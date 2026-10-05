-- 0026 — a lane can be closed, and every change an owner or a key makes is
-- written down.
--
-- LANE CLOSING. A lane is open, or closed with a reason and a message. The
-- reason is `full` (pass and monthly holders still get in) or `everyone`
-- (construction, night, anything else). The message is the owner's own
-- words, shown at the lane. Who closed it and when are kept on the lane;
-- reopening keeps the same two. The lane itself does not act on any of it
-- yet: `/lane/rules` carries the state so the lane's own round can.
--
-- THE CHANGE LOG. Every change made through the owner's screens or an
-- operator key is a line: who, what, before and after, when. A refused
-- attempt to change something is a line too, marked refused. The log can
-- only be added to: the application role has SELECT and INSERT (the grant
-- rate_plans uses, 0012), and a trigger refuses UPDATE, DELETE and TRUNCATE
-- for every role, the owner of the table included.
--
-- THE PLATFORM'S SECURITY LOG. A refused attempt that names no garage, lane,
-- computer or key of anyone, and comes with no session or key of anyone,
-- belongs to no owner. It is written here, never shown to an owner, and the
-- application role holds no grant on it at all: it is written only through
-- record_refused_change() below.
--
-- Run as the database OWNER.

BEGIN;

-- ---------------------------------------------------------------------------
-- lanes — closed or open, and who said so.
-- ---------------------------------------------------------------------------
ALTER TABLE lanes
  ADD COLUMN closed_reason  text,
  ADD COLUMN closed_message text,
  ADD COLUMN closed_by      text,
  ADD COLUMN closed_at      timestamptz,
  ADD COLUMN reopened_by    text,
  ADD COLUMN reopened_at    timestamptz,
  ADD CONSTRAINT lanes_closed_reason_is_known CHECK (closed_reason IN ('full', 'everyone')),
  -- Closed is all four together; open is none of them.
  ADD CONSTRAINT lanes_closed_shape CHECK (
    (closed_reason IS NULL AND closed_message IS NULL AND closed_by IS NULL AND closed_at IS NULL)
    OR (closed_reason IS NOT NULL AND closed_message IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
  ),
  ADD CONSTRAINT lanes_closed_message_is_bounded CHECK (
    closed_message IS NULL OR (length(closed_message) BETWEEN 1 AND 160 AND btrim(closed_message) <> '')
  ),
  ADD CONSTRAINT lanes_reopened_shape CHECK ((reopened_by IS NULL) = (reopened_at IS NULL)),
  ADD CONSTRAINT lanes_who_is_bounded CHECK (
    (closed_by IS NULL OR length(closed_by) <= 300) AND (reopened_by IS NULL OR length(reopened_by) <= 300)
  );

-- ---------------------------------------------------------------------------
-- garage_changes — the change log. Tenant-owned: docs/RLS_TEMPLATE.md, with
-- the grant narrowed to SELECT and INSERT. `garage_id` is NULL for a change
-- that belongs to the whole account (the owner's language, an operator key)
-- or a refused attempt on something that is not this account's.
-- ---------------------------------------------------------------------------
CREATE TABLE garage_changes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id    uuid        REFERENCES garages(id),
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome      text        NOT NULL CHECK (outcome IN ('done', 'refused')),
  -- owner: the signed-in owner; key: an operator key; outside: someone from
  -- another account (never named here); nobody: no session or key at all.
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('owner', 'key', 'outside', 'nobody')),
  actor_id     uuid,
  actor_name   text        CHECK (actor_name IS NULL OR length(actor_name) <= 300),
  action       text        NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)*$' AND length(action) <= 64),
  subject_kind text        NOT NULL CHECK (subject_kind IN (
                             'garage', 'lane', 'computer', 'reader', 'payment_account',
                             'rate_plan', 'tax_set', 'key', 'language', 'unknown')),
  subject_id   uuid,
  subject_name text        CHECK (subject_name IS NULL OR length(subject_name) <= 300),
  before       jsonb,
  after        jsonb,
  refusal      text        CHECK (refusal IS NULL OR refusal ~ '^[a-z0-9_]+$' AND length(refusal) <= 64),
  request      text        CHECK (request IS NULL OR length(request) <= 300),
  CONSTRAINT garage_changes_refusal_shape CHECK ((outcome = 'refused') = (refusal IS NOT NULL)),
  CONSTRAINT garage_changes_actor_shape CHECK (
    (actor_kind IN ('owner', 'key') AND actor_id IS NOT NULL)
    OR (actor_kind IN ('outside', 'nobody') AND actor_id IS NULL AND actor_name IS NULL)
  )
);
CREATE INDEX garage_changes_tenant_id_idx ON garage_changes (tenant_id);
CREATE INDEX garage_changes_newest_idx ON garage_changes (tenant_id, garage_id, at DESC, id DESC);

ALTER TABLE garage_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE garage_changes FORCE  ROW LEVEL SECURITY;

CREATE POLICY garage_changes_tenant_isolation ON garage_changes
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- platform_security_log — refused attempts that are nobody's. No tenant, no
-- grant to the application, never served.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_security_log (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  refusal    text        NOT NULL CHECK (refusal ~ '^[a-z0-9_]+$' AND length(refusal) <= 64),
  request    text        NOT NULL CHECK (length(request) <= 300),
  credential text        NOT NULL CHECK (credential IN ('none', 'session', 'key'))
);
REVOKE ALL ON platform_security_log FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Append-only, for every role. A grant binds the application; this binds the
-- owner of the table too. Dropping it is DDL, and DDL is the migrations'.
-- ---------------------------------------------------------------------------
CREATE FUNCTION refuse_log_rewrite() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    RAISE EXCEPTION '% is append-only: a line is never changed or removed', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END
  $$;

CREATE TRIGGER garage_changes_append_only
  BEFORE UPDATE OR DELETE ON garage_changes
  FOR EACH ROW EXECUTE FUNCTION refuse_log_rewrite();
CREATE TRIGGER garage_changes_no_truncate
  BEFORE TRUNCATE ON garage_changes
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_log_rewrite();
CREATE TRIGGER platform_security_log_append_only
  BEFORE UPDATE OR DELETE ON platform_security_log
  FOR EACH ROW EXECUTE FUNCTION refuse_log_rewrite();
CREATE TRIGGER platform_security_log_no_truncate
  BEFORE TRUNCATE ON platform_security_log
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_log_rewrite();

-- ---------------------------------------------------------------------------
-- record_refused_change — where a refused attempt is written.
--
-- A refusal is answered before, or instead of, anything the requester may
-- see: a session that has ended, a site that is not the admin's, a garage of
-- another account. So the application cannot write it under the right tenant
-- itself, and this resolves both sides as the owner of the tables:
--
--   the TARGET   the garage, lane, computer or key the path names, if it
--                exists: a line in its account's log, on its garage. When the
--                attempt comes from another account, it is "outside" and
--                never named.
--   the CALLER   the account of the signed-in owner or key, or of the session
--                or key presented even if it has ended (p_credential_hash, the
--                hash the application already computes; never the value): a
--                line in that account's log, when the target is not its own.
--   neither      the platform's security log.
--
-- Returns where it went: 'target', 'caller', 'both' or 'security'. The tenant
-- context is set for the inserts and put back as it was.
-- ---------------------------------------------------------------------------
CREATE FUNCTION record_refused_change(
  p_caller_tenant   uuid,
  p_credential_hash text,
  p_credential      text,
  p_actor_kind      text,
  p_actor_id        uuid,
  p_actor_name      text,
  p_target_kind     text,
  p_target_id       uuid,
  p_action          text,
  p_refusal         text,
  p_request         text
) RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_caller    uuid := p_caller_tenant;
    v_kind      text := p_actor_kind;
    v_actor     uuid := p_actor_id;
    v_name      text := p_actor_name;
    v_t_tenant  uuid;
    v_t_garage  uuid;
    v_t_name    text;
    v_subject   text;
    v_was       text := current_setting('openparking.tenant_id', true);
    v_went      text := NULL;
  BEGIN
    -- The caller, from a credential that no longer works: its account, and
    -- who it was. Read without touching it, so presenting an ended session
    -- does not keep anything alive.
    IF v_caller IS NULL AND p_credential_hash IS NOT NULL THEN
      SELECT t.tenant_id,
             CASE WHEN t.kind = 'session' THEN 'owner' ELSE 'key' END,
             CASE WHEN t.kind = 'session' THEN t.user_id ELSE t.id END,
             CASE WHEN t.kind = 'session' THEN u.email ELSE t.name END
        INTO v_caller, v_kind, v_actor, v_name
        FROM operator_tokens t
        LEFT JOIN operator_users u ON u.id = t.user_id AND u.tenant_id = t.tenant_id
       WHERE t.token_hash = p_credential_hash;
      IF v_caller IS NULL THEN
        v_kind := 'nobody'; v_actor := NULL; v_name := NULL;
      END IF;
    END IF;

    -- The target.
    IF p_target_id IS NOT NULL THEN
      IF p_target_kind = 'garage' THEN
        SELECT g.tenant_id, g.id, g.name INTO v_t_tenant, v_t_garage, v_t_name FROM garages g WHERE g.id = p_target_id;
        v_subject := 'garage';
      ELSIF p_target_kind = 'lane' THEN
        SELECT l.tenant_id, l.garage_id, l.name INTO v_t_tenant, v_t_garage, v_t_name FROM lanes l WHERE l.id = p_target_id;
        v_subject := 'lane';
      ELSIF p_target_kind = 'computer' THEN
        SELECT d.tenant_id, l.garage_id, d.name INTO v_t_tenant, v_t_garage, v_t_name
          FROM lane_devices d JOIN lanes l ON l.id = d.lane_id AND l.tenant_id = d.tenant_id
         WHERE d.id = p_target_id;
        v_subject := 'computer';
      ELSIF p_target_kind = 'key' THEN
        SELECT t.tenant_id, NULL, t.name INTO v_t_tenant, v_t_garage, v_t_name
          FROM operator_tokens t WHERE t.id = p_target_id AND t.kind = 'key';
        v_subject := 'key';
      END IF;
    END IF;

    IF v_t_tenant IS NOT NULL THEN
      PERFORM set_config('openparking.tenant_id', v_t_tenant::text, true);
      IF v_caller IS NOT NULL AND v_caller = v_t_tenant THEN
        INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                    action, subject_kind, subject_id, subject_name, refusal, request)
        VALUES (v_t_tenant, v_t_garage, 'refused', v_kind, v_actor, v_name,
                p_action, v_subject, p_target_id, v_t_name, p_refusal, p_request);
      ELSE
        INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                    action, subject_kind, subject_id, subject_name, refusal, request)
        VALUES (v_t_tenant, v_t_garage, 'refused',
                CASE WHEN v_caller IS NULL THEN 'nobody' ELSE 'outside' END, NULL, NULL,
                p_action, v_subject, p_target_id, v_t_name, p_refusal, p_request);
      END IF;
      v_went := 'target';
    END IF;

    IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM v_t_tenant THEN
      PERFORM set_config('openparking.tenant_id', v_caller::text, true);
      -- Something that is not this account's, or nothing at all: named by
      -- kind only, never by another account's name or id.
      INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                  action, subject_kind, subject_id, subject_name, refusal, request)
      VALUES (v_caller, NULL, 'refused', v_kind, v_actor, v_name,
              p_action, 'unknown', NULL, NULL, p_refusal,
              CASE WHEN v_t_tenant IS NULL THEN p_request ELSE NULL END);
      v_went := CASE WHEN v_went IS NULL THEN 'caller' ELSE 'both' END;
    END IF;

    IF v_went IS NULL THEN
      INSERT INTO platform_security_log (refusal, request, credential)
      VALUES (p_refusal, p_request, p_credential);
      v_went := 'security';
    END IF;

    PERFORM set_config('openparking.tenant_id', coalesce(v_was, ''), true);
    RETURN v_went;
  END
  $$;

REVOKE EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text) TO openparking_app;

GRANT SELECT, INSERT ON garage_changes TO openparking_app;

COMMIT;
