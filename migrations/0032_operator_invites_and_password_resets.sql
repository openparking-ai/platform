-- 0032 — an admin by invitation only, and a password reset by email.
--
-- Until now an admin was made at the database (`create-admin`), for a tenant
-- that already existed, and a forgotten password needed someone at the
-- database too. Now:
--
--   - `invite-admin` makes the tenant and an INVITE for one email, and emails
--     a link. The link is the only way an admin is made over HTTP: there is
--     still no sign-up. Accepting it chooses the password, makes the admin and
--     signs them in.
--   - `POST /auth/forgot` emails a RESET link to an admin; using it chooses a
--     new password and ends every session.
--
-- An invite and a reset are two tables, never one slot: asking for a reset
-- cannot overwrite an invite that is still waiting, nor an invite a reset.
--
-- And a garage's name gets a bound (at the end), so a name longer than the
-- column allows is a thing the route can refuse.
--
-- THE TOKEN IS NEVER STORED. Each link carries 32 random bytes; only their
-- SHA-256 is kept, as an operator token's is (0003), so a copy of this
-- database holds no link that works. The link carries the token in the URL
-- FRAGMENT (`#invite=…`, `#reset=…`), which a browser never sends, and the
-- screen sends it back in a POST body: it is in no request line anything logs.
--
-- Run as the database OWNER.

BEGIN;

-- ---------------------------------------------------------------------------
-- operator_invites — the invitation to become a tenant's one admin.
--
-- An invite is LIVE until it is used or replaced; it lasts seven days. A
-- tenant has at most one live invite, and an email at most one: a second
-- invite is a resend, which stamps the first `replaced_at` and makes a new
-- row, so the old link can say "a newer invite was sent". Expiry is not part
-- of "live" here -- an index cannot read the clock -- so an expired invite
-- stays the live one until a resend replaces it, and its link says "expired".
--
-- A tenant table read only once the tenant is known, except for the one
-- lookup a link needs (the token is presented and its tenant is what is being
-- found out): so ENABLE and FORCE like any other, and that lookup is a
-- definer that opens 0031's cross-account lookup for the length of the call.
-- ---------------------------------------------------------------------------
CREATE TABLE operator_invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text        NOT NULL,
  language    text        NOT NULL DEFAULT 'en',
  token_hash  text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_at timestamptz,
  -- The same rule as an admin's email (0024): the address an admin is made with.
  CONSTRAINT operator_invites_email_is_normal CHECK (
    email = lower(email) AND email = btrim(email)
    AND length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1
  ),
  CONSTRAINT operator_invites_language_is_known CHECK (language IN ('en', 'es')),
  -- A SHA-256, in hex: never a token.
  CONSTRAINT operator_invites_token_is_a_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operator_invites_lasts_seven_days CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '7 days'
  ),
  -- Used or replaced, never both: each is how the invite ended.
  CONSTRAINT operator_invites_ends_once CHECK (used_at IS NULL OR replaced_at IS NULL)
);
CREATE INDEX operator_invites_tenant_id_idx ON operator_invites (tenant_id);
CREATE UNIQUE INDEX operator_invites_one_live_per_tenant ON operator_invites (tenant_id)
  WHERE used_at IS NULL AND replaced_at IS NULL;
CREATE UNIQUE INDEX operator_invites_one_live_per_email ON operator_invites (email)
  WHERE used_at IS NULL AND replaced_at IS NULL;

ALTER TABLE operator_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_invites FORCE  ROW LEVEL SECURITY;
CREATE POLICY operator_invites_tenant_isolation ON operator_invites
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- operator_password_resets — a link that chooses a new password, once.
--
-- It lasts one hour and works once. A new request for the same admin stamps
-- the one before `replaced_at`, so only the newest link works. It belongs to
-- the admin (the composite key, as a lock row does), so it can never name an
-- admin of another tenant, and it goes when the admin goes.
-- ---------------------------------------------------------------------------
CREATE TABLE operator_password_resets (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  token_hash  text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_at timestamptz,
  FOREIGN KEY (user_id, tenant_id) REFERENCES operator_users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT operator_password_resets_token_is_a_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operator_password_resets_lasts_one_hour CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '1 hour'
  ),
  CONSTRAINT operator_password_resets_ends_once CHECK (used_at IS NULL OR replaced_at IS NULL)
);
CREATE INDEX operator_password_resets_tenant_id_idx ON operator_password_resets (tenant_id);
CREATE UNIQUE INDEX operator_password_resets_one_live_per_admin ON operator_password_resets (user_id)
  WHERE used_at IS NULL AND replaced_at IS NULL;

ALTER TABLE operator_password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_password_resets FORCE  ROW LEVEL SECURITY;
CREATE POLICY operator_password_resets_tenant_isolation ON operator_password_resets
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON operator_invites, operator_password_resets TO openparking_app;

-- ---------------------------------------------------------------------------
-- THE LOOKUPS. A link is presented and its tenant is what is being found
-- out, so each table gets 0031's policy -- SELECT only, for the role that owns
-- it, and only while `openparking.definer_lookup` is 'on' -- and the three
-- definers below, and nothing else, turn that on for the length of the call
-- and put it back as they found it. The application role's own queries are
-- untouched by the policy: it names the owner.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operator_invites', 'operator_password_resets']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR SELECT TO %I '
      'USING (current_setting(''openparking.definer_lookup'', true) = ''on'')',
      t || '_definer_lookup', t, current_user);
  END LOOP;
END
$$;

-- The invite a link names, however it ended: its tenant, and what the screen
-- says of it. Nothing for a hash no invite has.
CREATE FUNCTION resolve_operator_invite(p_token_hash text)
  RETURNS TABLE (invite_id uuid, tenant_id uuid, email text, language text,
                 expires_at timestamptz, used_at timestamptz, replaced_at timestamptz)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_was text := current_setting('openparking.definer_lookup', true);
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    RETURN QUERY
      SELECT i.id, i.tenant_id, i.email, i.language, i.expires_at, i.used_at, i.replaced_at
        FROM operator_invites i
       WHERE i.token_hash = p_token_hash;
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
  END
  $$;

-- The live invite of an email -- unused and not replaced, expired or not --
-- for `invite-admin --resend`. At most one (the index above).
CREATE FUNCTION resolve_operator_invite_for_email(p_email text)
  RETURNS TABLE (invite_id uuid, tenant_id uuid, language text, expires_at timestamptz)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_was text := current_setting('openparking.definer_lookup', true);
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    RETURN QUERY
      SELECT i.id, i.tenant_id, i.language, i.expires_at
        FROM operator_invites i
       WHERE i.email = p_email AND i.used_at IS NULL AND i.replaced_at IS NULL;
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
  END
  $$;

-- The reset a link names, however it ended. Nothing for a hash no reset has.
CREATE FUNCTION resolve_operator_password_reset(p_token_hash text)
  RETURNS TABLE (reset_id uuid, tenant_id uuid, user_id uuid,
                 expires_at timestamptz, used_at timestamptz, replaced_at timestamptz)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_was text := current_setting('openparking.definer_lookup', true);
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    RETURN QUERY
      SELECT r.id, r.tenant_id, r.user_id, r.expires_at, r.used_at, r.replaced_at
        FROM operator_password_resets r
       WHERE r.token_hash = p_token_hash;
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
  END
  $$;

-- Closed to PUBLIC, open to the application, as every definer is (0024).
REVOKE EXECUTE ON FUNCTION resolve_operator_invite(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_operator_invite_for_email(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_operator_password_reset(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_operator_invite(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION resolve_operator_invite_for_email(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION resolve_operator_password_reset(text) TO openparking_app;

-- ---------------------------------------------------------------------------
-- A garage's name, bounded. Until now the column took text of any length, so
-- "longer than the column allows" meant nothing and nothing refused it. Now
-- at most 100 characters -- what the admin screen's form takes -- and POST
-- /garages refuses a longer one in a sentence before it gets here
-- (src/garageFields.js), as it refuses an empty one. NOT VALID: it holds for
-- every garage made or renamed from now on, and a garage already stored is
-- not read, so no deployment's existing row can stop this migration.
-- ---------------------------------------------------------------------------
ALTER TABLE garages
  ADD CONSTRAINT garages_name_is_bounded CHECK (char_length(name) <= 100) NOT VALID;

COMMIT;
