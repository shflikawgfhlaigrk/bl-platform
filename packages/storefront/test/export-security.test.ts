import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportStaticSite } from '../src/export';
import { projectionOnlyDb, seedLiveProjection, fixtureItems } from './helpers';

describe('export filesystem boundary', () => {
  for (const slug of ['x/../../outside', 'x/../../../outside', 'x\\..\\outside']) {
    it(`rejects unsafe department path before cleaning or writing: ${slug}`, async () => {
      const db=await projectionOnlyDb();const root=await mkdtemp(join(tmpdir(),'store-export-boundary-'));const outDir=join(root,'level1','level2','export');
      try {
        const items=fixtureItems();items[0].departmentSlug=slug;
        const run=await seedLiveProjection(db,'tenant-fixture',items);
        await mkdir(outDir,{recursive:true});await writeFile(join(outDir,'keep.txt'),'preserve existing export');await writeFile(join(root,'outside.html'),'outside sentinel');
        await expect(exportStaticSite({db,tenantId:'tenant-fixture',publishRunId:run,outDir,runGates:false})).rejects.toThrow(/unsafe export path/i);
        expect(await readFile(join(root,'outside.html'),'utf8')).toBe('outside sentinel');
        expect(await readdir(outDir)).toEqual(['keep.txt']);
      } finally {await db.destroy();await rm(root,{recursive:true,force:true});}
    });
  }
  it('rejects caller-selected extra-asset traversal before cleaning',async()=>{
    const db=await projectionOnlyDb();const root=await mkdtemp(join(tmpdir(),'store-asset-boundary-'));const outDir=join(root,'level1','level2','export');
    try {
      const run=await seedLiveProjection(db,'tenant-fixture',fixtureItems());await mkdir(outDir,{recursive:true});await writeFile(join(outDir,'keep.txt'),'keep');await writeFile(join(root,'source'),'asset');
      await expect(exportStaticSite({db,tenantId:'tenant-fixture',publishRunId:run,outDir,runGates:false,extraAssets:[{sourcePath:join(root,'source'),destName:'../../outside'}]})).rejects.toThrow(/unsafe export path/i);
      expect(await readdir(outDir)).toEqual(['keep.txt']);
    }finally{await db.destroy();await rm(root,{recursive:true,force:true});}
  });
  it('rejects a nested destination symlink when preserving the output directory',async()=>{
    const db=await projectionOnlyDb();const root=await mkdtemp(join(tmpdir(),'store-link-boundary-'));const outDir=join(root,'level1','level2','export');
    try {
      const run=await seedLiveProjection(db,'tenant-fixture',fixtureItems());await mkdir(outDir,{recursive:true});await mkdir(join(root,'outside'));await symlink(join(root,'outside'),join(outDir,'assets'));
      await expect(exportStaticSite({db,tenantId:'tenant-fixture',publishRunId:run,outDir,clean:false,runGates:false})).rejects.toThrow(/unsafe export path/i);
      expect(await readdir(join(root,'outside'))).toEqual([]);
    }finally{await db.destroy();await rm(root,{recursive:true,force:true});}
  });
});
