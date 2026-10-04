-- 0025 — the owner's language, kept on the owner.
--
-- The admin screens speak English or Spanish. Until now the choice lived only
-- in one browser, so the owner chose again on every new computer. It is kept
-- here, on the admin's own row: one column, English unless the owner chose
-- Spanish. Every admin there already is starts as English.
--
-- Only the two languages the screens have words for are a value; anything else
-- is refused by the database as well as by the route that writes it
-- (src/signIn.js, PUT /api/v1/auth/language).
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE operator_users
  ADD COLUMN language text NOT NULL DEFAULT 'en',
  ADD CONSTRAINT operator_users_language_is_known CHECK (language IN ('en', 'es'));

COMMIT;
