"""Analysis metrics and scoring formulas for the study tracker.

This module is deliberately independent from Flask and the browser.  It consumes
the existing JSON data shape and returns JSON-serializable dictionaries for the
future analysis page.

The score is unbounded and uses a fixed internal weighting policy. A configured
standard performance evaluates to 100; better or worse performance moves the
score above or below 100 without a ceiling.
"""

from __future__ import annotations

import copy
import math
from datetime import date, timedelta
from typing import Any


SCHEMA_VERSION = 3
DEFAULT_SMOOTHING_MINUTES = 5.0
DEFAULT_SCALE_TOLERANCE = 0.25
DEFAULT_EVIDENCE_SATURATION = 2.0
DEFAULT_STABILITY_MIN_DAYS = 3


# This is the only configuration contract exposed to the user. The scoring
# policy is deliberately kept server-side so clients cannot tune the model.
DEFAULT_CONFIG: dict[str, Any] = {
    "schemaVersion": SCHEMA_VERSION,
    "standardDay": {
        "awakeMinutes": None,
        "totalClockMinutes": None,
        "nominalMinutes": None,
        "actualMinutes": None,
        "restMinutes": None,
        "unavailableMinutes": None,
        "specialStudyClockMinutes": None,
        "specialStudyActualMinutes": None,
        "taskMinutes": None,
    },
    "taskStandards": [],
}

INTERNAL_SCORE_POLICY: dict[str, Any] = {
    "smoothingMinutes": DEFAULT_SMOOTHING_MINUTES,
    "scaleTolerance": DEFAULT_SCALE_TOLERANCE,
    "dayWeights": {
        "ordinaryActual": 15.0,
        "nominalScale": 5.0,
        "nominalGap": 10.0,
        "awakeClockGap": 10.0,
        "rest": 5.0,
        "unavailable": 10.0,
        "specialStudy": 10.0,
        "taskVolume": 10.0,
        "taskReconciliation": 10.0,
        "focusEfficiency": 15.0,
    },
    "taskFactorWeight": 10.0,
    "evidence": {
        "saturation": DEFAULT_EVIDENCE_SATURATION,
    },
    "stability": {
        "minimumComparableDays": DEFAULT_STABILITY_MIN_DAYS,
        "cvTolerance": 0.35,
        "jumpTolerance": 0.75,
        "strength": 0.45,
        "cvInfluence": 0.35,
        "jumpInfluence": 0.65,
        "metricWeights": {
            "actualMinutes": 0.4,
            "taskMinutes": 0.3,
            "dailyScore": 0.3,
        },
    },
}


def default_config() -> dict[str, Any]:
    """Return a fresh copy suitable for an API response or a new save."""

    return copy.deepcopy(DEFAULT_CONFIG)


def normalize_config(value: Any) -> dict[str, Any]:
    """Merge a user config with defaults and discard malformed containers.

    Numeric validation is intentionally conservative here.  The calculation
    layer still reports unavailable factors instead of treating bad input as a
    zero-performing day.
    """

    source = value if isinstance(value, dict) else {}
    result = default_config()
    result["schemaVersion"] = SCHEMA_VERSION

    standard = source.get("standardDay")
    if isinstance(standard, dict):
        for key in result["standardDay"]:
            value_number = standard.get(key)
            if value_number is None or value_number == "":
                result["standardDay"][key] = None
                continue
            try:
                number = float(value_number)
            except (TypeError, ValueError):
                continue
            if math.isfinite(number) and number >= 0:
                result["standardDay"][key] = number

        # Earlier cards stored special-study targets as shares. Convert them
        # back to the minute-based fields used by the current score model.
        legacy_ratios = (
            ("specialStudyClockMinutes", "specialStudyClockMaxRatio", "totalClockMinutes"),
            ("specialStudyActualMinutes", "specialStudyActualMaxRatio", "actualMinutes"),
        )
        for target_key, ratio_key, total_key in legacy_ratios:
            if result["standardDay"][target_key] is not None:
                continue
            try:
                ratio = float(standard.get(ratio_key))
                total = float(result["standardDay"].get(total_key))
            except (TypeError, ValueError):
                continue
            if math.isfinite(ratio) and math.isfinite(total) and 0 <= ratio <= 1 and total >= 0:
                result["standardDay"][target_key] = ratio * total

        special_clock = result["standardDay"]["specialStudyClockMinutes"]
        special_actual = result["standardDay"]["specialStudyActualMinutes"]
        if special_clock is not None and special_actual is not None and special_actual > special_clock:
            result["standardDay"]["specialStudyActualMinutes"] = special_clock

        # Keep saved cards within the same duration relationships enforced by
        # the standard-day form. This also protects imported or older cards
        # that bypass the browser input constraints.
        standard_day = result["standardDay"]
        actual = standard_day["actualMinutes"]
        nominal = standard_day["nominalMinutes"]
        if actual is not None and nominal is not None and actual > nominal:
            standard_day["nominalMinutes"] = actual

        clock = standard_day["totalClockMinutes"]
        rest = standard_day["restMinutes"]
        nominal = standard_day["nominalMinutes"]
        if clock is not None and nominal is not None and rest is not None and nominal + rest > clock:
            standard_day["totalClockMinutes"] = nominal + rest

        task = standard_day["taskMinutes"]
        actual = standard_day["actualMinutes"]
        special_actual = standard_day["specialStudyActualMinutes"]
        if task is not None and actual is not None and special_actual is not None:
            standard_day["taskMinutes"] = min(task, actual + special_actual)

        awake = standard_day["awakeMinutes"]
        clock = standard_day["totalClockMinutes"]
        unavailable = standard_day["unavailableMinutes"]
        special_clock = standard_day["specialStudyClockMinutes"]
        if awake is not None and clock is not None and unavailable is not None and special_clock is not None:
            standard_day["awakeMinutes"] = max(awake, clock + unavailable + special_clock)

    task_standards = source.get("taskStandards")
    if isinstance(task_standards, list):
        normalized_tasks = []
        for item in task_standards:
            if not isinstance(item, dict):
                continue
            key = str(item.get("templateId") or item.get("activityType") or "").strip()
            if not key:
                continue
            entry = {
                "templateId": str(item.get("templateId") or "").strip(),
                "activityType": str(item.get("activityType") or "").strip(),
                "chapterMinutesPerUnit": _finite_nonnegative(item.get("chapterMinutesPerUnit")),
                "chapterScorePerUnit": _finite_nonnegative(item.get("chapterScorePerUnit")),
                "chapterMaxScore": _finite_nonnegative(item.get("chapterMaxScore")),
                "quantityPerMinute": _finite_nonnegative(item.get("quantityPerMinute")),
                "pureTimeMaxRatio": _finite_nonnegative(item.get("pureTimeMaxRatio")),
                "accuracy": _finite_ratio(item.get("accuracy")),
                "scoreRate": _finite_ratio(item.get("scoreRate")),
                "enabled": item.get("enabled", True) is not False,
            }
            normalized_tasks.append(entry)
        result["taskStandards"] = normalized_tasks

    return result


def _finite_nonnegative(value: Any, fallback: float | None = None) -> float | None:
    if value is None or value == "":
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) and number >= 0 else fallback


def _finite_ratio(value: Any) -> float | None:
    number = _finite_nonnegative(value)
    return number if number is not None and number <= 1 else None


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _parse_time(value: Any) -> int | None:
    try:
        hour_text, minute_text = str(value or "").split(":", 1)
        hour = int(hour_text)
        minute = int(minute_text)
    except (TypeError, ValueError):
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute


def _sleep_adjusted_minutes(value: Any) -> int | None:
    """Match the existing frontend's noon/midnight input compatibility rule."""

    minutes = _parse_time(value)
    if minutes is not None and 720 <= minutes < 780:
        return minutes - 720
    return minutes


def session_minutes(session: dict[str, Any]) -> int:
    start = _parse_time(session.get("startTime"))
    end = _parse_time(session.get("endTime"))
    if start is None or end is None or start == end:
        return 0
    return end - start if end > start else 1440 - start + end


def _is_unavailable(session: dict[str, Any]) -> bool:
    return session.get("type") == "special"


def _is_special_study(session: dict[str, Any]) -> bool:
    return session.get("type") == "special-study"


def _awake_minutes(day: dict[str, Any]) -> float | None:
    wake = _parse_time(day.get("wakeTime"))
    sleep = _sleep_adjusted_minutes(day.get("sleepTime"))
    if wake is None or sleep is None:
        return None
    result = sleep - wake
    if result <= 0:
        result += 1440
    return float(result)


def _template_for_task(task: dict[str, Any], templates: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    template_id = str(task.get("templateId") or "")
    if template_id and template_id in templates:
        return templates[template_id]
    activity = str(task.get("activityType") or "").strip()
    for template in templates.values():
        if str(template.get("activityType") or "").strip() == activity:
            return template
    return None


def _task_flags(task: dict[str, Any], template: dict[str, Any] | None) -> tuple[bool, bool, bool, bool]:
    named = bool(template and (template.get("namedItemEnabled") or template.get("ordinalEnabled")))
    named = named or bool(task.get("namedItemAllocations"))
    if (
        template
        and template.get("chapterQuantityOnly")
        and template.get("quantityEnabled")
        and (template.get("namedItemEnabled") or template.get("ordinalEnabled"))
    ):
        named = False
    quantity = bool(template and template.get("quantityEnabled"))
    quantity = quantity or task.get("quantity") not in (None, "")
    accuracy = bool(template and template.get("quantityEnabled") and template.get("accuracyEnabled"))
    score = bool(template and (template.get("scoreEnabled") or (
        template.get("chapterScoringEnabled")
        and (template.get("namedItemEnabled") or template.get("ordinalEnabled"))
        and not template.get("quantityEnabled")
    )))
    return named, quantity, accuracy, score


def _recorded_score(task: dict[str, Any], template: dict[str, Any] | None) -> tuple[float, float] | None:
    score = _finite_nonnegative(task.get("score"))
    per_chapter_max = _finite_nonnegative((template or {}).get("scoreMax"))
    if per_chapter_max is None:
        per_chapter_max = _finite_nonnegative((template or {}).get("chapterMaxScore"))
    scored_items = [
        item for item in (task.get("namedItemAllocations") or [])
        if isinstance(item, dict) and item.get("completed")
        and _finite_nonnegative(item.get("score")) is not None
    ]
    # Older chapter-only records contain individual scores without a task total.
    if score is None and scored_items and per_chapter_max is not None and per_chapter_max > 0:
        scores = [_finite_nonnegative(item.get("score")) for item in scored_items]
        if any(value > per_chapter_max for value in scores):
            return None
        return sum(scores), per_chapter_max * len(scores)
    # Persisted totals retain the scoring scope of historical records.
    maximum = _finite_nonnegative(task.get("scoreMax"))
    if maximum is None:
        completed = sum(1 for item in (task.get("namedItemAllocations") or []) if isinstance(item, dict) and item.get("completed"))
        maximum = per_chapter_max * completed if per_chapter_max is not None and completed > 0 else per_chapter_max
    if score is None or maximum is None or maximum <= 0 or score > maximum:
        return None
    return score, maximum


def _recorded_wrong_count(task: dict[str, Any], quantity: float) -> float | None:
    """Return an explicitly recorded valid wrong count, never an inferred zero."""

    value = task.get("wrongCount")
    if value in (None, ""):
        return None
    try:
        wrong = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(wrong) or wrong < 0 or wrong > quantity:
        return None
    return wrong


def _finalize_template_metrics(template_metrics: dict[str, dict[str, Any]], total_task_minutes: Any) -> None:
    """Derive comparable per-template efficiency metrics for any score scope."""

    total_minutes = _number(total_task_minutes)
    for row in template_metrics.values():
        minutes = _number(row.get("minutes"))
        completed = _number(row.get("completedChapters"))
        scored = _number(row.get("scoredChapters"))
        quantity = _number(row.get("quantity"))
        accuracy_quantity = _number(row.get("accuracyQuantity"))
        row["chapterMinutesPerCompleted"] = row["chapterMinutes"] / completed if completed else None
        row["chapterScorePerCompleted"] = row["chapterScoreTotal"] / scored if scored else None
        row["quantityPerMinute"] = quantity / minutes if quantity > 0 and minutes > 0 else None
        # A pure-time benchmark is the template's share of all task minutes,
        # not the share inside the template itself.
        row["pureTimeRatio"] = row["pureTimeMinutes"] / minutes if minutes > 0 else None
        row["pureTimeShareOfTotal"] = minutes / total_minutes if minutes > 0 and total_minutes > 0 else None
        row["accuracy"] = (accuracy_quantity - row["accuracyWrong"]) / accuracy_quantity if accuracy_quantity > 0 else None


def calculate_day_metrics(day: Any, templates: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Calculate one day's raw and derived metrics from the existing data shape."""

    day = day if isinstance(day, dict) else {}
    templates = templates or {}
    sessions = day.get("sessions") if isinstance(day.get("sessions"), list) else []
    tasks = day.get("tasks") if isinstance(day.get("tasks"), list) else []

    ordinary_clock = ordinary_actual = nominal = rest = distract = 0.0
    unavailable_clock = special_clock = special_actual = 0.0
    for session in sessions:
        if not isinstance(session, dict):
            continue
        clock = float(session_minutes(session))
        actual = max(0.0, _number(session.get("actualMinutes")))
        session_rest = max(0.0, _number(session.get("restMinutes")))
        if _is_unavailable(session):
            unavailable_clock += clock
        elif _is_special_study(session):
            special_clock += clock
            special_actual += min(actual, clock)
        else:
            ordinary_clock += clock
            ordinary_actual += actual
            nominal += max(0.0, _number(session.get("nominalMinutes")))
            rest += min(session_rest, clock)
            distract += max(0.0, clock - actual - session_rest)

    actual = ordinary_actual + special_actual
    total_clock = ordinary_clock + unavailable_clock + special_clock
    unavailable = unavailable_clock + max(0.0, special_clock - special_actual)
    effective_clock = max(0.0, ordinary_clock - rest + special_actual)
    awake = _awake_minutes(day)
    awake_clock_gap = max(0.0, awake - total_clock) if awake is not None else None

    task_total = 0.0
    pure_time_minutes = 0.0
    quantity_total = 0.0
    wrong_total = 0.0
    quantity_records = 0
    accuracy_quantity = 0.0
    accuracy_wrong = 0.0
    accuracy_records = 0
    completed_chapters = 0
    chapter_minutes = 0.0
    chapter_score_total = 0.0
    scored_chapters = 0
    template_metrics: dict[str, dict[str, Any]] = {}
    for task in tasks:
        if not isinstance(task, dict):
            continue
        minutes = max(0.0, _number(task.get("minutes")))
        task_total += minutes
        template = _template_for_task(task, templates)
        named, quantity_enabled, accuracy_enabled, score_enabled = _task_flags(task, template)
        if not named and not quantity_enabled:
            pure_time_minutes += minutes

        quantity = _number(task.get("quantity"), 0.0)
        if quantity_enabled and quantity > 0:
            quantity_total += quantity
            quantity_records += 1
        recorded_wrong = _recorded_wrong_count(task, quantity) if accuracy_enabled and quantity > 0 else None
        if recorded_wrong is not None:
            wrong_total += recorded_wrong
            accuracy_quantity += quantity
            accuracy_wrong += recorded_wrong
            accuracy_records += 1
        recorded_score = _recorded_score(task, template) if score_enabled else None

        allocations = task.get("namedItemAllocations")
        if named and isinstance(allocations, list):
            for allocation in allocations:
                if not isinstance(allocation, dict):
                    continue
                allocated_minutes = max(0.0, _number(allocation.get("minutes")))
                chapter_minutes += allocated_minutes
                if allocation.get("completed"):
                    completed_chapters += 1
                    score = _finite_nonnegative(allocation.get("score"))
                    if score is not None:
                        chapter_score_total += score
                        scored_chapters += 1

        key = str(task.get("templateId") or task.get("activityType") or "未分类").strip()
        row = template_metrics.setdefault(key, {
            "templateId": str(task.get("templateId") or ""),
            "activityType": str(task.get("activityType") or ""),
            "minutes": 0.0,
            "quantity": 0.0,
            "wrong": 0.0,
            "quantityRecords": 0,
            "pureTimeMinutes": 0.0,
            "chapterMinutes": 0.0,
            "completedChapters": 0,
            "chapterScoreTotal": 0.0,
            "scoredChapters": 0,
            "chapterScoringEnabled": bool(template and not template.get("scoreEnabled") and template.get("chapterScoringEnabled") and named and not quantity_enabled),
            "chapterMaxScore": _finite_nonnegative((template or {}).get("scoreMax", (template or {}).get("chapterMaxScore"))),
            "namedEnabled": named,
            "quantityEnabled": quantity_enabled,
            "accuracyEnabled": accuracy_enabled,
            "accuracyQuantity": 0.0,
            "accuracyWrong": 0.0,
            "accuracyRecords": 0,
            "scoreEnabled": score_enabled,
            "scoreTotal": 0.0,
            "scoreMaxTotal": 0.0,
            "scoreRecords": 0,
        })
        row["minutes"] += minutes
        row["quantity"] += quantity if quantity_enabled and quantity > 0 else 0.0
        row["wrong"] += recorded_wrong if recorded_wrong is not None else 0.0
        row["quantityRecords"] += 1 if quantity_enabled and quantity > 0 else 0
        row["accuracyQuantity"] += quantity if recorded_wrong is not None else 0.0
        row["accuracyWrong"] += recorded_wrong if recorded_wrong is not None else 0.0
        row["accuracyRecords"] += 1 if recorded_wrong is not None else 0
        if recorded_score is not None:
            row["scoreTotal"] += recorded_score[0]
            row["scoreMaxTotal"] += recorded_score[1]
            row["scoreRecords"] += 1
        row["pureTimeMinutes"] += minutes if not named and not quantity_enabled else 0.0
        if named and isinstance(allocations, list):
            row["chapterMinutes"] += sum(max(0.0, _number(item.get("minutes"))) for item in allocations if isinstance(item, dict))
            row["completedChapters"] += sum(1 for item in allocations if isinstance(item, dict) and item.get("completed"))
            for item in allocations:
                if not isinstance(item, dict) or not item.get("completed"):
                    continue
                score = _finite_nonnegative(item.get("score"))
                if score is not None:
                    row["chapterScoreTotal"] += score
                    row["scoredChapters"] += 1

    for row in template_metrics.values():
        row["scoreRate"] = row["scoreTotal"] / row["scoreMaxTotal"] if row["scoreMaxTotal"] > 0 else None
    _finalize_template_metrics(template_metrics, task_total)
    return {
        "awakeMinutes": awake,
        "ordinaryClockMinutes": ordinary_clock,
        "ordinaryActualMinutes": ordinary_actual,
        "nominalMinutes": nominal,
        "actualMinutes": actual,
        "restMinutes": rest,
        "distractMinutes": distract,
        "unavailableClockMinutes": unavailable_clock,
        "specialStudyClockMinutes": special_clock,
        "specialStudyActualMinutes": special_actual,
        "totalClockMinutes": total_clock,
        "unavailableMinutes": unavailable,
        "effectiveClockMinutes": effective_clock,
        "awakeClockGapMinutes": awake_clock_gap,
        "focusEfficiency": actual / effective_clock if effective_clock > 0 else None,
        "taskMinutes": task_total,
        "taskActualGapMinutes": abs(task_total - actual),
        "pureTimeTaskMinutes": pure_time_minutes,
        "pureTimeTaskRatio": pure_time_minutes / task_total if task_total > 0 else None,
        "quantityTotal": quantity_total,
        "quantityRecords": quantity_records,
        "wrongTotal": wrong_total,
        "accuracyQuantity": accuracy_quantity,
        "accuracyWrong": accuracy_wrong,
        "accuracyRecords": accuracy_records,
        "accuracy": (accuracy_quantity - accuracy_wrong) / accuracy_quantity if accuracy_quantity > 0 else None,
        "chapterMinutes": chapter_minutes,
        "completedChapters": completed_chapters,
        "chapterMinutesPerCompleted": chapter_minutes / completed_chapters if completed_chapters else None,
        "chapterScoreTotal": chapter_score_total,
        "scoredChapters": scored_chapters,
        "chapterScorePerCompleted": chapter_score_total / scored_chapters if scored_chapters else None,
        "quantityPerMinute": quantity_total / task_total if quantity_total > 0 and task_total > 0 else None,
        "templateMetrics": template_metrics,
    }


def _has_analysis_record(day: Any) -> bool:
    """Return whether a day has one of the raw records meaningful to scoring.

    Notes, date labels, and exclusion metadata describe a date but do not make
    it an observed day. This intentionally mirrors the analysis-page rule:
    sleep/wake times, a focus session, or a task record are required before a
    day can contribute to a score, trend, or stability calculation.
    """

    if not isinstance(day, dict):
        return False
    sessions = day.get("sessions")
    tasks = day.get("tasks")
    return bool(
        (isinstance(sessions, list) and sessions)
        or (isinstance(tasks, list) and tasks)
        or str(day.get("wakeTime") or "").strip()
        or str(day.get("sleepTime") or "").strip()
    )


def _date_list(start_date: str, end_date: str) -> list[str]:
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    if start > end:
        raise ValueError("startDate must not be later than endDate")
    result = []
    cursor = start
    while cursor <= end:
        result.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return result


def _standard_value(standard: dict[str, Any], key: str, days: int) -> float | None:
    value = standard.get(key)
    return value * days if value is not None else None


def _zero_anchored_smooth(value: float | None, smooth: float) -> float | None:
    """Smooth positive values without inventing activity at zero.

    The former ``value + smooth`` expression behaved like five virtual
    minutes of work. This curve keeps the small-value damping while retaining
    the essential property f(0) = 0.
    """

    number = _finite_nonnegative(value)
    if number is None:
        return None
    if number <= 0:
        return 0.0
    scale = max(0.0, float(smooth))
    if scale <= 0:
        return number
    return number + scale * (1.0 - math.exp(-number / scale))


def _ratio_higher(actual: float | None, standard: float | None, smooth: float) -> float | None:
    observed = _zero_anchored_smooth(actual, smooth)
    target = _zero_anchored_smooth(standard, smooth)
    if observed is None or target is None or target <= 0:
        return None
    return observed / target


def _ratio_lower_productive(actual: float | None, standard: float | None, smooth: float) -> float | None:
    """Productive lower-is-better ratio, such as minutes per chapter."""

    observed = _zero_anchored_smooth(actual, smooth)
    target = _zero_anchored_smooth(standard, smooth)
    if observed is None or target is None or observed <= 0 or target <= 0:
        return None
    return target / observed


def _ratio_lower_penalty(actual: float | None, standard: float | None, smooth: float) -> float | None:
    """One-sided quality penalty: below target is neutral, never a bonus."""

    observed = _finite_nonnegative(actual)
    target = _finite_nonnegative(standard)
    if observed is None or target is None:
        return None
    if observed <= target:
        return 1.0
    scale = max(float(smooth), target + float(smooth))
    return math.exp(-(observed - target) / scale)


def _ratio_closer(actual: float | None, standard: float | None, smooth: float, tolerance: float) -> float | None:
    observed_value = _zero_anchored_smooth(actual, smooth)
    target_value = _zero_anchored_smooth(standard, smooth)
    if observed_value is None or target_value is None or target_value <= 0 or tolerance <= 0:
        return None
    if observed_value <= 0:
        return 0.0
    observed = observed_value / target_value
    return math.exp(-abs(math.log(observed)) / tolerance)


def _add_factor(factors: list[dict[str, Any]], key: str, label: str, ratio: float | None, weight: Any, value: Any, standard: Any) -> None:
    numeric_weight = _finite_nonnegative(weight, 0.0) or 0.0
    if ratio is None or not math.isfinite(ratio) or ratio <= 0 or numeric_weight <= 0:
        return
    factors.append({
        "key": key,
        "label": label,
        "ratio": ratio,
        "_weight": numeric_weight,
        "value": value,
        "standard": standard,
    })


def calculate_score(factors: list[dict[str, Any]]) -> dict[str, Any]:
    if not factors:
        return {"score": None, "factors": []}
    total_weight = sum(float(item["_weight"]) for item in factors)
    if total_weight <= 0:
        return {"score": None, "factors": []}
    weighted_log = sum(float(item["_weight"]) * math.log(float(item["ratio"])) for item in factors) / total_weight
    score = 100.0 * math.exp(weighted_log)
    result = {
        "score": score,
        "factors": [
            {key: value for key, value in item.items() if key != "_weight"}
            for item in factors
        ],
    }
    return result


def _aggregate_metrics(day_metrics: list[dict[str, Any]]) -> dict[str, Any]:
    sum_keys = {
        "ordinaryClockMinutes", "ordinaryActualMinutes", "nominalMinutes", "actualMinutes",
        "restMinutes", "distractMinutes", "unavailableClockMinutes", "specialStudyClockMinutes",
        "specialStudyActualMinutes", "totalClockMinutes", "unavailableMinutes", "effectiveClockMinutes",
        "taskMinutes", "taskActualGapMinutes", "pureTimeTaskMinutes", "quantityTotal", "quantityRecords",
        "wrongTotal", "accuracyQuantity", "accuracyWrong", "accuracyRecords", "chapterMinutes", "completedChapters", "chapterScoreTotal", "scoredChapters",
    }
    result: dict[str, Any] = {key: sum(_number(day.get(key)) for day in day_metrics) for key in sum_keys}
    awake_values = [day["awakeMinutes"] for day in day_metrics if day.get("awakeMinutes") is not None]
    result["awakeMinutes"] = sum(awake_values) if awake_values else None
    result["awakeClockGapMinutes"] = sum(_number(day.get("awakeClockGapMinutes")) for day in day_metrics if day.get("awakeClockGapMinutes") is not None) if awake_values else None
    result["focusEfficiency"] = result["actualMinutes"] / result["effectiveClockMinutes"] if result["effectiveClockMinutes"] > 0 else None
    result["taskActualGapMinutes"] = abs(result["taskMinutes"] - result["actualMinutes"])
    result["pureTimeTaskRatio"] = result["pureTimeTaskMinutes"] / result["taskMinutes"] if result["taskMinutes"] > 0 else None
    result["accuracy"] = (result["accuracyQuantity"] - result["accuracyWrong"]) / result["accuracyQuantity"] if result["accuracyQuantity"] > 0 else None
    result["chapterMinutesPerCompleted"] = result["chapterMinutes"] / result["completedChapters"] if result["completedChapters"] else None
    result["quantityPerMinute"] = result["quantityTotal"] / result["taskMinutes"] if result["quantityTotal"] > 0 and result["taskMinutes"] > 0 else None
    merged: dict[str, dict[str, Any]] = {}
    for day in day_metrics:
        for key, row in (day.get("templateMetrics") or {}).items():
            target = merged.setdefault(key, {name: 0.0 for name in ("minutes", "quantity", "wrong", "quantityRecords", "accuracyQuantity", "accuracyWrong", "accuracyRecords", "scoreTotal", "scoreMaxTotal", "scoreRecords", "pureTimeMinutes", "chapterMinutes", "completedChapters", "chapterScoreTotal", "scoredChapters")})
            target.update({"templateId": row.get("templateId", ""), "activityType": row.get("activityType", ""), "namedEnabled": row.get("namedEnabled", False), "quantityEnabled": row.get("quantityEnabled", False), "accuracyEnabled": row.get("accuracyEnabled", False), "scoreEnabled": row.get("scoreEnabled", False), "chapterScoringEnabled": row.get("chapterScoringEnabled", False), "chapterMaxScore": row.get("chapterMaxScore")})
            for name in ("minutes", "quantity", "wrong", "quantityRecords", "accuracyQuantity", "accuracyWrong", "accuracyRecords", "scoreTotal", "scoreMaxTotal", "scoreRecords", "pureTimeMinutes", "chapterMinutes", "completedChapters", "chapterScoreTotal", "scoredChapters"):
                target[name] += _number(row.get(name))
    _finalize_template_metrics(merged, result["taskMinutes"])
    for row in merged.values():
        row["scoreRate"] = row["scoreTotal"] / row["scoreMaxTotal"] if row["scoreMaxTotal"] > 0 else None
    result["templateMetrics"] = merged
    return result


def _build_day_factors(metrics: dict[str, Any], config: dict[str, Any], days: int) -> list[dict[str, Any]]:
    standard = config["standardDay"]
    weights = INTERNAL_SCORE_POLICY["dayWeights"]
    smooth = float(INTERNAL_SCORE_POLICY["smoothingMinutes"])
    tolerance = float(INTERNAL_SCORE_POLICY["scaleTolerance"])
    factors: list[dict[str, Any]] = []
    standard_actual = _standard_value(standard, "actualMinutes", days)
    standard_nominal = _standard_value(standard, "nominalMinutes", days)
    standard_awake = _standard_value(standard, "awakeMinutes", days)
    standard_clock = _standard_value(standard, "totalClockMinutes", days)
    standard_rest = _standard_value(standard, "restMinutes", days)
    standard_unavailable = _standard_value(standard, "unavailableMinutes", days)
    standard_special_clock = _standard_value(standard, "specialStudyClockMinutes", days)
    standard_special_actual = _standard_value(standard, "specialStudyActualMinutes", days)
    standard_task = _standard_value(standard, "taskMinutes", days)

    standard_effective = None
    if standard_clock is not None and standard_rest is not None and standard_unavailable is not None:
        standard_effective = max(0.0, standard_clock - standard_unavailable - standard_rest)
    standard_nominal_gap = None if not standard_nominal or not standard_actual else max(0.0, standard_nominal - standard_actual)
    standard_awake_gap = None if not standard_awake or not standard_clock else max(0.0, standard_awake - standard_clock)
    standard_task_gap = None if not standard_task or not standard_actual else abs(standard_task - standard_actual)
    standard_efficiency = standard_actual / standard_effective if standard_actual is not None and standard_effective and standard_effective > 0 else None

    _add_factor(factors, "ordinaryActual", "实际专注", _ratio_higher(metrics.get("actualMinutes"), standard_actual, smooth), weights.get("ordinaryActual"), metrics.get("actualMinutes"), standard_actual)
    _add_factor(factors, "nominalScale", "名义计划规模", _ratio_closer(metrics.get("nominalMinutes"), standard_nominal, smooth, tolerance), weights.get("nominalScale"), metrics.get("nominalMinutes"), standard_nominal)
    _add_factor(factors, "taskVolume", "任务工作量", _ratio_higher(metrics.get("taskMinutes"), standard_task, smooth), weights.get("taskVolume"), metrics.get("taskMinutes"), standard_task)

    actual_minutes = _finite_nonnegative(metrics.get("actualMinutes"), 0.0) or 0.0
    nominal_minutes = _finite_nonnegative(metrics.get("nominalMinutes"), 0.0) or 0.0
    task_minutes = _finite_nonnegative(metrics.get("taskMinutes"), 0.0) or 0.0
    total_clock_minutes = _finite_nonnegative(metrics.get("totalClockMinutes"), 0.0) or 0.0
    ordinary_clock_minutes = _finite_nonnegative(metrics.get("ordinaryClockMinutes"), 0.0) or 0.0
    actual_nominal_gap = max(0.0, nominal_minutes - actual_minutes) if nominal_minutes > 0 and actual_minutes > 0 else None
    awake_clock_gap = metrics.get("awakeClockGapMinutes") if total_clock_minutes > 0 else None
    rest_minutes = metrics.get("restMinutes") if ordinary_clock_minutes > 0 else None
    unavailable_minutes = metrics.get("unavailableMinutes") if total_clock_minutes > 0 else None
    task_actual_gap = abs(task_minutes - actual_minutes) if task_minutes > 0 and actual_minutes > 0 else None
    _add_factor(factors, "nominalGap", "名义与实际差额", _ratio_lower_penalty(actual_nominal_gap, standard_nominal_gap, smooth), weights.get("nominalGap"), actual_nominal_gap, standard_nominal_gap)
    _add_factor(factors, "awakeClockGap", "清醒与时钟未覆盖差额", _ratio_lower_penalty(awake_clock_gap, standard_awake_gap, smooth), weights.get("awakeClockGap"), awake_clock_gap, standard_awake_gap)
    _add_factor(factors, "rest", "休息时长", _ratio_lower_penalty(rest_minutes, standard_rest, smooth), weights.get("rest"), rest_minutes, standard_rest)
    _add_factor(factors, "unavailable", "不可用时间", _ratio_lower_penalty(unavailable_minutes, standard_unavailable, smooth), weights.get("unavailable"), unavailable_minutes, standard_unavailable)
    special_clock_minutes = _finite_nonnegative(metrics.get("specialStudyClockMinutes"), 0.0) or 0.0
    special_actual_minutes = _finite_nonnegative(metrics.get("specialStudyActualMinutes"), 0.0) or 0.0
    special_ratio = None
    if special_clock_minutes > 0 and standard_special_clock is not None and standard_special_actual is not None:
        clock_ratio = _ratio_lower_productive(special_clock_minutes, standard_special_clock, smooth)
        actual_ratio = _ratio_higher(special_actual_minutes, standard_special_actual, smooth)
        if clock_ratio is not None and actual_ratio is not None:
            special_ratio = math.sqrt(clock_ratio * max(actual_ratio, 0.01))
    _add_factor(
        factors,
        "specialStudy",
        "特殊学习时长与实际专注",
        special_ratio,
        weights.get("specialStudy"),
        {"clockMinutes": special_clock_minutes, "actualMinutes": special_actual_minutes},
        {"clockMinutes": standard_special_clock, "actualMinutes": standard_special_actual},
    )
    _add_factor(factors, "taskReconciliation", "任务记录与实际专注误差", _ratio_lower_penalty(task_actual_gap, standard_task_gap, smooth), weights.get("taskReconciliation"), task_actual_gap, standard_task_gap)
    _add_factor(factors, "focusEfficiency", "专注效率", _ratio_higher(metrics.get("focusEfficiency"), standard_efficiency, 0.01), weights.get("focusEfficiency"), metrics.get("focusEfficiency"), standard_efficiency)
    return factors


def _task_factor_display_name(standard: dict[str, Any], row: dict[str, Any], templates: dict[str, dict[str, Any]]) -> str:
    """Return a human-readable task template name, never an internal ID."""

    for value in (standard.get("activityType"), row.get("activityType")):
        name = str(value or "").strip()
        if name:
            return name
    for template_id in (standard.get("templateId"), row.get("templateId")):
        template = templates.get(str(template_id or ""))
        name = str((template or {}).get("activityType") or "").strip()
        if name:
            return name
    return "未命名任务模板"


def _build_task_factors(metrics: dict[str, Any], config: dict[str, Any], templates: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    smooth = float(INTERNAL_SCORE_POLICY["smoothingMinutes"])
    factors: list[dict[str, Any]] = []
    by_key = metrics.get("templateMetrics") or {}
    for standard in config.get("taskStandards", []):
        if not standard.get("enabled", True):
            continue
        key = str(standard.get("templateId") or standard.get("activityType") or "")
        row = by_key.get(key)
        if not row:
            continue
        base = f"task:{key}"
        display_name = _task_factor_display_name(standard, row, templates)
        weight = INTERNAL_SCORE_POLICY["taskFactorWeight"]
        chapter_standard = standard.get("chapterMinutesPerUnit")
        if chapter_standard is not None and row.get("chapterMinutesPerCompleted") is not None:
            ratio = _ratio_lower_productive(row["chapterMinutesPerCompleted"], chapter_standard, smooth)
            _add_factor(factors, f"{base}:chapter", f"{display_name} 章节效率", ratio, weight, row["chapterMinutesPerCompleted"], chapter_standard)
        score_standard = standard.get("chapterScorePerUnit")
        if row.get("chapterScoringEnabled") and score_standard is not None and row.get("chapterScorePerCompleted") is not None:
            ratio = _ratio_higher(row["chapterScorePerCompleted"], score_standard, 0.01)
            _add_factor(
                factors,
                f"{base}:chapterScore",
                f"{display_name} 章节得分",
                ratio,
                weight,
                {"scorePerChapter": row["chapterScorePerCompleted"], "maxScore": row.get("chapterMaxScore")},
                {"scorePerChapter": score_standard, "maxScore": row.get("chapterMaxScore")},
            )
        quantity_standard = standard.get("quantityPerMinute")
        if quantity_standard is not None and row.get("quantityPerMinute") is not None:
            ratio = _ratio_higher(row["quantityPerMinute"], quantity_standard, 0.01)
            _add_factor(factors, f"{base}:quantity", f"{display_name} 数量效率", ratio, weight, row["quantityPerMinute"], quantity_standard)
        pure_standard = standard.get("pureTimeMaxRatio")
        pure_share = row.get("pureTimeShareOfTotal")
        if pure_standard is not None and pure_share is not None:
            ratio = _ratio_lower_penalty(pure_share, pure_standard, 0.01)
            _add_factor(factors, f"{base}:pureTime", f"{display_name} 纯时间任务占全部任务时长比例", ratio, weight, pure_share, pure_standard)
        accuracy_standard = standard.get("accuracy")
        if row.get("accuracyEnabled") and accuracy_standard is not None and row.get("accuracy") is not None:
            ratio = _ratio_higher(row["accuracy"], accuracy_standard, 0.001)
            _add_factor(factors, f"{base}:accuracy", f"{display_name} 正确率", ratio, weight, row["accuracy"], accuracy_standard)
        score_standard = standard.get("scoreRate")
        if score_standard is None and not row.get("chapterScoringEnabled") and row.get("chapterMaxScore"):
            legacy_standard = standard.get("chapterScorePerUnit")
            if legacy_standard is not None:
                score_standard = legacy_standard / row["chapterMaxScore"]
        if row.get("scoreEnabled") and score_standard is not None and row.get("scoreRate") is not None:
            ratio = _ratio_higher(row["scoreRate"], score_standard, 0.001)
            _add_factor(factors, f"{base}:score", f"{display_name} 得分率", ratio, weight, row["scoreRate"], score_standard)
    return factors


def _score_metrics(metrics: dict[str, Any], config: dict[str, Any], days: int, templates: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Score one day or a date-prefix with the same range scoring policy."""

    if days <= 0:
        return {"score": None, "factors": []}
    day_factors = _build_day_factors(metrics, config, days)
    task_factors = _build_task_factors(metrics, config, templates)
    return calculate_score(day_factors + task_factors)


def _calculate_evidence(metrics: dict[str, Any], config: dict[str, Any], days: int) -> dict[str, Any]:
    """Measure how much recorded productive work supports a score.

    The coverage coefficient is continuous and applies to every selected date
    range. It is deliberately based on work-volume targets rather than a
    date-state branch, so a partially recorded day fades toward zero instead
    of receiving a hidden baseline score.
    """

    standard = config["standardDay"]
    if days <= 0:
        return {
            "available": False,
            "coverage": None,
            "coefficient": None,
            "channels": [],
        }
    task_target = _standard_value(standard, "taskMinutes", days)
    task_observed = _finite_nonnegative(metrics.get("taskMinutes"))
    # Task duration is the mandatory basis for a score. Other time records
    # may affect the result only after both the standard and the date contain
    # a positive task duration.
    if task_target is None or task_target <= 0 or task_observed is None or task_observed <= 0:
        return {
            "available": True,
            "coverage": 0.0,
            "coefficient": 0.0,
            "channels": [],
        }

    channels = []
    for key, label in (("actualMinutes", "实际专注"), ("taskMinutes", "任务记录")):
        target = _standard_value(standard, key, days)
        observed = _finite_nonnegative(metrics.get(key))
        if target is None or target <= 0 or observed is None:
            continue
        raw_coverage = observed / target
        channels.append({
            "key": key,
            "label": label,
            "observed": observed,
            "target": target,
            "coverage": min(1.0, raw_coverage),
            "rawCoverage": raw_coverage,
        })

    if not channels:
        return {
            "available": False,
            "coverage": None,
            "coefficient": None,
            "channels": [],
        }

    coverage = max(channel["coverage"] for channel in channels)
    saturation = max(0.01, float(INTERNAL_SCORE_POLICY["evidence"]["saturation"]))
    normalizer = 1.0 - math.exp(-saturation)
    coefficient = (1.0 - math.exp(-saturation * coverage)) / normalizer if coverage > 0 else 0.0
    return {
        "available": True,
        "coverage": coverage,
        "coefficient": min(1.0, coefficient),
        "channels": channels,
    }


def _calendar_gap_days(previous: str, current: str) -> int | None:
    try:
        return (date.fromisoformat(current) - date.fromisoformat(previous)).days
    except (TypeError, ValueError):
        return None


def _calculate_series_stability(points: list[dict[str, Any]], policy: dict[str, Any]) -> dict[str, Any]:
    """Return CV and natural-day jump stability for one ordered metric."""

    minimum_days = max(2, int(policy["minimumComparableDays"]))
    valid = []
    for point in points:
        value = _finite_nonnegative(point.get("value"))
        if value is not None:
            valid.append({"date": str(point.get("date") or ""), "value": value})

    result: dict[str, Any] = {
        "available": False,
        "sampleCount": len(valid),
        "minimumComparableDays": minimum_days,
        "mean": None,
        "variance": None,
        "stdDev": None,
        "cv": None,
        "meanAdjacentJump": None,
        "adjacentPairs": 0,
        "skippedGaps": 0,
        "penalty": None,
    }
    if len(valid) < minimum_days:
        return result

    mean = sum(point["value"] for point in valid) / len(valid)
    if mean <= 1e-9:
        return result

    variance = sum((point["value"] - mean) ** 2 for point in valid) / len(valid)
    std_dev = math.sqrt(variance)
    cv = std_dev / mean
    jumps = []
    skipped_gaps = 0
    for previous, current in zip(valid, valid[1:]):
        if _calendar_gap_days(previous["date"], current["date"]) != 1:
            skipped_gaps += 1
            continue
        midpoint = max((previous["value"] + current["value"]) / 2.0, 1e-9)
        jumps.append(min(2.0, abs(current["value"] - previous["value"]) / midpoint))

    cv_tolerance = max(0.01, float(policy["cvTolerance"]))
    jump_tolerance = max(0.01, float(policy["jumpTolerance"]))
    cv_influence = max(0.0, float(policy["cvInfluence"]))
    jump_influence = max(0.0, float(policy["jumpInfluence"]))
    components = [(cv_influence, min(4.0, cv / cv_tolerance))]
    mean_jump = sum(jumps) / len(jumps) if jumps else None
    if mean_jump is not None:
        components.append((jump_influence, min(4.0, mean_jump / jump_tolerance)))
    total_influence = sum(weight for weight, _ in components)
    if total_influence <= 0:
        return result

    instability = sum(weight * value for weight, value in components) / total_influence
    penalty = math.exp(-max(0.0, float(policy["strength"])) * instability)
    result.update({
        "available": True,
        "mean": mean,
        "variance": variance,
        "stdDev": std_dev,
        "cv": cv,
        "meanAdjacentJump": mean_jump,
        "adjacentPairs": len(jumps),
        "skippedGaps": skipped_gaps,
        "penalty": penalty,
    })
    return result


def _stability_metric_weights(config: dict[str, Any]) -> dict[str, float]:
    """Enable stability dimensions only when their work-volume target exists."""

    configured = config["standardDay"]
    policy_weights = INTERNAL_SCORE_POLICY["stability"]["metricWeights"]
    weights: dict[str, float] = {
        "dailyScore": float(policy_weights["dailyScore"]),
    }
    if (_finite_nonnegative(configured.get("actualMinutes")) or 0.0) > 0:
        weights["actualMinutes"] = float(policy_weights["actualMinutes"])
    if (_finite_nonnegative(configured.get("taskMinutes")) or 0.0) > 0:
        weights["taskMinutes"] = float(policy_weights["taskMinutes"])
    return weights


def _calculate_stability(
    daily_observations: list[dict[str, Any]],
    metric_weights: dict[str, float],
) -> dict[str, Any]:
    """Combine configured time, task, and daily-score stability without rewarding it."""

    policy = INTERNAL_SCORE_POLICY["stability"]
    metrics = {}
    active: list[tuple[float, dict[str, Any]]] = []
    for key, weight in metric_weights.items():
        series = _calculate_series_stability(
            [{"date": item.get("date"), "value": item.get(key)} for item in daily_observations],
            policy,
        )
        metrics[key] = series
        numeric_weight = _finite_nonnegative(weight, 0.0) or 0.0
        if series["available"] and numeric_weight > 0:
            active.append((numeric_weight, series))

    if not active:
        return {
            "available": False,
            "penalty": 1.0,
            "metricCount": 0,
            "cv": None,
            "meanAdjacentJump": None,
            "minimumComparableDays": max(2, int(policy["minimumComparableDays"])),
            "metrics": metrics,
        }

    total_weight = sum(weight for weight, _ in active)
    penalty = math.exp(sum(weight * math.log(item["penalty"]) for weight, item in active) / total_weight)
    cv = sum(weight * item["cv"] for weight, item in active if item["cv"] is not None) / total_weight
    jump_items = [(weight, item["meanAdjacentJump"]) for weight, item in active if item["meanAdjacentJump"] is not None]
    jump_weight = sum(weight for weight, _ in jump_items)
    mean_jump = sum(weight * value for weight, value in jump_items) / jump_weight if jump_weight else None
    return {
        "available": True,
        "penalty": penalty,
        "metricCount": len(active),
        "cv": cv,
        "meanAdjacentJump": mean_jump,
        "minimumComparableDays": max(2, int(policy["minimumComparableDays"])),
        "metrics": metrics,
    }


def _apply_score_modifiers(
    base_score: dict[str, Any],
    evidence: dict[str, Any],
    stability: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply only-down evidence and stability modifiers to a base score."""

    result = copy.deepcopy(base_score)
    result["baseScore"] = result.get("score")
    result["evidence"] = copy.deepcopy(evidence)
    result["stability"] = copy.deepcopy(stability) if stability is not None else None
    if not evidence.get("available"):
        result["score"] = None
        return result

    evidence_ratio = float(evidence["coefficient"])
    if result["baseScore"] is None:
        # A configured work-volume target with zero coverage is a real zero,
        # while a positive-coverage day without any applicable factor remains
        # explicitly unscorable instead of receiving an invented baseline.
        result["score"] = 0.0 if evidence_ratio == 0 else None
        result["evidenceCoefficient"] = evidence_ratio
        result["stabilityPenalty"] = 1.0
        return result

    result["factors"].append({
        "key": "evidenceCoverage",
        "label": "有效记录覆盖度",
        "ratio": evidence_ratio,
        "value": copy.deepcopy(evidence),
        "standard": {"coverage": 1.0},
        "modifier": "multiplier",
    })
    stability_penalty = 1.0
    if stability and stability.get("available"):
        stability_penalty = float(stability["penalty"])
        result["factors"].append({
            "key": "stability",
            "label": "综合平稳度",
            "ratio": stability_penalty,
            "value": copy.deepcopy(stability),
            "standard": {
                "cvTolerance": INTERNAL_SCORE_POLICY["stability"]["cvTolerance"],
                "jumpTolerance": INTERNAL_SCORE_POLICY["stability"]["jumpTolerance"],
            },
            "modifier": "multiplier",
        })
    result["evidenceCoefficient"] = evidence_ratio
    result["stabilityPenalty"] = stability_penalty
    result["score"] = float(result["baseScore"]) * evidence_ratio * stability_penalty
    return result


DAY_TYPE_ALL_FILTER = "__all_day_types__"


def calculate_range(
    data: dict[str, Any],
    start_date: str,
    end_date: str,
    config: Any = None,
    include_excluded: bool = False,
    day_type_filter: str = "",
) -> dict[str, Any]:
    """Calculate a range response with optional date-type filtering.

    Empty filter preserves the original behavior. The reserved all-types
    value includes every date, while a regular value includes only dates
    whose ``dayType`` matches it. ``include_excluded`` remains as a backwards
    compatible fallback for older frontend callers.
    """

    dates = _date_list(start_date, end_date)
    config = normalize_config(config)
    templates = {
        str(template.get("id")): template
        for template in (data.get("__taskTemplates__", []) if isinstance(data, dict) else [])
        if isinstance(template, dict) and template.get("id")
    }
    selected_type = str(day_type_filter or "").strip()
    include_all_types = selected_type == DAY_TYPE_ALL_FILTER
    include_all_excluded = include_all_types or bool(selected_type) or include_excluded
    included_dates = []
    excluded_dates = []
    unrecorded_dates = []
    day_metrics = []
    daily = []
    for date_str in dates:
        day = data.get(date_str, {}) if isinstance(data, dict) else {}
        if not _has_analysis_record(day):
            unrecorded_dates.append(date_str)
            continue
        day_type = str(day.get("dayType") or "").strip() if isinstance(day, dict) else ""
        if selected_type and not include_all_types and day_type != selected_type:
            excluded_dates.append(date_str)
            continue
        if isinstance(day, dict) and day.get("excludeFromRating") and not include_all_excluded:
            excluded_dates.append(date_str)
            continue
        metrics = calculate_day_metrics(day, templates)
        included_dates.append(date_str)
        day_metrics.append(metrics)
        daily.append({"date": date_str, **metrics})

    daily_scores = []
    daily_observations = []
    for date_str, metrics in zip(included_dates, day_metrics):
        daily_base_score = _score_metrics(metrics, config, 1, templates)
        daily_evidence = _calculate_evidence(metrics, config, 1)
        daily_score = _apply_score_modifiers(daily_base_score, daily_evidence)
        daily_scores.append(daily_score)
        daily_observations.append({
            "date": date_str,
            "actualMinutes": metrics.get("actualMinutes"),
            "taskMinutes": metrics.get("taskMinutes"),
            "dailyScore": daily_score.get("score"),
        })

    stability_metric_weights = _stability_metric_weights(config)
    aggregate = _aggregate_metrics(day_metrics)
    aggregate_base_score = _score_metrics(aggregate, config, len(included_dates), templates)
    aggregate_evidence = _calculate_evidence(aggregate, config, len(included_dates))
    stability = _calculate_stability(daily_observations, stability_metric_weights)
    score = _apply_score_modifiers(aggregate_base_score, aggregate_evidence, stability)
    score_timeline = []
    prefix_metrics = []
    prefix_observations = []
    for index, (date_str, metrics) in enumerate(zip(included_dates, day_metrics)):
        prefix_metrics.append(metrics)
        prefix_observations.append(daily_observations[index])
        cumulative_metrics = _aggregate_metrics(prefix_metrics)
        cumulative_base_score = _score_metrics(cumulative_metrics, config, len(prefix_metrics), templates)
        cumulative_evidence = _calculate_evidence(cumulative_metrics, config, len(prefix_metrics))
        cumulative_stability = _calculate_stability(prefix_observations, stability_metric_weights)
        cumulative_score = _apply_score_modifiers(cumulative_base_score, cumulative_evidence, cumulative_stability)
        score_timeline.append({
            "date": date_str,
            "dailyScore": daily_scores[index].get("score"),
            "dailyBaseScore": daily_scores[index].get("baseScore"),
            "dailyEvidenceCoefficient": daily_scores[index].get("evidenceCoefficient"),
            "cumulativeScore": cumulative_score.get("score"),
            "cumulativeBaseScore": cumulative_score.get("baseScore"),
            "cumulativeEvidenceCoefficient": cumulative_score.get("evidenceCoefficient"),
            "cumulativeStabilityPenalty": cumulative_score.get("stabilityPenalty"),
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "startDate": start_date,
        "endDate": end_date,
        "dayTypeFilter": selected_type,
        "dates": dates,
        "includedDates": included_dates,
        "excludedDates": excluded_dates,
        "unrecordedDates": unrecorded_dates,
        "dayCount": len(included_dates),
        "metrics": aggregate,
        "daily": daily,
        "score": score,
        "scoreTimeline": score_timeline,
        "config": config,
        "dataQuality": {
            "rangeDays": len(dates),
            "includedDays": len(included_dates),
            "excludedDays": len(excluded_dates),
            "unrecordedDays": len(unrecorded_dates),
            "awakeRecordedDays": sum(1 for item in day_metrics if item.get("awakeMinutes") is not None),
            "taskDays": sum(1 for item in day_metrics if item.get("taskMinutes", 0) > 0),
            "sessionDays": sum(1 for item in day_metrics if item.get("totalClockMinutes", 0) > 0),
            "scoreableDays": sum(1 for item in daily_scores if item.get("score") is not None),
            "zeroScoreDays": sum(1 for item in daily_scores if item.get("score") == 0),
            "unconfiguredFactors": [
                key for key, value in config["standardDay"].items() if value is None
            ],
        },
    }


def validate_range(start_date: Any, end_date: Any) -> tuple[str, str]:
    start = str(start_date or "")
    end = str(end_date or "")
    date.fromisoformat(start)
    date.fromisoformat(end)
    if start > end:
        raise ValueError("startDate must not be later than endDate")
    return start, end
