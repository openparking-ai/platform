/**
 * The candidate set: the open stays of one garage, with what identifies each,
 * keyed on the session.
 *
 * The exit module matches an exiting car to a STAY. Its search
 * (`POST /v1/searches` on the identity service) takes one descriptor and a
 * list of `{id, descriptor}` candidates and answers "which of THESE, if any?"
 * -- and the list it must be given is every stay that could be the one
 * leaving, which is every stay still open in the garage the exit lane belongs
 * to. This module is that list. Nothing here compares anything.
 *
 * KEYED ON THE SESSION. A vehicle row is one identity and a descriptor is one
 * read; the search answers with an id, and what an exit needs back is which
 * STAY to close -- so the id is the session's, and it is what the search
 * echoes.
 *
 * WHAT A CANDIDATE CARRIES, and why it is more than the search needs. The
 * search takes an id and a descriptor. The shadow run (a later round) records
 * its outcome beside an ORACLE: on a plate- or ticket-matched exit the close
 * picked the stay independently of the descriptor, and a figure published
 * over those exits names that oracle. So each candidate carries its
 * identifying components -- exactly one of `plate` or `ticket_ref`, the
 * region, and the vehicle attributes the entry read produced -- so a consumer
 * can say which stay the plate picked without a second query. `forSearch`
 * below is the projection down to what the search is sent: no plate leaves
 * this platform for the identity service, whose contract says the search
 * involves no plate.
 *
 * THE DENOMINATOR TRAVELS WITH THE SET. `vehicles_exactly_one_identity` means
 * only plate- or ticket-identified cars ever get a session, so this set covers
 * those cars only; and the descriptor is opt-in at the identity service, so a
 * stay may be open with none. Both counts are on the result, because a figure
 * produced over this set has to be written beside them.
 *
 * RUN ON THE CALLER'S CLIENT, never a pool of its own. The one consumer that
 * matters reads this set INSIDE the close transaction, before `exit_at` is
 * written -- so the stay that is leaving is still open and in the set. Read
 * after the close, the true stay is gone and every plate-matched exit reads as
 * "absent true car". The function takes the client so that ordering is the
 * caller's to make and not this module's to break.
 *
 * `WHERE s.tenant_id = $1` is carried beside the tenant policy, as every query
 * in this platform carries it -- two independent controls (docs/RLS_TEMPLATE.md).
 */

export async function candidateStays(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.entry_confirmation, s.entry_descriptor AS descriptor,
            v.plate, v.ticket_ref, v.plate_region, v.make, v.model, v.color
       FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL
      ORDER BY s.entry_at, s.id`,
    [tenantId, garageId],
  );
  const candidates = rows.map((r) => ({
    id: r.id,
    entry_at: r.entry_at,
    entry_confirmation: r.entry_confirmation,
    // Named rather than inferred from which column is null, so a consumer
    // reads one field and the exactly-one rule is stated on the row it holds.
    identity_kind: r.ticket_ref ? 'ticket' : 'plate',
    plate: r.plate,
    ticket_ref: r.ticket_ref,
    plate_region: r.plate_region,
    make: r.make,
    model: r.model,
    color: r.color,
    descriptor: r.descriptor,
  }));
  return {
    garage_id: garageId,
    open: candidates.length,
    with_descriptor: candidates.filter((c) => c.descriptor !== null).length,
    candidates,
  };
}

/**
 * What the identity service's search is sent: `{id, descriptor}` for exactly
 * the candidates that HAVE a descriptor, and nothing else about them.
 *
 * A stay with no descriptor is not comparable and is not sent -- the search
 * would refuse it per candidate anyway, and sending it would put a car that
 * cannot be matched into a list whose length reads as "how many were
 * considered". It is still in `candidateStays`, and still counted, because
 * "not comparable" is one of the search's three outcomes and the denominator
 * has to say how many stays that was.
 */
export function forSearch(set) {
  return set.candidates
    .filter((c) => c.descriptor !== null)
    .map((c) => ({ id: c.id, descriptor: c.descriptor }));
}

/**
 * The SNAPSHOT the close takes: which stays were open and comparable at this
 * moment, as ids and counts, and nothing heavier.
 *
 * Measured before it was designed (the numbers are in migration 0011): the
 * full `candidateStays` set at 5,000 open stays with real-size descriptors is
 * 62 MB inside the close transaction; ids and counts are 1.2 MB. A descriptor
 * is immutable once written -- set at the open, nulled only by a retention
 * purge that cannot reach an open stay -- so it can be read by id later, by
 * whoever runs the search. What CANNOT be read later is which stays were open
 * before `exit_at` was written on one of them: that is this function, and it
 * is the only thing the close needs to hold.
 *
 * `ids` is exactly the subset `forSearch` would send: the open stays with a
 * descriptor. `open` is every open stay, for the denominator.
 */
export async function candidateSnapshot(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT s.id, (s.entry_descriptor IS NOT NULL) AS comparable
       FROM sessions s
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL
      ORDER BY s.entry_at, s.id`,
    [tenantId, garageId],
  );
  return {
    ids: rows.filter((r) => r.comparable).map((r) => r.id),
    open: rows.length,
    with_descriptor: rows.filter((r) => r.comparable).length,
  };
}
