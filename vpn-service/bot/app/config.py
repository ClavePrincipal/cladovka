"""Настройки бота. Всё читается из переменных окружения / файла .env."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from typing_extensions import Annotated


@dataclass(frozen=True)
class Tariff:
    days: int
    price_rub: Decimal

    @property
    def code(self) -> str:
        return f"d{self.days}"

    @property
    def title(self) -> str:
        if self.days % 30 == 0:
            months = self.days // 30
            word = _plural(months, "месяц", "месяца", "месяцев")
            return f"{months} {word}"
        return f"{self.days} {_plural(self.days, 'день', 'дня', 'дней')}"


def _plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(n) % 100
    if 11 <= n <= 19:
        return many
    n %= 10
    if n == 1:
        return one
    if 2 <= n <= 4:
        return few
    return many


def parse_tariffs(raw: str) -> list[Tariff]:
    """'30:199,90:549' -> [Tariff(30, 199), Tariff(90, 549)]"""
    tariffs: list[Tariff] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        days_s, _, price_s = chunk.partition(":")
        days, price = int(days_s), Decimal(price_s)
        if days <= 0 or price <= 0:
            raise ValueError(f"Неверный тариф: {chunk!r}")
        tariffs.append(Tariff(days=days, price_rub=price))
    if not tariffs:
        raise ValueError("TARIFFS пуст")
    if len({t.days for t in tariffs}) != len(tariffs):
        raise ValueError("В TARIFFS повторяется срок")
    return sorted(tariffs, key=lambda t: t.days)


def _split_csv(value: object) -> object:
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Telegram ---
    bot_token: str
    admin_ids: Annotated[list[int], NoDecode] = Field(default_factory=list)
    support_username: str = ""  # без @
    project_name: str = "MyVPN"
    offer_url: str = ""  # ссылка на публичную оферту / условия
    timezone: str = "Europe/Moscow"  # в каком поясе показывать даты

    # --- База данных ---
    database_url: str = "sqlite+aiosqlite:///data/bot.db"

    # --- Remnawave ---
    remnawave_url: str  # https://panel.example.com
    remnawave_token: str
    remnawave_squad_uuids: Annotated[list[str], NoDecode] = Field(default_factory=list)
    remnawave_caddy_token: str = ""  # если панель закрыта Caddy с X-Api-Key
    user_prefix: str = "tg"
    hwid_device_limit: int = 3  # 0 = без ограничения
    traffic_limit_gb: int = 0  # 0 = безлимит
    user_tag: str = "BOT"

    # --- Тарифы и бонусы ---
    tariffs: str = "30:199,90:549,180:999,360:1790"
    trial_days: int = 3  # 0 = выключить пробный период
    referral_bonus_days: int = 7  # 0 = выключить рефералку

    # --- CryptoBot (Crypto Pay API) ---
    cryptobot_token: str = ""
    cryptobot_testnet: bool = False
    cryptobot_assets: str = "USDT,TON,BTC"

    # --- ЮKassa ---
    yookassa_shop_id: str = ""
    yookassa_secret_key: str = ""
    yookassa_return_url: str = ""  # куда вернуть после оплаты, напр. https://t.me/your_bot
    yookassa_receipt_email: str = ""  # если нужен чек по 54-ФЗ — email для чека

    # --- Фоновые задачи ---
    payment_check_interval: int = 20  # сек
    payment_ttl_minutes: int = 60

    @field_validator("admin_ids", "remnawave_squad_uuids", mode="before")
    @classmethod
    def _csv(cls, v: object) -> object:
        return _split_csv(v)

    @field_validator("tariffs")
    @classmethod
    def _validate_tariffs(cls, v: str) -> str:
        parse_tariffs(v)
        return v

    @field_validator("remnawave_url")
    @classmethod
    def _strip_url(cls, v: str) -> str:
        return v.rstrip("/")

    @property
    def tariff_list(self) -> list[Tariff]:
        return parse_tariffs(self.tariffs)

    def tariff_by_code(self, code: str) -> Tariff | None:
        return next((t for t in self.tariff_list if t.code == code), None)

    @property
    def cryptobot_enabled(self) -> bool:
        return bool(self.cryptobot_token)

    @property
    def yookassa_enabled(self) -> bool:
        return bool(self.yookassa_shop_id and self.yookassa_secret_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
