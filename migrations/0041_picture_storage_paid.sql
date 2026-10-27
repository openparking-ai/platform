-- 0041 — picture storage a stay's customer has paid for.
--
--   sessions   `pictures_paid_until`: the time up to which the stay's
--              customer has paid to keep its pictures; null when nothing is
--              paid. The lane pictures the stay holds, and the walk pictures
--              a finished walk listed as seeing it, are kept until then,
--              whatever their 30 days say (src/bans.js, src/walks.js).
--
-- Nothing writes it yet: a storage fee is money, taken where a stay's money
-- is (the payment at the exit), and that payment does not take one.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN pictures_paid_until timestamptz;

COMMIT;
