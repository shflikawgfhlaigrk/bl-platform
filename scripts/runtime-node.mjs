import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const version = '22.23.2';
const hashes = {
  'darwin-arm64': '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
  'darwin-x64': '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
};
export async function fetchNode(target = 'darwin-arm64') {
  if (!hashes[target]) throw new Error(`No verified runtime pin for ${target}`);
  const cache = fileURLToPath(new URL(`../dist/business-cache/node-v${version}-${target}/`, import.meta.url));
  const archive = `${cache.slice(0, -1)}.tar.gz`;
  await fs.mkdir(path.dirname(archive), { recursive: true });
  let bytes = await fs.readFile(archive).catch(() => null);
  if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== hashes[target]) {
    const response = await fetch(`https://nodejs.org/dist/v${version}/node-v${version}-${target}.tar.gz`);
    if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== hashes[target]) throw new Error('Runtime archive checksum differs from the official pin.');
    await fs.writeFile(archive, bytes);
  }
  await fs.mkdir(cache, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', cache]);
  return { root: cache, version, target, archiveSha256: hashes[target], node: path.join(cache, 'bin/node'), license: path.join(cache, 'LICENSE') };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await fetchNode(process.argv[2]), null, 2));
