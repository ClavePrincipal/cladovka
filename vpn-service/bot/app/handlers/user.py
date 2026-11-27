from __future__ import annotations

import logging

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import CommandObject, CommandStart
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message

from .. import keyboards as kb
from .. import texts
from ..config import Settings
from ..db import PaymentStatus, User
from ..notify import notify_paid
from ..service import PROCESSING, ServiceError, VpnService

log = logging.getLogger(__name__)


def _parse_ref(args: str | None) -> int | None:
    if args and args.startswith("ref_"):
        try:
            return int(args[4:])
        except ValueError:
            return None
    return None


async def _edit(cb: CallbackQuery, text: str, markup: InlineKeyboardMarkup | None = None) -> None:
    """Редактирует сообщение под кнопкой; если не получилось — отправляет новое."""
    msg = cb.message
    try:
        if isinstance(msg, Message):
            await msg.edit_text(text, reply_markup=markup)
            return
    except TelegramBadRequest as e:
        if "message is not modified" in str(e):
            return
    await cb.bot.send_message(cb.from_user.id, text, reply_markup=markup)  # type: ignore[union-attr]


def _menu(user: User, service: VpnService, settings: Settings) -> tuple[str, InlineKeyboardMarkup]:
    trial = service.trial_available(user)
    return (
        texts.main_menu(user, settings, trial),
        kb.main_menu(settings, trial_available=trial, has_access=user.is_active()),
    )


def build_router() -> Router:
    router = Router(name="user")

    # ------------------------------------------------------------------ /start и меню

    @router.message(CommandStart())
    async def cmd_start(message: Message, command: CommandObject, service: VpnService, settings: Settings) -> None:
        assert message.from_user
        u = message.from_user
        user, _ = await service.register(u.id, u.username, u.first_name, _parse_ref(command.args))
        text, markup = _menu(user, service, settings)
        await message.answer(text, reply_markup=markup)

    @router.callback_query(kb.Menu.filter(F.action == "home"))
    async def cb_home(cb: CallbackQuery, service: VpnService, settings: Settings) -> None:
        user, _ = await service.register(cb.from_user.id, cb.from_user.username, cb.from_user.first_name)
        await _edit(cb, *_menu(user, service, settings))
        await cb.answer()

    @router.callback_query(kb.Menu.filter(F.action == "help"))
    async def cb_help(cb: CallbackQuery) -> None:
        await _edit(cb, texts.HELP, kb.back_home())
        await cb.answer()

    @router.callback_query(kb.Menu.filter(F.action == "my"))
    async def cb_my(cb: CallbackQuery, service: VpnService, settings: Settings) -> None:
        try:
            user = await service.sync_from_panel(cb.from_user.id)
        except Exception:
            log.exception("Панель недоступна при открытии «Мой VPN»")
            user = await service.get_user(cb.from_user.id)  # покажем то, что есть в кэше
        if not user or not user.subscription_url:
            await _edit(cb, texts.NO_ACCESS, kb.back_home())
        else:
            await _edit(cb, texts.access(user, settings), kb.access(user.subscription_url))
        await cb.answer()

    @router.callback_query(kb.Menu.filter(F.action == "trial"))
    async def cb_trial(cb: CallbackQuery, service: VpnService, settings: Settings) -> None:
        try:
            user = await service.activate_trial(cb.from_user.id)
        except ServiceError as e:
            await cb.answer(str(e), show_alert=True)
            return
        except Exception:
            log.exception("Ошибка активации пробного периода")
            await cb.answer(texts.ERROR, show_alert=True)
            return
        await _edit(cb, texts.trial_success(user, settings), kb.access(user.subscription_url))
        await cb.answer("Готово!")

    @router.callback_query(kb.Menu.filter(F.action == "ref"))
    async def cb_ref(cb: CallbackQuery, bot: Bot, service: VpnService, settings: Settings) -> None:
        me = await bot.me()
        link = f"https://t.me/{me.username}?start=ref_{cb.from_user.id}"
        invited, paid = await service.referrals_count(cb.from_user.id)
        await _edit(cb, texts.referral(settings, link, invited, paid), kb.back_home())
        await cb.answer()

    # ------------------------------------------------------------------ покупка

    @router.callback_query(kb.Menu.filter(F.action == "buy"))
    async def cb_buy(cb: CallbackQuery, service: VpnService, settings: Settings) -> None:
        if not service.providers:
            await cb.answer("Оплата пока не настроена. Напишите в поддержку.", show_alert=True)
            return
        await _edit(cb, texts.tariffs(settings), kb.tariffs(settings))
        await cb.answer()

    @router.callback_query(kb.BuyTariff.filter())
    async def cb_tariff(
        cb: CallbackQuery, callback_data: kb.BuyTariff, service: VpnService, settings: Settings
    ) -> None:
        tariff = settings.tariff_by_code(callback_data.code)
        if tariff is None:
            await cb.answer("Тариф больше недоступен", show_alert=True)
            return
        titles = {name: p.title for name, p in service.providers.items()}
        await _edit(cb, texts.choose_method(tariff), kb.methods(tariff.code, titles))
        await cb.answer()

    @router.callback_query(kb.PayMethod.filter())
    async def cb_method(
        cb: CallbackQuery, callback_data: kb.PayMethod, service: VpnService, settings: Settings
    ) -> None:
        tariff = settings.tariff_by_code(callback_data.code)
        if tariff is None:
            await cb.answer("Тариф больше недоступен", show_alert=True)
            return
        await service.register(cb.from_user.id, cb.from_user.username, cb.from_user.first_name)
        try:
            payment = await service.create_payment(cb.from_user.id, tariff, callback_data.provider)
        except ServiceError as e:
            await cb.answer(str(e), show_alert=True)
            return
        except Exception:
            log.exception("Не удалось создать счёт (%s)", callback_data.provider)
            await cb.answer(texts.ERROR, show_alert=True)
            return
        title = service.providers[callback_data.provider].title
        await _edit(cb, texts.invoice(payment, title, settings.payment_ttl_minutes), kb.invoice(payment))
        if isinstance(cb.message, Message):
            await service.set_payment_message(payment.id, cb.message.message_id)
        await cb.answer()

    @router.callback_query(kb.CheckPay.filter())
    async def cb_check(
        cb: CallbackQuery, callback_data: kb.CheckPay, bot: Bot, service: VpnService, settings: Settings
    ) -> None:
        payment = await service.get_payment(callback_data.payment_id)
        if payment is None or payment.user_id != cb.from_user.id:
            await cb.answer("Счёт не найден", show_alert=True)
            return
        try:
            status, result = await service.check_payment(payment.id)
        except Exception:
            log.exception("Ошибка проверки платежа #%s", payment.id)
            await cb.answer(texts.ERROR, show_alert=True)
            return

        if result is not None:
            await cb.answer("Оплата получена!")
            await notify_paid(bot, service, settings, result)
        elif status == PaymentStatus.PAID:
            await cb.answer("Этот счёт уже оплачен ✅", show_alert=True)
        elif status == PROCESSING:
            await cb.answer("Оплата получена, включаем доступ…", show_alert=True)
        elif status == PaymentStatus.PENDING:
            await cb.answer(texts.INVOICE_NOT_YET, show_alert=True)
        else:
            await _edit(cb, texts.INVOICE_EXPIRED, kb.back_home())
            await cb.answer()

    return router
