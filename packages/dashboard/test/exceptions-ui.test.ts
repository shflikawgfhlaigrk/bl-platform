import { afterEach, describe, expect, it, vi } from 'vitest';
// Browser module has no DOM dependency until its view factory is called.
// @ts-expect-error authored browser JS is verified by these behavioral checks
import { exceptionQueueView, renderExceptionQueue } from '../../../apps/business/public/dashboard.js';

const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const ui={esc,when:(value:string)=>value,money:(value:number)=>`$${(value/100).toFixed(2)}`,panel:(title:string,body:string)=>`<section><h2>${esc(title)}</h2>${body}</section>`};
const queue=()=>({items:[],sources:[{kind:'overdue_balance',label:'Overdue balances',available:false,count:null,issue:'Source unavailable'}],total:0,limit:25,offset:0,hasMore:false,completeness:'partial',sampledAt:'2026-10-03T12:00:00.000Z',staleAt:'2026-10-03T12:05:00.000Z'});
afterEach(()=>vi.useRealTimers());

describe('owner exception UI',()=>{
  it('keeps missing sources unknown and never represents a partial empty queue as success',()=>{
    const html=renderExceptionQueue(queue(),ui);
    expect(html).toContain('categories were not checked');expect(html).toContain('Overdue balances · Unknown');
    expect(html).toContain('No exceptions in the categories checked. Review the unchecked sources above.');
    expect(html).toContain('External provider freshness is not verified.');
  });
  it('escapes record fields and shows balance/source timestamps and complete pagination',()=>{
    const data={...queue(),total:237,offset:25,hasMore:true,items:[{id:'quote:"unsafe',title:'<script>alert(1)</script>',status:'sent',reason:'Review <unsafe>',nextAction:'Inspect source',balanceCents:10501,attentionSince:null,source:{updatedAt:null,href:'#/billing'}}]};
    const html=renderExceptionQueue(data,ui,true);
    expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('Source updated: Unknown');
    expect(html).toContain('$105.01');expect(html).toContain('26–26 of 237');expect(html).toContain('data-exception-page="next"');expect(html).toContain('data-exception-page="previous"');
    expect(html).toContain('#/dashboard/reports');
  });
  it('marks the sampled queue stale after five minutes, and does not update an unrelated view',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
    const freshness={dataset:{sampledAt:queue().sampledAt},textContent:'fresh',setAttribute:vi.fn()};
    const category={value:'',onchange:null};
    const content={innerHTML:'',querySelector:(selector:string)=>selector==='[data-exception-kind]'?category:freshness,querySelectorAll:()=>[]};
    const view=exceptionQueueView({...ui,content,api:vi.fn().mockResolvedValue(queue()),say:vi.fn()});
    await view();await vi.advanceTimersByTimeAsync(300000);
    expect(freshness.textContent).toContain('now stale');expect(freshness.setAttribute).toHaveBeenCalledWith('role','status');
    await view();freshness.dataset.sampledAt='another-view';freshness.textContent='leave intact';await vi.runOnlyPendingTimersAsync();
    expect(freshness.textContent).toBe('leave intact');
  });
  it('keeps reports visible when an earlier exception request completes afterward',async()=>{
    let resolveQueue!:(value:ReturnType<typeof queue>)=>void;
    const request=new Promise<ReturnType<typeof queue>>(resolve=>{resolveQueue=resolve;});
    const content={innerHTML:'loading',querySelector:vi.fn(),querySelectorAll:vi.fn()};
    const reports=vi.fn(async()=>{content.innerHTML='Basic reports';});
    const view=exceptionQueueView({...ui,content,api:vi.fn().mockReturnValue(request),reports,say:vi.fn()});
    const pendingQueue=view();await view('reports');resolveQueue(queue());await pendingQueue;
    expect(content.innerHTML).toBe('Basic reports');expect(reports).toHaveBeenCalledOnce();
    expect(content.querySelector).not.toHaveBeenCalled();
  });
  it('reads the selected current source without mutating it or dumping private fields',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
    const item={id:'overdue_balance:invoice',kind:'overdue_balance',title:'INV-1',status:'sent',reason:'Overdue',nextAction:'Review',balanceCents:100,attentionSince:null,source:{api:'billing/invoices/invoice',href:'#/billing',updatedAt:null}};
    const data={...queue(),items:[item],total:1};
    const button={dataset:{exceptionInspect:item.id},disabled:false,isConnected:true,onclick:null as null|(()=>Promise<void>)};
    const target={dataset:{exceptionDetail:item.id},innerHTML:''};
    const content={innerHTML:'',querySelector:()=>({dataset:{},value:''}),querySelectorAll:(selector:string)=>selector==='[data-exception-inspect]'?[button]:selector==='[data-exception-detail]'?[target]:[]};
    const api=vi.fn().mockResolvedValueOnce(data).mockResolvedValueOnce({number:'INV-1',status:'paid',total_cents:100,paid_cents:100,updated_at:data.sampledAt,due_at:data.sampledAt,private_credentials:'never render this'});
    await exceptionQueueView({...ui,content,api,say:vi.fn()})();await button.onclick!();
    expect(api).toHaveBeenNthCalledWith(2,'billing/invoices/invoice');expect(target.innerHTML).toContain('paid');expect(target.innerHTML).toContain('$0.00');
    expect(target.innerHTML).not.toContain('private_credentials');expect(target.innerHTML).not.toContain('never render this');
  });
});
