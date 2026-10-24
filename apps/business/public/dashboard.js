/** Owner queue uses saved local records; it never sends, retries, or charges. */
export function renderExceptionQueue(queue, ui, showReports=false) {
  const {esc,when,money,panel}=ui;
  const unknown=queue.sources.filter(source=>!source.available);
  const cards=queue.items.map(item=>`<article class="panel"><div class="heading-row"><h3>${esc(item.title)}</h3><span class="badge">${esc(item.status.replaceAll('_',' '))}</span></div><p>${esc(item.reason)}</p>${item.balanceCents===null?'':`<p><strong>Recorded balance ${esc(money(item.balanceCents))}</strong></p>`}<p>${esc(item.nextAction)}</p><p class="muted">Source updated: ${esc(item.source.updatedAt?when(item.source.updatedAt):'Unknown')} · Attention since: ${esc(item.attentionSince?when(item.attentionSince):'Unknown')}</p><div class="actions"><button class="quiet" data-exception-inspect="${esc(item.id)}">Inspect source record</button><a class="button quiet" href="${esc(item.source.href)}">Open workspace</a></div><div data-exception-detail="${esc(item.id)}"></div></article>`).join('');
  return panel('What needs your attention',`<p>Review the source, assign the next action, and refresh to see what has been resolved.</p><p class="muted" data-queue-freshness data-sampled-at="${esc(queue.sampledAt)}">Local records sampled ${esc(when(queue.sampledAt))}. External provider freshness is not verified.</p><div class="actions"><button class="quiet" data-exception-page="refresh">Refresh records</button>${showReports?'<a class="button quiet" href="#/dashboard/reports">Basic reports</a>':''}</div>${unknown.length?`<p role="status">${unknown.length} categories were not checked. A missing source is unknown.</p><ul>${unknown.map(source=>`<li><strong>${esc(source.label)}:</strong> ${esc(source.issue)}</li>`).join('')}</ul>`:''}<label>Show category<select data-exception-kind><option value="all">All available categories</option>${queue.sources.map(source=>`<option value="${esc(source.kind)}">${esc(source.label)} · ${source.count===null?'Unknown':source.count}</option>`).join('')}</select></label><p>${queue.total} recorded items in the selected categories.</p>`)
    +(cards||panel('Queue result',`<p>${queue.completeness==='partial'?'No exceptions in the categories checked. Review the unchecked sources above.':'No matching exceptions in these local records.'}</p>`))
    +`<div class="actions">${queue.offset?'<button class="quiet" data-exception-page="previous">Previous</button>':''}${queue.hasMore?'<button class="quiet" data-exception-page="next">Next</button>':''}<span class="muted">${queue.items.length?queue.offset+1:0}–${queue.offset+queue.items.length} of ${queue.total}</span></div>`;
}

export function exceptionQueueView(ui) {
  const {api,content,panel,esc,when,money,say}=ui;
  let offset=0,kind='all',staleTimer,sequence=0;
  const view=async(sub)=>{
    clearTimeout(staleTimer);
    const turn=++sequence;
    if(sub==='reports'&&ui.reports)return ui.reports();
    const queue=await api(`dashboard/exceptions?limit=25&offset=${offset}&kind=${encodeURIComponent(kind)}`);
    if(turn!==sequence)return;
    content.innerHTML=renderExceptionQueue(queue,ui,!!ui.reports);
    content.querySelector('[data-exception-kind]').value=kind;
    const refresh=async(nextOffset=offset)=>{offset=nextOffset;try{await view();}catch(error){say(error.message,true);}};
    content.querySelector('[data-exception-kind]').onchange=async event=>{kind=event.target.value;await refresh(0);};
    for(const button of content.querySelectorAll('[data-exception-page]'))button.onclick=async()=>{button.disabled=true;await refresh(button.dataset.exceptionPage==='next'?offset+25:button.dataset.exceptionPage==='previous'?Math.max(0,offset-25):offset);};
    staleTimer=setTimeout(()=>{
      if(turn!==sequence)return;
      const label=content.querySelector('[data-queue-freshness]');
      if(label?.dataset.sampledAt===queue.sampledAt){label.textContent=`This queue was sampled ${when(queue.sampledAt)} and is now stale. Refresh before acting. External provider freshness is not verified.`;label.setAttribute('role','status');}
    },Math.max(0,Date.parse(queue.staleAt)-Date.now()));
    for(const button of content.querySelectorAll('[data-exception-inspect]'))button.onclick=async()=>{
      button.disabled=true;
      try{
        const item=queue.items.find(item=>item.id===button.dataset.exceptionInspect);
        const detail=await api(item.source.api+(item.kind==='crew_attention'?'/closeout':'')),record=detail.quote||detail.assignment||detail;
        if(turn!==sequence||!button.isConnected)return;
        const values=[['Record',record.title||record.subject||record.number||record.id],['Current status',record.status],['Current source timestamp',when(record.updated_at||record.finishedAt||record.startedAt||record.scheduled_at)]];
        if(item.kind==='overdue_balance')values.push(['Due',when(record.due_at)],['Recorded balance',money(record.total_cents-record.paid_cents)]);
        if(item.kind==='inbox_attention')values.push(['Owner',record.assigned_user_id||'Unassigned'],['Recorded messages',(detail.messages||[]).length]);
        if(item.kind==='workflow_failure')values.push(['Attempts',record.attempts],['Next retry',when(record.nextRetryAt)],['Failed receipt count',(record.actions||[]).filter(action=>action.status==='failed').length]);
        if(item.kind==='crew_attention')values.push(['Scheduled',when(record.scheduled_at)],['Responsible team member',record.employee_id],['Closeout blockers',(detail.blockers||[]).map(blocker=>blocker.message).join(' · ')||'None recorded']);
        const target=[...content.querySelectorAll('[data-exception-detail]')].find(target=>target.dataset.exceptionDetail===item.id);
        target.innerHTML=panel('Current source record',`<dl>${values.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value??'Unknown')}</dd>`).join('')}</dl><p class="muted">Read directly from the source at ${esc(when(new Date().toISOString()))}. Refresh the queue after recording the resolution in its workspace.</p>`);
      }catch(error){say(error.message,true);}finally{button.disabled=false;}
    };
  };
  return view;
}
