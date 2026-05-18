#!/usr/bin/env bash
# Backend startup script (production-friendly).
#
# Schema management lives in the FastAPI lifespan handler in app/main.py —
# it runs `create_all` + idempotent `ALTER TABLE ... IF NOT EXISTS` on boot.
# We deliberately do NOT call `alembic upgrade head` here because the alembic
# revisions are no longer the source of truth and would conflict.

set -o errexit

echo "Starting FastAPI with Uvicorn..."
exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8000}" \
    --proxy-headers \
    --forwarded-allow-ips="*"
