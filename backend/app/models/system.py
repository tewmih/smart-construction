import uuid
from sqlalchemy import Column, String, Float, ForeignKey, DateTime, Text, Boolean
from sqlalchemy.dialects.postgresql import UUID as SQL_UUID

from app.models.user import Base, utcnow

class BudgetItem(Base):
    __tablename__ = "budget_items"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    amount = Column(Float, nullable=False)
    description = Column(Text)
    created_at = Column(DateTime(timezone=True), default=utcnow)


class BudgetPayment(Base):
    __tablename__ = "budget_payments"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    payment_amount = Column(Float, nullable=False)
    payment_date = Column(String(20), nullable=False)
    reference = Column(String(255), nullable=True)
    notes = Column(Text, nullable=True)
    recorded_by = Column(SQL_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=True)
    user_id = Column(SQL_UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    action = Column(String(255), nullable=False)
    entity_type = Column(String(100))
    entity_id = Column(String(255))
    details = Column(Text)
    created_at = Column(DateTime(timezone=True), default=utcnow)

class Message(Base):
    __tablename__ = "messages"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(SQL_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    content = Column(Text, nullable=False)
    is_read = Column(Boolean, default=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    # Notification metadata for icon routing and deep-linking.
    type = Column(String(50), nullable=True, index=True)
    entity_type = Column(String(50), nullable=True)
    entity_id = Column(SQL_UUID(as_uuid=True), nullable=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=True, index=True)

class SystemSetting(Base):
    __tablename__ = "system_settings"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    key = Column(String(255), unique=True, nullable=False)
    value = Column(Text)

class Announcement(Base):
    __tablename__ = "announcements"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    title = Column(String(255), nullable=False)
    content = Column(Text, nullable=False)
    priority = Column(String(50), default="normal")  # low, normal, high, urgent
    is_active = Column(Boolean, default=True)
    # Target audience: "all" (default) | "admins" | "project_managers"
    target_audience = Column(String(50), nullable=False, server_default="all")
    created_by = Column(SQL_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    expires_at = Column(DateTime(timezone=True), nullable=True)
