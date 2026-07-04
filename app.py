"""
学习追踪器 - Flask 后端
提供 API 接口供前端读写学习数据（JSON 文件持久化）
"""

import json
import os
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder=".", static_url_path="")

# ── 数据存储到 OneDrive 云盘（自动适配任何电脑的用户名）────────
DATA_DIR = os.path.join(os.path.expanduser("~"), "OneDrive", "学习追踪器数据")
os.makedirs(DATA_DIR, exist_ok=True)
DATA_FILE = os.path.join(DATA_DIR, "study_data.json")
SNAPSHOT_FILE = os.path.join(DATA_DIR, "draft_snapshot.json")

# 自动迁移：如果项目目录下有旧数据文件，搬到 OneDrive
_OLD_DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "study_data.json")
if os.path.exists(_OLD_DATA) and not os.path.exists(DATA_FILE):
    import shutil
    shutil.move(_OLD_DATA, DATA_FILE)
    print(f"📦 已将旧数据迁移到 OneDrive: {DATA_FILE}")


# ── 数据读写 ──────────────────────────────────────────────────
def load_data() -> dict:
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_data(data: dict) -> None:
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_snapshot() -> dict:
    if os.path.exists(SNAPSHOT_FILE):
        with open(SNAPSHOT_FILE, "r", encoding="utf-8") as f:
            payload = json.load(f)
            return payload if isinstance(payload, dict) else {}
    return {}


def save_snapshot(payload: dict) -> None:
    temp_file = SNAPSHOT_FILE + ".tmp"
    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(temp_file, SNAPSHOT_FILE)


# ── 页面入口 ─────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(".", "index.html")


# ── API ──────────────────────────────────────────────────────

@app.route("/api/data", methods=["GET"])
def get_all_data():
    """返回全部学习数据"""
    return jsonify(load_data())


@app.route("/api/data", methods=["POST"])
def set_all_data():
    """整体替换数据（导入 / 清空）"""
    payload = request.get_json(force=True, silent=True)
    if payload is None:
        return jsonify({"error": "invalid JSON"}), 400
    save_data(payload)
    return jsonify({"ok": True, "days": len(payload)})


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
    if os.path.exists(SNAPSHOT_FILE):
        os.remove(SNAPSHOT_FILE)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>", methods=["GET"])
def get_day(date_str: str):
    """返回某天数据"""
    data = load_data()
    day = data.get(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    return jsonify(day)


@app.route("/api/data/<date_str>", methods=["PUT"])
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
def put_sleep(date_str: str):
    """保存作息时间（含特殊天标记）"""
    payload = request.get_json(force=True, silent=True) or {}
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    day["wakeTime"] = payload.get("wakeTime", day.get("wakeTime", ""))
    day["sleepTime"] = payload.get("sleepTime", day.get("sleepTime", ""))
    if "dayType" in payload:
        day["dayType"] = payload["dayType"]
    # 特殊天标记
    if "specialDay" in payload:
        day["specialDay"] = payload["specialDay"]
    if "excludeFromRating" in payload:
        day["excludeFromRating"] = payload["excludeFromRating"]
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/dayNote", methods=["PUT"])
def put_day_note(date_str: str):
    """保存当天备注"""
    payload = request.get_json(force=True, silent=True) or {}
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    day["dayNote"] = payload.get("dayNote", "")
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/sessions", methods=["POST"])
def add_session(date_str: str):
    """添加一个专注时段"""
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "invalid JSON"}), 400
    data = load_data()
    day = data.setdefault(date_str, {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []})
    day.setdefault("sessions", []).append(payload)
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/sessions/<session_id>", methods=["DELETE"])
def delete_session(date_str: str, session_id: str):
    """删除某个专注时段"""
    data = load_data()
    day = data.get(date_str, {})
    day["sessions"] = [s for s in day.get("sessions", []) if s.get("id") != session_id]
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/data/<date_str>/tasks", methods=["POST"])
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
def delete_task(date_str: str, task_id: str):
    """删除某个任务"""
    data = load_data()
    day = data.get(date_str, {})
    day["tasks"] = [t for t in day.get("tasks", []) if t.get("id") != task_id]
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/day/move", methods=["POST"])
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

    target_day = data.setdefault(
        target_date,
        {"wakeTime": "", "sleepTime": "", "sessions": [], "tasks": []},
    )
    session_ids = {str(value) for value in selection.get("sessionIds", [])}
    task_ids = {str(value) for value in selection.get("taskIds", [])}
    source_sessions = list(source_day.get("sessions", []))
    source_tasks = list(source_day.get("tasks", []))
    selected_sessions = [item for item in source_sessions if str(item.get("id")) in session_ids]
    selected_tasks = [item for item in source_tasks if str(item.get("id")) in task_ids]

    moved = 0
    if selection.get("wakeTime") and source_day.get("wakeTime"):
        target_day["wakeTime"] = source_day["wakeTime"]
        source_day["wakeTime"] = ""
        moved += 1
    if selection.get("dayNote") and source_day.get("dayNote"):
        target_day["dayNote"] = source_day["dayNote"]
        source_day["dayNote"] = ""
        moved += 1
    if selected_sessions:
        target_day["sessions"] = (
            selected_sessions
            if mode == "overwrite"
            else list(target_day.get("sessions", [])) + selected_sessions
        )
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
    if selection.get("sleepTime") and source_day.get("sleepTime"):
        target_day["sleepTime"] = source_day["sleepTime"]
        source_day["sleepTime"] = ""
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
        "sourceDay": source_day,
        "targetDay": target_day,
    })


@app.route("/api/export", methods=["GET"])
def export_json():
    """以附件形式下载全部数据"""
    from flask import Response
    data = load_data()
    today = datetime.now().strftime("%Y-%m-%d")
    filename = f"学习数据_{today}.json"
    content = json.dumps(data, ensure_ascii=False, indent=2)
    return Response(
        content,
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"}
    )


if __name__ == "__main__":
    print("🚀  学习追踪器启动: http://127.0.0.1:5000")
    app.run(debug=True, host="0.0.0.0", port=5000)
