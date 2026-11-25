"""
СКОЛЬЗЯЩАЯ ПРОВЕРКА: сравниваем варианты прогноза на нескольких датах отреза.

Зачем. Одна проверка 80/20 — это одна случайная точка. Сдвиньте дату отреза
на неделю, и «лучший» вариант может смениться. Поэтому повторяем ту же
проверку много раз, каждый раз сдвигая дату отреза на неделю вперёд:

    проверка 1: |обучение··········|тест 28 дн.|
    проверка 2: |обучение·················|тест 28 дн.|
    проверка 3: |обучение························|тест 28 дн.|
                                                  ...
    последняя:  |обучение·································|тест 28 дн.|  ← конец истории

Так и в жизни: продавец каждую неделю смотрит на свежий прогноз и решает,
что заказать. Каждая проверка — одна такая «неделя». Тесты частично
перекрываются, это нормально: так устроена любая скользящая проверка.

Как читать результат. Для каждого варианта печатаются:
  • средняя ошибка по всем проверкам;
  • в скольких проверках вариант оказался лучше текущей модели из forecast.py.
Вариант стоит переносить в forecast.py, только если он лучше и в среднем,
и хотя бы в 2/3 проверок. Если выигрывает то один, то другой — разница
случайна, и менять ничего не нужно. Если несколько вариантов почти равны,
берите самый простой.

Как добавить свой вариант. Напишите функцию прогноза (как forecast_with_trend
ниже) и добавьте строку в словарь VARIANTS. Если вариант победит — перенесите
его код в forecast_daily_demand() в forecast.py.

Запуск:
    python check_rolling.py

Сколько ждать: на 10 товарах — секунда, на 1000 товаров за год — около
полутора минут (12 проверок × 5 вариантов × 1000 товаров = 60 000 прогнозов).
"""

import pandas as pd

from forecast import load_data, split_by_product, forecast_daily_demand
from check_accuracy import evaluate_cutoff, calc_metrics

TEST_DAYS = 28        # длина каждого теста: на сколько дней вперёд проверяем прогноз
STEP_DAYS = 7         # на сколько сдвигаем дату отреза: «прогноз обновляют раз в неделю»
MIN_TRAIN_DAYS = 56   # сколько истории должно быть до самой первой даты отреза

# Сколько последних дат отреза проверять. 12 недель хватает для уверенного
# вывода, а самые свежие недели важнее старых: рынок меняется. Без ограничения
# год истории даёт ~40 проверок, и на 1000 товарах расчёт идёт минут пять.
MAX_CHECKS = 12

# Если средние ошибки двух вариантов отличаются меньше чем на столько
# процентных пунктов, считаем их равными: такая разница — случайный шум.
TIE_POINTS = 1.0


# ==========================================================================
# Варианты прогноза, которые сравниваем
# ==========================================================================

def forecast_with_trend(history, history_days=28):
    """
    Пример своего варианта: среднее плюс тренд.

    Делим период пополам и сравниваем половины. Если вторая половина продаёт
    больше первой, товар растёт, и к прогнозу добавляем половину прироста
    (осторожно, чтобы не переоценить рост). Возвращает те же три числа,
    что и forecast_daily_demand() — иначе остальной код не сможет его вызвать.
    """
    known_days = history.dropna().tail(history_days)
    n_days = len(known_days)
    if n_days == 0:
        return 0.0, 0.0, 0

    half = n_days // 2                          # // — деление без остатка: 28 // 2 = 14
    if half == 0:
        daily_mean = known_days.mean()          # всего 1 день — тренд не посчитать
    else:
        older = known_days.head(half).mean()    # средние продажи в первой половине периода
        recent = known_days.tail(half).mean()   # средние продажи во второй половине
        daily_mean = max(recent + (recent - older) / 2, 0)   # прогноз не может быть меньше 0

    daily_std = known_days.std() if n_days > 1 else 0.0
    return daily_mean, daily_std, n_days


# Название варианта → функция прогноза.
# lambda — короткая безымянная функция в одну строку. Запись
#     lambda history: forecast_daily_demand(history, history_days=7)
# значит «функция, которая берёт history и вызывает модель с окном 7 дней».
VARIANTS = {
    "7 дн.": lambda history: forecast_daily_demand(history, history_days=7),
    "14 дн.": lambda history: forecast_daily_demand(history, history_days=14),
    "28 дн.": lambda history: forecast_daily_demand(history, history_days=28),
    "56 дн.": lambda history: forecast_daily_demand(history, history_days=56),
    "28 дн. + тренд": forecast_with_trend,
}

# С каким вариантом сравниваем остальные: это то, что сейчас стоит в forecast.py.
# Перенесли победителя в forecast.py — поменяйте и эту строку.
BASELINE = "28 дн."


# ==========================================================================
# Проверка
# ==========================================================================

def quoted(names):
    """['7 дн.', '14 дн.'] → «7 дн.», «14 дн.»"""
    return ", ".join(f"«{name}»" for name in names)


def make_cutoffs(sales):
    """
    Даты отреза: от конца истории назад с шагом STEP_DAYS, пока до даты
    отреза остаётся хотя бы MIN_TRAIN_DAYS дней истории, но не больше MAX_CHECKS.
    Начинаем с конца, чтобы самые свежие данные проверялись всегда.
    """
    first_date = sales["date"].min()
    cutoff = sales["date"].max() - pd.Timedelta(days=TEST_DAYS)
    cutoffs = []
    while (cutoff - first_date).days + 1 >= MIN_TRAIN_DAYS and len(cutoffs) < MAX_CHECKS:
        cutoffs.append(cutoff)
        cutoff -= pd.Timedelta(days=STEP_DAYS)
    return sorted(cutoffs)   # от старых к новым — так удобнее читать таблицу


def main():
    products, sales = load_data()
    sales_by_sku = split_by_product(sales)
    cutoffs = make_cutoffs(sales)

    if len(cutoffs) == 0:
        raise SystemExit(f"Слишком короткая история: нужно хотя бы "
                         f"{MIN_TRAIN_DAYS + TEST_DAYS} дн. (обучение + тест).")

    print()
    print(f"Проверок: {len(cutoffs)}. Каждая: прогноз в дату отреза, тест на {TEST_DAYS} дн. вперёд, "
          f"шаг {STEP_DAYS} дн.")
    if len(cutoffs) < 5:
        print("  Проверок мало, выводы будут неуверенными. Выгрузите историю подлиннее (см. README).")
    print()

    # --- Считаем ошибку каждого варианта в каждой проверке ---
    # Результат — таблица: строки = даты отреза, колонки = варианты.
    rows = []
    # Прогресс: по точке на каждую проверку, чтобы было видно, что программа работает.
    # end="" — не переходить на новую строку, flush=True — показать сразу, а не потом.
    print("Считаю", end="", flush=True)
    for cutoff in cutoffs:
        print(".", end="", flush=True)
        row = {"Дата отреза": f"{cutoff:%d.%m.%Y}"}
        for name, forecast_fn in VARIANTS.items():
            table, _ = evaluate_cutoff(products, sales_by_sku, cutoff, TEST_DAYS, forecast_fn)
            wape_period, _, _ = calc_metrics(table)
            row[name] = round(wape_period, 1)
        rows.append(row)
    errors = pd.DataFrame(rows).set_index("Дата отреза")
    print(" готово\n")

    print("Ошибка за период (WAPE, %) в каждой проверке:")
    print(errors.reset_index().to_string(index=False))
    print()

    # --- Итог по каждому варианту ---
    n = len(errors)
    summary = []
    for name in VARIANTS:
        # Сравнение двух колонок даёт True/False в каждой строке;
        # .sum() считает True как 1, то есть число проверок, где вариант лучше.
        wins = (errors[name] < errors[BASELINE]).sum()
        summary.append({
            "Вариант": name,
            "Средняя ошибка, %": round(errors[name].mean(), 1),
            f"Лучше, чем «{BASELINE}»": "—" if name == BASELINE else f"{wins} из {n}",
            "_wins": wins,
        })
    summary = pd.DataFrame(summary).sort_values("Средняя ошибка, %")

    print(f"Итог по {n} проверкам (лучшие сверху):")
    print(summary.drop(columns="_wins").to_string(index=False))
    print()

    # --- Вывод: стоит ли что-то менять ---
    # Правило: вариант «устойчиво лучше» текущего, если он лучше и в среднем,
    # и хотя бы в 2/3 проверок. 2/3 — правило большого пальца: «большинство
    # с запасом», а не 51 на 49.
    baseline_error = errors[BASELINE].mean()
    winners = summary[(summary["Вариант"] != BASELINE)
                      & (summary["Средняя ошибка, %"] < baseline_error)
                      & (summary["_wins"] >= n * 2 / 3)]

    if winners.empty:
        print(f"Ни один вариант не лучше «{BASELINE}» устойчиво. Менять ничего не нужно.")
        return

    print(f"Устойчиво лучше «{BASELINE}»: {quoted(winners['Вариант'])}.")

    # Среди победителей ищем тех, кто почти не отличается от лучшего.
    best_error = winners["Средняя ошибка, %"].min()
    ties = winners[winners["Средняя ошибка, %"] - best_error < TIE_POINTS]
    if len(ties) > 1:
        print(f"Из них {quoted(ties['Вариант'])} отличаются меньше чем на {TIE_POINTS:g} п.п. "
              f"(процентного пункта) — это шум, считайте их равными.")
        print("Из равных выбирайте самый простой: его легче объяснить клиенту, и он реже ломается.")
    print("Победителя перенесите в forecast.py и запустите проверку на данных следующего клиента:")
    print("на других данных ответ может оказаться другим.")

if __name__ == "__main__":
    main()
