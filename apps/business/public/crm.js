export function crmView(ui) {
  const {api,content,field,area,select,form,panel,table,action,bindForm,bindActions,render,say,esc,when,money,cents,customers,customerOptions}=ui;
  const types={customers:'Customer',leads:'Lead',deals:'Deal',jobs:'Job',companies:'Company',contacts:'Contact'};
  const singular={customers:'customer',leads:'lead',deals:'deal',jobs:'job',companies:'company',contacts:'contact'};
  const titles=r=>r.name||r.title||[r.first_name,r.last_name].filter(Boolean).join(' ');
  let selected,selectedType,query='',pageOffset=0,lastType;
  return async(sub='customers')=>{
    if(!types[sub])sub='customers';
    if(lastType!==sub){query='';pageOffset=0;lastType=sub;}
    const entityType=`crm.${singular[sub]}`;
    const [rows,stages,definitions,cs,companies]=await Promise.all([api(`crm/${sub}?limit=50&offset=${pageOffset}&q=${encodeURIComponent(query)}`),api('crm/lead-stages'),api(`crm/custom-fields?entity_type=${entityType}`),customers(),api('crm/companies?limit=200')]);
    const statuses=sub==='jobs'?['planned','in_progress','completed','canceled']:sub==='deals'?['open','won','lost']:sub==='customers'?['active','inactive','archived']:[];
    const optional=(name,label,values)=>select(name,label,[['','None'],...values],false);
    const recordFields=row=>{
      let html=sub==='contacts'?field('first_name','First name','text',row.first_name||'','required')+field('last_name','Last name','text',row.last_name||''):field(['jobs','deals'].includes(sub)?'title':'name',types[sub]+' name','text',titles(row),'required');
      if(!['jobs','deals'].includes(sub))html+=field('email','Email','email',row.email||'')+field('phone','Phone','text',row.phone||'');
      if(['customers','companies'].includes(sub))html+=field('address','Address','text',row.address||'');
      if(sub==='companies')html+=field('domain','Website domain','text',row.domain||'');
      if(['leads','contacts','deals'].includes(sub))html+=optional('company_id','Company',companies.map(r=>[r.id,r.name]));
      if(['leads','contacts','jobs','deals'].includes(sub))html+=optional('customer_id','Customer',customerOptions(cs));
      if(sub==='leads')html+=field('source','Lead source','text',row.source||'')+select('stage','Stage',stages.map(r=>[r.key,r.label]),false);
      if(statuses.length)html+=select('status','Status',statuses.map(s=>[s,s.replaceAll('_',' ')]),false);
      if(['leads','deals'].includes(sub))html+=field('value','Value ($)','text',((row.value_cents||0)/100).toFixed(2));
      if(sub==='jobs')html+=field('description','Description','text',row.description||'');
      for(const def of definitions){const value=row.custom_fields?.[def.key]??'';html+=def.kind==='boolean'?select(`custom:${def.key}`,def.label,[['','Unspecified'],['true','Yes'],['false','No']],false):field(`custom:${def.key}`,def.label,def.kind==='number'?'number':def.kind==='date'?'date':'text',value);}
      return html;
    };
    const populate=(id,row)=>{const f=document.getElementById(id);for(const name of ['company_id','customer_id','stage','status'])if(f.elements[name]&&row[name])f.elements[name].value=row[name];for(const def of definitions)if(def.kind==='boolean'&&row.custom_fields?.[def.key]!==undefined)f.elements[`custom:${def.key}`].value=String(row.custom_fields[def.key]);};
    const input=(data,row={})=>{
      const next={},custom={...(row.custom_fields||{})};
      for(const [key,value] of Object.entries(data)){
        if(key.startsWith('custom:')){const name=key.slice(7),def=definitions.find(d=>d.key===name);if(value===''){delete custom[name];continue;}custom[name]=def.kind==='number'?Number(value):def.kind==='boolean'?value==='true':value;}
        else if(key==='value')next.value_cents=cents(value||'0');
        else if(value!==''||row.id)next[key]=value===''?null:value;
      }
      if(definitions.length)next.custom_fields=custom;return next;
    };
    content.innerHTML=`<div class="tabs">${Object.entries(types).map(([key,title])=>`<a href="#/crm/${key}" class="${key===sub?'active':''}">${esc(key[0].toUpperCase()+key.slice(1))}</a>`).join('')}</div>`
      +form('crm-add',`Add ${types[sub].toLowerCase()}`,recordFields({}))
      +form('crm-search','Find records',field('q','Name, email, phone or source','search',query),'Search')
      +panel('Records',table(rows,[['Name',titles],['Email','email'],['Status',r=>r.stage||r.status||'Active'],['Created',r=>when(r.created_at)]],r=>action('view',r.id,'Activity & details'))+`<div class="actions">${pageOffset?action('previous','','Previous'):''}${rows.length===50?action('next','','Next'):''}<span class="muted">${pageOffset+1}–${pageOffset+rows.length}</span></div>`)
      +`<details class="panel"><summary>Import, export and record setup</summary>`
      +(['customers','contacts','leads'].includes(sub)?`<p><a href="/api/crm/${sub}/export.csv" download="${sub}.csv">Export ${sub} CSV</a></p>`+form('crm-import',`Import ${sub}`,`<p class="muted wide">Use headers from the CSV export. ${sub==='contacts'?'first_name':'name'} is required. Each import adds records; review row errors before importing again.</p>`+field('csv','CSV file','file','','required accept=".csv,text/csv"'),'Import CSV'):'')
      +form('custom-add','Add a field',field('label','Field label','text','','required')+select('kind','Field type',[['text','Text'],['number','Number'],['boolean','Yes / No'],['date','Date']],false),'Add field')
      +(sub==='leads'?form('stages-edit','Pipeline stages',area('stages','Stages in order — one per line',stages.map(r=>r.label).join('\n')),'Save stages'):'')+'</details><div id="crm-detail"></div>';
    bindForm('crm-add',data=>api(`crm/${sub}`,'POST',input(data)));
    bindForm('crm-search',async data=>{query=data.q;pageOffset=0;});
    bindForm('custom-add',data=>api('crm/custom-fields','POST',{entity_type:entityType,label:data.label,kind:data.kind,key:data.label.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')}));
    bindForm('stages-edit',data=>{const labels=data.stages.split('\n').map(s=>s.trim()).filter(Boolean);return api('crm/lead-stages','PUT',{stages:labels.map(label=>({key:stages.find(s=>s.label===label)?.key||label.toLowerCase().replace(/[^a-z0-9]+/g,'_'),label}))});});
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
        +panel('Tags',tags.map(tag=>`<span class="badge">${esc(tag.name)}</span> ${action('untag',tag.id,'Remove tag',`data-record="${esc(id)}"`)}`).join(' ')||'<p class="muted">No tags assigned.</p>')
        +form('crm-tag','Add a tag',optional('tagId','Existing tag',available.map(r=>[r.id,r.name]))+field('name','Or create a tag'),'Attach tag')
        +form('crm-note','Add a note',area('body','Note'),'Save note')
        +panel('Notes',table(notes,[['Note','body'],['Recorded',r=>when(r.created_at)]]))
        +panel('Activity timeline',table(history,[['Activity',r=>r.event_type.replaceAll('_',' ').replaceAll('.',' · ')],['Recorded',r=>when(r.created_at)]]))
        +`<details class="panel"><summary>Audit history</summary>${table(audit,[['Action',r=>r.action.replaceAll('.',' · ')],['Recorded',r=>when(r.created_at)]])}</details>`;
      populate('crm-edit',row);
      bindForm('crm-edit',data=>api(`crm/${sub}/${id}`,'PATCH',input(data,row)));
      bindForm('crm-note',data=>api('crm/notes','POST',{...data,entity_type:entityType,entity_id:id}));
      bindForm('crm-tag',async data=>{const tagId=data.tagId||(data.name.trim()?(await api('crm/tags','POST',{name:data.name.trim()})).id:null);if(!tagId)throw Error('Choose or name a tag.');await api(`crm/tags/${tagId}/attach`,'POST',{entity_type:entityType,entity_id:id});});
    }
    bindActions(async(a,id,b)=>{if(a==='view'){await details(id);content.querySelector('#crm-detail').scrollIntoView({behavior:'smooth'});}if(a==='next'||a==='previous'){pageOffset=Math.max(0,pageOffset+(a==='next'?50:-50));await render();}if(a==='untag'){await api(`crm/tags/${id}/detach`,'POST',{entity_type:entityType,entity_id:b.dataset.record});await render();say('Tag removed.');}});
    if(selected&&selectedType===sub)await details(selected);
  };
}
