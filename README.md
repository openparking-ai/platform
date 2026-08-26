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
table follows, and [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md) for what is stored
about vehicles and what has not been decided about keeping it.

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

A simulated car arms the loop, is identified, is allowed, the gate vends, a session
opens; it leaves and the session closes with the fee computed.

## What the lane talks to

| | |
|---|---|
| `GET /api/v1/lane/rules` | what the lane caches so it can decide offline |
| `POST /api/v1/lane/events` | append lane activity; idempotent on `event_id` |
| `POST /api/v1/lane/sessions/open` | entry; idempotent |
| `POST /api/v1/lane/sessions/close` | exit; computes and freezes the fee; idempotent |

Every one of those is idempotent on purpose. A lane that has been offline
re-sends whatever it could not confirm, so duplicate delivery is the normal
case, not an error case.

Times come from the **lane**, never the server clock — the car may have arrived
while the lane had no network. The fee, and the rate that produced it, are frozen
onto the session at exit, so editing a rate later cannot silently reprice history.

## Licence and contributing

AGPL-3.0-or-later — see [LICENSE](LICENSE).

Contributions are welcome and require a signed CLA before anything merges. See
[CONTRIBUTING.md](CONTRIBUTING.md).

---

Built by 72 Knots. Method by [72Knots.ai](https://72knots.ai)
