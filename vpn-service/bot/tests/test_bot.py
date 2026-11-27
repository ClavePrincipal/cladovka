"""Конфиг, тексты, клавиатуры и сборка диспетчера."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app import keyboards as kb
from app import texts
from app.__main__ import build_dispatcher, build_providers
from app.config import Settings, parse_tariffs
from app.db import User
from app.handlers.user import _parse_ref


def test_parse_tariffs_sorted_and_titled():
    ts = parse_tariffs("90:549, 30:199,360:1790,7:59")
    assert [t.days for t in ts] == [7, 30, 90, 360]
    assert [t.title for t in ts] == ["7 дней", "1 месяц", "3 месяца", "12 месяцев"]
    assert ts[1].price_rub == Decimal("199")


@pytest.mark.parametrize("raw", ["", "30:0", "abc", "30:199,30:299", "-1:5"])
def test_parse_tariffs_invalid(raw):
    with pytest.raises(ValueError):
        parse_tariffs(raw)


def test_settings_csv_and_flags(settings: Settings):
    assert settings.admin_ids == [1, 2]
    assert settings.remnawave_url == "https://panel.example.com"
    assert not settings.cryptobot_enabled and not settings.yookassa_enabled
    assert settings.tariff_by_code("d30") is not None and settings.tariff_by_code("d1") is None
    assert build_providers(settings) == {}


def test_providers_built_when_configured(settings: Settings):
    s = settings.model_copy(update={"cryptobot_token": "x", "yookassa_shop_id": "1", "yookassa_secret_key": "y"})
    assert set(build_providers(s)) == {"cryptobot", "yookassa"}


def test_callback_data_fits_telegram_limit(settings: Settings):
    for packed in [
        kb.Menu(action="home").pack(),
        kb.BuyTariff(code="d360").pack(),
        kb.PayMethod(code="d360", provider="cryptobot").pack(),
        kb.CheckPay(payment_id=2**31).pack(),
    ]:
        assert len(packed.encode()) <= 64


def test_parse_ref():
    assert _parse_ref("ref_123") == 123
    assert _parse_ref("ref_abc") is None
    assert _parse_ref(None) is None
    assert _parse_ref("promo") is None


def test_texts_render(settings: Settings):
    user = User(id=10, username="a<b", first_name="A", trial_used=False)
    menu = texts.main_menu(user, settings, trial_available=True)
    assert "Подписки пока нет" in menu and "3 дн." in menu
    t = texts.tariffs(settings)
    assert "1 месяц" in t and "199 ₽" in t and "−8%" in t  # 549/90 vs 199/30
    assert "a&lt;b" in texts.admin_user(user.__class__(**{**_defaults(), "id": 1, "username": "a<b"}), settings)


def _defaults():
    from app.db import utcnow

    return {"created_at": utcnow(), "trial_used": False, "bot_blocked": False}


def test_dispatcher_builds(settings: Settings):
    dp = build_dispatcher(settings, service=object())  # type: ignore[arg-type]
    assert {r.name for r in dp.sub_routers} == {"admin", "user"}
    assert "callback_query" in dp.resolve_used_update_types()
