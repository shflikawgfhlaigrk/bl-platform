import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

/**
 * Throw ApiError from services/routers; the shared errorHandler turns it into
 * the canonical error envelope: { error: { message, code, details } }.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, message: string, code = 'error', details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details: unknown = null): ApiError {
    return new ApiError(400, message, 'bad_request', details);
  }

  static unauthorized(message = 'unauthorized'): ApiError {
    return new ApiError(401, message, 'unauthorized');
  }

  static forbidden(message = 'forbidden'): ApiError {
    return new ApiError(403, message, 'forbidden');
  }

  static notFound(message = 'not found'): ApiError {
    return new ApiError(404, message, 'not_found');
  }

  static conflict(message: string, details: unknown = null): ApiError {
    return new ApiError(409, message, 'conflict', details);
  }
}

/**
 * Shared Hono error handler. Register once per app/router:
 *   app.onError(errorHandler);
 */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      { error: { message: err.message, code: err.code, details: err.details } },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: { message: 'validation failed', code: 'validation_error', details: err.issues } },
      400,
    );
  }
  console.error('[unhandled]', err);
  return c.json({ error: { message: 'internal error', code: 'internal', details: null } }, 500);
};
