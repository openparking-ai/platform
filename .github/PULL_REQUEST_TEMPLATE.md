## What this changes

<!-- One paragraph. What is different after this merges, and why. -->

## Checklist

- [ ] I have signed the CLA (`cla/signatures.json`). The `cla` check confirms it.
- [ ] No raw card data is handled anywhere in this change.
- [ ] Any new tenant-owned table follows `docs/RLS_TEMPLATE.md` — tenant column,
      `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, policy with both `USING` and
      `WITH CHECK`.
- [ ] Any new control has been observed failing when the thing it protects is
      removed. Say where, in the description above.

---

Built by 72 Knots Method by 72Knots.ai
