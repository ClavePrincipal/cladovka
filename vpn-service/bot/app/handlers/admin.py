from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Router
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, CommandObject
from aiogram.types import Message

from .. import texts
from ..config import Settings
from ..service import VpnService

log = logging.getLogger(__name__)
_background: set[asyncio.Task[None]] = set()  # держим ссылки, чтобы задачи не собрал GC


def build_router(settings: Settings) -> Router:
    router = Router(name="admin")
    admins = set(settings.admin_ids)
    router.message.filter(lambda m: m.from_user is not None and m.from_user.id in admins)

    @router.message(Command("admin"))
    async def cmd_admin(message: Message) -> None:
        await message.answer(texts.ADMIN_HELP)

    @router.message(Command("stats"))
    async def cmd_stats(message: Message, service: VpnService) -> None:
        await message.answer(texts.admin_stats(await service.stats()))

    @router.message(Command("user"))
    async def cmd_user(message: Message, command: CommandObject, service: VpnService) -> None:
        if not command.args or not command.args.strip().isdigit():
            await message.answer("Использование: /user &lt;telegram_id&gt;")
            return
        uid = int(command.args.strip())
        try:
            user = await service.sync_from_panel(uid)
        except Exception:
            user = await service.get_user(uid)
        if not user:
            await message.answer("Пользователь не найден")
            return
        await message.answer(texts.admin_user(user, settings))

    @router.message(Command("give"))
    async def cmd_give(message: Message, command: CommandObject, bot: Bot, service: VpnService) -> None:
        parts = (command.args or "").split()
        if len(parts) != 2 or not all(p.lstrip("-").isdigit() for p in parts) or int(parts[1]) <= 0:
            await message.answer("Использование: /give &lt;telegram_id&gt; &lt;дней&gt;")
            return
        uid, days = int(parts[0]), int(parts[1])
        if not await service.get_user(uid):
            await message.answer("Пользователь не найден (он должен хотя бы раз нажать /start)")
            return
        try:
            user = await service.extend(uid, days)
        except Exception as e:
            log.exception("give failed")
            await message.answer(f"Ошибка: {e}")
            return
        await message.answer(f"Готово. {texts.status_line(user, settings)}")
        try:
            await bot.send_message(uid, f"🎁 Вам начислено <b>+{days} дн.</b> подписки!")
        except Exception:
            pass

    @router.message(Command("broadcast"))
    async def cmd_broadcast(message: Message, bot: Bot, service: VpnService) -> None:
        src = message.reply_to_message
        if src is None:
            await message.answer("Ответьте командой /broadcast на сообщение, которое нужно разослать.")
            return
        ids = await service.all_user_ids()
        await message.answer(f"Начинаю рассылку на {len(ids)} пользователей…")

        async def run() -> None:
            ok = fail = 0
            for uid in ids:
                for _ in range(3):
                    try:
                        await bot.copy_message(uid, src.chat.id, src.message_id)
                        ok += 1
                        break
                    except TelegramRetryAfter as e:
                        await asyncio.sleep(e.retry_after + 1)
                    except TelegramForbiddenError:
                        await service.set_bot_blocked(uid)
                        fail += 1
                        break
                    except Exception:
                        fail += 1
                        break
                await asyncio.sleep(0.05)  # ~20 сообщений/сек — в пределах лимитов Telegram
            await message.answer(f"Рассылка завершена: доставлено {ok}, не доставлено {fail}.")

        task = asyncio.create_task(run())
        _background.add(task)
        task.add_done_callback(_background.discard)

    return router
