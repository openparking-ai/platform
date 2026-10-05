-- 0028 — a refused attempt is kept where it can be acted on, and one source
-- cannot bury anything.
--
-- WHOSE LOG. 0026 wrote a refused attempt that came with no working sign-in
-- or key into the log of whatever garage it named. That is the easiest thing
-- to send in bulk, and the owner can do nothing about it. Now:
--
--   a working sign-in or key   the log of the garage it aimed at (as
--                              "someone from another account" when it is not
--                              theirs) and, when that is not its own, its own
--                              account's log too -- as before;
--   anything else              the platform's security log only, whatever
--                              garage or id it names: no sign-in, an ended
--                              one, a cancelled or unknown key.
--
-- A credential is read here only to see whether it works NOW -- unrevoked,
-- unexpired, and for a session inside its idle window and signed in after the
-- password last changed, exactly as resolve_operator_session finds one -- and
-- it is never touched, so presenting it keeps nothing alive.
--
-- WHO. A key's line names the key by the name it was issued under, read here
-- when the application did not have it.
--
-- THE BOUND IS PER SOURCE. 0027 counted a repeat only when the request was
-- the same, path and ids included, so changing an id made a new line every
-- time. Now a source -- the account and person or key that asked, or, for
-- nobody, the hashed address -- gets REFUSED_PER_MINUTE lines a minute in a
-- log, across every route and id. The same attempt again is still counted on
-- its own line. Beyond the limit, one line per garage carries the count of
-- the rest (refusal `too_many_refused`). So a minute of anything from one
-- source is at most REFUSED_PER_MINUTE lines plus one in a log.
--
-- `source_key` now holds that source as a hash: the hashed address for
-- nobody, a hash of the account and actor otherwise. Never the address, and
-- never shown.
--
-- Run as the database OWNER.

BEGIN;

CREATE INDEX garage_changes_refused_source_idx ON garage_changes (tenant_id, source_key, at) WHERE outcome = 'refused';
CREATE INDEX platform_security_log_source_idx ON platform_security_log (source_key, at);

-- One refused line in a garage's log, bounded by its source. Called only by
-- record_refused_change(), as the owner of the tables, inside its tenant.
CREATE FUNCTION write_refused_line(
  p_tenant       uuid,
  p_garage       uuid,
  p_kind         text,
  p_actor        uuid,
  p_name         text,
  p_action       text,
  p_subject_kind text,
  p_subject_id   uuid,
  p_subject_name text,
  p_refusal      text,
  p_request      text,
  p_source       text,
  p_now          timestamptz
) RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_window constant interval := interval '60 seconds';
    v_limit  constant integer  := 20;   -- REFUSED_PER_MINUTE
    v_lines  integer;
  BEGIN
    -- One source at a time in this log, so its count cannot be raced past.
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'refused-line', p_tenant, p_source), 0));

    -- The same attempt again: counted on its line.
    UPDATE garage_changes
       SET attempts = attempts + 1, last_at = greatest(coalesce(last_at, at), p_now)
     WHERE id = (
       SELECT id FROM garage_changes
        WHERE tenant_id = p_tenant AND outcome = 'refused' AND source_key = p_source
          AND garage_id IS NOT DISTINCT FROM p_garage
          AND actor_kind = p_kind AND actor_id IS NOT DISTINCT FROM p_actor
          AND action = p_action AND refusal = p_refusal
          AND subject_id IS NOT DISTINCT FROM p_subject_id AND request IS NOT DISTINCT FROM p_request
          AND at > p_now - v_window
        ORDER BY at DESC LIMIT 1);
    IF FOUND THEN RETURN; END IF;

    SELECT count(*) INTO v_lines FROM garage_changes
     WHERE tenant_id = p_tenant AND outcome = 'refused' AND source_key = p_source
       AND refusal <> 'too_many_refused' AND at > p_now - v_window;
    IF v_lines < v_limit THEN
      INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                  action, subject_kind, subject_id, subject_name, refusal, request,
                                  at, last_at, source_key)
      VALUES (p_tenant, p_garage, 'refused', p_kind, p_actor, p_name,
              p_action, p_subject_kind, p_subject_id, p_subject_name, p_refusal, p_request, p_now, p_now, p_source);
      RETURN;
    END IF;

    -- Over the limit: the one line that carries the rest.
    UPDATE garage_changes
       SET attempts = attempts + 1, last_at = greatest(coalesce(last_at, at), p_now)
     WHERE id = (
       SELECT id FROM garage_changes
        WHERE tenant_id = p_tenant AND outcome = 'refused' AND source_key = p_source
          AND refusal = 'too_many_refused' AND garage_id IS NOT DISTINCT FROM p_garage
          AND at > p_now - v_window
        ORDER BY at DESC LIMIT 1);
    IF NOT FOUND THEN
      INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                  action, subject_kind, subject_id, subject_name, refusal, request,
                                  at, last_at, source_key)
      VALUES (p_tenant, p_garage, 'refused', p_kind, p_actor, p_name,
              'refused.many', 'unknown', NULL, NULL, 'too_many_refused', NULL, p_now, p_now, p_source);
    END IF;
  END
  $$;

-- The same, for the platform's security log.
CREATE FUNCTION write_refused_security(
  p_refusal    text,
  p_request    text,
  p_credential text,
  p_source     text,
  p_now        timestamptz
) RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_window constant interval := interval '60 seconds';
    v_limit  constant integer  := 20;   -- REFUSED_PER_MINUTE
    v_lines  integer;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'refused-security', p_source), 0));

    UPDATE platform_security_log
       SET attempts = attempts + 1, last_at = greatest(coalesce(last_at, at), p_now)
     WHERE id = (
       SELECT id FROM platform_security_log
        WHERE source_key = p_source AND refusal = p_refusal AND request = p_request AND credential = p_credential
          AND at > p_now - v_window
        ORDER BY at DESC LIMIT 1);
    IF FOUND THEN RETURN; END IF;

    SELECT count(*) INTO v_lines FROM platform_security_log
     WHERE source_key = p_source AND refusal <> 'too_many_refused' AND at > p_now - v_window;
    IF v_lines < v_limit THEN
      INSERT INTO platform_security_log (refusal, request, credential, at, last_at, source_key)
      VALUES (p_refusal, p_request, p_credential, p_now, p_now, p_source);
      RETURN;
    END IF;

    UPDATE platform_security_log
       SET attempts = attempts + 1, last_at = greatest(coalesce(last_at, at), p_now)
     WHERE id = (
       SELECT id FROM platform_security_log
        WHERE source_key = p_source AND refusal = 'too_many_refused' AND at > p_now - v_window
        ORDER BY at DESC LIMIT 1);
    IF NOT FOUND THEN
      INSERT INTO platform_security_log (refusal, request, credential, at, last_at, source_key)
      VALUES ('too_many_refused', 'more refused requests from this source', p_credential, p_now, p_now, p_source);
    END IF;
  END
  $$;

REVOKE EXECUTE ON FUNCTION write_refused_line(uuid, uuid, text, uuid, text, text, text, uuid, text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION write_refused_security(text, text, text, text, timestamptz) FROM PUBLIC;

DROP FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text);

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
  p_request         text,
  p_source_key      text,
  p_idle_seconds    integer
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
    v_source    text;
    v_was       text := current_setting('openparking.tenant_id', true);
    v_went      text := NULL;
    v_now       timestamptz := clock_timestamp();
  BEGIN
    -- The caller, from a credential the application did not accept for this
    -- request (a session from the wrong site, an ended one, a cancelled
    -- key): an account only while that credential works now. Read, never
    -- touched.
    IF v_caller IS NULL AND p_credential_hash IS NOT NULL THEN
      SELECT t.tenant_id,
             CASE WHEN t.kind = 'session' THEN 'owner' ELSE 'key' END,
             CASE WHEN t.kind = 'session' THEN t.user_id ELSE t.id END,
             CASE WHEN t.kind = 'session' THEN u.email ELSE t.name END
        INTO v_caller, v_kind, v_actor, v_name
        FROM operator_tokens t
        LEFT JOIN operator_users u ON u.id = t.user_id AND u.tenant_id = t.tenant_id
       WHERE t.token_hash = p_credential_hash
         AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > now())
         AND (t.kind = 'key'
              OR (t.kind = 'session' AND u.id IS NOT NULL
                  AND t.last_seen_at > now() - make_interval(secs => p_idle_seconds)
                  AND t.created_at >= u.password_changed_at));
    END IF;

    -- No working sign-in or key: the platform's log, and no owner's.
    IF v_caller IS NULL THEN
      PERFORM write_refused_security(p_refusal, p_request, p_credential, coalesce(p_source_key, md5('no address')), v_now);
      RETURN 'security';
    END IF;

    -- A key is named by the name it was issued under.
    IF v_kind = 'key' AND v_name IS NULL THEN
      SELECT t.name INTO v_name FROM operator_tokens t WHERE t.id = v_actor AND t.tenant_id = v_caller;
    END IF;
    v_source := md5(concat_ws('|', 'actor', v_caller, v_kind, v_actor));

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
      IF v_caller = v_t_tenant THEN
        PERFORM write_refused_line(v_t_tenant, v_t_garage, v_kind, v_actor, v_name,
                                   p_action, v_subject, p_target_id, v_t_name, p_refusal, p_request, v_source, v_now);
      ELSE
        PERFORM write_refused_line(v_t_tenant, v_t_garage, 'outside', NULL, NULL,
                                   p_action, v_subject, p_target_id, v_t_name, p_refusal, p_request, v_source, v_now);
      END IF;
      v_went := 'target';
    END IF;

    IF v_caller IS DISTINCT FROM v_t_tenant THEN
      PERFORM set_config('openparking.tenant_id', v_caller::text, true);
      -- Something that is not this account's, or nothing at all: named by
      -- kind only, never by another account's name or id.
      PERFORM write_refused_line(v_caller, NULL, v_kind, v_actor, v_name,
                                 p_action, 'unknown', NULL, NULL, p_refusal,
                                 CASE WHEN v_t_tenant IS NULL THEN p_request END, v_source, v_now);
      v_went := CASE WHEN v_went IS NULL THEN 'caller' ELSE 'both' END;
    END IF;

    PERFORM set_config('openparking.tenant_id', coalesce(v_was, ''), true);
    RETURN v_went;
  END
  $$;

REVOKE EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text, integer) TO openparking_app;

COMMIT;
