from __future__ import annotations

import itertools
import os
import sys
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings  # noqa: E402
from app.db import Database  # noqa: E402
from app.payments import CreatedInvoice, InvoiceState  # noqa: E402
from app.remnawave import PanelUser, RemnawaveError  # noqa: E402
from app.service import VpnService  # noqa: E402


class FakePanel:
    """In-memory имитация панели Remnawave."""

    def __init__(self) -> None:
        self.users: dict[int, PanelUser] = {}
        self.fail_next = False
        self.calls: list[str] = []
        self._ids = itertools.count(1)

    def _check_fail(self) -> None:
        if self.fail_next:
            self.fail_next = False
            raise RemnawaveError(500, "boom")

    async def get_user_by_id(self, user_id: int) -> PanelUser | None:
        return self.users.get(user_id)

    async def get_user_by_username(self, username: str) -> PanelUser | None:
        return next((u for u in self.users.values() if u.username == username), None)

    async def create_user(self, *, username: str, expire_at: datetime, telegram_id=None, **kw) -> PanelUser:
        self._check_fail()
        self.calls.append(f"create:{username}")
        uid = next(self._ids)
        u = PanelUser(
            id=uid,
            username=username,
            status="ACTIVE",
            expire_at=expire_at,
            subscription_url=f"https://sub.example.com/sub{uid}",
            used_traffic_bytes=0,
            traffic_limit_bytes=0,
            telegram_id=telegram_id,
        )
        self.users[uid] = u
        return u

    async def update_user(self, uid: int, **fields) -> PanelUser:
        self._check_fail()
        self.calls.append(f"update:{uid}")
        # Правила валидации панели v3 (PATCH /api/users)
        assert fields.get("status", "ACTIVE") in ("ACTIVE", "DISABLED"), fields
        if "expire_at" in fields:
            assert fields["expire_at"] > datetime.now(timezone.utc), "expireAt в прошлом"
        u = self.users[uid]
        u = replace(u, expire_at=fields.get("expire_at", u.expire_at), status=fields.get("status", u.status))
        self.users[uid] = u
        return u

    async def get_internal_squad_uuids(self) -> list[str]:
        return ["squad-1"]


class FakeProvider:
    name = "fake"
    title = "Fake"

    def __init__(self) -> None:
        self.states: dict[str, str] = {}
        self.counter = 0

    async def create_invoice(self, *, amount: Decimal, description: str, payload: str) -> CreatedInvoice:
        self.counter += 1
        ext = f"inv{self.counter}"
        self.states[ext] = InvoiceState.PENDING
        return CreatedInvoice(external_id=ext, pay_url=f"https://pay.example.com/{ext}")

    async def get_statuses(self, external_ids: list[str]) -> dict[str, str]:
        return {e: self.states[e] for e in external_ids if e in self.states}

    async def close(self) -> None:
        pass


@pytest.fixture
def settings() -> Settings:
    return Settings(
        bot_token="123:abc",
        remnawave_url="https://panel.example.com/",
        remnawave_token="tok",
        admin_ids="1,2",  # type: ignore[arg-type]
        tariffs="30:199,90:549",
        trial_days=3,
        referral_bonus_days=7,
        _env_file=None,  # type: ignore[call-arg]
    )


@pytest.fixture
async def db(tmp_path):
    database = Database(f"sqlite+aiosqlite:///{tmp_path}/test.db")
    await database.create_all()
    yield database
    await database.close()


@pytest.fixture
def panel() -> FakePanel:
    return FakePanel()


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def service(db, panel, settings, provider) -> VpnService:
    return VpnService(db, panel, settings, {"fake": provider})  # type: ignore[arg-type]
