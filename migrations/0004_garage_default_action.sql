-- 0004 — the garage decides what happens to a confidently-read plate that
-- matches no rule.
--
-- Until now `/lane/rules` served the string 'allow' from a literal in
-- src/app.js. There was no column, no environment variable and no
-- configuration file, so a garage that wanted the strict behaviour could not
-- have it: every lane in every deployment synced `default_action: 'allow'`,
-- and an operator who asked for anything else at creation was answered 201 and
-- ignored.
--
-- This changes what is POSSIBLE, not what happens. The default is the value
-- served today, so a garage that sets nothing behaves exactly as it did.
--
-- Per-garage settings live as columns on `garages` -- that is where `timezone`
-- and `currency` live, and they are served to the lane from the same row in
-- the same payload. `tenant_settings` is the per-TENANT surface and this is
-- not a per-tenant question: one operator can hold a strict garage and an open
-- one.
--
-- The permitted values are only the two the lane RECOGNISES by name
-- (lane_controller/decision.py). It reaches its fallback path -- a ticket and a
-- human -- for any other value, including none at all, but it reaches it
-- through an else-branch for unrecognised input rather than through a contract,
-- and serving a value whose meaning rests on that is how two layers come to
-- agree by convention.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN default_action text NOT NULL DEFAULT 'allow'
    CHECK (default_action IN ('allow', 'deny'));

COMMIT;
