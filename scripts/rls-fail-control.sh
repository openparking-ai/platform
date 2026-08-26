#!/usr/bin/env bash
# The control for the isolation suite.
#
# An isolation test that has never been observed to fail proves nothing -- it
# might be asserting something that is true for an unrelated reason, or nothing
# at all. This builds a scratch database, strips row-level security off it, and
# requires the same suite to FAIL. A pass here is the failure.
set -uo pipefail

SCRATCH="${SCRATCH_DB:-openparking_rls_control}"
: "${DATABASE_URL:?DATABASE_URL is required}"
APP_PASSWORD="${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

# Parse the admin URL properly rather than by string surgery -- a password
# containing '/' or '@' would quietly corrupt a ${VAR%/*} style split.
HOSTPORT="$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).host)')"
USERINFO="$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  process.stdout.write(u.username ? u.username + (u.password ? ":" + u.password : "") + "@" : "");
')"
BASE_URL="postgres://${USERINFO}${HOSTPORT}"

echo "== dropping and recreating scratch database '$SCRATCH' =="
psql "$BASE_URL/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null
psql "$BASE_URL/postgres" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SCRATCH" >/dev/null

export DATABASE_URL="$BASE_URL/$SCRATCH"
export APP_DATABASE_URL="postgres://openparking_app:${APP_PASSWORD}@${HOSTPORT}/$SCRATCH"

echo "== migrating scratch database =="
node scripts/migrate.js
node scripts/ensure-app-role.js

echo
echo "== control A: suite must PASS with RLS intact =="
if node --test test/tenant-isolation.test.js; then
  echo "control A OK — suite passes with RLS in place"
else
  echo "CONTROL A FAILED — the suite does not pass even with RLS intact." >&2
  exit 1
fi

echo
echo "== control B: stripping RLS from parking_sites =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE parking_sites NO FORCE ROW LEVEL SECURITY;
ALTER TABLE parking_sites DISABLE ROW LEVEL SECURITY;
SQL

echo "== control B: suite must now FAIL =="
if node --test test/tenant-isolation.test.js; then
  echo >&2
  echo "CONTROL B FAILED: the isolation suite PASSED with row-level security removed." >&2
  echo "The suite is not measuring isolation. Do not trust it." >&2
  psql "$BASE_URL/postgres" -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null
  exit 1
fi

echo
echo "control B OK — the suite fails when RLS is removed, as it must."
psql "$BASE_URL/postgres" -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null
echo "scratch database dropped."
