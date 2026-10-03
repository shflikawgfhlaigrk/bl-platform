/** Owner closeout/review controls augment the existing team administration view. */
export function employeeView(existing, ui) {
  const { api, content, panel, table, action, form, field, select, bindForm, render, say, esc, when } = ui;
  const pageSize=50;
  let timeStatus='pending',timeOffset=0,workStatus='',workOffset=0;
  return async (...args) => {
    await existing(...args);
    const timeRoute=()=>`portal-employee/time-entries?limit=${pageSize}&offset=${timeOffset}${timeStatus?`&status=${timeStatus}`:''}`;
    let [queue, workPage] = await Promise.all([api(timeRoute()), api(`portal-employee/assignments?limit=${pageSize+1}&offset=${workOffset}${workStatus?`&status=${workStatus}`:''}`)]);
    const timeTotal=timeStatus?queue.summary[timeStatus]:queue.summary.pending+queue.summary.approved+queue.summary.rejected;
    if(timeOffset>=timeTotal&&timeOffset){timeOffset=Math.max(0,Math.floor((timeTotal-1)/pageSize)*pageSize);queue=await api(timeRoute());}
    if(!workPage.length&&workOffset){workOffset=Math.max(0,workOffset-pageSize);workPage=await api(`portal-employee/assignments?limit=${pageSize+1}&offset=${workOffset}${workStatus?`&status=${workStatus}`:''}`);}
    const work=workPage.slice(0,pageSize),byId=new Map(work.map(row=>[row.id,row]));
    const missing=[...new Set(queue.items.map(row=>row.assignment_id).filter(id=>id&&!byId.has(id)))];
    await Promise.all(missing.map(async id=>{
      try {byId.set(id,await api(`portal-employee/assignments/${encodeURIComponent(id)}`));}
      catch(error){if(error.status!==404)throw error;}
    }));
    const workName=entry=>entry.assignment_id?byId.get(entry.assignment_id)?.title||'Linked assignment unavailable':'General shift';
    const pager=(kind,offset,count,more,total)=>`<div class="actions"><button type="button" class="quiet" data-employee-page="${kind}-previous" ${offset?'':'disabled'}>Previous ${kind==='time'?'time entries':'work'}</button><span class="muted">${count?offset+1:0}–${offset+count}${total===undefined?'':` of ${total}`}</span><button type="button" class="quiet" data-employee-page="${kind}-next" ${more?'':'disabled'}>Next ${kind==='time'?'time entries':'work'}</button></div>`;
    content.insertAdjacentHTML('beforeend', panel('Time approval', `<p>Review clocked-out time against the recorded work before job closeout. Record a reason for every approval or rejection.</p><p class="muted">${queue.summary.pending} pending · ${queue.summary.approved} approved · ${queue.summary.rejected} rejected · ${queue.summary.open} still clocked in. Counts cover the company. Page through every matching entry below.</p>`
      +form('employee-time-filter','Review state',select('status','Show time entries',[['pending','Pending review'],['rejected','Rejected — follow-up needed'],['approved','Approved'],['','All review states']],false),'Apply review filter')
      + table(queue.items, [['Team member','employee_name'],['Work',workName],['Started',r=>when(r.clock_in_at)],['Minutes',r=>r.duration_minutes??'Open'],['Review','review_status'],['Reason','review_note']], r=>(r.clock_out_at?action('employee-review',r.id,'Review time'):'Clock out first')+(r.assignment_id&&byId.has(r.assignment_id)?action('employee-closeout',r.assignment_id,'Open linked work'):''))
      +pager('time',timeOffset,queue.items.length,timeOffset+queue.items.length<timeTotal,timeTotal))
      + panel('Work closeout', `<p class="muted">Open work to see unfinished checklist items, reported exceptions, and time awaiting review.</p>`
      +form('employee-work-filter','Work status',select('status','Show work',[['','All work'],['assigned','Assigned'],['in_progress','In progress'],['completed','Completed'],['canceled','Canceled']],false),'Apply work filter')
      +table(work,[['Work','title'],['Status','status'],['Completed',r=>when(r.completed_at)]],r=>action('employee-closeout',r.id,'Open closeout'))
      +pager('work',workOffset,work.length,workPage.length>pageSize)));
    content.querySelector('#employee-time-filter [name=status]').value=timeStatus;
    content.querySelector('#employee-work-filter [name=status]').value=workStatus;
    bindForm('employee-time-filter',data=>{timeStatus=data.status;timeOffset=0;});
    bindForm('employee-work-filter',data=>{workStatus=data.status;workOffset=0;});
    for(const button of content.querySelectorAll('[data-employee-page]'))button.onclick=async()=>{
      button.disabled=true;
      const [kind,direction]=button.dataset.employeePage.split('-'),change=direction==='next'?pageSize:-pageSize;
      if(kind==='time')timeOffset=Math.max(0,timeOffset+change);else workOffset=Math.max(0,workOffset+change);
      try{await render();}catch(error){say(error.message,true);}finally{button.disabled=false;}
    };
    const previous = content.onclick;
    content.onclick = async event => {
      const button = event.target.closest('[data-action]');
      if (!button || !['employee-review','employee-closeout'].includes(button.dataset.action)) return previous?.(event);
      button.disabled = true;
      try {
        if (button.dataset.action === 'employee-review') {
          const entry = queue.items.find(row=>row.id===button.dataset.id);
          if (!entry) throw Error('This time entry is no longer in the current list. Refresh before reviewing.');
          content.querySelector('#employee-time-review')?.closest('.panel')?.remove();
          content.insertAdjacentHTML('beforeend',form('employee-time-review',`Review ${entry.employee_name}'s time`,`<p class="wide">${esc(workName(entry))} · ${esc(when(entry.clock_in_at))} → ${esc(when(entry.clock_out_at))} · ${esc(entry.duration_minutes)} recorded minutes · ${esc(entry.review_status)}</p>`+select('status','Decision',[['approved','Approve recorded time'],['rejected','Reject — follow-up needed']],false)+field('note','Review reason','text','','required maxlength="2000"'),'Record review'));
          bindForm('employee-time-review', data=>api(`portal-employee/time-entries/${entry.id}/review`,'POST',data));
          content.querySelector('#employee-time-review').scrollIntoView({behavior:'smooth'});
        } else {
          const closeout = await api(`portal-employee/assignments/${button.dataset.id}/closeout`);
          content.querySelector('#employee-closeout-detail')?.remove();
          const blocks = closeout.blockers.length?table(closeout.blockers,[['Needs attention','message']]):'<p>Checklist, exception and recorded time checks are clear. The assigned team member can complete this work.</p>';
          content.insertAdjacentHTML('beforeend',`<div id="employee-closeout-detail">${panel(closeout.assignment.title,blocks)}${panel('Exception records',table(closeout.exceptions,[['Reported issue','reason'],['State','status'],['Resolution','resolution_note'],['Decision','resolution_kind']]))}${closeout.exceptions.filter(issue=>issue.status==='open').map(issue=>form(`resolve-${issue.id}`,'Resolve reported exception',`<p class="wide">${esc(issue.reason)}</p>`+select('decision','Decision',[['resolved','Issue resolved — checklist item still required'],...(issue.checklist_item_id?[['waived','Waive this checklist item with reason']]:[])],false)+field('resolution_note','Manager resolution','text','','required maxlength="2000"'),'Record resolution')).join('')}</div>`);
          for(const issue of closeout.exceptions.filter(issue=>issue.status==='open')) bindForm(`resolve-${issue.id}`,data=>api(`portal-employee/exceptions/${issue.id}/resolve`,'POST',{resolution_note:data.resolution_note,waive_item:data.decision==='waived'}));
          content.querySelector('#employee-closeout-detail').scrollIntoView({behavior:'smooth'});
        }
      } catch(error) { say(error.message,true); } finally { button.disabled=false; }
    };
  };
}
