import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
execFileSync(path.join(root,'node_modules/.bin/tsc'),['-b'],{cwd:root,stdio:'pipe'});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const {fetchNode}=await import(new URL('./runtime-node.mjs',import.meta.url));
const node=await fetchNode('darwin-arm64');
const sqliteVersion=JSON.parse(await fs.readFile(path.join(root,'node_modules/better-sqlite3/package.json'),'utf8')).version;
if(sqliteVersion!=='12.11.1')throw Error('Review and pin the new SQLite native runtime before packaging.');
const nativeSha='8855551fa9a93d7141c5ff2156dd418bde42f63c23255b309a5b29c7c77925e2';
const nativeUrl='https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v127-darwin-arm64.tar.gz';
const cache=path.join(root,'dist/business-cache');await fs.mkdir(cache,{recursive:true});
const nativePath=path.join(cache,'sqlite-node127-darwin-arm64.tar.gz');
let native=await fs.readFile(nativePath).catch(()=>null);
if(!native||sha(native)!==nativeSha){const r=await fetch(nativeUrl);if(!r.ok)throw Error(`SQLite native download HTTP ${r.status}`);native=Buffer.from(await r.arrayBuffer());if(sha(native)!==nativeSha)throw Error('Native runtime differs from the official release digest.');await fs.writeFile(nativePath,native);}
async function tree(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.name==='node_modules'||e.name==='dist'||e.name.startsWith('.'))continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await tree(p));else if(e.isFile())out.push(p);}return out.sort();}
const sourceFiles=[...await tree(path.join(root,'apps/business')),...await tree(path.join(root,'apps/api/src'))];
for(const e of await fs.readdir(path.join(root,'packages'),{withFileTypes:true})){if(e.isDirectory())sourceFiles.push(...await tree(path.join(root,'packages',e.name,'src')));}
const source=await Promise.all(sourceFiles.sort().map(async p=>({path:path.relative(root,p),sha256:sha(await fs.readFile(p))})));
const sourceSha256=sha(JSON.stringify(source)),version='1.0.0',buildId=`${version}-${sourceSha256.slice(0,12)}-darwin-arm64`;
const stage=path.join(root,'dist/business',`blacklabel-business-${buildId}`);await fs.mkdir(path.dirname(stage),{recursive:true});await fs.mkdir(stage,{recursive:false});
await build({entryPoints:[path.join(root,'apps/business/src/server.ts')],outfile:path.join(stage,'server.mjs'),platform:'node',format:'esm',target:'node22',bundle:true,
  external:['better-sqlite3'],banner:{js:"import {createRequire as __blacklabelRequire} from 'node:module';const require=__blacklabelRequire(import.meta.url);"},legalComments:'none',metafile:true});
await fs.cp(path.join(root,'apps/business/public'),path.join(stage,'public'),{recursive:true});
await fs.cp(path.join(root,'apps/business/package'),stage,{recursive:true});
await fs.mkdir(path.join(stage,'runtime/bin'),{recursive:true});await fs.copyFile(node.node,path.join(stage,'runtime/bin/node'));await fs.copyFile(node.license,path.join(stage,'runtime/NODE-LICENSE.txt'));
for(const name of ['better-sqlite3','bindings','file-uri-to-path']){
  const src=path.join(root,'node_modules',name),dest=path.join(stage,'node_modules',name);await fs.mkdir(dest,{recursive:true});
  const pkg=JSON.parse(await fs.readFile(path.join(src,'package.json'),'utf8'));await fs.writeFile(path.join(dest,'package.json'),JSON.stringify(pkg,null,2));
  for(const e of await fs.readdir(src,{withFileTypes:true})){if((name==='better-sqlite3'&&e.name==='lib')||e.isFile()&&(e.name.endsWith('.js')||/^licen[cs]e/i.test(e.name)))await fs.cp(path.join(src,e.name),path.join(dest,e.name),{recursive:true});}
}
execFileSync('/usr/bin/tar',['-xzf',nativePath,'-C',path.join(stage,'node_modules/better-sqlite3')]);
execFileSync(path.join(stage,'runtime/bin/node'),['--input-type=module','-e',`import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const D=require('better-sqlite3');const db=new D(':memory:');if(db.prepare('select 7 as n').get().n!==7)throw Error('SQLite check failed');db.close();`],{cwd:stage,stdio:'pipe'});
for(const p of ['runtime/bin/node','install.sh','start.sh'])await fs.chmod(path.join(stage,p),0o755);
async function payload(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await payload(p));else if(e.isFile())out.push(p);else throw Error('Package contains a non-file entry.');}return out.sort();}
const files=await Promise.all((await payload(stage)).map(async p=>{const b=await fs.readFile(p);return {path:path.relative(stage,p),bytes:b.length,sha256:sha(b)};}));
const manifest={brand:'BlackLabel',package:'business-platform',version,buildId,sourceSha256,target:'darwin-arm64',modules:['crm','scheduling','quoting','portal-customer','portal-employee','dashboard','messaging','reviews','workflows','billing','files','industries'],runtime:{node:node.version,nodeSha256:node.archiveSha256,sqlite:sqliteVersion,sqliteNativeSha256:nativeSha},customerDataIncluded:false,credentialsIncluded:false,files};
await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2));
const archive=`${stage}.tar.gz`;execFileSync('/usr/bin/tar',['-czf',archive,'-C',path.dirname(stage),path.basename(stage)]);
const bytes=await fs.readFile(archive),candidate={brand:'BlackLabel',buildId,archive,archiveSha256:sha(bytes),bytes:bytes.length,sourceSha256,status:'candidate',commercialAcceptance:'pending'};
await fs.writeFile(`${stage}.candidate.json`,JSON.stringify(candidate,null,2));console.log(JSON.stringify(candidate,null,2));
