"""Отправка уведомлений об оплате (общая для кнопки «Я оплатил» и фоновой проверки)."""

from __future__ import annotations

import logging

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError

from . import keyboards as kb
from . import texts
from .config import Settings
from .service import PaidResult, VpnService

log = logging.getLogger(__name__)


async def safe_send(bot: Bot, service: VpnService, chat_id: int, text: str, **kwargs) -> bool:
    try:
        await bot.send_message(chat_id, text, **kwargs)
        return True
    except TelegramForbiddenError:
        await service.set_bot_blocked(chat_id)
    except TelegramBadRequest as e:
        log.warning("Не удалось отправить сообщение %s: %s", chat_id, e)
    return False


async def notify_paid(bot: Bot, service: VpnService, settings: Settings, result: PaidResult) -> None:
    p, user = result.payment, result.user
    if p.message_id:
        try:
            await bot.edit_message_text(texts.INVOICE_PAID.format(id=p.id), chat_id=p.user_id, message_id=p.message_id)
        except TelegramBadRequest:
            pass
    await safe_send(
        bot,
        service,
        p.user_id,
        texts.paid_success(user, settings, p.days),
        reply_markup=kb.access(user.subscription_url),
    )
    if result.referral_bonus_to:
        await safe_send(bot, service, result.referral_bonus_to, texts.referral_bonus(settings))
    for admin_id in settings.admin_ids:
        try:
            await bot.send_message(admin_id, texts.admin_new_payment(p, user))
        except Exception:  # noqa: BLE001 — уведомление админу не должно ломать обработку
            log.warning("Не удалось уведомить админа %s", admin_id)
