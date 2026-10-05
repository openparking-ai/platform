-- 0029 — who gets which alert, and how.
--
-- Per garage, the owner names the people to tell when something goes wrong:
-- each with a name, a phone number and/or an email address, and the language
-- to tell them in. For each alert, each person gets it by text, by email,
-- both or neither. The people have no account here and never sign in.
--
-- NOTHING IS SENT in this round. `confirmed` is false for everyone and stays
-- false until the alert module lands: before the first alert goes to a person
-- they will get one message asking them to confirm. This migration holds it
-- false, so nobody can be marked as having agreed to anything yet.
--
-- WHAT IS KEPT, AND HOW.
--   phone     `+` and 8 to 15 digits: a US number of 10 digits (or 11
--             starting with 1) is kept as +1..., any other as typed with its
--             own `+` (src/alerts.js turns what is typed into this)
--   email     trimmed, exactly one `@` with something either side, no space
--             and no invisible character, at most 254 characters
--   name      1 to 80 characters, no control or invisible formatting
--             character, no surrounding space (a lane name's rule, U4)
--   language  en or es, English unless said otherwise
-- At least one of phone or email. At most 25 people a garage.
--
-- THE CHOICES are kept on the person, as the alert keys they get by text and
-- by email (`by_text`, `by_email`). Which keys exist is the platform's ONE
-- list (src/alerts.js); this table holds what it is given. A text choice
-- needs a phone and an email choice needs an email, in the same row, so no
-- change can ever leave one without the other.
--
-- NOTHING TYPED ABOUT A PERSON ENTERS A LOG. A change-log line about a
-- person holds their id and what kind of change it was, never their name,
-- phone number, email address or any typed value; the log's read names them
-- from this table as they are now, or as removed (src/changes.js). Nothing
-- typed about them is written into the security log or the server's output
-- either (src/alerts.js). The log can only be added to, so it must never be
-- there to begin with: below, the change log refuses a name on a line about
-- a person.
--
-- Tenant-owned: docs/RLS_TEMPLATE.md.
--
-- Run as the database OWNER.

BEGIN;

CREATE TABLE alert_contacts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id  uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  phone      text,
  email      text,
  language   text        NOT NULL DEFAULT 'en',
  confirmed  boolean     NOT NULL DEFAULT false,
  by_text    text[]      NOT NULL DEFAULT '{}',
  by_email   text[]      NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_contacts_name_is_bounded CHECK (
    length(name) BETWEEN 1 AND 80
    AND name = btrim(name)
    AND name !~ '[\u0000-\u001f\u007f-\u009f­؜᠎​-‏ -‮⁠-⁯﻿￹-￻]'
  ),
  CONSTRAINT alert_contacts_phone_shape CHECK (phone IS NULL OR phone ~ '^\+[0-9]{8,15}$'),
  CONSTRAINT alert_contacts_email_shape CHECK (
    email IS NULL OR (
      length(email) BETWEEN 3 AND 254
      AND email ~ '^[^@]+@[^@]+$'
      AND email !~ '[[:space:]]'
      AND email !~ '[\u0000-\u001f\u007f- ­؜ ᠎ -‏ -  -⁯　﻿￹-￻]'
    )
  ),
  CONSTRAINT alert_contacts_reachable CHECK (phone IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT alert_contacts_language_is_known CHECK (language IN ('en', 'es')),
  -- Nothing is sent yet, so nobody has confirmed: the alert module lifts this.
  CONSTRAINT alert_contacts_not_confirmed_yet CHECK (confirmed = false),
  CONSTRAINT alert_contacts_choices_are_bounded CHECK (
    cardinality(by_text) <= 32 AND cardinality(by_email) <= 32
    AND array_position(by_text, NULL) IS NULL AND array_position(by_email, NULL) IS NULL
  ),
  CONSTRAINT alert_contacts_text_needs_phone CHECK (phone IS NOT NULL OR cardinality(by_text) = 0),
  CONSTRAINT alert_contacts_email_needs_email CHECK (email IS NOT NULL OR cardinality(by_email) = 0)
);

CREATE INDEX alert_contacts_tenant_id_idx ON alert_contacts (tenant_id);
CREATE INDEX alert_contacts_garage_idx ON alert_contacts (tenant_id, garage_id, created_at, id);

ALTER TABLE alert_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_contacts FORCE  ROW LEVEL SECURITY;

CREATE POLICY alert_contacts_tenant_isolation ON alert_contacts
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON alert_contacts TO openparking_app;

-- ---------------------------------------------------------------------------
-- A person is on a garage of their own account, and at most 25 a garage,
-- whoever writes the row.
--
-- The garage: a foreign key is checked without row-level security, so on
-- its own it would take another account's garage id. The trigger reads the
-- garage as the writer -- under the policy -- and refuses one that is not
-- the row's own account's.
--
-- The count: one garage's adds are taken one at a time (the same lock the
-- route takes before it counts), so two at once cannot both be the 25th. A
-- person moved to another garage counts there.
-- ---------------------------------------------------------------------------
CREATE FUNCTION alert_contacts_bounded() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_people integer;
  BEGIN
    IF TG_OP = 'UPDATE' AND NEW.garage_id = OLD.garage_id AND NEW.tenant_id = OLD.tenant_id THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM garages WHERE id = NEW.garage_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'alert_contacts_garage: a person is on a garage of their own account'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('alert-contacts|' || NEW.garage_id::text, 0));
    SELECT count(*) INTO v_people FROM alert_contacts WHERE garage_id = NEW.garage_id AND id <> NEW.id;
    IF v_people >= 25 THEN
      RAISE EXCEPTION 'alert_contacts_full: a garage has at most 25 people to tell'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER alert_contacts_at_most_25
  BEFORE INSERT OR UPDATE OF garage_id, tenant_id ON alert_contacts
  FOR EACH ROW EXECUTE FUNCTION alert_contacts_bounded();

-- ---------------------------------------------------------------------------
-- The change log can be about a person to tell -- by their id, never by
-- their name: the log's read names them as they are now.
-- ---------------------------------------------------------------------------
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'unknown'));
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_person_unnamed
  CHECK (subject_kind <> 'alert_contact' OR subject_name IS NULL);

COMMIT;
