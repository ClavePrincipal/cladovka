"""Точка входа: python -m app"""

from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand, LinkPreviewOptions

from .config import Settings, get_settings
from .db import Database
from .handlers import admin, user
from .payments import CryptoBotProvider, PaymentProvider, YooKassaProvider
from .remnawave import RemnawaveClient
from .service import VpnService
from .tasks import payments_loop, reminders_loop

log = logging.getLogger("app")


def build_providers(s: Settings) -> dict[str, PaymentProvider]:
    providers: dict[str, PaymentProvider] = {}
    if s.yookassa_enabled:
        providers["yookassa"] = YooKassaProvider(
            s.yookassa_shop_id,
            s.yookassa_secret_key,
            return_url=s.yookassa_return_url or "https://t.me",
            receipt_email=s.yookassa_receipt_email,
        )
    if s.cryptobot_enabled:
        providers["cryptobot"] = CryptoBotProvider(
            s.cryptobot_token,
            testnet=s.cryptobot_testnet,
            accepted_assets=s.cryptobot_assets,
            expires_in=s.payment_ttl_minutes * 60,
        )
    return providers


def build_dispatcher(settings: Settings, service: VpnService) -> Dispatcher:
    dp = Dispatcher(service=service, settings=settings)
    dp.include_router(admin.build_router(settings))
    dp.include_router(user.build_router())
    return dp


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()

    db = Database(settings.database_url)
    await db.create_all()
    panel = RemnawaveClient(settings.remnawave_url, settings.remnawave_token, settings.remnawave_caddy_token)
    providers = build_providers(settings)
    if not providers:
        log.warning("Не настроен ни один способ оплаты — продажи работать не будут")
    service = VpnService(db, panel, settings, providers)

    # Проверяем доступ к панели сразу при запуске, чтобы не узнать о проблеме от клиентов
    try:
        squads = await panel.get_internal_squad_uuids()
        log.info("Панель Remnawave доступна, сквадов: %d", len(squads))
    except Exception:
        log.exception("Нет доступа к панели Remnawave — проверьте REMNAWAVE_URL и REMNAWAVE_TOKEN")
        raise

    bot = Bot(
        settings.bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML, link_preview=LinkPreviewOptions(is_disabled=True)),
    )
    await bot.set_my_commands([BotCommand(command="start", description="Главное меню")])
    dp = build_dispatcher(settings, service)

    background = [
        asyncio.create_task(payments_loop(bot, service, settings)),
        asyncio.create_task(reminders_loop(bot, service, settings)),
    ]
    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        for t in background:
            t.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        for p in providers.values():
            await p.close()
        await panel.close()
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
