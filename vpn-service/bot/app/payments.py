"""Платёжные провайдеры.

Подтверждение оплаты — опросом API провайдера (бот сам спрашивает статус счёта).
Так не нужен публичный webhook-адрес, и подделать «успешную оплату» нельзя:
статус всегда берётся напрямую у провайдера по его API-ключу.

Чтобы добавить новый способ оплаты (Platega, Lava, Telegram Stars ...),
достаточно реализовать класс с методами create_invoice / get_statuses.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

import httpx

log = logging.getLogger(__name__)


class InvoiceState:
    PENDING = "pending"
    PAID = "paid"
    EXPIRED = "expired"
    CANCELED = "canceled"


@dataclass
class CreatedInvoice:
    external_id: str
    pay_url: str


class PaymentError(Exception):
    pass


class PaymentProvider(Protocol):
    name: str
    title: str

    async def create_invoice(self, *, amount: Decimal, description: str, payload: str) -> CreatedInvoice: ...

    async def get_statuses(self, external_ids: list[str]) -> dict[str, str]:
        """external_id -> InvoiceState. Отсутствующие в ответе id считаются pending."""
        ...

    async def close(self) -> None: ...


# --------------------------------------------------------------------------- CryptoBot


class CryptoBotProvider:
    """Crypto Pay API (@CryptoBot). Счёт выставляется в рублях, клиент платит USDT/TON/BTC."""

    name = "cryptobot"
    title = "💎 Криптовалюта (CryptoBot)"

    STATUS_MAP = {"active": InvoiceState.PENDING, "paid": InvoiceState.PAID, "expired": InvoiceState.EXPIRED}

    def __init__(
        self,
        token: str,
        *,
        testnet: bool = False,
        accepted_assets: str = "USDT,TON,BTC",
        expires_in: int = 3600,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        base = "https://testnet-pay.crypt.bot" if testnet else "https://pay.crypt.bot"
        self._http = httpx.AsyncClient(
            base_url=f"{base}/api",
            headers={"Crypto-Pay-API-Token": token},
            timeout=15.0,
            transport=transport,
        )
        self._assets = accepted_assets
        self._expires_in = expires_in

    async def _call(self, method: str, params: dict[str, Any]) -> Any:
        resp = await self._http.get(f"/{method}", params={k: v for k, v in params.items() if v is not None})
        try:
            data = resp.json()
        except ValueError as e:
            raise PaymentError(f"CryptoBot {method}: HTTP {resp.status_code}") from e
        if not data.get("ok"):
            raise PaymentError(f"CryptoBot {method}: {data.get('error')}")
        return data["result"]

    async def create_invoice(self, *, amount: Decimal, description: str, payload: str) -> CreatedInvoice:
        result = await self._call(
            "createInvoice",
            {
                "currency_type": "fiat",
                "fiat": "RUB",
                "accepted_assets": self._assets,
                "amount": f"{amount:.2f}",
                "description": description[:1024],
                "payload": payload,
                "expires_in": self._expires_in,
            },
        )
        url = result.get("bot_invoice_url") or result.get("mini_app_invoice_url") or result.get("pay_url")
        return CreatedInvoice(external_id=str(result["invoice_id"]), pay_url=url)

    async def get_statuses(self, external_ids: list[str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for i in range(0, len(external_ids), 100):
            chunk = external_ids[i : i + 100]
            result = await self._call("getInvoices", {"invoice_ids": ",".join(chunk), "count": len(chunk)})
            for item in result.get("items", []):
                out[str(item["invoice_id"])] = self.STATUS_MAP.get(item.get("status"), InvoiceState.PENDING)
        return out

    async def close(self) -> None:
        await self._http.aclose()


# --------------------------------------------------------------------------- ЮKassa


class YooKassaProvider:
    """ЮKassa API v3: банковские карты РФ, СБП, SberPay, ЮMoney."""

    name = "yookassa"
    title = "💳 Карта / СБП (ЮKassa)"

    STATUS_MAP = {
        "pending": InvoiceState.PENDING,
        "waiting_for_capture": InvoiceState.PENDING,
        "succeeded": InvoiceState.PAID,
        "canceled": InvoiceState.CANCELED,
    }

    def __init__(
        self,
        shop_id: str,
        secret_key: str,
        *,
        return_url: str,
        receipt_email: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url="https://api.yookassa.ru/v3",
            auth=(shop_id, secret_key),
            timeout=15.0,
            transport=transport,
        )
        self._return_url = return_url
        self._receipt_email = receipt_email

    async def create_invoice(self, *, amount: Decimal, description: str, payload: str) -> CreatedInvoice:
        value = f"{amount:.2f}"
        body: dict[str, Any] = {
            "amount": {"value": value, "currency": "RUB"},
            "capture": True,
            "confirmation": {"type": "redirect", "return_url": self._return_url},
            "description": description[:128],
            "metadata": {"payload": payload},
        }
        if self._receipt_email:
            body["receipt"] = {
                "customer": {"email": self._receipt_email},
                "items": [
                    {
                        "description": description[:128],
                        "quantity": "1.00",
                        "amount": {"value": value, "currency": "RUB"},
                        "vat_code": 1,
                        "payment_subject": "service",
                        "payment_mode": "full_payment",
                    }
                ],
            }
        resp = await self._http.post("/payments", json=body, headers={"Idempotence-Key": str(uuid.uuid4())})
        if resp.status_code >= 400:
            raise PaymentError(f"ЮKassa: HTTP {resp.status_code} {resp.text[:300]}")
        data = resp.json()
        return CreatedInvoice(external_id=data["id"], pay_url=data["confirmation"]["confirmation_url"])

    async def get_statuses(self, external_ids: list[str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for ext_id in external_ids:
            resp = await self._http.get(f"/payments/{ext_id}")
            if resp.status_code >= 400:
                log.warning("ЮKassa: не удалось получить платёж %s: HTTP %s", ext_id, resp.status_code)
                continue
            data = resp.json()
            out[ext_id] = self.STATUS_MAP.get(data.get("status"), InvoiceState.PENDING)
        return out

    async def close(self) -> None:
        await self._http.aclose()
