export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;
}

export function setTenantId(value: string | null): void;
export function newIdempotencyKey(): string;
export function request<T = unknown>(url: string, options?: {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  idempotencyKey?: string;
  body?: unknown;
}): Promise<T>;
