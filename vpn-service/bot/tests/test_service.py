from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import update

from app.db import Payment, PaymentStatus, User, utcnow
from app.payments import InvoiceState
from app.remnawave import RemnawaveError
from app.service import ServiceError


async def _expire(service, user_id: int, at) -> None:
    """Сдвинуть срок подписки (и в БД, и в фейковой панели)."""
    user = await service.get_user(user_id)
    panel_user = service.panel.users[user.panel_id]
    service.panel.users[user.panel_id] = type(panel_user)(**{**panel_user.__dict__, "expire_at": at})
    async with service.db.session() as s:
        await s.execute(update(User).where(User.id == user_id).values(expires_at=at))
        await s.commit()


async def test_register_and_self_referral_ignored(service):
    user, created = await service.register(10, "alice", "Alice", referrer_id=10)
    assert created and user.referrer_id is None
    _, created_again = await service.register(10, "alice", "Alice")
    assert not created_again


async def test_referrer_must_exist(service):
    user, _ = await service.register(11, None, "Bob", referrer_id=999)
    assert user.referrer_id is None


async def test_extend_creates_then_adds_to_remaining_time(service, panel):
    await service.register(10, "alice", "Alice")
    before = utcnow()
    user = await service.extend(10, 30)
    assert panel.calls == ["create:tg_10"]
    assert user.subscription_url and user.panel_id
    assert timedelta(days=30) - timedelta(seconds=5) < user.expires_at - before < timedelta(days=30, seconds=5)

    first_expiry = user.expires_at
    user = await service.extend(10, 90)
    assert user.expires_at == first_expiry + timedelta(days=90)  # дни суммируются
    assert len(panel.users) == 1


async def test_extend_after_expiry_counts_from_now(service, panel):
    await service.register(10, "alice", "Alice")
    await service.extend(10, 30)
    await _expire(service, 10, utcnow() - timedelta(days=10))
    panel_user = next(iter(panel.users.values()))
    panel.users[panel_user.id] = type(panel_user)(**{**panel_user.__dict__, "status": "EXPIRED"})

    user = await service.extend(10, 30)
    assert user.expires_at > utcnow() + timedelta(days=29)
    assert panel.users[user.panel_id].status == "ACTIVE"


async def test_extend_recovers_panel_user_by_username(service, panel, db):
    """Если локальная БД потерялась, бот находит пользователя в панели по username."""
    await service.register(10, "alice", "Alice")
    await service.extend(10, 30)
    async with db.session() as s:
        await s.execute(update(User).where(User.id == 10).values(panel_id=None))
        await s.commit()
    await service.extend(10, 30)
    assert len(panel.users) == 1


async def test_trial_only_once(service):
    await service.register(10, "alice", "Alice")
    user = await service.get_user(10)
    assert service.trial_available(user)
    user = await service.activate_trial(10)
    assert user.is_active()
    assert not service.trial_available(user)
    with pytest.raises(ServiceError):
        await service.activate_trial(10)


async def test_trial_unavailable_after_purchase(service):
    await service.register(10, "alice", "Alice")
    await service.extend(10, 30)
    with pytest.raises(ServiceError):
        await service.activate_trial(10)


async def test_trial_retry_after_panel_failure(service, panel):
    await service.register(10, "alice", "Alice")
    panel.fail_next = True
    with pytest.raises(RemnawaveError):
        await service.activate_trial(10)
    user = await service.activate_trial(10)  # флаг откатился — можно ещё раз
    assert user.is_active()


async def test_payment_flow_credits_exactly_once(service, provider, settings):
    await service.register(10, "alice", "Alice")
    tariff = settings.tariff_list[0]
    payment = await service.create_payment(10, tariff, "fake")
    assert payment.status == PaymentStatus.PENDING

    assert await service.poll_pending(include_old=True) == []
    status, result = await service.check_payment(payment.id)
    assert status == PaymentStatus.PENDING and result is None

    provider.states[payment.external_id] = InvoiceState.PAID
    results = await service.poll_pending(include_old=True)
    assert len(results) == 1 and results[0].payment.status == PaymentStatus.PAID
    first_expiry = results[0].user.expires_at

    # Повторные проверки ничего не начисляют
    assert await service.poll_pending(include_old=True) == []
    status, result = await service.check_payment(payment.id)
    assert status == PaymentStatus.PAID and result is None
    assert (await service.get_user(10)).expires_at == first_expiry


async def test_concurrent_checks_credit_once(service, provider, settings, panel):
    await service.register(10, "alice", "Alice")
    payment = await service.create_payment(10, settings.tariff_list[0], "fake")
    provider.states[payment.external_id] = InvoiceState.PAID

    outcomes = await asyncio.gather(
        service.check_payment(payment.id),
        service.poll_pending(include_old=True),
        service.check_payment(payment.id),
    )
    credited = sum(1 for o in (outcomes[0][1], outcomes[2][1]) if o) + len(outcomes[1])
    assert credited == 1
    assert panel.calls == ["create:tg_10"]


async def test_panel_failure_returns_payment_to_pending(service, provider, settings, panel):
    await service.register(10, "alice", "Alice")
    payment = await service.create_payment(10, settings.tariff_list[0], "fake")
    provider.states[payment.external_id] = InvoiceState.PAID
    panel.fail_next = True
    assert await service.poll_pending(include_old=True) == []
    assert (await service.get_payment(payment.id)).status == PaymentStatus.PENDING
    # Следующая проверка зачисляет
    assert len(await service.poll_pending(include_old=True)) == 1


async def test_expired_invoice_marked(service, provider, settings):
    await service.register(10, "alice", "Alice")
    payment = await service.create_payment(10, settings.tariff_list[0], "fake")
    provider.states[payment.external_id] = InvoiceState.EXPIRED
    await service.poll_pending(include_old=True)
    assert (await service.get_payment(payment.id)).status == PaymentStatus.EXPIRED


async def test_old_pending_invoices_expire_after_a_day(service, settings, db):
    await service.register(10, "alice", "Alice")
    payment = await service.create_payment(10, settings.tariff_list[0], "fake")
    async with db.session() as s:
        await s.execute(
            update(Payment).where(Payment.id == payment.id).values(created_at=utcnow() - timedelta(hours=25))
        )
        await s.commit()
    await service.poll_pending(include_old=False)
    assert (await service.get_payment(payment.id)).status == PaymentStatus.EXPIRED


async def test_referral_bonus_only_on_first_payment(service, provider, settings):
    await service.register(1, "ref", "Ref")
    await service.register(10, "alice", "Alice", referrer_id=1)

    p1 = await service.create_payment(10, settings.tariff_list[0], "fake")
    provider.states[p1.external_id] = InvoiceState.PAID
    [r1] = await service.poll_pending(include_old=True)
    assert r1.referral_bonus_to == 1
    ref_user = await service.get_user(1)
    assert ref_user.is_active()
    ref_expiry = ref_user.expires_at

    p2 = await service.create_payment(10, settings.tariff_list[0], "fake")
    provider.states[p2.external_id] = InvoiceState.PAID
    [r2] = await service.poll_pending(include_old=True)
    assert r2.referral_bonus_to is None
    assert (await service.get_user(1)).expires_at == ref_expiry
    assert await service.referrals_count(1) == (1, 1)


async def test_reminders_fire_once_per_stage(service):
    await service.register(10, "alice", "Alice")
    await service.extend(10, 30)
    assert await service.due_reminders() == []

    await _expire(service, 10, utcnow() + timedelta(days=2))
    assert [r.stage for r in await service.due_reminders()] == ["3d"]
    assert await service.due_reminders() == []

    await _expire(service, 10, utcnow() + timedelta(hours=5))
    assert [r.stage for r in await service.due_reminders()] == ["1d"]

    await _expire(service, 10, utcnow() - timedelta(hours=1))
    assert [r.stage for r in await service.due_reminders()] == ["expired"]
    assert await service.due_reminders() == []

    # После продления напоминания снова работают для нового срока
    await service.extend(10, 30)
    await _expire(service, 10, utcnow() + timedelta(days=2))
    assert [r.stage for r in await service.due_reminders()] == ["3d"]


async def test_stats(service, provider, settings):
    await service.register(10, "alice", "Alice")
    await service.register(11, "bob", "Bob")
    p = await service.create_payment(10, settings.tariff_list[1], "fake")
    provider.states[p.external_id] = InvoiceState.PAID
    await service.poll_pending(include_old=True)
    st = await service.stats()
    assert st.users_total == 2 and st.users_active == 1 and st.payments_30d == 1
    assert st.revenue_30d["RUB"] == settings.tariff_list[1].price_rub


async def test_unknown_provider(service, settings):
    await service.register(10, "alice", "Alice")
    with pytest.raises(ServiceError):
        await service.create_payment(10, settings.tariff_list[0], "nope")
