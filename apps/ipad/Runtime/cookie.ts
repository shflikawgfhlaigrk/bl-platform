// Browser Request/Response objects strip Cookie and Set-Cookie headers.
// The in-process Hono request carries a private session slot instead. Only
// the transport closure loads/saves it, using the native Keychain bridge.
export function getCookie(c: any, name: string) {
  return c.req.raw.barOneSession?.[name];
}
export function setCookie(c: any, name: string, value: string, _options?: unknown) {
  c.req.raw.barOneSessionUpdate = { name, value };
}
export function deleteCookie(c: any, name: string, _options?: unknown) {
  c.req.raw.barOneSessionUpdate = { name, value: '' };
}
