import uuid
from typing import Optional
from datetime import datetime, timezone
import enum

from sqlalchemy import Column, String, Boolean, DateTime, UUID as SQL_UUID
from sqlalchemy.orm import declarative_base

Base = declarative_base()

def utcnow():
    return datetime.now(timezone.utc)

class User(Base):
    __tablename__ = "users"

    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    full_name = Column(String(255), nullable=False)
    email = Column(String(255), unique=True, index=True, nullable=False)
    phone_number = Column(String(50), nullable=True)
    # Nullable because OAuth-only users (e.g. Google) have no password.
    hashed_password = Column(String(255), nullable=True)
    is_admin = Column(Boolean(), default=False, nullable=False)
    is_active = Column(Boolean(), default=True)
    # OAuth fields — null for traditional email/password users.
    google_id = Column(String(255), unique=True, index=True, nullable=True)
    auth_provider = Column(String(32), default="local", nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
