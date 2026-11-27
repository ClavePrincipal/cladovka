"""Сквозной сценарий: апдейты Telegram идут через настоящий диспетчер, API Telegram подменён."""

from __future__ import annotations

import itertools
from datetime import datetime, timezone

import pytest
from aiogram import Bot
from aiogram.client.session.base import BaseSession
from aiogram.methods import AnswerCallbackQuery, EditMessageText, GetMe, SendMessage, TelegramMethod
from aiogram.types import CallbackQuery, Chat, Message, Update
from aiogram.types import User as TgUser

from app import keyboards as kb
from app.__main__ import build_dispatcher
from app.payments import InvoiceState
from app.tasks import notify_paid

ALICE = TgUser(id=10, is_bot=False, first_name="Alice", username="alice")
CHAT = Chat(id=10, type="private")


class FakeTelegram(BaseSession):
    def __init__(self) -> None:
        super().__init__()
        self.sent: list[TelegramMethod] = []
        self._ids = itertools.count(100)

    async def make_request(self, bot, method, timeout=None):  # type: ignore[override]
        self.sent.append(method)
        if isinstance(method, GetMe):
            return TgUser(id=1, is_bot=True, first_name="Bot", username="test_vpn_bot")
        if isinstance(method, (SendMessage, EditMessageText)):
            return Message(
                message_id=next(self._ids),
                date=datetime.now(timezone.utc),
                chat=Chat(id=method.chat_id or 10, type="private"),
                text=method.text,
            )
        if isinstance(method, AnswerCallbackQuery):
            return True
        return True

    async def stream_content(self, *a, **kw):  # pragma: no cover
        raise NotImplementedError

    async def close(self) -> None:
        pass

    def texts(self) -> list[str]:
        return [m.text for m in self.sent if isinstance(m, (SendMessage, EditMessageText))]

    def alerts(self) -> list[str]:
        return [m.text for m in self.sent if isinstance(m, AnswerCallbackQuery) and m.text]

    def last_markup(self):
        return next(m.reply_markup for m in reversed(self.sent) if isinstance(m, (SendMessage, EditMessageText)))


@pytest.fixture
def tg():
    return FakeTelegram()


@pytest.fixture
def bot(tg):
    return Bot("42:TEST", session=tg)


_update_ids = itertools.count(1)


def _msg(text: str) -> Update:
    return Update(
        update_id=next(_update_ids),
        message=Message(message_id=1, date=datetime.now(timezone.utc), chat=CHAT, from_user=ALICE, text=text),
    )


def _cb(data: str) -> Update:
    msg = Message(message_id=55, date=datetime.now(timezone.utc), chat=CHAT, text="…")
    return Update(
        update_id=next(_update_ids),
        callback_query=CallbackQuery(id="cb", from_user=ALICE, chat_instance="x", message=msg, data=data),
    )


async def test_full_user_journey(bot, tg, service, settings, provider, panel):
    service.providers["fake"] = provider
    dp = build_dispatcher(settings, service)

    # /start с реферальной ссылкой несуществующего пользователя — просто меню
    await dp.feed_update(bot, _msg("/start ref_999"))
    assert "Подписки пока нет" in tg.texts()[-1]

    # Пробный период
    await dp.feed_update(bot, _cb(kb.Menu(action="trial").pack()))
    assert "Пробный период на 3 дн. активирован" in tg.texts()[-1]
    sub_url = (await service.get_user(10)).subscription_url
    assert sub_url in tg.texts()[-1]
    # Повторно нельзя
    await dp.feed_update(bot, _cb(kb.Menu(action="trial").pack()))
    assert tg.alerts()[-1] == "Пробный период уже использован"

    # Покупка: тарифы -> способ -> счёт
    await dp.feed_update(bot, _cb(kb.Menu(action="buy").pack()))
    assert "Выберите срок" in tg.texts()[-1]
    await dp.feed_update(bot, _cb(kb.BuyTariff(code="d30").pack()))
    assert "Выберите способ оплаты" in tg.texts()[-1]
    await dp.feed_update(bot, _cb(kb.PayMethod(code="d30", provider="fake").pack()))
    assert "Счёт №1" in tg.texts()[-1]
    pay_button = tg.last_markup().inline_keyboard[0][0]
    assert pay_button.url == "https://pay.example.com/inv1"

    # «Я оплатил» до оплаты
    await dp.feed_update(bot, _cb(kb.CheckPay(payment_id=1).pack()))
    assert "не поступила" in tg.alerts()[-1]

    # Оплата прошла — нажимаем «Я оплатил»
    before = (await service.get_user(10)).expires_at
    provider.states["inv1"] = InvoiceState.PAID
    await dp.feed_update(bot, _cb(kb.CheckPay(payment_id=1).pack()))
    assert any("Оплата получена! +30 дн." in t for t in tg.texts())
    assert any("Оплата 199 ₽" in t for t in tg.texts())  # уведомление админам
    after = (await service.get_user(10)).expires_at
    assert (after - before).days == 30

    # Повторное нажатие — не начисляет второй раз
    await dp.feed_update(bot, _cb(kb.CheckPay(payment_id=1).pack()))
    assert tg.alerts()[-1] == "Этот счёт уже оплачен ✅"
    assert (await service.get_user(10)).expires_at == after

    # Мой VPN
    await dp.feed_update(bot, _cb(kb.Menu(action="my").pack()))
    assert "Подписка активна" in tg.texts()[-1]
    assert tg.last_markup().inline_keyboard[0][0].url == sub_url

    # Реферальная ссылка
    await dp.feed_update(bot, _cb(kb.Menu(action="ref").pack()))
    assert "https://t.me/test_vpn_bot?start=ref_10" in tg.texts()[-1]


async def test_foreign_payment_not_visible(bot, tg, service, settings, provider):
    dp = build_dispatcher(settings, service)
    await service.register(77, "eve", "Eve")
    p = await service.create_payment(77, settings.tariff_list[0], "fake")
    await dp.feed_update(bot, _msg("/start"))
    await dp.feed_update(bot, _cb(kb.CheckPay(payment_id=p.id).pack()))
    assert tg.alerts()[-1] == "Счёт не найден"


async def test_background_payment_notification(bot, tg, service, settings, provider):
    await service.register(10, "alice", "Alice")
    p = await service.create_payment(10, settings.tariff_list[0], "fake")
    await service.set_payment_message(p.id, 555)
    provider.states[p.external_id] = InvoiceState.PAID
    [result] = await service.poll_pending(include_old=True)
    await notify_paid(bot, service, settings, result)
    edits = [m for m in tg.sent if isinstance(m, EditMessageText)]
    assert edits and edits[0].message_id == 555 and "оплачен" in edits[0].text
    assert any("Оплата получена" in t for t in tg.texts())


async def test_admin_commands(bot, tg, service, settings):
    dp = build_dispatcher(settings, service)
    admin = TgUser(id=1, is_bot=False, first_name="Admin")

    def admin_msg(text: str) -> Update:
        return Update(
            update_id=next(_update_ids),
            message=Message(
                message_id=1,
                date=datetime.now(timezone.utc),
                chat=Chat(id=1, type="private"),
                from_user=admin,
                text=text,
            ),
        )

    await service.register(10, "alice", "Alice")
    await dp.feed_update(bot, admin_msg("/give 10 14"))
    assert "Готово" in tg.texts()[-2] and "+14 дн." in tg.texts()[-1]
    await dp.feed_update(bot, admin_msg("/stats"))
    assert "Активных подписок: 1" in tg.texts()[-1]
    await dp.feed_update(bot, admin_msg("/user 10"))
    assert "@alice" in tg.texts()[-1]

    # Обычный пользователь не может вызвать админ-команду
    n = len(tg.sent)
    await dp.feed_update(bot, _msg("/give 10 999"))
    assert len(tg.sent) == n
