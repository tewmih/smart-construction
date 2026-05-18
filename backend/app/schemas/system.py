from pydantic import BaseModel, ConfigDict
from uuid import UUID
from datetime import datetime

# Budget Item
class BudgetItemCreate(BaseModel):
    amount: float
    description: str | None = None

class BudgetItemResponse(BudgetItemCreate):
    id: UUID
    project_id: UUID
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

# Budget summary
class BudgetSummary(BaseModel):
    total_budget: float
    budget_spent: float
    total_received: float
    remaining: float

# Budget Payment
class BudgetPaymentCreate(BaseModel):
    payment_amount: float
    payment_date: str
    reference: str | None = None
    notes: str | None = None

class BudgetPaymentUpdate(BaseModel):
    payment_amount: float | None = None
    payment_date: str | None = None
    reference: str | None = None
    notes: str | None = None

class BudgetPaymentResponse(BaseModel):
    id: UUID
    project_id: UUID
    payment_amount: float
    payment_date: str
    reference: str | None = None
    notes: str | None = None
    recorded_by: UUID
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

# Audit Log
class AuditLogResponse(BaseModel):
    id: UUID
    project_id: UUID | None
    user_id: UUID | None
    user_email: str | None = None
    user_name: str | None = None
    action: str
    entity_type: str | None
    entity_id: str | None
    details: str | None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class AuditLogPage(BaseModel):
    total: int
    page: int
    limit: int
    data: list[AuditLogResponse]

# Message
class MessageResponse(BaseModel):
    id: UUID
    user_id: UUID
    content: str
    is_read: bool
    created_at: datetime
    type: str | None = None
    entity_type: str | None = None
    entity_id: UUID | None = None
    project_id: UUID | None = None
    model_config = ConfigDict(from_attributes=True)

# System Settings
class SystemSettingCreate(BaseModel):
    key: str
    value: str

class SystemSettingUpdate(BaseModel):
    value: str

class SystemSettingResponse(BaseModel):
    id: UUID
    key: str
    value: str | None
    model_config = ConfigDict(from_attributes=True)

# Structured System Settings
class SystemSettingsStructured(BaseModel):
    """Structured system settings for the platform"""
    working_hours_per_day: float = 8.0
    working_days_per_week: int = 6
    overtime_multiplier: float = 1.5
    delay_risk_threshold_pct: float = 60.0
    budget_alert_threshold_pct: float = 80.0
    maintenance_mode: bool = False

class SystemSettingsUpdateRequest(BaseModel):
    """Request to update structured system settings"""
    working_hours_per_day: float | None = None
    working_days_per_week: int | None = None
    overtime_multiplier: float | None = None
    delay_risk_threshold_pct: float | None = None
    budget_alert_threshold_pct: float | None = None
    maintenance_mode: bool | None = None

# Admin Stats
class AdminStatsResponse(BaseModel):
    """Platform-wide statistics for admin dashboard"""
    total_users: int
    active_users: int
    total_projects: int
    projects_by_status: dict[str, int]
    total_suppliers: int
    recent_activity_count: int

# Announcements
class AnnouncementCreate(BaseModel):
    title: str
    content: str
    priority: str = "normal"  # low, normal, high, urgent
    target_audience: str = "all"  # all | admins | project_managers
    expires_at: datetime | None = None

class AnnouncementUpdate(BaseModel):
    title: str | None = None
    content: str | None = None
    priority: str | None = None
    target_audience: str | None = None
    is_active: bool | None = None
    expires_at: datetime | None = None

class AnnouncementResponse(BaseModel):
    id: UUID
    title: str
    content: str
    priority: str
    is_active: bool
    target_audience: str = "all"
    created_by: UUID
    created_at: datetime
    expires_at: datetime | None
    model_config = ConfigDict(from_attributes=True)
