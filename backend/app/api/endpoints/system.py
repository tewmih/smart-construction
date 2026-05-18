import csv
import io
from typing import Any, List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, Response
from sqlalchemy import select, func, or_

from app.api.dependencies import DbSession, get_current_active_user, get_current_admin_user
from app.models.user import User
from app.models.system import Message, AuditLog, SystemSetting, Announcement
from app.models.project import Project, Supplier
from app.schemas.system import (
    MessageResponse, AuditLogResponse, AuditLogPage,
    SystemSettingCreate, SystemSettingUpdate, SystemSettingResponse,
    SystemSettingsStructured, SystemSettingsUpdateRequest,
    AdminStatsResponse,
    AnnouncementCreate, AnnouncementUpdate, AnnouncementResponse,
)
from datetime import datetime, timedelta
from app.core.audit import log_audit

# ══════════════════════ Messages ══════════════════════
messages_router = APIRouter()

@messages_router.get("", response_model=List[MessageResponse], summary="List my messages")
async def list_messages(
    db: DbSession, current_user: User = Depends(get_current_active_user),
) -> Any:
    result = await db.execute(select(Message).where(Message.user_id == current_user.id).order_by(Message.created_at.desc()))
    return list(result.scalars().all())

@messages_router.get("/unread-count", summary="Unread message count")
async def unread_message_count(
    db: DbSession, current_user: User = Depends(get_current_active_user),
) -> Any:
    """Cheap aggregate used by the bell-icon badge."""
    result = await db.execute(
        select(func.count()).select_from(Message).where(
            Message.user_id == current_user.id,
            Message.is_read == False,  # noqa: E712
        )
    )
    return {"count": int(result.scalar() or 0)}

@messages_router.patch("/{message_id}/read", response_model=MessageResponse, summary="Mark message as read")
async def mark_message_read(
    message_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    msg = await db.get(Message, message_id)
    if not msg:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Message not found")
    msg.is_read = True
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return msg

# ══════════════════════ Audit Logs ══════════════════════
audit_router = APIRouter()

def _audit_filters(stmt, *, action: Optional[str], entity_type: Optional[str],
                   start_date: Optional[datetime], end_date: Optional[datetime],
                   user_id: Optional[UUID]):
    if action:
        stmt = stmt.where(AuditLog.action.ilike(f"%{action}%"))
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if start_date:
        stmt = stmt.where(AuditLog.created_at >= start_date)
    if end_date:
        stmt = stmt.where(AuditLog.created_at <= end_date)
    if user_id:
        stmt = stmt.where(AuditLog.user_id == user_id)
    return stmt


async def _hydrate_user_info(db, rows: list[AuditLog]) -> list[dict]:
    """Attach user_email + user_name to each row without N+1 queries."""
    user_ids = [r.user_id for r in rows if r.user_id]
    users_by_id: dict = {}
    if user_ids:
        res = await db.execute(select(User).where(User.id.in_(user_ids)))
        users_by_id = {u.id: u for u in res.scalars().all()}
    out = []
    for r in rows:
        user = users_by_id.get(r.user_id) if r.user_id else None
        out.append({
            "id": r.id,
            "project_id": r.project_id,
            "user_id": r.user_id,
            "user_email": user.email if user else None,
            "user_name": user.full_name if user else None,
            "action": r.action,
            "entity_type": r.entity_type,
            "entity_id": r.entity_id,
            "details": r.details,
            "created_at": r.created_at,
        })
    return out


@audit_router.get("", response_model=AuditLogPage, summary="List audit logs (Admin)")
async def list_audit_logs(
    db: DbSession,
    page: int = 1,
    limit: int = 50,
    action: Optional[str] = None,
    entity_type: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    user_search: Optional[str] = None,
    _: User = Depends(get_current_admin_user),
) -> Any:
    limit = max(1, min(limit, 200))
    page = max(1, page)
    offset = (page - 1) * limit

    # Resolve user search (email or name) to a user_id filter — simple LIKE join.
    user_id_filter: Optional[UUID] = None
    if user_search:
        u_res = await db.execute(
            select(User.id).where(
                or_(
                    User.email.ilike(f"%{user_search}%"),
                    User.full_name.ilike(f"%{user_search}%"),
                )
            )
        )
        ids = [r[0] for r in u_res.all()]
        if not ids:
            return {"total": 0, "page": page, "limit": limit, "data": []}
        # Use IN clause; we'll AND through _audit_filters with a single id only when 1 match,
        # otherwise inject as a where on the stmt below.
        user_id_filter = None  # we'll handle multi-id case below

    base_stmt = select(AuditLog)
    base_stmt = _audit_filters(
        base_stmt, action=action, entity_type=entity_type,
        start_date=start_date, end_date=end_date, user_id=user_id_filter,
    )
    if user_search and not user_id_filter:
        base_stmt = base_stmt.where(AuditLog.user_id.in_(ids))

    total = (await db.execute(
        select(func.count()).select_from(base_stmt.subquery())
    )).scalar() or 0

    rows = list((await db.execute(
        base_stmt.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit)
    )).scalars().all())

    return {
        "total": int(total),
        "page": page,
        "limit": limit,
        "data": await _hydrate_user_info(db, rows),
    }


@audit_router.get("/export.csv", summary="Export audit logs as CSV (Admin)")
async def export_audit_logs_csv(
    db: DbSession,
    action: Optional[str] = None,
    entity_type: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    user_search: Optional[str] = None,
    _: User = Depends(get_current_admin_user),
) -> Response:
    """Emit the filtered audit-log set as a CSV download. Caps at 10,000 rows."""
    ids: list[UUID] = []
    if user_search:
        u_res = await db.execute(
            select(User.id).where(
                or_(
                    User.email.ilike(f"%{user_search}%"),
                    User.full_name.ilike(f"%{user_search}%"),
                )
            )
        )
        ids = [r[0] for r in u_res.all()]

    stmt = select(AuditLog)
    stmt = _audit_filters(
        stmt, action=action, entity_type=entity_type,
        start_date=start_date, end_date=end_date, user_id=None,
    )
    if user_search:
        if not ids:
            stmt = stmt.where(False)
        else:
            stmt = stmt.where(AuditLog.user_id.in_(ids))

    rows = list((await db.execute(
        stmt.order_by(AuditLog.created_at.desc()).limit(10_000)
    )).scalars().all())
    rows_hydrated = await _hydrate_user_info(db, rows)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "timestamp", "action", "entity_type", "entity_id",
        "user_email", "user_name", "user_id", "project_id", "details",
    ])
    for r in rows_hydrated:
        writer.writerow([
            r["created_at"].isoformat() if r["created_at"] else "",
            r["action"] or "",
            r["entity_type"] or "",
            r["entity_id"] or "",
            r["user_email"] or "",
            r["user_name"] or "",
            str(r["user_id"]) if r["user_id"] else "",
            str(r["project_id"]) if r["project_id"] else "",
            (r["details"] or "").replace("\n", " "),
        ])

    filename = f"audit-logs-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@audit_router.get("/projects/{project_id}", response_model=List[AuditLogResponse], summary="List project audit logs")
async def list_project_audit_logs(
    project_id: UUID, db: DbSession, skip: int = 0, limit: int = 100,
    _: User = Depends(get_current_active_user),
) -> Any:
    result = await db.execute(
        select(AuditLog).where(AuditLog.project_id == project_id)
        .order_by(AuditLog.created_at.desc()).offset(skip).limit(limit)
    )
    rows = list(result.scalars().all())
    return await _hydrate_user_info(db, rows)

# ══════════════════════ System Settings ══════════════════════
settings_router = APIRouter()

@settings_router.get("", response_model=List[SystemSettingResponse], summary="List settings (Admin)")
async def list_settings(
    db: DbSession, _: User = Depends(get_current_admin_user),
) -> Any:
    result = await db.execute(select(SystemSetting))
    return list(result.scalars().all())

@settings_router.put("", response_model=SystemSettingResponse, summary="Create/update setting (Admin)")
async def upsert_setting(
    *, db: DbSession, setting_in: SystemSettingCreate,
    _: User = Depends(get_current_admin_user),
) -> Any:
    result = await db.execute(select(SystemSetting).where(SystemSetting.key == setting_in.key))
    existing = result.scalars().first()
    if existing:
        existing.value = setting_in.value
        db.add(existing)
        await db.commit()
        await db.refresh(existing)
        return existing
    else:
        import uuid
        obj = SystemSetting(id=uuid.uuid4(), key=setting_in.key, value=setting_in.value)
        db.add(obj)
        await db.commit()
        await db.refresh(obj)
        return obj

@settings_router.get("/structured", response_model=SystemSettingsStructured, summary="Get structured settings (Admin)")
async def get_structured_settings(
    db: DbSession, _: User = Depends(get_current_admin_user),
) -> Any:
    """Get all system settings in a structured format"""
    result = await db.execute(select(SystemSetting))
    settings = {s.key: s.value for s in result.scalars().all()}
    
    return SystemSettingsStructured(
        working_hours_per_day=float(settings.get("working_hours_per_day", "8.0")),
        working_days_per_week=int(settings.get("working_days_per_week", "6")),
        overtime_multiplier=float(settings.get("overtime_multiplier", "1.5")),
        delay_risk_threshold_pct=float(settings.get("delay_risk_threshold_pct", "60.0")),
        budget_alert_threshold_pct=float(settings.get("budget_alert_threshold_pct", "80.0")),
        maintenance_mode=settings.get("maintenance_mode", "false").lower() == "true",
    )

@settings_router.put("/structured", response_model=SystemSettingsStructured, summary="Update structured settings (Admin)")
async def update_structured_settings(
    *, db: DbSession, settings_in: SystemSettingsUpdateRequest,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Update system settings in a structured format"""
    import uuid
    
    updates = settings_in.model_dump(exclude_unset=True)
    
    for key, value in updates.items():
        # Convert value to string for storage
        str_value = str(value).lower() if isinstance(value, bool) else str(value)
        
        result = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
        existing = result.scalars().first()
        
        if existing:
            existing.value = str_value
            db.add(existing)
        else:
            obj = SystemSetting(id=uuid.uuid4(), key=key, value=str_value)
            db.add(obj)
    
    # Audit log
    await log_audit(
        db=db,
        user_id=current_user.id,
        action="UPDATE_SETTINGS",
        entity_type="system_settings",
        details=f"Updated settings: {', '.join(updates.keys())}"
    )
    
    await db.commit()
    
    # Return updated settings
    return await get_structured_settings(db, current_user)

# ══════════════════════ Admin Stats ══════════════════════
admin_router = APIRouter()

@admin_router.get("/stats", response_model=AdminStatsResponse, summary="Get platform stats (Admin)")
async def get_admin_stats(
    db: DbSession, _: User = Depends(get_current_admin_user),
) -> Any:
    """Get platform-wide statistics for admin dashboard"""
    
    # Total users
    total_users_result = await db.execute(select(func.count(User.id)))
    total_users = total_users_result.scalar() or 0
    
    # Active users
    active_users_result = await db.execute(select(func.count(User.id)).where(User.is_active == True))
    active_users = active_users_result.scalar() or 0
    
    # Total projects
    total_projects_result = await db.execute(select(func.count(Project.id)))
    total_projects = total_projects_result.scalar() or 0
    
    # Projects by status
    projects_result = await db.execute(select(Project.status, func.count(Project.id)).group_by(Project.status))
    projects_by_status = {status: count for status, count in projects_result.all()}
    
    # Total suppliers
    total_suppliers_result = await db.execute(select(func.count(Supplier.id)))
    total_suppliers = total_suppliers_result.scalar() or 0
    
    # Recent activity (last 7 days)
    seven_days_ago = datetime.utcnow() - timedelta(days=7)
    recent_activity_result = await db.execute(
        select(func.count(AuditLog.id)).where(AuditLog.created_at >= seven_days_ago)
    )
    recent_activity_count = recent_activity_result.scalar() or 0
    
    return AdminStatsResponse(
        total_users=total_users,
        active_users=active_users,
        total_projects=total_projects,
        projects_by_status=projects_by_status,
        total_suppliers=total_suppliers,
        recent_activity_count=recent_activity_count,
    )


@admin_router.get("/platform-summary", summary="Cross-project platform summary (Admin)")
async def admin_platform_summary(
    db: DbSession, _: User = Depends(get_current_admin_user),
) -> Any:
    """Aggregate metrics across every project — used by the System Reports page."""
    from app.models.task import Task
    from app.models.log import DailyLog

    # Users
    total_users = (await db.execute(select(func.count(User.id)))).scalar() or 0
    active_users = (await db.execute(select(func.count(User.id)).where(User.is_active == True))).scalar() or 0  # noqa: E712
    admin_users = (await db.execute(select(func.count(User.id)).where(User.is_admin == True))).scalar() or 0  # noqa: E712

    # Projects + budgets
    projects = list((await db.execute(select(Project))).scalars().all())
    total_projects = len(projects)
    by_status: dict[str, int] = {}
    total_budget = 0.0
    total_spent = 0.0
    for p in projects:
        by_status[p.status or "unknown"] = by_status.get(p.status or "unknown", 0) + 1
        total_budget += float(p.total_budget or 0.0)
        total_spent += float(p.budget_spent or 0.0)

    # Tasks
    total_tasks = (await db.execute(select(func.count(Task.id)))).scalar() or 0
    completed_tasks = (await db.execute(
        select(func.count(Task.id)).where(Task.status == "completed")
    )).scalar() or 0

    # Daily logs
    total_logs = (await db.execute(select(func.count(DailyLog.id)))).scalar() or 0
    pm_approved_logs = (await db.execute(
        select(func.count(DailyLog.id)).where(DailyLog.status == "pm_approved")
    )).scalar() or 0

    return {
        "users": {"total": int(total_users), "active": int(active_users), "admins": int(admin_users)},
        "projects": {
            "total": total_projects,
            "by_status": by_status,
            "total_budget": round(total_budget, 2),
            "total_spent": round(total_spent, 2),
            "remaining": round(total_budget - total_spent, 2),
        },
        "tasks": {"total": int(total_tasks), "completed": int(completed_tasks)},
        "daily_logs": {"total": int(total_logs), "pm_approved": int(pm_approved_logs)},
    }


@admin_router.get("/activity-summary", summary="Activity over time (Admin)")
async def admin_activity_summary(
    db: DbSession,
    days: int = 30,
    _: User = Depends(get_current_admin_user),
) -> Any:
    """Time-series of signups, logins, log approvals, and audit events bucketed by day."""
    from app.models.log import DailyLog
    days = max(1, min(days, 180))
    cutoff = datetime.utcnow() - timedelta(days=days)

    # Daily signups
    signup_rows = (await db.execute(
        select(func.date(User.created_at), func.count(User.id))
        .where(User.created_at >= cutoff)
        .group_by(func.date(User.created_at))
    )).all()
    signups = {str(d): int(c) for d, c in signup_rows}

    # Daily logins (using last_login_at as a proxy — gives "active users today" only)
    login_rows = (await db.execute(
        select(func.date(User.last_login_at), func.count(User.id))
        .where(User.last_login_at >= cutoff)
        .group_by(func.date(User.last_login_at))
    )).all()
    logins = {str(d): int(c) for d, c in login_rows}

    # Daily log approvals
    approval_rows = (await db.execute(
        select(func.date(DailyLog.date), func.count(DailyLog.id))
        .where(DailyLog.date >= cutoff, DailyLog.status == "pm_approved")
        .group_by(func.date(DailyLog.date))
    )).all()
    approvals = {str(d): int(c) for d, c in approval_rows}

    # Audit events / day
    audit_rows = (await db.execute(
        select(func.date(AuditLog.created_at), func.count(AuditLog.id))
        .where(AuditLog.created_at >= cutoff)
        .group_by(func.date(AuditLog.created_at))
    )).all()
    audit_events = {str(d): int(c) for d, c in audit_rows}

    # Build a continuous day-by-day series from cutoff to today
    series = []
    today = datetime.utcnow().date()
    start_day = cutoff.date()
    cur = start_day
    while cur <= today:
        key = cur.isoformat()
        series.append({
            "date": key,
            "signups": signups.get(key, 0),
            "logins": logins.get(key, 0),
            "log_approvals": approvals.get(key, 0),
            "audit_events": audit_events.get(key, 0),
        })
        cur = cur + timedelta(days=1)

    return {"days": days, "series": series}


@admin_router.get("/recent-activity", summary="Most recent audit events (Admin)")
async def admin_recent_activity(
    db: DbSession,
    limit: int = 10,
    _: User = Depends(get_current_admin_user),
) -> Any:
    """The N most recent audit-log entries with user info attached. Powers the dashboard feed."""
    limit = max(1, min(limit, 50))
    rows = list((await db.execute(
        select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    )).scalars().all())
    return await _hydrate_user_info(db, rows)


@admin_router.get("/system-health", summary="Lightweight system health (Admin)")
async def admin_system_health(
    db: DbSession, _: User = Depends(get_current_admin_user),
) -> Any:
    """Quick health indicators: DB reachability, table row counts, ML model status."""
    from app.models.task import Task
    from app.models.log import DailyLog
    from app.services import ml_predictor

    health: dict = {"status": "ok"}

    # DB reachability — if we got this far the connection works.
    try:
        await db.execute(select(1))
        health["database"] = {"reachable": True}
    except Exception as exc:
        health["database"] = {"reachable": False, "error": str(exc)}
        health["status"] = "degraded"

    # Row counts (cheap)
    health["row_counts"] = {
        "users": int((await db.execute(select(func.count(User.id)))).scalar() or 0),
        "projects": int((await db.execute(select(func.count(Project.id)))).scalar() or 0),
        "tasks": int((await db.execute(select(func.count(Task.id)))).scalar() or 0),
        "daily_logs": int((await db.execute(select(func.count(DailyLog.id)))).scalar() or 0),
        "audit_logs": int((await db.execute(select(func.count(AuditLog.id)))).scalar() or 0),
    }

    # ML model state
    try:
        health["ml_model_loaded"] = bool(ml_predictor.is_loaded())
    except Exception:
        health["ml_model_loaded"] = False

    # Last hour audit events — a rough liveness signal
    one_hour_ago = datetime.utcnow() - timedelta(hours=1)
    health["audit_events_last_hour"] = int(
        (await db.execute(
            select(func.count(AuditLog.id)).where(AuditLog.created_at >= one_hour_ago)
        )).scalar() or 0
    )

    return health


# ══════════════════════ Announcements ══════════════════════
announcements_router = APIRouter()

@announcements_router.get("", response_model=List[AnnouncementResponse], summary="List active announcements")
async def list_announcements(
    db: DbSession,
    skip: int = 0,
    limit: int = 100,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """List active announcements that target this user (audience-aware)."""
    from app.models.project import ProjectMember
    from app.models.commons import ProjectRole

    now = datetime.utcnow()

    # Build the set of audiences this user belongs to.
    audiences = ["all"]
    if current_user.is_admin:
        audiences.append("admins")
    pm_row = await db.execute(
        select(ProjectMember.id).where(
            ProjectMember.user_id == current_user.id,
            ProjectMember.role == ProjectRole.PROJECT_MANAGER.value,
        ).limit(1)
    )
    if pm_row.scalars().first() is not None:
        audiences.append("project_managers")

    result = await db.execute(
        select(Announcement)
        .where(Announcement.is_active == True)  # noqa: E712
        .where((Announcement.expires_at == None) | (Announcement.expires_at > now))  # noqa: E711
        .where(Announcement.target_audience.in_(audiences))
        .order_by(Announcement.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return list(result.scalars().all())

@announcements_router.get("/all", response_model=List[AnnouncementResponse], summary="List all announcements (Admin)")
async def list_all_announcements(
    db: DbSession, 
    skip: int = 0, 
    limit: int = 100,
    _: User = Depends(get_current_admin_user),
) -> Any:
    """List all announcements including inactive and expired. Admin only."""
    result = await db.execute(
        select(Announcement)
        .order_by(Announcement.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return list(result.scalars().all())

@announcements_router.post("", response_model=AnnouncementResponse, summary="Create announcement (Admin)")
async def create_announcement(
    *, 
    db: DbSession, 
    announcement_in: AnnouncementCreate,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Create a new platform-wide announcement. Admin only."""
    import uuid
    target = announcement_in.target_audience or "all"
    if target not in {"all", "admins", "project_managers"}:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="target_audience must be one of: all, admins, project_managers")

    obj = Announcement(
        id=uuid.uuid4(),
        title=announcement_in.title,
        content=announcement_in.content,
        priority=announcement_in.priority,
        target_audience=target,
        expires_at=announcement_in.expires_at,
        created_by=current_user.id,
    )
    db.add(obj)

    await log_audit(
        db=db,
        user_id=current_user.id,
        action="CREATE_ANNOUNCEMENT",
        entity_type="announcement",
        entity_id=str(obj.id),
        details=f"Created announcement ({target}): {announcement_in.title}"
    )

    # Fan out only to the targeted audience.
    from app.services.notifications import notify_many, notify_all_active_users
    if target == "admins":
        admin_rows = await db.execute(
            select(User.id).where(User.is_admin == True, User.is_active == True)  # noqa: E712
        )
        await notify_many(
            db,
            user_ids=[r[0] for r in admin_rows.all()],
            type="announcement",
            content=announcement_in.title or announcement_in.content[:200],
            entity_type="announcement",
            entity_id=obj.id,
        )
    elif target == "project_managers":
        from app.models.project import ProjectMember
        from app.models.commons import ProjectRole
        pm_rows = await db.execute(
            select(ProjectMember.user_id).where(ProjectMember.role == ProjectRole.PROJECT_MANAGER.value).distinct()
        )
        await notify_many(
            db,
            user_ids=[r[0] for r in pm_rows.all()],
            type="announcement",
            content=announcement_in.title or announcement_in.content[:200],
            entity_type="announcement",
            entity_id=obj.id,
        )
    else:
        await notify_all_active_users(
            db,
            type="announcement",
            content=announcement_in.title or announcement_in.content[:200],
            entity_type="announcement",
            entity_id=obj.id,
        )

    await db.commit()
    await db.refresh(obj)
    return obj

@announcements_router.put("/{announcement_id}", response_model=AnnouncementResponse, summary="Update announcement (Admin)")
async def update_announcement(
    announcement_id: UUID,
    *,
    db: DbSession,
    announcement_in: AnnouncementUpdate,
    _: User = Depends(get_current_admin_user),
) -> Any:
    """Update an announcement. Admin only."""
    announcement = await db.get(Announcement, announcement_id)
    if not announcement:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Announcement not found")
    
    update_data = announcement_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(announcement, field, value)
    
    db.add(announcement)
    await db.commit()
    await db.refresh(announcement)
    return announcement

@announcements_router.delete("/{announcement_id}", summary="Delete announcement (Admin)")
async def delete_announcement(
    announcement_id: UUID,
    db: DbSession,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Delete an announcement. Admin only."""
    announcement = await db.get(Announcement, announcement_id)
    if not announcement:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Announcement not found")
    
    title = announcement.title
    await db.delete(announcement)
    
    # Audit log
    await log_audit(
        db=db,
        user_id=current_user.id,
        action="DELETE_ANNOUNCEMENT",
        entity_type="announcement",
        entity_id=str(announcement_id),
        details=f"Deleted announcement: {title}"
    )
    
    await db.commit()
    return {"message": "Announcement deleted successfully"}
