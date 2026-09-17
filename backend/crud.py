"""All SQL access lives here: habits, logs, weight, streak, and trend queries."""

import json
import sqlite3
from datetime import date, timedelta
from typing import Optional

# The very first real day of tracking landed on a Sunday, which — combined
# with a stray earlier log from before a reset — skewed "days shown up" and
# the other consistency metrics with a day that was never really being
# tracked. Nothing before this date counts toward any consistency metric,
# the same way a day before a habit's own created_at doesn't — see its use
# in calculate_daily_completion, calculate_wellness_consistency, and
# calculate_weekly_goals_consistency.
TRACKING_START_DATE = date(2026, 9, 14)


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    if "archived" in d:
        d["archived"] = bool(d["archived"])
    if "extra" in d:
        # Stored as a JSON string; hand callers a real dict (or None), not
        # text they'd have to parse themselves.
        d["extra"] = json.loads(d["extra"]) if d["extra"] else None
    return d


# ---------- Habits ----------

def list_habits(conn: sqlite3.Connection, include_archived: bool = False) -> list:
    q = "SELECT * FROM habits"
    if not include_archived:
        q += " WHERE archived = 0"
    q += " ORDER BY sort_order, id"
    return [row_to_dict(r) for r in conn.execute(q).fetchall()]


def get_habit(conn: sqlite3.Connection, habit_id: int) -> Optional[dict]:
    row = conn.execute("SELECT * FROM habits WHERE id = ?", (habit_id,)).fetchone()
    return row_to_dict(row) if row else None


def get_habit_by_name(conn: sqlite3.Connection, name: str) -> Optional[dict]:
    row = conn.execute("SELECT * FROM habits WHERE name = ? AND archived = 0", (name,)).fetchone()
    return row_to_dict(row) if row else None


def create_habit(conn: sqlite3.Connection, data: dict) -> dict:
    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), 0) AS m FROM habits"
    ).fetchone()["m"]
    cur = conn.execute(
        """INSERT INTO habits
           (name, category, tracking_type, target_value, unit, weekly_frequency,
            weekly_metric_unit, section, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data["name"],
            data["category"],
            data["tracking_type"],
            data.get("target_value", 1),
            data.get("unit"),
            data.get("weekly_frequency"),
            data.get("weekly_metric_unit"),
            data.get("section"),
            max_order + 1,
        ),
    )
    conn.commit()
    return get_habit(conn, cur.lastrowid)


def update_habit(conn: sqlite3.Connection, habit_id: int, data: dict) -> Optional[dict]:
    existing = get_habit(conn, habit_id)
    if not existing:
        return None
    fields = {
        k: v
        for k, v in data.items()
        if v is not None
        and k
        in (
            "name",
            "category",
            "tracking_type",
            "target_value",
            "unit",
            "weekly_frequency",
            "weekly_metric_unit",
            "section",
            "sort_order",
        )
    }
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE habits SET {set_clause} WHERE id = ?",
            (*fields.values(), habit_id),
        )
        conn.commit()
    return get_habit(conn, habit_id)


def archive_habit(conn: sqlite3.Connection, habit_id: int) -> bool:
    cur = conn.execute(
        "UPDATE habits SET archived = 1, archived_at = datetime('now') WHERE id = ?",
        (habit_id,),
    )
    conn.commit()
    return cur.rowcount > 0


# ---------- Logs ----------

def upsert_log(conn: sqlite3.Connection, habit_id: int, log_date: str, value: float,
                note: Optional[str] = None, log_id: Optional[int] = None,
                value2: Optional[float] = None, extra: Optional[dict] = None) -> dict:
    habit = get_habit(conn, habit_id)
    if not habit:
        raise ValueError("habit not found")

    # Daily habits snapshot the target at the moment of logging, so a later
    # target change never silently rewrites a past day's completion. Weekly
    # habits don't need this — weekly completion is always evaluated live,
    # against the current week, never re-derived historically. For an
    # Exercise habit this snapshot is the day-type-effective target (half on
    # an office day) for whatever date is actually being logged — usually
    # today, but a backdated Entries edit resolves against that log_date's
    # own day type, not today's.
    if habit["category"] != "daily":
        target_at_time = None
    elif _is_exercise_habit(habit):
        day_type = get_day_type(conn, date.fromisoformat(log_date))
        target_at_time = exercise_target_for_day(habit["target_value"], day_type)
        if target_at_time is None:  # weekend — unused for scoring (habit isn't scheduled), but still needs a value
            target_at_time = habit["target_value"]
    else:
        target_at_time = habit["target_value"]
    extra_json = json.dumps(extra) if extra else None

    if log_id:
        conn.execute(
            "UPDATE habit_logs SET value = ?, value2 = ?, extra = ?, note = ?, log_date = ?, target_at_time = ? WHERE id = ?",
            (value, value2, extra_json, note, log_date, target_at_time, log_id),
        )
        result_id = log_id
    elif habit["category"] == "daily":
        existing = conn.execute(
            "SELECT id FROM habit_logs WHERE habit_id = ? AND log_date = ?",
            (habit_id, log_date),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE habit_logs SET value = ?, value2 = ?, extra = ?, note = ?, target_at_time = ? WHERE id = ?",
                (value, value2, extra_json, note, target_at_time, existing["id"]),
            )
            result_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO habit_logs (habit_id, log_date, value, value2, extra, note, target_at_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (habit_id, log_date, value, value2, extra_json, note, target_at_time),
            )
            result_id = cur.lastrowid
    else:
        # weekly habit: each call adds a new session entry
        cur = conn.execute(
            "INSERT INTO habit_logs (habit_id, log_date, value, value2, extra, note, target_at_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (habit_id, log_date, value, value2, extra_json, note, target_at_time),
        )
        result_id = cur.lastrowid

    conn.commit()
    row = conn.execute("SELECT * FROM habit_logs WHERE id = ?", (result_id,)).fetchone()
    return row_to_dict(row)


def delete_log(conn: sqlite3.Connection, log_id: int) -> bool:
    cur = conn.execute("DELETE FROM habit_logs WHERE id = ?", (log_id,))
    conn.commit()
    return cur.rowcount > 0


def get_logs_for_date(conn: sqlite3.Connection, log_date: str) -> list:
    rows = conn.execute(
        "SELECT * FROM habit_logs WHERE log_date = ?", (log_date,)
    ).fetchall()
    return [row_to_dict(r) for r in rows]


def get_week_bounds(today: Optional[date] = None):
    today = today or date.today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def get_logs_in_range(conn: sqlite3.Connection, habit_id: int, start: str, end: str) -> list:
    rows = conn.execute(
        """SELECT * FROM habit_logs
           WHERE habit_id = ? AND log_date BETWEEN ? AND ?
           ORDER BY log_date, id""",
        (habit_id, start, end),
    ).fetchall()
    return [row_to_dict(r) for r in rows]


# ---------- Shared completion calculations ----------
# One set of utilities, used by today's live status, the Forge Grid, streak,
# and consistency — rather than recomputing "is this day done" differently in
# several places.

STREAK_COMPLETION_THRESHOLD = 0.5  # a day "counts" toward the streak at 50%+, not only at 100%


def calculate_habit_score(value: float, target: float) -> float:
    """0..1 credit for one habit on one day. Never exceeds 1 even if the
    logged value overshoots the target (habit_score(150, 100) == 1)."""
    if not target:
        return 0.0
    return min(value / target, 1.0)


def calculate_sleep_completion(duration: Optional[float], sleep_score: Optional[float]) -> float:
    """Logging/completion and performance/quality are different things.
    Sleep counts as ONE completed Wellness habit once both duration and
    score have actually been entered — full credit (1.0) either way, same
    as a boolean habit — regardless of how good or bad the score is. A poor
    night's sleep that got logged is still logged; it must never read as
    "failed to track Sleep". The score itself only drives the Sleep
    progress bar/chart, never this completion credit."""
    return 1.0 if (duration and sleep_score) else 0.0


# ---------- Day types (home-office / office / weekend) ----------
# Exercise targets aren't the same every day: home-office days get the full
# target, office days get half of it, and on weekends the exercise habits
# don't count at all (that effort already lives in the Hyrox/Sauna/Bouldering
# weekly habits instead). Everything else (Wellness, Sleep, weekly habits)
# is unaffected by day type.

EXERCISE_OFFICE_DIVISOR = 2


def _is_exercise_habit(h: dict) -> bool:
    """Any daily numeric habit in the Exercise section — matched by shape,
    not by name, so a future 4th exercise habit automatically follows the
    same office/weekend rule without any code change."""
    return h["category"] == "daily" and h["tracking_type"] == "numeric" and h["section"] == "Exercise"


def get_day_type(conn: sqlite3.Connection, day: date) -> str:
    """An explicit override (set via the Today toggle) always wins; otherwise
    a plain, always-on weekday rule: Saturday/Sunday are weekends, every
    other day is home-office. That rule is a pure function of the date, so
    it applies the same way to any date, past or present — there's nothing
    to retroactively "fix", it was never applied differently before."""
    row = conn.execute("SELECT day_type FROM day_types WHERE date = ?", (day.isoformat(),)).fetchone()
    if row:
        return row["day_type"]
    return "weekend" if day.weekday() >= 5 else "home-office"


def set_day_type(conn: sqlite3.Connection, day: date, day_type: str) -> None:
    conn.execute(
        "INSERT INTO day_types (date, day_type) VALUES (?, ?) "
        "ON CONFLICT(date) DO UPDATE SET day_type = excluded.day_type",
        (day.isoformat(), day_type),
    )
    conn.commit()


def exercise_target_for_day(base_target: float, day_type: str) -> Optional[float]:
    """None means the habit isn't scheduled that day at all (weekend)."""
    if day_type == "weekend":
        return None
    if day_type == "office":
        return base_target / EXERCISE_OFFICE_DIVISOR
    return base_target


def is_wellness_practice(h: dict) -> bool:
    """The 4 selectable Wellness habits (Journaling, Wim Hof, Mobility, Yoga
    Nidra) — matched by shape (boolean + Wellness section), not by name, so
    it survives a rename. Sleep is excluded on tracking_type alone even
    though it shares the Wellness section: it has its own chart/scoring and
    must never be double-counted here.

    Unlike every other daily habit, a Wellness practice's presence on any
    given day is governed purely by whether the user explicitly selected it
    that day (a habit_logs row exists for that date) — never by "the habit
    exists globally". See get_scheduled_daily_habits_for_day and
    calculate_daily_completion for where that's enforced."""
    return h["tracking_type"] == "boolean" and h["section"] == "Wellness"


def get_scheduled_daily_habits_for_day(conn: sqlite3.Connection, day_str: str) -> list:
    """Daily habits that existed (and weren't yet archived) on a given date.
    created_at/archived_at are full datetimes, so we compare on just the date
    portion — a naive `<= day_str` string comparison against a bare date is
    wrong once time-of-day is involved.

    Wellness practices are deliberately excluded here — "existing" doesn't
    mean "chosen for today". They only ever enter the schedule via an actual
    log for that date (see calculate_daily_completion's extra_ids step)."""
    rows = conn.execute(
        """SELECT * FROM habits
           WHERE category = 'daily'
             AND NOT (tracking_type = 'boolean' AND section = 'Wellness')
             AND substr(created_at, 1, 10) <= ?
             AND (archived_at IS NULL OR substr(archived_at, 1, 10) > ?)
           ORDER BY sort_order, id""",
        (day_str, day_str),
    ).fetchall()
    return [row_to_dict(r) for r in rows]


def calculate_daily_completion(conn: sqlite3.Connection, day: date) -> dict:
    """{completion, completed_habits, total_habits} for one calendar day.

    Today uses the live, current habit set and current targets. Past days use
    exactly the habits scheduled as of that date, scored against the target
    snapshotted on that day's log (falling back to the habit's current target
    only for logs written before target_at_time existed)."""
    if day < TRACKING_START_DATE:
        return {"completion": 0.0, "completed_habits": 0, "total_habits": 0}

    day_str = day.isoformat()
    is_today = day == date.today()
    day_type = get_day_type(conn, day)

    logs = get_logs_for_date(conn, day_str)
    log_map = {l["habit_id"]: l for l in logs}

    if is_today:
        # Wellness practices are excluded here too (same reason as
        # get_scheduled_daily_habits_for_day) — "exists as a habit" isn't
        # "chosen for today". The extra_ids step below is what actually
        # brings a SELECTED Wellness practice into today's schedule.
        scheduled = [h for h in list_habits(conn) if h["category"] == "daily" and not is_wellness_practice(h)]
    else:
        scheduled = get_scheduled_daily_habits_for_day(conn, day_str)

    # A log for a habit that isn't otherwise scheduled is itself evidence it
    # applied that day — either a backdated entry for a habit created later
    # (past days), or a Wellness practice the user explicitly selected
    # (today and past days alike, since Wellness is never auto-scheduled).
    scheduled_ids = {h["id"] for h in scheduled}
    extra_ids = set(log_map.keys()) - scheduled_ids
    for hid in extra_ids:
        h = get_habit(conn, hid)
        if h and h["category"] == "daily":
            scheduled.append(h)

    # A weekend day never schedules the Exercise habits at all — not scored
    # against a target of 0, simply not counted, the same way a not-yet-
    # created habit isn't. Applies to today and to past days alike (it's a
    # pure weekday rule, see get_day_type).
    if day_type == "weekend":
        scheduled = [h for h in scheduled if not _is_exercise_habit(h)]

    if not scheduled:
        return {"completion": 0.0, "completed_habits": 0, "total_habits": 0}

    scores = []
    completed = 0
    for h in scheduled:
        log = log_map.get(h["id"])
        value = log["value"] if log else 0
        if _is_exercise_habit(h) and is_today:
            # Live for today: always the current day_type's effective
            # target, never a stale snapshot. Past days already have the
            # correct effective target frozen in target_at_time (set by
            # upsert_log at the moment each log was written), same as any
            # other daily habit — never None here since weekend rows were
            # already filtered out above.
            target = exercise_target_for_day(h["target_value"], day_type)
        elif is_today:
            target = h["target_value"]
        else:
            target = log["target_at_time"] if log and log.get("target_at_time") is not None else h["target_value"]
        if h["tracking_type"] == "sleep":
            value2 = log["value2"] if log else None
            score = calculate_sleep_completion(value, value2)
        else:
            score = calculate_habit_score(value, target)
        scores.append(score)
        if score >= 1:
            completed += 1

    return {
        "completion": sum(scores) / len(scores),
        "completed_habits": completed,
        "total_habits": len(scheduled),
    }


def calculate_current_streak(conn: sqlite3.Connection, threshold: float = STREAK_COMPLETION_THRESHOLD) -> int:
    today = date.today()
    today_completion = calculate_daily_completion(conn, today)["completion"]

    streak = 0
    day = today if today_completion >= threshold else today - timedelta(days=1)
    while calculate_daily_completion(conn, day)["completion"] >= threshold:
        streak += 1
        day -= timedelta(days=1)
    return streak


def calculate_wellness_consistency(conn: sqlite3.Connection, days: int = 91) -> Optional[float]:
    """Wellness is now something the user deliberately opts into each day
    (see is_wellness_practice), not a fixed 4-habit checklist — so
    consistency measures "of what I actually chose to do, how much did I
    follow through", not "did I do at least 2 of 4 available practices".

    total completed selected practices / total selected practices, summed
    across the whole horizon (every log row for a Wellness habit in range IS
    one "selected" instance, by construction — see the Wellness queue's
    add/remove flow). Every commitment carries equal weight this way, rather
    than each DAY carrying equal weight regardless of how much was chosen —
    that's why this isn't an average of daily percentages.

    A day with zero selected practices contributes zero rows here — it's
    excluded outright, not scored as 0%. Sleep is excluded (own chart)."""
    today = date.today()
    weeks = max(1, days // 7)
    this_monday = today - timedelta(days=today.weekday())
    start = max(this_monday - timedelta(days=7 * (weeks - 1)), TRACKING_START_DATE)

    rows = conn.execute(
        """SELECT habit_logs.value FROM habit_logs
           JOIN habits ON habits.id = habit_logs.habit_id
           WHERE habits.tracking_type = 'boolean' AND habits.section = 'Wellness'
             AND habit_logs.log_date BETWEEN ? AND ?""",
        (start.isoformat(), today.isoformat()),
    ).fetchall()
    if not rows:
        return None
    completed = sum(1 for r in rows if r["value"] >= 1)
    return completed / len(rows)


def calculate_weekly_goals_consistency(conn: sqlite3.Connection, days: int = 91) -> Optional[float]:
    """Completed sessions / prescribed sessions, summed across every weekly
    habit and every week in the horizon (including the current partial
    week) — not an average of per-week percentages, and not a count of
    "how many activity categories got touched". A habit's own sessions that
    week are capped at its target before summing, mirroring
    calculate_habit_score's cap elsewhere (extra sessions are still stored
    and still visible in Entries/history — they just don't inflate this
    beyond 100%). Returns None (render as "—") when nothing was ever
    prescribed."""
    today = date.today()
    weeks = max(1, days // 7)
    this_monday = today - timedelta(days=today.weekday())
    tracking_start_monday = TRACKING_START_DATE - timedelta(days=TRACKING_START_DATE.weekday())
    start_monday = max(this_monday - timedelta(days=7 * (weeks - 1)), tracking_start_monday)

    weekly_habits = [h for h in list_habits(conn, include_archived=True) if h["category"] == "weekly"]

    total_completed = 0
    total_prescribed = 0
    monday = start_monday
    while monday <= this_monday:
        sunday = monday + timedelta(days=6)
        for h in weekly_habits:
            created_date = h["created_at"][:10]
            if created_date > sunday.isoformat():
                continue  # didn't exist yet during this week
            if h["archived_at"] and h["archived_at"][:10] <= monday.isoformat():
                continue  # already archived before this week started
            target = h["weekly_frequency"] or 1
            sessions = get_logs_in_range(conn, h["id"], monday.isoformat(), sunday.isoformat())
            total_completed += min(len(sessions), target)
            total_prescribed += target
        monday += timedelta(days=7)

    return total_completed / total_prescribed if total_prescribed else None


RECENT_TOTALS_DAYS = 30


def calculate_recent_totals(conn: sqlite3.Connection, days: int = RECENT_TOTALS_DAYS) -> dict:
    """Trailing `days`-day rollups for the Consistency block: total exercise
    reps volume, total km run, and session counts for the 4 selectable
    Wellness practices (Journaling, Mobility, Yoga Nidra, Wim Hof Breathing)
    — how much actually got done lately, which the Forge Grid's day-by-day
    completion view doesn't surface on its own. A session only counts once
    it's actually completed (value >= 1), same as calculate_wellness_
    consistency — merely having selected a practice for the day doesn't
    count. Always a fixed trailing window, independent of build_forge_grid_
    data's own (configurable) horizon."""
    end = date.today()
    start = end - timedelta(days=days - 1)
    start_s, end_s = start.isoformat(), end.isoformat()

    exercise_ids = [h["id"] for h in list_habits(conn) if _is_exercise_habit(h)]
    reps_volume = 0.0
    if exercise_ids:
        placeholders = ",".join("?" * len(exercise_ids))
        row = conn.execute(
            f"""SELECT COALESCE(SUM(value), 0) AS total FROM habit_logs
                WHERE habit_id IN ({placeholders}) AND log_date BETWEEN ? AND ?""",
            (*exercise_ids, start_s, end_s),
        ).fetchone()
        reps_volume = row["total"]

    def sum_value(habit_name: str) -> float:
        habit = get_habit_by_name(conn, habit_name)
        if not habit:
            return 0.0
        row = conn.execute(
            """SELECT COALESCE(SUM(value), 0) AS total FROM habit_logs
               WHERE habit_id = ? AND log_date BETWEEN ? AND ?""",
            (habit["id"], start_s, end_s),
        ).fetchone()
        return row["total"]

    def session_count(habit_name: str) -> int:
        habit = get_habit_by_name(conn, habit_name)
        if not habit:
            return 0
        row = conn.execute(
            """SELECT COUNT(*) AS c FROM habit_logs
               WHERE habit_id = ? AND value >= 1 AND log_date BETWEEN ? AND ?""",
            (habit["id"], start_s, end_s),
        ).fetchone()
        return row["c"]

    return {
        "reps_volume": reps_volume,
        "km_ran": sum_value("Running"),
        "journaling_sessions": session_count("Journaling"),
        "mobility_sessions": session_count("Mobility Routine"),
        "yoga_nidra_sessions": session_count("Yoga Nidra"),
        "wim_hof_breathing_sessions": session_count("Wim Hof Breathing"),
    }


def build_forge_grid_data(conn: sqlite3.Connection, days: int = 91) -> dict:
    """`days` is interpreted as whole weeks (days // 7) — the grid is defined
    as N complete Monday-Sunday weeks plus the current in-progress week, not
    a raw day count, so it always renders as an exact N-column grid regardless
    of what weekday "today" happens to be (no partial leading week)."""
    today = date.today()
    weeks = max(1, days // 7)
    this_monday = today - timedelta(days=today.weekday())
    start = this_monday - timedelta(days=7 * (weeks - 1))
    end = today  # never render future days within the current week

    day_records = []
    day = start
    while day <= end:
        record = calculate_daily_completion(conn, day)
        record["date"] = day.isoformat()
        day_records.append(record)
        day += timedelta(days=1)

    # A day with total_habits == 0 means no habit existed yet (before tracking
    # began), not "zero effort" — it shouldn't count against you in the
    # denominators, and the grid renders it as a visually distinct "no data"
    # cell rather than a failed day.
    tracked = [d for d in day_records if d["total_habits"] > 0]
    tracked_completions = [d["completion"] for d in tracked]
    stats = {
        "days_shown_up": sum(1 for c in tracked_completions if c > 0),
        "tracked_days": len(tracked),
        "current_streak": calculate_current_streak(conn),
        "wellness_consistency": calculate_wellness_consistency(conn, days),
        "weekly_goals_consistency": calculate_weekly_goals_consistency(conn, days),
        "recent_totals": calculate_recent_totals(conn),
    }
    return {"days": day_records, "stats": stats}


# ---------- Trends ----------

def get_habit_daily_series(conn: sqlite3.Connection, habit_id: int, days: int = 30) -> dict:
    """Last `days` days for a habit, zero-filled where nothing was logged —
    so the series is a real, evenly-spaced calendar timeline for a bar chart.
    `has_data` is true only once some real (nonzero) effort has been logged —
    an explicit zero still counts as "tracked" elsewhere (the Forge Grid,
    streak), but showing an all-zero chart with axes and a target line just
    reads as broken, not informative.

    For an Exercise habit, each point also carries that DAY's own effective
    target (`target`) — home-office/office/weekend can differ day to day, so
    the chart compares each day's effort to the standard that actually
    applied that day, never a single flat "max" target for the whole 30-day
    window."""
    habit = get_habit(conn, habit_id)
    is_exercise = bool(habit) and _is_exercise_habit(habit)

    end = date.today()
    start = end - timedelta(days=days - 1)
    rows = conn.execute(
        """SELECT log_date, value, value2, target_at_time FROM habit_logs
           WHERE habit_id = ? AND log_date BETWEEN ? AND ?""",
        (habit_id, start.isoformat(), end.isoformat()),
    ).fetchall()
    row_by_date = {r["log_date"]: r for r in rows}

    series = []
    day = start
    while day <= end:
        day_str = day.isoformat()
        r = row_by_date.get(day_str)
        # value2 rides along for habits that use it (Sleep's score) — 0 (not
        # logged) rather than null, so a bar/line chart never breaks on a gap.
        point = {"date": day_str, "value": r["value"] if r else 0, "value2": (r["value2"] or 0) if r else 0}
        if is_exercise:
            if day == date.today():
                # Today isn't "finalized" yet — the day-type toggle can
                # still change after this habit was logged, so always use
                # the live target rather than whatever got frozen into
                # target_at_time on the last write (same rule as
                # calculate_daily_completion's is_today branch).
                point["target"] = exercise_target_for_day(habit["target_value"], get_day_type(conn, day)) or habit["target_value"]
            elif r and r["target_at_time"] is not None:
                point["target"] = r["target_at_time"]
            else:
                # No log that past day (value is 0 anyway) — still report
                # what WOULD apply, for a meaningful axis/target line.
                point["target"] = exercise_target_for_day(habit["target_value"], get_day_type(conn, day)) or habit["target_value"]
        series.append(point)
        day += timedelta(days=1)
    return {"series": series, "has_data": any(r["value"] > 0 for r in rows)}


# ---------- Weight ----------

def list_weight(conn: sqlite3.Connection, limit: int = 365) -> list:
    rows = conn.execute(
        "SELECT * FROM weight_logs ORDER BY logged_at ASC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def add_weight(conn: sqlite3.Connection, logged_at: str, value_kg: float) -> dict:
    cur = conn.execute(
        "INSERT INTO weight_logs (logged_at, value_kg) VALUES (?, ?)",
        (logged_at, value_kg),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM weight_logs WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def update_weight(conn: sqlite3.Connection, weight_id: int, logged_at: Optional[str], value_kg: Optional[float]) -> Optional[dict]:
    existing = conn.execute("SELECT * FROM weight_logs WHERE id = ?", (weight_id,)).fetchone()
    if not existing:
        return None
    fields = {}
    if logged_at is not None:
        fields["logged_at"] = logged_at
    if value_kg is not None:
        fields["value_kg"] = value_kg
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE weight_logs SET {set_clause} WHERE id = ?",
            (*fields.values(), weight_id),
        )
        conn.commit()
    row = conn.execute("SELECT * FROM weight_logs WHERE id = ?", (weight_id,)).fetchone()
    return dict(row)


def delete_weight(conn: sqlite3.Connection, weight_id: int) -> bool:
    cur = conn.execute("DELETE FROM weight_logs WHERE id = ?", (weight_id,))
    conn.commit()
    return cur.rowcount > 0


# ---------- Raw entries (edit panel) ----------

def list_recent_logs(conn: sqlite3.Connection, limit: int = 200) -> list:
    """Raw habit_logs rows (any habit, daily or weekly), newest first, joined
    with just enough habit info to label them in a flat "edit raw entries"
    list — not grouped/derived like list_habits/get_logs_in_range are for the
    dashboard."""
    rows = conn.execute(
        """SELECT habit_logs.*, habits.name AS habit_name, habits.unit AS habit_unit,
                  habits.weekly_metric_unit AS habit_weekly_metric_unit,
                  habits.category AS habit_category, habits.tracking_type AS habit_tracking_type,
                  habits.section AS habit_section
           FROM habit_logs
           JOIN habits ON habits.id = habit_logs.habit_id
           ORDER BY habit_logs.log_date DESC, habit_logs.id DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [row_to_dict(r) for r in rows]


# ---------- Garmin sync ----------
# garmin_sync.py talks to Garmin and returns plain candidate dicts; this
# module owns everything about matching those against what's already stored
# and actually writing them via upsert_log. Sleep is deduped by date (it's
# already one log per day); Running sessions aren't unique per date, so each
# imported run's `extra` carries its Garmin activity id for dedup instead.

def get_imported_garmin_activity_ids(conn: sqlite3.Connection, habit_id: int) -> set:
    rows = conn.execute(
        "SELECT extra FROM habit_logs WHERE habit_id = ? AND extra IS NOT NULL", (habit_id,)
    ).fetchall()
    ids = set()
    for r in rows:
        try:
            extra = json.loads(r["extra"])
        except (TypeError, ValueError):
            continue
        if extra and "garmin_activity_id" in extra:
            ids.add(extra["garmin_activity_id"])
    return ids


def annotate_garmin_candidates(conn: sqlite3.Connection, candidates: dict) -> dict:
    """Tags each candidate with status "new", "already_logged" (a Sleep log
    already exists that date), or "already_imported" (this exact Garmin run
    was imported before) — the picker uses this to leave those unchecked by
    default without hiding them outright."""
    sleep_habit = get_habit_by_name(conn, "Sleep")
    running_habit = get_habit_by_name(conn, "Running")

    logged_sleep_dates = set()
    if sleep_habit:
        rows = conn.execute(
            "SELECT log_date FROM habit_logs WHERE habit_id = ?", (sleep_habit["id"],)
        ).fetchall()
        logged_sleep_dates = {r["log_date"] for r in rows}

    imported_run_ids = get_imported_garmin_activity_ids(conn, running_habit["id"]) if running_habit else set()

    for rec in candidates["sleep"]:
        rec["status"] = "already_logged" if rec["date"] in logged_sleep_dates else "new"
    for rec in candidates["runs"]:
        rec["status"] = "already_imported" if rec["garmin_activity_id"] in imported_run_ids else "new"
    return candidates


def import_garmin_sleep(conn: sqlite3.Connection, habit_id: int, log_date: str,
                         duration_hours: float, score: Optional[float]) -> dict:
    return upsert_log(conn, habit_id, log_date, duration_hours, value2=score)


def import_garmin_run(conn: sqlite3.Connection, habit_id: int, record: dict) -> dict:
    extra = {"garmin_activity_id": record["garmin_activity_id"]}
    if record.get("pace_min_per_km") is not None:
        extra["pace"] = record["pace_min_per_km"]
    if record.get("avg_hr") is not None:
        extra["hr"] = record["avg_hr"]
    if record.get("cadence") is not None:
        extra["cadence"] = record["cadence"]
    return upsert_log(conn, habit_id, record["date"], record["distance_km"], extra=extra)
