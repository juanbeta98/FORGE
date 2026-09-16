#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ ! -d venv ]; then
  echo "Creating virtual environment…"
  python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

PORT="${PORT:-8420}"
echo ""
echo "Lifestyle Tracker running at: http://127.0.0.1:${PORT}"
echo "Pin that URL as a browser tab and keep it open."
echo ""

cd backend
exec uvicorn main:app --host 127.0.0.1 --port "$PORT"
