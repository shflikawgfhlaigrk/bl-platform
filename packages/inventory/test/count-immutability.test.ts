import { describe, it, expect } from 'vitest';
import { setImmediate as tick } from 'node:timers/promises';
import { setup, headers } from './helpers';
import { createLocation, applyMovement, openCountSession, addCountLine, recordCount, recordRecount, approveCountLine, closeCountSession, setCountSessionStatus, getCountSession, getStock } from '../src/service';

async function fixture(){
 const s=await setup();const loc=await createLocation(s.db,s.tenantA.id,'operator',{name:'Fixture',kind:'warehouse'});
 await applyMovement(s.db,s.events,s.tenantA.id,'operator',{variationId:'v1',locationId:loc.id,delta:10,reason:'received'});
 const session=await openCountSession(s.db,s.tenantA.id,'operator',{locationId:loc.id,kind:'full',recountThreshold:20});
 const line=await addCountLine(s.db,s.tenantA.id,'operator',session.id,'v1');await recordCount(s.db,s.tenantA.id,'operator',session.id,line.id,8);
 return {...s,loc,session,line};
}
async function snapshot(s:Awaited<ReturnType<typeof fixture>>){
 return {session:await getCountSession(s.db,s.tenantA.id,s.session.id),lines:await s.db.selectFrom('inventory_count_lines').selectAll().execute(),movements:await s.db.selectFrom('inventory_movements').selectAll().execute()};
}
describe('count sign-off immutability',()=>{
 for(const action of ['count','recount','approve','add','reopen'] as const){
  it(`rejects ${action} after closure with byte-identical signed evidence and ledger`,async()=>{
   const s=await fixture();try{
    await closeCountSession(s.db,s.events,s.tenantA.id,'operator',s.session.id,'manager');const before=await snapshot(s);
    const args=[s.db,s.tenantA.id,'operator',s.session.id,s.line.id] as const;
    const attempt=action==='count'?recordCount(...args,99):action==='recount'?recordRecount(...args,99):action==='approve'?approveCountLine(...args):action==='add'?addCountLine(s.db,s.tenantA.id,'operator',s.session.id,'v2'):setCountSessionStatus(s.db,s.tenantA.id,'operator',s.session.id,'open');
    await expect(attempt).rejects.toMatchObject({status:409});expect(await snapshot(s)).toEqual(before);
   }finally{await s.db.destroy();}
  });
 }
 it('HTTP combined line patch preserves normal review, then rejects every closed write',async()=>{
  const s=await fixture();try{
   const path=`/count-sessions/${s.session.id}/lines/${s.line.id}`;
   const patch=(body:object,tenant=s.tenantA)=>s.app.request(path,{method:'PATCH',headers:headers(tenant),body:JSON.stringify(body)});
   expect((await patch({countedQty:6,recountQty:7,approved:true})).status).toBe(200);
   await closeCountSession(s.db,s.events,s.tenantA.id,'operator',s.session.id,'manager');const before=await snapshot(s);
   for(const body of [{countedQty:99},{recountQty:99},{approved:true},{countedQty:99,recountQty:98,approved:true}])expect((await patch(body)).status).toBe(409);
   expect((await patch({countedQty:99},s.tenantB)).status).toBe(404);expect(await snapshot(s)).toEqual(before);
  }finally{await s.db.destroy();}
 });
});

// Hold a completed count-line read, including reads inside a transaction, so
// the competing closure can be scheduled at the original vulnerable boundary.
function pauseLineRead(db:any,method='executeTakeFirst'){
 let reachedResolve!:()=>void,releaseResolve!:()=>void,paused=false;
 const reached=new Promise<void>(r=>reachedResolve=r),released=new Promise<void>(r=>releaseResolve=r);
 function builder(b:any):any{return new Proxy(b,{get(t,k){const v=Reflect.get(t,k,t);if(typeof v!=='function')return v;return (...a:any[])=>{
  if(k===method)return v.apply(t,a).then(async(result:any)=>{if(!paused){paused=true;reachedResolve();await released;}return result;});
  const result=v.apply(t,a);return result&&typeof result.where==='function'?builder(result):result;
 };}});}
 function wrap(d:any):any{return new Proxy(d,{get(t,k){
  if(k==='selectFrom')return (table:string)=>table==='inventory_count_lines'?builder(t.selectFrom(table)):t.selectFrom(table);
  if(k==='transaction')return ()=>({execute:(fn:any)=>t.transaction().execute((trx:any)=>fn(wrap(trx)))});
  const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;
 }});}
 return {db:wrap(db),reached,release:()=>releaseResolve()};
}
describe('count close serialization',()=>{
 it('a write already holding the session lock completes before close snapshots its evidence',async()=>{
  const s=await fixture();const gate=pauseLineRead(s.db);let update:any,close:any;
  try{
   update=recordCount(gate.db,s.tenantA.id,'operator',s.session.id,s.line.id,7);await gate.reached;
   let closed=false;close=closeCountSession(s.db,s.events,s.tenantA.id,'operator',s.session.id,'manager').then(r=>{closed=true;return r;});
   await tick();await tick();const closedBeforeRelease=closed;gate.release();await Promise.all([update,close]);
   expect(closedBeforeRelease).toBe(false);expect((await getStock(s.db,s.tenantA.id,{variationId:'v1'}))[0].onHand).toBe(7);
   const state=await snapshot(s);expect(state.session.status).toBe('closed');expect(state.lines[0].counted_qty).toBe(7);
  }finally{gate.release();await Promise.allSettled([update,close]);await s.db.destroy();}
 });
 it('closure holding the lock finishes before a late write, which must reject',async()=>{
  const s=await fixture();const gate=pauseLineRead(s.db,'execute');let close:any,update:any;
  try{
   close=closeCountSession(gate.db,s.events,s.tenantA.id,'operator',s.session.id,'manager');await gate.reached;
   update=recordRecount(s.db,s.tenantA.id,'operator',s.session.id,s.line.id,99);const outcome=update.then(()=>({accepted:true}),(e:{status?:number})=>({accepted:false,status:e.status}));
   gate.release();await close;expect(await outcome).toEqual({accepted:false,status:409});
   const state=await snapshot(s);expect(state.lines[0].recount_qty).toBeNull();expect(state.session.status).toBe('closed');
   expect((await getStock(s.db,s.tenantA.id,{variationId:'v1'}))[0].onHand).toBe(8);
  }finally{gate.release();await Promise.allSettled([update,close]);await s.db.destroy();}
 });
});
