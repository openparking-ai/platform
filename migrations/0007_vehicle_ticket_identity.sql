-- 0007 — a stay can be identified by a TICKET instead of a plate.
--
-- Until now a vehicle WAS a plate. `vehicles.plate` was NOT NULL and
-- `UNIQUE (tenant_id, plate)`, and every route that opened or closed a stay
-- took one. That made the camera the only way into the record: a lane that
-- could not read a plate had no identity to open a session on, and the driver
-- sitting at the barrier had nothing the platform could hold a stay against.
--
-- The intercom is the answer to that driver, and what it can produce is a
-- TICKET REFERENCE — a code shown on a display, read back, or carried in a
-- downloadable ticket. So a vehicle row is now identified by EXACTLY ONE of
-- the two, and the constraint is what makes "exactly one" true rather than
-- conventional:
--
--   plate       a plate was READ. Unchanged, still unique per tenant.
--   ticket_ref  an identity a person or a display ASSERTED. Opaque to this
--               platform: it is unique per tenant and nothing here verifies
--               anything else about it. The agent that mints and verifies
--               tickets is a different module and this is not it.
--
-- WHY NOT BOTH ON ONE ROW. A row carrying a plate and a ticket would be
-- claiming that this platform established they belong to the same vehicle, and
-- nothing here can establish that: the plate is a measurement and the ticket is
-- an assertion. Binding the two is the identity module's job, and a row shaped
-- so it cannot be done here is how that stays true. `<>` on the two null tests
-- is XOR: exactly one, never neither, never both.
--
-- WHY `ticket_ref` HAS NO SHAPE CHECK HERE, and it is deliberate. The shape —
-- a closed alphabet and a length bound — is enforced at the REQUEST boundary in
-- src/app.js, exactly as the plate's is. The retention purge writes
-- `redacted:<row id>` into whichever of the two a row carries, and a CHECK on
-- the shape would refuse the redaction: the column would then be the one piece
-- of personal data the purge could not remove.
--
-- The purge redacts `ticket_ref` on the same window and the same rules as
-- `plate`, and preserves which of the two the row carries so this CHECK still
-- holds after redaction. See src/retention.js and docs/DATA_RETENTION.md.
--
-- NOTHING ABOUT AN EXISTING ROW CHANGES. Every row written before this
-- migration carries a plate and no ticket, which satisfies the CHECK as it
-- stands; a lane that sends only a plate is unaffected, and test/api.test.js
-- asserts that separately.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE vehicles ALTER COLUMN plate DROP NOT NULL;

ALTER TABLE vehicles ADD COLUMN ticket_ref text;

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_tenant_ticket_ref_key UNIQUE (tenant_id, ticket_ref);

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_exactly_one_identity
    CHECK ((plate IS NULL) <> (ticket_ref IS NULL));

COMMIT;
