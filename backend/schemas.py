"""Pydantic request/response models."""

from typing import Dict, List, Optional
from pydantic import BaseModel


class HabitCreate(BaseModel):
    name: str
    category: str  # 'daily' | 'weekly'
    tracking_type: str  # 'numeric' | 'boolean'
    target_value: float = 1
    unit: Optional[str] = None
    weekly_frequency: Optional[int] = None
    weekly_metric_unit: Optional[str] = None  # e.g. "km" — logs a number per session instead of just done/not-done
    section: Optional[str] = None  # daily-only grouping label, e.g. "Exercise" / "Wellness"


class HabitUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    tracking_type: Optional[str] = None
    target_value: Optional[float] = None
    unit: Optional[str] = None
    weekly_frequency: Optional[int] = None
    weekly_metric_unit: Optional[str] = None
    section: Optional[str] = None
    sort_order: Optional[int] = None


class LogUpsert(BaseModel):
    habit_id: int
    log_date: Optional[str] = None  # YYYY-MM-DD, defaults to today
    value: float
    value2: Optional[float] = None  # second number for a two-input habit (e.g. Sleep: duration=value, score=value2)
    extra: Optional[Dict[str, float]] = None  # extra named metrics (e.g. Running: {"pace": 5.5, "hr": 142, "cadence": 172})
    note: Optional[str] = None
    log_id: Optional[int] = None  # present -> edit that specific log row


class WeightCreate(BaseModel):
    logged_at: Optional[str] = None  # ISO date/datetime, defaults to now
    value_kg: float


class WeightUpdate(BaseModel):
    logged_at: Optional[str] = None
    value_kg: Optional[float] = None


class DayTypeSet(BaseModel):
    day_type: str  # 'home-office' | 'office' | 'weekend'


class GarminPreviewRequest(BaseModel):
    start_date: str  # YYYY-MM-DD
    end_date: str  # YYYY-MM-DD


class GarminSleepImport(BaseModel):
    date: str
    duration_hours: float
    score: Optional[float] = None


class GarminRunImport(BaseModel):
    date: str
    garmin_activity_id: int
    distance_km: float
    pace_min_per_km: Optional[float] = None
    avg_hr: Optional[float] = None
    cadence: Optional[float] = None


class GarminImportRequest(BaseModel):
    sleep: List[GarminSleepImport] = []
    runs: List[GarminRunImport] = []
