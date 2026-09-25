import type { MiddlewareHandler } from 'hono';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import * as path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

/** UI assets only. API routes, dotfiles, databases and backup bytes never use static delivery. */
export function privateStaticFiles(root: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/') || !['GET', 'HEAD'].includes(c.req.method)) return next();
    let decoded: string;
    try { decoded = decodeURIComponent(c.req.path); } catch { return c.text('Invalid path', 400); }
    if (decoded === '/api' || decoded.startsWith('/api/')) return next();
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(s => s.startsWith('.'))) return c.text('Forbidden', 403);
    const name = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (/\.(?:sqlite\d*|db)(?:-(?:wal|shm|journal))?$|\.(?:blbackup|backup|bak|dump|sql|key|pem|p12)$/i.test(name)) return c.text('Forbidden', 403);
    const mime = MIME[path.extname(name).toLowerCase()];
    if (!mime) return next();
    let file;
    try {
      const actualRoot = await realpath(root);
      const actual = await realpath(path.resolve(actualRoot, name));
      if (!actual.startsWith(actualRoot + path.sep)) return c.text('Forbidden', 403);
      file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await file.stat();
      if (!stats.isFile()) return c.text('Forbidden', 403);
      const header = Buffer.alloc(16); await file.read(header, 0, 16, 0);
      if (header.subarray(0, 15).toString() === 'SQLite format 3' || header.subarray(0, 8).toString() === 'BLBKP01\n') return c.text('Forbidden', 403);
      c.header('Content-Type', mime); c.header('Content-Length', String(stats.size));
      c.header('X-Content-Type-Options', 'nosniff');
      if (c.req.method === 'HEAD') return c.body(null);
      return c.body(new Uint8Array(await file.readFile()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return next();
      return c.text('Forbidden', 403);
    } finally { await file?.close(); }
  };
}
