-- 0008 — the constraint matches the route: an EMPTY STRING is not an identity.
--
-- 0007 added `vehicles_exactly_one_identity` as
-- `CHECK ((plate IS NULL) <> (ticket_ref IS NULL))`, and its own header says
-- what it is for: "the constraint is what makes 'exactly one' true rather than
-- conventional". It does not, quite. `'' IS NULL` is false, so a row whose only
-- identity is the empty string satisfies the XOR — the row has a plate column
-- that is not null and holds nothing, and every reader downstream treats it as
-- an identity because the constraint said it was one.
--
-- The ROUTE already refuses it: `Boolean('') === Boolean(null)` makes
-- `{plate: '', ticket_ref: ''}` a 400 naming the rule. That is exactly the gap
-- 0007's own fail-control names — "a rule enforced only at a route is a rule
-- one direct INSERT goes around" — so the rule belongs where the fail-control
-- says it belongs.
--
-- 0007 IS NOT EDITED. It is applied everywhere it will ever be applied, and a
-- migration that changes after it has run is a schema two databases disagree
-- about. This one drops the constraint by name and adds it back stronger, in
-- one transaction, so no row is ever unconstrained.
--
-- THE REDACTION STILL SATISFIES IT. The retention purge writes
-- `redacted:<row id>` into whichever of the two columns the row carries and
-- leaves the other NULL; that value is 45 characters, so `length(...) > 0`
-- holds for every redacted row exactly as the XOR already did. Nothing here
-- makes a purge-written value refusable, which was 0007's reason for putting no
-- shape check in the database at all — a bound on emptiness is not a shape.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE vehicles DROP CONSTRAINT vehicles_exactly_one_identity;

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_exactly_one_identity
    CHECK (
      ((plate IS NULL) <> (ticket_ref IS NULL))
      AND (plate IS NULL OR length(plate) > 0)
      AND (ticket_ref IS NULL OR length(ticket_ref) > 0)
    );

COMMIT;
