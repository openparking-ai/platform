-- 0035 — passkeys for the admin, people from a linked accounts module, and
-- "done by" on the change log.
--
--   operator_passkeys     the admin's own passkeys: the credential's id, its
--                         public key and its counter. Never a private key;
--                         nothing here signs anything.
--   linked_sessions       a sign-in by a person a linked accounts module keeps
--                         (README, "Linked accounts"): who, the garages, the
--                         permissions and the version the module answered, and
--                         when it was last asked. Only the token's SHA-256.
--   linked_sign_in_locks  wrong passwords for a linked email, per caller
--                         address: sign-in's lock for people this platform does
--                         not keep, by a hash of the email.
--   garage_changes        a linked person is an actor (`linked`); a passkey is a
--                         subject; and an operator key may say who acted through
--                         it (`done_by`), kept beside the line and trusted for
--                         nothing.
--
-- Run as the database OWNER.

BEGIN;

-- ---------------------------------------------------------------------------
-- operator_passkeys — a credential table, as operator_users is (0024): a
-- passkey is presented and its tenant is what the lookup is for, so the
-- table is ENABLE without FORCE and read across tenants only through the
-- definer below. Everything else reads and writes it inside its tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE operator_passkeys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  -- base64url, as WebAuthn hands it over. A credential id is at most 1023
  -- bytes, 1364 characters encoded; the regex says the alphabet and
  -- char_length the bounds, because a regex repetition stops at 255.
  credential_id text        NOT NULL UNIQUE CHECK (
                              credential_id ~ '^[A-Za-z0-9_-]+$' AND char_length(credential_id) BETWEEN 16 AND 1366),
  public_key    bytea       NOT NULL CHECK (octet_length(public_key) BETWEEN 16 AND 2048),
  counter       bigint      NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports    text[]      NOT NULL DEFAULT '{}',
  name          text        NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  FOREIGN KEY (user_id, tenant_id) REFERENCES operator_users (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX operator_passkeys_tenant_id_idx ON operator_passkeys (tenant_id);
CREATE INDEX operator_passkeys_user_id_idx ON operator_passkeys (user_id);

ALTER TABLE operator_passkeys ENABLE ROW LEVEL SECURITY;
-- Intentionally NOT forced, as operator_users.
CREATE POLICY operator_passkeys_tenant_isolation ON operator_passkeys
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE FUNCTION resolve_operator_passkey(p_credential_id text)
  RETURNS TABLE (passkey_id uuid, tenant_id uuid, user_id uuid, email text, public_key bytea, counter bigint, transports text[])
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT p.id, p.tenant_id, p.user_id, u.email, p.public_key, p.counter, p.transports
      FROM operator_passkeys p
      JOIN operator_users u ON u.id = p.user_id AND u.tenant_id = p.tenant_id
     WHERE p.credential_id = p_credential_id
  $$;

-- ---------------------------------------------------------------------------
-- linked_sessions — the same shape of problem as operator_tokens: a token is
-- presented and its tenant is what the lookup finds. ENABLE without FORCE,
-- found through the definer below, which records the use in the same
-- statement exactly as resolve_operator_session does.
-- ---------------------------------------------------------------------------
CREATE TABLE linked_sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  person       uuid        NOT NULL,
  email        text        NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
  name         text        CHECK (name IS NULL OR char_length(name) <= 200),
  language     text        NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  all_garages  boolean     NOT NULL,
  garages      uuid[]      NOT NULL DEFAULT '{}',
  permissions  text[]      NOT NULL,
  version      text        NOT NULL CHECK (char_length(version) BETWEEN 1 AND 128),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  checked_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT linked_sessions_garages_shape CHECK (NOT all_garages OR cardinality(garages) = 0)
);
CREATE INDEX linked_sessions_tenant_id_idx ON linked_sessions (tenant_id);
CREATE INDEX linked_sessions_person_idx ON linked_sessions (tenant_id, person);

ALTER TABLE linked_sessions ENABLE ROW LEVEL SECURITY;
-- Intentionally NOT forced, as operator_tokens.
CREATE POLICY linked_sessions_tenant_isolation ON linked_sessions
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE FUNCTION resolve_linked_session(p_token_hash text, p_idle_seconds integer)
  RETURNS TABLE (session_id uuid, tenant_id uuid, person uuid, email text, name text, language text,
                 all_garages boolean, garages uuid[], permissions text[], version text,
                 expires_at timestamptz, idle_ends_at timestamptz, checked_at timestamptz)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH used AS (
      UPDATE linked_sessions s
         SET last_seen_at = now()
       WHERE s.token_hash = p_token_hash
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.last_seen_at > now() - make_interval(secs => p_idle_seconds)
      RETURNING s.*
    )
    SELECT used.id, used.tenant_id, used.person, used.email, used.name, used.language,
           used.all_garages, used.garages, used.permissions, used.version,
           used.expires_at, used.last_seen_at + make_interval(secs => p_idle_seconds), used.checked_at
      FROM used
  $$;

-- ---------------------------------------------------------------------------
-- linked_sign_in_locks — no tenant: the email is presented before anything
-- says whose it is, and the module's refusal does not say either. Keyed by a
-- SHA-256 of the email and the caller address, holding nothing else.
-- ---------------------------------------------------------------------------
CREATE TABLE linked_sign_in_locks (
  email_hash   text        NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  address      text        NOT NULL CHECK (char_length(address) BETWEEN 1 AND 64),
  failed_count integer     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_hash, address)
);

-- ---------------------------------------------------------------------------
-- The change log.
-- ---------------------------------------------------------------------------
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_actor_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_actor_kind_check
  CHECK (actor_kind IN ('owner', 'key', 'linked', 'outside', 'nobody'));
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_actor_shape;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_actor_shape CHECK (
  (actor_kind IN ('owner', 'key', 'linked') AND actor_id IS NOT NULL)
  OR (actor_kind IN ('outside', 'nobody') AND actor_id IS NULL AND actor_name IS NULL)
);
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'passkey', 'unknown'));

-- Who acted through an operator key, in their own words: only beside a key's
-- line, never a control character, at most 80 characters.
ALTER TABLE garage_changes ADD COLUMN done_by text;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_done_by_shape CHECK (
  done_by IS NULL
  OR (actor_kind = 'key' AND done_by = btrim(done_by) AND char_length(done_by) BETWEEN 1 AND 80
      AND done_by !~ '[[:cntrl:]]')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON operator_passkeys, linked_sessions, linked_sign_in_locks TO openparking_app;

REVOKE EXECUTE ON FUNCTION resolve_operator_passkey(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_linked_session(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_operator_passkey(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION resolve_linked_session(text, integer) TO openparking_app;

COMMIT;
