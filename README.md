# Forge

A local, single-user habit/goal tracker: daily exercises with rep targets,
daily checkbox habits, weekly workouts, weight logging, a rotating quote, and
a single-screen dashboard of bar charts so progress is always visible.

Runs entirely on your Mac — no account, no cloud, one SQLite file on disk.

## Run it

```bash
./run.sh
```

First run creates a virtual environment, installs dependencies, and seeds the
default habits. Then open:

```
http://127.0.0.1:8420
```

Pin that as a browser tab and keep it open — that's the whole point.

To stop the server, `Ctrl+C` in the terminal it's running in. To run it again
later, just `./run.sh` again (it reuses the existing `venv` and database).

## Daily use

- **Today**: enter your reps (pushups/squats/crunches/pages) as you go, or
  check off the rest (journaling, Wim Hof, mobility, Yoga Nidra, …). Grouped
  into Exercise / Wellness. Saves automatically.
- **Today's Progress**: a live bar chart of every daily habit as % of target,
  so you can see the whole day's state at a glance.
- **This Week**: click **Log session** on Hyrox / Running / Sauna / Bouldering
  to open a small dialog (date, plus a distance field for Running) — no
  freeform notes, just the numbers that matter.
- **Weight**: click **+ Log weight** to open a dialog — the trend chart below
  is the only record, no separate list.
- **Trends**: last-30-days bar charts for every numeric habit (neon colors)
  plus weight and running distance over time, with real time-proportional
  spacing (sparse weight entries aren't stretched evenly).
- **Quote**: a rotating line from a local set (~130 entries — original
  mantras plus public-domain Stoic/classical quotes), refreshing every 15
  minutes or on click.

## Adding or changing habits

Click **⚙ Settings** in the top right. You can add a new habit (daily or
weekly, numeric or checkbox, with its own target/unit/group, or a per-session
metric like km for a weekly habit) without touching any code. Archiving a
habit hides it from the dashboard but keeps its history.

## Data & backups

Everything lives in `data/tracker.db`, a single SQLite file. To back it up,
just copy that file somewhere (e.g. a synced folder). Since this whole project
already lives in Google Drive, the file is backed up automatically as long as
Drive sync is running — just don't have the app open and Drive syncing the
exact same write at the same instant.

## Roadmap ideas (not built yet)

- Phone access (would need the server reachable on your network, or a
  cloud-synced backend instead of local SQLite)
- Reminders/notifications
