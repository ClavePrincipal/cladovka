"""Проверяем, что HTTP-запросы к панели и платёжкам формируются в том формате, который ждут их API."""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import respx

from app.payments import CryptoBotProvider, InvoiceState, PaymentError, YooKassaProvider
from app.remnawave import RemnawaveClient, RemnawaveError

USER = {
    "id": 7,
    "shortUuid": "abc",
    "username": "tg_10",
    "status": "ACTIVE",
    "expireAt": "2026-12-27T10:00:00.000Z",
    "subscriptionUrl": "https://sub.example.com/abc",
    "trafficLimitBytes": 0,
    "telegramId": 10,
    "userTraffic": {"usedTrafficBytes": 1024, "lifetimeUsedTrafficBytes": 2048},
}


# ------------------------------------------------------------------ Remnawave


@respx.mock
async def test_remnawave_create_user_body_and_headers():
    route = respx.post("https://panel.example.com/api/users").mock(
        return_value=httpx.Response(201, json={"response": USER})
    )
    client = RemnawaveClient("https://panel.example.com/", "tok")
    user = await client.create_user(
        username="tg_10",
        expire_at=datetime(2026, 12, 27, 10, tzinfo=timezone.utc),
        telegram_id=10,
        squad_uuids=["sq"],
        hwid_device_limit=3,
        tag="BOT",
    )
    req = route.calls.last.request
    assert req.headers["Authorization"] == "Bearer tok"
    assert "X-Forwarded-Proto" not in req.headers
    body = json.loads(req.content)
    assert body == {
        "username": "tg_10",
        "status": "ACTIVE",
        "expireAt": "2026-12-27T10:00:00.000Z",
        "trafficLimitBytes": 0,
        "trafficLimitStrategy": "NO_RESET",
        "telegramId": 10,
        "activeInternalSquads": ["sq"],
        "hwidDeviceLimit": 3,
        "tag": "BOT",
    }
    assert user.id == 7 and user.used_traffic_bytes == 1024
    assert user.expire_at == datetime(2026, 12, 27, 10, tzinfo=timezone.utc)
    await client.close()


@respx.mock
async def test_remnawave_plain_http_adds_forwarded_headers():
    route = respx.get("http://remnawave:3000/api/internal-squads").mock(
        return_value=httpx.Response(200, json={"response": {"total": 1, "internalSquads": [{"uuid": "s1"}]}})
    )
    client = RemnawaveClient("http://remnawave:3000", "Bearer tok")
    assert await client.get_internal_squad_uuids() == ["s1"]
    req = route.calls.last.request
    assert req.headers["X-Forwarded-Proto"] == "https"
    assert req.headers["Authorization"] == "Bearer tok"
    await client.close()


@respx.mock
async def test_remnawave_update_and_404():
    respx.get("https://p.example.com/api/users/by-username/nobody").mock(
        return_value=httpx.Response(404, json={"message": "User not found"})
    )
    upd = respx.patch("https://p.example.com/api/users").mock(return_value=httpx.Response(200, json={"response": USER}))
    respx.get("https://p.example.com/api/users/99").mock(return_value=httpx.Response(500, text="oops"))

    client = RemnawaveClient("https://p.example.com", "tok")
    assert await client.get_user_by_username("nobody") is None
    await client.update_user(7, expire_at=datetime(2027, 1, 1, tzinfo=timezone.utc), status="ACTIVE")
    assert json.loads(upd.calls.last.request.content) == {
        "id": 7,
        "expireAt": "2027-01-01T00:00:00.000Z",
        "status": "ACTIVE",
    }
    with pytest.raises(RemnawaveError):
        await client.get_user_by_id(99)
    with pytest.raises(TypeError):
        await client.update_user(1, bogus=1)
    await client.close()


# ------------------------------------------------------------------ CryptoBot


@respx.mock
async def test_cryptobot_create_and_statuses():
    create = respx.get("https://pay.crypt.bot/api/createInvoice").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "result": {"invoice_id": 42, "status": "active", "bot_invoice_url": "https://t.me/CryptoBot?start=IV"},
            },
        )
    )
    respx.get("https://pay.crypt.bot/api/getInvoices").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "result": {"items": [{"invoice_id": 42, "status": "paid"}, {"invoice_id": 43, "status": "expired"}]},
            },
        )
    )
    p = CryptoBotProvider("TOKEN", expires_in=3600)
    inv = await p.create_invoice(amount=Decimal("199"), description="VPN 30", payload="10:30")
    assert inv.external_id == "42" and inv.pay_url.startswith("https://t.me/CryptoBot")

    req = create.calls.last.request
    assert req.headers["Crypto-Pay-API-Token"] == "TOKEN"
    q = {k: v[0] for k, v in parse_qs(urlparse(str(req.url)).query).items()}
    assert q == {
        "currency_type": "fiat",
        "fiat": "RUB",
        "accepted_assets": "USDT,TON,BTC",
        "amount": "199.00",
        "description": "VPN 30",
        "payload": "10:30",
        "expires_in": "3600",
    }
    assert await p.get_statuses(["42", "43"]) == {"42": InvoiceState.PAID, "43": InvoiceState.EXPIRED}
    await p.close()


@respx.mock
async def test_cryptobot_error():
    respx.get("https://testnet-pay.crypt.bot/api/createInvoice").mock(
        return_value=httpx.Response(400, json={"ok": False, "error": {"code": 401, "name": "UNAUTHORIZED"}})
    )
    p = CryptoBotProvider("bad", testnet=True)
    with pytest.raises(PaymentError):
        await p.create_invoice(amount=Decimal("1"), description="x", payload="y")
    await p.close()


# ------------------------------------------------------------------ ЮKassa


@respx.mock
async def test_yookassa_create_with_receipt_and_statuses():
    create = respx.post("https://api.yookassa.ru/v3/payments").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "2d0f-pay",
                "status": "pending",
                "confirmation": {"type": "redirect", "confirmation_url": "https://yoomoney.ru/checkout/xyz"},
            },
        )
    )
    respx.get("https://api.yookassa.ru/v3/payments/2d0f-pay").mock(
        return_value=httpx.Response(200, json={"id": "2d0f-pay", "status": "succeeded"})
    )
    respx.get("https://api.yookassa.ru/v3/payments/old").mock(
        return_value=httpx.Response(200, json={"id": "old", "status": "canceled"})
    )
    p = YooKassaProvider("12345", "live_secret", return_url="https://t.me/my_bot", receipt_email="r@example.com")
    inv = await p.create_invoice(amount=Decimal("549"), description="MyVPN: 3 месяца", payload="10:90")
    assert inv.external_id == "2d0f-pay" and inv.pay_url == "https://yoomoney.ru/checkout/xyz"

    req = create.calls.last.request
    assert req.headers["Authorization"] == "Basic " + base64.b64encode(b"12345:live_secret").decode()
    assert req.headers["Idempotence-Key"]
    body = json.loads(req.content)
    assert body["amount"] == {"value": "549.00", "currency": "RUB"}
    assert body["capture"] is True
    assert body["confirmation"] == {"type": "redirect", "return_url": "https://t.me/my_bot"}
    assert body["receipt"]["items"][0]["payment_subject"] == "service"
    assert body["receipt"]["customer"] == {"email": "r@example.com"}

    assert await p.get_statuses(["2d0f-pay", "old"]) == {"2d0f-pay": InvoiceState.PAID, "old": InvoiceState.CANCELED}
    await p.close()


@respx.mock
async def test_yookassa_without_receipt():
    route = respx.post("https://api.yookassa.ru/v3/payments").mock(
        return_value=httpx.Response(200, json={"id": "p", "confirmation": {"confirmation_url": "https://x"}})
    )
    p = YooKassaProvider("1", "s", return_url="https://t.me/b")
    await p.create_invoice(amount=Decimal("199.5"), description="d" * 300, payload="p")
    body = json.loads(route.calls.last.request.content)
    assert "receipt" not in body and len(body["description"]) == 128
    assert body["amount"]["value"] == "199.50"
    await p.close()
