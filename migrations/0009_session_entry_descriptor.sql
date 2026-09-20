-- 0009 — a session carries the appearance descriptor its entry read produced.
--
-- The exit module (E1) matches an exiting car to a STAY, and the search it runs
-- compares one descriptor against the descriptors of every open stay in the
-- garage. Until now nothing on this platform held one: the lane's identity
-- service can produce a descriptor per read (vehicle-id, `identity.descriptor`,
-- opt-in and off by default), the lane dropped it on translation, and this
-- route destructured only the keys it knew and silently ignored the rest.
--
-- WHAT IT IS. An opaque, versioned, compact string — `opvid-fp/<version>:…` —
-- computed from one capture: a bounded set of keypoint descriptors, a colour
-- histogram and a coarse edge grid, after a fixed resize. Not an image, and a
-- photograph cannot be reconstructed from it. This platform does not parse it:
-- what is checked at the route is that it is a string, not blank, and not
-- larger than the bound in src/app.js. Versions are the identity service's
-- business, and two descriptors of different versions do not compare THERE.
--
-- WHY A DESCRIPTOR AND NOT A PICTURE. A garage with two entry lanes has its
-- entry pictures on two different boxes, neither the exit lane's; and a stay
-- older than the image retention has no picture at all, which would make every
-- monthly parker unmatchable by construction. A descriptor is a short string
-- and survives that.
--
-- NULLABLE, AND THAT IS THE COMPATIBILITY RULE. A lane that has the descriptor
-- switched off — the default — sends none, and every row written before this
-- migration has none. NULL means NOT MEASURED, exactly as it does on the wire.
-- No default, because a default would be a claim that something was measured.
--
-- IT IS IDENTITY, AND RETENTION REACHES IT. It describes one specific car's
-- appearance, so it is personal data on the same terms the plate is, and the
-- purge nulls it on the same window, under the same never-redact rules, in the
-- same run (src/retention.js). The identity service's own `redacted()` drops it
-- with the rest of the identity for the same reason.
--
-- ON THE SESSION, NOT THE VEHICLE. A vehicle row is one identity; a descriptor
-- is one READ, and the same car reads differently on a different day, in
-- different light, from a different lane. The search compares against stays,
-- keyed on the session, so this is where it lives. The exit's descriptor gets
-- its own column when the close carries it (3.0c); it is not this migration.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN entry_descriptor text;

COMMIT;
