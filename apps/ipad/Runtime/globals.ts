import { Buffer } from 'buffer';
// The browser Buffer package predates Node's base64url encoding, used by
// existing POS session tokens. Keep byte-for-byte token compatibility.
const originalToString = Buffer.prototype.toString;
Buffer.prototype.toString = function (encoding?: any, ...args: any[]) {
  if (encoding === 'base64url') return originalToString.call(this, 'base64', ...args).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return originalToString.call(this, encoding, ...args);
};
const originalFrom = Buffer.from;
Buffer.from = function (value: any, encoding?: any, ...args: any[]) {
  return originalFrom(value, encoding === 'base64url' ? 'base64' : encoding, ...args);
} as typeof Buffer.from;
export { Buffer };
