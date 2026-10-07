"""
学习追踪器 - Flask 后端
提供 API 接口供前端读写学习数据（JSON 文件持久化）
"""

import json
import os
import socket
import tempfile
import threading
from contextlib import contextmanager
from datetime import date, timedelta
from functools import wraps
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory

if os.name == "nt":
    import msvcrt
else:
    import fcntl

from analysis_formula import calculate_range, normalize_config, validate_range

PROJECT_DIR = Path(__file__).resolve().parent
DATA_FOLDER_NAME = "学习追踪器数据"
ANALYSIS_CONFIG_KEY = "__analysisConfig__"
ANALYSIS_CARD_COLLECTION_VERSION = 2
MAX_ANALYSIS_CARDS = 50
MAX_ANALYSIS_TRACKING_CARDS = 100


def normalize_analysis_card_collection(value: object) -> dict:
    """Normalize benchmark and date-range tracking cards."""

    source = value if isinstance(value, dict) else {}
    raw_cards = source.get("cards")
    cards: list[dict] = []
    seen_ids: set[str] = set()

    if isinstance(raw_cards, list):
        for index, raw_card in enumerate(raw_cards[:MAX_ANALYSIS_CARDS]):
            if not isinstance(raw_card, dict):
                continue
            candidate_id = str(raw_card.get("id") or "").strip()[:80]
            if not candidate_id or candidate_id in seen_ids:
                candidate_id = f"card-{index + 1}"
                suffix = 2
                while candidate_id in seen_ids:
                    candidate_id = f"card-{index + 1}-{suffix}"
                    suffix += 1
            seen_ids.add(candidate_id)
            name = str(raw_card.get("name") or "").strip()[:60] or "未命名标准"
            cards.append({
                "id": candidate_id,
                "name": name,
                "config": normalize_config(raw_card.get("config")),
            })
    elif isinstance(source.get("standardDay"), dict) or isinstance(source.get("taskStandards"), list):
        # The initial implementation stored one config directly. Keep it as a
        # usable card so existing work is preserved after this upgrade.
        cards.append({
            "id": "legacy-standard",
            "name": "未命名标准",
            "config": normalize_config(source),
        })

    requested_active_id = str(source.get("activeCardId") or "").strip()
    active_card_id = requested_active_id if requested_active_id in seen_ids else (cards[0]["id"] if cards else "")

    tracking_cards: list[dict] = []
    seen_tracking_ids: set[str] = set()
    raw_tracking_cards = source.get("trackingCards")
    if isinstance(raw_tracking_cards, list):
        for index, raw_card in enumerate(raw_tracking_cards[:MAX_ANALYSIS_TRACKING_CARDS]):
            if not isinstance(raw_card, dict):
                continue
            start_date = str(raw_card.get("startDate") or "").strip()
            end_date = str(raw_card.get("endDate") or "").strip()
            try:
                start = date.fromisoformat(start_date)
                end = date.fromisoformat(end_date)
            except (TypeError, ValueError):
                continue
            if start > end:
                continue
            candidate_id = str(raw_card.get("id") or "").strip()[:80]
            if not candidate_id or candidate_id in seen_tracking_ids:
                candidate_id = f"tracking-{index + 1}"
                suffix = 2
                while candidate_id in seen_tracking_ids:
                    candidate_id = f"tracking-{index + 1}-{suffix}"
                    suffix += 1
            seen_tracking_ids.add(candidate_id)
            tracking_cards.append({
                "id": candidate_id,
                "name": str(raw_card.get("name") or "").strip()[:60] or "未命名追踪",
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
                "includeExcluded": bool(raw_card.get("includeExcluded", False)),
                "dayTypeFilter": str(raw_card.get("dayTypeFilter") or "").strip()[:60],
                "config": normalize_config(raw_card.get("config")),
                "createdAt": str(raw_card.get("createdAt") or "").strip()[:80],
                "updatedAt": str(raw_card.get("updatedAt") or "").strip()[:80],
            })

    return {
        "schemaVersion": ANALYSIS_CARD_COLLECTION_VERSION,
        "activeCardId": active_card_id,
        "cards": cards,
        "trackingCards": tracking_cards,
    }


def add_existing_directory(candidates: list[Path], value: str | Path | None) -> None:
    if not value:
        return
    directory = Path(value).expanduser()
    if directory.is_dir() and directory not in candidates:
        candidates.append(directory)


def windows_drive_roots() -> list[Path]:
    if os.name != "nt":
        return []
    import ctypes

    mask = ctypes.windll.kernel32.GetLogicalDrives()
    return [Path(f"{chr(letter)}:/") for letter in range(65, 91) if mask & (1 << (letter - 65))]


def find_onedrive_roots() -> list[Path]:
    """发现当前机器上的 OneDrive 根目录，不依赖固定盘符。"""
    candidates: list[Path] = []

    # 项目随 OneDrive 移动时，优先使用其路径链上的 OneDrive 根目录。
    for directory in (PROJECT_DIR, *PROJECT_DIR.parents):
        if directory.name.casefold() == "onedrive":
            add_existing_directory(candidates, directory)
            break

    add_existing_directory(candidates, os.environ.get("TRACKER_ONEDRIVE_DIR"))
    for variable in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        add_existing_directory(candidates, os.environ.get(variable))
    add_existing_directory(candidates, Path.home() / "OneDrive")

    # 环境变量未配置时，只检查各已挂载盘符根目录的 OneDrive 文件夹。
    for drive_root in windows_drive_roots():
        add_existing_directory(candidates, drive_root / "OneDrive")
    return candidates


def resolve_data_dir(onedrive_roots: list[Path]) -> Path:
    configured = os.environ.get("TRACKER_DATA_DIR")
    if configured:
        return Path(configured).expanduser()

    candidates = [root / DATA_FOLDER_NAME for root in onedrive_roots]
    # 有多个 OneDrive 时，优先使用实际包含主数据文件的目录。
    for directory in candidates:
        if (directory / "study_data.json").is_file():
            return directory
    for directory in candidates:
        if directory.is_dir():
            return directory
    if candidates:
        return candidates[0]

    # 未发现 OneDrive 时仍可启动，但明确提示数据未同步到 OneDrive。
    print("⚠️  未找到 OneDrive，暂时将数据存入项目目录。")
    return PROJECT_DIR / DATA_FOLDER_NAME


ONEDRIVE_ROOTS = find_onedrive_roots()

app = Flask(__name__, static_folder=PROJECT_DIR, static_url_path="")

# ── 先定位 OneDrive，再定位其中的数据目录 ──────────────────────
DATA_DIR = resolve_data_dir(ONEDRIVE_ROOTS)
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_FILE = DATA_DIR / "study_data.json"
SNAPSHOT_FILE = DATA_DIR / "draft_snapshot.json"
DATA_LOCK_FILE = DATA_DIR / ".study_data.lock"
_DATA_THREAD_LOCK = threading.RLock()
_DATA_LOCK_STATE = threading.local()
_SNAPSHOT_THREAD_LOCK = threading.RLock()
print(f"📁 学习数据目录: {DATA_DIR}")

# 自动迁移：若当前数据目录为空，再从项目目录或其他已发现的 OneDrive 目录迁移。
_OLD_DATA_SOURCES = [PROJECT_DIR / "study_data.json"]
_OLD_DATA_SOURCES.extend(root / DATA_FOLDER_NAME / "study_data.json" for root in ONEDRIVE_ROOTS)
for _old_data in _OLD_DATA_SOURCES:
    if _old_data != DATA_FILE and _old_data.is_file() and not DATA_FILE.exists():
        import shutil
        shutil.move(_old_data, DATA_FILE)
        print(f"📦 已将旧数据迁移到: {DATA_FILE}")
        break


# ── 数据读写 ──────────────────────────────────────────────────
def _acquire_process_lock(lock_file) -> None:
    if os.name == "nt":
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
    else:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)


def _release_process_lock(lock_file) -> None:
    if os.name == "nt":
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@contextmanager
def data_file_lock():
    """Serialize complete data transactions across threads and local processes."""
    with _DATA_THREAD_LOCK:
        depth = getattr(_DATA_LOCK_STATE, "depth", 0)
        if depth == 0:
            lock_file = open(DATA_LOCK_FILE, "a+b")
            try:
                _acquire_process_lock(lock_file)
            except Exception:
                lock_file.close()
                raise
            _DATA_LOCK_STATE.lock_file = lock_file
        _DATA_LOCK_STATE.depth = depth + 1
        try:
            yield
        finally:
            remaining = _DATA_LOCK_STATE.depth - 1
            if remaining:
                _DATA_LOCK_STATE.depth = remaining
            else:
                lock_file = _DATA_LOCK_STATE.lock_file
                try:
                    _release_process_lock(lock_file)
                finally:
                    lock_file.close()
                    del _DATA_LOCK_STATE.lock_file
                    del _DATA_LOCK_STATE.depth


def data_transaction(view_function):
    """Hold the data lock for an entire read-modify-write API request."""
    @wraps(view_function)
    def wrapped(*args, **kwargs):
        with data_file_lock():
            return view_function(*args, **kwargs)

    return wrapped


def atomic_write_json(path: Path, payload: object) -> None:
    """Durably write JSON beside its target, then replace the target atomically."""
    descriptor, temp_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as temp_file:
            json.dump(payload, temp_file, ensure_ascii=False, indent=2)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def load_data() -> dict:
    with data_file_lock():
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        return {}


def save_data(data: dict) -> None:
    with data_file_lock():
        atomic_write_json(DATA_FILE, data)


def load_snapshot() -> dict:
    with _SNAPSHOT_THREAD_LOCK:
        if os.path.exists(SNAPSHOT_FILE):
            with open(SNAPSHOT_FILE, "r", encoding="utf-8") as f:
                payload = json.load(f)
                return payload if isinstance(payload, dict) else {}
        return {}


def save_snapshot(payload: dict) -> None:
    with _SNAPSHOT_THREAD_LOCK:
        atomic_write_json(SNAPSHOT_FILE, payload)


def parse_minutes(value) -> int | None:
    try:
      hour, minute = str(value or "").split(":", 1)
      hour_num = int(hour)
      minute_num = int(minute)
    except (TypeError, ValueError):
      return None
    if not (0 <= hour_num <= 23 and 0 <= minute_num <= 59):
      return None
    return hour_num * 60 + minute_num


def session_segments(session: dict) -> list[tuple[int, int]]:
    start = parse_minutes(session.get("startTime"))
    end = parse_minutes(session.get("endTime"))
    if start is None or end is None or start == end:
      return []
    if end > start:
      return [(start, end)]
    return [(start, 1440), (0, end)]


def sessions_overlap(first: dict, second: dict) -> bool:
    return any(
        first_start < second_end and second_start < first_end
        for first_start, first_end in session_segments(first)
        for second_start, second_end in session_segments(second)
    )


def parse_port(value, fallback: int = 5000) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return fallback
    return port if 1 <= port <= 65535 else fallback


def port_available(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((host, port))
        return True
    except OSError:
        return False


def find_available_port(preferred_port: int, host: str = "0.0.0.0", scan_count: int = 100) -> int:
    for port in range(preferred_port, min(65536, preferred_port + max(1, scan_count))):
        if port_available(host, port):
            return port
    raise RuntimeError(f"未找到可用端口：已检查 {preferred_port} 到 {preferred_port + scan_count - 1}")


def has_any_record_content(day: dict) -> bool:
    """只要某天含任一实际内容，就不再把它视为未记录日。"""
    if not isinstance(day, dict):
        return False
    for value in day.values():
        if value is None or value is False:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, (list, dict, tuple, set)) and not value:
            continue
        return True
    return False


def _is_valid_iso_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


# ── 页面入口 ─────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(PROJECT_DIR, "index.html")


# ── API ──────────────────────────────────────────────────────

@app.route("/api/data", methods=["GET"])
def get_all_data():
    """返回学习记录，不包含独立保存的分析标准。"""
    data = load_data()
    if not isinstance(data, dict):
        return jsonify(data)
    return jsonify({key: value for key, value in data.items() if key != ANALYSIS_CONFIG_KEY})


@app.route("/api/analysis/config", methods=["GET"])
def get_analysis_config():
    """返回分析标准卡片集合；尚未配置时返回空集合。"""
    data = load_data()
    saved_config = data.get(ANALYSIS_CONFIG_KEY) if isinstance(data, dict) else None
    return jsonify(normalize_analysis_card_collection(saved_config))


@app.route("/api/analysis/config", methods=["PUT"])
@data_transaction
def put_analysis_config():
    """持久化分析标准卡片集合，不修改任何日期记录。"""
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid JSON"}), 400
    data = load_data()
    if not isinstance(data, dict):
        return jsonify({"error": "study data must be a JSON object"}), 400
    collection = normalize_analysis_card_collection(payload)
    data[ANALYSIS_CONFIG_KEY] = collection
    save_data(data)
    return jsonify({"ok": True, "collection": collection})


@app.route("/api/analysis/evaluate", methods=["POST"])
def evaluate_analysis_range():
    """按闭区间汇总日期记录，并使用无上限的加权几何平均评分。"""
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid JSON"}), 400
    try:
        start_date, end_date = validate_range(payload.get("startDate"), payload.get("endDate"))
    except (TypeError, ValueError):
        return jsonify({"error": "startDate and endDate must be ISO dates, and startDate cannot be later than endDate"}), 400

    data = load_data()
    if not isinstance(data, dict):
        return jsonify({"error": "study data must be a JSON object"}), 400
    if "config" in payload and not isinstance(payload["config"], dict):
        return jsonify({"error": "config must be a JSON object when provided"}), 400
    config = payload.get("config") if "config" in payload else data.get(ANALYSIS_CONFIG_KEY)
    result = calculate_range(
        data,
        start_date,
        end_date,
        config=config,
        include_excluded=bool(payload.get("includeExcluded", False)),
        day_type_filter=str(payload.get("dayTypeFilter") or "").strip(),
    )
    return jsonify(result)


@app.route("/api/data", methods=["POST"])
@data_transaction
def set_all_data():
    """整体替换数据（导入 / 清空）"""
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid JSON"}), 400
    # 分析标准由专用接口管理，导入或常规自动保存都不能覆盖评分策略。
    existing = load_data()
    data = {key: value for key, value in payload.items() if key != ANALYSIS_CONFIG_KEY}
    if isinstance(existing, dict) and ANALYSIS_CONFIG_KEY in existing:
        data[ANALYSIS_CONFIG_KEY] = existing[ANALYSIS_CONFIG_KEY]
    save_data(data)
    return jsonify({"ok": True, "days": len(payload)})


@app.route("/api/navigation/last-unrecorded-day", methods=["GET"])
def get_last_unrecorded_day():
    """返回最后一个含实际内容日期的下一天，即真正完全空白的日期。"""
    data = load_data()
    recorded_dates = sorted(
        date_str
        for date_str, day in data.items()
        if isinstance(date_str, str)
        and len(date_str) == 10
        and date_str[4] == "-"
        and date_str[7] == "-"
        and _is_valid_iso_date(date_str)
        and has_any_record_content(day)
    )
    if not recorded_dates:
        return jsonify({"ok": True, "found": False, "date": None, "lastRecordedDate": None})
    last_recorded_date = recorded_dates[-1]
    target_date = (date.fromisoformat(last_recorded_date) + timedelta(days=1)).isoformat()
    return jsonify({
        "ok": True,
        "found": True,
        "date": target_date,
        "lastRecordedDate": last_recorded_date,
    })


@app.route("/api/snapshot", methods=["GET"])
def get_snapshot():
    """返回跨浏览器共享的最后一次界面快照"""
    return jsonify(load_snapshot())


@app.route("/api/snapshot", methods=["PUT", "POST"])
def put_snapshot():
    """独立保存界面与未提交表单快照，不覆盖学习数据"""
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid JSON"}), 400
    save_snapshot(payload)
    return jsonify({"ok": True, "updatedAt": payload.get("updatedAt")})


@app.route("/api/snapshot", methods=["DELETE"])
def delete_snapshot():
    """清除共享界面快照"""
    with _SNAPSHOT_THREAD_LOCK:
        if os.path.exists(SNAPSHOT_FILE):
            os.remove(SNAPSHOT_FILE)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>", methods=["PUT"])
@data_transaction
def put_day(date_str: str):
    """整体更新某天数据"""
    payload = request.get_json(force=True, silent=True)
    if payload is None:
        return jsonify({"error": "invalid JSON"}), 400
    data = load_data()
    data[date_str] = payload
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/sleep", methods=["PUT"])
@data_transaction
def put_sleep(date_str: str):
    """保存作息时间、对应备注及日期类型评分属性"""
    payload = request.get_json(force=True, silent=True) or {}
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    day["wakeTime"] = payload.get("wakeTime", day.get("wakeTime", ""))
    day["sleepTime"] = payload.get("sleepTime", day.get("sleepTime", ""))
    day["wakeNote"] = str(payload.get("wakeNote", day.get("wakeNote", "")) or "")
    day["sleepNote"] = str(payload.get("sleepNote", day.get("sleepNote", "")) or "")
    if "dayType" in payload:
        day["dayType"] = str(payload["dayType"] or "").strip()
    if not day.get("dayType"):
        day["excludeFromRating"] = False
    elif "excludeFromRating" in payload:
        day["excludeFromRating"] = bool(day.get("dayType")) and bool(payload["excludeFromRating"])
    day.pop("specialDay", None)
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/dayType", methods=["PUT"])
@data_transaction
def put_day_type(date_str: str):
    """独立保存日期类型与范围汇总排除标记"""
    payload = request.get_json(force=True, silent=True) or {}
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    day["dayType"] = str(payload.get("dayType", "")).strip()
    day["excludeFromRating"] = bool(day["dayType"]) and bool(payload.get("excludeFromRating", False))
    day.pop("specialDay", None)
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/dayNote", methods=["PUT"])
@data_transaction
def put_day_note(date_str: str):
    """保存当天备注"""
    payload = request.get_json(force=True, silent=True) or {}
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    day["dayNote"] = payload.get("dayNote", "")
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/sessions", methods=["POST"])
@data_transaction
def add_session(date_str: str):
    """添加一个专注时段"""
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "invalid JSON"}), 400
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    conflict = next(
        (session for session in day.get("sessions", []) if sessions_overlap(payload, session)),
        None,
    )
    if conflict:
        return jsonify({
            "error": "session_overlap",
            "startTime": conflict.get("startTime", ""),
            "endTime": conflict.get("endTime", ""),
        }), 409
    day.setdefault("sessions", []).append(payload)
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/sessions/<session_id>", methods=["DELETE"])
@data_transaction
def delete_session(date_str: str, session_id: str):
    """删除某个专注时段"""
    data = load_data()
    day = data.get(date_str, {})
    day["sessions"] = [s for s in day.get("sessions", []) if s.get("id") != session_id]
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/tasks", methods=["POST"])
@data_transaction
def add_task(date_str: str):
    """添加一个任务"""
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "invalid JSON"}), 400
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    day.setdefault("tasks", []).append(payload)
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/tasks/<task_id>", methods=["DELETE"])
@data_transaction
def delete_task(date_str: str, task_id: str):
    """删除某个任务"""
    data = load_data()
    day = data.get(date_str, {})
    day["tasks"] = [t for t in day.get("tasks", []) if t.get("id") != task_id]
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/day/move", methods=["POST"])
@data_transaction
def move_day_items():
    """将某天选中的作息、备注、时段和任务原子迁移到另一天"""
    payload = request.get_json(force=True, silent=True) or {}
    source_date = str(payload.get("sourceDate", ""))
    target_date = str(payload.get("targetDate", ""))
    mode = str(payload.get("mode", "append"))
    selection = payload.get("selection", {})
    if not source_date or not target_date or source_date == target_date:
        return jsonify({"error": "invalid dates"}), 400
    if mode not in ("append", "overwrite"):
        return jsonify({"error": "invalid mode"}), 400
    if not isinstance(selection, dict):
        return jsonify({"error": "invalid selection"}), 400

    data = load_data()
    source_day = data.get(source_date)
    if not isinstance(source_day, dict):
        return jsonify({"error": "source day not found"}), 400

    empty_day = {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []}
    target_day = data.setdefault(target_date, dict(empty_day))
    session_ids = {str(value) for value in selection.get("sessionIds", [])}
    task_ids = {str(value) for value in selection.get("taskIds", [])}
    source_sessions = list(source_day.get("sessions", []))
    source_tasks = list(source_day.get("tasks", []))
    selected_sessions = [item for item in source_sessions if str(item.get("id")) in session_ids]
    selected_tasks = [item for item in source_tasks if str(item.get("id")) in task_ids]

    if mode == "overwrite":
        # 覆盖模式是整日覆盖：先清空目标日全部原有数据，再写入本次所选项目。
        target_day = {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []}
        data[target_date] = target_day

    moved = 0
    replaced_target_sessions = 0
    if selection.get("wakeTime") and (source_day.get("wakeTime") or source_day.get("wakeNote")):
        target_day["wakeTime"] = source_day.get("wakeTime", "")
        target_day["wakeNote"] = source_day.get("wakeNote", "")
        source_day["wakeTime"] = ""
        source_day["wakeNote"] = ""
        moved += 1
    if selection.get("dayNote") and source_day.get("dayNote"):
        target_day["dayNote"] = source_day["dayNote"]
        source_day["dayNote"] = ""
        moved += 1
    if selected_sessions:
        if mode == "overwrite":
            target_day["sessions"] = selected_sessions
        else:
            # 追加模式保留目标日原有数据；只有与迁入时段重叠的目标日旧时段会被删除，避免产生时间冲突。
            target_sessions = list(target_day.get("sessions", []))
            kept_sessions = [
                session for session in target_sessions
                if not any(sessions_overlap(session, incoming) for incoming in selected_sessions)
            ]
            replaced_target_sessions = len(target_sessions) - len(kept_sessions)
            target_day["sessions"] = kept_sessions + selected_sessions
        source_day["sessions"] = [
            item for item in source_sessions if str(item.get("id")) not in session_ids
        ]
        moved += len(selected_sessions)
    if selected_tasks:
        target_day["tasks"] = (
            selected_tasks
            if mode == "overwrite"
            else list(target_day.get("tasks", [])) + selected_tasks
        )
        source_day["tasks"] = [
            item for item in source_tasks if str(item.get("id")) not in task_ids
        ]
        moved += len(selected_tasks)
    if selection.get("sleepTime") and (source_day.get("sleepTime") or source_day.get("sleepNote")):
        target_day["sleepTime"] = source_day.get("sleepTime", "")
        target_day["sleepNote"] = source_day.get("sleepNote", "")
        source_day["sleepTime"] = ""
        source_day["sleepNote"] = ""
        moved += 1

    if moved == 0:
        return jsonify({"error": "selection has no available data"}), 400
    data[source_date] = source_day
    save_data(data)
    return jsonify({
        "ok": True,
        "moved": moved,
        "movedSessions": len(selected_sessions),
        "movedTasks": len(selected_tasks),
        "replacedTargetSessions": replaced_target_sessions,
        "sourceDay": source_day,
        "targetDay": target_day,
    })


if __name__ == "__main__":
    host = os.environ.get("TRACKER_HOST", "0.0.0.0")
    preferred_port = parse_port(os.environ.get("TRACKER_PORT") or os.environ.get("PORT"), 5000)
    scan_count = parse_port(os.environ.get("TRACKER_PORT_SCAN_COUNT"), 100)
    port = find_available_port(preferred_port, host, scan_count)
    if port != preferred_port:
        print(f"⚠️  端口 {preferred_port} 已被占用，已自动切换到 {port}")
    print(f"🚀  学习追踪器启动: http://127.0.0.1:{port}")
    app.run(debug=True, host=host, port=port, use_reloader=False)
