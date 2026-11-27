"""Бизнес-логика: пользователи, подписки, платежи, пробный период, рефералка, напоминания.

Модуль не зависит от aiogram — его удобно тестировать и переиспользовать (например, для сайта).
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select, update

from .config import Settings, Tariff
from .db import Database, Payment, PaymentStatus, User, utcnow
from .payments import InvoiceState, PaymentProvider
from .remnawave import PanelUser, RemnawaveClient

log = logging.getLogger(__name__)

# Платежи «processing» — уже забраны одним обработчиком, второй их не тронет.
PROCESSING = "processing"


class ServiceError(Exception):
    """Ошибка, текст которой можно показать пользователю."""


@dataclass
class PaidResult:
    payment: Payment
    user: User
    referral_bonus_to: int | None = None  # id пригласившего, если ему начислен бонус


@dataclass
class Reminder:
    user: User
    stage: str  # "3d" | "1d" | "expired"


@dataclass
class Stats:
    users_total: int
    users_active: int
    users_new_24h: int
    payments_30d: int
    revenue_30d: dict[str, Decimal] = field(default_factory=dict)


class VpnService:
    def __init__(
        self,
        db: Database,
        panel: RemnawaveClient,
        settings: Settings,
        providers: dict[str, PaymentProvider],
    ) -> None:
        self.db = db
        self.panel = panel
        self.settings = settings
        self.providers = providers
        self._locks: defaultdict[int, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._squads: list[str] | None = list(settings.remnawave_squad_uuids) or None

    # ------------------------------------------------------------------ users

    async def register(
        self, user_id: int, username: str | None, first_name: str | None, referrer_id: int | None = None
    ) -> tuple[User, bool]:
        """Создаёт пользователя при первом /start. Возвращает (user, created)."""
        async with self.db.session() as s:
            user = await s.get(User, user_id)
            if user:
                changed = user.username != username or user.first_name != first_name or user.bot_blocked
                user.username, user.first_name, user.bot_blocked = username, first_name, False
                if changed:
                    await s.commit()
                return user, False
            if referrer_id == user_id or (referrer_id and not await s.get(User, referrer_id)):
                referrer_id = None
            user = User(id=user_id, username=username, first_name=first_name, referrer_id=referrer_id)
            s.add(user)
            await s.commit()
            return user, True

    async def get_user(self, user_id: int) -> User | None:
        async with self.db.session() as s:
            return await s.get(User, user_id)

    async def set_bot_blocked(self, user_id: int) -> None:
        async with self.db.session() as s:
            await s.execute(update(User).where(User.id == user_id).values(bot_blocked=True))
            await s.commit()

    def panel_username(self, user_id: int) -> str:
        return f"{self.settings.user_prefix}_{user_id}"

    async def _squad_uuids(self) -> list[str]:
        if self._squads is None:
            self._squads = await self.panel.get_internal_squad_uuids()
            if not self._squads:
                log.warning("В панели нет ни одного internal squad — пользователи не получат серверов")
        return self._squads

    async def _find_panel_user(self, user: User) -> PanelUser | None:
        if user.panel_id:
            found = await self.panel.get_user_by_id(user.panel_id)
            if found:
                return found
        return await self.panel.get_user_by_username(self.panel_username(user.id))

    async def sync_from_panel(self, user_id: int) -> User | None:
        """Подтягивает актуальный срок и ссылку из панели (если админ менял их вручную)."""
        async with self.db.session() as s:
            user = await s.get(User, user_id)
            if not user:
                return None
            panel_user = await self._find_panel_user(user)
            if panel_user:
                user.panel_id = panel_user.id
                user.subscription_url = panel_user.subscription_url
                user.expires_at = panel_user.expire_at
                await s.commit()
            return user

    # ------------------------------------------------------------------ subscription

    async def extend(self, user_id: int, days: int) -> User:
        """Продлевает (или создаёт) подписку в панели на days дней."""
        if days <= 0:
            raise ValueError("days должен быть > 0")
        async with self._locks[user_id]:
            async with self.db.session() as s:
                user = await s.get(User, user_id)
                if user is None:
                    raise ServiceError("Пользователь не найден")
                panel_user = await self._find_panel_user(user)
                now = utcnow()
                if panel_user is None:
                    gb = self.settings.traffic_limit_gb
                    panel_user = await self.panel.create_user(
                        username=self.panel_username(user_id),
                        expire_at=now + timedelta(days=days),
                        telegram_id=user_id,
                        squad_uuids=await self._squad_uuids(),
                        hwid_device_limit=self.settings.hwid_device_limit or None,
                        traffic_limit_bytes=gb * 1024**3 if gb else 0,
                        description=f"@{user.username}" if user.username else user.first_name,
                        tag=self.settings.user_tag or None,
                    )
                else:
                    new_expire = max(now, panel_user.expire_at) + timedelta(days=days)
                    fields: dict[str, object] = {"expire_at": new_expire}
                    # DISABLED не трогаем: это ручная блокировка админом
                    if panel_user.status == "EXPIRED":
                        fields["status"] = "ACTIVE"
                    panel_user = await self.panel.update_user(panel_user.id, **fields)
                user.panel_id = panel_user.id
                user.subscription_url = panel_user.subscription_url
                user.expires_at = panel_user.expire_at
                # Короткий срок (пробный период, подарок на пару дней) не должен сразу
                # вызывать «закончится через 3 дня»: такие напоминания считаем отправленными.
                left = panel_user.expire_at - now
                if left <= timedelta(days=3):
                    user.remind_3d_for = panel_user.expire_at
                if left <= timedelta(days=1):
                    user.remind_1d_for = panel_user.expire_at
                await s.commit()
                return user

    def trial_available(self, user: User) -> bool:
        return self.settings.trial_days > 0 and not user.trial_used and user.panel_id is None

    async def activate_trial(self, user_id: int) -> User:
        async with self.db.session() as s:
            user = await s.get(User, user_id)
            if user is None or not self.trial_available(user):
                raise ServiceError("Пробный период уже использован")
            res = await s.execute(
                update(User).where(User.id == user_id, User.trial_used.is_(False)).values(trial_used=True)
            )
            await s.commit()
            if res.rowcount != 1:
                raise ServiceError("Пробный период уже использован")
        try:
            return await self.extend(user_id, self.settings.trial_days)
        except Exception:
            async with self.db.session() as s:  # вернуть возможность попробовать ещё раз
                await s.execute(update(User).where(User.id == user_id).values(trial_used=False))
                await s.commit()
            raise

    # ------------------------------------------------------------------ payments

    async def create_payment(self, user_id: int, tariff: Tariff, provider_name: str) -> Payment:
        provider = self.providers.get(provider_name)
        if provider is None:
            raise ServiceError("Этот способ оплаты сейчас недоступен")
        description = f"{self.settings.project_name}: доступ на {tariff.title}"
        invoice = await provider.create_invoice(
            amount=tariff.price_rub, description=description, payload=f"{user_id}:{tariff.days}"
        )
        async with self.db.session() as s:
            payment = Payment(
                user_id=user_id,
                provider=provider_name,
                external_id=invoice.external_id,
                amount=tariff.price_rub,
                currency="RUB",
                days=tariff.days,
                pay_url=invoice.pay_url,
            )
            s.add(payment)
            await s.commit()
            return payment

    async def set_payment_message(self, payment_id: int, message_id: int) -> None:
        async with self.db.session() as s:
            await s.execute(update(Payment).where(Payment.id == payment_id).values(message_id=message_id))
            await s.commit()

    async def get_payment(self, payment_id: int) -> Payment | None:
        async with self.db.session() as s:
            return await s.get(Payment, payment_id)

    async def check_payment(self, payment_id: int) -> tuple[str, PaidResult | None]:
        """Проверка одного платежа (кнопка «Я оплатил»). Возвращает (статус, результат если зачислен)."""
        payment = await self.get_payment(payment_id)
        if payment is None:
            raise ServiceError("Платёж не найден")
        if payment.status != PaymentStatus.PENDING:
            return payment.status, None
        provider = self.providers.get(payment.provider)
        if provider is None:
            return payment.status, None
        state = (await provider.get_statuses([payment.external_id])).get(payment.external_id, InvoiceState.PENDING)
        return await self._apply_state(payment, state)

    async def poll_pending(self, *, include_old: bool) -> list[PaidResult]:
        """Опрос всех ожидающих платежей. include_old=False — только свежие (моложе TTL)."""
        now = utcnow()
        ttl = timedelta(minutes=self.settings.payment_ttl_minutes)
        async with self.db.session() as s:
            # Счета старше суток больше не проверяем
            await s.execute(
                update(Payment)
                .where(Payment.status == PaymentStatus.PENDING, Payment.created_at < now - timedelta(hours=24))
                .values(status=PaymentStatus.EXPIRED)
            )
            await s.commit()
            q = select(Payment).where(Payment.status == PaymentStatus.PENDING)
            if not include_old:
                q = q.where(Payment.created_at >= now - ttl)
            pending = list((await s.execute(q)).scalars())

        by_provider: defaultdict[str, list[Payment]] = defaultdict(list)
        for p in pending:
            by_provider[p.provider].append(p)

        results: list[PaidResult] = []
        for name, payments in by_provider.items():
            provider = self.providers.get(name)
            if provider is None:
                continue
            try:
                states = await provider.get_statuses([p.external_id for p in payments])
            except Exception:
                log.exception("Не удалось опросить провайдера %s", name)
                continue
            for p in payments:
                state = states.get(p.external_id, InvoiceState.PENDING)
                try:
                    _, paid = await self._apply_state(p, state)
                except Exception:
                    log.exception("Ошибка обработки платежа #%s", p.id)
                    continue
                if paid:
                    results.append(paid)
        return results

    async def _apply_state(self, payment: Payment, state: str) -> tuple[str, PaidResult | None]:
        if state == InvoiceState.PENDING:
            return PaymentStatus.PENDING, None
        if state in (InvoiceState.EXPIRED, InvoiceState.CANCELED):
            async with self.db.session() as s:
                await s.execute(
                    update(Payment)
                    .where(Payment.id == payment.id, Payment.status == PaymentStatus.PENDING)
                    .values(status=state)
                )
                await s.commit()
            return state, None
        if state != InvoiceState.PAID:
            return PaymentStatus.PENDING, None
        result = await self._process_paid(payment.id)
        return PaymentStatus.PAID, result

    async def _process_paid(self, payment_id: int) -> PaidResult | None:
        """Зачисляет оплату ровно один раз, даже если её одновременно нашли кнопка и фоновая проверка."""
        async with self.db.session() as s:
            res = await s.execute(
                update(Payment)
                .where(Payment.id == payment_id, Payment.status == PaymentStatus.PENDING)
                .values(status=PROCESSING)
            )
            await s.commit()
            if res.rowcount != 1:
                return None  # уже обработан другим вызовом
            payment = await s.get(Payment, payment_id)
            assert payment is not None

        try:
            user = await self.extend(payment.user_id, payment.days)
        except Exception:
            # Вернём в pending — следующая проверка попробует ещё раз
            async with self.db.session() as s:
                await s.execute(update(Payment).where(Payment.id == payment_id).values(status=PaymentStatus.PENDING))
                await s.commit()
            raise

        async with self.db.session() as s:
            await s.execute(
                update(Payment).where(Payment.id == payment_id).values(status=PaymentStatus.PAID, paid_at=utcnow())
            )
            await s.commit()
            payment = await s.get(Payment, payment_id)
            assert payment is not None

        bonus_to = await self._reward_referrer(user)
        return PaidResult(payment=payment, user=user, referral_bonus_to=bonus_to)

    async def _reward_referrer(self, user: User) -> int | None:
        days = self.settings.referral_bonus_days
        if days <= 0 or not user.referrer_id or user.referral_rewarded:
            return None
        async with self.db.session() as s:
            res = await s.execute(
                update(User).where(User.id == user.id, User.referral_rewarded.is_(False)).values(referral_rewarded=True)
            )
            await s.commit()
            if res.rowcount != 1:
                return None
        try:
            await self.extend(user.referrer_id, days)
        except Exception:
            log.exception("Не удалось начислить реферальный бонус пользователю %s", user.referrer_id)
            return None
        return user.referrer_id

    # ------------------------------------------------------------------ reminders

    async def due_reminders(self) -> list[Reminder]:
        """Пользователи, которым пора напомнить о продлении. Отмечает напоминания как отправленные."""
        now = utcnow()
        out: list[Reminder] = []
        async with self.db.session() as s:
            q = select(User).where(
                User.expires_at.is_not(None),
                User.bot_blocked.is_(False),
                User.expires_at > now - timedelta(days=1),
                User.expires_at < now + timedelta(days=3),
            )
            for user in (await s.execute(q)).scalars():
                exp = user.expires_at
                assert exp is not None
                left = exp - now
                if left <= timedelta(0):
                    if user.remind_expired_for != exp:
                        user.remind_expired_for = exp
                        out.append(Reminder(user, "expired"))
                elif left <= timedelta(days=1):
                    if user.remind_1d_for != exp:
                        user.remind_1d_for = exp
                        user.remind_3d_for = exp  # 3-дневное уже неактуально
                        out.append(Reminder(user, "1d"))
                elif user.remind_3d_for != exp:
                    user.remind_3d_for = exp
                    out.append(Reminder(user, "3d"))
            await s.commit()
        return out

    # ------------------------------------------------------------------ admin

    async def stats(self) -> Stats:
        now = utcnow()
        async with self.db.session() as s:
            total = await s.scalar(select(func.count()).select_from(User))
            active = await s.scalar(select(func.count()).select_from(User).where(User.expires_at > now))
            new = await s.scalar(
                select(func.count()).select_from(User).where(User.created_at > now - timedelta(days=1))
            )
            rows = (
                await s.execute(
                    select(Payment.currency, func.count(), func.sum(Payment.amount))
                    .where(Payment.status == PaymentStatus.PAID, Payment.paid_at > now - timedelta(days=30))
                    .group_by(Payment.currency)
                )
            ).all()
        return Stats(
            users_total=total or 0,
            users_active=active or 0,
            users_new_24h=new or 0,
            payments_30d=sum(r[1] for r in rows),
            revenue_30d={r[0]: Decimal(r[2] or 0) for r in rows},
        )

    async def all_user_ids(self) -> list[int]:
        async with self.db.session() as s:
            return list((await s.execute(select(User.id).where(User.bot_blocked.is_(False)))).scalars())

    async def referrals_count(self, user_id: int) -> tuple[int, int]:
        """(сколько пригласил, сколько из них оплатили)"""
        async with self.db.session() as s:
            invited = await s.scalar(select(func.count()).select_from(User).where(User.referrer_id == user_id))
            paid = await s.scalar(
                select(func.count())
                .select_from(User)
                .where(User.referrer_id == user_id, User.referral_rewarded.is_(True))
            )
        return invited or 0, paid or 0
