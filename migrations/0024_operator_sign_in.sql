-- 0024 — the owner signs in.
--
-- One admin per tenant: an email and a password, and a sign-in is a SESSION
-- token minted the way operator tokens already are, so every operator route
-- works unchanged behind it. No roles, no user management, no sign-up.
--
-- Run as the database OWNER.

BEGIN;

-- ---------------------------------------------------------------------------
-- operator_users — the one admin of a tenant.
--
-- A credential table, and the second of its kind: an email is presented and
-- the tenant it belongs to is precisely what the lookup exists to discover,
-- so a tenant policy cannot gate it. The SAME shape as operator_tokens (0003)
-- and for the same reason: ENABLE without FORCE, read through a SECURITY
-- DEFINER resolver owned by the migration role. docs/RLS_TEMPLATE.md, "The one
-- sanctioned exception: authentication".
--
-- The email is stored lower-cased and trimmed, unique across the table: one
-- email names one account on the whole deployment. The password is stored as
-- the string src/passwords.js writes, which names its own parameters.
-- ---------------------------------------------------------------------------
CREATE TABLE operator_users (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  email               text        NOT NULL UNIQUE,
  password_hash       text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  -- The composite target the session and lock rows reference, so neither can
  -- name a user of another tenant.
  UNIQUE (id, tenant_id),
  CONSTRAINT operator_users_email_is_normal CHECK (
    email = lower(email) AND email = btrim(email)
    AND length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1
  ),
  CONSTRAINT operator_users_password_hash_is_scrypt CHECK (password_hash LIKE 'scrypt$%')
);

ALTER TABLE operator_users ENABLE ROW LEVEL SECURITY;
-- Intentionally NOT forced. See the note above.

CREATE POLICY operator_users_tenant_isolation ON operator_users
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE FUNCTION resolve_operator_user(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT u.id, u.tenant_id, u.password_hash
    FROM operator_users u
    WHERE u.email = p_email
  $$;

-- ---------------------------------------------------------------------------
-- operator_sign_in_locks — wrong passwords, per account AND per caller address.
--
-- Ten wrong passwords from one address lock THAT address out of THAT account
-- for thirty minutes; other addresses are unaffected, so knowing the admin's
-- email is not enough to keep the admin out. There is no account-wide lock.
-- Read and written only once the account -- and so the tenant -- is known, so
-- this is an ordinary tenant table: ENABLE and FORCE.
-- ---------------------------------------------------------------------------
CREATE TABLE operator_sign_in_locks (
  id           uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL,
  address      text        NOT NULL CHECK (length(address) BETWEEN 1 AND 64),
  failed_count integer     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address),
  FOREIGN KEY (user_id, tenant_id) REFERENCES operator_users (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX operator_sign_in_locks_tenant_id_idx ON operator_sign_in_locks (tenant_id);

ALTER TABLE operator_sign_in_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_sign_in_locks FORCE  ROW LEVEL SECURITY;
CREATE POLICY operator_sign_in_locks_tenant_isolation ON operator_sign_in_locks
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- operator_tokens — a KEY (every token until now: unchanged, no expiry) or a
-- SESSION (a sign-in: belongs to a user, ends).
-- ---------------------------------------------------------------------------
ALTER TABLE operator_tokens
  ADD COLUMN kind       text        NOT NULL DEFAULT 'key',
  ADD COLUMN user_id    uuid,
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT operator_tokens_kind_is_known CHECK (kind IN ('key', 'session')),
  ADD CONSTRAINT operator_tokens_kind_shape CHECK (
    (kind = 'key'     AND user_id IS NULL     AND expires_at IS NULL)
    OR (kind = 'session' AND user_id IS NOT NULL AND expires_at IS NOT NULL AND last_seen_at IS NOT NULL)
  ),
  ADD CONSTRAINT operator_tokens_user_fk FOREIGN KEY (user_id, tenant_id)
    REFERENCES operator_users (id, tenant_id) ON DELETE CASCADE;
CREATE INDEX operator_tokens_user_id_idx ON operator_tokens (user_id) WHERE user_id IS NOT NULL;

-- A KEY, as before -- and only a key: a session presented as a Bearer token is
-- not one, so it can never step around the cookie's Origin rule. The resolver
-- refuses an expired or revoked row.
CREATE OR REPLACE FUNCTION resolve_operator_token(p_token_hash text)
  RETURNS TABLE (token_id uuid, tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.tenant_id
    FROM operator_tokens t
    WHERE t.token_hash = p_token_hash
      AND t.kind = 'key'
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > now())
  $$;

-- A SESSION: found only while it is unrevoked, inside its absolute end, and
-- used within the idle window -- and the use is recorded in the same
-- statement, so the idle window is measured from the last use, not the last
-- successful touch. An ended session is never revived by presenting it again:
-- nothing here can move `expires_at`, and a session past its idle window is
-- not found, so it is not touched.
--
-- Nor is a session issued before the admin's password last changed, revoked
-- or not: a password changed by any route, the reset command or SQL by hand,
-- ends every session signed in with the one before it.
CREATE FUNCTION resolve_operator_session(p_token_hash text, p_idle_seconds integer)
  RETURNS TABLE (token_id uuid, tenant_id uuid, user_id uuid, email text, expires_at timestamptz, idle_ends_at timestamptz)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH used AS (
      UPDATE operator_tokens t
         SET last_seen_at = now()
        FROM operator_users u
       WHERE t.token_hash = p_token_hash
         AND t.kind = 'session'
         AND t.revoked_at IS NULL
         AND t.expires_at > now()
         AND t.last_seen_at > now() - make_interval(secs => p_idle_seconds)
         AND u.id = t.user_id AND u.tenant_id = t.tenant_id
         AND t.created_at >= u.password_changed_at
      RETURNING t.id, t.tenant_id, t.user_id, u.email, t.expires_at, t.last_seen_at
    )
    SELECT used.id, used.tenant_id, used.user_id, used.email, used.expires_at,
           used.last_seen_at + make_interval(secs => p_idle_seconds)
      FROM used
  $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON operator_users, operator_sign_in_locks TO openparking_app;

-- ---------------------------------------------------------------------------
-- WHO MAY RUN A DEFINER. A function is executable by PUBLIC when it is made,
-- and a SECURITY DEFINER function runs as its owner: so until now ANY role on
-- the database -- one with no grant at all -- could call these, and
-- resolve_operator_user hands back a password hash. Every SECURITY DEFINER
-- function in the schema is taken from PUBLIC here, the ones from 0002 and
-- 0003 as well, and given to exactly the role that calls it: the application,
-- for its operator keys, its sessions, its lane devices and its maintenance
-- sweep. test/definer-grants.test.js walks pg_proc and holds this for every
-- definer there is, not for this list.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION resolve_lane_device(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION touch_lane_device(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_operator_token(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION touch_operator_token(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION list_tenant_ids_for_maintenance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_operator_user(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_operator_session(text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_lane_device(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION touch_lane_device(uuid) TO openparking_app;
GRANT EXECUTE ON FUNCTION resolve_operator_token(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION touch_operator_token(uuid) TO openparking_app;
GRANT EXECUTE ON FUNCTION list_tenant_ids_for_maintenance() TO openparking_app;
GRANT EXECUTE ON FUNCTION resolve_operator_user(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION resolve_operator_session(text, integer) TO openparking_app;

COMMIT;
