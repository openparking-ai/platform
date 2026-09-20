-- 0011 — the shadow run: what the close snapshotted, and what the search said.
--
-- The exit module's search is called for real exits, its answer RECORDED, and
-- nothing acts on it. This table is the queue between the two halves, and the
-- record of the second.
--
-- THE SNAPSHOT IS TAKEN INSIDE THE CLOSE TRANSACTION, BEFORE `exit_at` IS
-- WRITTEN. The close finds the stay by plate or ticket and closes it; a search
-- run afterwards against "open stays" would find the true stay already closed,
-- and every plate-matched exit would read as "absent true car" -- the exact
-- inversion the search exists to prevent. So the row below is inserted by the
-- close route, in its transaction, from the set of open stays read BEFORE the
-- UPDATE that closes one of them. It commits with the close or not at all.
--
-- IDS ONLY, AND THAT WAS MEASURED, NOT PREFERRED. Every open stay of a garage
-- carrying a 12,333-character descriptor (the incompressible ORB size at the
-- identity service's keypoint cap) materialises 6.2 MB at 500 stays and 62 MB
-- at 5,000 inside the close transaction (13 ms / 42 ms on a laptop) -- on a
-- request path a lane's outbox flush blocks on. The same snapshot as ids alone
-- is 120 KB / 1.2 MB (8 ms either way). A descriptor is immutable once written
-- -- set at the open, nulled only by retention, which cannot reach a stay that
-- is open -- so the worker fetches descriptors BY ID, outside the transaction,
-- for exactly the candidates that have one. The snapshot holds which stays were
-- open and comparable at that moment; that is the only thing that cannot be
-- re-read later.
--
-- NO DESCRIPTOR IS STORED HERE, and none goes into `events` either. The exit's
-- descriptor is on the session the close closed (`sessions.exit_descriptor`),
-- the candidates' are on theirs, and this row and the `shadow_search` event
-- carry SESSION IDS: a descriptor is tens of kilobytes, times N candidates, per
-- exit, and `events` is append-only by grant and outside the retention purge.
--
-- THE DENOMINATOR IS ON THE ROW. `candidates_open` is every stay that was open;
-- `candidate_ids` is the subset that had a descriptor and was sent to the
-- search; `true_stay_comparable` says whether the stay the close picked was
-- among them. A figure computed over these rows is written beside those
-- numbers, and the oracle is named: on every row here the close picked the
-- stay by plate or ticket, independently of the search -- so a match rate over
-- rows where `true_stay_comparable` holds is a measurement with ground truth,
-- over plate- or ticket-identified cars only, inheriting the plate reader's
-- own errors. A rate over ALL exits is not measurable here: a close that
-- matches nothing answers 404 and inserts no row.
--
-- RETENTION REACHES IT. A shadow row ages out with the stay it shadowed: when
-- the purge redacts that stay's vehicle it nulls this row's SESSION REFERENCES
-- -- `session_id`, `candidate_ids`, `matched_ids` -- stamps `redacted_at`, and
-- KEEPS the counts and the outcome. The figure survives; what it was a figure
-- about does not. That is the same shape as the vehicle's own redaction: the
-- row stays, the identity goes. (A session id is a platform-minted uuid, not
-- identity in itself, but it is the join to one; the candidate lists of
-- YOUNGER rows keep their ids, because the stays they point at persist,
-- redacted, and each row ages on its own stay's window.) The `shadow_search`
-- EVENT beside this row is append-only by grant and the purge cannot reach it
-- -- the open item docs/DATA_RETENTION.md already records for `events.detail`.
--
-- Tenant-owned; docs/RLS_TEMPLATE.md, the full template: the worker UPDATEs
-- the row it read with the outcome, the purge UPDATEs it again, and a queue row
-- is a working record that may one day be pruned -- unlike the EVENT, which is
-- the record.
--
-- Run as the database OWNER.

BEGIN;

CREATE TABLE shadow_searches (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id                  uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  -- The stay the close closed: the oracle's answer. NULL once redacted.
  session_id                 uuid        REFERENCES sessions(id) ON DELETE CASCADE,
  exit_lane_id               uuid        REFERENCES lanes(id) ON DELETE SET NULL,
  close_event_id             text        NOT NULL,
  -- The open stays that had a descriptor at the snapshot: what the search is
  -- sent. NULL once redacted.
  candidate_ids              uuid[],
  candidates_open            integer     NOT NULL CHECK (candidates_open >= 0),
  candidates_with_descriptor integer     NOT NULL CHECK (candidates_with_descriptor >= 0),
  true_stay_comparable       boolean     NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  -- Written by the worker. NULL until the search has been run.
  searched_at                timestamptz,
  outcome                    text        CHECK (outcome IN ('match', 'tie', 'no_match', 'none_comparable')),
  matched_ids                uuid[],
  true_stay_matched          boolean,
  counts                     jsonb,
  thresholds                 jsonb,
  search_ref                 text,
  attempts                   integer     NOT NULL DEFAULT 0,
  last_error                 text,
  -- Written by the purge. The references go, the figure stays.
  redacted_at                timestamptz,
  CONSTRAINT shadow_searches_outcome_matches_searched CHECK (
    (searched_at IS NULL AND outcome IS NULL AND matched_ids IS NULL AND true_stay_matched IS NULL)
    OR
    (searched_at IS NOT NULL AND outcome IS NOT NULL AND true_stay_matched IS NOT NULL
       AND (matched_ids IS NOT NULL OR redacted_at IS NOT NULL))
  ),
  -- Redacted means the references are gone; not redacted means they are there.
  CONSTRAINT shadow_searches_redacted_has_no_references CHECK (
    (redacted_at IS NULL AND session_id IS NOT NULL AND candidate_ids IS NOT NULL)
    OR
    (redacted_at IS NOT NULL AND session_id IS NULL AND candidate_ids IS NULL AND matched_ids IS NULL)
  ),
  UNIQUE (tenant_id, close_event_id)
);
CREATE INDEX shadow_searches_tenant_id_idx ON shadow_searches (tenant_id);
CREATE INDEX shadow_searches_pending_idx ON shadow_searches (tenant_id, created_at) WHERE searched_at IS NULL;
CREATE INDEX shadow_searches_garage_idx ON shadow_searches (garage_id, searched_at);

ALTER TABLE shadow_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_searches FORCE  ROW LEVEL SECURITY;

CREATE POLICY shadow_searches_tenant_isolation ON shadow_searches
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON shadow_searches TO openparking_app;

COMMIT;
