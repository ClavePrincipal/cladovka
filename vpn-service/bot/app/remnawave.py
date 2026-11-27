"""Минимальный клиент REST API панели Remnawave (сверено с контрактом SDK remnawave 2.8.x).

Используем только то, что нужно боту: создать/обновить/получить пользователя и список сквадов.
Все ответы панели приходят в обёртке {"response": ...}.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx

log = logging.getLogger(__name__)


class RemnawaveError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"Remnawave API {status}: {message}")
        self.status = status


@dataclass
class PanelUser:
    uuid: str
    username: str
    status: str
    expire_at: datetime
    subscription_url: str
    used_traffic_bytes: float
    traffic_limit_bytes: float
    telegram_id: int | None

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> "PanelUser":
        traffic = data.get("userTraffic") or {}
        return cls(
            uuid=data["uuid"],
            username=data["username"],
            status=data.get("status", "ACTIVE"),
            expire_at=_parse_dt(data["expireAt"]),
            subscription_url=data["subscriptionUrl"],
            used_traffic_bytes=float(traffic.get("usedTrafficBytes", data.get("usedTrafficBytes", 0)) or 0),
            traffic_limit_bytes=float(data.get("trafficLimitBytes") or 0),
            telegram_id=data.get("telegramId"),
        )


def _parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RemnawaveClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        caddy_token: str = "",
        timeout: float = 15.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        base_url = base_url.rstrip("/")
        if not base_url.endswith("/api"):
            base_url += "/api"
        headers = {"Authorization": token if token.startswith("Bearer ") else f"Bearer {token}"}
        if caddy_token:
            headers["X-Api-Key"] = caddy_token
        if base_url.startswith("http://"):
            # Панель без reverse-proxy (напр. http://remnawave:3000 в docker-сети) требует эти заголовки
            headers["X-Forwarded-Proto"] = "https"
            headers["X-Forwarded-For"] = "127.0.0.1"
        self._http = httpx.AsyncClient(base_url=base_url, headers=headers, timeout=timeout, transport=transport)

    async def close(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = await self._http.request(method, path, **kwargs)
        if resp.status_code >= 400:
            try:
                message = resp.json().get("message", resp.text)
            except ValueError:
                message = resp.text
            raise RemnawaveError(resp.status_code, str(message)[:500])
        data = resp.json()
        return data.get("response", data) if isinstance(data, dict) else data

    # --- users ---

    async def get_user_by_username(self, username: str) -> PanelUser | None:
        try:
            data = await self._request("GET", f"/users/by-username/{username}")
        except RemnawaveError as e:
            if e.status == 404:
                return None
            raise
        return PanelUser.from_api(data)

    async def get_user_by_uuid(self, uuid: str) -> PanelUser | None:
        try:
            data = await self._request("GET", f"/users/{uuid}")
        except RemnawaveError as e:
            if e.status == 404:
                return None
            raise
        return PanelUser.from_api(data)

    async def create_user(
        self,
        *,
        username: str,
        expire_at: datetime,
        telegram_id: int | None = None,
        squad_uuids: list[str] | None = None,
        hwid_device_limit: int | None = None,
        traffic_limit_bytes: int = 0,
        description: str | None = None,
        tag: str | None = None,
    ) -> PanelUser:
        body: dict[str, Any] = {
            "username": username,
            "status": "ACTIVE",
            "expireAt": _iso(expire_at),
            "trafficLimitBytes": traffic_limit_bytes,
            "trafficLimitStrategy": "MONTH" if traffic_limit_bytes else "NO_RESET",
        }
        if telegram_id is not None:
            body["telegramId"] = telegram_id
        if squad_uuids:
            body["activeInternalSquads"] = squad_uuids
        if hwid_device_limit:
            body["hwidDeviceLimit"] = hwid_device_limit
        if description:
            body["description"] = description[:500]
        if tag:
            body["tag"] = tag
        return PanelUser.from_api(await self._request("POST", "/users", json=body))

    async def update_user(self, uuid: str, **fields: Any) -> PanelUser:
        body: dict[str, Any] = {"uuid": uuid}
        mapping = {
            "expire_at": "expireAt",
            "status": "status",
            "hwid_device_limit": "hwidDeviceLimit",
            "traffic_limit_bytes": "trafficLimitBytes",
            "squad_uuids": "activeInternalSquads",
            "telegram_id": "telegramId",
            "description": "description",
        }
        for key, value in fields.items():
            if key not in mapping:
                raise TypeError(f"Неизвестное поле: {key}")
            body[mapping[key]] = _iso(value) if isinstance(value, datetime) else value
        return PanelUser.from_api(await self._request("PATCH", "/users", json=body))

    async def revoke_subscription(self, uuid: str) -> PanelUser:
        """Перевыпустить ссылку подписки (если пользователь её «слил»)."""
        return PanelUser.from_api(await self._request("POST", f"/users/{uuid}/actions/revoke", json={}))

    # --- squads ---

    async def get_internal_squad_uuids(self) -> list[str]:
        data = await self._request("GET", "/internal-squads")
        return [s["uuid"] for s in data.get("internalSquads", [])]
