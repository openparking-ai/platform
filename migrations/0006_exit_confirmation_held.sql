-- 0006 — an exit the loops did not confirm still closes, and says so.
--
-- 0005 gave a session what confirmed each end of it. At an ENTRY, nothing
-- confirming means there is no session: the pending entry is held and no row is
-- written, which is the whole point of the ticket not being the entry.
--
-- AT AN EXIT THAT IS THE WRONG ANSWER, and it was measured before it was
-- decided: the exit vend IS the payment moment and the barrier opened, so the
-- car is gone whatever the loops saw. Leaving the session open left the stay
-- unbilled (`fee_minor` NULL, `exit_at` NULL) and the vehicle counted as inside
-- for ever — so a site that installed the confirmation loops lost money that the
-- same site without them collected. A defence that makes a garage worse than no
-- defence is not one.
--
-- So a held exit CLOSES and BILLS like any other, and carries its own name:
--
--   held   the exit vended and the loops did not confirm a forward crossing
--          inside the window. The money is on the row; the flag is for a human,
--          and the `exit_held` lane event is beside it in `events`
--
-- `held` is an EXIT value only. There is no entry equivalent and there must not
-- be one: an entry nothing confirmed is not a session at all, and src/app.js
-- keeps the two accepted sets apart with a test on each side.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE sessions DROP CONSTRAINT sessions_exit_confirmation_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_exit_confirmation_check
    CHECK (exit_confirmation IN ('confirmed', 'unconfirmable', 'held', 'closed_on_vend'));

COMMIT;
