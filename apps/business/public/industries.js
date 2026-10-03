export function industriesView(ui){
 const {api,content,panel,table,action,bindActions,render,say,when,esc}=ui;
 return async()=>{
  const [industries,applied]=await Promise.all([api('industries?limit=200'),api('industries/applied').catch(e=>{if(e.status===404)return null;throw e;})]);
  content.innerHTML=panel('Configure a working service flow','<p>Apply a starting workflow, then review your stages, services, rates, and appointment durations. Existing owner configuration is preserved.</p><p class="muted">Supported local task recipes connect real module events to follow-up work. External message and unsupported recipes stay disabled. Basic reports and the owner action queue are available in Overview.</p>')
   +panel('Available industries',table(industries,[['Industry','label'],['Description','description'],['Lead stages',r=>r.counts.leadStages],['Quote templates',r=>r.counts.quoteTemplates],['Appointment types',r=>r.counts.appointmentTypes]],r=>action('apply',r.key,'Apply configuration')));
  if(applied)content.insertAdjacentHTML('beforeend',panel('Current industry',table([applied],[['Industry',r=>industries.find(i=>i.key===r.industryKey)?.label||r.industryKey],['Applied',r=>when(r.appliedAt)]]))
   +panel('Company terminology',table(Object.entries(applied.terminology).map(([key,value])=>({key,value})),[['Record type','key'],['Company term','value']]))
   +panel('Starting lead definitions',table(applied.leadStages,[['Stage','label'],['Order','sortOrder']]))
   +panel('Starting quote definitions',table(applied.quoteTemplates,[['Template',r=>r.name||r.label||r.key]]))
   +panel('Runtime setup receipts',applied.runtime?.available?`<p class="muted">Last checked ${esc(when(applied.runtime.checkedAt))}. Reapply to verify current local targets. Rates and activation remain your choice.</p>`+table(applied.runtime.items,[['Component','key'],['Result',r=>r.status.replaceAll('_',' ')],['Readback','detail'],['Checked',r=>when(r.checkedAt)]],r=>`<a class="button quiet" href="${esc(r.href)}">Review workspace</a>`):'<p role="status">Runtime setup has not been verified for this configuration. Its saved definitions alone do not establish working modules.</p>'));
  bindActions(async(_,id)=>{const result=await api(`industries/${id}/apply`,'POST',{});await render();const items=result.runtime?.items||[],incomplete=items.filter(item=>!['installed','preserved'].includes(item.status));say(items.length?`Configuration checked. ${incomplete.length?`${incomplete.length} components need configuration or review; see runtime receipts.`:'Real module targets were read back; owner edits were preserved.'}`:'Configuration definitions saved. Runtime targets have not been verified.');});
 };
}
