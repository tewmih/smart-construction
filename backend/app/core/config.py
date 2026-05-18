import os
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator

# Sentinel for the well-known dev secret. If we see it in production, refuse to boot.
_INSECURE_DEV_SECRET = "09d25e094faa6ca2556c818166b7a9563b93f7099f6f0f4caa6cf63b88e8d3e7"


class Settings(BaseSettings):
    PROJECT_NAME: str = "Foresite API"
    API_V1_STR: str = "/api/v1"

    # Set ENV=production in the deployed environment to enforce stricter checks.
    ENV: str = "development"

    # SECRET_KEY: must be overridden in production. The default below is a public
    # dev-only value — config.__init__ rejects it when ENV=production.
    SECRET_KEY: str = _INSECURE_DEV_SECRET
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # CORS — accepts either a JSON list or a comma-separated string from env.
    # In dev we default to wide-open; in production point it at your Vercel URLs.
    BACKEND_CORS_ORIGINS: List[str] = ["*"]

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def _parse_cors(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                # Pydantic will parse JSON lists itself.
                return v
            # Comma-separated → list of trimmed origins.
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    # Database — required. asyncpg URL handled by SQLALCHEMY_DATABASE_URI below.
    DATABASE_URL: str = os.getenv("DATABASE_URL") or ""

    # Frontend URL — used in email links (password reset / invitations).
    FRONTEND_URL: str = "http://localhost:3000"

    # Email — Resend (HTTP, works in restricted egress environments)
    RESEND_API_KEY: str | None = None
    RESEND_FROM_EMAIL: str = "Foresite <onboarding@resend.dev>"

    # Email — SMTP fallback (works for local dev; flaky on locked-down hosts)
    SMTP_EMAIL: str | None = None
    SMTP_PASSWORD: str | None = None
    SMTP_HOST: str | None = None
    SMTP_PORT: int | None = None

    # Google Sign-In (optional; /auth/google returns 503 if unset)
    GOOGLE_CLIENT_ID: str | None = None

    # Cloudinary (optional). When all three are set, daily-log photos go to
    # Cloudinary; otherwise the backend writes them to backend/uploads/ which
    # only survives on persistent volumes — not suitable for EC2 replacement.
    CLOUDINARY_CLOUD_NAME: str | None = None
    CLOUDINARY_API_KEY: str | None = None
    CLOUDINARY_API_SECRET: str | None = None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    def model_post_init(self, __context) -> None:
        # Production safety rails — fail fast if obvious misconfig.
        if self.ENV == "production":
            if self.SECRET_KEY == _INSECURE_DEV_SECRET:
                raise RuntimeError(
                    "SECRET_KEY is still the public dev default. "
                    "Set a strong SECRET_KEY env var in production."
                )
            if "*" in self.BACKEND_CORS_ORIGINS:
                raise RuntimeError(
                    "BACKEND_CORS_ORIGINS contains '*' in production. "
                    "Set it to a comma-separated list of allowed origins."
                )
            if not self.DATABASE_URL:
                raise RuntimeError("DATABASE_URL is required in production.")

    @property
    def SQLALCHEMY_DATABASE_URI(self) -> str:
        url = self.DATABASE_URL
        # Convert standard Postgres URL to use async driver
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        # Avoid asyncpg conflicts with strict channel_binding (e.g., Neon)
        if "channel_binding=require" in url:
            url = url.replace("&channel_binding=require", "")
            url = url.replace("?channel_binding=require", "")
        # asyncpg does not understand sslmode; strip it (use ssl=True on the engine if needed)
        url = url.replace("?sslmode=require", "")
        url = url.replace("&sslmode=require", "")
        return url


settings = Settings()
