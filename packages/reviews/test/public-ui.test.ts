import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../../../apps/business/public/review.js', import.meta.url), 'utf8');
const platforms = [{ name: 'Honest public review', url: 'https://example.test/reviews' }];
async function page(state: Record<string, unknown>, rating = 1) {
  const content = { innerHTML: '', textContent: '', querySelectorAll: () => [] }, notice = { textContent: '', className: '' };
  const form: any = {}, optOut: any = {};
  const fetch = vi.fn(async (path: string, _init?: { body?: string }) => ({ ok: true, json: async () => ({ data: path.endsWith('/submit')
    ? { message: 'Thank you for honest feedback.', platforms } : state }) }));
  runInNewContext(script, { document: { querySelector: (selector: string) => ({ '#review-content': content, '#notice': notice, '#review-form': form, '#opt-out': optOut }[selector]) },
    location: { hash: '#abcdefghijklmnopqrstuvwxabcdefghijklmnopqrst' }, fetch,
    FormData: class { [Symbol.iterator]() { return [['rating', String(rating)], ['comment', 'My experience']][Symbol.iterator](); } } });
  await new Promise(resolve => setImmediate(resolve));
  return { content, form, fetch };
}

describe('customer review page', () => {
  it.each([1, 2, 3, 4, 5])('makes the public link available before and after a %i-star private rating', async rating => {
    const f = await page({ submitted: false, optedOut: false, status: 'clicked', platforms }, rating);
    expect(f.content.innerHTML).toContain('href="https://example.test/reviews"');
    expect(f.content.innerHTML.indexOf('href=')).toBeLessThan(f.content.innerHTML.indexOf('<select'));
    await f.form.onsubmit({ preventDefault() {}, currentTarget: {} });
    expect(f.content.innerHTML).toContain('href="https://example.test/reviews"');
    expect(f.content.innerHTML).toContain('Feedback recorded');
    expect(JSON.parse(f.fetch.mock.calls[1][1]!.body!).rating).toBe(rating);
  });
  it('keeps the same link visible on completed and opted-out revisits', async () => {
    for (const state of [{ submitted: true, status: 'completed' }, { optedOut: true, status: 'opted_out' }]) {
      const f = await page({ ...state, platforms });
      expect(f.content.innerHTML).toContain('href="https://example.test/reviews"');
      expect(f.content.innerHTML).not.toContain('<select');
    }
  });
});
