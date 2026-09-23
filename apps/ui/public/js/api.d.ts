export interface ClientPrincipal { userId: string; tenantId: string; expiresAt: number }
export function setCredential(token: string, principal: ClientPrincipal): void;
export function clearCredential(): void;
export function sendRaw(m: {
  url: string; method?: string; body?: unknown; idempotencyKey?: string;
  principal?: Pick<ClientPrincipal, 'userId' | 'tenantId'> | null;
}): Promise<{ok: boolean; status: number; body: unknown}>;
