"""
ПРОВЕРКА ТОЧНОСТИ ПРОГНОЗА (по-научному — «бэктест»).

Идея: представим, что сегодня — не сегодня, а 28 дней назад.
  1. Отрезаем последние 28 дней: модель их «не видит».
  2. Делаем прогноз по оставшимся данным, как будто это реальная жизнь.
  3. Сравниваем прогноз с тем, что на самом деле продалось за эти 28 дней.

Так мы честно узнаём, насколько ошибается прогноз, ДО того, как клиент потратит
по нему деньги на закупку. И главное: если вы поменяете функцию
forecast_daily_demand() в forecast.py, этот скрипт сразу покажет,
стало лучше или хуже.

Запуск:
    python check_accuracy.py
"""

import pandas as pd

# Берём готовые функции из forecast.py, чтобы проверять ровно ту же модель,
# по которой строится план закупок. Копировать код сюда нельзя: тогда
# можно случайно проверять одно, а использовать другое.
from forecast import load_data, make_history, forecast_daily_demand

TEST_DAYS = 28   # сколько последних дней «прячем» от модели


def main():
    products, sales = load_data()

    # Дата «отреза»: всё, что до неё включительно, модель видит, всё, что после, — нет.
    cutoff = sales["date"].max() - pd.Timedelta(days=TEST_DAYS)
    print(f"Делаем вид, что сегодня {cutoff:%d.%m.%Y}, и прогнозируем следующие {TEST_DAYS} дней.\n")

    rows = []
    for _, product in products.iterrows():
        product_sales = sales[sales["sku"] == product["sku"]]
        past = product_sales[product_sales["date"] <= cutoff]     # то, что модель знает
        future = product_sales[product_sales["date"] > cutoff]    # то, что спрятали

        daily, _, n_days = forecast_daily_demand(make_history(past))
        if n_days == 0:
            print(f"  {product['name']}: до {cutoff:%d.%m.%Y} продаж не было, пропускаем.")
            continue

        # Сравниваем только дни, когда товар был в наличии. В дни дефицита
        # продажи были бы больше, если бы товар был, — это не ошибка прогноза.
        future_in_stock = future[future["stock"] > 0]
        forecast_total = daily * len(future_in_stock)
        actual_total = future_in_stock["sold"].sum()

        rows.append({
            "Товар": product["name"],
            "Прогноз, шт": round(forecast_total),
            "Факт, шт": actual_total,
            "Ошибка, шт": round(forecast_total - actual_total),
            # Плюс — прогноз завысил (закупили бы лишнее), минус — занизил (риск дефицита).
            "Ошибка, %": round((forecast_total - actual_total) / actual_total * 100)
                         if actual_total > 0 else None,
        })

    table = pd.DataFrame(rows)
    print(table.to_string(index=False))

    # --- Итоговые метрики по всем товарам ---
    errors = table["Прогноз, шт"] - table["Факт, шт"]
    total_actual = table["Факт, шт"].sum()

    # WAPE (Weighted Absolute Percentage Error) — главная метрика точности.
    # Складываем все промахи без знака (и «перелёты», и «недолёты») и делим
    # на все реальные продажи. Товары с большими продажами весят больше:
    # ошибка в 50% на товаре, который продаётся раз в неделю, почти не важна.
    wape = errors.abs().sum() / total_actual * 100

    # Смещение (bias): то же самое, но со знаком. Показывает, в какую сторону
    # прогноз ошибается в среднем. Хороший прогноз ошибается в обе стороны поровну,
    # и смещение близко к 0.
    bias = errors.sum() / total_actual * 100

    print()
    print(f"Средняя ошибка (WAPE): {wape:.1f}%   ← чем меньше, тем лучше")
    print(f"Смещение:              {bias:+.1f}%   ← плюс: завышает, минус: занижает, лучше всего около 0")
    print()
    print("Смотрите на товары с самой большой ошибкой: у них обычно рост, падение или сезонность.")
    print("Попробуйте улучшить forecast_daily_demand() в forecast.py и запустите проверку снова.")


if __name__ == "__main__":
    main()
