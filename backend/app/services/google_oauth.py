"""
Self-contained Google Sign-In service.

Verifies a Google-issued ID token, then finds-or-creates a local user and
returns our standard Token (access + refresh) — same shape as /auth/login.

To remove the Google Sign-In feature entirely:
  1. Delete this file.
  2. Delete app/api/endpoints/oauth.py.
  3. Remove the oauth.router include from app/api/routes.py.
  4. Remove GOOGLE_CLIENT_ID from app/core/config.py.
  5. Remove google-auth from requirements.txt.
"""
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import logging

from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_requests

from app.core.config import settings
from app.core.security import create_access_token, create_refresh_token
from app.core.audit import log_audit
from app.models.user import User
from app.models.project import ProjectMember, ProjectInvitation
from app.repositories.user import UserRepository
from app.schemas.token import Token

logger = logging.getLogger(__name__)


class GoogleOAuthService:
    @staticmethod
    def _verify_id_token(id_token_str: str) -> dict:
        if not settings.GOOGLE_CLIENT_ID:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Google Sign-In is not configured on this server.",
            )
        try:
            # Verifies signature, expiration, issuer, and audience (our client ID).
            claims = google_id_token.verify_oauth2_token(
                id_token_str,
                google_requests.Request(),
                settings.GOOGLE_CLIENT_ID,
            )
        except ValueError as exc:
            logger.info("Google ID token verification failed: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Google ID token.",
            )

        # Extra defense: google-auth checks 'iss' but pin it explicitly.
        if claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token issuer.",
            )

        if not claims.get("email_verified", False):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Google account email is not verified.",
            )

        return claims

    @staticmethod
    async def _accept_pending_invitations(db: AsyncSession, user: User) -> None:
        """Mirror the invitation auto-accept logic used by UserService."""
        result = await db.execute(
            select(ProjectInvitation).where(
                ProjectInvitation.email == user.email,
                ProjectInvitation.status == "pending",
            )
        )
        pending = list(result.scalars().all())
        if not pending:
            return
        for inv in pending:
            existing = await db.execute(
                select(ProjectMember).where(
                    ProjectMember.project_id == inv.project_id,
                    ProjectMember.user_id == user.id,
                )
            )
            if not existing.scalars().first():
                db.add(ProjectMember(
                    project_id=inv.project_id,
                    user_id=user.id,
                    role=inv.role,
                ))
            inv.status = "accepted"
            db.add(inv)
            logger.info("Auto-accepted invitation for %s to project %s", user.email, inv.project_id)
        await db.commit()

    @staticmethod
    async def sign_in_with_google(db: AsyncSession, id_token_str: str) -> Token:
        claims = GoogleOAuthService._verify_id_token(id_token_str)

        google_id = claims["sub"]
        email = claims["email"]
        full_name = claims.get("name") or email.split("@")[0]

        # 1. Try to find an existing user by Google ID (returning Google user).
        user = await UserRepository.get_by_google_id(db, google_id=google_id)

        # 2. If not found by Google ID, try by email (existing local user linking Google).
        if not user:
            user = await UserRepository.get_by_email(db, email=email)
            if user:
                # Email is verified by Google, so it's safe to link.
                user = await UserRepository.link_google_id(db, user=user, google_id=google_id)

        # 3. Brand-new user — create via Google. Audit as REGISTER.
        is_new_signup = False
        if not user:
            user = await UserRepository.create_oauth_user(
                db,
                email=email,
                full_name=full_name,
                google_id=google_id,
            )
            is_new_signup = True

        if not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")

        await GoogleOAuthService._accept_pending_invitations(db, user)

        # Stamp last_login_at + audit the event (REGISTER on first signup, LOGIN otherwise).
        from datetime import datetime, timezone
        user.last_login_at = datetime.now(timezone.utc)
        db.add(user)
        if is_new_signup:
            await log_audit(
                db, user_id=user.id, action="REGISTER", entity_type="user",
                entity_id=str(user.id),
                details=f"New account via Google: {user.email}",
            )
        else:
            await log_audit(
                db, user_id=user.id, action="LOGIN", entity_type="user",
                entity_id=str(user.id),
                details=f"Google login for {user.email}",
            )
        await db.commit()

        access = create_access_token(subject=user.id)
        refresh = create_refresh_token(subject=user.id)
        return Token(access_token=access, refresh_token=refresh, token_type="bearer")
