import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const runtime = path.join(root, 'apps/ipad/Runtime');
const output = path.join(root, 'apps/ipad/Resources/Register');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp('apps/ui/public', output, { recursive: true });
const guard = `const unavailable = () => { throw new Error('This filesystem operation requires the native iPad storage adapter'); };`;
const result = await build({ entryPoints: [path.join(runtime, 'entry.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'safari17',
  outfile: path.join(output, 'runtime.js'), inject: [path.join(runtime, 'globals.ts')], metafile: true,
  plugins: [{ name: 'native-platform', setup(b) {
    b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: path.join(runtime, 'crypto.ts') }));
    b.onResolve({ filter: /^hono\/cookie$/ }, () => ({ path: path.join(runtime, 'cookie.ts') }));
    b.onResolve({ filter: /^\.\/admin-wiring$/ }, args => args.importer.endsWith('/apps/api/src/app.ts') ? { path: path.join(runtime, 'admin-wiring.ts') } : null);
    b.onLoad({ filter: /packages\/db\/src\/index\.ts$/ }, async args => ({ loader: 'ts', contents: (await readFile(args.path, 'utf8'))
      .replace("import SqliteDatabase from 'better-sqlite3';", 'const SqliteDatabase: any = class { constructor() { throw new Error("Use native SQLite on iPad"); } };') }));
    b.onResolve({ filter: /^node:(fs|fs\/promises|path)$/ }, args => ({ path: args.path, namespace: 'native-unused' }));
    b.onLoad({ filter: /.*/, namespace: 'native-unused' }, args => ({ contents: args.path === 'node:path'
      ? `export const sep='/'; export const join=(...parts)=>parts.join('/').replace(/\\/+/g,'/'); export const resolve=join; export const dirname=p=>p.slice(0,p.lastIndexOf('/')); export const basename=p=>p.split('/').pop(); export const extname=p=>p.includes('.')?'.'+p.split('.').pop():'';`
      : guard + 'export const mkdir=unavailable, readFile=unavailable, unlink=unavailable, writeFile=unavailable, access=unavailable, copyFile=unavailable, rm=unavailable, open=unavailable, createReadStream=unavailable, createWriteStream=unavailable;' }));
  }}],
});
let html = await readFile(path.join(output, 'index.html'), 'utf8');
html = html.replace('<body>', '<body data-pos-profile="bar" data-native-pos="true">')
  .replace('It stays entirely on this computer.', 'Your register is stored on this iPad.')
  .replace('<script type="module" src="./js/app.js"></script>', '<script src="./runtime.js"></script><script src="./ui.js" defer></script>');
await writeFile(path.join(output, 'index.html'), html);
// A single UI bundle also avoids custom-scheme cross-origin module loading.
await build({ entryPoints: ['apps/ui/public/js/app.js'], bundle: true, platform: 'browser', format: 'iife', target: 'safari17', outfile: path.join(output, 'ui.js'), plugins: [{name:'browser-root-imports', setup(b) { b.onResolve({filter: /^(?:\.\.\/)+src\//}, args => ({path: path.join(root, 'apps/ui/public/src', path.basename(args.path))})); }}] });
await writeFile(path.join(output, 'runtime-manifest.json'), JSON.stringify({ version: 12, sourceFiles: Object.keys(result.metafile.inputs), runtime: 'native-sqlite', remoteServer: false }, null, 2));
console.log(`Bundled POS engine and UI in ${output}`);
