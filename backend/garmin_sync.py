"""Garmin Connect integration: pulls sleep + running activities for a date
range and normalizes them into candidate records for the sync dialog to show
before anything is written to habit_logs (see crud.annotate_garmin_candidates
and crud.import_garmin_sleep/import_garmin_run for that write side).

Uses the unofficial `garminconnect` package (no official public API exists
for individual accounts) — treat any failure from Garmin as expected and
surface it as GarminSyncError rather than a raw traceback, since login/MFA
behavior on their end can change without notice.
"""

import logging
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from garminconnect import Garmin, GarminConnectAuthenticationError

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

# Cached OAuth session (garth tokens) so a sync doesn't have to re-login
# every time — a fresh login is what's most likely to trip Garmin's MFA
# challenge. Gitignored; see .gitignore.
TOKEN_DIR = PROJECT_ROOT / "data" / ".garmin_session"

# A single preview call fetches sleep one day at a time (Garmin's API has no
# range endpoint for it), so an unbounded range would mean an unbounded
# number of requests. Enforced in main.py's endpoint.
MAX_RANGE_DAYS = 60


class GarminSyncError(Exception):
    """Message is safe to show directly in the sync dialog."""


def get_client() -> Garmin:
    """Log in (reusing a cached session if one exists) and return an
    authenticated client. Also called directly by garmin_login.py — the
    one-time interactive setup script — since a fresh login is exactly the
    path that can hit Garmin's "enter the code we emailed you" prompt, which
    only a real terminal (not this web app) can answer. See that script's
    docstring."""
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise GarminSyncError(
            "Set GARMIN_EMAIL and GARMIN_PASSWORD in a .env file at the project root first."
        )

    client = Garmin(email, password)
    try:
        client.login(tokenstore=str(TOKEN_DIR))
        return client
    except Exception:
        pass  # no cached session yet, or it's stale — fall through to a fresh login

    try:
        client.login()
    except GarminConnectAuthenticationError:
        raise GarminSyncError("Garmin rejected that email/password — check .env.")
    except EOFError:
        # garth's default MFA handler reads the code via input() — fine in a
        # real terminal, impossible from inside a web request. Garmin asks
        # for this on a login it doesn't recognize (new device/session), not
        # on every login, so a one-time interactive run clears it: once that
        # session gets cached (see the tokenstore branch above), this app
        # never hits sso.login() again until the cache goes stale.
        raise GarminSyncError(
            "Garmin is asking for a one-time login verification code (emailed to you) that this "
            "web app can't answer. Run this once from a terminal, enter the code when prompted, "
            "then retry Sync:\n  venv/bin/python backend/garmin_login.py"
        )
    except Exception as e:
        logger.exception("Garmin login failed")
        raise GarminSyncError(f"Couldn't log into Garmin Connect ({type(e).__name__}: {e})")
    client.garth.dump(str(TOKEN_DIR))
    return client


def _parse_sleep(day_str: str, data: dict) -> Optional[dict]:
    dto = (data or {}).get("dailySleepDTO") or {}
    seconds = dto.get("sleepTimeSeconds")
    if not seconds:
        return None
    scores = dto.get("sleepScores") or (data or {}).get("sleepScores") or {}
    score = (scores.get("overall") or {}).get("value")
    return {
        "type": "sleep",
        "date": day_str,
        "duration_hours": round(seconds / 3600, 2),
        "score": score,
    }


def _parse_run(activity: dict) -> dict:
    distance_m = activity.get("distance") or 0
    duration_s = activity.get("duration") or 0
    distance_km = round(distance_m / 1000, 2)
    pace_min_per_km = round((duration_s / 60) / distance_km, 2) if distance_km else None
    return {
        "type": "run",
        "garmin_activity_id": activity["activityId"],
        "date": (activity.get("startTimeLocal") or "")[:10],
        "name": activity.get("activityName"),
        "activity_subtype": (activity.get("activityType") or {}).get("typeKey"),
        "distance_km": distance_km,
        "duration_seconds": duration_s,
        "pace_min_per_km": pace_min_per_km,
        "avg_hr": activity.get("averageHR"),
        "cadence": activity.get("averageRunningCadenceInStepsPerMinute"),
    }


def fetch_candidates(start: date, end: date) -> dict:
    """{"sleep": [...], "runs": [...]} for [start, end] — read-only, no
    habit_logs writes happen here."""
    client = get_client()

    sleep_records = []
    day = start
    while day <= end:
        try:
            data = client.get_sleep_data(day.isoformat())
            parsed = _parse_sleep(day.isoformat(), data) if data else None
        except Exception as e:
            logger.exception("Garmin sleep fetch/parse failed for %s", day)
            raise GarminSyncError(f"Couldn't read sleep data from Garmin Connect for {day}: {e}")
        if parsed:
            sleep_records.append(parsed)
        day += timedelta(days=1)

    try:
        activities = client.get_activities_by_date(start.isoformat(), end.isoformat(), "running")
        run_records = [_parse_run(a) for a in activities]
    except Exception as e:
        logger.exception("Garmin activities fetch/parse failed")
        raise GarminSyncError(f"Couldn't read runs from Garmin Connect: {e}")

    return {"sleep": sleep_records, "runs": run_records}
