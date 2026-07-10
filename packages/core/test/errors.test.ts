import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, errorHandler } from '@blacklabel/core';

function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.get('/api-error', () => {
    throw ApiError.conflict('already exists', { key: 'dup' });
  });
  app.get('/zod-error', () => {
    z.object({ n: z.number() }).parse({ n: 'not a number' });
    return new Response('unreachable');
  });
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  return app;
}

describe('errorHandler', () => {
  it('maps ApiError to its status with the canonical envelope', async () => {
    const res = await makeApp().request('/api-error');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: { message: 'already exists', code: 'conflict', details: { key: 'dup' } },
    });
  });

  it('maps ZodError to 400 validation_error with issues', async () => {
    const res = await makeApp().request('/zod-error');
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('maps unknown errors to 500 without leaking the message', async () => {
    const res = await makeApp().request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('kaboom');
  });
});
