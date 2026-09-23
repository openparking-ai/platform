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
| `GET /api/v1/lane/rules` | what the lane caches so it can decide offline: the garage's plans whole, its space class, each linked module's register, the open stays with a cursor — the slow cadence |
| `GET /api/v1/lane/stays?since=<cursor>` | every stay changed since the cursor, closed rows included — the fast cadence; without `since`, the full open set |
| `POST /api/v1/lane/events` | append lane activity; idempotent on `event_id` |
| `POST /api/v1/lane/sessions/open` | entry; idempotent on `event_id`; requires `entry_confirmation`; carries and echoes an optional `descriptor` |
| `POST /api/v1/lane/sessions/close` | exit; computes and freezes the fee; idempotent on `event_id`; requires `exit_confirmation`; carries and echoes an optional `descriptor` |

### A stay is identified by a plate or by a ticket — exactly one

The camera used to be the only way into the record. A driver whose plate could
not be read had no identity for a session to open on, so the intercom had
nothing to hand this platform even after a human had decided to let the car in.

`vehicles` now carries **exactly one** of:

| | |
|---|---|
| `plate` | a plate a camera **read** |
| `ticket_ref` | an identity a display or a person **asserted** |

Every route that opens, finds or closes a stay takes either, in the same
exactly-one form — `POST /lane/sessions/open`, `GET /lane/sessions/open`
(`?plate=` or `?ticket_ref=`) and `POST /lane/sessions/close`. **A lane that
sends only a plate is unchanged**, and a test asserts that end to end.

Sending **both** is refused. A row carrying a plate and a ticket would be
claiming this platform established they belong to the same vehicle, and nothing
here can: the plate is a measurement and the ticket is an assertion. Binding the
two is the identity module's job, and `vehicles_exactly_one_identity` is what
keeps it from being done accidentally in this one.

**A `ticket_ref` is opaque here.** What is checked is a closed alphabet and a
length — 6 to 64 characters of `A-Z`, `0-9` and hyphen — and nothing else: no
signature, no expiry, no issuer. The agent that mints and verifies tickets is a
different module. This platform's whole claim about a ticket is that it is
unique per tenant and that it looks like one.

It is personal data on the same terms a plate is, and the retention purge
redacts it on the same window — see
[docs/DATA_RETENTION.md](docs/DATA_RETENTION.md).

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

### A session carries the appearance descriptor its entry read produced

The exit module matches an exiting car to a **stay** by comparing one descriptor
against the descriptors of every open stay in the garage. This is the entry
half: a lane whose identity service produced a descriptor sends it on the open
as `descriptor`, and the platform holds it on the session as `entry_descriptor`
(migration 0009).

A descriptor is the identity service's opaque, versioned, compact string
(`opvid-fp/<version>:…`) — a bounded set of keypoint descriptors, a colour
histogram and a coarse edge grid, after a fixed resize. It is not an image, a
photograph cannot be reconstructed from it, and this platform does not parse
it: what is checked is that it is a string, not blank, and at most 64 KiB (a
bound with a measurement behind it, in `src/app.js`).

**It is optional, and absent means NOT MEASURED.** The identity service produces
one only when a deployment asks for it, so a lane with it switched off — the
default — sends none and is unchanged, and every row written before the column
carries `null`.

**The response echoes it back, and that is the contract term.** This route
destructures the keys it knows and ignores the rest, so a platform older than
the column accepts the same call with a `201` and drops the field — silently,
which is worse than a refusal because nothing reports it. The lane treats an
open whose response does not carry the descriptor it sent as undelivered,
exactly as it does for `entry_confirmation`. A fail control
(`npm run entry-descriptor-fail-control`) turns the suite red when the field is
ignored, not stored, not echoed, unbounded, or left behind by retention.

**It is identity, and retention reaches it.** It describes one specific car's
appearance, so it is personal data on the same terms the plate is: the purge
nulls it on the sessions of every vehicle it redacts, on the same window, in
the same run — see [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md).

**The exit's descriptor rides the CLOSE, and no other channel.** A lane whose
exit read produced one sends it on `POST /lane/sessions/close` as `descriptor`,
and the platform holds it as `exit_descriptor` (migration 0010), echoes it, and
redacts it with the entry one. The exit reaches this platform on two channels
that arrive in no specified order — the sessions sync and the events ingest —
and the shadow search snapshots the open stays *inside* the close transaction,
before `exit_at` is written; on the events channel the descriptor could land
after the stay was already closed, and every plate-matched exit would read as
"absent true car". One channel, one ordering. A stay that has not exited holds
no exit descriptor — `sessions_exit_descriptor_needs_exit`, checked at the
database and not only at the route.

### The candidate set

The exit module's search takes one descriptor and a list of `{id, descriptor}`
candidates and answers "which of *these*, if any?" — and the list it must be
given is every stay that could be the one leaving: every stay still open in the
garage the exit lane belongs to. `src/candidates.js` is that list.

**Keyed on the session**, because what an exit needs back is which *stay* to
close. Each candidate carries what identifies it — exactly one of `plate` or
`ticket_ref` (named as `identity_kind`), the region and the vehicle attributes
the entry read produced — beside the stored `descriptor`, so a later round can
say which stay the plate picked without a second query. `forSearch` projects
that down to what the identity service is sent: `{id, descriptor}` for exactly
the stays that **have** a descriptor, and no plate, ticket or attribute — its
contract says no plate is involved.

**The denominator travels with the set.** Only plate- or ticket-identified cars
ever get a session, and the descriptor is opt-in at the identity service, so a
stay may be open with none. `open` and `with_descriptor` are on the result
because a figure produced over this set has to be written beside them.

**It runs on the caller's client.** The consumer that matters reads the set
*inside* the close transaction, before `exit_at` is written, so the stay that
is leaving is still open and in it. There is no operator route for it.

### The shadow run

The search is called for real exits, its answer **recorded**, and nothing acts
on it. Two halves, with a row in `shadow_searches` (migration 0011) between them.

**The snapshot is taken inside the close, before `exit_at` is written.** A
close that carries a descriptor reads which stays are open and comparable in
the same transaction, after the stay to close is found and before it is
closed, and writes them as **session ids and counts** — nothing heavier. That
was measured, not preferred: at 5,000 open stays with real-size descriptors the
full candidate set is 62 MB inside the close transaction; ids and counts are
1.2 MB. A descriptor is immutable once written, so the worker reads them by id
later; which stays were open *before* the close is the one thing that cannot
be re-read, and it is the one thing the close holds. A snapshot taken after the
close finds the true stay already gone, and every plate-matched exit reads as
"absent true car" — the fail control puts that ordering back and the suite goes
red.

**The worker runs later, outside any request** — `npm run shadow-search`, on a
schedule beside the purge. It needs `VEHICLE_ID_URL` (the identity service's
search route, on loopback or a tokened bind: `VEHICLE_ID_TOKEN_FILE`) and the
two thresholds the search is told to apply, `SHADOW_THRESHOLD_STRUCTURE` and
`SHADOW_THRESHOLD_COLOUR` — **required, never defaulted**, because no operating
point has been measured for the descriptor on real entry-and-exit photographs.
It sends `{id, descriptor}` per candidate and nothing else, and writes the
outcome onto the row and a `shadow_search` event beside it: **session ids,
never descriptors** — `events` is append-only by grant and outside the
retention purge. A search that cannot be obtained leaves the row pending and
counted, and is retried. **Retention reaches the row:** when the purge redacts
the stay it shadowed, the session references go and the outcome and counts
stay, so the figure survives the identity — see
[docs/DATA_RETENTION.md](docs/DATA_RETENTION.md).

**What may be published** — `npm run shadow-report <tenant> <garage>`. Every
figure names its denominator and its oracle: on every row the close picked the
stay by plate or ticket independently of the search, so whether the search
named that stay is a measurement with ground truth — over plate- or
ticket-identified cars only, inheriting the plate reader's own errors. The four
rates (match, wrong match, tie, no match) partition the rows where the true
stay was comparable; a tie that includes the true stay is a tie, not a match.
**A match rate over all exits is not measurable here** — a close that matches
nothing answers 404 and inserts no row — and none is published.

**Nothing decides anything.** No vend, fee or session is touched by an outcome.
The identity service this needs — one serving the search route on the platform
host — is a deployment dependency and is not started by anything here.

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
while the lane had no network. The fee, and the plan version and breakdown that
produced it, are frozen onto the session at exit, so a later version cannot
silently reprice history.

### What this platform can and cannot establish

The platform records what a lane device reports, and holds no evidence of its
own. A device token IS that lane's identity: it resolves server-side to one lane
and one direction, so an entry token attempting a close and an exit token
attempting an open are both refused `409` — run against this code, both ways,
rather than promised. What is checked here is shape, direction, ordering (an
exit before its own entry is refused). What cannot be checked from here is that
a vehicle was ever there: the lane's loops and camera are the only things
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

### A lane that has gone quiet

`GET /api/v1/garages/<id>/devices` lists the devices on that garage's lanes with
`last_seen_at` — the column written on every authenticated lane request. It is
the only place anything can see that a lane has stopped reporting, because a
lane that is switched off cannot report that it is switched off.

The platform publishes the timestamp and **no verdict**. How long is too long is
a per-site assumption, and a threshold chosen here would be one nobody measured,
applied to every site. `revoked_at` is in the listing beside it, because a
revoked device that stops being seen is not a fault. `token_hash` is not.

### Every conflict names itself

A `409` is this platform's **terminal** refusal: a lane classifies `5xx` as
retryable and re-sends forever, so anything meant as final arrives as one of
these and the lane dead-letters it. Seven different conditions produced one
indistinguishable fact, and one of the seven is a clock skew large enough that
every session open and close from that lane is being dropped — money leaving the
record, reported to nobody.

Every `409` body therefore carries a machine-readable `code` beside the human
`error` message:

```json
{ "error": "entry_at is 600s ahead of this server's clock, more than the 120s of drift tolerated — a time in the future is not a stay that has happened", "code": "clock_skew" }
```

It is on **all** of them and not only on the skew, because a code present on one
refusal and absent from six cannot distinguish "this was not a skew" from "this
platform is too old to say". A consumer reading that absence as "not a skew"
would report a healthy clock while the record lost every session the lane sent.

### Rate plans: the plan store

Pricing lives in [`rate-engine`](https://github.com/openparking-ai/rate-engine),
a finished engine with **no persistence**: `quote(plans, stay)` takes every plan
version of a garage on every call and picks the one in force at entry. Until
migration 0012 nothing in this platform could hand it that list — `rates` is an
hourly figure with no currency, no plan, no version and no effective date — so
the platform is the engine's first caller, and this is the store.

```sh
curl -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"plan": { ...the plan document, whole... }}' \
  http://127.0.0.1:3000/api/v1/garages/<id>/rate-plans     # 201, the row and the document
curl -H "authorization: Bearer $OPERATOR_TOKEN" \
  http://127.0.0.1:3000/api/v1/garages/<id>/rate-plans     # every plan of the garage
```

What the store does, and does not do — the reasons are in `migrations/0012_rate_plans.sql`:

- **The document is stored whole.** The engine's own loader refuses and names any
  key its version does not understand; a schema that shredded the document into
  columns would drop exactly those keys silently. `plan_version` and
  `effective_from` are lifted out as index keys and CHECKed against the document.
- **Validated by the engine before it is stored, never at the barrier.** The route
  sends the document to the engine's `POST /v1/validate-plan` at `RATE_ENGINE_URL`.
  A document the engine cannot load is a `400` carrying the engine's sentence
  (which names the key). A document that loads but has **findings** — a gap
  nothing prices, a conflict — is `409 plan_has_findings` with every finding in
  `details`, settled ones included: a decision is an acknowledgement, not a
  price. No engine reachable is `409 rate_engine_unavailable`, never a silent
  accept.
- **The read returns every plan; the engine selects.** There is no "current plan"
  route and no selector here. The engine's `select_plan` picks by entry time and
  its own test holds that rule; a second chooser would be the copy that drifts.
- **Currency is the garage's, in one place.** The document restates it; a plan in
  another currency is `409 plan_currency_disagrees_with_garage` at the route and
  a trigger refusal on a direct INSERT.
- **One version name and one effective instant per garage** —
  `409 plan_version_exists`, `409 plan_effective_from_taken`. Two versions at one
  instant is the ambiguity the engine refuses on every stay from then on; it is
  refused here first.
- **Append-only by grant, like `events`.** A changed price is a new version.
  Storing one is recorded as a `rate_plan_stored` event naming the operator token.
- **A closed stay keeps `plan_version`, `breakdown` and `space_class` beside
  `fee_minor`** — the version that priced it, the engine's plain-English ledger
  and the class it was priced as, together or not at all.

### The close prices through the engine, and a close that cannot price still closes

`src/fees.js` is gone (migration 0013). `POST /lane/sessions/close` hands
**every** plan of the garage — unfiltered — with the garage's currency and
space class to the engine's `POST /v1/quote`, and freezes what comes back onto
the stay. The engine picks the version in force at **entry**; its own test holds
that rule, and this platform does not pre-select, because a platform that handed
it one version would have made the choice itself, silently, by exit time. The
response is the row, never a recomputation, and a replay echoes what was
frozen. A later version never reprices a closed stay.

**A refusal is not a refusal of the close.** `computeFee` could not fail;
`quote()` refuses by design — no version in force at entry (the ordinary first
morning of a plan: cars that came in the night before), a gap the plan set left
— and a `409` there is **dropped by the lane**: the barrier has already
opened, the car is gone, the stay never closes, nothing is billed, and the car
is counted inside for ever. So the stay closes **unpriced**: `200`,
`fee_minor: null`, the refusal — the engine's findings, verbatim — in
`pricing_refusal`, a `close_unpriced` event beside it, and a line under
`closes_unpriced` in the reconciliation report (codes, no plate). A flag for a
human, not a hole in the ledger; the same principle as `exit_held`.

An engine that **cannot be reached** is different and is not recorded as
unpriced: the stay can be priced, just not now. That close answers `500`, the
transaction rolls back, and the lane's outbox retries with the same event id.

**A space class, because the engine prices a space.** A garage carries
`space_class` (default `standard`, set at creation, frozen like its currency);
every stay in it is priced as that class, and the store refuses a plan that
does not declare it (`409 plan_does_not_price_garage_space_class`). A garage
with two kinds of space is not expressible today — stated, not hidden.

`test/pricing.test.js` drives all of it through the lane route against the real
engine. `npm run pricing-fail-control` breaks each property — the 409 put back,
the refusal uncaught, an outage recorded as a refusal, the platform selecting
the latest version, the class hard-coded, the ledger dropped, the event
dropped, the report hiding the row, the store ignoring the class, and two
schema statements never created — and requires the suite to go red.

`test/rate-plans.test.js` starts the real engine — the commit in
`rate-engine.pin`, installed by CI — because the store's claims are the engine's
sentences and a stand-in would test this platform against itself.
`npm run rate-plans-fail-control` breaks each property in turn and requires the
suite to go red.

### The activation gate

A garage is not usable until its **rate setup is complete** and its **transient
mode is stated** (migration 0014). Two conditions, observed from the schema:

- **rate_setup_complete** — at least one plan is stored and a version is in
  force now. The store already refused a plan the engine found fault with, so
  this is presence and coverage, not a second validation.
- **transient_mode_stated** — `transient_available` is `true` (sells transient
  parking) or `false` (pass and monthly only). It is the three-state field
  `garage-pass` ships, copied: unstated (`null`) is not false, nothing defaults
  it, and a request cannot send `null` as a value. Stated at creation or by
  `PATCH /api/v1/garages/<id>` at any time; restatable, never un-statable.

There is no third condition. The payment-processor onboarding and the tested
money collection are a separate requirement with its own place; this gate
carries no such condition at all rather than an unchecked one, and a test
sweeps `src/` and `migrations/` for the processor's name.

```sh
curl -H "authorization: Bearer $OPERATOR_TOKEN" \
  http://127.0.0.1:3000/api/v1/garages/<id>/activation   # active?, and each condition with why not
curl -X POST -H "authorization: Bearer $OPERATOR_TOKEN" \
  http://127.0.0.1:3000/api/v1/garages/<id>/activate     # 201 and a garage_activated event, or 409 garage_not_activatable with `details.unmet`
```

Activation is an act, with a timestamp and the operator token that did it, and
the database's own trigger checks the same conditions as the row is written —
a direct `UPDATE` does not go around the route. Once set it cannot be cleared
or moved. **An inactive garage does not operate:** `POST /lane/sessions/open`
and `/close` answer `409 garage_not_active`, and because the lane drops a 409,
the refusal is **recorded first** as a `garage_inactive_refusal` event keyed on
the lane's event id. `/lane/rules` carries `active` so a lane can see it.

What the gate does not reach: a stay that outlived the plan that covered it. It
still arrives at the exit with no price, and the unpriced close above is its
backstop. `npm run activation-fail-control` breaks each property in turn.

### The exit's three outcomes, and the two modules consulted

His words: *"we have several different customers: monthly/garage pass,
transient, transient with card on file."* Every close now names which
(migration 0015), in `sessions.exit_outcome`:

- **`covered`** — a garage pass or a monthly agreement covers the stay. No
  transient fee; which module said so, and what it said, is in
  `sessions.entitlement`, and an `exit_covered` event records the money not
  charged.
- **`transient`** — priced through the engine (or unpriced with its refusal).
- **`transient_card_on_file`** — priced, charged off-session, no tap.
  **Declared and produced nowhere:** this platform holds no customer, account
  or card, so no close can say it yet. It is in the vocabulary so the third
  customer has a seat; a test asserts nothing writes it.

Before pricing, the close consults **`garage-pass`** (`access-in-store
--direction exit`) and **`monthly-billing`** (`covered-in-store --entered-at`)
— each through its own command line, run as a subprocess with the environment
this platform was given (`GARAGE_PASS_DSN`, `MONTHLY_BILLING_DSN` are theirs;
`ENTITLEMENT_BIN_DIR` names where the scripts are, else the PATH). This platform
imports neither and holds none of their data. Both linked modules are always
asked; what each printed, its exit code and the argv are kept verbatim on the
row — the named reason for a not-covered answer as much as for a covered one,
and no amount ever travels. **A module that cannot answer is not a
not-covered:** the close answers `500`, rolls back, and the lane retries — a
pass holder is not billed on the strength of an outage.

**Links are stated, never inferred.** `PUT /api/v1/garages/<id>/entitlement-links`
with `{"garage_pass": {"tenant_id", "garage_id"} | null, "monthly_billing": … | null}`
says which garage this is in each module, under which tenant of that module.
Each stated link is **probed** — the module must answer a question about that
garage at all — and refused `409 entitlement_link_unanswerable` when it cannot.
A garage linked to neither prices every exit as transient, on the record. Every
statement is recorded (`entitlement_links_stated`).

The retention purge nulls `entitlement` (it names the identity) on the sessions
of every vehicle it redacts and keeps `exit_outcome`. `test/exit-outcomes.test.js`
builds a database for each module from its own migrations (`garage-pass.pin`,
`monthly-billing.pin`; CI checks them out), seeds through their doors, and drives
all of it through the lane's close. `npm run exit-outcomes-fail-control` breaks
each property in turn.

### The rules payload: what the exit decides from, off the barrier's path

His requirement: *"we must identify the car and display the fee in about a
second. if no fee (garage pass, monthly) open the gate in about a second."*
Nothing on the barrier's path may wait on the network, so the lane decides
from what it already holds — and what it holds comes from `GET /lane/rules`
(migration 0016):

- **`rate_plans`** — every plan of the garage, whole, as 0012 stores them,
  oldest first. The engine selects among them by entry time; this platform
  filters nothing. **`space_class`** — the garage's, which every quote takes.
- **`entitlements`** — each linked module's register, read through its own
  `show-garage-register` verb (garage-pass G27, monthly-billing G48) and kept
  verbatim under `register`, beside the argv and exit code: which vehicle a
  pass or an agreement holds *at this garage*, its state and its days, in the
  modules' own words — the lane reads them with its own clock, which is how
  both verbs are written to be read. A module that is not linked says so; a
  module whose register **could not be read** says `unavailable`, carries no
  `register`, and `complete` is false. An outage is never an empty register:
  a reader replaces a module's facts only when its `register` is present.
- **`stays`** — the garage's open stays (`plate` or `ticket_ref`, `entry_at`,
  `entry_lane`) and a **cursor**. A transient cannot be priced without its
  entry time, and the entry time lives here.

**Two cadences.** Plans, entitlements and settings change rarely; open stays
change with every car. So `GET /lane/stays?since=<cursor>` is the fast one:
every stay whose `change_seq` is past the cursor, in order, **closed rows
included** so a reader drops them; `cursor` is where to continue from and
`more` says a page filled. `sessions.change_seq` is drawn from one sequence and
bumped by a trigger whenever the entry, the exit, the vehicle or the entry lane
changes — every writer moves it without knowing it exists. **The cursor's
honest limit:** a sequence value is taken when a row is written, and a
transaction can commit after a later value was already read, so a delta can
miss such a row. The full open set — on `/lane/rules`, and on `/lane/stays`
without `since` — is what bounds the miss: a reader takes the full set on the
slow cadence and the delta on the fast one. `test/rules-payload.test.js` plants
exactly that race and asserts both halves. The interval a lane polls the fast
route at is the size of the class of cars that entered too recently to be
priced at the barrier; that interval is the lane's configuration, not this
platform's.

**What left the payload:** `hourly_minor` and `rate_id` — an hourly figure
from the `rates` table that nothing has priced with since 0013 (serving it
beside the real plans would be two prices on one channel) — and `plate_rules`,
an empty list. `POST /api/v1/garages/<id>/rates` is **retired by name**: `410
rates_retired`, pointing at `/rate-plans`. The table stays (`sessions.rate_id`
and the hourly-legacy rows reference it); nothing writes it.

A rules read records nothing: like the two module verbs it calls, it writes
no row and appends no event. `npm run rules-payload-fail-control` breaks each
property in turn.

### The close consumes the lane's decision, and the reconciler checks it out of band

The exit round moved the price to the lane: the barrier shows a fee computed
on the box, before the boom moves, by the same engine function this platform
calls, from the plans this platform handed it. One computation feeds the
screen, the card and the row — so a close that carries the lane's decision
(`local_decision` on the close body, the lane's `exit_pricing` detail) **writes
that decision's numbers and does not run the engine again** (migration 0017).
A close that carries none prices exactly as before. Which path closed the stay
is on the row: `sessions.decided_by` is `'platform'` or `'lane'`, and every
closed stay says which.

**What the close does not consume.** A decision that names a session other
than the one being closed, prices in another currency or space class, or names
a plan version this garage does not hold is not written as the fee: the close
prices itself and keeps the decision it did not take on the entitlement record
under `local_decision_ignored`, with its reason. A lane that could not decide
(`no_cached_entry`, `stale_facts`, `engine_refused`, `engine_invalid`) says so
and the close prices itself, as before. A decision whose shape is wrong is a
`400` by name, and the stay stays open. None of those is a `5xx`: a `5xx` the
lane classifies as retryable and jams its outbox behind. A covered decision
closes the stay `exit_covered` without asking either module — the lane read the
same registers this platform would have — and the event's actor says
`lane:decision`.

**What stands behind a device-written fee.** The platform now stores a fee a
device wrote, on a device token. Two things stand behind it:

- **`sessions.decision_inputs`** — everything the lane said it decided from:
  the entry and exit instants it priced between, the space class, the plan
  version, the currency, the fee, and the cache's `synced_at` (the rules' and
  the stays' timestamps and the stays cursor). Stored beside the fee, held to
  the fee by a CHECK (`lane` carries inputs, `platform` carries none), so the
  number can be re-derived later from what the lane said it used.
- **The reconciler** — `laneDecidedCloses` in `src/reconcile.js`, on the
  operator's reconciliation route, never the barrier's path. It recomputes each
  lane-decided fee through the engine from those inputs and the plans as
  stored, and **reports divergence and stops**: `agreed`, `diverged` (the lane's
  figure and the recomputed one side by side, with the cache's `synced_at`),
  `inputs_disagree` (the inputs the lane said it used against the row's own
  entry, exit and class), `unrecomputable` (the engine's refusal, verbatim),
  `covered_by_lane` (listed, not re-consulted). It corrects nothing: an
  auto-correcting reconciler on a money record is a way to lose the evidence of
  the thing it was built to detect. The same shape the file already had.

**And it looks without being asked** (migration 0018). The reconciliation route
reports on the period an operator asked about — 24 hours by default — so a fee
written by a device that nobody queries inside that day was never re-derived by
anything: the record was there, and nothing looked. `npm run
reconcile-lane-decisions`, on a schedule beside the purge and the shadow
search, sweeps **every lane-decided close nothing has checked yet, oldest
first, with no window over it**. `sessions.decision_checked_at` is the queue
(NULL means never checked) and `sessions.decision_check` is the verdict —
`agreed`, `diverged`, `inputs_disagree`, `unrecomputable` or `covered` — held
to it by a CHECK. A verdict that is not `agreed` is also written to `events`,
which is append-only by grant, so the finding cannot be edited away by
something that can write `sessions`. **The sweep corrects nothing**, unattended
least of all: the two columns above are the only ones its statement names. The
operator's route publishes `lane_decisions_unchecked`, so a sweep that has
stopped running is visible as a backlog rather than as silence.

`test/lane-decided-close.test.js` plants a lane that writes fee + 1 and asserts
the reconciler names it and the row is byte-identical after;
`test/lane-decision-sweep.test.js` plants the same lane on a close **a year
old** — outside every window the route would report on — and asserts the sweep
finds it, and that every column of that row but the two is byte-identical
afterwards.
`npm run lane-decided-close-fail-control` and `npm run lane-decision-sweep-fail-control` break each property in turn — the
close pricing again, the inputs not stored, a mismatch consumed, a covered
decision asking the doors, a blind reconciler, a correcting one, and the
attribution constraint never created.

### A validation at the exit: a linked module, and one more line on the ledger

A **validation** is a discount a merchant gives a driver ahead of the exit,
carried by the driver's phone number. The module that holds validations is its
own system, asked through its own door as garage-pass and monthly-billing are,
and **this repository gets the ability to ask, never the module** (migration
0019). A garage states which garage of a validations module it is —
`PUT /api/v1/garages/<id>/validations-link` with `{validations: {tenant_id,
garage_id}}` or `null` — and the link is probed before it is stored.

**The claim is made when the phone is entered, not at the close** (amendment
A1): the close comes after the barrier opens, and the driver has to see the
discounted amount before paying. The reader shows the fee the lane priced with
an optional phone number; the lane sends what was entered to
`POST /api/v1/lane/sessions/<id>/validation` with the decision on screen, and
this platform reads and, when a validation is live, **claims it for the stay on
that fee** and holds it on the open stay. The answer — the line, the fee before
and after — is what the reader shows next. The claim is made only on a priced
decision above zero that the close would consume for this very stay; asked
again on the same fee it answers the held claim, without the door.

The discount is **the module's assertion**, checked for shape — whole minor
units, not more than the fee, the fee and currency echoed back — and it becomes
**one more line on the ledger**, `code: 'validation'`, after the engine's lines.
**The close records the held claim — when the reader showed it** (amendment
A2): the close carries `reader_shown`, `{fee_minor, currency}`, what the reader
actually put up, and the line is appended, the fee the running total including
it, only when that is the discounted fee. A reader that gave up waiting and
showed the fee as priced, or a close that says nothing about the reader, gives
the hold back: the row says what the driver saw. No door asked, nothing
re-priced.

**No door call is the last word.** The door commits in its own database before
this platform does, so every call that changes the module is preceded by a
record committed here — `claiming` before a claim, `releasing` before a release
— and neither is ever recorded as a discount. A rollback after the door
answered leaves one of them, and the close or the sweep gives it back:
releasing a claim that never landed is harmless, the door answers `none`.

**A release names the claim it gives back.** Those door calls happen outside
any lock here, so a release can reach the module after the same stay has
claimed again. Every claim is named by the attempt that made it (`--claim`),
a record keeps the names of the claims it may still hold, and a release names
those and nothing else; the module refuses to release a claim it no longer
holds (`already_superseded`). A late release cannot undo a newer claim.

**A hold no close takes is given back** through the module's door
(`release-in-store`), so a driver who entered a phone and then did not pay and
leave strands nothing: the validation is unclaimed again, live if its day has
not ended. The close gives back a hold it cannot take (the stay closed covered,
unpriced, at another fee, or the reader did not show it) — after it commits, so
a door that cannot answer leaves `releasing` for the sweep and never refuses a
close. `npm run release-validation-holds`, on a
schedule, gives back every hold still on an OPEN stay a hold window after the
claim (`VALIDATION_HOLD_MINUTES`, default 30), gives back a claim whose hold was
never stored, and finishes every release begun; the driver who comes back to the
reader enters the phone and claims again. A close that arrives after its hold
was given back records no discount, with a `validation_released_before_close`
event for a human.

**The phone number is never kept.** It goes to the door on stdin — never argv,
because argv is kept on the record — and into no column, event or log line;
the door's `phone_last4` is dropped from every answer before it is stored, and
a refused `phone` field names the field, not the value. The close takes no
phone at all.

A door that **could not decide** at the reader answers 5xx and nothing is held
(the record says `claiming`, and is given back);
a read that says `already_claimed` is asked on, because the claim it names may
be this stay's own from a claim whose hold was not stored — the module answers
that claim again. A door that **refused** holds nothing, with a
`validation_refused` event. The reconciler compares the engine's number with
the fee **without** the validation line.

`test/validations.test.js` runs against the real engine and a stand-in for the
door (`test/fixtures/validations-door`) that speaks the door's contract and
computes nothing; `npm run validations-fail-control` breaks each property in
turn.

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
