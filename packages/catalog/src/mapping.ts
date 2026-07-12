import type { ExclusionReason } from './schema';

/**
 * Deterministic catalog mapping rules — pure, dependency-free, documented.
 * These are derived from the REAL Mags Tack ledger category names and item
 * name prefixes (probed read-only from ~/MagsTack/ledger.db). See README.md
 * for the full rationale and coverage stats.
 */

/** URL-safe slug: lowercase, non-alphanumerics → single hyphen, trimmed. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/* ------------------------------------------------------------------ *
 * Curated department tree
 * ------------------------------------------------------------------ */

export interface DepartmentSeed {
  slug: string;
  name: string;
  /** Parent slug, or null for a root department. */
  parent: string | null;
  sort: number;
}

/** The curated department tree seeded on first import. */
export const DEPARTMENT_TREE: DepartmentSeed[] = [
  { slug: 'tack', name: 'Tack', parent: null, sort: 10 },
  { slug: 'saddle-pads', name: 'Saddle Pads', parent: 'tack', sort: 11 },
  { slug: 'horse-boots', name: 'Horse Boots & Wraps', parent: null, sort: 20 },
  { slug: 'blankets', name: 'Blankets & Sheets', parent: null, sort: 30 },
  { slug: 'grooming', name: 'Grooming', parent: null, sort: 40 },
  { slug: 'health-care', name: 'Health & Care', parent: null, sort: 50 },
  { slug: 'apparel', name: 'Rider Apparel', parent: null, sort: 60 },
  { slug: 'footwear', name: 'Footwear', parent: 'apparel', sort: 61 },
  { slug: 'helmets-safety', name: 'Helmets & Safety', parent: null, sort: 70 },
  { slug: 'accessories', name: 'Rider Accessories', parent: null, sort: 80 },
  { slug: 'barn-stable', name: 'Barn & Stable', parent: null, sort: 90 },
  { slug: 'toys-gifts', name: 'Toys & Gifts', parent: null, sort: 100 },
  { slug: 'consignment', name: 'Consignment', parent: null, sort: 110 },
];

/* ------------------------------------------------------------------ *
 * Deterministic category → department rules (first match wins)
 * ------------------------------------------------------------------ */

export interface CategoryRule {
  /** Stable rule name, recorded on every mapping decision. */
  name: string;
  /** Lowercase substrings; the category name matching ANY of them wins. */
  keywords: string[];
  department: string;
}

/**
 * Ordered rule set. ORDER MATTERS: more specific rules come first so that,
 * e.g., "Saddle Pads" resolves to saddle-pads before the generic "saddle"
 * tack rule, and "Riding Boots" resolves to footwear before any boot rule.
 * A category matching no rule stays `needs_review`.
 */
export const CATEGORY_RULES: CategoryRule[] = [
  { name: 'consignment_category', keywords: ['jpc consignment'], department: 'consignment' },
  { name: 'saddle_pads', keywords: ['saddle pad', 'half pad'], department: 'saddle-pads' },
  {
    name: 'footwear',
    keywords: ['riding boot', 'paddock boot', 'barn boot', 'barn shoe', 'shoes'],
    department: 'footwear',
  },
  {
    name: 'horse_boots_wraps',
    keywords: [
      'horse boot',
      'bell boot',
      'fly boot',
      'hoof boot',
      'polo wrap',
      'exercise horse boot',
      'shipping wrap',
      'stable and shipping',
      'boots & wraps',
      'boots and wraps',
      'garter',
    ],
    department: 'horse-boots',
  },
  {
    name: 'blankets_sheets',
    keywords: ['blanket', 'sheet', 'cooler', 'turnout', 'saddle cover'],
    department: 'blankets',
  },
  {
    name: 'helmets_safety',
    keywords: ['helmet', 'safety', 'protection vest', 'protective', 'nose filter'],
    department: 'helmets-safety',
  },
  {
    name: 'tack',
    keywords: [
      'bridle',
      'rein',
      'bit',
      'halter',
      'lead rope',
      'leadrope',
      'girth',
      'stirrup',
      'leather',
      'browband',
      'noseband',
      'martingale',
      'breastplate',
      'saddle',
      'lunge',
      'lunging',
      'training tack',
      'ear bonnet',
      'ear plug',
      'hair net',
      'hobby horse',
      'crop',
      'whip',
      'bat',
      'spur',
      'jodhpur strap',
      'bucket strap',
      'stock tie',
    ],
    department: 'tack',
  },
  {
    name: 'grooming',
    keywords: [
      'grooming',
      'brush',
      'shampoo',
      'conditioner',
      'braiding',
      'hoof pick',
      'hoof',
      'main and tail',
      'body brush',
      'shine spray',
      'detangler',
      'hair tonic',
      'snood',
    ],
    department: 'grooming',
  },
  {
    name: 'health_care',
    keywords: [
      'first aid',
      'liniment',
      'poultice',
      'supplement',
      'fly spray',
      'fly mask',
      'fly boots',
      'chemical',
      'wormer',
      'bacterial wash',
      'sticky spray',
      'leather cleaner',
      'grazing muzzle',
      'ointment',
      'treat',
      'stud',
    ],
    department: 'health-care',
  },
  {
    name: 'apparel',
    keywords: [
      'shirt',
      'breeches',
      'tights',
      'jacket',
      'outerwear',
      'vest',
      'sock',
      'underwear',
      'pajama',
      'hoodie',
      'sweater',
      'sweat shirt',
      'fleece',
      'polo',
      'sun shirt',
      'sunshirt',
      'coat',
      'rain',
      'pants',
      'jogger',
      'shorts',
      'dress',
      'bib',
      'jodhpur',
      'turtle neck',
      'half chap',
      'long underwear',
      'loungewear',
      'base layer',
      'pull on',
      'zip',
      'zips',
      'sleeveless',
      'soft shell',
      'waterproof',
      'glove',
      'snood shirt',
    ],
    department: 'apparel',
  },
  {
    name: 'toys_gifts',
    keywords: [
      'stuffed animal',
      'toy pony',
      'tiny pony',
      'toy puppy',
      'toy rider',
      'horse toy',
      'horse pomm',
      'gift',
      'ornament',
      'book',
      'bow',
      'christmas',
      'pinney',
      'pinny',
      'sticker',
      'stationary',
    ],
    department: 'toys-gifts',
  },
  {
    name: 'barn_stable',
    keywords: [
      'stable supplies',
      'hay net',
      'hanging hook',
      'trailer',
      'misc tack',
      'safety',
    ],
    department: 'barn-stable',
  },
  {
    name: 'accessories',
    keywords: [
      'belt',
      'jewelry',
      'bag',
      'backpack',
      'hat',
      'cap',
      'watch',
      'towel',
      'cup',
      'tumbler',
      'home goods',
      'snood',
      'hat silk',
      'dog accessor',
    ],
    department: 'accessories',
  },
];

export interface CategoryDecision {
  department: string | null;
  status: 'mapped' | 'needs_review';
  ruleName: string;
}

/**
 * Map a raw source category name to a department slug deterministically.
 * Empty/blank names and no-rule-match names return `needs_review`.
 */
export function mapCategory(sourceCategoryName: string | null | undefined): CategoryDecision {
  const name = (sourceCategoryName ?? '').trim().toLowerCase();
  if (name === '') {
    return { department: null, status: 'needs_review', ruleName: 'unmapped_empty' };
  }
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => name.includes(kw))) {
      return { department: rule.department, status: 'mapped', ruleName: rule.name };
    }
  }
  return { department: null, status: 'needs_review', ruleName: 'unmapped' };
}

/* ------------------------------------------------------------------ *
 * Exact-safe brand extraction (name prefix)
 * ------------------------------------------------------------------ */

/** Minimum item count a brand must clear to be trusted (probed from ledger). */
export const MIN_BRAND_ITEMS = 5;

interface BrandSeed {
  name: string;
  /** Lowercase leading token(s); a product name whose leading tokens equal this phrase is that brand. */
  prefix: string[];
}

/**
 * Curated known-brand table. Every entry cleared MIN_BRAND_ITEMS in the live
 * ledger. Matching is EXACT and whole-token (prefix only) — never a partial
 * token — so "LeMieux" matches "LeMieux Saddle Pad" but never "Lemieuxx" or a
 * mid-name occurrence. Ambiguous 2–3 letter internal codes (ERS, KL, HZ, …)
 * and generic leading words (Toy, Young, Mini, Leather, …) are DELIBERATELY
 * excluded to keep extraction honest.
 */
export const BRAND_TABLE: BrandSeed[] = [
  { name: 'LeMieux', prefix: ['lemieux'] },
  { name: 'HKM', prefix: ['hkm'] },
  { name: 'Shires', prefix: ['shires'] },
  { name: 'Horze', prefix: ['horze'] },
  { name: 'Kudos', prefix: ['kudos'] },
  { name: 'Equinavia', prefix: ['equinavia'] },
  { name: 'Arika', prefix: ['arika'] },
  { name: 'Dapplebay', prefix: ['dapplebay'] },
  { name: 'Lettia', prefix: ['lettia'] },
  { name: 'Ovation', prefix: ['ovation'] },
  { name: 'Jacks', prefix: ['jacks'] },
  { name: 'TuffRider', prefix: ['tuffrider'] },
  { name: 'Aubrion', prefix: ['aubrion'] },
  { name: 'Acavallo', prefix: ['acavallo'] },
  { name: 'Kismet', prefix: ['kismet'] },
  { name: 'Centaur', prefix: ['centaur'] },
  { name: 'Epona', prefix: ['epona'] },
  { name: 'Romfh', prefix: ['romfh'] },
  { name: 'Equitheme', prefix: ['equitheme'] },
  { name: 'Fleck', prefix: ['fleck'] },
  { name: 'Effol', prefix: ['effol'] },
  { name: 'Effax', prefix: ['effax'] },
  { name: 'Camelot', prefix: ['camelot'] },
  { name: 'Bridleberry', prefix: ['bridleberry'] },
  { name: 'Farnam', prefix: ['farnam'] },
  { name: 'Kunkle', prefix: ['kunkle'] },
  { name: 'Equinatura', prefix: ['equinatura'] },
  { name: 'Walsh', prefix: ['walsh'] },
  { name: 'Cavallo', prefix: ['cavallo'] },
  { name: 'Absorbine', prefix: ['absorbine'] },
  { name: 'Heritage', prefix: ['heritage'] },
  { name: 'Majyk Equipe', prefix: ['majyk'] },
  { name: 'Henri de Rivel', prefix: ['henri'] },
  { name: 'Nunn Finer', prefix: ['nunn'] },
];

export interface BrandDecision {
  name: string;
  slug: string;
}

/**
 * Extract a brand from a product name using the exact-safe prefix rule.
 * Tokenizes on whitespace and compares the leading token(s) to each brand's
 * prefix phrase (case-insensitive, whole-token). Returns null when no brand's
 * full prefix phrase leads the name.
 */
export function extractBrand(productName: string | null | undefined): BrandDecision | null {
  const tokens = (productName ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  for (const brand of BRAND_TABLE) {
    if (brand.prefix.length > tokens.length) continue;
    let matches = true;
    for (let i = 0; i < brand.prefix.length; i += 1) {
      if (tokens[i] !== brand.prefix[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return { name: brand.name, slug: slugify(brand.name) };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Owner-directed exclusions (exclusions.json semantics, embedded)
 * ------------------------------------------------------------------ */

/**
 * The exclusion law from ~/MagsTack/tools/exclusions.json, embedded so the pure
 * function is deterministic and testable on synthetic rows. Rules are
 * case-insensitive. Token matching is WHOLE-WORD (whitespace/hyphen separated)
 * so a SKU fragment like "mujpc1" is NOT a JPC token and survives.
 */
export const EXCLUSION_RULES = {
  categoryNames: ['jpc consignment'],
  namePrefixes: ['dnu'],
  // 'dnu' as a whole word catches the real 'z_DNU …' naming pattern (129 items
  // in the live ledger) that the bare prefix rule misses; probed 2026-07-12:
  // prefix 2,065 + z_dnu 129 = all 2,194 DNU names, zero other patterns.
  dnuTokens: ['dnu'],
  nameSubstrings: ['consignment'],
  nameTokens: ['jpc'],
} as const;

export interface ExclusionDecision {
  excluded: boolean;
  reason: ExclusionReason | null;
}

/** Split a name into whole words on whitespace, hyphen, or underscore boundaries. */
function words(name: string): string[] {
  return name.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
}

/**
 * Decide whether a product is excluded from public/customer surfaces, and why.
 * Owner reports/ledger are never filtered — this governs public surfaces only.
 * Precedence (first match wins): DNU name prefix, JPC category, JPC name token,
 * "consignment" name substring.
 */
export function evaluateExclusion(
  productName: string | null | undefined,
  sourceCategoryName: string | null | undefined,
): ExclusionDecision {
  const name = (productName ?? '').trim();
  const category = (sourceCategoryName ?? '').trim().toLowerCase();
  const lowerName = name.toLowerCase();

  if (EXCLUSION_RULES.namePrefixes.some((p) => lowerName.startsWith(p))) {
    return { excluded: true, reason: 'dnu' };
  }
  const earlyWords = words(name);
  if (EXCLUSION_RULES.dnuTokens.some((t) => earlyWords.includes(t))) {
    return { excluded: true, reason: 'dnu' };
  }
  if ((EXCLUSION_RULES.categoryNames as readonly string[]).includes(category)) {
    return { excluded: true, reason: 'jpc_consignment' };
  }
  const nameWords = earlyWords;
  if (EXCLUSION_RULES.nameTokens.some((t) => nameWords.includes(t))) {
    return { excluded: true, reason: 'jpc_consignment' };
  }
  if (EXCLUSION_RULES.nameSubstrings.some((s) => lowerName.includes(s))) {
    return { excluded: true, reason: 'consignment_name' };
  }
  return { excluded: false, reason: null };
}
