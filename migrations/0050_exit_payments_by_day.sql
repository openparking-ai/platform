-- 0050 — a garage's payments, read by the day they succeeded.
--
-- A garage's own numbers (src/garageSnapshot.js) add up the payments that
-- succeeded between two instants. With only `exit_payments_tenant_id_idx` that
-- read every payment the account ever took: on 1,500,000 payments the phone's
-- Today read was a sequential scan of about 115 ms, nearly all of the read,
-- and growing with every payment.
--
--   exit_payments_garage_succeeded_idx   (tenant_id, garage_id, succeeded_at),
--                    only the payments that succeeded: no other is ever read
--                    by day.
--
-- CONCURRENTLY, so payments keep being taken while it builds: the one
-- statement in this file, outside any transaction (scripts/migrate.js sends
-- a file as one query, and a single statement is not wrapped in one). If
-- the build stops part-way it leaves an INVALID index of this name, which
-- IF NOT EXISTS would then keep: drop it (DROP INDEX CONCURRENTLY
-- exit_payments_garage_succeeded_idx) and run this file again.
--
-- Numbered 0050: 0049 is left free for an open change.
--
-- Run as the database OWNER.

CREATE INDEX CONCURRENTLY IF NOT EXISTS exit_payments_garage_succeeded_idx
  ON exit_payments (tenant_id, garage_id, succeeded_at) WHERE status = 'succeeded';
