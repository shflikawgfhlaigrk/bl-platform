export function crmView(ui) {
  const {api,content,field,area,select,form,panel,table,action,bindForm,bindActions,render,say,esc,when,money,cents,customers,customerOptions}=ui;
  const types={customers:'Customer',leads:'Lead',deals:'Deal',jobs:'Job',companies:'Company',contacts:'Contact'};
  const singular={customers:'customer',leads:'lead',deals:'deal',jobs:'job',companies:'company',contacts:'contact'};
  const titles=r=>r.name||r.title||[r.first_name,r.last_name].filter(Boolean).join(' ');
  let selected,selectedType,query='',pageOffset=0,lastType,queueBucket='all',queueOwner='';
  const bucketOptions=[['all','All active leads'],['overdue','Overdue'],['unowned','Unowned'],['no_next_action','No next action'],['no_due_date','No due date']];
  const localDate=value=>value?new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  return async(sub='queue')=>{
    const queueMode=sub==='queue';
    if(queueMode)sub='leads';
    if(!types[sub])sub='customers';
    const viewKey=queueMode?'queue':sub;
    if(lastType!==viewKey){query='';pageOffset=0;lastType=viewKey;}
    const entityType=`crm.${singular[sub]}`;
    const [result,stages,definitions,cs,companies,owners]=await Promise.all([api(queueMode?`crm/sales-queue?limit=50&offset=${pageOffset}&q=${encodeURIComponent(query)}&bucket=${queueBucket}&owner_user_id=${encodeURIComponent(queueOwner)}`:`crm/${sub}?limit=50&offset=${pageOffset}&q=${encodeURIComponent(query)}`),api('crm/lead-stages'),api(`crm/custom-fields?entity_type=${entityType}`),customers(),api('crm/companies?limit=200'),sub==='leads'?api('crm/owners?limit=200'):[]]);
    const rows=queueMode?result.items:result;
    const statuses=sub==='jobs'?['planned','in_progress','completed','canceled']:sub==='deals'?['open','won','lost']:sub==='customers'?['active','inactive','archived']:[];
    const optional=(name,label,values)=>select(name,label,[['','None'],...values],false);
    const recordFields=row=>{
      let html=sub==='contacts'?field('first_name','First name','text',row.first_name||'','required')+field('last_name','Last name','text',row.last_name||''):field(['jobs','deals'].includes(sub)?'title':'name',types[sub]+' name','text',titles(row),'required');
      if(!['jobs','deals'].includes(sub))html+=field('email','Email','email',row.email||'')+field('phone','Phone','text',row.phone||'');
      if(['customers','companies'].includes(sub))html+=field('address','Address','text',row.address||'');
      if(sub==='companies')html+=field('domain','Website domain','text',row.domain||'');
      if(['leads','contacts','deals'].includes(sub))html+=optional('company_id','Company',companies.map(r=>[r.id,r.name]));
      if(['leads','contacts','jobs','deals'].includes(sub))html+=optional('customer_id','Customer',customerOptions(cs));
      if(sub==='leads')html+=field('source','Lead source','text',row.source||'')+select('stage','Stage',stages.map(r=>[r.key,r.label]),false)
        +optional('owner_user_id','Follow-up owner',owners.map(r=>[r.id,r.name]))
        +field('next_action','Next action','text',row.next_action||'','maxlength="500" placeholder="Call to confirm service requirements"')
        +field('next_action_due_at','Next action due','datetime-local',localDate(row.next_action_due_at))
        +(!owners.length?'<p class="muted wide">No company users are available to own follow-ups. Company setup must provision an owner.</p>':'');
      if(statuses.length)html+=select('status','Status',statuses.map(s=>[s,s.replaceAll('_',' ')]),false);
      if(['leads','deals'].includes(sub))html+=field('value','Value ($)','text',((row.value_cents||0)/100).toFixed(2));
      if(sub==='jobs')html+=field('description','Description','text',row.description||'');
      for(const def of definitions){const value=row.custom_fields?.[def.key]??'';html+=def.kind==='boolean'?select(`custom:${def.key}`,def.label,[['','Unspecified'],['true','Yes'],['false','No']],false):field(`custom:${def.key}`,def.label,def.kind==='number'?'number':def.kind==='date'?'date':'text',value);}
      return html;
    };
    const populate=(id,row)=>{const f=document.getElementById(id);for(const name of ['company_id','customer_id','stage','status','owner_user_id'])if(f.elements[name]&&row[name]){if(name==='owner_user_id'&&!owners.some(owner=>owner.id===row[name]))f.elements[name].add(new Option('Previous owner unavailable',row[name]));f.elements[name].value=row[name];}for(const def of definitions)if(def.kind==='boolean'&&row.custom_fields?.[def.key]!==undefined)f.elements[`custom:${def.key}`].value=String(row.custom_fields[def.key]);};
    const input=(data,row={})=>{
      const next={},custom={...(row.custom_fields||{})};
      for(const [key,value] of Object.entries(data)){
        if(key.startsWith('custom:')){const name=key.slice(7),def=definitions.find(d=>d.key===name);if(value===''){delete custom[name];continue;}custom[name]=def.kind==='number'?Number(value):def.kind==='boolean'?value==='true':value;}
        else if(key==='value')next.value_cents=cents(value||'0');
        else if(key==='next_action_due_at')next[key]=value?new Date(value).toISOString():null;
        else if(value!==''||row.id)next[key]=value===''?null:value;
      }
      if(sub==='leads'&&next.next_action===null)next.next_action_due_at=null;
      if(sub==='leads'&&row.id)next.expected_next_action_revision=row.next_action_revision;
      if(definitions.length)next.custom_fields=custom;return next;
    };
    const recordColumns=queueMode?[['Lead',titles],['Owner',r=>r.owner_name||(r.owner_user_id?'Previous owner unavailable':'Unassigned')],['Next action',r=>r.next_action||'Set a next action'],['Due',r=>when(r.next_action_due_at)],['Attention',r=>r.exceptions.map(s=>s.replaceAll('_',' ')).join(' · ')||'Scheduled'],['Source',r=>r.source||'Unrecorded']]:[['Name',titles],['Email','email'],['Status',r=>r.stage||r.status||'Active'],['Created',r=>when(r.created_at)]];
    content.innerHTML=`<div class="tabs"><a href="#/crm/queue" class="${queueMode?'active':''}">Sales queue</a>${Object.entries(types).map(([key,title])=>`<a href="#/crm/${key}" class="${!queueMode&&key===sub?'active':''}">${esc(key[0].toUpperCase()+key.slice(1))}</a>`).join('')}</div>`
      +(queueMode?panel('Own the next customer action',`<p>Work overdue follow-ups first, then give every active lead an owner and a dated next action. Closed stages leave this queue.</p><div class="fields">${[['active','Active leads'],['overdue','Overdue actions'],['unowned','Unowned leads'],['no_next_action','No next action'],['no_due_date','Undated actions']].map(([key,label])=>`<div class="metric"><span class="muted">${esc(label)}</span><div class="stat">${result.summary[key]}</div></div>`).join('')}</div><p class="muted">Active estimated pipeline: ${money(result.summary.pipeline_value_cents)} · Calculated ${esc(when(result.generated_at))}. Counts include all matching leads; the queue is paginated.</p>`):'')
      +form('crm-add',`Add ${types[sub].toLowerCase()}`,recordFields({}))
      +form('crm-search',queueMode?'Filter the sales queue':'Find records',field('q','Name, email, phone or source','search',query)+(queueMode?select('bucket','Needs attention',bucketOptions,false)+optional('owner','Owner',owners.map(r=>[r.id,r.name])):''),'Search')
      +panel(queueMode?'Next actions':'Records',(rows.length?table(rows,recordColumns,r=>action('view',r.id,queueMode?'Open lead & act':'Activity & details')):`<p class="empty">${queueMode?'No active leads match this filter. Closed leads stay in Leads.':'No records yet. Add a record to begin.'}</p>`)+`<div class="actions">${pageOffset?action('previous','','Previous'):''}${rows.length===50?action('next','','Next'):''}<span class="muted">${rows.length?pageOffset+1:0}–${pageOffset+rows.length}</span></div>`)
      +`<details class="panel"><summary>Import, export and record setup</summary>`
      +(['customers','contacts','leads'].includes(sub)?`<p><a href="/api/crm/${sub}/export.csv" download="${sub}.csv">Export ${sub} CSV</a></p>`+form('crm-import',`Import ${sub}`,`<p class="muted wide">Use headers from the CSV export. ${sub==='contacts'?'first_name':'name'} is required. Each import adds records; review row errors before importing again.</p>`+field('csv','CSV file','file','','required accept=".csv,text/csv"'),'Import CSV'):'')
      +form('custom-add','Add a field',field('label','Field label','text','','required')+select('kind','Field type',[['text','Text'],['number','Number'],['boolean','Yes / No'],['date','Date']],false),'Add field')
      +(sub==='leads'?form('stages-edit','Pipeline stages',area('stages','Stages in order — one per line; append | closed to completed stages',stages.map(r=>r.label+(r.is_closed?' | closed':'')).join('\n')),'Save stages'):'')+'</details><div id="crm-detail"></div>';
    bindForm('crm-add',data=>api(`crm/${sub}`,'POST',input(data)));
    if(queueMode){document.querySelector('#crm-search').elements.bucket.value=queueBucket;document.querySelector('#crm-search').elements.owner.value=queueOwner;}
    bindForm('crm-search',async data=>{query=data.q;pageOffset=0;if(queueMode){queueBucket=data.bucket;queueOwner=data.owner;}});
    bindForm('custom-add',data=>api('crm/custom-fields','POST',{entity_type:entityType,label:data.label,kind:data.kind,key:data.label.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')}));
    bindForm('stages-edit',data=>{const labels=data.stages.split('\n').map(s=>s.trim()).filter(Boolean);return api('crm/lead-stages','PUT',{stages:labels.map(line=>{const closed=/\s*\|\s*closed\s*$/i.test(line),label=line.replace(/\s*\|\s*closed\s*$/i,'').trim();return {key:stages.find(s=>s.label===label)?.key||label.toLowerCase().replace(/[^a-z0-9]+/g,'_'),label,is_closed:closed};})});});
    bindForm('crm-import',async(_,f)=>{
      const file=f.elements.csv.files[0];if(file.size>10*1024*1024)throw Error('Choose a CSV smaller than 10 MB.');
      const response=await fetch(`/api/crm/${sub}/import.csv`,{method:'POST',headers:{'content-type':'text/csv'},body:await file.text()});
      const body=await response.json();if(!response.ok)throw Error(body.error?.message||'Import failed.');await render();
      content.insertAdjacentHTML('beforeend',panel('Import result',`<p>${body.data.imported} records imported.</p>`+table(body.data.errors,[['Row','row'],['Issue','message']])));say('Import completed. Review the result.');
    },false);
    async function details(id){
      selected=id;selectedType=sub;const ref=new URLSearchParams({entity_type:entityType,entity_id:id,limit:'200'});
      const [row,history,notes,tags,available,audit]=await Promise.all([api(`crm/${sub}/${id}`),api(`crm/timeline?${ref}`),api(`crm/notes?${ref}`),api(`crm/taggings?${ref}`),api('crm/tags?limit=200'),api(`business/audit?entityType=${entityType}&entityId=${encodeURIComponent(id)}`)]);
      const detail=document.querySelector('#crm-detail');detail.innerHTML=form('crm-edit',titles(row),recordFields(row),'Save changes')
        +(sub==='leads'&&row.next_action?form('crm-complete-action','Complete the current next action',`<p class="wide">${esc(row.next_action)} · ${esc(when(row.next_action_due_at))}</p>`+field('note','Outcome note','text','','maxlength="2000"'),'Complete action'):'')
        +(sub==='leads'?panel('Lead contact & source',`<p>${esc(row.email||'No email recorded')} · ${esc(row.phone||'No phone recorded')}</p><p class="muted">Source: ${esc(row.source||'Unrecorded')} · Lead ID: ${esc(row.id)}</p>`):'')
        +panel('Tags',tags.map(tag=>`<span class="badge">${esc(tag.name)}</span> ${action('untag',tag.id,'Remove tag',`data-record="${esc(id)}"`)}`).join(' ')||'<p class="muted">No tags assigned.</p>')
        +form('crm-tag','Add a tag',optional('tagId','Existing tag',available.map(r=>[r.id,r.name]))+field('name','Or create a tag'),'Attach tag')
        +form('crm-note','Add a note',area('body','Note'),'Save note')
        +panel('Notes',table(notes,[['Note','body'],['Recorded',r=>when(r.created_at)]]))
        +panel('Activity timeline',table(history,[['Activity',r=>r.event_type.replaceAll('_',' ').replaceAll('.',' · ')],['Details',r=>{const data=r.data?JSON.parse(r.data):{};return [data.action,data.note].filter(Boolean).join(' · ');}],['Recorded',r=>when(r.created_at)]]))
        +`<details class="panel"><summary>Audit history</summary>${table(audit,[['Action',r=>r.action.replaceAll('.',' · ')],['Recorded',r=>when(r.created_at)]])}</details>`;
      populate('crm-edit',row);
      bindForm('crm-edit',data=>api(`crm/${sub}/${id}`,'PATCH',input(data,row)));
      const completionKey=crypto.randomUUID();
      bindForm('crm-complete-action',async data=>{const result=await api(`crm/leads/${id}/next-action/complete`,'POST',{revision:row.next_action_revision,idempotency_key:completionKey,note:data.note});say(`Completed. Receipt ${result.receipt.id}. Set the next action or close this lead.`);await render();},false);
      bindForm('crm-note',data=>api('crm/notes','POST',{...data,entity_type:entityType,entity_id:id}));
      bindForm('crm-tag',async data=>{const tagId=data.tagId||(data.name.trim()?(await api('crm/tags','POST',{name:data.name.trim()})).id:null);if(!tagId)throw Error('Choose or name a tag.');await api(`crm/tags/${tagId}/attach`,'POST',{entity_type:entityType,entity_id:id});});
    }
    bindActions(async(a,id,b)=>{if(a==='view'){await details(id);content.querySelector('#crm-detail').scrollIntoView({behavior:'smooth'});}if(a==='next'||a==='previous'){pageOffset=Math.max(0,pageOffset+(a==='next'?50:-50));await render();}if(a==='untag'){await api(`crm/tags/${id}/detach`,'POST',{entity_type:entityType,entity_id:b.dataset.record});await render();say('Tag removed.');}});
    if(selected&&selectedType===sub)await details(selected);
  };
}
