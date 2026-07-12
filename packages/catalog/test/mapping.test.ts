import { describe, expect, it } from 'vitest';
import { evaluateExclusion, extractBrand, mapCategory, slugify } from '../src/mapping';

describe('deterministic category mapping', () => {
  it('maps known categories to departments (mapped)', () => {
    expect(mapCategory('Saddle Pads')).toMatchObject({ department: 'saddle-pads', status: 'mapped' });
    expect(mapCategory('Bridles')).toMatchObject({ department: 'tack', status: 'mapped' });
    expect(mapCategory('Riding Boots')).toMatchObject({ department: 'footwear', status: 'mapped' });
    expect(mapCategory('Grooming')).toMatchObject({ department: 'grooming', status: 'mapped' });
    expect(mapCategory('JPC Consignment')).toMatchObject({ department: 'consignment', status: 'mapped' });
  });
  it('routes unknown/ambiguous categories to needs_review', () => {
    expect(mapCategory('Miscellaneous')).toMatchObject({ department: null, status: 'needs_review' });
    expect(mapCategory('Western')).toMatchObject({ department: null, status: 'needs_review' });
    expect(mapCategory('')).toMatchObject({ status: 'needs_review', ruleName: 'unmapped_empty' });
  });
  it('is order-sensitive: "Saddle Pads" beats the generic saddle→tack rule', () => {
    expect(mapCategory('Saddle Pads').department).toBe('saddle-pads');
    expect(mapCategory('Saddle Covers').department).toBe('blankets');
  });
});

describe('exact-safe brand extraction', () => {
  it('extracts a leading known brand', () => {
    expect(extractBrand('LeMieux Saddle Pad')).toEqual({ name: 'LeMieux', slug: 'lemieux' });
    expect(extractBrand('TuffRider Breeches')).toEqual({ name: 'TuffRider', slug: 'tuffrider' });
    expect(extractBrand('Henri de Rivel Bridle')).toEqual({ name: 'Henri de Rivel', slug: 'henri-de-rivel' });
  });
  it('is case-insensitive on the prefix token', () => {
    expect(extractBrand('lemieux pad')).toEqual({ name: 'LeMieux', slug: 'lemieux' });
  });
  it('never partial-token matches (exact-safe)', () => {
    expect(extractBrand('Lemieuxx Knockoff')).toBeNull();
    expect(extractBrand('Nice LeMieux Pad')).toBeNull(); // brand not at prefix
    expect(extractBrand('Shiresman Thing')).toBeNull();
    expect(extractBrand('')).toBeNull();
  });
});

describe('owner exclusion law (word-boundary JPC)', () => {
  it('excludes the real z_DNU naming pattern as dnu (underscore is a boundary)', () => {
    expect(evaluateExclusion('z_DNU Old Halter', 'Halters')).toEqual({ excluded: true, reason: 'dnu' });
    expect(evaluateExclusion('Z_dnu-legacy strap', 'Straps')).toEqual({ excluded: true, reason: 'dnu' });
  });

  it('does NOT exclude names merely containing dnu inside a word', () => {
    expect(evaluateExclusion('Dnubuck Halter', 'Halters')).toEqual({ excluded: true, reason: 'dnu' }); // prefix rule still applies
    expect(evaluateExclusion('Grand Nubuck dnux strap', 'Straps')).toEqual({ excluded: false, reason: null });
  });

  it('does NOT exclude a SKU fragment like "mujpc1"', () => {
    expect(evaluateExclusion('mujpc1 belt', 'Belts')).toEqual({ excluded: false, reason: null });
  });
  it('excludes a whole-word JPC token', () => {
    expect(evaluateExclusion('JPC belt', 'Belts')).toEqual({ excluded: true, reason: 'jpc_consignment' });
    expect(evaluateExclusion('cool JPC-strap', 'Belts')).toEqual({ excluded: true, reason: 'jpc_consignment' });
  });
  it('excludes a DNU name prefix', () => {
    expect(evaluateExclusion('DNU-strap', 'Belts')).toEqual({ excluded: true, reason: 'dnu' });
    expect(evaluateExclusion('DNU old stock', 'Belts')).toEqual({ excluded: true, reason: 'dnu' });
  });
  it('excludes the JPC Consignment category', () => {
    expect(evaluateExclusion('Anything', 'JPC Consignment')).toEqual({
      excluded: true,
      reason: 'jpc_consignment',
    });
  });
  it('excludes a "consignment" name substring', () => {
    expect(evaluateExclusion('Vendor consignment lot', 'Belts')).toEqual({
      excluded: true,
      reason: 'consignment_name',
    });
  });
});

describe('slugify', () => {
  it('produces url-safe slugs', () => {
    expect(slugify('Horse Boots & Wraps')).toBe('horse-boots-wraps');
    expect(slugify('Henri de Rivel')).toBe('henri-de-rivel');
  });
});
