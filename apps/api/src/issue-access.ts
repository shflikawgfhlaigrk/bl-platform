/** Local owner command: write one expiring user credential to a private file. */
import { constants, existsSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDb } from '@blacklabel/db';
import { asCoreDb } from '@blacklabel/core';
import { identityCredentials } from './identity';
import type { PlatformDatabase } from './app';
const args=process.argv.slice(2);
const value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const tenantId=value('--tenant'), userId=value('--user'), output=value('--output');
if(!tenantId||!userId||!output) throw new Error('Required: --tenant TENANT_ID --user USER_ID --output PRIVATE_FILE');
const storage=path.resolve(process.env.PLATFORM_STORAGE_DIR??'.storage');
const dbPath=process.env.PLATFORM_DB_PATH??process.env.DB_PATH??path.join(storage,'platform.db');
if(!existsSync(dbPath)) throw new Error('Existing Platform database required');
let key:Buffer|string;
if(process.env.ADMIN_MASTER_KEY) key=process.env.ADMIN_MASTER_KEY;
else {
 const file=process.env.ADMIN_MASTER_KEY_FILE??path.join(storage,'admin.key');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const info=fstatSync(fd);
  if(!info.isFile()||info.nlink!==1||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077)!==0) throw new Error('A private owner key file is required');
  key=readFileSync(fd);
 } finally {closeSync(fd);}
}
const db=createDb<PlatformDatabase>(dbPath);
try {
 const user=await asCoreDb(db).selectFrom('users').select('id').where('tenant_id','=',tenantId).where('id','=',userId).executeTakeFirst();
 if(!user) throw new Error('User does not belong to the requested tenant');
 writeFileSync(path.resolve(output),identityCredentials(key).issue(tenantId,userId),{flag:'wx',mode:0o600});
 console.log('One-hour credential written to '+path.resolve(output));
} finally {await db.destroy();}
