export function integrationView(ui) {
  const {api,content,panel,form,field,esc,table,say,bindForm} = ui;
  let preview, input, importKey;
  return async () => {
    const receipts = await api('business/integrations/receipts');
    content.innerHTML = panel('Keep your current setup', '<p>Import a customer export while your existing system stays in place. Preview changes first. Matching uses your source record IDs; conflicting local edits need review.</p><p class="muted">This connector imports JSON customer records. It does not log in to, synchronize with, or write back to another service.</p>')
      +form('customer-import','Preview customer records',field('source','Source identifier','text','existing-system','required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}"')
        +'<label class="wide">Customer export (JSON)<textarea name="records" required rows="10" spellcheck="false" placeholder=\'[ { "externalId": "your-record-id", "name": "Customer name", "email": "customer@example.test" } ]\'></textarea></label>','Preview changes')
      +'<div id="import-preview" aria-live="polite"></div>'
      +panel('Import receipts',table(receipts,[['Source','source'],['Imported',r=>new Date(r.created_at).toLocaleString()],['Receipt','id'],['Records',r=>r.result.imported.length],['Follow-up events',r=>r.result.followUpEvents||'Review legacy receipt']]));
    document.querySelector('#customer-import').addEventListener('input',()=>{
      const apply=document.querySelector('#apply-import');
      if(apply){apply.disabled=true;apply.textContent='Preview your edited records again';}
    });
    bindForm('customer-import',async data=>{
      input={source:data.source,records:JSON.parse(data.records)};
      preview=await api('business/integrations/customers/preview','POST',input); importKey=crypto.randomUUID();
      document.querySelector('#import-preview').innerHTML=panel('Review the changes',table(preview.rows,[['Source record','externalId'],['Action','action'],['Current name',r=>r.before?.name],['Incoming name',r=>r.after.name],['Current email',r=>r.before?.email],['Incoming email',r=>r.after.email],['Review needed','conflict']])
        +'<p class="muted">Unspecified phone, address and email fields preserve their current values. No source-system changes are made.</p>'
        +(preview.canApply?'<button id="apply-import">Import these records</button>':'<p>Resolve the conflicts in your export and preview again. Use a verified localId to link an existing customer.</p>'));
      const apply=document.querySelector('#apply-import'); if(apply)apply.onclick=async()=>{
        apply.disabled=true;
        try {
          const receipt=await api('business/integrations/customers/apply','POST',{...input,previewHash:preview.previewHash,idempotencyKey:importKey});
          document.querySelector('#import-preview').innerHTML=panel('Records imported',`<p>${esc(receipt.imported.length)} records read back successfully.</p><p class="receipt">Receipt ${esc(receipt.id)}</p>`
            +(receipt.followUpEvents!=='processed'?`<p>Records were imported. Follow-up events: ${esc(receipt.followUpEvents||'needs review')}. Review the receipt before taking further action.</p>`:''));
          say('Customer records imported. Your source system was not changed.');
        } catch(error){say(error.message,true);apply.disabled=false;}
      };
    },false);
  };
}
