# Data retention

**The decision:** the running system stores real vehicle identity, and keeps it
for a limited, configurable time.

Vehicle ID is the product. A parking platform that cannot recognise a vehicle
cannot open a gate for it, price its stay, or tell one car from another — so the
database holds the plate, the make, the model, the colour and whatever else the
lane read, tenant-scoped under row-level security like everything else.

What is kept for a limited time is *transient* identity: the vehicles that
simply parked and left. What persists is *enrolled* identity: a vehicle holding
a monthly, a pass or another standing credential, for as long as it holds it.

## The window

| | |
|---|---|
| Default | **30 days** after the stay closes |
| Configurable | per tenant, `tenant_settings.vehicle_retention_days` |
| Bounds | 1 to 3650 days |
| Enforced by | `scripts/purge-vehicles.js`, run on a schedule |

The default lives in the column default and nowhere else, so there is exactly
one place it can be wrong.

## Redaction, not deletion

The purge **redacts**; it does not delete. That is not squeamishness, it is a
foreign key: `sessions.vehicle_id` references `vehicles` with `ON DELETE
CASCADE`, so deleting a vehicle would take with it every parking session it ever
had — and therefore the financial record of every stay it paid for.

Removing personal data must not destroy the books. So the row survives and
everything identifying is replaced:

```
plate         -> 'redacted:<row id>'   (keeps the unique index satisfied, carries nothing)
ticket_ref    -> 'redacted:<row id>'   (the same, for a stay identified by a ticket)
plate_region  -> NULL
make          -> NULL
model         -> NULL
color         -> NULL
attributes    -> {}
redacted_at   -> when it happened
```

**Added with migration 0007:** a vehicle is identified by a plate **or** a
ticket reference — exactly one, enforced by `vehicles_exactly_one_identity` —
and a ticket is personal data on the same terms a plate is. It is a code minted
for one arrival, read out over an intercom or carried on a downloadable ticket,
and it identifies a stay for as long as it exists. So it ages out on the **same
window**, under the **same never-redact rules**, in the same statement. The
redaction writes the placeholder into whichever of the two columns the row
carries and leaves the other NULL: filling both would violate the exactly-one
constraint and fail the whole purge, and filling neither would leave the ticket
as the one identity retention could not remove. `test/retention.test.js` asserts
the redaction and carries the control that a ticket inside the window is left
alone.

**Added with migration 0008:** the same constraint also refuses an identity that
is an EMPTY STRING in either column. `'' IS NULL` is false, so 0007's XOR alone
counted a blank as an identity and a direct `INSERT` could write a row that had
one in name only. The placeholder the purge writes — `redacted:<row id>` — is 45
characters, so redaction satisfies the stronger constraint exactly as it
satisfied the weaker one; nothing about the window, the rules or the statement
changes.

**Added with migration 0009:** a session may carry the **appearance descriptor**
its entry read produced (`sessions.entry_descriptor`) — an opaque string that
describes one specific car's appearance, which makes it personal data on the
same terms the plate is. It lives on the session rather than the vehicle,
because a descriptor is one *read* and not an identity, so it is reached by a
second statement in the same run: nulled on every session of every vehicle the
run redacts, and on no other.

```
sessions.entry_descriptor -> NULL   (on the sessions of the vehicles redacted above)
sessions.exit_descriptor  -> NULL   (the same car read a second time, at the exit — migration 0010)
```

`test/entry-descriptor.test.js` and `test/exit-descriptor.test.js` assert the
redaction and carry the control that a stay inside the window keeps both.

**Added with migration 0011:** `shadow_searches` and the `shadow_search` event
hold **session ids, counts and verdicts** — never a descriptor and never a
plate. The descriptors they refer to live on `sessions`, where the purge
reaches them. A shadow row **ages out with the stay it shadowed**: when the
purge redacts that stay's vehicle it nulls the row's session references and
keeps the figure —

```
shadow_searches.session_id     -> NULL
shadow_searches.candidate_ids  -> NULL
shadow_searches.matched_ids    -> NULL
shadow_searches.redacted_at    -> when it happened
(outcome, counts, true_stay_comparable, true_stay_matched, thresholds: kept)
```

— so a report run after the window still counts every exit and what the search
said about it, and cannot say which stay any of it was about. The candidate
lists of *younger* rows keep their ids: the stays they point at persist,
redacted, and each row ages on its own stay's window. `test/shadow.test.js`
asserts the redaction with the control that a row inside the window keeps its
references, and that the report is unchanged by the purge.

**Still open, and now one more instance of it:** the `shadow_search` event
carries session ids in `events.detail`, which is append-only by grant and
outside the purge — the same open item as the plate in `events.detail`.

The session keeps its times and its fee. `test/retention.test.js` asserts
exactly that, because it is the property most likely to be broken by someone
later deciding deletion is tidier.

**Added with migration 0013:** `sessions.breakdown` (the engine's ledger lines),
`sessions.pricing_refusal` (its findings) and `sessions.space_class` (the
garage's) describe a price, not a person or a car; the purge leaves them where
they are, as it leaves `fee_minor`.

**Added with migration 0012:** `rate_plans` holds a garage's rate plan
documents and nothing about a person or a car. The purge does not touch it, and
`test/rate-plans.test.js` asserts the table is byte-identical across a run in
which the purge redacted a vehicle. The `rate_plan_stored` event beside it names
an operator token, not a person, and is append-only like every event.

## What is never redacted

- **Enrolled vehicles**, while enrolled.
- **A vehicle still inside a garage** — a car that has not left cannot have its
  identity removed out from under the session it is in.
- **Anything inside the retention window**, which the tests control for
  explicitly rather than assuming.

## Known gap: the event log

`events` is append-only, enforced by the grants — the application role has no
`UPDATE` and no `DELETE`. That is the right property for an audit log and the
wrong one for personal data with a retention limit, and the two have not been
reconciled yet.

`events.detail` can carry a plate. It is not redacted today, and the purge does
not touch it. Closing this needs a privileged, audited redaction path that does
not hand the application a general power to rewrite history. **Recorded as open,
not as done.**

## No real data in this repository

Separate rule, same spirit. The repository — code, docs, tests, fixtures —
contains only invented values. No real plate, no real address, nothing about a
real person or a real vehicle.

Enforced, not remembered:

| Guard | What it does |
|---|---|
| `.github/scripts/check-no-real-data.js` | fails CI on real-looking data in any tracked file |
| `.github/scripts/check-commit-emails.js` | fails CI on a real address in commit metadata or a co-author trailer |

Both self-test before they report: each plants something it ought to catch and
requires the catch. A guard nobody has watched fail is not known to work.

---

Built by 72 Knots Method by 72Knots.ai
