"""Модели БД и фабрика сессий (SQLAlchemy 2, async)."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator[datetime]):
    """Хранит время в UTC и всегда возвращает aware-datetime (SQLite теряет таймзону)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):  # type: ignore[override]
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime запрещён, используйте UTC")
        return value.astimezone(timezone.utc)

    def process_result_value(self, value: datetime | None, dialect):  # type: ignore[override]
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)  # Telegram user id
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    referrer_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), index=True)
    referral_rewarded: Mapped[bool] = mapped_column(Boolean, default=False)
    trial_used: Mapped[bool] = mapped_column(Boolean, default=False)
    bot_blocked: Mapped[bool] = mapped_column(Boolean, default=False)

    # Кэш данных из панели Remnawave
    panel_id: Mapped[int | None] = mapped_column(BigInteger)
    subscription_url: Mapped[str | None] = mapped_column(String(512))
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, index=True)

    # Для каких expires_at уже отправлены напоминания (сбрасываются сами при продлении)
    remind_3d_for: Mapped[datetime | None] = mapped_column(UTCDateTime)
    remind_1d_for: Mapped[datetime | None] = mapped_column(UTCDateTime)
    remind_expired_for: Mapped[datetime | None] = mapped_column(UTCDateTime)

    def is_active(self, now: datetime | None = None) -> bool:
        return self.expires_at is not None and self.expires_at > (now or utcnow())


class PaymentStatus:
    PENDING = "pending"
    PAID = "paid"
    EXPIRED = "expired"
    CANCELED = "canceled"


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (UniqueConstraint("provider", "external_id", name="uq_payment_provider_ext"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), index=True)
    provider: Mapped[str] = mapped_column(String(16))
    external_id: Mapped[str] = mapped_column(String(64))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(8), default="RUB")
    days: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default=PaymentStatus.PENDING, index=True)
    pay_url: Mapped[str] = mapped_column(String(1024))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    paid_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # Номер сообщения со ссылкой на оплату — чтобы потом его отредактировать
    message_id: Mapped[int | None] = mapped_column(BigInteger)


class Database:
    def __init__(self, url: str) -> None:
        if url.startswith("sqlite"):
            _ensure_sqlite_dir(url)
        self.engine: AsyncEngine = create_async_engine(url, pool_pre_ping=True)
        self.session: async_sessionmaker[AsyncSession] = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_all(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def close(self) -> None:
        await self.engine.dispose()


def _ensure_sqlite_dir(url: str) -> None:
    import os

    path = url.split("///", 1)[-1]
    if path and path != ":memory:":
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
