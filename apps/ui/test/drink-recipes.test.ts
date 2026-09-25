import { describe, expect, it } from 'vitest';
// Browser module shared with the actual iPad register.
// @ts-expect-error Plain browser JavaScript has no declaration file.
import { findDrinkRecipes } from '../public/js/drink-recipes.js';

describe('bartender guide lookup', () => {
  it('finds accented names with plain typing and narrows by alcohol family', () => {
    expect(findDrinkRecipes(' pina colada ').map((r: {name: string}) => r.name)).toEqual(['Piña Colada', 'Virgin Piña Colada']);
    expect(findDrinkRecipes('pina colada', 'No alcohol').map((r: {name: string}) => r.name)).toEqual(['Virgin Piña Colada']);
    expect(findDrinkRecipes('PINEAPPLE COCONUT', 'Rum').some((r: {name: string}) => r.name === 'Piña Colada')).toBe(true);
    expect(findDrinkRecipes('unknowningredientxyz')).toEqual([]);
  });
});
