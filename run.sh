#!/usr/bin/env sh
set -e

echo "[EV Charge Live] Starting Add-on service..."

# Ensure persistent data dir exists
mkdir -p /data

export PYTHONPATH="/"
cd /
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8099 --log-level info
