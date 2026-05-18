import logging
import os
import uuid as uuid_lib
from pathlib import Path
from typing import Any, List
from uuid import UUID
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy import select

import cloudinary
import cloudinary.uploader

from app.api.dependencies import DbSession, get_current_active_user
from app.core.config import settings
from app.models.user import User
from app.models.log import (
    DailyLog, Manpower, Material, Equipment, EquipmentIdle, DailyLogPhoto, DailyLogActivity,
)
from app.models.task import TaskDependency, Task
from app.schemas.log import (
    DailyLogCreate, DailyLogResponse, DailyLogReject,
    ManpowerCreate, ManpowerUpdate, ManpowerResponse,
    MaterialCreate, MaterialUpdate, MaterialResponse,
    EquipmentCreate, EquipmentUpdate, EquipmentResponse,
    EquipmentIdleCreate, EquipmentIdleResponse,
    DailyLogPhotoResponse,
    DailyLogActivityCreate, DailyLogActivityResponse,
)
from app.services.log import DailyLogService
from app.repositories.log import DailyLogRepository

logger = logging.getLogger(__name__)

# ── Router A: project-scoped routes  (prefix will be /projects) ──
project_logs_router = APIRouter()

# ── Router B: log-level / sub-entity routes  (prefix will be "") ──
logs_router = APIRouter()

log_repo = DailyLogRepository()


# ── Photo storage config ──
UPLOAD_ROOT = Path(__file__).resolve().parents[3] / "uploads"
DAILY_LOG_PHOTO_DIR = UPLOAD_ROOT / "daily-logs"
ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_PHOTO_BYTES = 10 * 1024 * 1024  # 10 MB
CLOUDINARY_FOLDER = "smart-construction/daily-logs"


def _cloudinary_configured() -> bool:
    return bool(
        settings.CLOUDINARY_CLOUD_NAME
        and settings.CLOUDINARY_API_KEY
        and settings.CLOUDINARY_API_SECRET
    )


def _configure_cloudinary() -> None:
    cloudinary.config(
        cloud_name=settings.CLOUDINARY_CLOUD_NAME,
        api_key=settings.CLOUDINARY_API_KEY,
        api_secret=settings.CLOUDINARY_API_SECRET,
        secure=True,
    )


async def _ensure_no_blocking_dependency(db, task_id: UUID) -> None:
    """Block daily-log creation against a task whose predecessors are not yet complete."""
    deps_res = await db.execute(
        select(TaskDependency).where(TaskDependency.task_id == task_id)
    )
    for dep in deps_res.scalars().all():
        blocker = await db.get(Task, dep.depends_on_task_id)
        if blocker and blocker.status != "completed":
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot log against this task — dependency "
                    f"'{blocker.name}' is not completed yet."
                ),
            )


# ══════════════════════════════════════════════════════════════
# A) PROJECT-SCOPED: /projects/{project_id}/daily-logs
# ══════════════════════════════════════════════════════════════

@project_logs_router.get("/{project_id}/daily-logs", response_model=List[DailyLogResponse], summary="List daily logs")
async def list_daily_logs(
    project_id: UUID, db: DbSession, status: str = None,
    created_by: UUID = None,
    start_date: datetime = None, end_date: datetime = None,
    skip: int = 0, limit: int = 100,
    _: User = Depends(get_current_active_user),
) -> Any:
    from sqlalchemy import func
    from app.schemas.log import UserBasic
    
    query = select(DailyLog).where(DailyLog.project_id == project_id)
    if status:
        query = query.where(DailyLog.status == status)
    if created_by:
        query = query.where(DailyLog.created_by_id == created_by)
    if start_date:
        query = query.where(DailyLog.date >= start_date)
    if end_date:
        query = query.where(DailyLog.date <= end_date)
    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    logs = list(result.scalars().all())
    
    # Enrich each log with counts and costs
    enriched_logs = []
    for log in logs:
        # Count activities
        activities_result = await db.execute(
            select(func.count(DailyLogActivity.id)).where(DailyLogActivity.log_id == log.id)
        )
        activities_count = activities_result.scalar() or 0
        
        # Count and sum manpower
        manpower_result = await db.execute(
            select(
                func.count(Manpower.id),
                func.coalesce(func.sum(Manpower.cost), 0.0)
            ).where(Manpower.log_id == log.id)
        )
        manpower_row = manpower_result.first()
        manpower_count = manpower_row[0] or 0
        manpower_cost = float(manpower_row[1] or 0.0)
        
        # Count and sum materials
        materials_result = await db.execute(
            select(
                func.count(Material.id),
                func.coalesce(func.sum(Material.cost), 0.0)
            ).where(Material.log_id == log.id)
        )
        materials_row = materials_result.first()
        materials_count = materials_row[0] or 0
        materials_cost = float(materials_row[1] or 0.0)
        
        # Count and sum equipment
        equipment_result = await db.execute(
            select(
                func.count(Equipment.id),
                func.coalesce(func.sum(Equipment.cost), 0.0)
            ).where(Equipment.log_id == log.id)
        )
        equipment_row = equipment_result.first()
        equipment_count = equipment_row[0] or 0
        equipment_cost = float(equipment_row[1] or 0.0)
        
        # Get created_by user info
        created_by_user = await db.get(User, log.created_by_id)
        created_by_basic = UserBasic.model_validate(created_by_user) if created_by_user else None
        
        # Create enriched response
        log_dict = {
            "id": log.id,
            "project_id": log.project_id,
            "task_id": log.task_id,
            "created_by_id": log.created_by_id,
            "date": log.date,
            "status": log.status,
            "notes": log.notes,
            "weather": log.weather,
            "rejection_reason": log.rejection_reason,
            "activities_count": activities_count,
            "manpower_count": manpower_count,
            "manpower_cost": manpower_cost,
            "materials_count": materials_count,
            "materials_cost": materials_cost,
            "equipment_count": equipment_count,
            "equipment_cost": equipment_cost,
            "created_by": created_by_basic,
        }
        enriched_logs.append(log_dict)
    
    return enriched_logs


# ── Task-scoped: /projects/{project_id}/tasks/{task_id}/daily-logs ──

@project_logs_router.post("/{project_id}/tasks/{task_id}/daily-logs", response_model=DailyLogResponse, status_code=201, summary="Create daily log for a task")
async def create_task_daily_log(
    *, db: DbSession, project_id: UUID, task_id: UUID, log_in: DailyLogCreate,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Create a daily log scoped to a specific task.
    Blocked when the task has any incomplete dependency."""
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.project_id != project_id:
        raise HTTPException(status_code=400, detail="Task does not belong to this project")

    await _ensure_no_blocking_dependency(db, task_id)

    return await DailyLogService.create_log(
        db=db,
        project_id=project_id,
        task_id=task_id,
        user_id=current_user.id,
        notes=log_in.notes,
        weather=log_in.weather,
    )



# ══════════════════════════════════════════════════════════════
# B) LOG-LEVEL ROUTES: /daily-logs/{log_id}/...
# ══════════════════════════════════════════════════════════════

@logs_router.get("/daily-logs/{log_id}", response_model=DailyLogResponse, summary="Get daily log details")
async def get_daily_log(log_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    log = await log_repo.get_by_id(db, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Daily log not found")
    return log


@logs_router.put("/daily-logs/{log_id}", response_model=DailyLogResponse, summary="Update daily log (draft/rejected only)")
async def update_daily_log(
    log_id: UUID, 
    db: DbSession, 
    log_in: DailyLogCreate,
    current_user: User = Depends(get_current_active_user)
) -> Any:
    """Update a daily log. Only draft or rejected logs can be updated."""
    log = await log_repo.get_by_id(db, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Daily log not found")
    
    # Only allow editing draft or rejected logs
    if log.status not in ["draft", "rejected"]:
        raise HTTPException(
            status_code=400, 
            detail="Only draft or rejected logs can be edited"
        )
    
    # Check if user is the creator
    if log.created_by_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own logs")
    
    # Update fields
    if log_in.notes is not None:
        log.notes = log_in.notes
    if log_in.weather is not None:
        log.weather = log_in.weather
    
    await db.commit()
    await db.refresh(log)
    return log


@logs_router.delete("/daily-logs/{log_id}", status_code=204, summary="Delete daily log (draft only)")
async def delete_daily_log(
    log_id: UUID,
    db: DbSession,
    current_user: User = Depends(get_current_active_user)
) -> None:
    """Delete a daily log. Only draft logs can be deleted."""
    log = await log_repo.get_by_id(db, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Daily log not found")
    
    # Only allow deleting draft logs
    if log.status != "draft":
        raise HTTPException(
            status_code=400,
            detail="Only draft logs can be deleted"
        )
    
    # Check if user is the creator
    if log.created_by_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own logs")

    # Reset is_completed on every task activity linked to this log so they
    # reappear as available after the log is deleted.
    from app.models.task import TaskActivity
    linked = await db.execute(
        select(DailyLogActivity).where(DailyLogActivity.log_id == log_id)
    )
    for link in linked.scalars().all():
        activity = await db.get(TaskActivity, link.task_activity_id)
        if activity:
            activity.is_completed = False
            db.add(activity)

    await db.delete(log)
    await db.commit()


# ── 3-step Approval Workflow: submit → consultant-approve → pm-approve ──

async def _do_transition(db, log_id: UUID, action: str, current_user: User):
    log = await log_repo.get_by_id(db, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Daily log not found")
    from app.repositories.project import ProjectMemberRepository
    member = await ProjectMemberRepository().get_by_project_and_user(db, log.project_id, current_user.id)
    if not member:
        raise HTTPException(status_code=403, detail="Not a project member")
    return await DailyLogService.transition_log(db, log_id, action, member.role, actor_id=current_user.id)


@logs_router.patch("/daily-logs/{log_id}/submit", response_model=DailyLogResponse, summary="Submit log (Site Engineer)")
async def submit_log(log_id: UUID, db: DbSession, current_user: User = Depends(get_current_active_user)) -> Any:
    return await _do_transition(db, log_id, "submit", current_user)

@logs_router.patch("/daily-logs/{log_id}/consultant-approve", response_model=DailyLogResponse, summary="Consultant approve")
async def consultant_approve_log(log_id: UUID, db: DbSession, current_user: User = Depends(get_current_active_user)) -> Any:
    return await _do_transition(db, log_id, "consultant-approve", current_user)

@logs_router.patch("/daily-logs/{log_id}/pm-approve", response_model=DailyLogResponse, summary="PM final approval")
async def pm_approve_log(log_id: UUID, db: DbSession, current_user: User = Depends(get_current_active_user)) -> Any:
    return await _do_transition(db, log_id, "pm-approve", current_user)

@logs_router.patch("/daily-logs/{log_id}/reject", response_model=DailyLogResponse, summary="Reject log (with note)")
async def reject_log(
    log_id: UUID, db: DbSession,
    body: DailyLogReject = None,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    reason = body.rejection_reason if body else "No reason provided"
    return await DailyLogService.reject_log(db, log_id, rejection_reason=reason, actor_id=current_user.id)


# ── Sub-Entities: Manpower ──

@logs_router.post("/daily-logs/{log_id}/manpower", response_model=ManpowerResponse, status_code=201, summary="Add manpower entry")
async def add_manpower(*, db: DbSession, log_id: UUID, manpower_in: ManpowerCreate, _: User = Depends(get_current_active_user)) -> Any:
    obj = Manpower(
        log_id=log_id,
        worker_type=manpower_in.worker_type,
        number_of_workers=manpower_in.number_of_workers,
        hours_worked=manpower_in.hours_worked,
        overtime_hours=manpower_in.overtime_hours,
        hourly_rate=manpower_in.hourly_rate,
        overtime_rate=manpower_in.overtime_rate,
        cost=manpower_in.cost
    )
    db.add(obj); await db.commit(); await db.refresh(obj)
    return obj

@logs_router.get("/daily-logs/{log_id}/manpower", response_model=List[ManpowerResponse], summary="List manpower entries")
async def list_manpower(log_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    result = await db.execute(select(Manpower).where(Manpower.log_id == log_id))
    return list(result.scalars().all())

@logs_router.patch("/manpower/{manpower_id}", response_model=ManpowerResponse, summary="Update manpower entry")
async def update_manpower(manpower_id: UUID, body: ManpowerUpdate, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    obj = await db.get(Manpower, manpower_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Manpower entry not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(obj, field, value)
    db.add(obj); await db.commit(); await db.refresh(obj)
    return obj

@logs_router.delete("/manpower/{manpower_id}", status_code=204, summary="Delete manpower entry")
async def delete_manpower(manpower_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> None:
    obj = await db.get(Manpower, manpower_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Manpower entry not found")
    await db.delete(obj); await db.commit()


# ── Sub-Entities: Materials ──

@logs_router.post("/daily-logs/{log_id}/materials", response_model=MaterialResponse, status_code=201, summary="Add material entry")
async def add_material(*, db: DbSession, log_id: UUID, mat_in: MaterialCreate, _: User = Depends(get_current_active_user)) -> Any:
    obj = Material(
        log_id=log_id,
        name=mat_in.name,
        supplier_id=mat_in.supplier_id,
        supplier_name=mat_in.supplier_name,
        quantity=mat_in.quantity,
        unit=mat_in.unit,
        unit_cost=mat_in.unit_cost,
        cost=mat_in.cost,
        delivery_date=mat_in.delivery_date
    )
    db.add(obj); await db.commit(); await db.refresh(obj)
    return obj

@logs_router.get("/daily-logs/{log_id}/materials", response_model=List[MaterialResponse], summary="List material entries")
async def list_materials(log_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    result = await db.execute(select(Material).where(Material.log_id == log_id))
    return list(result.scalars().all())

@logs_router.patch("/materials/{material_id}", response_model=MaterialResponse, summary="Update material entry")
async def update_material(material_id: UUID, body: MaterialUpdate, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    obj = await db.get(Material, material_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Material entry not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(obj, field, value)
    db.add(obj); await db.commit(); await db.refresh(obj)
    return obj

@logs_router.delete("/materials/{material_id}", status_code=204, summary="Delete material entry")
async def delete_material(material_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> None:
    obj = await db.get(Material, material_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Material entry not found")
    await db.delete(obj); await db.commit()


# ── Sub-Entities: Equipment ──

@logs_router.post("/daily-logs/{log_id}/equipment", response_model=EquipmentResponse, status_code=201, summary="Add equipment entry")
async def add_equipment(*, db: DbSession, log_id: UUID, equip_in: EquipmentCreate, _: User = Depends(get_current_active_user)) -> Any:
    obj = Equipment(
        log_id=log_id,
        name=equip_in.name,
        quantity=equip_in.quantity,
        start_date=equip_in.start_date,
        hours_used=equip_in.hours_used,
        unit_cost=equip_in.unit_cost,
        cost=equip_in.cost,
        idle_hours=equip_in.idle_hours,
        idle_reason=equip_in.idle_reason
    )
    db.add(obj); await db.commit(); await db.refresh(obj)
    return obj

@logs_router.get("/daily-logs/{log_id}/equipment", response_model=List[EquipmentResponse], summary="List equipment entries")
async def list_equipment(log_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    result = await db.execute(select(Equipment).where(Equipment.log_id == log_id))
    return list(result.scalars().all())

@logs_router.patch("/equipment/{equipment_id}", response_model=EquipmentResponse, summary="Update equipment entry")
async def update_equipment_entry(equipment_id: UUID, body: EquipmentUpdate, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    obj = await db.get(Equipment, equipment_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Equipment entry not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(obj, field, value)
    db.add(obj); await db.commit(); await db.refresh(obj)
    return obj

@logs_router.delete("/equipment/{equipment_id}", status_code=204, summary="Delete equipment entry")
async def delete_equipment_entry(equipment_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> None:
    obj = await db.get(Equipment, equipment_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Equipment entry not found")
    await db.delete(obj); await db.commit()


# ── Sub-Entities: Equipment Idle ──

@logs_router.post("/equipment/{equipment_id}/idle", response_model=EquipmentIdleResponse, status_code=201, summary="Record equipment idle time")
async def add_equipment_idle(*, db: DbSession, equipment_id: UUID, idle_in: EquipmentIdleCreate, _: User = Depends(get_current_active_user)) -> Any:
    obj = EquipmentIdle(equipment_id=equipment_id, reason=idle_in.reason, hours_idle=idle_in.hours_idle)
    db.add(obj); await db.commit(); await db.refresh(obj)
    return obj

@logs_router.get("/equipment/{equipment_id}/idle", response_model=List[EquipmentIdleResponse], summary="List equipment idle records")
async def list_equipment_idle(equipment_id: UUID, db: DbSession, _: User = Depends(get_current_active_user)) -> Any:
    result = await db.execute(select(EquipmentIdle).where(EquipmentIdle.equipment_id == equipment_id))
    return list(result.scalars().all())


# ── Sub-Entities: Photos ──

def _photo_extension(filename: str | None, content_type: str | None) -> str:
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        if 1 <= len(ext) <= 5 and ext.isalnum():
            return ext
    if content_type:
        m = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
        if content_type in m:
            return m[content_type]
    return "bin"


@logs_router.post("/daily-logs/{log_id}/photos", response_model=DailyLogPhotoResponse, status_code=201, summary="Upload photo to daily log")
async def upload_daily_log_photo(
    log_id: UUID, db: DbSession,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Attach a picture to a daily log. Stored on Cloudinary when configured,
    otherwise on local disk under backend/uploads/daily-logs/{log_id}/."""
    log = await log_repo.get_by_id(db, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Daily log not found")

    if file.content_type not in ALLOWED_PHOTO_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content_type {file.content_type!r}. Allowed: {sorted(ALLOWED_PHOTO_TYPES)}",
        )

    contents = await file.read()
    if len(contents) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_PHOTO_BYTES // (1024 * 1024)} MB)")

    photo_id = uuid_lib.uuid4()

    if _cloudinary_configured():
        _configure_cloudinary()
        public_id = f"{CLOUDINARY_FOLDER}/{log_id}/{photo_id}"
        try:
            result = cloudinary.uploader.upload(
                contents,
                public_id=public_id,
                resource_type="image",
                overwrite=False,
            )
        except Exception as e:
            logger.exception("Cloudinary upload failed for log_id=%s: %s", log_id, e)
            raise HTTPException(status_code=502, detail=f"Cloudinary upload failed: {e}")
        file_path = result["public_id"]
        url_path = result["secure_url"]
        logger.info("Uploaded daily-log photo to Cloudinary: log_id=%s public_id=%s", log_id, file_path)
    else:
        ext = _photo_extension(file.filename, file.content_type)
        target_dir = DAILY_LOG_PHOTO_DIR / str(log_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        rel_path = f"daily-logs/{log_id}/{photo_id}.{ext}"
        abs_path = UPLOAD_ROOT / rel_path
        abs_path.write_bytes(contents)
        file_path = str(rel_path)
        url_path = f"/uploads/{rel_path}"
        logger.info("Uploaded daily-log photo locally: log_id=%s photo_id=%s size=%dB", log_id, photo_id, len(contents))

    photo = DailyLogPhoto(
        id=photo_id,
        log_id=log_id,
        file_path=file_path,
        url_path=url_path,
        original_filename=file.filename,
        content_type=file.content_type,
        size_bytes=len(contents),
        uploaded_by_id=current_user.id,
    )
    db.add(photo)
    await db.commit()
    await db.refresh(photo)
    return photo


@logs_router.get("/daily-logs/{log_id}/photos", response_model=List[DailyLogPhotoResponse], summary="List daily log photos")
async def list_daily_log_photos(
    log_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    result = await db.execute(select(DailyLogPhoto).where(DailyLogPhoto.log_id == log_id))
    return list(result.scalars().all())


@logs_router.delete("/daily-logs/{log_id}/photos/{photo_id}", status_code=204, summary="Delete daily log photo")
async def delete_daily_log_photo(
    log_id: UUID, photo_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> None:
    result = await db.execute(
        select(DailyLogPhoto).where(DailyLogPhoto.id == photo_id, DailyLogPhoto.log_id == log_id)
    )
    photo = result.scalars().first()
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    if photo.url_path and photo.url_path.startswith("https://") and _cloudinary_configured():
        _configure_cloudinary()
        try:
            cloudinary.uploader.destroy(photo.file_path, resource_type="image")
        except Exception as e:
            logger.warning("Cloudinary destroy failed for public_id=%s: %s", photo.file_path, e)
    else:
        abs_path = UPLOAD_ROOT / photo.file_path
        try:
            if abs_path.exists():
                os.remove(abs_path)
        except OSError as e:
            logger.warning("Failed to remove local photo file %s: %s", abs_path, e)

    await db.delete(photo)
    await db.commit()


# ── Sub-Entities: Daily Log Activities (completed task activities) ──

@logs_router.post("/daily-logs/{log_id}/completed-activities", response_model=DailyLogActivityResponse, status_code=201, summary="Mark task activity as completed in this log")
async def add_completed_activity(
    *, db: DbSession, log_id: UUID, activity_in: DailyLogActivityCreate,
    _: User = Depends(get_current_active_user),
) -> Any:
    """Link a task activity to this daily log, marking it as completed.
    Task progress will be updated when the log is PM approved, not immediately."""
    from app.models.task import TaskActivity
    
    # Verify log exists
    log = await log_repo.get_by_id(db, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Daily log not found")
    
    # Verify activity exists and belongs to the log's task
    activity = await db.get(TaskActivity, activity_in.task_activity_id)
    if not activity:
        raise HTTPException(status_code=404, detail="Task activity not found")
    
    # Allow activities from any task that belongs to the same project
    # (supports cross-task daily logs created from the UI)
    activity_task = await db.get(Task, activity.task_id)
    if not activity_task or activity_task.project_id != log.project_id:
        raise HTTPException(
            status_code=400,
            detail="Activity does not belong to a task in this project"
        )
    
    # Check if already linked
    existing = await db.execute(
        select(DailyLogActivity).where(
            DailyLogActivity.log_id == log_id,
            DailyLogActivity.task_activity_id == activity_in.task_activity_id
        )
    )
    if existing.scalars().first():
        raise HTTPException(status_code=400, detail="Activity already linked to this log")
    
    # Create link
    link = DailyLogActivity(
        log_id=log_id,
        task_activity_id=activity_in.task_activity_id
    )
    db.add(link)
    
    # Mark activity as completed
    activity.is_completed = True
    db.add(activity)
    
    await db.commit()
    await db.refresh(link)
    
    # DO NOT recalculate task progress here - it will be done when log is PM approved
    logger.info(
        "Activity %s marked complete in log %s (task progress will update on PM approval)",
        activity_in.task_activity_id, log_id
    )
    
    return link


@logs_router.get("/daily-logs/{log_id}/completed-activities", response_model=List[DailyLogActivityResponse], summary="List activities completed in this log")
async def list_completed_activities(
    log_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """Get all task activities that were marked complete in this daily log."""
    result = await db.execute(
        select(DailyLogActivity).where(DailyLogActivity.log_id == log_id)
    )
    return list(result.scalars().all())


@logs_router.delete("/daily-logs/{log_id}/completed-activities/{activity_id}", status_code=204, summary="Unlink activity from log")
async def remove_completed_activity(
    log_id: UUID, activity_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> None:
    """Remove the link between a log and an activity. This will mark the activity as incomplete.
    Task progress will be updated when the log is PM approved, not immediately."""
    from app.models.task import TaskActivity
    
    result = await db.execute(
        select(DailyLogActivity).where(
            DailyLogActivity.log_id == log_id,
            DailyLogActivity.task_activity_id == activity_id
        )
    )
    link = result.scalars().first()
    if not link:
        raise HTTPException(status_code=404, detail="Activity link not found")
    
    # Get activity to mark as incomplete
    activity = await db.get(TaskActivity, activity_id)
    if activity:
        activity.is_completed = False
        db.add(activity)
    
    await db.delete(link)
    await db.commit()
    
    # DO NOT recalculate task progress here - it will be done when log is PM approved
