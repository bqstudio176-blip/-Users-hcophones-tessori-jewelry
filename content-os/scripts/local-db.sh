#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Start a throwaway local PostgreSQL 15+/16 cluster for the DB test suite and
# apply the Supabase shim + all migrations.
#
#   bash scripts/local-db.sh          # start (idempotent) and reset database
#   bash scripts/local-db.sh stop     # stop cluster
#
# Exports nothing; tests read TEST_DATABASE_URL (default below).
# This is ONLY for automated tests. Real environments use Supabase.
# -----------------------------------------------------------------------------
set -euo pipefail

PORT="${TEST_DB_PORT:-54329}"
DATA_DIR="${TEST_DB_DIR:-/tmp/content-os-test-pg}"
DB_NAME="content_os_test"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PG_BIN="${PG_BIN:-}"
if [[ -z "$PG_BIN" ]]; then
  if command -v pg_ctl >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v pg_ctl)")"
  else
    PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
  fi
fi
[[ -x "$PG_BIN/pg_ctl" ]] || { echo "PostgreSQL server binaries not found (set PG_BIN)"; exit 1; }

# initdb/postgres refuse to run as root; use the postgres OS user if needed.
run_pg() {
  if [[ "$(id -u)" == "0" ]]; then
    su postgres -s /bin/bash -c "$*"
  else
    bash -c "$*"
  fi
}

if [[ "${1:-}" == "stop" ]]; then
  run_pg "'$PG_BIN/pg_ctl' -D '$DATA_DIR' stop -m fast" || true
  exit 0
fi

if [[ ! -f "$DATA_DIR/PG_VERSION" ]]; then
  mkdir -p "$DATA_DIR"
  [[ "$(id -u)" == "0" ]] && chown postgres "$DATA_DIR"
  run_pg "'$PG_BIN/initdb' -D '$DATA_DIR' -U postgres --auth=trust >/dev/null"
fi

if ! run_pg "'$PG_BIN/pg_ctl' -D '$DATA_DIR' status" >/dev/null 2>&1; then
  run_pg "'$PG_BIN/pg_ctl' -D '$DATA_DIR' -o \"-p $PORT -k /tmp -c listen_addresses=127.0.0.1\" -l '$DATA_DIR/server.log' -w start" >/dev/null
fi

PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "drop database if exists $DB_NAME with (force);" >/dev/null
"${PSQL[@]}" -d postgres -c "create database $DB_NAME;" >/dev/null
"${PSQL[@]}" -d "$DB_NAME" -f "$ROOT_DIR/tests/db/supabase-shim.sql" >/dev/null
for f in "$ROOT_DIR"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "$DB_NAME" -f "$f" >/dev/null
done

echo "Test database ready: postgresql://postgres@127.0.0.1:$PORT/$DB_NAME"
