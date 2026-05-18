import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

from app.core.config import settings
from app.api.routes import api_router
from app.database.session import engine
from app.models.user import Base
from app.services.ml_predictor import load_artifacts as load_ml_artifacts

# Import all model modules so their tables register into Base.metadata
import app.models.user
import app.models.project
import app.models.task
import app.models.log
import app.models.system

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create any missing tables to sync with new models.
    # For production, use Alembic migrations instead.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Add new columns to pre-existing tables (safe to run repeatedly)
        await conn.execute(text(
            "ALTER TABLE materials ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255)"
        ))
        await conn.execute(text(
            "ALTER TABLE materials ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id)"
        ))
        await conn.execute(text(
            "ALTER TABLE materials ADD COLUMN IF NOT EXISTS delivery_date TIMESTAMP WITH TIME ZONE"
        ))
        await conn.execute(text(
            "ALTER TABLE manpower ADD COLUMN IF NOT EXISTS number_of_workers INTEGER DEFAULT 1"
        ))
        await conn.execute(text(
            "ALTER TABLE manpower ADD COLUMN IF NOT EXISTS overtime_hours FLOAT DEFAULT 0.0"
        ))
        await conn.execute(text(
            "ALTER TABLE manpower ADD COLUMN IF NOT EXISTS hourly_rate FLOAT DEFAULT 0.0"
        ))
        await conn.execute(text(
            "ALTER TABLE manpower ADD COLUMN IF NOT EXISTS overtime_rate FLOAT DEFAULT 0.0"
        ))
        await conn.execute(text(
            "ALTER TABLE materials ADD COLUMN IF NOT EXISTS unit_cost FLOAT DEFAULT 0.0"
        ))
        await conn.execute(text(
            "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1"
        ))
        await conn.execute(text(
            "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS start_date TIMESTAMP WITH TIME ZONE"
        ))
        await conn.execute(text(
            "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS unit_cost FLOAT DEFAULT 0.0"
        ))
        await conn.execute(text(
            "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS idle_hours FLOAT DEFAULT 0.0"
        ))
        await conn.execute(text(
            "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS idle_reason TEXT"
        ))
        # Notifications: extend messages with type/entity link and bookkeeping on projects
        await conn.execute(text(
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS type VARCHAR(50)"
        ))
        await conn.execute(text(
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50)"
        ))
        await conn.execute(text(
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS entity_id UUID"
        ))
        await conn.execute(text(
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)"
        ))
        await conn.execute(text(
            "ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_alert_risk_level VARCHAR(20)"
        ))
        await conn.execute(text(
            "ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_alert_budget_threshold FLOAT"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE"
        ))
        await conn.execute(text(
            "ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_audience VARCHAR(50) NOT NULL DEFAULT 'all'"
        ))
        await conn.execute(text(
            "ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_alert_threshold_pct_override FLOAT"
        ))
    load_ml_artifacts()
    yield

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    lifespan=lifespan
)

@app.exception_handler(IntegrityError)
async def integrity_exception_handler(request: Request, exc: IntegrityError):
    """
    Global handler for database integrity errors (Foreign Key, Unique constraints).
    """
    detail = str(exc.orig)
    
    # Custom parsing for common asyncpg / sqlalchemy error messages
    if "is not present in table" in detail:
        return JSONResponse(
            status_code=400,
            content={"detail": "Reference error: The related record (ID) does not exist."},
        )
    if "already exists" in detail:
        return JSONResponse(
            status_code=409,
            content={"detail": "Conflict error: One or more fields already exist (Unique constraint violated)."},
        )
        
    return JSONResponse(
        status_code=400,
        content={"detail": f"Database integrity error: {detail}"},
    )


# Set all CORS enabled origins
if settings.BACKEND_CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[str(origin) for origin in settings.BACKEND_CORS_ORIGINS],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(api_router, prefix=settings.API_V1_STR)

# Local file storage for daily-log photos. Lives at backend/uploads/.
# Files are written by the photo upload endpoint and served back via this mount.
UPLOAD_DIR = Path(__file__).resolve().parents[1] / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

@app.get("/")
def root():
    return {"message": "Welcome to Foresite API"}


@app.get("/health")
def health():
    """Cheap liveness probe — no DB hit, returns immediately.
    Use this for ALB / Caddy / Docker HEALTHCHECK pings."""
    return {"status": "ok"}
