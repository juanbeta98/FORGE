"""One-time interactive Garmin Connect login.

Garmin sometimes asks for a verification code (emailed to you) on a login it
doesn't recognize — a new device/session. That prompt blocks on terminal
input (garth's default MFA handler calls Python's input()), which the
running web app can't answer since it has no interactive terminal attached
to a request. Run this script directly instead:

    venv/bin/python backend/garmin_login.py

Enter the code when asked. It caches the resulting session under
data/.garmin_session/ (gitignored), so the app's own login (garmin_sync.
get_client) finds that cache first and reuses it — no interactive prompt —
until the session eventually goes stale, at which point re-run this once
more.
"""

import garmin_sync

if __name__ == "__main__":
    client = garmin_sync.get_client()
    print(f"Logged in as {client.full_name}. Session cached at {garmin_sync.TOKEN_DIR}")
