from typing import Any, List
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException

from app.api.dependencies import DbSession, get_current_active_user, require_project_role
from app.models.user import User
from app.models.commons import ProjectRole
from app.schemas.project import (
    ProjectCreate, ProjectUpdate, ProjectResponse, ProjectDashboard,
    ProjectMemberCreate, ProjectMemberUpdate, ProjectMemberResponse,
    ProjectMemberWithUserResponse,
    ProjectInvitationCreate, ProjectInvitationResponse, ProjectInvitationAccept
)
from app.services.project import ProjectService, ProjectMemberService, ProjectInvitationService
from app.repositories.project import ProjectRepository, ProjectMemberRepository
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.models.project import ProjectMember

router = APIRouter()
project_repo = ProjectRepository()
member_repo = ProjectMemberRepository()

# ── Project CRUD ──

@router.post("", response_model=ProjectResponse, status_code=201, summary="Create a new project")
async def create_project(
    *, db: DbSession, project_in: ProjectCreate,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    return await ProjectService.create_project(db, project_in, current_user.id)

@router.get("", response_model=List[ProjectResponse], summary="List all projects")
async def list_projects(
    db: DbSession, skip: int = 0, limit: int = 100,
    _: User = Depends(get_current_active_user),
) -> Any:
    return await project_repo.get_all(db, skip=skip, limit=limit)

@router.get("/{project_id}", response_model=ProjectResponse, summary="Get project details")
async def get_project(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project

@router.put("/{project_id}", response_model=ProjectResponse, summary="Update project",
            dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def update_project(
    *, db: DbSession, project_id: UUID, project_in: ProjectUpdate,
) -> Any:
    return await ProjectService.update_project(db, project_id, project_in)

@router.delete("/{project_id}", status_code=204, summary="Delete project",
               dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def delete_project(
    project_id: UUID, db: DbSession,
    current_user: User = Depends(get_current_active_user),
) -> None:
    await ProjectService.delete_project(db, project_id, actor_id=current_user.id)


@router.get("/{project_id}/settings-overrides", summary="Get project setting overrides")
async def get_project_overrides(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """Return per-project setting overrides (null = inherit from global)."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "budget_alert_threshold_pct_override": project.budget_alert_threshold_pct_override,
    }


@router.put(
    "/{project_id}/settings-overrides",
    summary="Update project setting overrides",
    dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))],
)
async def update_project_overrides(
    *, db: DbSession, project_id: UUID,
    body: dict[str, Any],
) -> Any:
    """Set or clear a per-project threshold override. Pass null to clear."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if "budget_alert_threshold_pct_override" in body:
        val = body.get("budget_alert_threshold_pct_override")
        if val is None:
            project.budget_alert_threshold_pct_override = None
        else:
            try:
                v = float(val)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="budget_alert_threshold_pct_override must be a number or null")
            if v <= 0 or v >= 100:
                raise HTTPException(status_code=400, detail="threshold must be between 0 and 100 exclusive")
            project.budget_alert_threshold_pct_override = v
            # Reset the last-alerted marker so the new threshold can re-arm.
            project.last_alert_budget_threshold = None

    db.add(project)
    await db.commit()
    return {
        "budget_alert_threshold_pct_override": project.budget_alert_threshold_pct_override,
    }

# ── Project Dashboard ──

@router.get("/{project_id}/dashboard", response_model=ProjectDashboard, summary="Get project dashboard")
async def get_project_dashboard(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    return await ProjectService.get_dashboard(db, project_id)

# ── Project Members ──

@router.post("/{project_id}/members", response_model=ProjectMemberResponse, status_code=201, summary="Add project member",
             dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def add_member(
    *, db: DbSession, project_id: UUID, member_in: ProjectMemberCreate,
) -> Any:
    return await ProjectMemberService.add_member(db, project_id, member_in)

@router.get("/{project_id}/members", response_model=List[ProjectMemberWithUserResponse], summary="List project members")
async def list_members(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    result = await db.execute(
        select(ProjectMember)
        .options(selectinload(ProjectMember.user))
        .where(ProjectMember.project_id == project_id)
    )
    return list(result.scalars().all())

@router.patch("/{project_id}/members/{user_id}", response_model=ProjectMemberResponse, summary="Update member role",
              dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def update_member_role(
    *, db: DbSession, project_id: UUID, user_id: UUID, update_in: ProjectMemberUpdate,
) -> Any:
    return await ProjectMemberService.update_member_role(db, project_id, user_id, update_in)

@router.delete("/{project_id}/members/{user_id}", status_code=204, summary="Remove project member",
               dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def remove_member(project_id: UUID, user_id: UUID, db: DbSession) -> None:
    await ProjectMemberService.remove_member(db, project_id, user_id)

# ── Project Invitations ──

@router.post("/{project_id}/invitations", response_model=ProjectInvitationResponse, status_code=201, summary="Create invitation (any role)",
             dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def create_invitation(
    *, db: DbSession, project_id: UUID, invite_in: ProjectInvitationCreate,
) -> Any:
    return await ProjectInvitationService.create_invitation(db, project_id, invite_in)

@router.get("/{project_id}/invitations", response_model=List[ProjectInvitationResponse], summary="List invitations",
            dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def list_invitations(
    project_id: UUID, db: DbSession,
    status: str | None = None,
) -> Any:
    """
    List invitations for a project.
    By default returns ALL invitations regardless of status.
    Pass ?status=pending|accepted|expired to filter.
    """
    return await ProjectInvitationService.get_invitations(db, project_id, status=status)

@router.post("/{project_id}/invitations/{invitation_id}/resend", response_model=ProjectInvitationResponse, summary="Resend invitation email",
             dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def resend_invitation(
    *, db: DbSession, project_id: UUID, invitation_id: UUID,
) -> Any:
    return await ProjectInvitationService.resend_invitation(db, project_id, invitation_id)

@router.delete("/{project_id}/invitations/{invitation_id}", status_code=204, summary="Delete invitation",
               dependencies=[Depends(require_project_role([ProjectRole.OWNER, ProjectRole.PROJECT_MANAGER]))])
async def delete_invitation(project_id: UUID, invitation_id: UUID, db: DbSession) -> None:
    """
    Delete an invitation by id. Works for any status (pending/accepted/expired).
    Note: deleting an accepted invitation does NOT remove the project member —
    it only removes the historical record. Use DELETE /members/{user_id} for that.
    """
    await ProjectInvitationService.delete_invitation(db, project_id, invitation_id)

@router.post("/invitations/accept", response_model=ProjectMemberResponse, summary="Accept an invitation")
async def accept_invitation(
    *, db: DbSession, accept_in: ProjectInvitationAccept,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    return await ProjectInvitationService.accept_invitation(db, accept_in.token, current_user.id)
