-- PLANTED BREAK -- not for merge. 0002's resolve_lane_device put back as it
-- was: a definer that joins FORCED `lanes` with no lookup opened. CI must go
-- red on a lane sign-in; then this file is removed.
BEGIN;
DROP FUNCTION resolve_lane_device(text);
CREATE FUNCTION resolve_lane_device(p_token_hash text)
  RETURNS TABLE (device_id uuid, tenant_id uuid, lane_id uuid, garage_id uuid, direction text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT d.id, d.tenant_id, d.lane_id, l.garage_id, l.direction
    FROM lane_devices d
    JOIN lanes l ON l.id = d.lane_id
    WHERE d.token_hash = p_token_hash
      AND d.revoked_at IS NULL
  $$;
REVOKE EXECUTE ON FUNCTION resolve_lane_device(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_lane_device(text) TO openparking_app;
COMMIT;
