export function filesView(ui){
 const {api,content,field,select,form,panel,table,action,bindForm,bindActions,render,say,esc,when,customers,customerOptions}=ui;let query={};
 return async()=>{
  const [rows,folders,cs,people]=await Promise.all([api(`files/files?limit=200&${new URLSearchParams(query)}`),api('files/folders?limit=200'),customers(),api('business/users')]);
  const folderOptions=[['','No folder'],...folders.map(f=>[f.id,f.name])],visibility=[['private','Private'],['tenant','Company team'],['public','Public visibility']];
  content.innerHTML=form('file-search','Find documents',field('name','File name','text',query.name||'')+field('tag','Tag','text',query.tag||'')+select('folder_id','Folder',folderOptions,false),'Search')
   +form('folder-add','Create a folder',field('name','Folder name','text','','required')+select('parent_id','Inside folder',folderOptions,false),'Create folder')
   +form('file-upload','Add a document',field('file','Choose file','file','','required')+select('folder_id','Folder',folderOptions,false)+field('tags','Tags — comma separated')+select('visibility','Visibility',visibility,false)+select('customer','Share with a customer',[['','Keep private'],...customerOptions(cs)],false),'Upload document')
   +panel('Documents',table(rows,[['File','name'],['Tags',r=>(r.tags||[]).join(', ')],['Visibility','visibility'],['Size',r=>`${r.size_bytes.toLocaleString()} bytes`],['Created',r=>when(r.created_at)]],r=>`<a class="button quiet" href="/api/files/files/${encodeURIComponent(r.id)}/content">Download</a>${action('details',r.id,'Manage')}`));
  document.querySelector('#file-search [name=folder_id]').value=query.folder_id||'';
  bindForm('file-search',d=>{query=Object.fromEntries(Object.entries(d).filter(([,v])=>v));});
  bindForm('folder-add',d=>api('files/folders','POST',{name:d.name,parent_id:d.parent_id||null}));
  bindForm('file-upload',async(d,f)=>{const file=f.querySelector('[name=file]').files[0];if(file.size>10*1024*1024)throw Error('Choose a file up to 10 MB.');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);const upload=await api('files/uploads','POST',{name:file.name,mime:file.type||'application/octet-stream',folder_id:d.folder_id||null,visibility:d.visibility,tags:d.tags.split(',').map(s=>s.trim()).filter(Boolean)});const stored=await api(`files/uploads/${upload.id}/complete`,'POST',{content_base64:btoa(binary)});if(d.customer)await api(`files/files/${stored.id}/links`,'POST',{entity_type:'portal.customer',entity_id:d.customer});});
  bindActions(async(a,id,b)=>{
   if(a==='unlink'){await api(`files/files/${b.dataset.file}/links/${id}`,'DELETE');await render();return;}
   if(a==='revoke'){await api(`files/files/${b.dataset.file}/permissions/${id}`,'DELETE');await render();return;}
   if(a!=='details')return;
   const [file,links,permissions,audit,jobs,quotes,invoices]=await Promise.all([api(`files/files/${id}`),api(`files/files/${id}/links`),api(`files/files/${id}/permissions`),api(`files/files/${id}/audit`),api('crm/jobs?limit=200'),api('quoting/quotes?limit=200'),api('billing/invoices?limit=200')]);
   document.querySelector('#file-detail')?.remove();content.insertAdjacentHTML('beforeend',`<div id="file-detail">`+form('file-edit','Document settings',field('name','File name','text',file.name,'required')+select('folder_id','Folder',folderOptions,false)+field('tags','Tags — comma separated','text',(file.tags||[]).join(', '))+select('visibility','Visibility',visibility,false))
    +form('file-link','Attach to a record',select('record','Record',[...cs.map(r=>[`crm.customer:${r.id}`,`Customer: ${r.name}`]),...cs.map(r=>[`portal.customer:${r.id}`,`Share in portal: ${r.name}`]),...jobs.map(r=>[`crm.job:${r.id}`,`Job: ${r.title}`]),...quotes.map(r=>[`quoting.quote:${r.id}`,`Quote: ${r.title||r.number}`]),...invoices.map(r=>[`billing.invoice:${r.id}`,`Invoice: ${r.number}`])]),'Attach record')
    +form('file-permission','Give access',select('person','Person or role',[...people.map(p=>[`user:${p.id}`,p.name]),['role:member','Company members']])+select('write','Permission',[['false','Read'],['true','Read and edit']],false),'Grant access')
    +panel('Linked records',table(links,[['Type','entity_type'],['Record','entity_id']],r=>action('unlink',r.id,'Remove link',`data-file="${id}"`)))
    +panel('Explicit permissions',table(permissions,[['Type','grantee_type'],['Recipient','grantee'],['Edit',r=>r.can_write?'Yes':'No']],r=>action('revoke',r.id,'Revoke',`data-file="${id}"`)))
    +panel('Document audit',table(audit,[['Action','action'],['Recorded',r=>when(r.created_at)]]))+'</div>');
   document.querySelector('#file-edit [name=folder_id]').value=file.folder_id||'';document.querySelector('#file-edit [name=visibility]').value=file.visibility;
   bindForm('file-edit',d=>api(`files/files/${id}`,'PATCH',{name:d.name,folder_id:d.folder_id||null,visibility:d.visibility,tags:d.tags.split(',').map(s=>s.trim()).filter(Boolean)}));
   bindForm('file-link',d=>{const [entity_type,entity_id]=d.record.split(':');return api(`files/files/${id}/links`,'POST',{entity_type,entity_id});});
   bindForm('file-permission',d=>{const[grantee_type,grantee]=d.person.split(':');return api(`files/files/${id}/permissions`,'POST',{grantee_type,grantee,can_write:d.write==='true'});});
   document.querySelector('#file-detail').scrollIntoView({behavior:'smooth'});
  });
 };
}
