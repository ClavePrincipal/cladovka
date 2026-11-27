from __future__ import annotations

from aiogram.filters.callback_data import CallbackData
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
from aiogram.utils.keyboard import InlineKeyboardBuilder

from .config import Settings
from .db import Payment
from .texts import fmt_price


class Menu(CallbackData, prefix="m"):
    action: str  # home | buy | my | trial | help | ref


class BuyTariff(CallbackData, prefix="t"):
    code: str


class PayMethod(CallbackData, prefix="pm"):
    code: str
    provider: str


class CheckPay(CallbackData, prefix="cp"):
    payment_id: int


def main_menu(s: Settings, *, trial_available: bool, has_access: bool) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    if trial_available:
        kb.button(text=f"🎁 Попробовать бесплатно ({s.trial_days} дн.)", callback_data=Menu(action="trial"))
    kb.button(text="💳 Продлить" if has_access else "💳 Купить", callback_data=Menu(action="buy"))
    kb.button(text="🔐 Мой VPN", callback_data=Menu(action="my"))
    kb.button(text="📖 Как подключить", callback_data=Menu(action="help"))
    if s.referral_bonus_days > 0:
        kb.button(text="🤝 Пригласить друга", callback_data=Menu(action="ref"))
    if s.support_username:
        kb.button(text="💬 Поддержка", url=f"https://t.me/{s.support_username.lstrip('@')}")
    kb.adjust(1)
    return kb.as_markup()


def back_home() -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.button(text="« В меню", callback_data=Menu(action="home"))
    return kb.as_markup()


def tariffs(s: Settings) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    for t in s.tariff_list:
        kb.button(text=f"{t.title} — {fmt_price(t.price_rub)}", callback_data=BuyTariff(code=t.code))
    kb.button(text="« В меню", callback_data=Menu(action="home"))
    kb.adjust(1)
    return kb.as_markup()


def methods(code: str, providers: dict[str, str]) -> InlineKeyboardMarkup:
    """providers: name -> title"""
    kb = InlineKeyboardBuilder()
    for name, title in providers.items():
        kb.button(text=title, callback_data=PayMethod(code=code, provider=name))
    kb.button(text="« Назад", callback_data=Menu(action="buy"))
    kb.adjust(1)
    return kb.as_markup()


def invoice(p: Payment) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="💳 Оплатить", url=p.pay_url)],
            [InlineKeyboardButton(text="🔄 Я оплатил", callback_data=CheckPay(payment_id=p.id).pack())],
            [InlineKeyboardButton(text="« В меню", callback_data=Menu(action="home").pack())],
        ]
    )


def access(subscription_url: str | None) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    if subscription_url:
        kb.button(text="🚀 Подключить", url=subscription_url)
    kb.button(text="📖 Инструкция", callback_data=Menu(action="help"))
    kb.button(text="💳 Продлить", callback_data=Menu(action="buy"))
    kb.button(text="« В меню", callback_data=Menu(action="home"))
    kb.adjust(1, 2, 1)
    return kb.as_markup()


def renew() -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.button(text="💳 Продлить", callback_data=Menu(action="buy"))
    return kb.as_markup()
