"""Фоновые задачи: автопроверка оплат и напоминания о продлении."""

from __future__ import annotations

import asyncio
import logging

from aiogram import Bot

from . import keyboards as kb
from . import texts
from .config import Settings
from .notify import notify_paid, safe_send
from .service import VpnService

log = logging.getLogger(__name__)


async def payments_loop(bot: Bot, service: VpnService, settings: Settings) -> None:
    tick = 0
    while True:
        try:
            # Свежие счета проверяем каждый цикл, старые (до суток) — примерно раз в 10 минут
            include_old = tick % max(1, 600 // settings.payment_check_interval) == 0
            for result in await service.poll_pending(include_old=include_old):
                await notify_paid(bot, service, settings, result)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Ошибка в цикле проверки оплат")
        tick += 1
        await asyncio.sleep(settings.payment_check_interval)


async def reminders_loop(bot: Bot, service: VpnService, settings: Settings, interval: int = 1800) -> None:
    while True:
        try:
            for r in await service.due_reminders():
                await safe_send(
                    bot, service, r.user.id, texts.reminder(r.stage, r.user, settings), reply_markup=kb.renew()
                )
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Ошибка в цикле напоминаний")
        await asyncio.sleep(interval)
