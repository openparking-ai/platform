#!/usr/bin/env bash
# 0002 is applied everywhere it will ever be applied, so its STATEMENTS are
# frozen. Its comments are not -- one of them stated the opposite of a decision
# that had since been made, and leaving that in a public repository is worse
# than touching a released file.
#
# This asserts the distinction holds: comments may move, SQL may not.
set -euo pipefail
EXPECTED="5bdd0e57925e07a14831a0c9fd8d1754514a73193848f6f2535a737e88f0e8c7"
ACTUAL=$(sed -e 's/--.*$//' migrations/0002_core_schema.sql | tr -s '[:space:]' ' ' | tr -d ' ' | shasum -a 256 | cut -d' ' -f1)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "migrations/0002 SQL changed. It is applied everywhere; it is forward-only." >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi
echo "0002 SQL unchanged (comments may differ)."
