/** Legacy workflow fixtures obtain real signed credentials before calling the real guard. */
import { getTenant, asCoreDb } from '@blacklabel/core';
import type { PlatformApp } from '../src/app';
export function authenticatedFixture(platform: PlatformApp): void {
  const request = platform.app.request.bind(platform.app);
  platform.app.request = (async (input: any, init?: RequestInit, ...rest: any[]) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const tenantId = headers.get('x-tenant-id');
    if (tenantId && !headers.has('authorization') && await getTenant(asCoreDb(platform.db), tenantId)) {
      const userId = headers.get('x-user-id') || (await platform.seedTenant(tenantId)).ownerUserId;
      headers.set('authorization', 'Bearer ' + await platform.issueCredential(tenantId,userId));
    }
    return request(input, {...init,headers}, ...rest);
  }) as typeof platform.app.request;
}
