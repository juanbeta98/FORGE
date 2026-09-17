// FORGE frontend — no build step, plain fetch + DOM + Chart.js.

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
};

// toISOString() converts to UTC — in any positive-UTC-offset timezone that
// silently rolls "today" over 1-2 hours early relative to local midnight
// (e.g. 00:15 local on the 14th reads back as the 13th). Build the date from
// local components instead so it always matches the calendar date on screen.
const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  // Lets an immediate trigger (blur, Enter) call off a pending debounced
  // fire — without this, an old value could still commit ~500ms later
  // after the immediate one already saved the current value, and the two
  // overlapping requests can race into duplicate habit_logs rows.
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

const charts = {}; // chart key -> Chart instance
let currentDaily = []; // [{habit, log}] for today
let currentWeekly = []; // [{habit, sessions}] for this week
let numericInputsInOrder = []; // reset each renderDaily() — lets Enter jump to the next field
let todayForgeCell = null; // the Forge Grid cell for today, kept live without a refetch
let forgeGridDays = []; // cached day records from the last /api/forge-grid load, patched live for "today"
const STREAK_THRESHOLD = 0.5; // mirrors backend STREAK_COMPLETION_THRESHOLD

// Every other numeric daily habit (Reading, etc.) keeps the shared crimson
// accent — color there is just effort, not identity.
const CHART_BAR_COLOR = "#a52a49";

// Pushups/Squats/Crunches and Sleep get their own fixed neon colors instead
// — both their Today progress bar AND (for the Exercise trio) their line in
// the combined Exercise chart read the exact same constant below, so the two
// are unmistakably the same habit at a glance. Mirrors the --neon-* custom
// properties in style.css; kept as literal hex here (not read from CSS) since
// these also feed Chart.js, which needs a plain string, not a CSS var.
// green, pink, orange, cyan, violet, coral — by Exercise-section order
// (Pushups, Squats, Crunches, Dips, Rows, Hip Thrusts). 6 distinct colors so
// the combined chart's legend doesn't repeat a color across two different
// exercises; cycles if a 7th is ever added.
const NEON_EXERCISE_COLORS = ["#39ff88", "#ff3fa4", "#ff9f1c", "#22d3ee", "#a78bfa", "#fb7185"];
const NEON_SLEEP_COLOR = "#2ec4ff"; // blue

// Optional extra named metrics per session, keyed by habit name — only
// Running has these today, but any weekly habit could get an entry here
// without a schema change (they're stored as one JSON blob per log, see
// backend crud.upsert_log). Shown in the session-log modal (new entries) and
// the Entries panel's Habit Logs tab (editing existing ones).
const EXTRA_METRIC_FIELDS_BY_HABIT_NAME = {
  Running: [
    { key: "pace", label: "Avg pace", unit: "min/km", step: "0.01" },
    { key: "hr", label: "Avg HR", unit: "bpm", step: "1" },
    { key: "cadence", label: "Avg cadence", unit: "spm", step: "1" },
  ],
};

// ---------- Header status (date / today% / week% / streak) ----------

function updateDateStatus() {
  const label = new Date()
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    .toUpperCase();
  document.getElementById("status-date").textContent = label;
}

// Logging/completion and performance/quality are different things (applies
// throughout: Exercise logs reps vs. hits a target %, Running logs a
// session vs. a distance). For Sleep: completion is binary — both duration
// and score entered — mirroring backend crud.calculate_sleep_completion
// exactly so the live client-side % never drifts from a full reload. A bad
// night that got logged is still logged; this must never read as "didn't
// track Sleep" just because the score was low.
function sleepCompletionFraction(duration, score) {
  return duration && score ? 1 : 0;
}

// The Sleep progress bar represents Score alone — Duration never affects
// it, even though the habit also carries an hours target internally.
function sleepScoreFraction(score) {
  return Math.min(Math.max(score || 0, 0) / 100, 1);
}

// Storage stays decimal hours (matches the backend column and every other
// numeric habit) — only the Today row's display/edit is hh:mm, via a native
// <input type="time">, so a naked "7" is never mistaken for anything other
// than what it is, and it's one compact control instead of two fields.
function decimalHoursToHHMM(decimalHours) {
  const totalMinutes = Math.round((decimalHours || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function hhmmToDecimalHours(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) + (m || 0) / 60;
}

// ---------- Day type (home-office / office / weekend) ----------
// Exercise targets aren't the same every day: home-office is the full
// target, office is half of it, and on a weekend the exercise habits don't
// count toward Today at all — that effort already lives in the Hyrox/
// Sauna/Bouldering weekly habits. Mirrors backend crud.py's get_day_type /
// exercise_target_for_day / _is_exercise_habit exactly, so the live client
// math never drifts from what a full reload recomputes. Only ever concerns
// today — see the toggle wiring further down.
let todayDayType = "home-office";

function isExerciseHabit(habit) {
  return habit.category === "daily" && habit.tracking_type === "numeric" && habit.section === "Exercise";
}

// Mirrors backend crud.is_wellness_practice exactly. A Wellness practice
// only ever appears in currentDaily once the user has explicitly selected
// it for today (the "+ Add" queue) — its absence there means "not chosen",
// never "not done".
function isWellnessPractice(habit) {
  return habit.tracking_type === "boolean" && habit.section === "Wellness";
}

// null means "not scheduled today at all" (weekend) — distinct from 0.
function exerciseTargetForDay(baseTarget, dayType) {
  if (dayType === "weekend") return null;
  if (dayType === "office") return baseTarget / 2;
  return baseTarget;
}

function habitFraction(habit, log) {
  if (habit.tracking_type === "sleep") {
    return sleepCompletionFraction(log ? log.value : 0, log ? log.value2 : 0);
  }
  const value = log ? log.value : 0;
  const target = isExerciseHabit(habit) ? exerciseTargetForDay(habit.target_value, todayDayType) : habit.target_value;
  if (target === null) return null; // excluded from today's average entirely — not scored, not even as 0%
  return Math.min(value / target, 1);
}

function isHabitComplete(habit, log) {
  const fraction = habitFraction(habit, log);
  return fraction !== null && fraction >= 1;
}

// Excluded only when it's an Exercise habit AND today is a weekend — every
// other habit is always scheduled, same as before day types existed.
function isScheduledToday(habit) {
  return !(isExerciseHabit(habit) && todayDayType === "weekend");
}

function computeLiveTodayFraction(daily) {
  const scores = daily.map(({ habit, log }) => habitFraction(habit, log)).filter((f) => f !== null);
  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function computeWeekStatus(weekly) {
  if (!weekly.length) return { fraction: 0, met: 0, total: 0 };
  let totalScore = 0;
  let met = 0;
  for (const { habit, sessions } of weekly) {
    const target = habit.weekly_frequency || 1;
    totalScore += Math.min(sessions.length / target, 1);
    if (sessions.length >= target) met++;
  }
  return { fraction: totalScore / weekly.length, met, total: weekly.length };
}

function bucketLevel(completion, totalHabits) {
  if (!totalHabits || completion <= 0) return 0;
  if (completion >= 1) return 5;
  if (completion >= 0.75) return 4;
  if (completion >= 0.5) return 3;
  if (completion >= 0.25) return 2;
  return 1;
}

// Effort should visibly build the interface up, not just fill a bar somewhere:
// a 0% day stays dark/muted, and text pushes progressively brighter crimson as
// the day fills in, stepping outside the palette to gold only once it's done.
const INTENSITY_TEXT_COLORS = ["#a5384f", "#b23a5e", "#c94a6e", "#e0597e"];
function intensityTextColor(fraction) {
  if (fraction >= 1) return "var(--gold)";
  if (fraction <= 0) return "";
  const idx = Math.min(INTENSITY_TEXT_COLORS.length - 1, Math.floor(fraction * INTENSITY_TEXT_COLORS.length));
  return INTENSITY_TEXT_COLORS[idx];
}

// The whole dashboard responds to a single keystroke, not just the field you
// typed in: today's %, today's Forge Grid cell, and Consistency/streak (all
// derived from the same cached day records) recompute immediately, without
// waiting for a server round-trip. The backend recomputes the same numbers
// from scratch on every full reload, so drift never persists.
function patchTodayIntoForgeDays(todayFraction) {
  if (!forgeGridDays.length) return null;
  const last = forgeGridDays[forgeGridDays.length - 1];
  if (last.date !== todayStr()) return null; // grid hasn't loaded yet / stale — next full reload corrects it
  const scheduledToday = currentDaily.filter(({ habit }) => isScheduledToday(habit));
  last.completion = todayFraction;
  last.total_habits = scheduledToday.length;
  last.completed_habits = currentDaily.filter(({ habit, log }) => isHabitComplete(habit, log)).length;
  return last;
}

function recomputeStreakFromDays(days) {
  if (!days.length) return 0;
  let idx = days.length - 1;
  const today = days[idx];
  const todayCounts = today.total_habits > 0 && today.completion >= STREAK_THRESHOLD;
  if (!todayCounts) idx -= 1; // today in progress doesn't break an existing streak, it just isn't counted yet
  let streak = 0;
  while (idx >= 0 && days[idx].total_habits > 0 && days[idx].completion >= STREAK_THRESHOLD) {
    streak++;
    idx--;
  }
  return streak;
}

// Wellness/Weekly-goals need a per-habit-type breakdown across the whole
// horizon that the cached day records don't carry — they're only ever
// recomputed by a real /api/forge-grid fetch (loadForgeGrid), not this
// instant client-side path. Cached here so an unrelated instant recompute
// (e.g. typing a Pushups value) doesn't flash them to "no data" in between.
// The 30-day rollups (reps volume, km ran, practice session counts) are the
// same story — server-computed across a fixed trailing window, not derived
// from forgeGridDays.
let lastConsistencyExtras = {
  wellness_consistency: null,
  weekly_goals_consistency: null,
  recent_totals: null,
};

function recomputeAndRenderProofStats() {
  if (!forgeGridDays.length) return null;
  const tracked = forgeGridDays.filter((d) => d.total_habits > 0);
  const completions = tracked.map((d) => d.completion);
  const stats = {
    ...lastConsistencyExtras,
    days_shown_up: completions.filter((c) => c > 0).length,
    tracked_days: tracked.length,
    current_streak: recomputeStreakFromDays(forgeGridDays),
  };
  renderProofStats(stats);
  return stats;
}

// Today's % is derived client-side from data already loaded (instant feedback
// as you type); the backend remains the source of truth on every full reload.
function updateHeaderAndBadges() {
  const todayFraction = computeLiveTodayFraction(currentDaily);
  const todayPct = Math.round(todayFraction * 100);
  const todayColor = intensityTextColor(todayFraction);

  const todayBadge = document.getElementById("today-badge");
  todayBadge.textContent = `${todayPct}%`;
  todayBadge.style.color = todayColor;

  const week = computeWeekStatus(currentWeekly);
  document.getElementById("week-badge").textContent = `${week.met}/${week.total} targets`;

  if (todayForgeCell) {
    todayForgeCell.className = "forge-cell today";
    if (currentDaily.length === 0) {
      todayForgeCell.classList.add("pretrack");
    } else {
      const level = bucketLevel(todayFraction, currentDaily.length);
      if (level > 0) todayForgeCell.classList.add(`level-${level}`);
      if (todayFraction >= 1) todayForgeCell.classList.add("gold");
    }
    todayForgeCell.title = `${todayStr()}\n${todayPct}% complete`;
  }

  patchTodayIntoForgeDays(todayFraction);
  recomputeAndRenderProofStats();
}

// ---------- Loaders ----------

async function loadToday() {
  const data = await api("/api/logs/today");
  currentDaily = data.daily;
  currentWeekly = data.weekly;
  renderDaily(currentDaily);
  renderWeekly(currentWeekly);
  updateHeaderAndBadges();
}

// 12 complete weeks + the current in-progress week (backend aligns to whole
// Monday-Sunday weeks) — recent evidence of consistency, not a sprawling
// archive. Bigger cells at this range make the grid the dashboard's
// centerpiece faster than a six-month window mostly full of pre-tracking days.
const FORGE_GRID_DAYS = 91;

// Shorter than the grid's own horizon on purpose — this early into tracking,
// 30 days of mostly-blank history read as empty rather than informative.
// 15 keeps every chart's window meaningfully full; revisit as more history
// accumulates.
const CHART_HISTORY_DAYS = 15;

async function loadForgeGrid() {
  const data = await api(`/api/forge-grid?days=${FORGE_GRID_DAYS}`);
  forgeGridDays = data.days;
  lastConsistencyExtras = {
    wellness_consistency: data.stats.wellness_consistency,
    weekly_goals_consistency: data.stats.weekly_goals_consistency,
    recent_totals: data.stats.recent_totals,
  };
  renderForgeGrid(forgeGridDays);
  updateHeaderAndBadges(); // now that todayForgeCell exists, paints it (and recomputes stats) with live data immediately
}

// All secondary charts render at once — no carousel. History shouldn't hide
// behind slides just because there are a few habits to show.
let trendItems = []; // [{kind:'weight', data} | {kind:'exercise', habits, seriesByHabit, hasData} | {kind:'habit', habit, showTarget, data, hasData}]

// Pushups/Squats/Crunches (any daily numeric habit under the Exercise
// section — not hardcoded by name, so a new Exercise habit just joins the
// combined chart) share one "% of target" chart instead of three separate
// raw-reps charts, so different rep targets can sit on one comparable axis.
async function loadExerciseItem(exerciseHabits) {
  const perHabit = await Promise.all(
    exerciseHabits.map((h) => api(`/api/trends/daily?habit_id=${h.id}&days=${CHART_HISTORY_DAYS}`))
  );
  const hasData = perHabit.some((r) => r.has_data);
  const seriesByHabit = exerciseHabits.map((h, i) => ({
    habit: h,
    // Each day compares to ITS OWN standard (home-office/office target that
    // actually applied that day — see backend get_habit_daily_series), not
    // one flat target for the whole 30-day window.
    series: perHabit[i].series.map((s) => ({
      date: s.date,
      pct: s.target ? (s.value / s.target) * 100 : 0,
    })),
  }));
  return { kind: "exercise", habits: exerciseHabits, seriesByHabit, hasData };
}

async function loadTrends(habits) {
  const numericDaily = habits.filter((h) => h.category === "daily" && h.tracking_type === "numeric");
  const exerciseHabits = numericDaily.filter((h) => h.section === "Exercise");
  const otherDaily = numericDaily.filter((h) => h.section !== "Exercise");
  const metricWeekly = habits.filter((h) => h.category === "weekly" && h.weekly_metric_unit);
  const sleepHabit = habits.find((h) => h.tracking_type === "sleep");

  const weightEntries = await api("/api/weight");
  const items = [{ kind: "weight", data: weightEntries }];

  if (exerciseHabits.length) items.push(await loadExerciseItem(exerciseHabits));

  for (const h of [...otherDaily, ...metricWeekly]) {
    const { series, has_data } = await api(`/api/trends/daily?habit_id=${h.id}&days=${CHART_HISTORY_DAYS}`);
    items.push({ kind: "habit", habit: h, showTarget: h.category === "daily", data: series, hasData: has_data });
  }

  if (sleepHabit) {
    const { series, has_data } = await api(`/api/trends/daily?habit_id=${sleepHabit.id}&days=${CHART_HISTORY_DAYS}`);
    items.push({ kind: "sleep", habit: sleepHabit, data: series, hasData: has_data });
  }

  trendItems = items;
  renderAllTrendCharts();
}

// Called after logging a new weight entry — refreshes just the cached data
// and re-renders (cheap: only ever a handful of small charts).
async function refreshWeightData() {
  const entries = await api("/api/weight");
  const item = trendItems.find((it) => it.kind === "weight");
  if (item) item.data = entries;
  renderAllTrendCharts();
}

function destroyAllCharts(prefix) {
  for (const key of Object.keys(charts)) {
    if (!prefix || key.startsWith(prefix)) {
      charts[key].destroy();
      delete charts[key];
    }
  }
}

function renderAllTrendCharts() {
  destroyAllCharts("habit-");
  destroyAllCharts("weight");
  destroyAllCharts("exercise");
  destroyAllCharts("sleep");
  document.getElementById(PRIMARY_CHARTS_ID).innerHTML = "";
  document.getElementById(SECONDARY_CHARTS_ID).innerHTML = "";

  for (const item of trendItems) {
    if (item.kind === "weight") {
      renderWeightChart(item.data);
    } else if (item.kind === "exercise") {
      if (item.hasData) renderExerciseChart(item.seriesByHabit);
      else renderEmptyExerciseBox();
    } else if (item.kind === "sleep") {
      if (item.hasData) renderSleepChart(item.habit, item.data);
      else renderEmptySleepBox(item.habit);
    } else if (item.hasData) {
      renderHabitDailyChart(item.habit, item.data, item.showTarget);
    } else {
      renderEmptyChartBox(item.habit);
    }
  }
}

let quotesCache = null;
async function loadQuote() {
  if (!quotesCache) {
    quotesCache = await fetch("quotes.json").then((r) => r.json());
  }
  const q = quotesCache[Math.floor(Math.random() * quotesCache.length)];
  document.getElementById("quote-text").textContent = `“${q.text}”`;
  document.getElementById("quote-author").textContent = q.author ? `— ${q.author}` : "";
}

// Full habit definitions, regardless of whether they're selected for today —
// the Wellness "+ Add" selector needs to know every practice that EXISTS
// (habits) to offer the ones NOT in currentDaily (selected). Refreshed
// whenever refreshAll() runs; selection state itself lives in currentDaily.
let allHabits = [];

async function refreshAll() {
  // Today's rendering/scoring reads todayDayType synchronously, so it must
  // be current before loadToday() (and the trends/forge-grid fetches, which
  // also depend on it server-side) run.
  const dayTypeData = await api("/api/day-type");
  todayDayType = dayTypeData.day_type;
  allHabits = await api("/api/habits");
  await Promise.all([loadToday(), loadTrends(allHabits), loadForgeGrid()]);
}

// ---------- Rendering: Today (daily habits, grouped by section) ----------

function updateLocalDailyLog(habitId, value, value2) {
  const item = currentDaily.find((d) => d.habit.id === habitId);
  if (item) item.log = { ...(item.log || {}), value, ...(value2 !== undefined ? { value2 } : {}) };
  updateHeaderAndBadges();
  patchTodayIntoHabitChart(habitId, value, value2);
}

// Reflects today's new value straight into its trend chart — patches the
// existing Chart.js instance if one's already rendered, or fetches once and
// upgrades a "No data yet" placeholder the first time a habit gets a value.
function patchTodayIntoHabitChart(habitId, value, value2) {
  const exerciseItem = trendItems.find((it) => it.kind === "exercise" && it.habits.some((h) => h.id === habitId));
  if (exerciseItem) {
    patchTodayIntoExerciseChart(exerciseItem, habitId, value);
    return;
  }

  const sleepItem = trendItems.find((it) => it.kind === "sleep" && it.habit.id === habitId);
  if (sleepItem) {
    patchTodayIntoSleepChart(sleepItem, value, value2);
    return;
  }

  const key = `habit-${habitId}`;
  const chart = charts[key];
  if (chart) {
    const idx = chart.data.labels.length - 1; // these series always end on today
    chart.data.datasets[0].data[idx] = value;
    chart.update("none");
    return;
  }
  const item = trendItems.find((it) => it.kind === "habit" && it.habit.id === habitId);
  if (!item || item.hasData) return; // not a charted habit, or already has a live chart
  api(`/api/trends/daily?habit_id=${habitId}&days=${CHART_HISTORY_DAYS}`).then(({ series, has_data }) => {
    item.data = series;
    item.hasData = has_data;
    if (!has_data) return;
    document.getElementById(`box-habit-${habitId}`)?.remove();
    renderHabitDailyChart(item.habit, series, item.showTarget);
  });
}

function patchTodayIntoExerciseChart(item, habitId, value) {
  const habit = item.habits.find((h) => h.id === habitId);
  if (!habit) return;
  const todayTarget = exerciseTargetForDay(habit.target_value, todayDayType);
  const pct = todayTarget ? (value / todayTarget) * 100 : 0;

  const chart = charts["exercise"];
  if (chart) {
    const dataset = chart.data.datasets.find((d) => d.habitId === habitId);
    if (dataset) {
      dataset.data[dataset.data.length - 1] = pct; // these series always end on today
      chart.update("none");
    }
    return;
  }
  if (item.hasData) return; // chart should already exist if hasData was true

  // First real value logged for any of the exercise habits — refetch the
  // combined series and upgrade the empty placeholder into a live chart.
  loadExerciseItem(item.habits).then((fresh) => {
    item.seriesByHabit = fresh.seriesByHabit;
    item.hasData = fresh.hasData;
    if (!item.hasData) return;
    document.getElementById("box-exercise")?.remove();
    renderExerciseChart(item.seriesByHabit);
  });
}

function patchTodayIntoSleepChart(item, duration, score) {
  const chart = charts["sleep"];
  if (chart) {
    const durationData = chart.data.datasets[0].data;
    const scoreData = chart.data.datasets[1].data;
    durationData[durationData.length - 1] = duration; // these series always end on today
    scoreData[scoreData.length - 1] = score || 0;
    chart.update("none");
    return;
  }
  if (item.hasData) return; // chart should already exist if hasData was true

  // First real Sleep entry — refetch its series and upgrade the empty
  // placeholder into a live chart.
  api(`/api/trends/daily?habit_id=${item.habit.id}&days=${CHART_HISTORY_DAYS}`).then(({ series, has_data }) => {
    item.data = series;
    item.hasData = has_data;
    if (!has_data) return;
    document.getElementById("box-sleep")?.remove();
    renderSleepChart(item.habit, series);
  });
}

function buildHabitRow(habit, log, color) {
  const value = log ? log.value : 0;
  const complete = value >= habit.target_value;

  if (habit.tracking_type === "boolean") {
    // A <label> wrapping the checkbox + name is natively clickable anywhere
    // across the row (no JS needed for hit-area), and is the semantically
    // correct control to pair with an <input>.
    const label = document.createElement("label");
    label.className = "habit-row" + (complete ? " complete" : "");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = habit.name;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = complete;
    checkbox.addEventListener("change", async () => {
      const v = checkbox.checked ? 1 : 0;
      await api("/api/logs", {
        method: "POST",
        body: JSON.stringify({ habit_id: habit.id, log_date: todayStr(), value: v }),
      });
      updateLocalDailyLog(habit.id, v);
      label.classList.toggle("complete", checkbox.checked);
      // The Wellness consistency bar is computed server-side across the
      // whole horizon (not just today) — a boolean toggle is the one thing
      // that can move it, so refetch it rather than let it go stale until
      // the next full reload.
      loadForgeGrid();
    });

    label.append(name, checkbox);
    return label;
  }

  if (habit.tracking_type === "sleep") {
    // Duration and Score are two independent measurements, never blended
    // into one number or one bar: SLEEP | [hh:mm] | [score] /100 | score
    // bar. No DURATION/SCORE text labels — the hh:mm format and the /100
    // suffix already say what each number is. Deliberately never gets the
    // crimson "complete" treatment Wellness practices use for chosen/done —
    // Sleep is a measured metric, not a chosen action, and the cyan bar is
    // its own distinct visual language.
    const duration = log ? log.value : 0;
    const score = log && log.value2 != null ? log.value2 : 0;

    const row = document.createElement("div");
    row.className = "habit-row sleep-row";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = habit.name;

    // One compact hh:mm control, never a naked decimal or two separate
    // fields — a native time input gives free hh:mm entry/validation
    // (00-23 / 00-59) without any text parsing of our own.
    const durationInput = document.createElement("input");
    durationInput.className = "sleep-duration-input";
    durationInput.type = "time";
    durationInput.step = "60"; // whole minutes — no seconds segment
    durationInput.value = duration ? decimalHoursToHHMM(duration) : "";

    // Score: the number the bar visualizes.
    const scoreInput = document.createElement("input");
    scoreInput.type = "number";
    scoreInput.min = "0";
    scoreInput.max = "100";
    scoreInput.step = "1";
    scoreInput.value = score || "";
    const scoreUnit = document.createElement("span");
    scoreUnit.className = "sleep-unit";
    scoreUnit.textContent = "/100";

    const scoreControl = document.createElement("span");
    scoreControl.className = "sleep-score-control";
    scoreControl.append(scoreInput, scoreUnit);

    // Bar: Score only. Duration has zero effect on it. Gets the flexible
    // remaining width — duration/score only ever take what they need.
    const barWrap = document.createElement("span");
    barWrap.className = "sleep-bar-wrap";
    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${sleepScoreFraction(score) * 100}%`;
    fill.style.background = NEON_SLEEP_COLOR;
    track.appendChild(fill);
    barWrap.appendChild(track);

    const doCommit = async () => {
      const d = hhmmToDecimalHours(durationInput.value);
      const s = parseFloat(scoreInput.value) || 0;
      await api("/api/logs", {
        method: "POST",
        body: JSON.stringify({ habit_id: habit.id, log_date: todayStr(), value: d, value2: s }),
      });
      updateLocalDailyLog(habit.id, d, s);
      fill.style.width = `${sleepScoreFraction(s) * 100}%`;
    };
    // Duration and score share one commit, and blur/Enter/debounce can all
    // reach it — chaining onto commitChain keeps saves sequential instead of
    // letting two overlapping requests race into duplicate habit_logs rows.
    let commitChain = Promise.resolve();
    const commit = () => {
      debouncedCommit.cancel();
      commitChain = commitChain.then(doCommit, doCommit);
      return commitChain;
    };
    const debouncedCommit = debounce(commit, 500);

    for (const input of [durationInput, scoreInput]) {
      input.addEventListener("input", debouncedCommit);
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        // Don't also commit() here — moving/removing focus below fires
        // this same input's blur listener synchronously, which commits.
        // Calling both was firing two overlapping saves per Enter press.
        const next = numericInputsInOrder[numericInputsInOrder.indexOf(input) + 1];
        if (next) { next.focus(); next.select(); } else input.blur();
      });
      numericInputsInOrder.push(input);
    }

    row.append(name, durationInput, scoreControl, barWrap);
    return row;
  }

  // Numeric: name — inline progress bar — editable value — "/target unit".
  // For an Exercise habit, "target" isn't fixed — it's home-office's full
  // value, half of that on an office day, or not scheduled at all (null) on
  // a weekend, per the day-type toggle.
  const isExercise = isExerciseHabit(habit);
  const effectiveTarget = isExercise ? exerciseTargetForDay(habit.target_value, todayDayType) : habit.target_value;
  const excludedToday = effectiveTarget === null;
  const numericComplete = !excludedToday && value >= effectiveTarget;

  const row = document.createElement("div");
  row.className = "habit-row numeric" + (numericComplete ? " complete" : "") + (excludedToday ? " excluded-today" : "");

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = habit.name;

  const track = document.createElement("div");
  track.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  // Excluded rows still show progress against the base target as informal
  // reference (a bonus weekend session is still nice to see), it just never
  // factors into Today's %.
  fill.style.width = `${Math.min((value / (effectiveTarget ?? habit.target_value)) * 100, 100)}%`;
  if (color) fill.style.background = color;
  track.appendChild(fill);

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  // Exercise reps get bumped in chunks of 5 via the spinner arrows — that's
  // how they're actually adjusted day to day, vs. typing an exact number.
  // Every other numeric daily habit keeps fine-grained 0.01 steps.
  input.step = isExercise ? "5" : "0.01";
  input.value = value;

  const progress = document.createElement("span");
  progress.className = "progress-text";
  // Unit is dropped here — the section heading already makes it obvious
  // (Exercise → reps), and it's still shown in Settings where it matters.
  progress.textContent = excludedToday ? "not tracked today" : `/${effectiveTarget}`;

  const doCommit = async () => {
    const v = parseFloat(input.value) || 0;
    await api("/api/logs", {
      method: "POST",
      body: JSON.stringify({ habit_id: habit.id, log_date: todayStr(), value: v }),
    });
    updateLocalDailyLog(habit.id, v);
    fill.style.width = `${Math.min((v / (effectiveTarget ?? habit.target_value)) * 100, 100)}%`;
    row.classList.toggle("complete", !excludedToday && v >= effectiveTarget);
  };
  // input/blur/Enter can all reach this — chaining onto commitChain keeps
  // saves sequential instead of letting two overlapping requests race into
  // duplicate habit_logs rows (see backend upsert_log's BEGIN IMMEDIATE,
  // which only closes half of this race without this frontend fix).
  let commitChain = Promise.resolve();
  const commit = () => {
    debouncedCommit.cancel();
    commitChain = commitChain.then(doCommit, doCommit);
    return commitChain;
  };
  const debouncedCommit = debounce(commit, 500);

  input.addEventListener("input", debouncedCommit);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Don't also commit() here — moving/removing focus below fires this
    // same input's blur listener synchronously, which commits. Calling
    // both was firing two overlapping saves per Enter press.
    const next = numericInputsInOrder[numericInputsInOrder.indexOf(input) + 1];
    if (next) { next.focus(); next.select(); } else input.blur();
  });
  numericInputsInOrder.push(input);

  const valueGroup = document.createElement("span");
  valueGroup.className = "value-group";
  valueGroup.append(input, progress);

  row.append(name, track, valueGroup);
  return row;
}

const DAY_TYPE_OPTIONS = [
  { value: "home-office", label: "Home-office" },
  { value: "office", label: "Office" },
  { value: "weekend", label: "Weekend" },
];

// Only Exercise's targets/scheduling depend on this, so the toggle lives
// right on that section's heading row rather than in the page header.
function buildDayTypeToggle() {
  const wrap = document.createElement("div");
  wrap.className = "day-type-toggle";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Day type");

  for (const opt of DAY_TYPE_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.label;
    btn.className = "day-type-btn" + (opt.value === todayDayType ? " active" : "");
    btn.addEventListener("click", async () => {
      if (opt.value === todayDayType) return;
      await api("/api/day-type", { method: "PUT", body: JSON.stringify({ day_type: opt.value }) });
      todayDayType = opt.value;
      // Targets, exclusion, today's %, the Exercise chart, and the Forge
      // Grid/Consistency block all depend on this — simplest to just
      // refetch everything rather than patch each one individually.
      refreshAll();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

// ---------- Wellness: a daily, user-chosen queue (not a fixed checklist) ----------
// Reserves a fixed 2x2 slot area regardless of 0-4 selected practices (see
// .wellness-queue in style.css — an explicit 2-row grid template, occupied
// or not), so choosing/completing/removing one never changes Today's
// height. "Selected" simply means a habit_logs row exists for today (value
// 0 = chosen, not done yet; 1 = done) — the same upsert/delete endpoints
// used everywhere else, no new API surface for this.

function buildWellnessQueue(wellnessItems) {
  const grid = document.createElement("div");
  grid.className = "bool-grid wellness-queue";

  if (!wellnessItems.length) {
    // Zero selected is a neutral state, not a failure — no unchecked
    // cards, no 0/4, no warning color. One quiet message filling the same
    // reserved area instead of four empty boxes.
    const empty = document.createElement("div");
    empty.className = "wellness-empty";
    empty.textContent = "Choose a wellness practice";
    grid.appendChild(empty);
    return grid;
  }

  for (const { habit, log } of wellnessItems) {
    grid.appendChild(buildWellnessSlot(habit, log));
  }
  return grid;
}

function buildWellnessSlot(habit, log) {
  // The remove button is a SIBLING of the checkbox <label>, not nested
  // inside it — nesting a button inside a <label> risks the label's native
  // click-forwarding toggling the checkbox on the way out.
  const wrap = document.createElement("div");
  wrap.className = "wellness-slot";
  wrap.appendChild(buildHabitRow(habit, log));

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "wellness-remove-btn";
  removeBtn.textContent = "✕";
  removeBtn.title = `Remove ${habit.name} from today`;
  removeBtn.addEventListener("click", async () => {
    if (!log) return;
    await api(`/api/logs/${log.id}`, { method: "DELETE" });
    refreshAll();
  });
  wrap.appendChild(removeBtn);
  return wrap;
}

function buildWellnessAddControl() {
  const wrap = document.createElement("div");
  wrap.className = "wellness-add-wrap";

  const selectedIds = new Set(currentDaily.filter(({ habit }) => isWellnessPractice(habit)).map(({ habit }) => habit.id));
  const unselected = allHabits.filter((h) => isWellnessPractice(h) && !selectedIds.has(h.id));

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wellness-add-btn";
  btn.textContent = "+ Add";
  btn.disabled = unselected.length === 0; // all 4 already selected — nothing left to offer

  const menu = document.createElement("div");
  menu.className = "wellness-add-menu";
  menu.hidden = true;
  for (const h of unselected) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = h.name;
    item.addEventListener("click", async () => {
      menu.hidden = true;
      await api("/api/logs", {
        method: "POST",
        body: JSON.stringify({ habit_id: h.id, log_date: todayStr(), value: 0 }),
      });
      refreshAll();
    });
    menu.appendChild(item);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let this immediately re-trigger the document-level close-on-outside-click handler
    if (btn.disabled) return;
    document.querySelectorAll(".wellness-add-menu").forEach((m) => { if (m !== menu) m.hidden = true; });
    menu.hidden = !menu.hidden;
  });

  wrap.append(btn, menu);
  return wrap;
}

// Today is an internal two-column composition, ~55/45 (see .today-columns) —
// the first section (Exercise) on the left, every other section (Wellness,
// and anything added later) stacked on the right. Within a right-hand
// section, binary habits compact into a 2-column grid and any multi-input
// row (Sleep) spans full width beneath it, rather than one flat vertical
// list — that's what actually shortens the card, not a page-level 3rd column.
function renderDaily(daily) {
  const container = document.getElementById("daily-rows");
  container.innerHTML = "";
  numericInputsInOrder = [];

  const groups = new Map();
  for (const item of daily) {
    const key = item.habit.section || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const leftCol = document.createElement("div");
  leftCol.className = "today-col today-col-exercise";
  const rightCol = document.createElement("div");
  rightCol.className = "today-col today-col-wellness";

  [...groups.entries()].forEach(([section, items], idx) => {
    const target = idx === 0 ? leftCol : rightCol;

    const heading = document.createElement("div");
    heading.className = "section-heading";
    heading.textContent = section;

    if (idx === 0) {
      // The day-type toggle only affects Exercise targets/scheduling, so it
      // lives right on that section's own heading row, not in the header.
      const headingRow = document.createElement("div");
      headingRow.className = "section-heading-row";
      headingRow.append(heading, buildDayTypeToggle());
      target.appendChild(headingRow);

      // 2 columns x N rows (auto-flow:column) rather than one tall list —
      // with 6 exercises that's what keeps Today's height unchanged. Column
      // placement is purely a consequence of habit order (Pushups/Squats/
      // Crunches, then Dips/Rows/Hip Thrusts land left/right automatically),
      // not hardcoded per name — see database.py's DEFAULT_HABITS ordering.
      const grid = document.createElement("div");
      grid.className = "exercise-grid";
      grid.style.gridTemplateRows = `repeat(${Math.ceil(items.length / 2)}, auto)`;
      items.forEach(({ habit, log }, i) => {
        grid.appendChild(buildHabitRow(habit, log, NEON_EXERCISE_COLORS[i % NEON_EXERCISE_COLORS.length]));
      });
      target.appendChild(grid);
      return;
    }

    // Wellness (and any further section): quantitative rows first (e.g.
    // Reading), then the Wellness queue (a fixed 2x2 slot area — see
    // buildWellnessQueue), then any multi-input row (Sleep) spans the full
    // width beneath it and never moves regardless of queue size.
    const headingRow = document.createElement("div");
    headingRow.className = "section-heading-row";
    headingRow.append(heading);
    if (section === "Wellness") headingRow.appendChild(buildWellnessAddControl());
    target.appendChild(headingRow);

    const normalItems = items.filter(({ habit }) => habit.tracking_type === "numeric");
    const wellnessItems = items.filter(({ habit }) => isWellnessPractice(habit));
    const wideItems = items.filter(({ habit }) => habit.tracking_type !== "numeric" && !isWellnessPractice(habit));

    for (const { habit, log } of normalItems) target.appendChild(buildHabitRow(habit, log));

    if (section === "Wellness") target.appendChild(buildWellnessQueue(wellnessItems));

    for (const { habit, log } of wideItems) target.appendChild(buildHabitRow(habit, log));
  });

  container.append(leftCol, rightCol);
}

// ---------- Rendering: This Week (one fixed-height row per activity) ----------
// This panel is a summary, not the log: it answers "how many sessions, what
// was the latest one, is the target met" — never grows with usage. Logging a
// session updates THIS row in place; it never appends a visible record
// underneath it. Every individual session is still stored (see backend
// upsert_log) and inspecting/deleting one happens in Entries, not here.

function renderWeekly(weekly) {
  const container = document.getElementById("weekly-rows");
  container.innerHTML = "";

  for (const { habit, sessions } of weekly) {
    const target = habit.weekly_frequency || 1;
    const met = sessions.length >= target;

    const wrap = document.createElement("div");
    wrap.className = "weekly-habit" + (met ? " complete" : "");

    const summary = document.createElement("div");
    summary.className = "summary";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = habit.name;

    const fraction = document.createElement("span");
    fraction.className = "fraction";
    fraction.textContent = `${met ? "✓ " : ""}${sessions.length}/${target}`;

    const latest = sessions[sessions.length - 1];
    const detail = document.createElement("span");
    detail.className = "detail";
    // "Sep 09" rather than "2026-09-09" — shorter, and leaves room for the
    // metric alongside it in a compact column instead of forcing a wide one.
    // One decimal place on the metric ("3.6 km", never "3.63 km") is a
    // deliberate compact summary, not a rounding bug — the exact stored
    // value is unaffected and still shown in full in Entries.
    const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "2-digit" });
    detail.textContent = latest
      ? `${shortDate(latest.log_date)}${habit.weekly_metric_unit ? ` · ${latest.value.toFixed(1)} ${habit.weekly_metric_unit}` : ""}`
      : "—";

    // Once the target's met, the button steps back to secondary — FORGE
    // should only visually ask for attention where work still remains.
    const logBtn = document.createElement("button");
    logBtn.type = "button";
    logBtn.className = "log-btn" + (met ? " secondary" : "");
    logBtn.textContent = met ? "+ LOG" : "LOG";
    logBtn.addEventListener("click", () => openSessionModal(habit));

    summary.append(name, fraction, detail, logBtn);
    wrap.appendChild(summary);
    container.appendChild(wrap);
  }
}

// ---------- Rendering: Forge Grid + Proof of Work stats ----------

function forgeDayOfWeekMon0(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return (d.getDay() + 6) % 7; // JS: Sun=0..Sat=6 → Mon=0..Sun=6
}

// Cell size is measured, not guessed: the grid's flex share of the layout
// varies with viewport size (and with whatever the Consistency block next
// to it needs), so a fixed px guess either wastes space or overflows onto
// that block. This computes the largest square cell that actually fits the
// real available width for however many week-columns are showing, keeping
// the same physical footprint while making cells as large as that footprint
// allows — which is the actual goal, not a specific pixel count.
const FORGE_GAP = 4; // must match --forge-gap in style.css
function sizeForgeGrid(columns) {
  const wrap = document.querySelector(".forge-grid-wrap");
  const weekdayLabels = document.querySelector(".forge-weekday-labels");
  if (!wrap || !weekdayLabels || !columns) return;
  const available = wrap.clientWidth - weekdayLabels.getBoundingClientRect().width - FORGE_GAP;
  const maxCellFromWidth = Math.floor((available - (columns - 1) * FORGE_GAP) / columns);
  const cell = Math.max(14, Math.min(30, maxCellFromWidth));
  wrap.style.setProperty("--forge-cell", `${cell}px`);
}

let forgeGridColumnCount = 0;
window.addEventListener("resize", debounce(() => sizeForgeGrid(forgeGridColumnCount), 150));

function renderForgeGrid(days) {
  const grid = document.getElementById("forge-grid");
  grid.innerHTML = "";
  todayForgeCell = null;
  if (!days.length) return;

  const leadingBlanks = forgeDayOfWeekMon0(days[0].date);
  const cells = [...Array(leadingBlanks).fill(null), ...days];
  const today = todayStr();

  forgeGridColumnCount = Math.ceil(cells.length / 7);
  sizeForgeGrid(forgeGridColumnCount);

  for (const day of cells) {
    const cell = document.createElement("div");
    cell.className = "forge-cell";
    if (!day) {
      // A leading padding cell (aligns the first partial week) isn't a real
      // day at all — it must read as even less than "before tracking", not
      // default to the visible tracked-zero gray.
      cell.classList.add("pretrack");
    } else if (day.date === today) {
      // updateHeaderAndBadges() (called right after this) owns today's
      // final level/gold styling from live data — this just marks it.
      cell.classList.add("today");
      todayForgeCell = cell;
    } else if (day.total_habits === 0) {
      cell.classList.add("pretrack"); // the habit didn't exist yet — not a zero-effort day
    } else {
      const level = bucketLevel(day.completion, day.total_habits);
      if (level > 0) cell.classList.add(`level-${level}`);
    }
    if (day) {
      cell.title = day.total_habits > 0
        ? `${day.date}\n${Math.round(day.completion * 100)}% complete\n${day.completed_habits}/${day.total_habits} habits completed`
        : `${day.date}\nBefore tracking began`;
    }
    grid.appendChild(cell);
  }

  renderForgeMonthLabels(cells);
}

// One label per column (week) where a new month begins — more useful for
// reading history at a glance than a repeated weekday header.
function renderForgeMonthLabels(cells) {
  const container = document.getElementById("forge-months");
  container.innerHTML = "";
  let lastMonth = null;
  let lastCol = -Infinity;
  for (let col = 0; col * 7 < cells.length; col++) {
    const weekCells = cells.slice(col * 7, col * 7 + 7);
    const firstDay = weekCells.find((d) => d);
    if (!firstDay) continue;
    const month = firstDay.date.slice(0, 7); // "YYYY-MM"
    if (month === lastMonth) continue;
    // Skip a label that would sit right next to the previous one — a 3-letter
    // month name needs a bit more than one 16px column of room to not collide.
    if (col - lastCol < 3) continue;
    lastMonth = month;
    lastCol = col;
    const span = document.createElement("span");
    span.style.gridColumn = String(col + 1);
    span.textContent = new Date(`${firstDay.date}T00:00:00`).toLocaleDateString(undefined, { month: "short" });
    container.appendChild(span);
  }
}

// A compact summary beside the Forge Grid, not a competing visual — the
// grid is primary, this is supporting detail. Two consistency dimensions
// get their own progress bar (Wellness: the 4 checkbox Wellness habits only,
// never Sleep; Weekly goals: completed/prescribed sessions across every
// weekly habit) since "did I show up" and "did I hit the target" are
// genuinely different questions — no single blended "Consistency" number.
// Days shown up / streak / perfect days stay as plain supporting stat rows.
function buildConsistencyBar(label, fraction) {
  const hasData = fraction !== null && fraction !== undefined;

  const row = document.createElement("div");
  row.className = "consistency-bar-row";

  const head = document.createElement("div");
  head.className = "consistency-bar-head";
  head.innerHTML = `<span class="label">${label}</span><span class="value">${hasData ? Math.round(fraction * 100) + "%" : "—"}</span>`;
  if (hasData) head.querySelector(".value").style.color = intensityTextColor(fraction) || "";

  const track = document.createElement("div");
  track.className = "progress-track consistency-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.style.width = `${hasData ? Math.min(Math.max(fraction, 0), 1) * 100 : 0}%`;
  track.appendChild(fill);

  row.append(head, track);
  return row;
}

// "Days shown up" earns green past 80% rather than riding the same
// crimson-to-gold ramp as everything else — at that point it's read as a
// solid, "done" result, not just more effort on the way to 100%.
const DAYS_SHOWN_UP_GREEN_THRESHOLD = 0.8;
function daysShownUpColor(fraction) {
  if (fraction > DAYS_SHOWN_UP_GREEN_THRESHOLD) return "var(--neon-green)";
  return intensityTextColor(fraction) || "";
}

function renderProofStats(stats) {
  const el = document.getElementById("proof-stats");
  el.innerHTML = "";

  // Two tiers, each its own flex-sized block (see .consistency-top /
  // .consistency-recent in style.css for the ~55/45 vertical split) —
  // Consistency (adherence, top) vs Last 30 days (accumulated evidence,
  // bottom).
  const top = document.createElement("div");
  top.className = "consistency-top";

  const heading = document.createElement("div");
  heading.className = "section-heading consistency-heading";
  heading.textContent = "Consistency";
  top.appendChild(heading);

  top.appendChild(buildConsistencyBar("Wellness", stats.wellness_consistency));
  top.appendChild(buildConsistencyBar("Weekly goals", stats.weekly_goals_consistency));

  // Same principle as the header: zero is neutral, brightness is earned.
  // Streak has no natural 0..1 ceiling, so it's judged against a 2-week span.
  const statsList = document.createElement("div");
  statsList.className = "consistency-stats";
  const daysShownUpFraction = stats.tracked_days ? stats.days_shown_up / stats.tracked_days : 0;
  const rows = [
    ["Days shown up", `${stats.days_shown_up}/${stats.tracked_days}`, daysShownUpColor(daysShownUpFraction)],
    ["Current streak", `${stats.current_streak} day${stats.current_streak === 1 ? "" : "s"}`, intensityTextColor(Math.min(stats.current_streak / 14, 1)) || ""],
  ];
  for (const [label, value, color] of rows) {
    const row = document.createElement("div");
    row.className = "stat";
    row.innerHTML = `<span class="label">${label}</span><span class="value">${value}</span>`;
    row.querySelector(".value").style.color = color;
    statsList.appendChild(row);
  }
  top.appendChild(statsList);
  el.appendChild(top);

  el.appendChild(buildRecentTotals(stats.recent_totals));
}

// Last-30-days rollups: accumulated EVIDENCE of work done, not another
// adherence/target metric — deliberately no progress bars and no bright
// color here (that's reserved for Consistency above). Two typographic
// tiers, both using the same 2-column grid/gap so their columns line up:
// Reps/Distance (largest — the headline totals, stacked number-over-label)
// on top, then the 4 Wellness practice counts below as compact inline
// "count label" pairs in a tight 2x2 grid — supporting totals, not
// headline KPIs, so they read as one unit per line rather than two.
// Always all 6 metrics, in the same positions, even at zero, so the layout
// never shifts as data changes. Server-computed (build_forge_grid_data /
// calculate_recent_totals) over a fixed trailing 30-day window, independent
// of the grid's own (configurable) horizon and of the 15-day Exercise/Sleep
// chart windows.
function buildRecentTotals(totals) {
  const wrap = document.createElement("div");
  wrap.className = "consistency-recent";

  const heading = document.createElement("div");
  heading.className = "section-heading consistency-heading recent-heading";
  heading.textContent = "Last 30 days";
  wrap.appendChild(heading);

  const primary = document.createElement("div");
  primary.className = "recent-totals-primary";
  const repsValue = totals ? Math.round(totals.reps_volume).toLocaleString() : "—";
  const kmValue = totals ? totals.km_ran.toFixed(1) : "—";
  primary.innerHTML = `
    <div class="recent-total-tile"><span class="number">${repsValue}</span><span class="unit">Reps</span></div>
    <div class="recent-total-tile"><span class="number">${kmValue}</span><span class="unit">Km</span></div>
  `;
  wrap.appendChild(primary);

  // Fixed order/positions regardless of value — Journal, Mobility top row;
  // Wim Hof, Nidra bottom row (shortened dashboard labels used only in this
  // compact block — full names remain elsewhere).
  const secondary = document.createElement("div");
  secondary.className = "recent-totals-secondary";
  const chips = [
    ["Journal", totals ? totals.journaling_sessions : "—"],
    ["Mobility", totals ? totals.mobility_sessions : "—"],
    ["Wim Hof", totals ? totals.wim_hof_breathing_sessions : "—"],
    ["Nidra", totals ? totals.yoga_nidra_sessions : "—"],
  ];
  for (const [label, count] of chips) {
    const chip = document.createElement("div");
    chip.className = "recent-total-chip";
    chip.innerHTML = `<span class="count">${count}</span><span class="label">${label}</span>`;
    secondary.appendChild(chip);
  }
  wrap.appendChild(secondary);

  return wrap;
}

// ---------- Weight entry: a button opens a small modal, the chart is the record ----------

const weightModal = document.getElementById("weight-modal");
document.getElementById("close-weight-modal").addEventListener("click", () => {
  weightModal.hidden = true;
});
weightModal.addEventListener("click", (e) => {
  if (e.target === weightModal) weightModal.hidden = true;
});

document.getElementById("weight-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("weight-input");
  const dateInput = document.getElementById("weight-date");
  const value = parseFloat(input.value);
  if (!value) return;
  await api("/api/weight", {
    method: "POST",
    body: JSON.stringify({ value_kg: value, logged_at: dateInput.value || todayStr() }),
  });
  input.value = "";
  weightModal.hidden = true;
  refreshWeightData();
});

// ---------- Weekly session logging: a button opens a small modal (date + optional metric) ----------

const sessionModal = document.getElementById("session-modal");
let sessionHabit = null; // the weekly habit currently targeted by the session modal

function openSessionModal(habit) {
  sessionHabit = habit;
  document.getElementById("session-modal-title").textContent = `Log ${habit.name}`;
  document.getElementById("session-date").value = todayStr();

  const metricLabel = document.getElementById("session-metric-label");
  const metricText = document.getElementById("session-metric-text");
  const metricInput = document.getElementById("session-metric");
  if (habit.weekly_metric_unit) {
    metricLabel.hidden = false;
    metricText.textContent = `Amount (${habit.weekly_metric_unit})`;
    metricInput.value = "";
    metricInput.required = true;
  } else {
    metricLabel.hidden = true;
    metricInput.required = false;
  }

  renderSessionExtraFields(habit);

  sessionModal.hidden = false;
}

function renderSessionExtraFields(habit) {
  const container = document.getElementById("session-extra-fields");
  container.innerHTML = "";
  const fields = EXTRA_METRIC_FIELDS_BY_HABIT_NAME[habit.name];
  if (!fields || !fields.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const f of fields) {
    const label = document.createElement("label");
    label.textContent = `${f.label} (${f.unit})`;
    const input = document.createElement("input");
    input.type = "number";
    input.step = f.step;
    input.min = "0";
    input.dataset.extraKey = f.key;
    label.appendChild(input);
    container.appendChild(label);
  }
}

// Reads whatever's in #session-extra-fields into a plain {key: value}
// object, skipping blanks — null (not {}) when nothing was filled in, so an
// empty session never writes a meaningless empty extra blob.
function collectExtraFieldValues(container) {
  const inputs = container.querySelectorAll("input[data-extra-key]");
  const extra = {};
  let any = false;
  for (const input of inputs) {
    if (input.value === "") continue;
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) {
      extra[input.dataset.extraKey] = v;
      any = true;
    }
  }
  return any ? extra : null;
}

document.getElementById("close-session-modal").addEventListener("click", () => {
  sessionModal.hidden = true;
});
sessionModal.addEventListener("click", (e) => {
  if (e.target === sessionModal) sessionModal.hidden = true;
});

document.getElementById("session-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sessionHabit) return;
  const date = document.getElementById("session-date").value;
  const metricInput = document.getElementById("session-metric");
  const value = sessionHabit.weekly_metric_unit ? parseFloat(metricInput.value) || 0 : 1;
  const extra = collectExtraFieldValues(document.getElementById("session-extra-fields"));

  await api("/api/logs", {
    method: "POST",
    body: JSON.stringify({ habit_id: sessionHabit.id, log_date: date, value, extra }),
  });

  sessionModal.hidden = true;
  loadToday();
  loadForgeGrid(); // Weekly goals consistency is computed server-side across the whole horizon — refetch it now rather than let it go stale
});

// ---------- Rendering: Charts ----------
// Proof of Work splits into two tiers: Exercise + Sleep are the two large
// "primary" charts (right column); Weight + Running + anything else are
// smaller "secondary" charts (bottom-left, under the Forge Grid).
const PRIMARY_CHARTS_ID = "primary-charts-container";
const SECONDARY_CHARTS_ID = "secondary-charts-container";

function ensureChartBox(id, label, extraClass = "", containerId = SECONDARY_CHARTS_ID) {
  const box = document.createElement("div");
  box.className = extraClass ? `chart-box ${extraClass}` : "chart-box";
  box.id = `box-${id}`;
  box.innerHTML = `<h4>${label}</h4><canvas></canvas>`;
  document.getElementById(containerId).appendChild(box);
  return box.querySelector("canvas");
}

// Any weekly habit that tracks a number per session (Running, etc.) gets an
// equal secondary-tier share alongside Weight — not hardcoded to "Running"
// by name, so a second metric-tracked weekly habit would join it.
function weeklyMetricClass(habit) {
  return habit.category === "weekly" ? "chart-weekly-metric" : "";
}

function renderEmptyChartBox(habit) {
  const title = habit.category === "weekly"
    ? `${habit.name} (${habit.weekly_metric_unit}) — last ${CHART_HISTORY_DAYS} days`
    : `${habit.name} — last ${CHART_HISTORY_DAYS} days`;
  const box = document.createElement("div");
  box.className = `chart-box ${weeklyMetricClass(habit)}`.trim();
  box.id = `box-habit-${habit.id}`;
  box.innerHTML = `<h4>${title}</h4><div class="chart-empty">No data yet</div>`;
  document.getElementById(SECONDARY_CHARTS_ID).appendChild(box);
}

function renderHabitDailyChart(habit, series, showTarget = true) {
  const title = habit.category === "weekly"
    ? `${habit.name} (${habit.weekly_metric_unit}) — last ${CHART_HISTORY_DAYS} days`
    : `${habit.name} — last ${CHART_HISTORY_DAYS} days`;
  const canvas = ensureChartBox(`habit-${habit.id}`, title, weeklyMetricClass(habit), SECONDARY_CHARTS_ID);
  const labels = series.map((s) => s.date.slice(5)); // "MM-DD", every calendar day so spacing is already true-to-time
  const data = series.map((s) => s.value);

  const datasets = [
    { type: "bar", label: habit.name, data, backgroundColor: CHART_BAR_COLOR, borderRadius: 3 },
  ];
  if (showTarget) {
    datasets.push({
      type: "line",
      label: "target",
      data: labels.map(() => habit.target_value),
      borderColor: "rgba(255,255,255,0.25)", // quiet — the actual recorded effort should read first, the target sits behind it
      borderDash: [4, 4],
      borderWidth: 1,
      pointRadius: 0,
    });
  }

  charts[`habit-${habit.id}`] = new Chart(canvas, {
    data: { labels, datasets },
    options: baseChartOptions(),
  });
  requestAnimationFrame(() => charts[`habit-${habit.id}`]?.update()); // chart-boxes are flex-sized now (not a fixed px height): the canvas can still be mid-layout at creation, so a same-tick update() draws against the same unsettled size — deferring one frame lands after layout settles
}

function renderEmptyExerciseBox() {
  const box = document.createElement("div");
  box.className = "chart-box chart-exercise chart-large";
  box.id = "box-exercise";
  box.innerHTML = `<h4>Exercise — % of target — last ${CHART_HISTORY_DAYS} days</h4><div class="chart-empty">No data yet</div>`;
  document.getElementById(PRIMARY_CHARTS_ID).appendChild(box);
}

// Combines every Exercise-section habit into one chart, each series plotted
// as % of its own target (not raw reps) so Pushups/Squats/Crunches — with
// different targets — share one comparable axis. The dashed 100% line is the
// one visually meaningful threshold; values are free to run past it.
function renderExerciseChart(seriesByHabit) {
  const canvas = ensureChartBox("exercise", `Exercise — % of target — last ${CHART_HISTORY_DAYS} days`, "chart-exercise chart-large", PRIMARY_CHARTS_ID);
  const labels = seriesByHabit[0].series.map((s) => s.date.slice(5));

  // Grouped bars (one per exercise, per day) rather than overlapping lines —
  // three distinct daily efforts read more meaningfully side by side than
  // as tangled trend lines.
  const datasets = seriesByHabit.map(({ habit, series }, i) => ({
    type: "bar",
    label: habit.name,
    data: series.map((s) => s.pct),
    habitId: habit.id,
    backgroundColor: NEON_EXERCISE_COLORS[i % NEON_EXERCISE_COLORS.length],
    borderRadius: 2,
  }));

  datasets.push({
    type: "line",
    label: "100%",
    data: labels.map(() => 100),
    borderColor: "rgba(255,255,255,0.4)", // brighter than a per-habit target line — this is THE reference line here
    borderWidth: 1.5,
    borderDash: [5, 4],
    pointRadius: 0,
  });

  charts["exercise"] = new Chart(canvas, {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 10, font: { size: 10 }, color: "#9a9ca3" } },
      },
      scales: {
        x: { ticks: { color: "#5f6266", font: { size: 10 }, maxTicksLimit: 6, autoSkip: true }, grid: { display: false } },
        y: {
          beginAtZero: true, // values can run past 100% — the axis just isn't capped there
          ticks: { color: "#5f6266", font: { size: 10 }, maxTicksLimit: 4, callback: (v) => `${v}%` },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
  requestAnimationFrame(() => charts["exercise"]?.update()); // see the comment in renderHabitDailyChart — same fix, deferred to the next frame
}

// Score reads as "how good", tying it to FORGE's own accent color rather
// than introducing a new one — kept distinct from NEON_SLEEP_COLOR (the
// duration bars) and from gold (reserved for a 100%-complete day).
const SLEEP_SCORE_COLOR = "#b23a5e";

function renderEmptySleepBox(habit) {
  const box = document.createElement("div");
  box.className = "chart-box chart-sleep chart-large";
  box.id = "box-sleep";
  box.innerHTML = `<h4>${habit.name} — Duration &amp; Score — last ${CHART_HISTORY_DAYS} days</h4><div class="chart-empty">No data yet</div>`;
  document.getElementById(PRIMARY_CHARTS_ID).appendChild(box);
}

// Sleep logs two numbers a day (duration vs. its hours target, and a 0-100
// quality score) — one dual-axis chart shows both together rather than two
// disconnected charts: duration as bars against a dashed target line (left
// axis, hours), score as a line overlay (right axis, 0-100).
function renderSleepChart(habit, series) {
  const canvas = ensureChartBox("sleep", `${habit.name} — Duration & Score — last ${CHART_HISTORY_DAYS} days`, "chart-sleep chart-large", PRIMARY_CHARTS_ID);
  const labels = series.map((s) => s.date.slice(5));
  const durationData = series.map((s) => s.value);
  const scoreData = series.map((s) => s.value2);

  const datasets = [
    {
      type: "bar",
      label: "Duration (hrs)",
      data: durationData,
      backgroundColor: NEON_SLEEP_COLOR,
      borderRadius: 3,
      yAxisID: "yDuration",
      order: 2, // Chart.js draws higher `order` first — keep the bars behind the score line
    },
    {
      type: "line",
      label: "Score (/100)",
      data: scoreData,
      borderColor: SLEEP_SCORE_COLOR,
      backgroundColor: SLEEP_SCORE_COLOR,
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.25,
      yAxisID: "yScore",
      order: 0, // drawn last — always on top of the duration bars, even when the score dips below the bar's top
    },
    {
      type: "line",
      label: `Target (${habit.target_value}h)`,
      data: labels.map(() => habit.target_value),
      borderColor: "rgba(255,255,255,0.3)",
      borderDash: [4, 4],
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: "yDuration",
      order: 1,
    },
  ];

  charts["sleep"] = new Chart(canvas, {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 10, font: { size: 10 }, color: "#9a9ca3" } },
      },
      scales: {
        x: { ticks: { color: "#5f6266", font: { size: 10 }, maxTicksLimit: 5, autoSkip: true }, grid: { display: false } },
        yDuration: {
          position: "left",
          beginAtZero: true,
          ticks: { color: "#5f6266", font: { size: 10 }, maxTicksLimit: 4, callback: (v) => `${v}h` },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        yScore: {
          position: "right",
          min: 0,
          max: 100,
          ticks: { color: "#5f6266", font: { size: 10 }, maxTicksLimit: 4 },
          grid: { display: false }, // avoid a second overlapping gridline set — yDuration's grid is enough
        },
      },
    },
  });
  requestAnimationFrame(() => charts["sleep"]?.update()); // see the comment in renderHabitDailyChart — same fix, deferred to the next frame
}

// Weight is logged whenever, not daily — a category axis would space every
// entry evenly regardless of the real gap between dates. Use a linear numeric
// axis (days-since-epoch) instead, so the x-distance between points matches
// the actual time elapsed.
const DAY_MS = 24 * 60 * 60 * 1000;
const toDayNumber = (dateStr) => Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS);
const dayNumberToLabel = (dayNum) =>
  new Date(dayNum * DAY_MS).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function renderWeightChart(entries) {
  const box = document.createElement("div");
  box.className = "chart-box chart-weight"; // a body measurement's graph is simpler than the performance charts — needs less width
  box.id = "box-weight";
  box.innerHTML = `
    <div class="chart-box-head">
      <div><span class="eyebrow">Body</span><h4>Weight (kg)</h4></div>
      <button type="button" class="small-btn">+ Log weight</button>
    </div>
    <canvas></canvas>
  `;
  document.getElementById(SECONDARY_CHARTS_ID).appendChild(box);
  box.querySelector("button").addEventListener("click", () => {
    document.getElementById("weight-date").value = todayStr();
    weightModal.hidden = false;
  });

  if (!entries.length) {
    box.querySelector("canvas").replaceWith(Object.assign(document.createElement("div"), {
      className: "chart-empty",
      textContent: "No data yet",
    }));
    return;
  }

  const canvas = box.querySelector("canvas");
  const points = entries.map((e) => ({ x: toDayNumber(e.logged_at), y: e.value_kg }));

  charts["weight"] = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [{ label: "kg", data: points, borderColor: "#8c1c3e", backgroundColor: "#8c1c3e", tension: 0.25, pointRadius: 3 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (items) => dayNumberToLabel(items[0].parsed.x) } },
      },
      scales: {
        x: {
          type: "linear",
          ticks: { color: "#5f6266", font: { size: 10 }, callback: dayNumberToLabel, maxTicksLimit: 5, autoSkip: true },
          grid: { display: false },
        },
        y: {
          ticks: { color: "#5f6266", font: { size: 10 }, maxTicksLimit: 3 },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
  requestAnimationFrame(() => charts["weight"]?.update()); // see the comment in renderHabitDailyChart — same fix, deferred to the next frame
}

function baseChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false, // chart-box has a fixed height — fill it instead of using Chart.js's default aspect ratio
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: "#5f6266", font: { size: 10 }, maxTicksLimit: 5, autoSkip: true }, grid: { display: false } },
      y: {
        // The "0" baseline is visual noise on a bar chart that already starts at
        // the axis — skip its label, keep just a couple of others for scale.
        ticks: {
          color: "#5f6266",
          font: { size: 10 },
          maxTicksLimit: 3,
          callback: (value) => (value === 0 ? "" : value),
        },
        grid: { color: "rgba(255,255,255,0.04)" },
      },
    },
  };
}

// ---------- Settings modal ----------

const modal = document.getElementById("settings-modal");
document.getElementById("settings-btn").addEventListener("click", async () => {
  modal.hidden = false;
  await renderHabitSettingsList();
});
document.getElementById("close-settings").addEventListener("click", () => {
  modal.hidden = true;
});
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.hidden = true; // click on the backdrop, not the content
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!modal.hidden) modal.hidden = true;
  if (!weightModal.hidden) weightModal.hidden = true;
  if (!sessionModal.hidden) sessionModal.hidden = true;
  if (!entriesModal.hidden) entriesModal.hidden = true;
  if (!garminModal.hidden) garminModal.hidden = true;
  document.querySelectorAll(".wellness-add-menu").forEach((m) => { m.hidden = true; });
});

// The Wellness "+ Add" popover closes on any click outside it — a single
// document-level listener (not one per render, since renderDaily rebuilds
// this control from scratch on every refresh) rather than a per-menu one
// that would pile up on stale, already-removed DOM nodes.
document.addEventListener("click", (e) => {
  if (e.target.closest(".wellness-add-wrap")) return;
  document.querySelectorAll(".wellness-add-menu").forEach((m) => { m.hidden = true; });
});

async function renderHabitSettingsList() {
  const habits = await api("/api/habits");
  const list = document.getElementById("habit-list");
  list.innerHTML = "";
  for (const h of habits) {
    const row = document.createElement("div");
    row.className = "habit-list-row";
    const dailyDetail = h.tracking_type === "sleep"
      ? `daily, target ${h.target_value}h + score /100`
      : h.tracking_type === "numeric"
        ? `daily, target ${h.target_value}${h.unit ? " " + h.unit : ""}`
        : "daily, checkbox";
    const meta = h.category === "weekly"
      ? `weekly x${h.weekly_frequency || 1}${h.weekly_metric_unit ? `, tracks ${h.weekly_metric_unit}` : ""}`
      : `${h.section ? h.section + ", " : ""}${dailyDetail}`;
    row.innerHTML = `<span class="name">${h.name}</span><span class="meta">${meta}</span>`;
    const archiveBtn = document.createElement("button");
    archiveBtn.textContent = "Archive";
    archiveBtn.addEventListener("click", async () => {
      if (!confirm(`Archive "${h.name}"? History is kept, it just won't show up anymore.`)) return;
      await api(`/api/habits/${h.id}`, { method: "DELETE" });
      renderHabitSettingsList();
      refreshAll();
    });
    row.appendChild(archiveBtn);
    list.appendChild(row);
  }
}

const categorySelect = document.getElementById("h-category");
const typeSelect = document.getElementById("h-type");
function syncHabitFormVisibility() {
  const isWeekly = categorySelect.value === "weekly";
  const isNumeric = typeSelect.value === "numeric";
  document.getElementById("h-freq-label").hidden = !isWeekly;
  document.getElementById("h-metric-label").hidden = !isWeekly;
  document.getElementById("h-section-label").hidden = isWeekly;
  document.getElementById("h-target-label").hidden = !isNumeric;
  document.getElementById("h-unit-label").hidden = !isNumeric;
}
categorySelect.addEventListener("change", syncHabitFormVisibility);
typeSelect.addEventListener("change", syncHabitFormVisibility);
syncHabitFormVisibility();

document.getElementById("habit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("h-name").value.trim();
  const category = categorySelect.value;
  const tracking_type = typeSelect.value;
  const target_value = tracking_type === "numeric" ? parseFloat(document.getElementById("h-target").value) || 1 : 1;
  const unit = document.getElementById("h-unit").value.trim() || null;
  const weekly_frequency = category === "weekly" ? parseInt(document.getElementById("h-freq").value) || 1 : null;
  const weekly_metric_unit = category === "weekly" ? (document.getElementById("h-metric").value.trim() || null) : null;
  const section = category === "daily" ? (document.getElementById("h-section").value.trim() || null) : null;

  if (!name) return;

  await api("/api/habits", {
    method: "POST",
    body: JSON.stringify({ name, category, tracking_type, target_value, unit, weekly_frequency, weekly_metric_unit, section }),
  });

  e.target.reset();
  syncHabitFormVisibility();
  renderHabitSettingsList();
  refreshAll();
});

// ---------- Garmin sync modal ----------
// Preview (fetch from Garmin, show candidates) and import are two separate
// steps — nothing is written until the user picks which rows to bring in.
// Sleep/Running are the only two habits this touches (see backend/crud.py's
// annotate_garmin_candidates for how "already logged"/"already imported"
// status is derived).

const garminModal = document.getElementById("garmin-modal");
let garminCandidates = null; // last preview fetch: {sleep: [...], runs: [...]}

document.getElementById("garmin-sync-btn").addEventListener("click", () => {
  document.getElementById("garmin-results").hidden = true;
  setGarminStatus("", false);

  const startInput = document.getElementById("garmin-start-date");
  const endInput = document.getElementById("garmin-end-date");
  if (!endInput.value) endInput.value = todayStr();
  if (!startInput.value) {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    startInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  garminModal.hidden = false;
});
document.getElementById("close-garmin-modal").addEventListener("click", () => {
  garminModal.hidden = true;
});
garminModal.addEventListener("click", (e) => {
  if (e.target === garminModal) garminModal.hidden = true;
});

function setGarminStatus(text, isError) {
  const el = document.getElementById("garmin-status");
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("error", !!isError);
}

async function fetchGarminPreview(start_date, end_date) {
  const fetchBtn = document.getElementById("garmin-fetch-btn");
  fetchBtn.disabled = true;
  try {
    garminCandidates = await api("/api/garmin/preview", {
      method: "POST",
      body: JSON.stringify({ start_date, end_date }),
    });
    renderGarminResults();
  } finally {
    fetchBtn.disabled = false;
  }
}

document.getElementById("garmin-range-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const start_date = document.getElementById("garmin-start-date").value;
  const end_date = document.getElementById("garmin-end-date").value;
  if (!start_date || !end_date) return;

  document.getElementById("garmin-results").hidden = true;
  setGarminStatus("Fetching from Garmin Connect…", false);
  try {
    await fetchGarminPreview(start_date, end_date);
    setGarminStatus("", false);
  } catch (err) {
    setGarminStatus(err.message, true);
  }
});

const GARMIN_STATUS_LABEL = { new: "new", already_logged: "already logged", already_imported: "already imported" };

function garminRow(rec, type) {
  const row = document.createElement("label");
  row.className = "garmin-row";
  row._record = rec;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = rec.status === "new";
  checkbox.dataset.type = type;

  const detail = document.createElement("span");
  detail.className = "detail";
  detail.innerHTML = type === "sleep"
    ? `<strong>${rec.date}</strong> — ${rec.duration_hours}h${rec.score != null ? `, score ${rec.score}` : ""}`
    : `<strong>${rec.date}</strong> — ${rec.distance_km}km${rec.activity_subtype ? ` (${rec.activity_subtype.replace(/_/g, " ")})` : ""}`;

  const status = document.createElement("span");
  status.className = "status-tag";
  status.textContent = GARMIN_STATUS_LABEL[rec.status] || rec.status;

  row.append(checkbox, detail, status);
  return row;
}

function renderGarminResults() {
  const sleepList = document.getElementById("garmin-sleep-list");
  const runsList = document.getElementById("garmin-runs-list");
  sleepList.innerHTML = "";
  runsList.innerHTML = "";

  if (!garminCandidates.sleep.length) {
    sleepList.innerHTML = `<div class="garmin-empty">No sleep data in this range.</div>`;
  } else {
    for (const rec of garminCandidates.sleep) sleepList.appendChild(garminRow(rec, "sleep"));
  }
  if (!garminCandidates.runs.length) {
    runsList.innerHTML = `<div class="garmin-empty">No runs in this range.</div>`;
  } else {
    for (const rec of garminCandidates.runs) runsList.appendChild(garminRow(rec, "run"));
  }
  document.getElementById("garmin-results").hidden = false;
}

document.getElementById("garmin-import-btn").addEventListener("click", async () => {
  const rows = document.querySelectorAll("#garmin-sleep-list .garmin-row, #garmin-runs-list .garmin-row");
  const sleep = [];
  const runs = [];
  for (const row of rows) {
    const checkbox = row.querySelector("input[type=checkbox]");
    if (!checkbox.checked) continue;
    const r = row._record;
    if (checkbox.dataset.type === "sleep") {
      sleep.push({ date: r.date, duration_hours: r.duration_hours, score: r.score });
    } else {
      runs.push({
        date: r.date,
        garmin_activity_id: r.garmin_activity_id,
        distance_km: r.distance_km,
        pace_min_per_km: r.pace_min_per_km,
        avg_hr: r.avg_hr,
        cadence: r.cadence,
      });
    }
  }
  if (!sleep.length && !runs.length) return;

  const importBtn = document.getElementById("garmin-import-btn");
  importBtn.disabled = true;
  setGarminStatus("Importing…", false);
  try {
    const result = await api("/api/garmin/import", {
      method: "POST",
      body: JSON.stringify({ sleep, runs }),
    });
    await fetchGarminPreview(
      document.getElementById("garmin-start-date").value,
      document.getElementById("garmin-end-date").value,
    );
    setGarminStatus(`Imported ${result.imported_sleep} sleep night(s) and ${result.imported_runs} run(s).`, false);
    refreshAll();
  } catch (err) {
    setGarminStatus(err.message, true);
  } finally {
    importBtn.disabled = false;
  }
});

// ---------- Entries modal (edit/delete raw weight + habit-log rows) ----------
// Separate from Settings (which manages habit definitions) — this edits the
// actual logged numbers, for fixing a typo'd entry without deleting and
// re-logging it (which would lose the original date).

const entriesModal = document.getElementById("entries-modal");

document.getElementById("entries-btn").addEventListener("click", async () => {
  entriesModal.hidden = false;
  await Promise.all([renderEntriesWeightList(), renderEntriesLogsList()]);
});
document.getElementById("close-entries").addEventListener("click", () => {
  entriesModal.hidden = true;
});
entriesModal.addEventListener("click", (e) => {
  if (e.target === entriesModal) entriesModal.hidden = true;
});

document.getElementById("entries-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  for (const b of document.querySelectorAll("#entries-tabs .tab-btn")) b.classList.toggle("active", b === btn);
  document.getElementById("entries-weight-panel").hidden = btn.dataset.tab !== "weight";
  document.getElementById("entries-logs-panel").hidden = btn.dataset.tab !== "logs";
});

// Exercise / Wellness / Weekly — filters the already-fetched list client-side
// (no refetch), so switching sub-tabs is instant.
let entriesLogsSubtab = "all";
function logEntryCategory(log) {
  if (log.habit_category === "weekly") return "weekly";
  return log.habit_section === "Exercise" ? "exercise" : "wellness";
}
document.getElementById("entries-logs-subtabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".subtab-btn");
  if (!btn) return;
  entriesLogsSubtab = btn.dataset.subtab;
  for (const b of document.querySelectorAll("#entries-logs-subtabs .subtab-btn")) b.classList.toggle("active", b === btn);
  renderEntriesLogsRows(entriesLogsCache);
});

function entryDateOnly(isoLike) {
  // logged_at/log_date may be a bare date or a full datetime — <input type=date> needs just YYYY-MM-DD.
  return (isoLike || "").slice(0, 10);
}

async function renderEntriesWeightList() {
  const list = document.getElementById("entries-weight-list");
  list.innerHTML = "";
  const entries = await api("/api/weight");
  if (!entries.length) {
    list.innerHTML = `<div class="entry-empty">No weight entries logged yet.</div>`;
    return;
  }
  // Newest first — that's where a just-made typo is.
  for (const entry of [...entries].reverse()) {
    const row = document.createElement("div");
    row.className = "entry-row";

    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = entryDateOnly(entry.logged_at);

    const valueInput = document.createElement("input");
    valueInput.type = "number";
    valueInput.step = "0.01";
    valueInput.min = "0";
    valueInput.value = entry.value_kg;

    const unit = document.createElement("span");
    unit.className = "entry-unit";
    unit.textContent = "kg";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      const value_kg = parseFloat(valueInput.value);
      if (!Number.isFinite(value_kg) || value_kg <= 0 || !dateInput.value) return;
      await api(`/api/weight/${entry.id}`, {
        method: "PUT",
        body: JSON.stringify({ logged_at: dateInput.value, value_kg }),
      });
      refreshWeightData();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm("Delete this weight entry?")) return;
      await api(`/api/weight/${entry.id}`, { method: "DELETE" });
      renderEntriesWeightList();
      refreshWeightData();
    });

    row.append(dateInput, valueInput, unit, saveBtn, delBtn);
    list.appendChild(row);
  }
}

let entriesLogsCache = [];

async function renderEntriesLogsList() {
  entriesLogsCache = await api("/api/logs/recent?limit=300");
  renderEntriesLogsRows(entriesLogsCache);
}

function renderEntriesLogsRows(logs) {
  const list = document.getElementById("entries-logs-list");
  list.innerHTML = "";
  if (!logs.length) {
    list.innerHTML = `<div class="entry-empty">No habit entries logged yet.</div>`;
    return;
  }
  const filtered = entriesLogsSubtab === "all" ? logs : logs.filter((log) => logEntryCategory(log) === entriesLogsSubtab);
  if (!filtered.length) {
    list.innerHTML = `<div class="entry-empty">Nothing in this category yet.</div>`;
    return;
  }
  for (const log of filtered) {
    const row = document.createElement("div");
    row.className = "entry-row";

    const name = document.createElement("span");
    name.className = "entry-name";
    name.textContent = log.habit_name;

    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = entryDateOnly(log.log_date);

    const valueInput = document.createElement("input");
    valueInput.type = "number";
    valueInput.step = "0.01";
    valueInput.min = "0";
    valueInput.value = log.value;
    valueInput.title = log.habit_tracking_type === "sleep" ? "Duration (hours)" : "Value";

    const isSleep = log.habit_tracking_type === "sleep";
    const scoreInput = document.createElement("input");
    if (isSleep) {
      scoreInput.type = "number";
      scoreInput.step = "1";
      scoreInput.min = "0";
      scoreInput.max = "100";
      scoreInput.value = log.value2 != null ? log.value2 : "";
      scoreInput.title = "Sleep score (out of 100)";
      scoreInput.placeholder = "/100";
    }

    const unit = document.createElement("span");
    unit.className = "entry-unit";
    unit.textContent = isSleep
      ? "hrs"
      : log.habit_category === "weekly" ? (log.habit_weekly_metric_unit || "") : (log.habit_unit || "");

    // Extra per-session metrics (Running: pace/HR/cadence) — rendered
    // whenever this habit HAS them defined, prefilled from the existing log,
    // and always resent on Save (even unedited) so saving date/value alone
    // never silently wipes them.
    const extraFieldDefs = EXTRA_METRIC_FIELDS_BY_HABIT_NAME[log.habit_name] || [];
    const extraWrap = document.createElement("span");
    extraWrap.className = "entry-extra";
    const extraInputs = extraFieldDefs.map((f) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = f.step;
      input.min = "0";
      input.title = `${f.label} (${f.unit})`;
      input.placeholder = f.unit;
      input.value = log.extra && log.extra[f.key] != null ? log.extra[f.key] : "";
      input.dataset.extraKey = f.key;
      extraWrap.appendChild(input);
      return input;
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      const value = parseFloat(valueInput.value);
      if (!Number.isFinite(value) || value < 0 || !dateInput.value) return;
      const value2 = isSleep ? (parseFloat(scoreInput.value) || 0) : undefined;
      const extra = extraFieldDefs.length ? collectExtraFieldValues(extraWrap) : undefined;
      await api("/api/logs", {
        method: "POST",
        body: JSON.stringify({ habit_id: log.habit_id, log_date: dateInput.value, value, value2, extra, log_id: log.id }),
      });
      refreshAll();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete this ${log.habit_name} entry?`)) return;
      await api(`/api/logs/${log.id}`, { method: "DELETE" });
      renderEntriesLogsList();
      refreshAll();
    });

    row.append(name, dateInput, valueInput, ...(isSleep ? [scoreInput] : []), unit, extraWrap, saveBtn, delBtn);
    list.appendChild(row);
  }
}

// ---------- Boot ----------

updateDateStatus();
setInterval(updateDateStatus, 60 * 60 * 1000); // catches a midnight rollover if the tab stays open

refreshAll();
loadQuote();
setInterval(loadQuote, 15 * 60 * 1000);
