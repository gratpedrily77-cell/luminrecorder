"""Chapter question totals are enforced only while calibration is enabled."""

import math
import sys
from collections import defaultdict

MAX_SAFE_INTEGER = 9007199254740991


class ChapterLimitError(ValueError):
    pass


def uses_chapter_question_counts(template):
    return bool(template.get("chapterQuantityOnly") and template.get("quantityEnabled")
                and template.get("namedItemEnabled", template.get("ordinalEnabled")))


def is_question_count(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and 0 <= value <= MAX_SAFE_INTEGER and float(value).is_integer())


def template_tasks(data, template, templates):
    for date_str, day in data.items():
        if date_str.startswith("__") or not isinstance(day, dict):
            continue
        for task in day.get("tasks", []):
            if not isinstance(task, dict):
                continue
            template_id = task.get("templateId")
            if not any(item.get("id") == template_id for item in templates):
                matches = [item for item in templates if item.get("activityType")
                           and item["activityType"] == task.get("activityType")]
                template_id = matches[0].get("id") if len(matches) == 1 else None
            if template_id == template.get("id"):
                yield task


def chapter_state(template, data, templates):
    # Existing legacy violations must not prevent unrelated saves. Revalidate
    # whenever limits, chapter associations, or the task quantities change.
    return (
        uses_chapter_question_counts(template),
        template.get("namedItems"),
        [(task.get("id"), task.get("quantity"), task.get("namedItemAllocations"))
         for task in template_tasks(data, template, templates)],
    )


def validate_chapter_limits(data, previous=None):
    templates = data.get("__taskTemplates__", [])
    previous_templates = (previous or {}).get("__taskTemplates__", [])
    for template in templates:
        if not uses_chapter_question_counts(template):
            continue
        old = next((item for item in previous_templates if item.get("id") == template.get("id")), None)
        if old and chapter_state(old, previous, previous_templates) == chapter_state(template, data, templates):
            continue
        items = template.get("namedItems", [])
        active = [item for item in items if not item.get("archived")]
        if (not active or any(not is_question_count(item.get("questionCount")) for item in active)
                or not 0 < sum(item["questionCount"] for item in active) <= MAX_SAFE_INTEGER):
            raise ChapterLimitError("开启“章节仅作题数标定”后，每个活动章节都必须填写非负整数总题数，合计必须大于 0。")
        quantities = defaultdict(float)
        records = defaultdict(int)
        for task in template_tasks(data, template, templates):
            label = task.get("name") or "未命名任务"
            quantity = task.get("quantity")
            if quantity is not None and not is_question_count(quantity):
                raise ChapterLimitError(f"任务“{label}”的题数必须是非负整数。")
            allocations = task.get("namedItemAllocations") or []
            if not allocations and quantity:
                raise ChapterLimitError(f"任务“{label}”缺少章节关联，请先为它选择章节。")
            all_unassigned = all(item.get("quantity") is None for item in allocations)
            values = [(quantity / len(allocations) if all_unassigned and quantity is not None
                       else (item.get("quantity") or 0)) for item in allocations]
            if any(not isinstance(value, (int, float)) or isinstance(value, bool)
                   or not math.isfinite(value) or value < 0 for value in values):
                raise ChapterLimitError(f"任务“{label}”的章节题数无效。")
            assigned = sum(values)
            # Match the frontend's tolerance for equal-share floating point arithmetic.
            rounding = sys.float_info.epsilon * max(1, assigned, quantity or 0) * max(1, len(values)) * 4
            if quantity is not None and abs(assigned - quantity) > rounding:
                raise ChapterLimitError(f"任务“{label}”的章节题数合计必须等于任务总题数。")
            for allocation, value in zip(allocations, values):
                item = next((item for item in items if item.get("id") == allocation.get("itemId")), None)
                if item is None:
                    name = str(allocation.get("itemName") or "").strip().lower()
                    item = next((item for item in items if str(item.get("name") or "").strip().lower() == name), None)
                if item is None:
                    raise ChapterLimitError(f"章节“{allocation.get('itemName', '')}”尚未设置总题数，请先在共享章节库添加并标定。")
                if item.get("questionCount") is None and item.get("archived"):
                    continue
                if not is_question_count(item.get("questionCount")):
                    raise ChapterLimitError(f"章节“{item.get('name', '')}”的总题数无效，请先在共享章节库修正。")
                quantities[item["id"]] += value
                records[item["id"]] += 1
        for item in items:
            quantity = quantities[item["id"]]
            limit = item.get("questionCount")
            if limit is None:
                continue
            rounding = sys.float_info.epsilon * max(1, quantity, limit) * max(1, records[item["id"]]) * 4
            if quantity - limit > rounding:
                raise ChapterLimitError(
                    f"章节“{item['name']}”累计题数不能超过 {limit:g} 题；"
                    f"保存后为 {quantity:g} 题，超出 {quantity - limit:g} 题。")
