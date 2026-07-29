import { describe, expect, it } from 'vitest';
import { REGISTERED_VIEW_IDS } from '../public/js/views/index.js';
import { DEFAULT_ROUTE, missingRoutes, parseHash, routeHash, routeIds, ROUTES } from '../public/src/routes.mjs';

describe('client operations routes', () => {
  it('registers every required operator view exactly once', () => {
    expect(routeIds()).toEqual([
      'overview',
      'products',
      'services',
      'workflows',
      'review-inbox',
      'integrations',
      'artifacts',
      'reports',
      'client-setup',
    ]);
    expect(missingRoutes(REGISTERED_VIEW_IDS)).toEqual([]);
    expect(new Set(REGISTERED_VIEW_IDS).size).toBe(ROUTES.length);
  });

  it('parses valid hashes and safely defaults unknown routes', () => {
    expect(parseHash('#/products')).toEqual({ route: 'products' });
    expect(parseHash('#/services')).toEqual({ route: 'services' });
    expect(parseHash('#/review-inbox?status=pending')).toEqual({ route: 'review-inbox' });
    expect(parseHash('#/missing')).toEqual({ route: DEFAULT_ROUTE });
    expect(parseHash('')).toEqual({ route: DEFAULT_ROUTE });
  });

  it('produces canonical route hashes', () => {
    expect(routeHash('products')).toBe('#/products');
    expect(routeHash('client-setup')).toBe('#/client-setup');
    expect(routeHash('unknown')).toBe('#/overview');
  });
});
