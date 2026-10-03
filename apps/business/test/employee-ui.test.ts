import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error authored browser JS is verified by these behavioral checks
import { employeeView } from '../public/employee.js';

type FormNode={id:string;handler?: (body:Record<string,string>)=>unknown;value:string;closest:()=>{remove:()=>void};scrollIntoView:()=>void};
function fixture(){
  let html='',forms:FormNode[]=[],buttons:any[]=[];
  const content:any={onclick:null,querySelector:(selector:string)=>forms.find(node=>selector.startsWith(`#${node.id}`))??null,
    querySelectorAll:(selector:string)=>selector==='[data-employee-page]'?buttons:[],
    insertAdjacentHTML:(_position:string,value:string)=>{
      html+=value;
      for(const [,id] of value.matchAll(/<form id="([^"]+)"/g)){
        const node:FormNode={id,value:'',closest:()=>({remove:()=>{forms=forms.filter(item=>item!==node);}}),scrollIntoView:vi.fn()};forms.push(node);
      }
      for(const [,key,attributes] of value.matchAll(/data-employee-page="([^"]+)"([^>]*)/g))buttons.push({dataset:{employeePage:key},disabled:attributes.includes('disabled')});
    }};
  Object.defineProperty(content,'innerHTML',{get:()=>html,set:(value:string)=>{html=value;forms=[];buttons=[];}});
  const summary={pending:120,approved:230,rejected:1,open:0};
  const entries=[{id:'time-a',employee_name:'Crew A',assignment_id:'older-job',clock_in_at:'2026-01-01T00:00:00Z',clock_out_at:'2026-01-01T01:00:00Z',duration_minutes:60,review_status:'pending'},
    {id:'time-b',employee_name:'Crew B',assignment_id:null,clock_in_at:'2026-01-02T00:00:00Z',clock_out_at:'2026-01-02T01:00:00Z',duration_minutes:60,review_status:'pending'}];
  const api=vi.fn(async(route:string,_method?:string,_body?:unknown)=>{
    if(route.startsWith('portal-employee/time-entries?'))return {summary,items:entries};
    if(route.startsWith('portal-employee/assignments?'))return Array.from({length:51},(_,i)=>({id:`work-${i}`,title:`Work ${i}`,status:'assigned'}));
    if(route==='portal-employee/assignments/older-job')return {id:'older-job',title:'Verified older work'};
    return {};
  });
  const esc=(value:unknown)=>String(value??'');
  const panel=(title:string,body:string)=>`<section class="panel"><h2>${title}</h2>${body}</section>`;
  const form=(id:string,title:string,body:string)=>panel(title,`<form id="${id}">${body}</form>`);
  const table=(rows:any[],columns:any[],actions?:(row:any)=>string)=>rows.map(row=>columns.map(([,get]:any[])=>typeof get==='function'?get(row):row[get]).join(' ')+(actions?.(row)??'')).join('\n');
  const bindForm=(id:string,handler:(body:Record<string,string>)=>unknown)=>{const node=forms.find(form=>form.id===id);if(!node)throw Error(`Missing ${id}`);node.handler=handler;};
  let view:()=>Promise<void>;
  const say=vi.fn();
  view=employeeView(async()=>{content.innerHTML='';},{api,content,panel,form,table,esc,bindForm,say,render:()=>view(),when:esc,field:()=>'',select:()=>'',action:(name:string,id:string,label:string)=>`<button data-action="${name}" data-id="${id}">${label}</button>`});
  const click=(action:string,id:string)=>content.onclick({target:{closest:()=>({dataset:{action,id},disabled:false})}});
  return {view,api,content,summary,entries,say,click,forms:()=>forms,buttons:()=>buttons};
}

describe('employee owner review UI',()=>{
  it('shows pending time first and looks up linked work beyond the closeout page',async()=>{
    const f=fixture();await f.view();
    expect(f.api).toHaveBeenCalledWith('portal-employee/time-entries?limit=50&offset=0&status=pending');
    expect(f.api).toHaveBeenCalledWith('portal-employee/assignments/older-job');
    expect(f.content.innerHTML).toContain('Verified older work');expect(f.content.innerHTML).toContain('data-id="older-job">Open linked work');
    expect(f.content.innerHTML).toContain('of 120');
  });
  it('pages older time and work independently, then resets time pagination on a review filter change',async()=>{
    const f=fixture();await f.view();await f.buttons().find(button=>button.dataset.employeePage==='time-next').onclick();
    expect(f.api).toHaveBeenCalledWith('portal-employee/time-entries?limit=50&offset=50&status=pending');
    await f.buttons().find(button=>button.dataset.employeePage==='work-next').onclick();
    expect(f.api).toHaveBeenCalledWith('portal-employee/assignments?limit=51&offset=50');
    await f.forms().find(form=>form.id==='employee-time-filter')!.handler!({status:'rejected'});await f.view();
    expect(f.api).toHaveBeenCalledWith('portal-employee/time-entries?limit=50&offset=0&status=rejected');
  });
  it('replaces the previous review and submits only the most recently selected time entry',async()=>{
    const f=fixture();await f.view();await f.click('employee-review','time-a');await f.click('employee-review','time-b');
    const reviews=f.forms().filter(form=>form.id==='employee-time-review');expect(reviews).toHaveLength(1);
    await reviews[0].handler!({status:'approved',note:'Verified against work'});
    expect(f.api).toHaveBeenCalledWith('portal-employee/time-entries/time-b/review','POST',{status:'approved',note:'Verified against work'});
    expect(f.api.mock.calls.some(([route,method])=>route==='portal-employee/time-entries/time-a/review'&&method==='POST')).toBe(false);
    await f.click('employee-review','missing');expect(f.say).toHaveBeenCalledWith(expect.stringContaining('Refresh before reviewing'),true);
    expect(f.forms().filter(form=>form.id==='employee-time-review')).toHaveLength(1);
  });
  it('backs out of an empty final time page after review removes the last matching entry',async()=>{
    const f=fixture();await f.view();await f.buttons().find(button=>button.dataset.employeePage==='time-next').onclick();
    f.summary.pending=0;f.entries.splice(0);await f.view();
    expect(f.api).toHaveBeenLastCalledWith('portal-employee/time-entries?limit=50&offset=0&status=pending');
    expect(f.content.innerHTML).toContain('0–0 of 0');
    expect(f.buttons().find(button=>button.dataset.employeePage==='time-next').disabled).toBe(true);
    expect(f.api.mock.calls.filter(([route])=>route==='portal-employee/time-entries?limit=50&offset=0&status=pending').length).toBeGreaterThan(1);
  });
});
