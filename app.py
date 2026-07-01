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
    # 特殊天标记
    if "specialDay" in payload:
        day["specialDay"] = payload["specialDay"]
    if "specialDayReason" in payload:
        day["specialDayReason"] = payload["specialDayReason"]
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


# ── AI 暂存缓存 ─────────────────────────────────────────────
CACHE_FILE = os.path.join(DATA_DIR, "ai_cache.json")


def load_cache() -> dict:
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_cache(data: dict) -> None:
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@app.route("/api/cache", methods=["GET"])
def get_cache():
    """获取 AI 暂存缓存"""
    cache = load_cache()
    # 自动清理：超过24小时的缓存视为过期
    ts = cache.get("timestamp", 0)
    if ts and (datetime.now().timestamp() - ts) > 86400:
        save_cache({})
        return jsonify({})
    return jsonify(cache)


@app.route("/api/cache", methods=["POST"])
def set_cache():
    """保存 AI 暂存缓存（单份，覆盖写入）"""
    payload = request.get_json(force=True, silent=True)
    if payload is None:
        return jsonify({"error": "invalid JSON"}), 400
    payload["timestamp"] = datetime.now().timestamp()
    save_cache(payload)
    return jsonify({"ok": True})


@app.route("/api/cache", methods=["DELETE"])
def clear_cache():
    """清除 AI 暂存缓存"""
    save_cache({})
    return jsonify({"ok": True})


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
