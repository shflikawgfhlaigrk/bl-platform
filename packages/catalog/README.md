# @blacklabel/catalog

Merchandising system of record for Mags Tack: departments, deterministic
category→department mapping (with an admin review queue), exact-safe brand
extraction, products/variations with **preserved Square source ids**, multi-
barcode normalization + UPC-A/EAN-13 checksum validation, price books with
deterministic scheduled-price resolution, promotions (core money math),
kits/bundles, publication/exclusion law, CSV bulk lanes, label data, and an
idempotent ledger import.

Everything is tenant-scoped, integer-cents, UTC-ISO, append-only where it
matters, and audited. See `/CONVENTIONS.md` and `/CONTRACTS-MAGS.md`.

## Events emitted

| Event | Payload |
|---|---|
| `catalog.variation.changed` | `{ v:1, variationId }` |
| `catalog.publication.changed` | `{ v:1, itemIds: string[] }` |

## Barcodes

- **Normalization** strips every non-digit (`"8 40300 30530 2"` → `"840300305302"`).
- **UPC-A (12)** and **EAN-13 (13)** check digits are validated with the standard
  mod-10 algorithms. Invalid codes are **still stored and searchable** — the live
  ledger has 442 hand-typed bad check digits; `checksum_valid = 0` flags them.
- **Symbology** is classified by normalized length: 12 → `upca`, 13 → `ean13`,
  other non-empty content → `code128`, empty → `unknown`.
- `lookupByCode` precedence: **normalized barcode exact** (ALL matches when a code
  is duplicated across variations — merge-tolerant) → **exact sku** → **name
  substring**. Duplicate normalized codes are queryable via `listBarcodeConflicts`.

## Department mapping rules

Deterministic keyword table in `mapping.ts` (`CATEGORY_RULES`), applied first-
match-wins to the source category name (case-insensitive substring). Order is
significant: specific rules precede generic ones (e.g. `Saddle Pads` →
`saddle-pads` before the generic `saddle`→`tack` rule; `Riding Boots` →
`footwear` before any boot rule). Unmatched or blank names → `needs_review`
(the admin queue).

Curated department tree (`DEPARTMENT_TREE`): `tack` (→ `saddle-pads`),
`horse-boots`, `blankets`, `grooming`, `health-care`, `apparel` (→ `footwear`),
`helmets-safety`, `accessories`, `barn-stable`, `toys-gifts`, `consignment`.

**Coverage vs the real ledger** (probed read-only from `~/MagsTack/ledger.db`):
the live catalog has **252 distinct non-empty category names** (the build prompt
said 412 — see Deviations). The rule table maps **246 / 252 (97.6%)**; the
remaining **6** (`Accessories`, `Kids casual clothes`, `Miscellaneous`,
`Shipping Costs`, `Verv Panels`, `Western`) are genuinely ambiguous and land in
`needs_review` on purpose.

| department | categories mapped |
|---|---|
| apparel | 92 |
| tack | 47 |
| accessories | 23 |
| toys-gifts | 19 |
| health-care | 15 |
| grooming | 11 |
| horse-boots | 10 |
| blankets | 9 |
| footwear | 6 |
| helmets-safety | 6 |
| barn-stable | 5 |
| saddle-pads | 2 |
| consignment | 1 |

## Brand extraction (exact-safe)

`extractBrand` matches the **leading token(s)** of a product name against
`BRAND_TABLE` (case-insensitive, **whole-token, prefix only**). It never
partial-token matches ("Lemieuxx" ≠ LeMieux) and never matches a brand mid-name.
Every brand in the table cleared `MIN_BRAND_ITEMS` (≥5) in the live ledger.
Ambiguous 2–3 letter internal codes (ERS, KL, HZ, RJ, …) and generic leading
words (Toy, Young, Mini, Leather, …) are **deliberately excluded**.

Brands (with live leading-token item counts): LeMieux (502, both casings), HKM
(480), Shires (178), Horze (120), Kudos (84), Equinavia (80), Arika (76),
Dapplebay (71), Lettia (64), Ovation (62), Jacks (59), TuffRider (61),
Aubrion (49), Majyk Equipe (28), Acavallo (26), Kismet (26), Henri de Rivel (23),
Heritage (21), Centaur (20), Epona (16), Romfh (13), Equitheme (13),
Nunn Finer (13), Fleck (12), Effol (12), Camelot (12), Bridleberry (12),
Farnam (11), Kunkle (10), Equinatura (10), Effax (10), Walsh (9), Cavallo (9),
Absorbine (9). (34 brands.)

## Exclusion law (public surfaces only)

Embedded from `~/MagsTack/tools/exclusions.json` (`EXCLUSION_RULES`), governing
customer-facing publication only — owner reports/ledger are never filtered.
Precedence (first match wins), all case-insensitive:

1. **DNU name prefix** → `dnu`
2. **`JPC Consignment` category** → `jpc_consignment`
3. **whole-word `JPC` name token** → `jpc_consignment` (word-boundary: `mujpc1`
   survives, `JPC belt` / `JPC-strap` are excluded)
4. **`consignment` name substring** → `consignment_name`

A product may be **published** only when: not excluded, has a department, and
has a price (or an explicit `allowUnpriced` flag). `price_cents = NULL` is an
honest "price not listed", never `0`.

## Deterministic price resolution

`resolvePrice(variationId, at)`: among **active** price-book entries (entry
window open AND its price book active + window open), pick the most specific —
a dated `effective_from` beats an open-ended one; tie → latest `effective_from`;
tie → `id`. Future-dated entries are not yet active. No active entry → the
variation's base price (may be `NULL`). Promotions (`resolvePromotedPrice`) apply
in-scope, in-window discounts via core `applyDiscount` and keep the lowest.

## Integrator wiring

- Mount `catalogRouter(deps)` at `/api/catalog`.
- Initial / incremental load: `importFromLedger(db, tenantId, rows, { events })`
  — **idempotent**, keyed on preserved Square source ids
  (`source_item_id`, `source_variation_id`) and `(variation, raw code)` for
  barcodes; re-running updates in place and never duplicates. Publication is
  never downgraded on re-run (owner-published stays published unless it becomes
  excluded by law).
- `buildImportPlan(rows)` is **pure** — inspect the full plan + stats
  (items / variations / skus / upcs / badCheckDigits / duplicateNormalizedUpcs /
  excluded / needsReviewCategories) before touching the DB.
- `rows` are ledger-shaped (`LedgerItem[]`): source ids, name, category, nested
  variations with `sku`, raw `upc`, `priceCents`. The tenant DB
  `~/MagsTack/platform/mags-tack.db` is written by the integrator, not here.

## Deviations from the build prompt

- The prompt's "412 source category names" does not match the live ledger, which
  has **252 distinct non-empty** `catalog_items.category_name` values (plus a
  blank/NULL bucket). Rules were written against the **real 252**; coverage
  stats above reflect that ground truth.
