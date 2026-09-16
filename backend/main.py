"""FastAPI app: REST API for the lifestyle tracker + serves the static frontend."""

from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

import crud
import database
import garmin_sync
from schemas import (
    DayTypeSet,
    GarminImportRequest,
    GarminPreviewRequest,
    HabitCreate,
    HabitUpdate,
    LogUpsert,
    WeightCreate,
    WeightUpdate,
)

DAY_TYPES = ("home-office", "office", "weekend")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    yield


app = FastAPI(title="Lifestyle Tracker", lifespan=lifespan)


def get_conn():
    return database.get_connection()


# ---------- Habits ----------

@app.get("/api/habits")
def api_list_habits():
    conn = get_conn()
    try:
        return crud.list_habits(conn)
    finally:
        conn.close()


@app.post("/api/habits")
def api_create_habit(habit: HabitCreate):
    if habit.category not in ("daily", "weekly"):
        raise HTTPException(400, "category must be 'daily' or 'weekly'")
    if habit.tracking_type not in ("numeric", "boolean", "sleep"):
        raise HTTPException(400, "tracking_type must be 'numeric', 'boolean', or 'sleep'")
    conn = get_conn()
    try:
        return crud.create_habit(conn, habit.model_dump())
    finally:
        conn.close()


@app.put("/api/habits/{habit_id}")
def api_update_habit(habit_id: int, habit: HabitUpdate):
    conn = get_conn()
    try:
        updated = crud.update_habit(conn, habit_id, habit.model_dump())
        if not updated:
            raise HTTPException(404, "habit not found")
        return updated
    finally:
        conn.close()


@app.delete("/api/habits/{habit_id}")
def api_archive_habit(habit_id: int):
    conn = get_conn()
    try:
        ok = crud.archive_habit(conn, habit_id)
        if not ok:
            raise HTTPException(404, "habit not found")
        return {"ok": True}
    finally:
        conn.close()


# ---------- Logs ----------

@app.get("/api/logs/today")
def api_logs_today():
    conn = get_conn()
    try:
        today = date.today()
        monday, sunday = crud.get_week_bounds(today)
        habits = crud.list_habits(conn)

        daily = []
        for h in habits:
            if h["category"] != "daily":
                continue
            logs = crud.get_logs_in_range(conn, h["id"], today.isoformat(), today.isoformat())
            log = logs[0] if logs else None
            # A Wellness practice only shows up once the user has actually
            # chosen it for today (the Wellness "+ Add" queue) — unlike
            # every other daily habit, it isn't auto-scheduled just for
            # existing. No log yet today means "not selected", not "not done".
            if crud.is_wellness_practice(h) and log is None:
                continue
            daily.append({"habit": h, "log": log})

        weekly = []
        for h in habits:
            if h["category"] != "weekly":
                continue
            sessions = crud.get_logs_in_range(conn, h["id"], monday.isoformat(), sunday.isoformat())
            weekly.append({
                "habit": h,
                "week_start": monday.isoformat(),
                "week_end": sunday.isoformat(),
                "sessions": sessions,
            })

        return {"date": today.isoformat(), "daily": daily, "weekly": weekly}
    finally:
        conn.close()


@app.post("/api/logs")
def api_upsert_log(entry: LogUpsert):
    conn = get_conn()
    try:
        log_date = entry.log_date or date.today().isoformat()
        try:
            return crud.upsert_log(conn, entry.habit_id, log_date, entry.value, entry.note, entry.log_id, entry.value2, entry.extra)
        except ValueError as e:
            raise HTTPException(404, str(e))
    finally:
        conn.close()


@app.get("/api/logs/recent")
def api_logs_recent(limit: int = 200):
    """Flat, raw habit_logs rows (any date, any habit) for the "edit raw
    entries" panel — as opposed to /api/logs/today, which is shaped around
    today/this-week for the dashboard."""
    conn = get_conn()
    try:
        return crud.list_recent_logs(conn, limit)
    finally:
        conn.close()


@app.delete("/api/logs/{log_id}")
def api_delete_log(log_id: int):
    conn = get_conn()
    try:
        ok = crud.delete_log(conn, log_id)
        if not ok:
            raise HTTPException(404, "log not found")
        return {"ok": True}
    finally:
        conn.close()


# ---------- Trends ----------

@app.get("/api/trends/daily")
def api_trends_daily(habit_id: int, days: int = 30):
    conn = get_conn()
    try:
        habit = crud.get_habit(conn, habit_id)
        if not habit:
            raise HTTPException(404, "habit not found")
        result = crud.get_habit_daily_series(conn, habit_id, days)
        return {"habit": habit, "series": result["series"], "has_data": result["has_data"]}
    finally:
        conn.close()


# ---------- Forge Grid (historical proof-of-work) ----------

@app.get("/api/forge-grid")
def api_forge_grid(days: int = 91):
    conn = get_conn()
    try:
        return crud.build_forge_grid_data(conn, days)
    finally:
        conn.close()


# ---------- Weight ----------

@app.get("/api/weight")
def api_list_weight():
    conn = get_conn()
    try:
        return crud.list_weight(conn)
    finally:
        conn.close()


@app.post("/api/weight")
def api_add_weight(entry: WeightCreate):
    conn = get_conn()
    try:
        logged_at = entry.logged_at or date.today().isoformat()
        return crud.add_weight(conn, logged_at, entry.value_kg)
    finally:
        conn.close()


@app.put("/api/weight/{weight_id}")
def api_update_weight(weight_id: int, entry: WeightUpdate):
    conn = get_conn()
    try:
        updated = crud.update_weight(conn, weight_id, entry.logged_at, entry.value_kg)
        if not updated:
            raise HTTPException(404, "weight entry not found")
        return updated
    finally:
        conn.close()


@app.delete("/api/weight/{weight_id}")
def api_delete_weight(weight_id: int):
    conn = get_conn()
    try:
        ok = crud.delete_weight(conn, weight_id)
        if not ok:
            raise HTTPException(404, "weight entry not found")
        return {"ok": True}
    finally:
        conn.close()


# ---------- Day type (home-office / office / weekend) ----------
# Only ever concerns today — see crud.get_day_type for how a date with no
# explicit row here still resolves (the weekday rule), and calculate_daily_
# completion/upsert_log for how it changes Exercise targets/scheduling.

@app.get("/api/day-type")
def api_get_day_type():
    conn = get_conn()
    try:
        today = date.today()
        return {"date": today.isoformat(), "day_type": crud.get_day_type(conn, today)}
    finally:
        conn.close()


@app.put("/api/day-type")
def api_set_day_type(entry: DayTypeSet):
    if entry.day_type not in DAY_TYPES:
        raise HTTPException(400, f"day_type must be one of {DAY_TYPES}")
    conn = get_conn()
    try:
        today = date.today()
        crud.set_day_type(conn, today, entry.day_type)
        return {"date": today.isoformat(), "day_type": entry.day_type}
    finally:
        conn.close()


# ---------- Garmin sync ----------
# Read (preview) and write (import) are separate calls on purpose — nothing
# reaches habit_logs until the user has seen the candidates and picked which
# ones to bring in (see garmin_sync.fetch_candidates / crud.import_garmin_*).

@app.post("/api/garmin/preview")
def api_garmin_preview(req: GarminPreviewRequest):
    try:
        start = date.fromisoformat(req.start_date)
        end = date.fromisoformat(req.end_date)
    except ValueError:
        raise HTTPException(400, "start_date/end_date must be YYYY-MM-DD")
    if end < start:
        raise HTTPException(400, "end_date must be on or after start_date")
    if (end - start).days > garmin_sync.MAX_RANGE_DAYS:
        raise HTTPException(400, f"Range too large — max {garmin_sync.MAX_RANGE_DAYS} days at a time")

    try:
        candidates = garmin_sync.fetch_candidates(start, end)
    except garmin_sync.GarminSyncError as e:
        raise HTTPException(502, str(e))

    conn = get_conn()
    try:
        return crud.annotate_garmin_candidates(conn, candidates)
    finally:
        conn.close()


@app.post("/api/garmin/import")
def api_garmin_import(req: GarminImportRequest):
    conn = get_conn()
    try:
        sleep_habit = crud.get_habit_by_name(conn, "Sleep")
        running_habit = crud.get_habit_by_name(conn, "Running")
        if req.sleep and not sleep_habit:
            raise HTTPException(404, "Sleep habit not found")
        if req.runs and not running_habit:
            raise HTTPException(404, "Running habit not found")

        for rec in req.sleep:
            crud.import_garmin_sleep(conn, sleep_habit["id"], rec.date, rec.duration_hours, rec.score)
        for rec in req.runs:
            crud.import_garmin_run(conn, running_habit["id"], rec.model_dump())

        return {"imported_sleep": len(req.sleep), "imported_runs": len(req.runs)}
    finally:
        conn.close()


# ---------- Static frontend (mounted last so it doesn't shadow /api routes) ----------

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
