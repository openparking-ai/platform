/**
 * The candidate set: every open stay of ONE garage, keyed on the session,
 * with what identifies it and the stored descriptor -- and nothing from any
 * other garage, any other tenant, or any stay that has closed.
 *
 * Every exclusion below has a positive control in the same test: the thing
 * excluded is planted, shown to exist, and shown absent from the set. A set
 * that is short because a JOIN silently dropped rows looks exactly like a set
 * that is correct, and the only way to tell them apart is to know what should
 * have been there.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { candidateStays, forSearch } from '../src/candidates.js';

let tenant;
let world;

const descriptor = (tag) => `opvid-fp/1:${Buffer.from(`${tag}-${randomUUID()}`).toString('base64url')}`;
const plate = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** One stay, written directly, with every component a candidate carries. */
async function stay(
  tenantId,
  { garage, entryLane, exitLane },
  { plate: p = null, ticket = null, region = null, make = null, color = null, entryDescriptor = null, closed = false, confirmation = 'confirmed' },
) {
  return withTenant(tenantId, async (c) => {
    const v = (
      await c.query(
        `INSERT INTO vehicles (tenant_id, plate, ticket_ref, plate_region, make, color)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, p, ticket, region, make, color],
      )
    ).rows[0].id;
    const s = (
      await c.query(
        `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency,
                               open_event_id, entry_confirmation, entry_descriptor,
                               exit_lane_id, exit_at, exit_confirmation, close_event_id,
                               fee_minor, hourly_minor_applied)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          tenantId, garage, v, entryLane, '2026-08-26T09:00:00Z', randomUUID(), confirmation,
          entryDescriptor,
          closed ? exitLane : null,
          closed ? '2026-08-26T11:00:00Z' : null,
          closed ? 'confirmed' : null,
          closed ? randomUUID() : null,
          closed ? 250 : null,
          closed ? 250 : null,
        ],
      )
    ).rows[0].id;
    return s;
  });
}

const setFor = (tenantId, garage) => withTenant(tenantId, (c) => candidateStays(c, tenantId, garage));

before(async () => {
  tenant = await createTenant('candidates');
  world = await buildWorld(tenant);
});
after(async () => {
  await pool.end();
});

test('every open stay of the garage, keyed on the session, with its identity and descriptor', async () => {
  const d1 = descriptor('ONE');
  const p1 = plate('ONE');
  const s1 = await stay(tenant, world, { plate: p1, region: 'TR', make: 'Toyota', color: 'silver', entryDescriptor: d1 });
  const s2 = await stay(tenant, world, { ticket: `TKT-${randomUUID().slice(0, 8).toUpperCase()}`, entryDescriptor: descriptor('TWO') });
  const s3 = await stay(tenant, world, { plate: plate('THREE') }); // open, no descriptor

  const set = await setFor(tenant, world.garage);
  const byId = Object.fromEntries(set.candidates.map((c) => [c.id, c]));

  assert.ok(byId[s1] && byId[s2] && byId[s3], 'all three open stays are candidates');
  assert.equal(set.garage_id, world.garage);

  // Keyed on the session, and the row carries what identifies the stay.
  assert.equal(byId[s1].plate, p1);
  assert.equal(byId[s1].identity_kind, 'plate');
  assert.equal(byId[s1].ticket_ref, null);
  assert.equal(byId[s1].plate_region, 'TR');
  assert.equal(byId[s1].make, 'Toyota');
  assert.equal(byId[s1].color, 'silver');
  assert.equal(byId[s1].descriptor, d1);
  assert.equal(byId[s1].entry_confirmation, 'confirmed');
  assert.ok(byId[s1].entry_at);

  // A ticket stay is a stay: exactly one identity, named.
  assert.equal(byId[s2].identity_kind, 'ticket');
  assert.equal(byId[s2].plate, null);
  assert.match(byId[s2].ticket_ref, /^TKT-/);

  // A stay with no descriptor is IN the set, with the field null, and COUNTED.
  assert.equal(byId[s3].descriptor, null);
  assert.ok(set.open >= 3);
  assert.equal(set.with_descriptor, set.candidates.filter((c) => c.descriptor !== null).length);
  assert.ok(set.with_descriptor < set.open, 'the denominator says some stays are not comparable');
});

test('a closed stay is not a candidate — with the control that it was there while open', async () => {
  const p = plate('CLOSE');
  const s = await stay(tenant, world, { plate: p, entryDescriptor: descriptor('CLOSE') });
  const before = await setFor(tenant, world.garage);
  assert.ok(before.candidates.some((c) => c.id === s), 'the control: open, it is in the set');

  await withTenant(tenant, (c) =>
    c.query(
      `UPDATE sessions SET exit_at = '2026-08-26T11:00:00Z', exit_lane_id = $2, exit_confirmation = 'confirmed',
              close_event_id = $3, fee_minor = 250, hourly_minor_applied = 250
        WHERE id = $1`,
      [s, world.exitLane, randomUUID()],
    ),
  );
  const after = await setFor(tenant, world.garage);
  assert.ok(!after.candidates.some((c) => c.id === s), 'closed, it is gone');
  assert.equal(after.open, before.open - 1);
});

test('another garage\'s open stay is not a candidate — same tenant, same everything else', async () => {
  const other = await withTenant(tenant, async (c) => {
    const garage = (
      await c.query(
        `INSERT INTO garages (tenant_id, name, timezone, currency)
         VALUES ($1, 'Other Garage', 'America/New_York', 'USD') RETURNING id`,
        [tenant],
      )
    ).rows[0].id;
    const lane = (
      await c.query(
        `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,'Entry',$3) RETURNING id`,
        [tenant, garage, 'entry'],
      )
    ).rows[0].id;
    return { garage, entryLane: lane, exitLane: lane };
  });
  const s = await stay(tenant, other, { plate: plate('OTHER'), entryDescriptor: descriptor('OTHER') });

  // The control: it IS the other garage's candidate.
  const theirs = await setFor(tenant, other.garage);
  assert.ok(theirs.candidates.some((c) => c.id === s));
  // And not this garage's.
  const ours = await setFor(tenant, world.garage);
  assert.ok(!ours.candidates.some((c) => c.id === s), 'a stay in another garage cannot be the car at this exit');
});

test('another tenant sees nothing of this garage — two controls, the policy and the WHERE', async () => {
  const stranger = await createTenant('stranger');
  // Asking for OUR garage's id as the other tenant: the policy hides the rows
  // and the WHERE would not match them anyway. Both are supposed to be there.
  const set = await withTenant(stranger, (c) => candidateStays(c, stranger, world.garage));
  assert.equal(set.open, 0);
  assert.deepEqual(set.candidates, []);
  // The control that the garage has candidates to hide.
  assert.ok((await setFor(tenant, world.garage)).open > 0);
});

test('forSearch sends exactly the stays with a descriptor, as {id, descriptor}, and no plate', async () => {
  const set = await setFor(tenant, world.garage);
  const sent = forSearch(set);
  assert.equal(sent.length, set.with_descriptor);
  assert.ok(sent.length > 0, 'the control: there is something to send');
  for (const c of sent) {
    assert.deepEqual(Object.keys(c).sort(), ['descriptor', 'id']);
    assert.ok(c.descriptor.startsWith('opvid-fp/'));
  }
  // No plate, ticket or attribute leaves for the identity service.
  const text = JSON.stringify(sent);
  for (const c of set.candidates) {
    if (c.plate) assert.ok(!text.includes(c.plate), 'a plate reached the search payload');
    if (c.ticket_ref) assert.ok(!text.includes(c.ticket_ref), 'a ticket reached the search payload');
  }
  // And the control on that sweep: the set itself DOES carry them.
  assert.ok(JSON.stringify(set).includes(set.candidates.find((c) => c.plate).plate));
});
