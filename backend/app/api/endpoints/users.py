from typing import Any, List
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException

from app.api.dependencies import DbSession, get_current_active_user, get_current_admin_user
from app.schemas.user import UserResponse, UserUpdate, UserPage
from app.models.user import User
from app.services.user import UserService
from app.repositories.user import UserRepository
from app.core.audit import log_audit

router = APIRouter()

# ── Current User ──

@router.get("/me", response_model=UserResponse, summary="Get current user profile")
async def read_user_me(
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Return the currently authenticated user's profile."""
    return current_user

@router.put("/me", response_model=UserResponse, summary="Update own profile")
async def update_user_me(
    *,
    db: DbSession,
    user_in: UserUpdate,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """Update the currently authenticated user's profile (name, phone, etc.)."""
    return await UserService.update_user(db=db, db_user=current_user, user_in=user_in)

# ── Admin: User Management ──

@router.get("", response_model=UserPage, summary="List all users (Admin)")
async def read_users(
    db: DbSession,
    page: int = 1,
    limit: int = 50,
    search: str | None = None,
    is_active: bool | None = None,
    is_admin: bool | None = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Paginated user listing with filters + sorting. Admin only."""
    limit = max(1, min(limit, 200))
    page = max(1, page)
    skip = (page - 1) * limit

    total = await UserRepository.count_all(
        db, search=search, is_active=is_active, is_admin=is_admin
    )
    data = await UserRepository.get_all(
        db, skip=skip, limit=limit,
        search=search, is_active=is_active, is_admin=is_admin,
        sort_by=sort_by, sort_dir=sort_dir,
    )
    return {"total": total, "page": page, "limit": limit, "data": data}

@router.get("/{user_id}", response_model=UserResponse, summary="Get user by ID (Admin)")
async def read_user_by_id(
    user_id: UUID,
    db: DbSession,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Get a specific user by their ID. Admin only."""
    user = await UserRepository.get_by_id(db, id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@router.put("/{user_id}", response_model=UserResponse, summary="Update user (Admin)")
async def update_user(
    *,
    db: DbSession,
    user_id: UUID,
    user_in: UserUpdate,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Update any user's profile. Admin only."""
    user = await UserRepository.get_by_id(db, id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return await UserService.update_user(db=db, db_user=user, user_in=user_in)

@router.patch("/{user_id}/activate", response_model=UserResponse, summary="Activate user (Admin)")
async def activate_user(
    user_id: UUID,
    db: DbSession,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Re-activate a deactivated user account. Admin only."""
    user = await UserRepository.activate(db, id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Audit log
    await log_audit(
        db=db,
        user_id=current_user.id,
        action="ACTIVATE_USER",
        entity_type="user",
        entity_id=str(user_id),
        details=f"Activated user: {user.email}"
    )
    await db.commit()
    
    return user

@router.patch("/{user_id}/deactivate", response_model=UserResponse, summary="Deactivate user (Admin)")
async def deactivate_user(
    user_id: UUID,
    db: DbSession,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Deactivate a user account. The user can no longer login. Admin only."""
    user = await UserRepository.deactivate(db, id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Audit log
    await log_audit(
        db=db,
        user_id=current_user.id,
        action="DEACTIVATE_USER",
        entity_type="user",
        entity_id=str(user_id),
        details=f"Deactivated user: {user.email}"
    )
    await db.commit()
    
    return user

@router.patch("/{user_id}/promote", response_model=UserResponse, summary="Promote user to admin (Admin)")
async def promote_user(
    user_id: UUID,
    db: DbSession,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Promote a user to admin. Admin cannot promote themselves. Admin only."""
    if user_id == current_user.id:
        raise HTTPException(status_code=403, detail="Cannot promote yourself")
    
    user = await UserRepository.get_by_id(db, id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    if user.is_admin:
        raise HTTPException(status_code=400, detail="User is already an admin")
    
    user = await UserRepository.promote(db, id=user_id)
    
    # Audit log
    await log_audit(
        db=db,
        user_id=current_user.id,
        action="PROMOTE_USER",
        entity_type="user",
        entity_id=str(user_id),
        details=f"Promoted user to admin: {user.email}"
    )
    await db.commit()
    
    return user

@router.patch("/{user_id}/demote", response_model=UserResponse, summary="Demote admin to regular user (Admin)")
async def demote_user(
    user_id: UUID,
    db: DbSession,
    current_user: User = Depends(get_current_admin_user),
) -> Any:
    """Demote an admin to regular user. Admin cannot demote themselves. Admin only."""
    if user_id == current_user.id:
        raise HTTPException(status_code=403, detail="Cannot demote yourself")
    
    user = await UserRepository.get_by_id(db, id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    if not user.is_admin:
        raise HTTPException(status_code=400, detail="User is not an admin")
    
    user = await UserRepository.demote(db, id=user_id)
    
    # Audit log
    await log_audit(
        db=db,
        user_id=current_user.id,
        action="DEMOTE_USER",
        entity_type="user",
        entity_id=str(user_id),
        details=f"Demoted admin to user: {user.email}"
    )
    await db.commit()
    
    return user
