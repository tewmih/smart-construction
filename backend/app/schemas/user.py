from pydantic import BaseModel, EmailStr, ConfigDict
from uuid import UUID
from datetime import datetime

class UserBase(BaseModel):
    full_name: str
    email: EmailStr
    phone_number: str | None = None
    is_admin: bool = False
    is_active: bool = True

class UserCreate(UserBase):
    password: str

class UserUpdate(BaseModel):
    full_name: str | None = None
    email: EmailStr | None = None
    phone_number: str | None = None
    password: str | None = None
    is_admin: bool | None = None
    is_active: bool | None = None

class UserResponse(UserBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    last_login_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class UserPage(BaseModel):
    total: int
    page: int
    limit: int
    data: list[UserResponse]
