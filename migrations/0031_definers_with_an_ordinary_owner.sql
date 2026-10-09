-- 0031 — the definers work for an ordinary owner.
--
-- WHAT 0002 GOT WRONG. 0002 says the lane resolver "does NOT rely on" a
-- superuser: the owner is exempt from lane_devices' policy because that table
-- is not FORCED, and "the exemption is a property of ownership, not of
-- privilege". True of lane_devices, and false of the function:
-- resolve_lane_device() also joins `lanes`, which IS forced, and FORCE binds
-- the owner. Run with no tenant context -- which is the whole point of a
-- resolver -- an owner that is NOSUPERUSER and NOBYPASSRLS sees no lane, so
-- every lane token is refused. CI never saw it: it migrated as `postgres`, a
-- superuser, and a superuser bypasses every policy. Measured on a live host on
-- 2026-10-09, where it works only because the owner was given BYPASSRLS.
--
-- Two more definers have the same shape:
--   list_tenant_ids_for_maintenance()  (0003)  reads `tenants`, forced. Its own
--     comment says the owner cannot list tenants "because tenants is FORCED",
--     and then lists them as the owner.
--   record_refused_change(...)         (0028)  finds the garage, lane or lane
--     computer an attempt named, in whichever account it is: `garages` and
--     `lanes`, forced. As an ordinary owner another account's target is not
--     found, so its owner's log never gets the line and the caller's line
--     keeps a request that names it.
-- The other five definers read only lane_devices, operator_tokens and
-- operator_users, which are not forced, and need nothing here.
--
-- THE FIX. Each of the three reads ACROSS accounts on purpose: a credential is
-- presented and the account it belongs to is what is being found out. So
-- those three tables get one more policy -- SELECT only, for the role that
-- owns them (the role running this migration), and only while
-- `openparking.definer_lookup` is 'on' -- and the three functions, and
-- nothing else, turn that on.
--
-- How they turn it on. Postgres keeps a setting attached to a function, and
-- puts it back when the function returns, but it lets only a superuser attach
-- one this project made up -- and this migration runs without a superuser. So
-- each function's body is kept exactly as it is, under a new name
-- (`<name>_body`), made SECURITY INVOKER and callable by nobody but the owner;
-- and the old name, with the same arguments, the same result and the same
-- grants, is a definer that turns the setting on, calls the body, and puts the
-- setting back as it found it. If the body fails, the failure undoes the
-- setting with everything else.
--
-- What it does not widen. The policy names the owner, so it is not part of
-- any query the application role makes, whatever that role sets: the
-- application reads exactly what it read before. The owner's own connection
-- (migrations) is still bound by FORCE on all three tables -- the setting is
-- off there. The three functions return what they returned before; their
-- bodies are the same text, moved. test/ordinary-owner.test.js holds each of
-- these.
--
-- Run as the database OWNER, the role that ran every migration before it: the
-- policy is written for whoever runs this, and is for the role that owns the
-- functions. (Run by a superuser, as a development database may be, it is
-- written for the superuser, who needs none of it.)

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'garages', 'lanes']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR SELECT TO %I '
      'USING (current_setting(''openparking.definer_lookup'', true) = ''on'')',
      t || '_definer_lookup', t, current_user);
  END LOOP;
END
$$;

-- The bodies, kept as they are.
ALTER FUNCTION resolve_lane_device(text) RENAME TO resolve_lane_device_body;
ALTER FUNCTION list_tenant_ids_for_maintenance() RENAME TO list_tenant_ids_for_maintenance_body;
ALTER FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text, integer) RENAME TO record_refused_change_body;

ALTER FUNCTION resolve_lane_device_body(text) SECURITY INVOKER;
ALTER FUNCTION list_tenant_ids_for_maintenance_body() SECURITY INVOKER;
ALTER FUNCTION record_refused_change_body(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text, integer) SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION resolve_lane_device_body(text) FROM PUBLIC, openparking_app;
REVOKE EXECUTE ON FUNCTION list_tenant_ids_for_maintenance_body() FROM PUBLIC, openparking_app;
REVOKE EXECUTE ON FUNCTION record_refused_change_body(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text, integer) FROM PUBLIC, openparking_app;

-- The three names, as definers that open the lookup for the length of the call.
CREATE FUNCTION resolve_lane_device(p_token_hash text)
  RETURNS TABLE (device_id uuid, tenant_id uuid, lane_id uuid, garage_id uuid, direction text)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_was text := current_setting('openparking.definer_lookup', true);
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    RETURN QUERY SELECT * FROM resolve_lane_device_body(p_token_hash);
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
  END
  $$;

CREATE FUNCTION list_tenant_ids_for_maintenance()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_was text := current_setting('openparking.definer_lookup', true);
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    RETURN QUERY SELECT * FROM list_tenant_ids_for_maintenance_body();
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
  END
  $$;

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
    v_was  text := current_setting('openparking.definer_lookup', true);
    v_went text;
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    v_went := record_refused_change_body(p_caller_tenant, p_credential_hash, p_credential, p_actor_kind,
                                         p_actor_id, p_actor_name, p_target_kind, p_target_id, p_action,
                                         p_refusal, p_request, p_source_key, p_idle_seconds);
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
    RETURN v_went;
  END
  $$;

REVOKE EXECUTE ON FUNCTION resolve_lane_device(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION list_tenant_ids_for_maintenance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_lane_device(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION list_tenant_ids_for_maintenance() TO openparking_app;
GRANT EXECUTE ON FUNCTION record_refused_change(uuid, text, text, text, uuid, text, text, uuid, text, text, text, text, integer) TO openparking_app;

COMMIT;
