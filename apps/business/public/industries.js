export function industriesView(ui){
 const {api,content,panel,table,action,bindActions,render,say,when}=ui;
 return async()=>{
  const [industries,applied]=await Promise.all([api('industries?limit=200'),api('industries/applied').catch(e=>{if(e.status===404)return null;throw e;})]);
  content.innerHTML=panel('Industry configuration','<p class="muted">Apply the terminology, lead stages, estimate templates, appointment types, dashboard and workflow defaults for your business.</p>')
   +panel('Available industries',table(industries,[['Industry','label'],['Description','description'],['Lead stages',r=>r.counts.leadStages],['Quote templates',r=>r.counts.quoteTemplates],['Appointment types',r=>r.counts.appointmentTypes]],r=>action('apply',r.key,'Apply configuration')));
  if(applied)content.insertAdjacentHTML('beforeend',panel('Current industry',table([applied],[['Industry',r=>industries.find(i=>i.key===r.industryKey)?.label||r.industryKey],['Applied',r=>when(r.appliedAt)]]))
   +panel('Company terminology',table(Object.entries(applied.terminology).map(([key,value])=>({key,value})),[['Record type','key'],['Company term','value']]))
   +panel('Configured lead stages',table(applied.leadStages,[['Stage','label'],['Order','sortOrder']]))
   +panel('Configured quote templates',table(applied.quoteTemplates,[['Template',r=>r.name||r.label||r.key]])));
  bindActions(async(_,id)=>{await api(`industries/${id}/apply`,'POST',{});await render();say('Industry configuration applied and saved.');});
 };
}
