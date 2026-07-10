import { describe, expect, it } from 'vitest';
import { ApiError, parseFilters, parsePagination, parseSort } from '@blacklabel/core';

describe('parsePagination', () => {
  it('defaults to limit 50 offset 0', () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
  });

  it('clamps limit to [1, maxLimit] and offset to >= 0', () => {
    expect(parsePagination({ limit: '999999' })).toEqual({ limit: 200, offset: 0 });
    expect(parsePagination({ limit: '-5' })).toEqual({ limit: 1, offset: 0 });
    expect(parsePagination({ offset: '-10' })).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: '25', offset: '75' })).toEqual({ limit: 25, offset: 75 });
  });

  it('falls back on garbage input', () => {
    expect(parsePagination({ limit: 'abc', offset: 'xyz' })).toEqual({ limit: 50, offset: 0 });
  });

  it('honors custom defaults', () => {
    expect(parsePagination({}, { defaultLimit: 10, maxLimit: 20 })).toEqual({
      limit: 10,
      offset: 0,
    });
    expect(parsePagination({ limit: '99' }, { maxLimit: 20 })).toEqual({ limit: 20, offset: 0 });
  });
});

describe('parseSort', () => {
  const allowed = ['name', 'created_at'];

  it('parses plain, -prefixed and :desc forms', () => {
    expect(parseSort({ sort: 'name' }, allowed)).toEqual({ column: 'name', direction: 'asc' });
    expect(parseSort({ sort: '-created_at' }, allowed)).toEqual({
      column: 'created_at',
      direction: 'desc',
    });
    expect(parseSort({ sort: 'name:desc' }, allowed)).toEqual({
      column: 'name',
      direction: 'desc',
    });
  });

  it('returns the fallback when no sort param is present', () => {
    expect(parseSort({}, allowed)).toBeUndefined();
    expect(parseSort({}, allowed, { column: 'created_at', direction: 'desc' })).toEqual({
      column: 'created_at',
      direction: 'desc',
    });
  });

  it('throws ApiError 400 for non-whitelisted columns', () => {
    try {
      parseSort({ sort: 'password' }, allowed);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
    }
  });
});

describe('parseFilters', () => {
  it('extracts only whitelisted, non-empty params', () => {
    const query = { status: 'open', owner: '', secret: 'x', limit: '10' };
    expect(parseFilters(query, ['status', 'owner', 'missing'])).toEqual({ status: 'open' });
  });
});
