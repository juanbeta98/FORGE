"""Unit tests for the shared completion-calculation utilities in crud.py.

Runs against a fresh in-memory SQLite DB (not the real tracker.db) using the
same schema, so it's fast and never touches real data.

    python3 -m unittest backend/test_calculations.py
"""

import sqlite3
import unittest
from datetime import date, timedelta

import crud
import database


def make_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(database.SCHEMA)
    return conn


def add_habit(conn, name, category="daily", tracking_type="numeric", target_value=100,
              weekly_frequency=None, created_at=None):
    cur = conn.execute(
        """INSERT INTO habits (name, category, tracking_type, target_value, weekly_frequency, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, 0, COALESCE(?, datetime('now')))""",
        (name, category, tracking_type, target_value, weekly_frequency, created_at),
    )
    conn.commit()
    return cur.lastrowid


class TestHabitScore(unittest.TestCase):
    def test_examples_from_brief(self):
        self.assertEqual(crud.calculate_habit_score(0, 100), 0)
        self.assertEqual(crud.calculate_habit_score(50, 100), 0.5)
        self.assertEqual(crud.calculate_habit_score(100, 100), 1)
        self.assertEqual(crud.calculate_habit_score(150, 100), 1)  # capped, never exceeds 1

    def test_zero_target_is_safe(self):
        self.assertEqual(crud.calculate_habit_score(5, 0), 0)


class TestDailyCompletion(unittest.TestCase):
    def setUp(self):
        self.conn = make_conn()

    def test_mixed_daily_habits_average_correctly(self):
        h1 = add_habit(self.conn, "Pushups", target_value=100)
        h2 = add_habit(self.conn, "Squats", target_value=150)
        h3 = add_habit(self.conn, "Journaling", tracking_type="boolean", target_value=1)
        today = date.today().isoformat()

        crud.upsert_log(self.conn, h1, today, 80)   # 0.8
        crud.upsert_log(self.conn, h2, today, 75)   # 0.5
        crud.upsert_log(self.conn, h3, today, 1)    # 1.0

        result = crud.calculate_daily_completion(self.conn, date.today())
        self.assertAlmostEqual(result["completion"], (0.8 + 0.5 + 1.0) / 3)
        self.assertEqual(result["completed_habits"], 1)  # only Journaling hit 100%
        self.assertEqual(result["total_habits"], 3)

    def test_no_scheduled_habits_is_empty_not_bad(self):
        result = crud.calculate_daily_completion(self.conn, date.today())
        self.assertEqual(result, {"completion": 0.0, "completed_habits": 0, "total_habits": 0})

    def test_habit_created_later_excluded_from_earlier_days(self):
        earlier_day = date.today() - timedelta(days=10)
        add_habit(self.conn, "New Habit", target_value=10)  # created_at defaults to now
        result = crud.calculate_daily_completion(self.conn, earlier_day)
        self.assertEqual(result["total_habits"], 0)


class TestHistoricalAccuracy(unittest.TestCase):
    """The critical requirement: changing a habit's target later must not
    retroactively change a previously-logged day's completion."""

    def setUp(self):
        self.conn = make_conn()

    def test_target_change_does_not_rewrite_history(self):
        habit_id = add_habit(self.conn, "Pushups", target_value=100)
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        crud.upsert_log(self.conn, habit_id, yesterday, 100)  # 100/100 = perfect at the time

        before = crud.calculate_daily_completion(self.conn, date.today() - timedelta(days=1))
        self.assertEqual(before["completion"], 1.0)

        # Bump the target way up — as if the user edited it today.
        crud.update_habit(self.conn, habit_id, {"target_value": 200})

        after = crud.calculate_daily_completion(self.conn, date.today() - timedelta(days=1))
        self.assertEqual(after["completion"], 1.0, "past completion must stay pinned to the target at logging time")

    def test_todays_completion_does_use_the_new_target(self):
        habit_id = add_habit(self.conn, "Pushups", target_value=100)
        today = date.today().isoformat()
        crud.upsert_log(self.conn, habit_id, today, 100)
        self.assertEqual(crud.calculate_daily_completion(self.conn, date.today())["completion"], 1.0)

        crud.update_habit(self.conn, habit_id, {"target_value": 200})
        self.assertEqual(crud.calculate_daily_completion(self.conn, date.today())["completion"], 0.5,
                          "today is always live — it should reflect the current target immediately")


class TestStreak(unittest.TestCase):
    def setUp(self):
        self.conn = make_conn()
        self.habit_id = add_habit(self.conn, "Journaling", tracking_type="boolean", target_value=1)

    def _log(self, days_ago, value):
        day = (date.today() - timedelta(days=days_ago)).isoformat()
        crud.upsert_log(self.conn, self.habit_id, day, value)

    def test_perfect_days_build_a_streak(self):
        for i in range(5):
            self._log(i, 1)
        self.assertEqual(crud.calculate_current_streak(self.conn), 5)

    def test_a_zero_day_breaks_the_streak(self):
        self._log(0, 1)
        self._log(1, 1)
        self._log(2, 0)  # gap
        self._log(3, 1)
        self.assertEqual(crud.calculate_current_streak(self.conn), 2)

    def test_missing_day_counts_as_zero_and_breaks_streak(self):
        self._log(0, 1)
        self._log(1, 1)
        # day 2 never logged at all
        self._log(3, 1)
        self.assertEqual(crud.calculate_current_streak(self.conn), 2)

    def test_today_in_progress_does_not_break_yesterdays_streak(self):
        self._log(1, 1)
        self._log(2, 1)
        # today not logged yet — should still count yesterday's streak
        self.assertEqual(crud.calculate_current_streak(self.conn), 2)

    def test_no_logs_at_all_is_zero(self):
        self.assertEqual(crud.calculate_current_streak(self.conn), 0)


class TestForgeGridStats(unittest.TestCase):
    """Days before the first habit existed must not count against you —
    'days shown up' is out of days *tracked*, not the full display window."""

    def setUp(self):
        self.conn = make_conn()

    def test_stats_denominator_excludes_pre_tracking_days(self):
        # Habit created 4 days ago (inclusive of today = 4 tracked days: -3..0).
        created = (date.today() - timedelta(days=3)).isoformat() + " 00:00:00"
        habit_id = add_habit(self.conn, "Pushups", target_value=100, created_at=created)
        crud.upsert_log(self.conn, habit_id, date.today().isoformat(), 100)  # today: perfect
        crud.upsert_log(self.conn, habit_id, (date.today() - timedelta(days=1)).isoformat(), 0)  # yesterday: zero

        result = crud.build_forge_grid_data(self.conn, days=30)
        stats = result["stats"]

        # tracked_days depends only on "habit created 3 days ago", not on the
        # window's total length (which itself varies with today's weekday
        # under the week-aligned grid) — so assert it directly rather than
        # against a hardcoded window size.
        self.assertEqual(stats["tracked_days"], 4)
        self.assertEqual(stats["days_shown_up"], 1)  # only today has completion > 0
        self.assertEqual(stats["perfect_days"], 1)

        # Every day before the habit existed should show as untracked, not zero-effort.
        pre_tracking_days = [d for d in result["days"] if d["total_habits"] == 0]
        self.assertEqual(len(pre_tracking_days), len(result["days"]) - 4)


if __name__ == "__main__":
    unittest.main()
