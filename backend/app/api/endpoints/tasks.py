from datetime import datetime, timedelta, timezone
from typing import Any, List
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func, delete, or_
from sqlalchemy.orm import selectinload

from app.api.dependencies import DbSession, get_current_active_user, require_project_role, get_project_member
from app.models.user import User
from app.models.commons import ProjectRole
from app.models.project import Project
from app.models.task import Task, TaskDependency, TaskActivity
from app.models.log import DailyLog, Manpower
from app.schemas.task import (
    TaskCreate, TaskUpdate, TaskResponse,
    TaskDependencyCreate, TaskDependencyResponse,
    TaskActivityCreate, TaskActivityUpdate, TaskActivityResponse,
    TaskManpowerSummary, ManpowerByTrade,
    TaskBudgetSummary,
)
from app.repositories.log import TaskRepository, TaskDependencyRepository, TaskActivityRepository

task_repo = TaskRepository()
dep_repo = TaskDependencyRepository()
activity_repo = TaskActivityRepository()


# ── Business-day helpers (skip weekends) ──

def _add_business_days(start: datetime, days: int) -> datetime:
    """Add N business days (Mon-Fri) to a datetime, skipping weekends."""
    if days <= 0:
        return start
    current = start
    added = 0
    while added < days:
        current += timedelta(days=1)
        if current.weekday() < 5:  # Mon=0 .. Fri=4
            added += 1
    return current


def _next_business_day(dt: datetime) -> datetime:
    """If dt falls on a weekend, advance to the next Monday."""
    while dt.weekday() >= 5:  # Sat=5, Sun=6
        dt += timedelta(days=1)
    return dt


# ── Duration ↔ end_date sync ──

def _ensure_aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _sync_end_date(task: Task) -> None:
    """duration_days is the source of truth. If start_date and duration_days
    are both set, recompute end_date using business days (skip weekends)."""
    start = _ensure_aware(task.start_date)
    if start is None or task.duration_days is None:
        return
    task.end_date = _add_business_days(start, int(task.duration_days))


def _backfill_duration_from_end(task: Task) -> None:
    """When a caller supplies end_date but no duration_days, derive duration
    counting only business days."""
    start = _ensure_aware(task.start_date)
    end = _ensure_aware(task.end_date)
    if task.duration_days is None and start and end:
        biz_days = 0
        current = start
        while current < end:
            current += timedelta(days=1)
            if current.weekday() < 5:
                biz_days += 1
        task.duration_days = max(0, biz_days)


# ── Dependency cascade ──

async def _propagate_dependents(db, source_task_id: UUID, visited: set[UUID] | None = None) -> None:
    """Walk forward through TaskDependency edges. For every successor of
    source_task_id, recompute its start_date as the next business day after
    the latest predecessor end_date, re-derive end_date from duration, and recurse."""
    if visited is None:
        visited = set()
    if source_task_id in visited:
        return
    visited.add(source_task_id)

    successors_res = await db.execute(
        select(TaskDependency).where(TaskDependency.depends_on_task_id == source_task_id)
    )
    successor_edges = list(successors_res.scalars().all())

    for edge in successor_edges:
        successor = await db.get(Task, edge.task_id)
        if not successor:
            continue

        # Find the latest end_date among ALL predecessors of this successor.
        all_preds_res = await db.execute(
            select(TaskDependency).where(TaskDependency.task_id == successor.id)
        )
        latest_pred_end: datetime | None = None
        for pred_edge in all_preds_res.scalars().all():
            pred = await db.get(Task, pred_edge.depends_on_task_id)
            pred_end = _ensure_aware(pred.end_date) if pred else None
            if pred_end and (latest_pred_end is None or pred_end > latest_pred_end):
                latest_pred_end = pred_end

        if latest_pred_end is None:
            continue

        # Successor starts on the next business day after predecessor ends
        new_start = _next_business_day(latest_pred_end + timedelta(days=1))
        old_start = _ensure_aware(successor.start_date)

        # Only push forward — never pull a successor backwards.
        if old_start is None or old_start < new_start:
            successor.start_date = new_start
            _sync_end_date(successor)
            db.add(successor)
            await db.flush()
            await _propagate_dependents(db, successor.id, visited)


# ── Activity-based progress recalculation ──

async def _recalculate_task_progress(db, task_id: UUID):
    """Task progress = sum of percentage for all completed activities."""
    activities = (await db.execute(
        select(TaskActivity).where(TaskActivity.task_id == task_id)
    )).scalars().all()

    task = await db.get(Task, task_id)
    if not task:
        return

    if activities:
        task.progress_percentage = sum(a.percentage for a in activities if a.is_completed)
    # If no activities, keep current progress

    if task.progress_percentage >= 100:
        task.status = "completed"
    elif task.progress_percentage > 0 and task.status == "pending":
        task.status = "in_progress"

    db.add(task)
    await db.commit()

    # Recalculate project progress
    await _recalculate_project_progress(db, task.project_id)


async def _recalculate_project_progress(db, project_id: UUID):
    """Recalculate project progress as absolute scope completion.
    Each task contributes (its_progress% / 100 * its_weight) to the project total.
    When all tasks (weights summing to 100) are fully done, project = 100%."""
    all_tasks = (await db.execute(
        select(Task).where(Task.project_id == project_id)
    )).scalars().all()

    project = await db.get(Project, project_id)
    if project and all_tasks:
        project.progress_percentage = round(
            sum((t.progress_percentage or 0) / 100.0 * (t.weight or 0) for t in all_tasks), 2
        )
        db.add(project)
        await db.commit()


router = APIRouter()


# ══════════════════════════════════════════════════════════════
# Task CRUD
# ══════════════════════════════════════════════════════════════

@router.post("/{project_id}/tasks", response_model=TaskResponse, status_code=201, summary="Create task (with optional dependency)",
             dependencies=[Depends(require_project_role([ProjectRole.PROJECT_MANAGER]))])
async def create_task(
    *, db: DbSession, project_id: UUID, task_in: TaskCreate,
) -> Any:
    task = Task(
        project_id=project_id,
        name=task_in.name,
        status=task_in.status.value if task_in.status else "pending",
        start_date=task_in.start_date,
        duration_days=task_in.duration_days,
        end_date=task_in.end_date,
        budget=task_in.budget or 0.0,
        weight=task_in.weight or 0.0,
        assigned_to=task_in.assigned_to,
    )

    # If a dependency is provided at creation time, auto-adjust start_date
    if task_in.depends_on_task_id:
        predecessor = await db.get(Task, task_in.depends_on_task_id)
        if not predecessor:
            raise HTTPException(status_code=404, detail="Dependency task not found")
        if predecessor.project_id != project_id:
            raise HTTPException(status_code=400, detail="Dependency task must belong to the same project")

        # Set start_date to next business day after predecessor's end_date
        pred_end = _ensure_aware(predecessor.end_date)
        if pred_end:
            task.start_date = _next_business_day(pred_end + timedelta(days=1))

    # Reconcile duration ↔ end_date.
    if task.duration_days is not None:
        _sync_end_date(task)
    else:
        _backfill_duration_from_end(task)

    db.add(task)
    await db.commit()

    # Create the dependency record if provided
    if task_in.depends_on_task_id:
        dep = TaskDependency(task_id=task.id, depends_on_task_id=task_in.depends_on_task_id)
        db.add(dep)
        await db.commit()

    await _recalculate_project_progress(db, project_id)

    # Notify the assignee if this task was assigned at creation time.
    if task.assigned_to:
        from app.services.notifications import notify
        await notify(
            db, user_id=task.assigned_to, type="task_assigned",
            content=f"You were assigned to task '{task.name}'",
            entity_type="task", entity_id=task.id, project_id=project_id,
        )
        await db.commit()

    # Re-fetch with assignee loaded
    result = await db.execute(
        select(Task).options(selectinload(Task.assignee)).where(Task.id == task.id)
    )
    return result.scalars().first()


@router.get("/{project_id}/tasks", response_model=List[TaskResponse], summary="List project tasks",
            dependencies=[Depends(get_project_member)])
async def list_tasks(
    project_id: UUID, db: DbSession, status: str = None,
    assigned_to: UUID = None,
    skip: int = 0, limit: int = 100,
) -> Any:
    stmt = select(Task).options(
        selectinload(Task.assignee),
        selectinload(Task.activities),
    ).where(Task.project_id == project_id)
    if status:
        stmt = stmt.where(Task.status == status)
    if assigned_to:
        stmt = stmt.where(Task.assigned_to == assigned_to)
    stmt = stmt.offset(skip).limit(limit)
    result = await db.execute(stmt)
    tasks = list(result.scalars().all())
    return [
        TaskResponse.model_validate(t).model_copy(update={"activity_count": len(t.activities)})
        for t in tasks
    ]


@router.get("/tasks/{task_id}", response_model=TaskResponse, summary="Get task details")
async def get_task(task_id: UUID, db: DbSession, current_user: User = Depends(get_current_active_user)) -> Any:
    result = await db.execute(
        select(Task).options(
            selectinload(Task.assignee),
            selectinload(Task.activities),
        ).where(Task.id == task_id)
    )
    task = result.scalars().first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    # Verify user is a project member
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")
    return TaskResponse.model_validate(task).model_copy(update={"activity_count": len(task.activities)})


@router.put("/tasks/{task_id}", response_model=TaskResponse, summary="Update task (PM only)")
async def update_task(
    *, db: DbSession, task_id: UUID, task_in: TaskUpdate,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    task = await task_repo.get_by_id(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Verify user is project PM or admin
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")
        if member.role != ProjectRole.PROJECT_MANAGER.value:
            raise HTTPException(status_code=403, detail="Only the project manager can update tasks")

    # Block start if dependencies are not completed
    new_status = task_in.status.value if task_in.status else None
    if new_status == "in_progress" or (task_in.progress_percentage and task_in.progress_percentage > 0 and task.status == "pending"):
        deps = await dep_repo.get_by_task(db, task_id)
        for dep in deps:
            blocker = await task_repo.get_by_id(db, dep.depends_on_task_id)
            if blocker and blocker.status != "completed":
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot start — dependency '{blocker.name}' is not completed yet"
                )

    schedule_fields_changed = (
        task_in.start_date is not None
        or task_in.duration_days is not None
        or task_in.end_date is not None
    )
    previous_assignee = task.assigned_to

    updated = await task_repo.update(db, task, task_in)

    # Reconcile duration ↔ end_date after the update.
    if schedule_fields_changed:
        if task_in.duration_days is not None or task_in.start_date is not None:
            _sync_end_date(updated)
        elif task_in.end_date is not None:
            _backfill_duration_from_end(updated)
        db.add(updated)
        await db.flush()

    # Auto-update status based on progress
    if updated.progress_percentage >= 100 and updated.status != "completed":
        updated.status = "completed"
        db.add(updated)
        await db.commit()
        await db.refresh(updated)
    elif updated.progress_percentage > 0 and updated.status == "pending":
        updated.status = "in_progress"
        db.add(updated)
        await db.commit()
        await db.refresh(updated)
    else:
        await db.commit()

    # Cascade schedule changes to dependents.
    if schedule_fields_changed:
        await _propagate_dependents(db, updated.id)
        await db.commit()

    await _recalculate_project_progress(db, task.project_id)

    # Notify the new assignee when assigned_to changed to a different non-null user.
    if updated.assigned_to and updated.assigned_to != previous_assignee:
        from app.services.notifications import notify
        await notify(
            db, user_id=updated.assigned_to, type="task_assigned",
            content=f"You were assigned to task '{updated.name}'",
            entity_type="task", entity_id=updated.id, project_id=task.project_id,
        )
        await db.commit()

    # Re-fetch with assignee loaded
    result = await db.execute(
        select(Task).options(selectinload(Task.assignee)).where(Task.id == updated.id)
    )
    return result.scalars().first()


@router.delete("/tasks/{task_id}", status_code=204, summary="Delete task (PM only)")
async def delete_task(task_id: UUID, db: DbSession, current_user: User = Depends(get_current_active_user)) -> None:
    task = await task_repo.get_by_id(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Verify user is project PM or admin
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member or member.role != ProjectRole.PROJECT_MANAGER.value:
            raise HTTPException(status_code=403, detail="Only the project manager can delete tasks")

    project_id = task.project_id

    # Remove all dependency rows that reference this task (both sides of the FK)
    await db.execute(
        delete(TaskDependency).where(
            or_(
                TaskDependency.task_id == task_id,
                TaskDependency.depends_on_task_id == task_id,
            )
        )
    )

    await task_repo.delete(db, task_id)
    await _recalculate_project_progress(db, project_id)


# ══════════════════════════════════════════════════════════════
# Task Dependencies
# ══════════════════════════════════════════════════════════════

@router.post("/tasks/{task_id}/dependencies", response_model=TaskDependencyResponse, status_code=201, summary="Add task dependency")
async def add_dependency(
    *, db: DbSession, task_id: UUID, dep_in: TaskDependencyCreate,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    if task_id == dep_in.depends_on_task_id:
        raise HTTPException(status_code=400, detail="A task cannot depend on itself")

    # Verify membership
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")

    dep = TaskDependency(task_id=task_id, depends_on_task_id=dep_in.depends_on_task_id)
    db.add(dep)
    await db.commit()
    await db.refresh(dep)

    # Auto-adjust: push this task's start_date to next business day after predecessor end
    predecessor = await db.get(Task, dep_in.depends_on_task_id)
    if predecessor and predecessor.end_date:
        pred_end = _ensure_aware(predecessor.end_date)
        new_start = _next_business_day(pred_end + timedelta(days=1))
        current_start = _ensure_aware(task.start_date)
        if current_start is None or current_start < new_start:
            task.start_date = new_start
            _sync_end_date(task)
            db.add(task)
            await db.flush()

    # Cascade from predecessor so downstream tasks are pushed forward
    await _propagate_dependents(db, dep_in.depends_on_task_id)
    await db.commit()
    return dep


@router.get("/tasks/{task_id}/dependencies", response_model=List[TaskDependencyResponse], summary="List task dependencies")
async def list_dependencies(
    task_id: UUID, db: DbSession, current_user: User = Depends(get_current_active_user),
) -> Any:
    # Verify membership
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")
    return await dep_repo.get_by_task(db, task_id)


@router.delete("/tasks/{task_id}/dependencies/{dep_id}", status_code=204, summary="Remove task dependency")
async def remove_dependency(
    task_id: UUID, dep_id: UUID, db: DbSession,
    current_user: User = Depends(get_current_active_user),
) -> None:
    # Verify membership
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")

    result = await db.execute(
        select(TaskDependency).where(TaskDependency.id == dep_id, TaskDependency.task_id == task_id)
    )
    dep = result.scalars().first()
    if dep:
        await db.delete(dep)
        await db.commit()


# ══════════════════════════════════════════════════════════════
# Task Activities (progress tracking)
# ══════════════════════════════════════════════════════════════

@router.post("/tasks/{task_id}/activities", response_model=TaskActivityResponse, status_code=201, summary="Add activity to task")
async def add_activity(
    *, db: DbSession, task_id: UUID, activity_in: TaskActivityCreate,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Add an activity to a task. PM only. Each activity has a percentage weight."""
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # PM-only check
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member or member.role != ProjectRole.PROJECT_MANAGER.value:
            raise HTTPException(status_code=403, detail="Only the project manager can add activities")

    # Validate percentage doesn't exceed 100% total
    existing = await activity_repo.get_by_task(db, task_id)
    total = sum(a.percentage for a in existing) + activity_in.percentage
    if total > 100:
        raise HTTPException(
            status_code=400,
            detail=f"Total activity percentage would be {total}%, which exceeds 100%"
        )

    activity = TaskActivity(
        task_id=task_id,
        name=activity_in.name,
        percentage=activity_in.percentage,
    )
    db.add(activity)
    await db.commit()
    await db.refresh(activity)

    # Recalculate task progress
    await _recalculate_task_progress(db, task_id)
    return activity


@router.get("/tasks/{task_id}/activities", response_model=List[TaskActivityResponse], summary="List task activities")
async def list_activities(
    task_id: UUID, db: DbSession, current_user: User = Depends(get_current_active_user),
) -> Any:
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")
    return await activity_repo.get_by_task(db, task_id)


@router.patch("/tasks/{task_id}/activities/{activity_id}", response_model=TaskActivityResponse, summary="Update or complete activity")
async def update_activity(
    *, db: DbSession, task_id: UUID, activity_id: UUID, update_in: TaskActivityUpdate,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Update an activity. Any project member can mark it complete."""
    result = await db.execute(
        select(TaskActivity).where(TaskActivity.id == activity_id, TaskActivity.task_id == task_id)
    )
    activity = result.scalars().first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")

    task = await db.get(Task, task_id)
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")

    if update_in.name is not None:
        activity.name = update_in.name
    if update_in.percentage is not None:
        # Validate new total doesn't exceed 100%
        existing = await activity_repo.get_by_task(db, task_id)
        total = sum(a.percentage for a in existing if a.id != activity_id) + update_in.percentage
        if total > 100:
            raise HTTPException(status_code=400, detail=f"Total would be {total}%, exceeds 100%")
        activity.percentage = update_in.percentage
    if update_in.is_completed is not None:
        activity.is_completed = update_in.is_completed

    db.add(activity)
    await db.commit()
    await db.refresh(activity)

    # Recalculate task progress
    await _recalculate_task_progress(db, task_id)
    return activity


@router.delete("/tasks/{task_id}/activities/{activity_id}", status_code=204, summary="Delete activity (PM only)")
async def delete_activity(
    task_id: UUID, activity_id: UUID, db: DbSession,
    current_user: User = Depends(get_current_active_user),
) -> None:
    """Delete an activity. PM only."""
    result = await db.execute(
        select(TaskActivity).where(TaskActivity.id == activity_id, TaskActivity.task_id == task_id)
    )
    activity = result.scalars().first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")

    task = await db.get(Task, task_id)
    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member or member.role != ProjectRole.PROJECT_MANAGER.value:
            raise HTTPException(status_code=403, detail="Only the project manager can delete activities")

    await db.delete(activity)
    await db.commit()

    # Recalculate task progress
    await _recalculate_task_progress(db, task_id)


# ══════════════════════════════════════════════════════════════
# Per-task manpower / efficiency aggregation
# ══════════════════════════════════════════════════════════════

@router.get("/tasks/{task_id}/manpower-summary", response_model=TaskManpowerSummary, summary="Task manpower aggregation")
async def get_task_manpower_summary(
    task_id: UUID, db: DbSession,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Aggregate manpower across all daily logs for this task."""
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")

    logs_res = await db.execute(select(DailyLog).where(DailyLog.task_id == task_id))
    logs = list(logs_res.scalars().all())
    log_ids = [l.id for l in logs]

    manpower_rows: list[Manpower] = []
    if log_ids:
        mp_res = await db.execute(select(Manpower).where(Manpower.log_id.in_(log_ids)))
        manpower_rows = list(mp_res.scalars().all())

    by_trade_map: dict[str, dict[str, float]] = {}
    for mp in manpower_rows:
        trade = mp.worker_type or "unspecified"
        agg = by_trade_map.setdefault(trade, {"workers": 0, "hours": 0.0, "cost": 0.0})
        agg["workers"] += 1
        agg["hours"] += float(mp.hours_worked or 0.0)
        agg["cost"] += float(mp.cost or 0.0)

    total_hours = sum(float(mp.hours_worked or 0.0) for mp in manpower_rows)
    total_cost = sum(float(mp.cost or 0.0) for mp in manpower_rows)

    return TaskManpowerSummary(
        task_id=task.id,
        task_name=task.name,
        log_count=len(logs),
        total_workers=len(manpower_rows),
        total_hours=round(total_hours, 2),
        total_cost=round(total_cost, 2),
        total_quantity_completed=None,
        productivity_per_hour=None,
        by_trade=[
            ManpowerByTrade(
                worker_type=trade,
                workers=int(agg["workers"]),
                hours_worked=round(agg["hours"], 2),
                cost=round(agg["cost"], 2),
            )
            for trade, agg in by_trade_map.items()
        ],
    )


@router.get("/tasks/{task_id}/budget-summary", response_model=TaskBudgetSummary, summary="Task budget vs spent analysis")
async def get_task_budget_summary(
    task_id: UUID, db: DbSession,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Calculate budget allocation vs actual spending across all daily logs for this task.
    
    Returns:
    - allocated_budget: Task.budget field
    - spent_labor: Sum of Manpower.cost from all logs
    - spent_materials: Sum of Material.cost from all logs
    - spent_equipment: Sum of Equipment.cost from all logs
    - total_spent: Sum of all costs
    - remaining_budget: allocated - spent
    - budget_utilization_pct: (spent / allocated) * 100
    - status: under_budget / on_budget / over_budget
    """
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not current_user.is_admin:
        from app.repositories.project import ProjectMemberRepository
        member = await ProjectMemberRepository().get_by_project_and_user(db, task.project_id, current_user.id)
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this project")

    # Get all logs for this task
    logs_res = await db.execute(select(DailyLog).where(DailyLog.task_id == task_id))
    logs = list(logs_res.scalars().all())
    log_ids = [l.id for l in logs]

    # Calculate spent amounts
    spent_labor = 0.0
    spent_materials = 0.0
    spent_equipment = 0.0

    if log_ids:
        # Labor costs
        from app.models.log import Material, Equipment
        labor_res = await db.execute(select(Manpower).where(Manpower.log_id.in_(log_ids)))
        spent_labor = sum(float(mp.cost or 0.0) for mp in labor_res.scalars().all())

        # Material costs
        material_res = await db.execute(select(Material).where(Material.log_id.in_(log_ids)))
        spent_materials = sum(float(m.cost or 0.0) for m in material_res.scalars().all())

        # Equipment costs
        equipment_res = await db.execute(select(Equipment).where(Equipment.log_id.in_(log_ids)))
        spent_equipment = sum(float(e.cost or 0.0) for e in equipment_res.scalars().all())

    total_spent = spent_labor + spent_materials + spent_equipment
    allocated_budget = float(task.budget or 0.0)
    remaining_budget = allocated_budget - total_spent
    
    # Calculate utilization percentage
    budget_utilization_pct = 0.0
    if allocated_budget > 0:
        budget_utilization_pct = (total_spent / allocated_budget) * 100

    # Determine status
    status = "under_budget"
    if budget_utilization_pct >= 100:
        status = "over_budget"
    elif budget_utilization_pct >= 80:
        status = "on_budget"

    return TaskBudgetSummary(
        task_id=task.id,
        task_name=task.name,
        allocated_budget=round(allocated_budget, 2),
        spent_labor=round(spent_labor, 2),
        spent_materials=round(spent_materials, 2),
        spent_equipment=round(spent_equipment, 2),
        total_spent=round(total_spent, 2),
        remaining_budget=round(remaining_budget, 2),
        budget_utilization_pct=round(budget_utilization_pct, 2),
        status=status,
        log_count=len(logs),
    )
