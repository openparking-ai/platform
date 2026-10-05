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
--             character, no surrounding space (a lane name's rule, U4);
--             and never a phone number or email address: no @ and at most
--             6 digits of any script, read after normalisation
--   language  en or es, English unless said otherwise
-- At least one of phone or email. At most 25 people a garage.
--
-- THE CHOICES are kept on the person, as the alert keys they get by text and
-- by email (`by_text`, `by_email`). Which keys exist is the platform's ONE
-- list (src/alerts.js); this table holds what it is given. A text choice
-- needs a phone and an email choice needs an email, in the same row, so no
-- change can ever leave one without the other.
--
-- A PERSON'S DETAILS NEVER ENTER A LOG. The change log names the person and
-- says what changed; their phone number and email address are never written
-- into it, the security log or the server's output (src/alerts.js). The log
-- can only be added to, so they must never be there to begin with.
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
  -- A name is written into the change log, which can only be added to: no
  -- phone number or email address may get through in one, however it is
  -- written. After compatibility normalisation (full-width, circled and
  -- similar digits become plain ones; a full-width @ becomes @): no @, and
  -- at most 6 decimal digits of any script in all, whatever stands between
  -- them. The digits are src/digits.js's table, the route's own.
  CONSTRAINT alert_contacts_name_holds_no_contact CHECK (
    strpos(normalize(name, NFKC), '@') = 0
    AND length(regexp_replace(normalize(name, NFKC), '[^\u0030-\u0039\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0DE6-\u0DEF\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u1090-\u1099\u17E0-\u17E9\u1810-\u1819\u1946-\u194F\u19D0-\u19D9\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\uA620-\uA629\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uA9F0-\uA9F9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19\U000104A0-\U000104A9\U00010D30-\U00010D39\U00010D40-\U00010D49\U00011066-\U0001106F\U000110F0-\U000110F9\U00011136-\U0001113F\U000111D0-\U000111D9\U000112F0-\U000112F9\U00011450-\U00011459\U000114D0-\U000114D9\U00011650-\U00011659\U000116C0-\U000116C9\U000116D0-\U000116D9\U000116DA-\U000116E3\U00011730-\U00011739\U000118E0-\U000118E9\U00011950-\U00011959\U00011BF0-\U00011BF9\U00011C50-\U00011C59\U00011D50-\U00011D59\U00011DA0-\U00011DA9\U00011DE0-\U00011DE9\U00011F50-\U00011F59\U00016130-\U00016139\U00016A60-\U00016A69\U00016AC0-\U00016AC9\U00016B50-\U00016B59\U00016D70-\U00016D79\U0001CCF0-\U0001CCF9\U0001D7CE-\U0001D7D7\U0001D7D8-\U0001D7E1\U0001D7E2-\U0001D7EB\U0001D7EC-\U0001D7F5\U0001D7F6-\U0001D7FF\U0001E140-\U0001E149\U0001E2F0-\U0001E2F9\U0001E4F0-\U0001E4F9\U0001E5F1-\U0001E5FA\U0001E950-\U0001E959\U0001FBF0-\U0001FBF9]', '', 'g')) <= 6
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
-- The change log can name a person to tell (by their name only).
-- ---------------------------------------------------------------------------
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'unknown'));

COMMIT;
