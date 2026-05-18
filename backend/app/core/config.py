import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List

class Settings(BaseSettings):
    PROJECT_NAME: str = "Foresite API"
    API_V1_STR: str = "/api/v1"
    SECRET_KEY: str = "09d25e094faa6ca2556c818166b7a9563b93f7099f6f0f4caa6cf63b88e8d3e7"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    BACKEND_CORS_ORIGINS: List[str] = ["*"]
    
    # Defaults to Neon URL if not found in environment
    DATABASE_URL: str = os.getenv("DATABASE_URL")
    
    # Frontend URL for email links
    FRONTEND_URL: str = "https://smart-construction-three.vercel.app"

    # Email — Resend (HTTP API, used on Render where SMTP is blocked)
    RESEND_API_KEY: str | None = None
    RESEND_FROM_EMAIL: str = "Foresite <onboarding@resend.dev>"

    # Email — SMTP fallback (used locally; do NOT rely on this on Render)
    SMTP_EMAIL: str | None = None
    SMTP_PASSWORD: str | None = None
    SMTP_HOST: str | None = None
    SMTP_PORT: int | None = None

    # Google Sign-In (optional). When unset, /auth/google returns 503.
    GOOGLE_CLIENT_ID: str | None = None

    # Cloudinary (optional). When all three are set, daily-log photos are uploaded
    # to Cloudinary instead of the local backend/uploads/ folder. Leave any of
    # these unset to fall back to local storage.
    CLOUDINARY_CLOUD_NAME: str | None = None
    CLOUDINARY_API_KEY: str | None = None
    CLOUDINARY_API_SECRET: str | None = None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def SQLALCHEMY_DATABASE_URI(self) -> str:
        url = self.DATABASE_URL
        # Convert standard Postgres URL to use async driver
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        # Avoid asyncpg conflicts with strict channel_binding query params in neon
        if "channel_binding=require" in url:
            url = url.replace("&channel_binding=require", "")
            url = url.replace("?channel_binding=require", "")
        # Remove sslmode for asyncpg compatibility
        url = url.replace("?sslmode=require", "")
        url = url.replace("&sslmode=require", "")
        return url

settings = Settings()
