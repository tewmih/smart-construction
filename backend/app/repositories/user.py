from uuid import UUID
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.user import User
from app.schemas.user import UserCreate, UserUpdate
from app.core.security import get_password_hash

SORTABLE_USER_COLUMNS = {
    "full_name": User.full_name,
    "email": User.email,
    "created_at": User.created_at,
    "last_login_at": User.last_login_at,
    "is_active": User.is_active,
    "is_admin": User.is_admin,
}

class UserRepository:
    @staticmethod
    async def get_by_id(db: AsyncSession, id: UUID | str) -> User | None:
        result = await db.execute(select(User).where(User.id == id))
        return result.scalars().first()
    
    @staticmethod
    async def get_by_email(db: AsyncSession, email: str) -> User | None:
        result = await db.execute(select(User).where(User.email == email))
        return result.scalars().first()

    @staticmethod
    async def get_by_google_id(db: AsyncSession, google_id: str) -> User | None:
        result = await db.execute(select(User).where(User.google_id == google_id))
        return result.scalars().first()

    @staticmethod
    async def create_oauth_user(
        db: AsyncSession,
        *,
        email: str,
        full_name: str,
        google_id: str,
    ) -> User:
        db_obj = User(
            full_name=full_name,
            email=email,
            hashed_password=None,
            google_id=google_id,
            auth_provider="google",
            is_admin=False,
            is_active=True,
        )
        db.add(db_obj)
        await db.commit()
        await db.refresh(db_obj)
        return db_obj

    @staticmethod
    async def link_google_id(db: AsyncSession, user: User, google_id: str) -> User:
        user.google_id = google_id
        if user.auth_provider == "local":
            user.auth_provider = "google"
        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user

    @staticmethod
    async def get_all(
        db: AsyncSession,
        skip: int = 0,
        limit: int = 100,
        search: str | None = None,
        is_active: bool | None = None,
        is_admin: bool | None = None,
        sort_by: str = "created_at",
        sort_dir: str = "desc",
    ) -> list[User]:
        query = select(User)

        if search:
            search_pattern = f"%{search}%"
            query = query.where(
                (User.full_name.ilike(search_pattern)) |
                (User.email.ilike(search_pattern))
            )
        if is_active is not None:
            query = query.where(User.is_active == is_active)
        if is_admin is not None:
            query = query.where(User.is_admin == is_admin)

        sort_col = SORTABLE_USER_COLUMNS.get(sort_by, User.created_at)
        query = query.order_by(sort_col.desc() if sort_dir == "desc" else sort_col.asc())

        query = query.offset(skip).limit(limit)
        result = await db.execute(query)
        return list(result.scalars().all())

    @staticmethod
    async def count_all(
        db: AsyncSession,
        search: str | None = None,
        is_active: bool | None = None,
        is_admin: bool | None = None,
    ) -> int:
        query = select(func.count()).select_from(User)
        if search:
            search_pattern = f"%{search}%"
            query = query.where(
                (User.full_name.ilike(search_pattern)) |
                (User.email.ilike(search_pattern))
            )
        if is_active is not None:
            query = query.where(User.is_active == is_active)
        if is_admin is not None:
            query = query.where(User.is_admin == is_admin)
        result = await db.execute(query)
        return int(result.scalar() or 0)

    @staticmethod
    async def create(db: AsyncSession, user_in: UserCreate) -> User:
        db_obj = User(
            full_name=user_in.full_name,
            email=user_in.email,
            phone_number=user_in.phone_number,
            hashed_password=get_password_hash(user_in.password),
            is_admin=user_in.is_admin,
            is_active=user_in.is_active,
        )
        db.add(db_obj)
        await db.commit()
        await db.refresh(db_obj)
        return db_obj

    @staticmethod
    async def update(db: AsyncSession, db_obj: User, obj_in: UserUpdate) -> User:
        update_data = obj_in.model_dump(exclude_unset=True)
        if "password" in update_data:
            hashed_password = get_password_hash(update_data["password"])
            del update_data["password"]
            update_data["hashed_password"] = hashed_password

        for field, value in update_data.items():
            setattr(db_obj, field, value)

        db.add(db_obj)
        await db.commit()
        await db.refresh(db_obj)
        return db_obj

    @staticmethod
    async def deactivate(db: AsyncSession, id: UUID | str) -> User | None:
        db_obj = await UserRepository.get_by_id(db, id=id)
        if db_obj:
            db_obj.is_active = False
            db.add(db_obj)
            await db.commit()
            await db.refresh(db_obj)
        return db_obj

    @staticmethod
    async def activate(db: AsyncSession, id: UUID | str) -> User | None:
        db_obj = await UserRepository.get_by_id(db, id=id)
        if db_obj:
            db_obj.is_active = True
            db.add(db_obj)
            await db.commit()
            await db.refresh(db_obj)
        return db_obj

    @staticmethod
    async def promote(db: AsyncSession, id: UUID | str) -> User | None:
        db_obj = await UserRepository.get_by_id(db, id=id)
        if db_obj:
            db_obj.is_admin = True
            db.add(db_obj)
            await db.commit()
            await db.refresh(db_obj)
        return db_obj

    @staticmethod
    async def demote(db: AsyncSession, id: UUID | str) -> User | None:
        db_obj = await UserRepository.get_by_id(db, id=id)
        if db_obj:
            db_obj.is_admin = False
            db.add(db_obj)
            await db.commit()
            await db.refresh(db_obj)
        return db_obj

    @staticmethod
    async def delete(db: AsyncSession, id: UUID | str) -> bool:
        db_obj = await UserRepository.get_by_id(db, id=id)
        if not db_obj:
            return False
        await db.delete(db_obj)
        await db.commit()
        return True
