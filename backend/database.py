"""SQLite connection handling, schema creation, and default habit seeding.

This also carries small idempotent migrations (add-column-if-missing,
insert-habit-if-missing-by-name) so an already-running install picks up new
default habits/fields without losing existing data. Fine for a single-user
local app; would need a real migration tool at any bigger scale.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "tracker.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('daily', 'weekly')),
    tracking_type TEXT NOT NULL CHECK (tracking_type IN ('numeric', 'boolean', 'sleep')),
    target_value REAL NOT NULL DEFAULT 1,
    unit TEXT,
    weekly_frequency INTEGER,
    weekly_metric_unit TEXT,
    section TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    log_date TEXT NOT NULL,
    value REAL NOT NULL,
    value2 REAL,
    extra TEXT, -- JSON object of extra named metrics for one log (e.g. Running: {"pace":5.5,"hr":142,"cadence":172})
    note TEXT,
    target_at_time REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_date ON habit_logs(habit_id, log_date);

CREATE TABLE IF NOT EXISTS weight_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at TEXT NOT NULL,
    value_kg REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weight_logs_logged_at ON weight_logs(logged_at);

-- One row per date that has an EXPLICIT day-type override (set via the
-- Today toggle). A date with no row here isn't "unset" in the app's eyes —
-- crud.get_day_type falls back to a pure weekday rule (Sat/Sun -> weekend,
-- else home-office), so this table only ever needs to grow from today
-- onward as the user actually toggles a day away from that default.
CREATE TABLE IF NOT EXISTS day_types (
    date TEXT PRIMARY KEY,
    day_type TEXT NOT NULL CHECK (day_type IN ('home-office', 'office', 'weekend'))
);
"""

# name, category, tracking_type, target_value, unit, weekly_frequency, weekly_metric_unit, section, sort_order
# The 6 Exercise habits stay in this exact relative order (Pushups, Squats,
# Crunches, then Dips, Rows, Hip Thrusts) — that's what makes the Today
# grid's 2-column x 3-row split (auto-flow:column, see app.js) land as
# [Pushups/Squats/Crunches] left, [Dips/Rows/Hip Thrusts] right, since the
# frontend derives column placement purely from this order, not from names.
DEFAULT_HABITS = [
    ("Pushups", "daily", "numeric", 100, "reps", None, None, "Exercise", 1),
    ("Squats", "daily", "numeric", 150, "reps", None, None, "Exercise", 2),
    ("Crunches", "daily", "numeric", 70, "reps", None, None, "Exercise", 3),
    ("Dips", "daily", "numeric", 30, "reps", None, None, "Exercise", 4),
    ("Rows", "daily", "numeric", 50, "reps", None, None, "Exercise", 5),
    ("Hip Thrusts", "daily", "numeric", 50, "reps", None, None, "Exercise", 6),
    ("Reading", "daily", "numeric", 20, "pages", None, None, "Wellness", 7),
    ("Journaling", "daily", "boolean", 1, None, None, None, "Wellness", 8),
    ("Wim Hof Breathing", "daily", "boolean", 1, None, None, None, "Wellness", 9),
    ("Mobility Routine", "daily", "boolean", 1, None, None, None, "Wellness", 10),
    ("Yoga Nidra", "daily", "boolean", 1, None, None, None, "Wellness", 11),
    # Two numbers (duration + score), but still ONE habit — see tracking_type
    # "sleep" handling in crud.calculate_sleep_completion. target_value is
    # the duration target in hours (shown as context, not a completion
    # gate); the score is always out of a fixed 100.
    ("Sleep", "daily", "sleep", 8, "hrs", None, None, "Wellness", 12),
    ("Hyrox Workout", "weekly", "boolean", 1, None, 1, None, None, 13),
    ("Running", "weekly", "boolean", 1, None, 2, "km", None, 14),
    ("Sauna", "weekly", "boolean", 1, None, 1, None, None, 15),
    ("Bouldering", "weekly", "boolean", 1, None, 1, None, None, 16),
]

# (name, category) -> migration patch applied only if the habit is missing.
# Kept separate from DEFAULT_HABITS so a fresh install (seeded wholesale from
# DEFAULT_HABITS) and an existing install (patched habit-by-habit below) end
# up in the same place.
MIGRATION_HABITS = DEFAULT_HABITS


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _column_names(conn: sqlite3.Connection, table: str) -> set:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _widen_tracking_type_check(conn: sqlite3.Connection) -> None:
    """SQLite can't ALTER a CHECK constraint in place, so a pre-existing
    install's `habits` table still has the old CHECK (tracking_type IN
    ('numeric', 'boolean')) baked in — inserting a 'sleep' habit into it
    would fail outright. Rebuild the table with the widened constraint and
    copy every row across, preserving ids. legacy_alter_table keeps the
    rename from rewriting habit_logs' "REFERENCES habits(id)" to point at
    the renamed habits_old (SQLite's default auto-fixup would otherwise
    leave that FK dangling once habits_old is dropped below)."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='habits'"
    ).fetchone()
    if row and "'sleep'" in row["sql"]:
        return  # already widened

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("PRAGMA legacy_alter_table = ON")
    conn.execute("ALTER TABLE habits RENAME TO habits_old")
    conn.execute("PRAGMA legacy_alter_table = OFF")
    conn.execute("""
        CREATE TABLE habits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('daily', 'weekly')),
            tracking_type TEXT NOT NULL CHECK (tracking_type IN ('numeric', 'boolean', 'sleep')),
            target_value REAL NOT NULL DEFAULT 1,
            unit TEXT,
            weekly_frequency INTEGER,
            weekly_metric_unit TEXT,
            section TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            archived_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        INSERT INTO habits (id, name, category, tracking_type, target_value, unit,
                             weekly_frequency, weekly_metric_unit, section, sort_order,
                             archived, archived_at, created_at)
        SELECT id, name, category, tracking_type, target_value, unit,
               weekly_frequency, weekly_metric_unit, section, sort_order,
               archived, archived_at, created_at
        FROM habits_old
    """)
    conn.execute("DROP TABLE habits_old")
    conn.execute("PRAGMA foreign_keys = ON")


def _migrate(conn: sqlite3.Connection) -> None:
    columns = _column_names(conn, "habits")
    if "weekly_metric_unit" not in columns:
        conn.execute("ALTER TABLE habits ADD COLUMN weekly_metric_unit TEXT")
    if "section" not in columns:
        conn.execute("ALTER TABLE habits ADD COLUMN section TEXT")
    if "archived_at" not in columns:
        conn.execute("ALTER TABLE habits ADD COLUMN archived_at TEXT")

    _widen_tracking_type_check(conn)

    log_columns = _column_names(conn, "habit_logs")
    if "value2" not in log_columns:
        conn.execute("ALTER TABLE habit_logs ADD COLUMN value2 REAL")
    if "extra" not in log_columns:
        conn.execute("ALTER TABLE habit_logs ADD COLUMN extra TEXT")
    if "target_at_time" not in log_columns:
        conn.execute("ALTER TABLE habit_logs ADD COLUMN target_at_time REAL")
        # Backfill: best available approximation is each habit's *current*
        # target — we never recorded historical targets before this column
        # existed. Every log written from here on gets a real snapshot.
        conn.execute(
            """UPDATE habit_logs
               SET target_at_time = (
                   SELECT target_value FROM habits WHERE habits.id = habit_logs.habit_id
               )
               WHERE target_at_time IS NULL"""
        )

    # Backfill section/weekly_metric_unit on pre-existing default habits, and
    # add any new default habits (Yoga Nidra, Sauna, Bouldering, ...) that
    # weren't there yet — matched by name so custom user habits are untouched.
    existing_names = {row["name"] for row in conn.execute("SELECT name FROM habits").fetchall()}
    max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) AS m FROM habits").fetchone()["m"]

    for name, category, tracking_type, target_value, unit, weekly_frequency, weekly_metric_unit, section, _ in MIGRATION_HABITS:
        if name in existing_names:
            if section is not None:
                conn.execute(
                    "UPDATE habits SET section = ? WHERE name = ? AND section IS NULL",
                    (section, name),
                )
            if weekly_metric_unit is not None:
                conn.execute(
                    "UPDATE habits SET weekly_metric_unit = ? WHERE name = ? AND weekly_metric_unit IS NULL",
                    (weekly_metric_unit, name),
                )
        else:
            max_order += 1
            conn.execute(
                """INSERT INTO habits
                   (name, category, tracking_type, target_value, unit, weekly_frequency,
                    weekly_metric_unit, section, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (name, category, tracking_type, target_value, unit, weekly_frequency,
                 weekly_metric_unit, section, max_order),
            )

    conn.commit()


def init_db() -> None:
    conn = get_connection()
    try:
        conn.executescript(SCHEMA)
        count = conn.execute("SELECT COUNT(*) AS c FROM habits").fetchone()["c"]
        if count == 0:
            conn.executemany(
                """INSERT INTO habits
                   (name, category, tracking_type, target_value, unit, weekly_frequency,
                    weekly_metric_unit, section, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                DEFAULT_HABITS,
            )
            conn.commit()
        else:
            _migrate(conn)
    finally:
        conn.close()
