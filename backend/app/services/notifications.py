"""
Notification helper.

Every event that should produce an in-app notification calls `notify(...)`.
The helper builds a Message row but never commits — the caller's transaction
is the source of truth. Failure to enqueue a notification must NEVER bubble up
and roll back the user's main operation, so all errors are logged and swallowed.

Message types currently in use:
    log_submitted              — sent to consultant when SE submits
    log_consultant_approved    — sent to PM when consultant approves
    log_approved               — sent to log creator when PM finalises
    log_rejected               — sent to log creator on rejection
    member_added               — sent to new project member
    task_assigned              — sent to assignee when task assignment changes
    invitation                 — sent to existing user being invited
    announcement               — sent to every active user when admin posts
    risk_alert                 — sent to PM when ML risk level escalates
    budget_alert               — sent to PM when spend crosses 80% / 100%
"""
import logging
from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system import Message
from app.models.user import User

logger = logging.getLogger(__name__)


async def notify(
    db: AsyncSession,
    *,
    user_id: UUID,
    type: str,
    content: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[UUID] = None,
    project_id: Optional[UUID] = None,
) -> Optional[Message]:
    """Enqueue an in-app notification for a single user."""
    try:
        message = Message(
            user_id=user_id,
            type=type,
            content=content,
            entity_type=entity_type,
            entity_id=entity_id,
            project_id=project_id,
        )
        db.add(message)
        await db.flush()
        return message
    except Exception:
        logger.exception("notify failed for user=%s type=%s — swallowing", user_id, type)
        return None


async def notify_many(
    db: AsyncSession,
    *,
    user_ids: list[UUID],
    type: str,
    content: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[UUID] = None,
    project_id: Optional[UUID] = None,
) -> int:
    """Enqueue the same notification for multiple recipients. Returns count created."""
    created = 0
    for uid in user_ids:
        msg = await notify(
            db,
            user_id=uid,
            type=type,
            content=content,
            entity_type=entity_type,
            entity_id=entity_id,
            project_id=project_id,
        )
        if msg is not None:
            created += 1
    return created


async def notify_all_active_users(
    db: AsyncSession,
    *,
    type: str,
    content: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[UUID] = None,
) -> int:
    """Fan out a notification to every active user. Used for global announcements."""
    result = await db.execute(select(User.id).where(User.is_active == True))  # noqa: E712
    user_ids = [row[0] for row in result.all()]
    return await notify_many(
        db,
        user_ids=user_ids,
        type=type,
        content=content,
        entity_type=entity_type,
        entity_id=entity_id,
    )
