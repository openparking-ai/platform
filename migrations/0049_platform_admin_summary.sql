-- 0049 — the platform admin's summary: every account, its garages, their
-- lanes and spaces, and how many cars came in and went out between two days.
--
-- WHO READS IT. The person who runs this platform, on a page of their own,
-- through one door (src/platformAdmin.js) that is off unless the deployment
-- names a key file. It is the only read in this schema that is ACROSS
-- accounts on purpose and is not a credential lookup.
--
-- WHAT IT RETURNS. Names and counts only: the account's name and when it was
-- made; each garage's name, time zone, whether it is open (activated_at), its
-- number of spaces (0034; NULL until the map or the owner says it); its lanes
-- (name, entry or exit, closed or open); and two counts. NO plate, NO vehicle,
-- NO picture, NO person, NO money: nothing a stay holds but its two times.
--
--   cars_in   stays whose car came in (entry_at) on a garage-local day from
--             p_from to p_to, both included -- a car still inside counts.
--   cars_out  stays whose car left (exit_at) on a garage-local day in the same
--             range.
--
-- HOW IT READS ACROSS ACCOUNTS WITHOUT WIDENING ANYTHING. The account list
-- comes through the definer lookup 0031 made (`tenants`, `garages`, `lanes`
-- have a SELECT policy for the owner while `openparking.definer_lookup` is
-- 'on'). The stays do NOT: `sessions` gets no new policy. For each account the
-- body sets `openparking.tenant_id` to that account, so the ordinary tenant
-- policy is what lets it count that account's stays and no other's. Both
-- settings are put back as they were found before the function returns.
--
-- The body is SECURITY INVOKER and callable by nobody but the owner; the
-- name the door calls is a definer, closed to PUBLIC and granted to the
-- application role -- the shape 0031 uses, held for every definer by
-- test/definer-grants.test.js.
--
-- A range of more than 366 days is refused, and p_to before p_from.
--
-- Run as the database OWNER.

BEGIN;

CREATE FUNCTION platform_admin_summary_body(p_from date, p_to date)
  RETURNS TABLE (
    tenant_id       uuid,
    tenant_name     text,
    tenant_created  timestamptz,
    garage_id       uuid,
    garage_name     text,
    garage_timezone text,
    garage_open     boolean,
    garage_spaces   integer,
    lanes           jsonb,
    cars_in         bigint,
    cars_out        bigint
  )
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    t        record;
    v_tenant text := current_setting('openparking.tenant_id', true);
  BEGIN
    IF p_from IS NULL OR p_to IS NULL THEN
      RAISE EXCEPTION 'platform_admin_summary: both days are required' USING ERRCODE = '22023';
    END IF;
    IF p_to < p_from OR p_to - p_from > 365 THEN
      RAISE EXCEPTION 'platform_admin_summary: the range is from 1 to 366 days, the first day first' USING ERRCODE = '22023';
    END IF;
    FOR t IN SELECT x.id, x.name, x.created_at FROM tenants x ORDER BY lower(x.name), x.id LOOP
      PERFORM set_config('openparking.tenant_id', t.id::text, true);
      RETURN QUERY
        SELECT t.id, t.name, t.created_at,
               g.id, g.name, g.timezone, g.activated_at IS NOT NULL, g.spaces,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'id', l.id, 'name', l.name, 'direction', l.direction,
                                  'closed', l.closed_at IS NOT NULL)
                                ORDER BY l.direction, lower(l.name), l.id)
                           FROM lanes l WHERE l.garage_id = g.id AND l.tenant_id = t.id), '[]'::jsonb),
               (SELECT count(*) FROM sessions s
                 WHERE s.garage_id = g.id
                   AND s.entry_at >= (p_from::timestamp AT TIME ZONE g.timezone)
                   AND s.entry_at <  ((p_to + 1)::timestamp AT TIME ZONE g.timezone)),
               (SELECT count(*) FROM sessions s
                 WHERE s.garage_id = g.id
                   AND s.exit_at >= (p_from::timestamp AT TIME ZONE g.timezone)
                   AND s.exit_at <  ((p_to + 1)::timestamp AT TIME ZONE g.timezone))
          FROM (SELECT 1) one
          LEFT JOIN garages g ON g.tenant_id = t.id
         ORDER BY lower(g.name), g.id;
    END LOOP;
    PERFORM set_config('openparking.tenant_id', coalesce(v_tenant, ''), true);
  END
  $$;

REVOKE EXECUTE ON FUNCTION platform_admin_summary_body(date, date) FROM PUBLIC;

CREATE FUNCTION platform_admin_summary(p_from date, p_to date)
  RETURNS TABLE (
    tenant_id       uuid,
    tenant_name     text,
    tenant_created  timestamptz,
    garage_id       uuid,
    garage_name     text,
    garage_timezone text,
    garage_open     boolean,
    garage_spaces   integer,
    lanes           jsonb,
    cars_in         bigint,
    cars_out        bigint
  )
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_was text := current_setting('openparking.definer_lookup', true);
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    RETURN QUERY SELECT * FROM platform_admin_summary_body(p_from, p_to);
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
  END
  $$;

REVOKE EXECUTE ON FUNCTION platform_admin_summary(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_summary(date, date) TO openparking_app;

COMMIT;
