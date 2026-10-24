export function schedulingView(ui) {
  const { api, content, field, select, form, panel, table, action, bindForm, bindActions, render, say, esc, when, customers, customerOptions } = ui;
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const optional = (name, label, rows) => select(name, label, [['', 'None'], ...rows.map(r => [r.id, r.name])], false);
  const local = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const append = html => { content.querySelector('[data-schedule-detail]')?.remove(); content.insertAdjacentHTML('beforeend', `<div data-schedule-detail>${html}</div>`); content.querySelector('[data-schedule-detail]').scrollIntoView({ behavior: 'smooth' }); };
  return async (sub = 'appointments') => {
    if (!['appointments', 'setup', 'availability'].includes(sub)) sub = 'appointments';
    const [calendars, staff, resources, types] = await Promise.all(['calendars', 'staff', 'resources', 'appointment-types'].map(key => api(`scheduling/${key}?limit=200`)));
    const owners = [...staff.map(r => [`staff:${r.id}`, `${r.name} · Staff`]), ...resources.map(r => [`resource:${r.id}`, `${r.name} · Resource`])];
    const owner = key => { const [ownerType, ownerId] = key.split(':'); return { ownerType, ownerId }; };
    content.innerHTML = `<div class="tabs">${[['appointments','Appointments'],['setup','Calendars & resources'],['availability','Availability']].map(([key,label]) => `<a href="#/scheduling/${key}" class="${key===sub?'active':''}">${label}</a>`).join('')}</div>`;
    if (sub === 'setup') {
      content.insertAdjacentHTML('beforeend',
        form('calendar-add','Create a calendar',field('name','Calendar name','text','','required')+field('timezone','Timezone','text',zone(),'required'))
        + panel('Calendars',table(calendars,[['Calendar','name'],['Timezone','timezone']],r=>`<a href="/api/scheduling/calendars/${encodeURIComponent(r.id)}/ics" download="calendar.ics">Export ICS</a>`))
        + form('staff-add','Add bookable staff',field('name','Name','text','','required')+field('email','Email','email'))
        + panel('Staff',table(staff,[['Name','name'],['Email','email']]))
        + form('resource-add','Add a resource',field('name','Resource name','text','','required')+field('kind','Type — room, vehicle, equipment'))
        + panel('Resources',table(resources,[['Name','name'],['Type','kind']]))
        + form('type-add','Create an appointment type',field('name','Name','text','','required')+field('durationMinutes','Duration (minutes)','number','60','required min="1" step="1"')+field('bufferBeforeMinutes','Before (minutes)','number','0','min="0" step="1"')+field('bufferAfterMinutes','After (minutes)','number','0','min="0" step="1"'))
        + panel('Appointment types',table(types,[['Type','name'],['Duration (min)','duration_minutes'],['Before (min)','buffer_before_minutes'],['After (min)','buffer_after_minutes']])));
      bindForm('calendar-add',d=>api('scheduling/calendars','POST',d));
      bindForm('staff-add',d=>api('scheduling/staff','POST',d));
      bindForm('resource-add',d=>api('scheduling/resources','POST',d));
      bindForm('type-add',d=>api('scheduling/appointment-types','POST',{name:d.name,durationMinutes:Number(d.durationMinutes),bufferBeforeMinutes:Number(d.bufferBeforeMinutes),bufferAfterMinutes:Number(d.bufferAfterMinutes)}));
      return;
    }
    if (sub === 'availability') {
      const [windows, exceptions] = await Promise.all(['availability-windows','availability-exceptions'].map(key=>api(`scheduling/${key}`)));
      const name = row => owners.find(([key])=>key===`${row.owner_type}:${row.owner_id}`)?.[1] || row.owner_type;
      content.insertAdjacentHTML('beforeend',
        form('window-add','Weekly availability',select('owner','Staff / resource',owners)+select('weekday','Day',[[1,'Monday'],[2,'Tuesday'],[3,'Wednesday'],[4,'Thursday'],[5,'Friday'],[6,'Saturday'],[7,'Sunday']],false)+field('startTime','From','time','09:00','required')+field('endTime','Until','time','17:00','required'))
        + panel('Weekly hours',table(windows,[['For',name],['Weekday','weekday'],['From','start_time'],['Until','end_time']],r=>action('window-delete',r.id,'Remove')))
        + form('exception-add','Date exception',select('owner','Staff / resource',owners)+field('date','Date','date','','required')+select('available','Availability',[['false','Unavailable all day'],['true','Use these hours']],false)+field('startTime','From','time','09:00')+field('endTime','Until','time','17:00')+field('reason','Reason'))
        + panel('Date exceptions',table(exceptions,[['For',name],['Date','date'],['Available',r=>r.available?'Yes':'No'],['Reason','reason']],r=>action('exception-delete',r.id,'Remove')))
        + form('slot-search','Find available times',select('calendarId','Calendar',calendars.map(r=>[r.id,`${r.name} · ${r.timezone}`]))+select('appointmentTypeId','Appointment type',types.map(r=>[r.id,r.name]))+select('staff','Staff',[['any','First available'],...staff.map(r=>[r.id,r.name])],false)+optional('resourceId','Required resource',resources)+field('from','From date','date',local(new Date()).slice(0,10),'required')+field('days','Search days','number','7','min="1" max="30" required')+'<p class="muted wide">Staff and resource hours follow the selected calendar’s timezone. Preparation and cleanup buffers must fit inside those hours.</p>','Find times')+'<div id="available-times"></div>');
      bindForm('window-add',d=>api('scheduling/availability-windows','POST',{...owner(d.owner),weekday:Number(d.weekday),startTime:d.startTime,endTime:d.endTime}));
      bindForm('exception-add',d=>api('scheduling/availability-exceptions','POST',{...owner(d.owner),date:d.date,available:d.available==='true',...(d.available==='true'?{startTime:d.startTime,endTime:d.endTime}:{}),reason:d.reason}));
      bindForm('slot-search',async d=>{
        const query=new URLSearchParams({appointment_type_id:d.appointmentTypeId,calendar_id:d.calendarId,staff:d.staff,from:d.from,days:d.days,limit:'30'});
        if(d.resourceId)query.set('resource_ids',d.resourceId);
        const result=await api(`scheduling/next-available?${query}`);
        content.querySelector('#available-times').innerHTML=panel('Available times',result.slots.length?table(result.slots,[['Staff',r=>staff.find(s=>s.id===r.staff_id)?.name||'Staff'],['Resource',r=>(r.resource_ids||[]).map(id=>resources.find(s=>s.id===id)?.name||'Resource').join(', ')||'None'],['Starts',r=>when(r.starts_at)],['Ends',r=>when(r.ends_at)]])+'<p class="muted">Availability is checked again when booking.</p>':'<p>No matching times. Try another date, staff member, or resource.</p>'); say('Available times checked.');
      },false);
      bindActions(async(a,id)=>{if(a==='window-delete'||a==='exception-delete'){await api(`scheduling/${a==='window-delete'?'availability-windows':'availability-exceptions'}/${id}`,'DELETE');await render();say('Availability updated.');}});
      return;
    }
    const [rows,cs] = await Promise.all([api('scheduling/appointments?limit=200'),customers()]);
    content.insertAdjacentHTML('beforeend',
      (calendars.length?'':form('calendar-add','Create a calendar',field('name','Calendar name','text','','required')+field('timezone','Timezone','text',zone(),'required')))
      + form('appointment-add','Book an appointment',select('calendarId','Calendar',calendars.map(r=>[r.id,r.name]))+select('customerId','Customer',customerOptions(cs))+field('title','Appointment','text','','required')+field('startsAt','Starts','datetime-local','','required')+field('endsAt','Ends','datetime-local','','required')+field('timezone','Timezone','text',zone(),'required')+optional('appointmentTypeId','Appointment type',types)+optional('staffId','Assign staff',staff)+optional('resourceId','Assign resource',resources)+select('frequency','Repeat',[['','Does not repeat'],['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']],false)+field('count','Occurrences','number','1','min="1" max="60" step="1"'),'Book appointment')
      + panel('Appointments',table(rows,[['Appointment','title'],['Starts',r=>when(r.starts_at)],['Ends',r=>when(r.ends_at)],['Staff',r=>r.staff_ids.map(id=>staff.find(s=>s.id===id)?.name||'Staff').join(', ')],['Resource',r=>r.resource_ids.map(id=>resources.find(s=>s.id===id)?.name||'Resource').join(', ')],['Status','status']],r=>action('details',r.id,'Details')+(!['canceled','completed','no_show'].includes(r.status)?action('reschedule',r.id,'Reschedule')+action('complete',r.id,'Complete')+action('cancel',r.id,'Cancel'):''))));
    bindForm('calendar-add',d=>api('scheduling/calendars','POST',d));
    bindForm('appointment-add',d=>api('scheduling/appointments','POST',{calendarId:d.calendarId,customerId:d.customerId,title:d.title,startsAt:d.startsAt,endsAt:d.endsAt,timezone:d.timezone,appointmentTypeId:d.appointmentTypeId||undefined,staffIds:d.staffId?[d.staffId]:[],resourceIds:d.resourceId?[d.resourceId]:[],recurrence:d.frequency?{frequency:d.frequency,count:Number(d.count)}:undefined}));
    bindActions(async(a,id)=>{
      if(a==='cancel'||a==='complete'){await api(`scheduling/appointments/${id}/${a==='cancel'?'cancel':'status'}`,'POST',a==='cancel'?{reason:'Canceled by company owner'}:{status:'completed'});await render();say(a==='cancel'?'Appointment canceled.':'Appointment completed.');}
      if(a==='reschedule'){
        const row=await api(`scheduling/appointments/${id}`);
        append(form('appointment-reschedule',row.schedule_rule_id?'Reschedule this occurrence':'Reschedule appointment',field('startsAt','Starts','datetime-local',local(row.starts_at),'required')+field('endsAt','Ends','datetime-local',local(row.ends_at),'required')+field('timezone','Timezone','text',zone(),'required')+'<p class="muted wide">Staff, resources, and time off are checked before saving.</p>','Reschedule'));
        bindForm('appointment-reschedule',d=>api(`scheduling/appointments/${id}/reschedule`,'POST',d));
      }
      if(a==='details'){
        const row=await api(`scheduling/appointments/${id}`),reminders=await api(`scheduling/appointments/${id}/reminders`);
        append(panel(row.title,`<p>${esc(when(row.starts_at))} – ${esc(when(row.ends_at))}</p><p>Calendar sync: ${esc(row.calendar_sync_status)}.</p><a href="/api/scheduling/calendars/${encodeURIComponent(row.calendar_id)}/ics" download="calendar.ics">Export calendar</a>`)
          +panel('Reminders',table(reminders,[['Send at',r=>when(r.send_at)],['Recipient','recipient'],['Status','status'],['Delivery detail','last_error'],['Next check',r=>when(r.next_attempt_at)]]))
          +(!['canceled','completed','no_show'].includes(row.status)?form('reminder-add','Schedule a reminder',field('sendAt','Send at','datetime-local','','required')+select('channel','Channel',[['email','Email'],['sms','SMS']],false)+field('recipient','Recipient','text','','required')+field('message','Message','text','','required')+'<p class="muted wide">Delivery requires a connected provider.</p>','Schedule reminder'):''));
        bindForm('reminder-add',d=>api(`scheduling/appointments/${id}/reminders`,'POST',{...d,timezone:zone()}));
      }
    });
  };
}
