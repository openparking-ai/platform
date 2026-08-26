# Data retention — an open decision, recorded as open

A number plate identifies a vehicle and, in practice, a person. In most
jurisdictions that makes it personal data, with obligations attached about how
long it is kept and why.

**No retention policy has been decided for Open Parking AI, and this file exists
so that absence is visible rather than accidental.** There is no purge job, no
expiry column and no anonymisation step in the schema today. That is a gap, not
a design.

## What is stored today

| Table | Personal data | Kept until |
|---|---|---|
| `vehicles` | `plate`, `plate_region`, first and last seen | deleted by hand |
| `sessions` | links a vehicle to times and a fee | deleted by hand |
| `events` | lane activity; `detail` may carry a plate and a confidence score | never — the table is append-only |

`events` deserves particular attention. It is deliberately append-only, enforced
by the grants rather than by convention, which is the right property for an
audit log and the wrong one for personal data with a retention limit. Those two
requirements will have to be reconciled — most likely by keeping the event rows
and redacting the personal fields out of `detail` on a schedule.

## What has to be decided

1. How long a `vehicle` row outlives its last session.
2. Whether a closed session keeps the plate, or points at an anonymised vehicle
   after some period.
3. How `events.detail` gets redacted given that the table takes no `UPDATE`
   grant — a redaction path will need its own privileged, audited route.
4. Which jurisdictions the answer has to satisfy.

Until those are answered, an operator running this software is responsible for
its retention behaviour, and should read the table above as the whole of it.

---

Built by 72 Knots Method by 72Knots.ai
