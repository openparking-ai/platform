-- 0036 — a car whose plate nobody could read is a stay too.
--
-- The owner's rule: every car that crosses the lane's activation loop and then
-- its closing loop is a stay, whatever opened the barrier, and the car is
-- identified by what was seen -- the plate as read, or "unreadable", which is a
-- value of the car's identity and not a failure to have one. Until now a stay
-- needed a plate a camera read or a ticket a person asserted (0007, 0008), so a
-- car the lane could not read had no identity to open a stay on: it got into
-- the garage and into no money record, and the count of cars inside (0034) did
-- not count it.
--
-- So a vehicle row may now be the third thing: an UNREAD car. It carries
-- neither a plate nor a ticket, and `unread_ref` instead -- the lane's own
-- event id of the open, the one stay this row stands for:
--
--   plate       a plate was READ. Unchanged.
--   ticket_ref  an identity a person or a display ASSERTED. Unchanged.
--   unread_ref  a car the lane saw and could not read. NOT an identity anyone
--               can present: it names the stay it was opened with, and nothing
--               finds a stay by it.
--
-- WHY ONE ROW PER UNREAD CAR. Nothing here can say two unread cars are the same
-- car, and a vehicle with an open stay takes no second one
-- (`sessions_one_open_per_vehicle`): a shared "unreadable" row would fold every
-- unread car in the garage into the first one's stay. Keyed on the open's event
-- id, a replayed open is the same row and the same stay, and a second car is a
-- second row.
--
-- The purge redacts `unread_ref` as it redacts the other two
-- (`redacted:<row id>`, src/retention.js), so a redacted row keeps its shape
-- and this constraint still holds.
--
-- TWO MORE THINGS ABOUT THE STAY, on `sessions`:
--
--   no_open_command   the lane's loops saw this car go in and no open command
--                     of the lane let it in -- a car following another through
--                     one opening, a refused car that drove in anyway, a car
--                     through a barrier that is up. NOT `tailgater`, which
--                     keeps its own meaning (U7f, 0033: a car no vend let in
--                     whose plate was READ, the one a garage that bans
--                     tailgaters may list). A car nobody could read is never
--                     listed: a dirty plate on a monthly would lock the
--                     monthly out on a match nobody can check.
--   entry_unsure_plate, entry_unsure_plate_confidence
--                     what the camera read of an unread car's plate below the
--                     lane's confidence, and that confidence -- what was seen,
--                     kept for the exit's matching. NOT an identity: no route
--                     finds a stay by it, nothing compares it to a plate, no
--                     ban lists it. Both or neither. Personal data like a
--                     plate: the purge nulls it with the stay's descriptors.
--
-- 0007 AND 0008 ARE NOT EDITED. This drops the constraint by name and adds it
-- back over three columns, in one transaction, so no row is ever
-- unconstrained. Every existing row has a plate or a ticket and no unread_ref,
-- which satisfies the new constraint exactly as it satisfied the old.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE vehicles ADD COLUMN unread_ref text;

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_tenant_unread_ref_key UNIQUE (tenant_id, unread_ref);

ALTER TABLE vehicles DROP CONSTRAINT vehicles_exactly_one_identity;

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_exactly_one_identity
    CHECK (
      num_nonnulls(plate, ticket_ref, unread_ref) = 1
      AND (plate IS NULL OR length(plate) > 0)
      AND (ticket_ref IS NULL OR length(ticket_ref) > 0)
      AND (unread_ref IS NULL OR length(unread_ref) > 0)
    );

ALTER TABLE sessions
  ADD COLUMN no_open_command boolean NOT NULL DEFAULT false;

ALTER TABLE sessions
  ADD COLUMN entry_unsure_plate text,
  ADD COLUMN entry_unsure_plate_confidence double precision;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_entry_unsure_plate_shape
    CHECK (
      (entry_unsure_plate IS NULL AND entry_unsure_plate_confidence IS NULL)
      OR (
        length(entry_unsure_plate) BETWEEN 1 AND 32
        AND entry_unsure_plate_confidence >= 0
        AND entry_unsure_plate_confidence <= 1
      )
    );

COMMIT;
