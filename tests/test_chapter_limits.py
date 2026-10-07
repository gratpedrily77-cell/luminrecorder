import copy
import importlib
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chapter_limits import ChapterLimitError, validate_chapter_limits


def template(enabled=True, count=155):
    return {"id": "math", "activityType": "学习/数学", "namedItemEnabled": True,
            "quantityEnabled": True, "chapterQuantityOnly": enabled,
            "namedItems": [{"id": "a", "name": "第一章", "questionCount": count},
                           {"id": "b", "name": "第二章", "questionCount": 200}]}


def task(quantity, task_id="old", chapter="a"):
    return {"id": task_id, "name": task_id, "templateId": "math", "quantity": quantity,
            "namedItemAllocations": [{"itemId": chapter, "itemName": "第一章" if chapter == "a" else "第二章",
                                     "quantity": quantity, "minutes": 30}]}


def data(*tasks, enabled=True, count=155):
    return {"__taskTemplates__": [template(enabled, count)], "2026-10-01": {"tasks": list(tasks)}}


class ChapterLimitsTest(unittest.TestCase):
    def test_exact_total_and_cross_date_overrun(self):
        validate_chapter_limits(data(task(100), task(55, "next")))
        candidate = data(task(100))
        candidate["2026-10-07"] = {"tasks": [task(56, "next")]}
        with self.assertRaisesRegex(ChapterLimitError, "不能超过 155.*156.*超出 1"):
            validate_chapter_limits(candidate)

    def test_disabled_calibration_does_not_enforce_stored_counts(self):
        validate_chapter_limits(data(task(1000), enabled=False))

    def test_edit_replaces_contribution(self):
        previous = data(task(100), task(55, "next"))
        validate_chapter_limits(data(task(99), task(55, "next")), previous)
        with self.assertRaisesRegex(ChapterLimitError, "超出 1"):
            validate_chapter_limits(data(task(101), task(55, "next")), previous)

    def test_calibration_activation_and_reduction_check_history(self):
        with self.assertRaises(ChapterLimitError):
            validate_chapter_limits(data(task(156)), data(task(156), enabled=False))
        with self.assertRaises(ChapterLimitError):
            validate_chapter_limits(data(task(100), count=99), data(task(100)))

    def test_multi_chapter_overrun(self):
        current = task(12, "next")
        current["namedItemAllocations"] = [task(6)["namedItemAllocations"][0], task(6, chapter="b")["namedItemAllocations"][0]]
        with self.assertRaisesRegex(ChapterLimitError, "第一章.*超出 1"):
            validate_chapter_limits(data(task(150), current))

    def test_equal_share_rounding(self):
        current = task(155)
        current["namedItemAllocations"] *= 3
        for allocation in current["namedItemAllocations"]:
            allocation["quantity"] = 155 / 3
        validate_chapter_limits(data(current))

    def test_allocation_mismatch_and_unknown_chapter(self):
        current = task(156)
        current["namedItemAllocations"][0]["quantity"] = 1
        with self.assertRaisesRegex(ChapterLimitError, "合计必须等于"):
            validate_chapter_limits(data(current))
        current = task(1, chapter="new")
        current["namedItemAllocations"][0]["itemName"] = "第三章"
        with self.assertRaisesRegex(ChapterLimitError, "尚未设置"):
            validate_chapter_limits(data(current))

    def test_legacy_names_and_template_resolution(self):
        current = task(156)
        del current["templateId"]
        current["activityType"] = "学习/数学"
        current["namedItemAllocations"][0]["itemId"] = "old-id"
        with self.assertRaisesRegex(ChapterLimitError, "不能超过 155"):
            validate_chapter_limits(data(current))

    def test_legacy_violations_do_not_block_unrelated_saves(self):
        previous = data(task(156))
        candidate = copy.deepcopy(previous)
        candidate["2026-10-01"]["dayNote"] = "普通备注"
        validate_chapter_limits(candidate, previous)
        candidate["2026-10-01"]["tasks"].append(task(1, "new"))
        with self.assertRaises(ChapterLimitError):
            validate_chapter_limits(candidate, previous)


class ChapterLimitsApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="recorder-chapter-test-")
        cls.old_data_dir = os.environ.get("TRACKER_DATA_DIR")
        os.environ["TRACKER_DATA_DIR"] = cls.directory.name
        # Creating the file before importing prevents any automatic data migration.
        (Path(cls.directory.name) / "study_data.json").write_text("{}", encoding="utf-8")
        cls.backend = importlib.import_module("app")
        cls.backend.app.config["TESTING"] = True

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()
        if cls.old_data_dir is None:
            del os.environ["TRACKER_DATA_DIR"]
        else:
            os.environ["TRACKER_DATA_DIR"] = cls.old_data_dir

    def setUp(self):
        self.backend.save_data({})
        self.backend.save_data(data(task(100)))
        self.client = self.backend.app.test_client()

    def test_task_post_rejects_overrun_without_writing(self):
        before = self.backend.DATA_FILE.read_bytes()
        response = self.client.post("/api/data/2026-10-07/tasks", json=task(56, "next"))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json["code"], "chapter_limit")
        self.assertIn("超出 1", response.json["error"])
        self.assertEqual(self.backend.DATA_FILE.read_bytes(), before)
        response = self.client.post("/api/data/2026-10-07/tasks", json=task(55, "next"))
        self.assertEqual(response.status_code, 200)

    def test_day_edit_rechecks_other_dates(self):
        self.client.post("/api/data/2026-10-07/tasks", json=task(55, "next"))
        response = self.client.put("/api/data/2026-10-01", json={"tasks": [task(101)]})
        self.assertEqual(response.status_code, 400)
        response = self.client.put("/api/data/2026-10-01", json={"tasks": [task(99)]})
        self.assertEqual(response.status_code, 200)

    def test_full_data_save_and_template_changes_cannot_bypass_limit(self):
        response = self.client.post("/api/data", json=data(task(100), count=99))
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/data", json=data(task(156)))
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/data", json=data(task(1000), enabled=False))
        self.assertEqual(response.status_code, 200)

    def test_concurrent_requests_cannot_both_take_the_last_question(self):
        self.backend.save_data(data(task(154)))
        statuses = []
        barrier = threading.Barrier(2)

        def send(task_id):
            with self.backend.app.test_client() as client:
                barrier.wait()
                response = client.post("/api/data/2026-10-07/tasks", json=task(1, task_id))
                statuses.append(response.status_code)

        workers = [threading.Thread(target=send, args=(str(index),)) for index in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertEqual(sorted(statuses), [200, 400])
        self.assertEqual(sum(item["quantity"] for day in self.backend.load_data().values()
                             if isinstance(day, dict) for item in day.get("tasks", [])), 155)


if __name__ == "__main__":
    unittest.main()
