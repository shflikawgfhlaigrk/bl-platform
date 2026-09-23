# User credentials

The assembled API requires a signed, tenant-bound user credential on private
routes. Missing headers do not select an owner or system actor. Removing the
user header keeps the authenticated user; a conflicting user/tenant header is
rejected. User membership and workforce session invalidation are checked on
every request. Roles remain database-controlled. Credentials expire after one
hour. Customer, employee, review and webhook endpoints retain their own specific
credentials; they receive no staff authority.

A local owner can issue a credential for an existing user, using the existing
private admin key and database (no new account or secret is generated):

```
node --import tsx apps/api/src/issue-access.ts --tenant TENANT_ID --user USER_ID --output /private/path/access.txt
```

The file is created exclusively with mode 0600; the credential is never logged.
The browser sign-in form accepts it, or a native client sends it in
`Authorization: Bearer ...`. Never put it in a URL. Browser credentials remain
in sessionStorage for the current tab. Signing out clears that tab; workforce
Invalidate All Sessions revokes outstanding credentials for the tenant. Queued
mutations are bound to the original user/tenant and do not cross sign-ins.

`OWNER_USER_ID` no longer bypasses authentication. Tests obtain real signed
synthetic credentials from a process-local issuer and exercise the same guards.
The files router accepts identity only from its configured authenticated-user
resolver; trusted direct service integrations may still explicitly pass
`SYSTEM_ACTOR` without exposing that authority over HTTP.
