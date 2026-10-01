-- 0023 — tax on what the driver pays: the stay keeps its pre-tax subtotal.
--
-- The ledger's order is one order everywhere:
--
--   base lines  ->  the validation line  ->  the tax lines
--
-- and `fee_minor` is the running total. The tax lines are the engine's
-- (`POST /v1/tax`, `contract.run_tax` on the lane), taken on the SUBTOTAL --
-- the money the driver pays after any validation, before tax. A driver paying
-- nothing is charged no tax and carries no zero-valued tax line.
--
-- `subtotal_minor` is that subtotal, stored beside the fee. It is NULL for a
-- covered stay, for an unpriced one, and for every row closed before this
-- migration -- those were never taxed, and a number written onto them now
-- would be one nobody computed.
--
-- THE WRITE ASSERTS THE TWO AGREE: the subtotal plus the ledger's tax lines is
-- the fee. Tax lines are told by their code (`tax.applied`), never by their
-- position. A row on which they disagree is refused by this table, not
-- discovered later, so the stored number and the ledger cannot drift apart.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN subtotal_minor bigint CHECK (subtotal_minor >= 0);

-- The sum of a ledger's tax lines. IMMUTABLE so the CHECK below may call it:
-- it reads only its argument.
CREATE FUNCTION ledger_tax_minor(breakdown jsonb) RETURNS bigint
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT COALESCE(sum((line->>'delta_minor')::bigint), 0)::bigint
      FROM jsonb_array_elements(COALESCE(breakdown, '[]'::jsonb)) AS line
     WHERE line->>'code' = 'tax.applied'
  $$;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_subtotal_plus_tax_is_the_fee CHECK (
    subtotal_minor IS NULL
    OR (fee_minor IS NOT NULL
        AND breakdown IS NOT NULL
        AND subtotal_minor + ledger_tax_minor(breakdown) = fee_minor)
  );

COMMIT;
