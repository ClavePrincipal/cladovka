"""
ГЕНЕРАТОР ДЕМО-ДАННЫХ: придуманный магазин на маркетплейсе.

Зачем он нужен:
    Чтобы запустить прогноз и посмотреть результат, не имея своего магазина.
    Когда появятся настоящие данные продавца, этот файл больше не нужен:
    просто положите его выгрузку в папку data/ в том же формате (см. README.md).

Что создаёт:
    data/products.csv — справочник товаров (цена, себестоимость, комиссия...)
    data/sales.csv    — продажи, остатки и реклама за каждый день

Запуск:
    python make_demo_data.py

Как устроено:
    Каждый товар — отдельный «сценарий», чтобы в отчёте было видно все ситуации:
    стабильный спрос, рост, падение, дефицит, излишек, убыток из-за рекламы, новинка.
    Затем мы «проживаем» 120 дней: каждый день покупатели хотят купить случайное
    число штук, а продать можно не больше, чем есть на складе.
"""

from pathlib import Path

import numpy as np
import pandas as pd

DAYS = 120                 # сколько дней истории придумываем
END_DATE = "2026-11-23"    # последний день данных («вчера»)
SEED = 5                   # «зерно» случайности: с ним при каждом запуске получаются одни и те же данные

# --------------------------------------------------------------------------
# Описание товаров.
#
# Поля, которые попадут в products.csv (это то, что знает продавец):
#   sku             — артикул
#   name            — название
#   price           — цена продажи покупателю, за 1 шт
#   cost            — себестоимость: сколько вы платите поставщику за 1 шт
#   commission_pct  — комиссия маркетплейса, % от цены
#   logistics       — логистика маркетплейса за 1 шт (доставка до покупателя)
#   lead_time_days  — сколько дней идёт поставка: от заказа у поставщика до приёмки на складе маркетплейса
#   in_transit      — сколько штук уже заказано и едет на склад
#
# Поля только для симуляции (их у реального продавца нет, это «правда», которую мы прячем):
#   demand          — (спрос в первый день, спрос в последний день), шт/день; между ними — плавно
#   start_stock     — остаток на складе в первый день
#   deliveries      — {номер дня: сколько штук приехало}
#   ads             — примерный расход на рекламу в день
#   first_day       — с какого дня товар начали продавать (для новинки)
# --------------------------------------------------------------------------
PRODUCTS = [
    # Обычный товар: спрос ровный, поставки приходят вовремя.
    {"sku": "A001", "name": "Чехол для телефона", "price": 590, "cost": 150,
     "commission_pct": 19, "logistics": 70, "lead_time_days": 14, "in_transit": 0,
     "demand": (12, 12), "start_stock": 450, "deliveries": {35: 450, 70: 450, 100: 700}, "ads": 400},

    # Был дефицит недавно: поставка опоздала, ~10 дней товара не было.
    {"sku": "B002", "name": "Зарядка USB-C 20W", "price": 990, "cost": 380,
     "commission_pct": 17, "logistics": 80, "lead_time_days": 14, "in_transit": 0,
     "demand": (8, 8), "start_stock": 300, "deliveries": {30: 300, 65: 200, 108: 400}, "ads": 500},

    # Спрос растёт: товар «выстреливает».
    {"sku": "C003", "name": "Термокружка 450 мл", "price": 1290, "cost": 420,
     "commission_pct": 18, "logistics": 110, "lead_time_days": 21, "in_transit": 100,
     "demand": (3, 12), "start_stock": 250, "deliveries": {40: 300, 75: 300, 100: 300}, "ads": 600},

    # Сезонный товар перед Новым годом: спрос резко растёт, а остаток маленький.
    {"sku": "D004", "name": "Гирлянда светодиодная 10 м", "price": 890, "cost": 260,
     "commission_pct": 20, "logistics": 90, "lead_time_days": 21, "in_transit": 0,
     "demand": (1, 25), "start_stock": 500, "deliveries": {60: 600, 95: 450}, "ads": 300},

    # Спрос падает: товар выходит из моды, а на складе его много.
    {"sku": "E005", "name": "Коврик для йоги", "price": 1490, "cost": 520,
     "commission_pct": 18, "logistics": 160, "lead_time_days": 14, "in_transit": 0,
     "demand": (10, 4), "start_stock": 600, "deliveries": {60: 400}, "ads": 400},

    # Продаётся неплохо, но реклама съедает всю прибыль.
    {"sku": "F006", "name": "Беспроводные наушники", "price": 2490, "cost": 1300,
     "commission_pct": 25, "logistics": 150, "lead_time_days": 30, "in_transit": 0,
     "demand": (3, 3), "start_stock": 600, "deliveries": {}, "ads": 1200},

    # Продаётся редко: в некоторые дни 0, в некоторые 2–3 штуки.
    {"sku": "G007", "name": "Набор кистей для макияжа", "price": 690, "cost": 180,
     "commission_pct": 20, "logistics": 60, "lead_time_days": 14, "in_transit": 0,
     "demand": (0.8, 0.8), "start_stock": 160, "deliveries": {}, "ads": 50},

    # Закончился прямо сейчас: товара нет уже больше недели.
    {"sku": "H008", "name": "Органайзер для ящиков", "price": 790, "cost": 210,
     "commission_pct": 19, "logistics": 90, "lead_time_days": 14, "in_transit": 0,
     "demand": (6, 6), "start_stock": 250, "deliveries": {40: 250, 75: 180}, "ads": 300},

    # Новинка: продаётся всего 12 дней, истории мало.
    {"sku": "I009", "name": "Настольная лампа (новинка)", "price": 1990, "cost": 700,
     "commission_pct": 18, "logistics": 140, "lead_time_days": 21, "in_transit": 0,
     "demand": (5, 5), "start_stock": 150, "deliveries": {}, "ads": 800, "first_day": 108},

    # Излишек: закупили слишком много, деньги заморожены на складе.
    {"sku": "J010", "name": "Бутылка для воды 750 мл", "price": 690, "cost": 190,
     "commission_pct": 19, "logistics": 70, "lead_time_days": 14, "in_transit": 0,
     "demand": (4, 4), "start_stock": 1500, "deliveries": {}, "ads": 200},
]

# Какие поля сохранить в справочник товаров (остальные — только для симуляции).
CATALOG_COLUMNS = ["sku", "name", "price", "cost", "commission_pct",
                   "logistics", "lead_time_days", "in_transit"]


def simulate_product(product, dates, rng):
    """«Проживает» все дни для одного товара и возвращает список строк продаж."""
    rows = []
    stock = product["start_stock"]
    first_demand, last_demand = product["demand"]

    for day, date in enumerate(dates):
        # Новинку начали продавать не с первого дня — до этого строк нет.
        if day < product.get("first_day", 0):
            continue

        # 1. Утром приезжает поставка (если она запланирована на этот день).
        stock += product["deliveries"].get(day, 0)

        # 2. Средний спрос в этот день: плавно меняется от первого значения к последнему.
        mean_demand = first_demand + (last_demand - first_demand) * day / (DAYS - 1)
        if date.dayofweek >= 5:          # суббота и воскресенье: покупают чуть больше
            mean_demand *= 1.3

        # 3. Реальный спрос случаен. Распределение Пуассона — стандартный выбор
        #    для «сколько штук купили за день»: целые числа, не меньше нуля.
        demand = rng.poisson(mean_demand)

        # 4. Продать можно не больше, чем есть на складе.
        #    Если хотели 10, а осталось 3 — продали 3, остальные 7 покупателей ушли к конкуренту.
        sold = min(demand, stock)

        # 5. Реклама: если товара нет, продавец её отключает.
        ad_spend = round(product["ads"] * rng.uniform(0.7, 1.3)) if stock > 0 else 0

        stock -= sold
        rows.append({
            "date": date.strftime("%Y-%m-%d"),
            "sku": product["sku"],
            "sold": sold,          # продано за день, шт
            "stock": stock,        # остаток на конец дня, шт
            "ad_spend": ad_spend,  # расход на рекламу за день
        })
    return rows


def main():
    rng = np.random.default_rng(SEED)   # генератор случайных чисел
    dates = pd.date_range(end=END_DATE, periods=DAYS, freq="D")

    all_rows = []
    for product in PRODUCTS:
        all_rows.extend(simulate_product(product, dates, rng))

    data_dir = Path(__file__).parent / "data"
    data_dir.mkdir(exist_ok=True)

    products = pd.DataFrame(PRODUCTS)[CATALOG_COLUMNS]
    sales = pd.DataFrame(all_rows)

    # utf-8-sig — кодировка, в которой Excel правильно показывает русские буквы.
    products.to_csv(data_dir / "products.csv", index=False, encoding="utf-8-sig")
    sales.to_csv(data_dir / "sales.csv", index=False, encoding="utf-8-sig")

    print(f"Готово: {len(products)} товаров, {len(sales)} строк продаж.")
    print(f"Файлы: {data_dir / 'products.csv'} и {data_dir / 'sales.csv'}")


# Эта строка значит: «запусти main(), только если файл запустили напрямую».
# Если же другой файл сделает import make_demo_data, то main() сам не запустится.
if __name__ == "__main__":
    main()
