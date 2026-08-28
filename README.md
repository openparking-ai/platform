# Open Parking AI — platform

The multi-tenant server behind Open Parking AI: tenants, sites, rules, pricing and the
event record that lane controllers report into.

Every tenant-owned table is isolated twice over — once by application-level scoping and
again by Postgres row-level security, enabled and **forced** from migration 0001. The
database refuses to leak across tenants even if the application layer forgets to ask
correctly. That guarantee is tested, and the test is proven to fail when RLS is removed.

A card number never passes through this code. Payments are processor-tokenized only; any
change that handles raw card data is rejected on review.

## Stack

Node / Express / Postgres 16.

## Quick start

```sh
npm install
cp .env.example .env
createdb openparking_dev
npm run migrate                 # schema + RLS, as the owner role
npm run ensure-app-role         # the NOSUPERUSER NOBYPASSRLS role the app connects as
npm test
```

## Why two database URLs

`DATABASE_URL` is the owner connection. It runs migrations and nothing else.

`APP_DATABASE_URL` is what the application and the tests connect as, and it points at a
role created `NOSUPERUSER NOBYPASSRLS`. This is load-bearing, not ceremony: **a Postgres
superuser bypasses row-level security unconditionally** — `FORCE ROW LEVEL SECURITY` does
not stop one. An isolation test run as a superuser sees every tenant's rows whether the
policies are present or absent, so it proves nothing in either direction. Connecting as an
unprivileged role is what makes the test mean something.

See [docs/RLS_TEMPLATE.md](docs/RLS_TEMPLATE.md) for the pattern every new tenant-owned
table follows, and [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md) for what is stored about
vehicles and how long it is kept.

## Watch a car drive through

```sh
npm run demo          # database, schema, app role, a demo garage, server on :3000
```

It prints a tenant, a garage and two device tokens, and writes them to
`.demo-credentials.json`. Then, from the
[lane-controller](https://github.com/openparking-ai/lane-controller) repository:

```sh
python -m lane_controller.demo --credentials ../platform/.demo-credentials.json
```

A simulated car arms the loop, is identified, is allowed, the gate vends, and a
session opens once the entry is settled; it leaves and the session closes with the
fee computed. The demo lane has no closing loops, so its entries settle as
`unconfirmable` — see below.

## What the lane talks to

| | |
|---|---|
| `GET /api/v1/lane/rules` | what the lane caches so it can decide offline |
| `POST /api/v1/lane/events` | append lane activity; idempotent on `event_id` |
| `POST /api/v1/lane/sessions/open` | entry; idempotent on `event_id`; requires `entry_confirmation` |
| `POST /api/v1/lane/sessions/close` | exit; computes and freezes the fee; idempotent on `event_id`; requires `exit_confirmation` |

### Every session records what saw the car

A ticket is not an entry. A driver can pull up, take one and drive away, and a
vend with nothing behind it is not an arrival at all — so every abandoned
approach used to become a phantom occupant, counted as inside and never seen
again. The lane now creates a pending entry at the vend and promotes it when two
loops after the barrier see a vehicle cross them forward.

`entry_confirmation` is **required and never defaulted**, and it says which:

| | |
|---|---|
| `confirmed` | two loops after the barrier saw a vehicle cross them forward |
| `unconfirmable` | that lane has no closing loops, so nothing could confirm or refute it |

The response **echoes the value back**, and that is a contract term rather than a
convenience: a platform older than the column accepts the same call and drops the
field, so the lane treats an open that does not echo what it sent as undelivered.

`exit_confirmation` is the same question about the other end of the stay, with
one more value:

| | |
|---|---|
| `held` | the exit vended and nothing confirmed a crossing. It closes and bills anyway — the barrier opened and the car is gone — carrying the flag, with an `exit_held` lane event beside it |

Entries that were backed out of or never confirmed are **not sessions** — no
session, no occupancy, no money. They are lane events and they land in `events`.

`inside_count` on the operator surface counts CONFIRMED sessions. The rest are
not hidden: `unconfirmable_count` and `open_count` are returned beside it.

Every one of those is idempotent on purpose, and idempotent **on the lane's
event id — never on state**. A lane that has been offline re-sends whatever it
could not confirm, so duplicate delivery is the normal case, not an error case.

State is not a key. An entry replayed after the car has already left finds no
open session, and a state-based check opens a second one: a phantom that never
exits and corrupts the garage's inside-count permanently. `event_id` is
required on every session call for that reason.

Times come from the **lane**, never the server clock — the car may have arrived
while the lane had no network. The fee, and the rate that produced it, are frozen
onto the session at exit, so editing a rate later cannot silently reprice history.

### What this platform can and cannot establish

The platform records what a lane device reports, and holds no evidence of its
own. A device token IS that lane's identity: it resolves server-side to one lane
and one direction, so an entry token attempting a close and an exit token
attempting an open are both refused `409` — run against this code, both ways,
rather than promised. What is checked here is shape, direction, ordering (an
exit before its own entry is refused), a time that has not happened yet (further
ahead of this server's clock than the drift tolerated is refused), and the
garage's maximum stay where it has set one. What cannot be checked from here is
that a vehicle was ever there: the lane's loops and camera are the only things
that see a car, so **a stolen device token is a stolen lane**, and every record
it writes is indistinguishable from a real one. Binding a session to physical
evidence is not built.

## Operator surface

Authenticated by an operator token; the tenant comes **from the token**. There is
no HTTP route that mints one — `npm run issue-operator-token <tenant-id> "<name>"`
needs database access, deliberately, because a token is what unlocks the surface.

```sh
curl -H "authorization: Bearer $OPERATOR_TOKEN" \
  http://127.0.0.1:3000/api/v1/garages/<id>/sessions/open
```

## Vehicle identity and retention

The database stores real vehicle identity — plate, make, model, colour — because
that is the product. Transient identity is redacted **30 days after the stay
closes** by default, configurable per tenant; enrolled vehicles persist while
enrolled. `npm run purge` enforces it, and it redacts rather than deletes so the
financial record survives. See [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md).

The **repository** contains no real data at all: fixtures and tests use invented
values, enforced by `npm run check-no-real-data`.

## Licence and contributing

AGPL-3.0-or-later — see [LICENSE](LICENSE).

Contributions are welcome and require a signed CLA before anything merges. See
[CONTRIBUTING.md](CONTRIBUTING.md).

---

Built by 72 Knots Method by 72Knots.ai
