"""Все тексты бота в одном месте — правьте под свой бренд."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from html import escape
from zoneinfo import ZoneInfo

from .config import Settings, Tariff, _plural
from .db import Payment, User, utcnow
from .service import Stats


def fmt_date(dt: datetime, tz: str) -> str:
    return dt.astimezone(ZoneInfo(tz)).strftime("%d.%m.%Y %H:%M")


def fmt_price(amount: Decimal) -> str:
    q = amount.quantize(Decimal("1")) if amount == amount.to_integral() else amount
    return f"{q} ₽"


def days_left(dt: datetime) -> int:
    return max(0, (dt - utcnow()).days)


def status_line(user: User, s: Settings) -> str:
    if user.is_active() and user.expires_at:
        left = days_left(user.expires_at)
        return (
            f"✅ Подписка активна до <b>{fmt_date(user.expires_at, s.timezone)}</b> "
            f"({left} {_plural(left, 'день', 'дня', 'дней')})"
        )
    if user.expires_at:
        return f"❌ Подписка закончилась {fmt_date(user.expires_at, s.timezone)}"
    return "❌ Подписки пока нет"


def main_menu(user: User, s: Settings, trial_available: bool) -> str:
    devices = f"До {s.hwid_device_limit} устройств" if s.hwid_device_limit else "Без ограничения устройств"
    traffic = f"{s.traffic_limit_gb} ГБ в месяц" if s.traffic_limit_gb else "Безлимитный трафик"
    trial = f"\n\n🎁 Попробуйте бесплатно {s.trial_days} дн." if trial_available else ""
    return (
        f"🔐 <b>{escape(s.project_name)}</b> — VPN, который работает даже там, где другие блокируют.\n\n"
        "• Протокол VLESS Reality: трафик выглядит как обычный HTTPS\n"
        f"• {devices}\n"
        f"• {traffic}\n"
        "• iPhone, Android, Windows, macOS, Linux\n\n"
        f"{status_line(user, s)}{trial}"
    )


def tariffs(s: Settings) -> str:
    lines = ["💳 <b>Выберите срок подписки</b>\n"]
    base = s.tariff_list[0]
    per_day_base = base.price_rub / base.days
    for t in s.tariff_list:
        per_month = t.price_rub / t.days * 30
        discount = int(round((1 - (t.price_rub / t.days) / per_day_base) * 100))
        extra = f" (−{discount}%)" if discount > 0 else ""
        lines.append(f"• {t.title} — <b>{fmt_price(t.price_rub)}</b>  ≈ {per_month:.0f} ₽/мес{extra}")
    lines.append("\nЕсли подписка активна, новый срок добавится к текущему.")
    if s.offer_url:
        lines.append(f'Оплачивая, вы принимаете <a href="{escape(s.offer_url)}">условия сервиса</a>.')
    return "\n".join(lines)


def choose_method(t: Tariff) -> str:
    return f"Тариф: <b>{t.title}</b> за <b>{fmt_price(t.price_rub)}</b>\n\nВыберите способ оплаты:"


def invoice(p: Payment, provider_title: str, ttl_minutes: int) -> str:
    return (
        f"🧾 <b>Счёт №{p.id}</b>\n\n"
        f"Сумма: <b>{fmt_price(p.amount)}</b>\n"
        f"Срок: {p.days} дн.\n"
        f"Способ: {provider_title}\n\n"
        f"Нажмите «Оплатить». Ссылка действует {ttl_minutes} мин.\n"
        "После оплаты доступ включится автоматически в течение минуты, "
        "или нажмите «Я оплатил»."
    )


INVOICE_PAID = "✅ <b>Счёт №{id} оплачен.</b> Спасибо!"
INVOICE_NOT_YET = "Оплата пока не поступила. Если вы уже заплатили, подождите минуту и проверьте ещё раз."
INVOICE_EXPIRED = "Счёт просрочен или отменён. Создайте новый в меню «Купить»."


def access(user: User, s: Settings) -> str:
    url = escape(user.subscription_url or "")
    return (
        f"{status_line(user, s)}\n\n"
        "🔗 <b>Ваша ссылка-подписка</b> (нажмите, чтобы скопировать):\n"
        f"<code>{url}</code>\n\n"
        "Нажмите «Подключить»: откроется страница с инструкцией для вашего устройства. "
        "Ссылка одна на все устройства, не передавайте её другим."
    )


def paid_success(user: User, s: Settings, days: int) -> str:
    return f"🎉 <b>Оплата получена! +{days} дн.</b>\n\n" + access(user, s)


def trial_success(user: User, s: Settings) -> str:
    return f"🎁 <b>Пробный период на {s.trial_days} дн. активирован!</b>\n\n" + access(user, s)


NO_ACCESS = "У вас пока нет подписки. Нажмите «Купить» или попробуйте бесплатно, если доступно."


HELP = (
    "📖 <b>Как подключиться</b>\n\n"
    "<b>1. Установите приложение</b>\n"
    "• iPhone / iPad: <b>Happ</b> или <b>v2RayTun</b> (App Store)\n"
    "• Android: <b>Happ</b>, <b>v2RayTun</b> или <b>Hiddify</b> (Google Play)\n"
    "• Windows / macOS: <b>Happ</b> или <b>Hiddify</b>\n"
    "• Linux: <b>Hiddify</b> или <b>v2rayN</b>\n\n"
    "<b>2. Добавьте подписку</b>\n"
    "Откройте «Мой VPN», нажмите «Подключить» и выберите своё приложение. "
    "Или скопируйте ссылку и в приложении нажмите «+» → «Импорт из буфера».\n\n"
    "<b>3. Включите VPN</b> большой кнопкой в приложении.\n\n"
    "Не работает? Обновите подписку в приложении (иконка ↻) или напишите в поддержку."
)


def referral(s: Settings, link: str, invited: int, paid: int) -> str:
    return (
        "🤝 <b>Пригласите друга</b>\n\n"
        f"Когда друг оплатит первую подписку, вы получите <b>+{s.referral_bonus_days} дн.</b> бесплатно.\n\n"
        f"Ваша ссылка:\n<code>{escape(link)}</code>\n\n"
        f"Приглашено: {invited}, оплатили: {paid}"
    )


def referral_bonus(s: Settings) -> str:
    return f"🎁 Ваш друг оплатил подписку, вам начислено <b>+{s.referral_bonus_days} дн.</b> Спасибо!"


def reminder(stage: str, user: User, s: Settings) -> str:
    if stage == "expired":
        return "⛔️ <b>Подписка закончилась</b>, VPN отключён. Продлите, чтобы снова пользоваться."
    when = fmt_date(user.expires_at, s.timezone) if user.expires_at else ""
    if stage == "1d":
        return f"⏰ <b>Подписка закончится меньше чем через сутки</b> ({when}). Продлите, чтобы не потерять доступ."
    return f"⏰ Подписка закончится через 3 дня ({when}). Продлить можно заранее, дни суммируются."


ERROR = "😔 Что-то пошло не так. Попробуйте ещё раз через минуту или напишите в поддержку."


# ---------------------------------------------------------------- admin


ADMIN_HELP = (
    "<b>Команды администратора</b>\n\n"
    "/stats — статистика\n"
    "/user &lt;id&gt; — информация о пользователе\n"
    "/give &lt;id&gt; &lt;дней&gt; — подарить дни\n"
    "/broadcast — ответьте этой командой на сообщение, чтобы разослать его всем"
)


def admin_stats(st: Stats) -> str:
    revenue = ", ".join(f"{fmt_price(v) if c == 'RUB' else f'{v} {c}'}" for c, v in st.revenue_30d.items()) or "0 ₽"
    return (
        "📊 <b>Статистика</b>\n\n"
        f"Пользователей: {st.users_total} (+{st.users_new_24h} за сутки)\n"
        f"Активных подписок: {st.users_active}\n"
        f"Оплат за 30 дней: {st.payments_30d}\n"
        f"Выручка за 30 дней: {revenue}"
    )


def admin_user(user: User, s: Settings) -> str:
    name = f"@{escape(user.username)}" if user.username else escape(user.first_name or "—")
    return (
        f"👤 <b>{name}</b> (<code>{user.id}</code>)\n"
        f"Зарегистрирован: {fmt_date(user.created_at, s.timezone)}\n"
        f"{status_line(user, s)}\n"
        f"Panel UUID: <code>{user.panel_uuid or '—'}</code>\n"
        f"Пригласил: {user.referrer_id or '—'} | Триал: {'да' if user.trial_used else 'нет'}"
        f"{' | ⛔️ заблокировал бота' if user.bot_blocked else ''}"
    )


def admin_new_payment(p: Payment, user: User) -> str:
    name = f"@{escape(user.username)}" if user.username else escape(user.first_name or str(user.id))
    return f"💰 Оплата {fmt_price(p.amount)} — {name} (<code>{user.id}</code>), {p.days} дн., {p.provider}"
