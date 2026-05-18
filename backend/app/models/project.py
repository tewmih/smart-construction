import uuid
from sqlalchemy import Column, String, Float, ForeignKey, Text, DateTime, Integer
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import UUID as SQL_UUID

from app.models.user import Base, utcnow
from app.models.commons import ProjectStatus

class Client(Base):
    __tablename__ = "clients"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    tin_number = Column(String(20))  # Ethiopian Tax Identification Number
    address = Column(String(300))
    contact_email = Column(String(150))
    contact_phone = Column(String(20))

    project = relationship("Project", back_populates="clients")


class Supplier(Base):
    __tablename__ = "suppliers"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    role = Column(String(100))  # Type of supply e.g. Cement, Steel, Aggregate, Formwork, Equipment rental
    tin_number = Column(String(20))  # Ethiopian Tax Identification Number
    address = Column(String(300))
    contact_email = Column(String(150))
    contact_phone = Column(String(20))

    project = relationship("Project", back_populates="suppliers")

class Project(Base):
    __tablename__ = "projects"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text)
    location = Column(String(500))
    status = Column(String(50), default=ProjectStatus.PLANNING.value)
    
    planned_start_date = Column(DateTime(timezone=True))
    planned_end_date = Column(DateTime(timezone=True))
    
    progress_percentage = Column(Float, default=0.0)
    total_budget = Column(Float, nullable=False)
    budget_spent = Column(Float, default=0.0)
    
    timezone = Column(String(64), nullable=False, server_default="Africa/Addis_Ababa")
    fiscal_year_start_month = Column(Integer, nullable=False, server_default="1")
    week_starts_on = Column(Integer, nullable=False, server_default="0")  # 0=Mon, 6=Sun

    # Last-notified markers — prevent duplicate risk/budget alerts.
    last_alert_risk_level = Column(String(20), nullable=True)
    last_alert_budget_threshold = Column(Float, nullable=True)

    # Per-project setting overrides (nullable = fall back to global system setting).
    budget_alert_threshold_pct_override = Column(Float, nullable=True)

    clients = relationship("Client", back_populates="project", cascade="all, delete-orphan", lazy="selectin")
    suppliers = relationship("Supplier", back_populates="project", cascade="all, delete-orphan", lazy="selectin")

    owner_id = Column(SQL_UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    owner = relationship("User", foreign_keys=[owner_id], lazy="selectin")

    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")
    invitations = relationship("ProjectInvitation", back_populates="project", cascade="all, delete-orphan")
    progress_snapshots = relationship("ProjectProgressSnapshot", back_populates="project", cascade="all, delete-orphan")

class ProjectMember(Base):
    __tablename__ = "project_members"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    user_id = Column(SQL_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    role = Column(String(50), nullable=False) # Enforced via ProjectRole enum in app validation
    
    project = relationship("Project", back_populates="members")
    user = relationship("User")

class ProjectInvitation(Base):
    __tablename__ = "project_invitations"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    email = Column(String(255), nullable=False, index=True)
    role = Column(String(50), nullable=False)
    token = Column(String(255), unique=True, nullable=False, index=True)
    status = Column(String(50), default="pending") # pending, accepted, expired
    # Set when an invitation email has been successfully delivered to SMTP.
    # Always non-null for rows persisted via the atomic create flow.
    email_sent_at = Column(DateTime(timezone=True), nullable=True)

    project = relationship("Project", back_populates="invitations")


class ProjectProgressSnapshot(Base):
    """Frozen snapshot of project progress + budget at a point in time. Powers the S-curve."""
    __tablename__ = "project_progress_snapshots"
    id = Column(SQL_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(SQL_UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    snapshot_date = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    progress_percentage = Column(Float, nullable=False)
    budget_spent = Column(Float, nullable=False)
    total_budget = Column(Float, nullable=False)
    planned_progress = Column(Float, nullable=True)
    captured_by = Column(String(50), nullable=False, default="report_run")

    project = relationship("Project", back_populates="progress_snapshots")
