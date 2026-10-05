-- 0027 — a refused attempt repeated is counted, not written again.
--
-- 0026 wrote a line for every refused attempt, with no bound: anyone could
-- fill the log, and the disk, by sending the same refused request again and
-- again. Now the same refused attempt from the same source -- the same
-- caller (account and person or key, or nobody), the same address, the same
-- action, refusal, subject and request -- within WINDOW of the line's first
-- attempt is that line again: `attempts` goes up by one and `last_at` moves.
-- After the window a new line starts. Changes that were made are never
-- counted together: each keeps its own line, as before.
--
-- The address is kept as a hash (`source_key`), never as itself: the line
-- needs to tell two sources apart, not to say who they were.
--
-- The logs stay append-only for everything else. The trigger from 0026 now
-- lets exactly one change through, on a REFUSED line only: `attempts` up and
-- `last_at` forward, every other field as it was. DELETE and TRUNCATE are
-- refused as before, for every role. The application still holds no UPDATE
-- grant: the count is moved only by record_refused_change(), below.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garage_changes
  ADD COLUMN attempts   integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  ADD COLUMN last_at    timestamptz,
  ADD COLUMN source_key text        CHECK (source_key IS NULL OR source_key ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT garage_changes_count_shape CHECK (
    (outcome = 'done' AND attempts = 1 AND last_at IS NULL)
    OR (outcome = 'refused' AND (last_at IS NULL OR last_at >= at))
  );

ALTER TABLE platform_security_log
  ADD COLUMN attempts   integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  ADD COLUMN last_at    timestamptz,
  ADD COLUMN source_key text        CHECK (source_key IS NULL OR source_key ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT platform_security_log_count_shape CHECK (last_at IS NULL OR last_at >= at);

-- One change allowed, and only this one: a refused line counted again.
CREATE OR REPLACE FUNCTION refuse_log_rewrite() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF TG_OP = 'UPDATE'
       AND (TG_TABLE_NAME <> 'garage_changes' OR to_jsonb(OLD)->>'outcome' = 'refused')
       AND (to_jsonb(NEW) - 'attempts' - 'last_at') = (to_jsonb(OLD) - 'attempts' - 'last_at')
       AND NEW.attempts > OLD.attempts
       AND NEW.last_at IS NOT NULL
       AND NEW.last_at >= coalesce(OLD.last_at, OLD.at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% is append-only: a line is never changed or removed', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END
  $$;

DROP FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text);

-- As 0026, with the source and the count. WINDOW: 60 seconds from a line's
-- first attempt. Each kind of attempt is taken one at a time (an advisory
-- lock on its key, for this transaction), so attempts arriving together
-- still count onto one line. One that took its clock reading before the
-- line's last attempt was counted keeps `last_at` where it is: it only moves
-- forward.
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
  p_source_key      text
) RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_window    constant interval := interval '60 seconds';
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
    v_now       timestamptz := clock_timestamp();
  BEGIN
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
      DECLARE
        k_kind text := CASE WHEN v_caller IS NOT NULL AND v_caller = v_t_tenant THEN v_kind
                            WHEN v_caller IS NULL THEN 'nobody' ELSE 'outside' END;
        k_id   uuid := CASE WHEN v_caller IS NOT NULL AND v_caller = v_t_tenant THEN v_actor END;
        k_name text := CASE WHEN v_caller IS NOT NULL AND v_caller = v_t_tenant THEN v_name END;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'target', v_t_tenant, v_t_garage, k_kind, k_id,
          p_action, p_refusal, p_target_id, p_request, p_source_key), 0));
        UPDATE garage_changes
           SET attempts = attempts + 1, last_at = greatest(coalesce(last_at, at), v_now)
         WHERE id = (
           SELECT id FROM garage_changes
            WHERE tenant_id = v_t_tenant AND garage_id IS NOT DISTINCT FROM v_t_garage AND outcome = 'refused'
              AND actor_kind = k_kind AND actor_id IS NOT DISTINCT FROM k_id
              AND action = p_action AND refusal = p_refusal AND subject_id IS NOT DISTINCT FROM p_target_id
              AND request IS NOT DISTINCT FROM p_request AND source_key IS NOT DISTINCT FROM p_source_key
              AND at > v_now - v_window
            ORDER BY at DESC LIMIT 1);
        IF NOT FOUND THEN
          INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                      action, subject_kind, subject_id, subject_name, refusal, request,
                                      at, last_at, source_key)
          VALUES (v_t_tenant, v_t_garage, 'refused', k_kind, k_id, k_name,
                  p_action, v_subject, p_target_id, v_t_name, p_refusal, p_request, v_now, v_now, p_source_key);
        END IF;
      END;
      v_went := 'target';
    END IF;

    IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM v_t_tenant THEN
      PERFORM set_config('openparking.tenant_id', v_caller::text, true);
      DECLARE
        k_request text := CASE WHEN v_t_tenant IS NULL THEN p_request END;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'caller', v_caller, v_kind, v_actor,
          p_action, p_refusal, k_request, p_source_key), 0));
        UPDATE garage_changes
           SET attempts = attempts + 1, last_at = greatest(coalesce(last_at, at), v_now)
         WHERE id = (
           SELECT id FROM garage_changes
            WHERE tenant_id = v_caller AND garage_id IS NULL AND outcome = 'refused'
              AND actor_kind = v_kind AND actor_id IS NOT DISTINCT FROM v_actor
              AND action = p_action AND refusal = p_refusal AND subject_kind = 'unknown'
              AND request IS NOT DISTINCT FROM k_request AND source_key IS NOT DISTINCT FROM p_source_key
              AND at > v_now - v_window
            ORDER BY at DESC LIMIT 1);
        IF NOT FOUND THEN
          INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                      action, subject_kind, subject_id, subject_name, refusal, request,
                                      at, last_at, source_key)
          VALUES (v_caller, NULL, 'refused', v_kind, v_actor, v_name,
                  p_action, 'unknown', NULL, NULL, p_refusal, k_request, v_now, v_now, p_source_key);
        END IF;
      END;
      v_went := CASE WHEN v_went IS NULL THEN 'caller' ELSE 'both' END;
    END IF;

    IF v_went IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'security', p_refusal, p_request, p_credential, p_source_key), 0));
      UPDATE platform_security_log
         SET attempts = attempts + 1, last_at = greatest(coalesce(last_at, at), v_now)
       WHERE id = (
         SELECT id FROM platform_security_log
          WHERE refusal = p_refusal AND request = p_request AND credential = p_credential
            AND source_key IS NOT DISTINCT FROM p_source_key
            AND at > v_now - v_window
          ORDER BY at DESC LIMIT 1);
      IF NOT FOUND THEN
        INSERT INTO platform_security_log (refusal, request, credential, at, last_at, source_key)
        VALUES (p_refusal, p_request, p_credential, v_now, v_now, p_source_key);
      END IF;
      v_went := 'security';
    END IF;

    PERFORM set_config('openparking.tenant_id', coalesce(v_was, ''), true);
    RETURN v_went;
  END
  $$;

REVOKE EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text) TO openparking_app;

COMMIT;
