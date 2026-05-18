from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from fastapi import HTTPException

from app.models.log import DailyLog, Manpower, Material, Equipment, DailyLogActivity
from app.models.task import Task, TaskActivity
from app.models.project import Project, ProjectMember
from app.models.user import User
from app.models.commons import LogStatus, ProjectRole, ProjectStatus
from app.repositories.log import DailyLogRepository
from app.services.notifications import notify

log_repo = DailyLogRepository()


async def _task_summary(db: AsyncSession, log: DailyLog) -> str:
    """
    Build a human label for the tasks covered by a daily log.

    A log has a primary task (log.task_id) plus zero or more additional tasks
    inferred from its linked DailyLogActivity rows. We name the primary task
    and append "+N more" when extras exist; fall back to "a daily log" when no
    task is attached.
    """
    primary_id = log.task_id

    linked_rows = (await db.execute(
        select(DailyLogActivity.task_activity_id).where(DailyLogActivity.log_id == log.id)
    )).all()
    activity_ids = [r[0] for r in linked_rows]
    extra_task_ids: set[UUID] = set()
    for aid in activity_ids:
        activity = await db.get(TaskActivity, aid)
        if activity and activity.task_id and activity.task_id != primary_id:
            extra_task_ids.add(activity.task_id)

    if primary_id:
        primary = await db.get(Task, primary_id)
        primary_name = primary.name if primary else "a task"
        if extra_task_ids:
            return f"{primary_name} +{len(extra_task_ids)} more"
        return primary_name

    # No primary — use the count of extras if any, otherwise generic phrase.
    if extra_task_ids:
        return f"{len(extra_task_ids)} task{'s' if len(extra_task_ids) != 1 else ''}"
    return "a daily log"


async def _project_member_ids(db: AsyncSession, project_id: UUID, role: ProjectRole) -> list[UUID]:
    """Return user_ids of project members holding the given role."""
    result = await db.execute(
        select(ProjectMember.user_id).where(
            ProjectMember.project_id == project_id,
            ProjectMember.role == role.value,
        )
    )
    return [row[0] for row in result.all()]


async def _user_full_name(db: AsyncSession, user_id: UUID) -> str:
    user = await db.get(User, user_id)
    return user.full_name if user else "Someone"

# Workflow transitions: who can trigger what
# 3-step chain: Site Engineer submits → Consultant approves → PM final approval
WORKFLOW_TRANSITIONS = {
    "submit": {
        "from_status": [LogStatus.DRAFT, LogStatus.REJECTED],
        "to_status": LogStatus.SUBMITTED,
        "allowed_roles": [ProjectRole.SITE_ENGINEER],
    },
    "consultant-approve": {
        "from_status": [LogStatus.SUBMITTED],
        "to_status": LogStatus.CONSULTANT_APPROVED,
        "allowed_roles": [ProjectRole.CONSULTANT],
    },
    "pm-approve": {
        "from_status": [LogStatus.CONSULTANT_APPROVED],
        "to_status": LogStatus.PM_APPROVED,
        "allowed_roles": [ProjectRole.PROJECT_MANAGER],
    },
}


class DailyLogService:
    @staticmethod
    async def create_log(
        db: AsyncSession,
        project_id: UUID,
        user_id: UUID,
        notes: str = None,
        weather: str = None,
        task_id: UUID = None,
    ) -> DailyLog:
        log = DailyLog(
            project_id=project_id,
            task_id=task_id,  # optional
            created_by_id=user_id,
            notes=notes,
            weather=weather,
        )
        db.add(log)
        await db.commit()
        await db.refresh(log)
        return log

    @staticmethod
    async def transition_log(db: AsyncSession, log_id: UUID, action: str, user_role: str, actor_id: UUID | None = None) -> DailyLog:
        """Execute a workflow transition on a daily log."""
        if action not in WORKFLOW_TRANSITIONS:
            raise HTTPException(status_code=400, detail=f"Invalid action: {action}")

        transition = WORKFLOW_TRANSITIONS[action]
        log = await log_repo.get_by_id(db, log_id)
        if not log:
            raise HTTPException(status_code=404, detail="Daily log not found")

        # Verify current status
        allowed_from = [s.value for s in transition["from_status"]]
        if log.status not in allowed_from:
            raise HTTPException(
                status_code=400,
                detail=f"Log must be in {allowed_from} status for action '{action}'. Current: '{log.status}'"
            )

        # Verify role permission
        allowed = [r.value for r in transition["allowed_roles"]]
        if user_role not in allowed:
            raise HTTPException(
                status_code=403,
                detail=f"Role '{user_role}' cannot perform '{action}'. Allowed: {allowed}"
            )

        log.status = transition["to_status"].value
        db.add(log)

        # Fire notifications for the new state. Recipient depends on the action.
        task_label = await _task_summary(db, log)
        actor_name = await _user_full_name(db, actor_id) if actor_id else "Someone"

        if action == "submit":
            # Site Engineer just submitted -> notify consultant(s).
            consultant_ids = await _project_member_ids(db, log.project_id, ProjectRole.CONSULTANT)
            for uid in consultant_ids:
                await notify(
                    db, user_id=uid, type="log_submitted",
                    content=f"{actor_name} submitted a daily log for {task_label}",
                    entity_type="daily_log", entity_id=log.id, project_id=log.project_id,
                )
        elif action == "consultant-approve":
            # Consultant approved -> notify PM(s) for final approval.
            pm_ids = await _project_member_ids(db, log.project_id, ProjectRole.PROJECT_MANAGER)
            for uid in pm_ids:
                await notify(
                    db, user_id=uid, type="log_consultant_approved",
                    content=f"{actor_name} approved a daily log for {task_label}. Awaiting your final approval.",
                    entity_type="daily_log", entity_id=log.id, project_id=log.project_id,
                )
        elif action == "pm-approve":
            # PM finalised -> notify the log creator.
            if log.created_by_id and log.created_by_id != actor_id:
                await notify(
                    db, user_id=log.created_by_id, type="log_approved",
                    content=f"Your daily log for {task_label} was approved",
                    entity_type="daily_log", entity_id=log.id, project_id=log.project_id,
                )

        await db.commit()
        await db.refresh(log)

        # On final PM approval, update budget and recalculate task progress from activities
        if action == "pm-approve":
            await DailyLogService._on_final_approval(db, log)

        return log

    @staticmethod
    async def reject_log(db: AsyncSession, log_id: UUID, rejection_reason: str, actor_id: UUID | None = None) -> DailyLog:
        log = await log_repo.get_by_id(db, log_id)
        if not log:
            raise HTTPException(status_code=404, detail="Daily log not found")
        if log.status not in [LogStatus.SUBMITTED.value, LogStatus.CONSULTANT_APPROVED.value]:
            raise HTTPException(status_code=400, detail=f"Cannot reject log in '{log.status}' status")
        log.status = LogStatus.REJECTED.value
        log.rejection_reason = rejection_reason
        db.add(log)

        # Notify the log creator with the rejection reason.
        if log.created_by_id and log.created_by_id != actor_id:
            task_label = await _task_summary(db, log)
            reason_clip = (rejection_reason or "").strip()
            if len(reason_clip) > 140:
                reason_clip = reason_clip[:140].rstrip() + "…"
            content = f"Your daily log for {task_label} was rejected"
            if reason_clip:
                content = f"{content}: {reason_clip}"
            await notify(
                db, user_id=log.created_by_id, type="log_rejected",
                content=content,
                entity_type="daily_log", entity_id=log.id, project_id=log.project_id,
            )

        await db.commit()
        await db.refresh(log)
        return log

    @staticmethod
    async def _on_final_approval(db: AsyncSession, log: DailyLog):
        """Update project budget and task progress after PM approval.
        Recalculates progress for every task touched by activities in this log."""
        # ── 1. Update project budget_spent ──────────────────────────────────
        manpower_cost = await db.execute(
            select(func.coalesce(func.sum(Manpower.cost), 0)).where(Manpower.log_id == log.id)
        )
        mat_cost = await db.execute(
            select(func.coalesce(func.sum(Material.cost), 0)).where(Material.log_id == log.id)
        )
        equip_cost = await db.execute(
            select(func.coalesce(func.sum(Equipment.cost), 0)).where(Equipment.log_id == log.id)
        )
        total_cost = manpower_cost.scalar() + mat_cost.scalar() + equip_cost.scalar()

        project = await db.get(Project, log.project_id)
        if project:
            project.budget_spent = (project.budget_spent or 0) + total_cost
            db.add(project)

        # ── 2. Collect every task touched by this log's completed activities ─
        linked = (await db.execute(
            select(DailyLogActivity).where(DailyLogActivity.log_id == log.id)
        )).scalars().all()

        touched_task_ids: set = set()
        for link in linked:
            activity = await db.get(TaskActivity, link.task_activity_id)
            if activity:
                touched_task_ids.add(activity.task_id)
        # Always include the log's primary task even if it has no linked activities
        if log.task_id:
            touched_task_ids.add(log.task_id)

        # ── 3. Recalculate progress for every touched task ───────────────────
        for task_id in touched_task_ids:
            task = await db.get(Task, task_id)
            if not task:
                continue

            all_activities = (await db.execute(
                select(TaskActivity).where(TaskActivity.task_id == task_id)
            )).scalars().all()

            if all_activities:
                task.progress_percentage = sum(
                    a.percentage for a in all_activities if a.is_completed
                )

            if task.progress_percentage >= 100:
                task.status = "completed"
            elif task.progress_percentage > 0:
                task.status = "in_progress"
            db.add(task)

        await db.flush()

        # ── 4. Recalculate overall project completion (weighted by task weight) ─
        if project:
            all_tasks = (await db.execute(
                select(Task).where(Task.project_id == project.id)
            )).scalars().all()

            if all_tasks:
                project.progress_percentage = round(
                    sum((t.progress_percentage or 0) / 100.0 * (t.weight or 0) for t in all_tasks), 2
                )

                # Auto-transition status. on_hold is a manual flag; never override it.
                if project.status != ProjectStatus.ON_HOLD.value:
                    if project.progress_percentage >= 100:
                        project.status = ProjectStatus.COMPLETED.value
                    elif project.progress_percentage > 0 and project.status == ProjectStatus.PLANNING.value:
                        project.status = ProjectStatus.IN_PROGRESS.value

                db.add(project)

        # ── 5. Budget threshold alert (notify PM once per threshold crossing) ─
        if project and project.total_budget and project.total_budget > 0:
            pct = (project.budget_spent or 0) / project.total_budget * 100
            last = project.last_alert_budget_threshold or 0
            # Per-project override wins; otherwise default to 80 (matches the global setting).
            warn_threshold = float(project.budget_alert_threshold_pct_override or 80)
            new_threshold = None
            if pct >= 100 and last < 100:
                new_threshold = 100
            elif pct >= warn_threshold and last < warn_threshold:
                new_threshold = warn_threshold

            if new_threshold:
                pm_ids = await _project_member_ids(db, project.id, ProjectRole.PROJECT_MANAGER)
                phrasing = (
                    f"Project '{project.name}' has now spent {pct:.0f}% of its budget"
                    if new_threshold == 100
                    else f"Project '{project.name}' has crossed {int(new_threshold)}% of its budget ({pct:.0f}%)"
                )
                for uid in pm_ids:
                    await notify(
                        db, user_id=uid, type="budget_alert",
                        content=phrasing,
                        entity_type="project", entity_id=project.id, project_id=project.id,
                    )
                project.last_alert_budget_threshold = float(new_threshold)
                db.add(project)

        await db.commit()
