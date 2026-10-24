import fs from 'node:fs/promises';
import { acceptBusinessControls } from './business-ui-journeys.mjs';
import { acceptOperationsControls } from './business-operations-journeys.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
if(process.argv.length!==4||!process.env.BLACKLABEL_PUPPETEER)throw Error('Provide ARCHIVE, NEW_EVIDENCE_DIRECTORY and BLACKLABEL_PUPPETEER.');
const archive=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
await fs.mkdir(out,{recursive:false,mode:0o700});const extracted=path.join(out,'extracted');await fs.mkdir(extracted);
const entries=execFileSync('/usr/bin/tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
assert(entries.every(p=>!path.isAbsolute(p)&&!p.split('/').includes('..')));const tops=new Set(entries.map(p=>p.split('/')[0]));assert.equal(tops.size,1);
execFileSync('/usr/bin/tar',['-xzf',archive,'-C',extracted]);const unpacked=path.join(extracted,[...tops][0]),installation=path.join(out,'installation');
const installLog=execFileSync('/bin/bash',[path.join(unpacked,'install.sh'),'--root',installation,'--no-service'],{encoding:'utf8',env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});
await fs.writeFile(path.join(out,'installer.log'),installLog);
const app=path.join(installation,'app'),data=path.join(installation,'data'),node=path.join(app,'runtime/bin/node');
const manifest=JSON.parse(await fs.readFile(path.join(app,'manifest.json'),'utf8'));assert.deepEqual(await fs.readdir(data),[]);
const checks=['extracted archive and installer with bundled runtime','empty customer data after installation'];
let child,browser,page,stderr='',base;
async function start(){let stdout='';stderr='';child=spawn(node,[path.join(app,'server.mjs')],{env:{...process.env,BLACKLABEL_BUSINESS_DATA:data,BLACKLABEL_BUSINESS_PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});child.stderr.on('data',b=>stderr+=b);base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Runtime startup timeout: ${stderr}`)),20000);child.once('exit',()=>{clearTimeout(timer);reject(Error(`Runtime exited: ${stderr}`));});child.stdout.on('data',b=>{stdout+=b;for(const line of stdout.split('\n')){try{const r=JSON.parse(line);if(r.ready&&r.url){clearTimeout(timer);resolve(r.url);}}catch{}}});});}
async function stop(){if(!child||child.exitCode!==null)return;const exited=once(child,'exit');child.send({type:'blacklabel:shutdown'});await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Runtime did not shut down gracefully')),10000))]);}
const puppeteer=createRequire(import.meta.url)(process.env.BLACKLABEL_PUPPETEER);
async function submit(selector){await page.click(`${selector} button:not([type=button])`);}
async function nav(key,selector){await page.click(`nav a[data-module="${key}"]`);if(key==='crm')await page.evaluate(()=>{location.hash='/crm/customers';});if(selector)await page.waitForSelector(selector);}
async function read(route){return page.evaluate(async(route)=>{const response=await fetch(`/api/${route}`);const body=await response.json();if(!response.ok)throw Error(body.error?.message||String(response.status));return body.data;},route);}
const browserErrors=[];
try{
  await start();
  browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:path.join(out,'browser-profile'),args:['--no-first-run','--no-default-browser-check']});
  page=await browser.newPage();await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});page.on('pageerror',e=>browserErrors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle0'});await page.type('#login-form [name=token]',(await fs.readFile(path.join(data,'access.token'),'utf8')).trim());await submit('#login-form');
  await page.waitForSelector('#company');await page.type('#company [name=companyName]','Avery Services — acceptance fixture');await submit('#company');
  await page.waitForFunction(()=>document.querySelector('#title')?.textContent==='Overview');checks.push('company sign-in and onboarding through customer forms');
  await nav('crm','#crm-add');await page.type('#crm-add [name=name]','Avery Customer Fixture');await page.type('#crm-add [name=email]','avery@example.test');await submit('#crm-add');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Avery Customer Fixture'));
  const customers=await read('crm/customers');assert.equal(customers.length,1);const customerId=customers[0].id;checks.push('create and read back a customer');
  await nav('quoting','#quote-add');await page.select('#quote-add [name=customerId]',customerId);await page.type('#quote-add [name=title]','Fixture Service Estimate');await page.type('#quote-add [name=description]','Service visit');await page.type('#quote-add [name=price]','125.50');await submit('#quote-add');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Fixture Service Estimate'));await page.click('[data-action=publish]');await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('sent'));
  assert.equal((await read('quoting/quotes'))[0].total_cents,12550);checks.push('quote calculation and customer-portal publication');
  await nav('scheduling','#calendar-add');await page.type('#calendar-add [name=name]','Service calendar');await page.$eval('#calendar-add [name=timezone]',e=>{e.value='America/Chicago';});await submit('#calendar-add');
  await page.waitForFunction(()=>document.querySelector('#appointment-add [name=calendarId]')?.options.length>1);
  const calendarId=await page.$eval('#appointment-add [name=calendarId]',s=>s.options[1].value);await page.select('#appointment-add [name=calendarId]',calendarId);await page.select('#appointment-add [name=customerId]',customerId);await page.type('#appointment-add [name=title]','Fixture Service Visit');
  await page.$eval('#appointment-add [name=startsAt]',e=>{e.value='2027-01-12T10:00';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.$eval('#appointment-add [name=endsAt]',e=>{e.value='2027-01-12T11:00';e.dispatchEvent(new Event('input',{bubbles:true}));});await submit('#appointment-add');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Fixture Service Visit'));assert.equal((await read('scheduling/appointments')).length,1);checks.push('calendar and appointment creation');
  await nav('files','#file-upload');const file=path.join(out,'fixture-document.txt'),fileText='Customer acceptance document, stored and read back.';await fs.writeFile(file,fileText);
  await (await page.$('#file-upload [name=file]')).uploadFile(file);await page.select('#file-upload [name=customer]',customerId);await submit('#file-upload');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('fixture-document.txt'));const files=await read('files/files');assert.equal(files.length,1);
  const downloaded=await page.evaluate(async(id)=>fetch(`/api/files/files/${id}/content`).then(r=>r.text()),files[0].id);assert.equal(downloaded,fileText);checks.push('upload, explicit customer sharing, and exact file download');
  for(const [key,selector] of [['billing','#invoice-add'],['messaging','#conversation-add'],['workflows','#workflow-add'],['portal-customer','#portal-account'],['portal-employee','#employee-add'],['reviews','#testimonial-add'],['industries','[data-action=apply]'],['connections','#company']]){
    await nav(key,selector);assert.equal(await page.$eval('#notice',e=>e.classList.contains('error')),false,`Module error: ${key}`);
  }
  checks.push('all twelve module views are reachable');
  // The team uses an isolated browser session; owner cookies never grant its access.
  await nav('portal-employee','#employee-add');await page.type('#employee-add [name=name]','Casey Team Fixture');await page.type('#employee-add [name=email]','casey@example.test');await submit('#employee-add');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Casey Team Fixture'));
  const worker=(await read('portal-employee/employees')).find(row=>row.email==='casey@example.test');
  await page.type('#checklist-add [name=name]','Service closeout');await page.type('#checklist-add [name=items]','Verify site\nRecord completion');await submit('#checklist-add');
  await page.waitForFunction(()=>[...document.querySelector('#assignment-add [name=templateId]').options].some(row=>row.text==='Service closeout'));
  const template=(await read('portal-employee/checklist-templates'))[0];
  await page.select('#assignment-add [name=employeeId]',worker.id);await page.select('#assignment-add [name=templateId]',template.id);await page.type('#assignment-add [name=title]','Complete fixture site visit');await submit('#assignment-add');
  await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('Complete fixture site visit'));
  const assignment=(await read('portal-employee/assignments'))[0];
  await page.click(`[data-action=access][data-id="${worker.id}"]`);await page.waitForSelector('[data-team-token]');const teamKey=await page.$eval('[data-team-token]',e=>e.textContent.trim());
  const teamContext=await browser.createBrowserContext();const teamPage=await teamContext.newPage();teamPage.on('pageerror',error=>browserErrors.push(error.message));await teamPage.setViewport({width:430,height:932});
  await teamPage.goto(`${base}/team`,{waitUntil:'networkidle0'});await teamPage.type('#team-login [name=token]',teamKey);await teamPage.click('#team-login button');await teamPage.waitForSelector('#clock');
  await teamPage.click('#clock');await teamPage.waitForFunction(()=>document.querySelector('#clock')?.dataset.mode==='out');await teamPage.click('#clock');await teamPage.waitForFunction(()=>document.querySelector('#clock')?.dataset.mode==='in');
  await teamPage.click(`[data-work="${assignment.id}"]`);await teamPage.waitForSelector('#work-status');await teamPage.select('#work-status [name=status]','in_progress');await teamPage.click('#work-status button');await teamPage.waitForFunction(()=>document.querySelector('#notice')?.textContent==='Work status saved.');
  await teamPage.click('[data-check]');await teamPage.waitForFunction(()=>document.querySelector('#notice')?.textContent==='Checklist saved.');
  await teamPage.type('#work-log [name=body]','Fixture site inspected and work recorded.');await teamPage.click('#work-log button');await teamPage.waitForFunction(()=>document.querySelector('#notice')?.textContent==='Work note saved.');
  const png=path.join(out,'fixture-work.png');await fs.writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64'));
  await (await teamPage.$('#work-photo [name=photo]')).uploadFile(png);await teamPage.type('#work-photo [name=caption]','Fixture work photo');await teamPage.click('#work-photo button');await teamPage.waitForFunction(()=>document.querySelector('#notice')?.textContent==='Photo saved and verified.');
  await teamPage.waitForFunction(()=>document.querySelector('.work-photo')?.naturalWidth>0);await teamPage.screenshot({path:path.join(out,'team-work.png'),fullPage:true});
  assert.equal(await teamPage.evaluate(async()=>fetch('/api/crm/customers').then(r=>r.status)),401);
  assert.equal((await read(`portal-employee/assignments/${assignment.id}/logs`)).some(row=>row.body==='Fixture site inspected and work recorded.'),true);
  assert.equal((await read(`portal-employee/assignments/${assignment.id}/checklists`))[0].items[0].checked,true);
  checks.push('isolated team browser signs in, clocks time, updates assigned work, saves checklist and work notes, uploads and renders stored photo, and is denied owner access');
  // Use a separate customer browser and a locally generated fixture link. No provider delivery is claimed.
  const customerSetup=await page.evaluate(async(customerId)=>{const headers={'content-type':'application/json'};const account=await fetch('/api/portal-customer/accounts',{method:'POST',headers,body:JSON.stringify({customerId,name:'Avery Customer Fixture',email:'avery@example.test'})});if(!account.ok)throw Error('Customer fixture account failed');const link=await fetch('/api/portal-customer/auth/request-link',{method:'POST',headers,body:JSON.stringify({email:'avery@example.test'})});if(!link.ok)throw Error('Customer fixture link failed');return (await account.json()).data;},customerId);
  const lookupCode="const Database=require('better-sqlite3');const db=new Database(process.argv[1],{readonly:true});const row=db.prepare('select token from portal_customer_login_tokens where account_id=? and used_at is null order by created_at desc,id limit 1').get(process.argv[2]);process.stdout.write(row.token);db.close();";
  const customerToken=execFileSync(node,['-e',lookupCode,path.join(data,'platform.db'),customerSetup.id],{cwd:app,encoding:'utf8'});
  const customerContext=await browser.createBrowserContext();const customerPage=await customerContext.newPage();customerPage.on('pageerror',error=>browserErrors.push(error.message));await customerPage.setViewport({width:430,height:932});
  await customerPage.goto(`${base}/api/portal-customer/ui/session?token=${encodeURIComponent(customerToken)}`,{waitUntil:'networkidle0'});await customerPage.waitForSelector('form[action$="/approve"] button');
  const [approvalResponse]=await Promise.all([customerPage.waitForNavigation({waitUntil:'networkidle0'}),customerPage.click('form[action$="/approve"] button')]);
  await fs.writeFile(path.join(out,'customer-approval-response.json'),JSON.stringify({status:approvalResponse?.status(),url:customerPage.url(),body:await customerPage.$eval('body',e=>e.textContent)},null,2));
  assert.equal(approvalResponse?.status(),200,'Customer approval browser response');
  assert.equal((await read('quoting/quotes'))[0].status,'approved');
  await nav('quoting','[data-action=convert]');await page.click('[data-action=convert]');await page.waitForFunction(()=>document.querySelector('#content')?.textContent.includes('Job and invoice created'));
  const quoteId=(await read('quoting/quotes'))[0].id;const conversion=await read(`quoting/quotes/${quoteId}/conversion`);assert.equal((await read(`crm/jobs/${conversion.job_id}`)).title,'Fixture Service Estimate');assert.equal((await read(`billing/invoices/${conversion.invoice_id}`)).total_cents,12550);checks.push('approved quote creates a persisted CRM job and exact billing invoice with linked conversion receipt');
  await customerPage.screenshot({path:path.join(out,'customer-portal.png'),fullPage:true});checks.push('isolated customer browser uses a local fixture sign-in link and approves its quote with quoting readback; email delivery is untested');
  await nav('billing','#invoice-add');await page.waitForSelector('[data-action=publish]');await page.click(`[data-action=publish][data-id="${conversion.invoice_id}"]`);await page.waitForSelector('[data-action=payment]');
  const invoice=await read(`billing/invoices/${conversion.invoice_id}`);await page.click(`[data-action=payment][data-id="${conversion.invoice_id}"]`);await page.type('#record-payment [name=amount]','50.25');await page.type('#record-payment [name=reference]','Fixture manual receipt only');await submit('#record-payment');await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('partial'));
  assert.equal((await read(`billing/invoices/${invoice.id}`)).paid_cents,5025);await customerPage.reload({waitUntil:'networkidle0'});assert.match(await customerPage.$eval('body',e=>e.textContent),/75\.25/);checks.push('manual partial payment is recorded exactly and remaining balance appears in the customer portal; no payment processed');
  await customerPage.type('form[action$="/messages"] [name=subject]','Fixture portal follow-up');await customerPage.type('form[action$="/messages"] [name=body]','Please confirm the fixture service arrival window.');
  await Promise.all([customerPage.waitForNavigation({waitUntil:'networkidle0'}),customerPage.click('form[action$="/messages"] button')]);assert.match(await customerPage.$eval('body',e=>e.textContent),/Please confirm the fixture service arrival window/);
  const portalThreads=await read('messaging/conversations');const portalThread=portalThreads.find(t=>t.subject==='Fixture portal follow-up');assert(portalThread);assert.match(JSON.stringify(await read(`messaging/conversations/${portalThread.id}`)),/Please confirm the fixture service arrival window/);checks.push('customer portal message form persists the customer message and relays it into the owner inbox with exact body readback');
  await page.evaluate(async id=>{const r=await fetch(`/api/crm/jobs/${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'completed'})});if(!r.ok)throw Error('Completed synthetic job fixture failed');},conversion.job_id);
  await nav('reviews','#review-request');await page.select('#review-request [name=customerId]',customerId);await submit('#review-request');await page.waitForSelector('[data-action=link]');await page.click('[data-action=link]');await page.waitForSelector('a[href^="/review#"]');const reviewPath=await page.$eval('a[href^="/review#"]',e=>e.getAttribute('href'));
  await customerPage.goto(`${base}${reviewPath}`,{waitUntil:'networkidle0'});await customerPage.select('#review-form [name=rating]','3');await customerPage.type('#review-form [name=comment]','Fixture feedback from the customer browser.');await customerPage.click('#review-form button');await customerPage.waitForFunction(()=>document.querySelector('#review-content h2')?.textContent==='Feedback recorded');assert.equal((await read('reviews/requests'))[0].status,'completed');
  await customerPage.screenshot({path:path.join(out,'customer-feedback.png'),fullPage:true});checks.push('public review form records customer feedback and owner readback');
  await acceptBusinessControls({page,read,customerId,checks,out});
  await acceptOperationsControls({page,read,customerId,checks,out});
  const {acceptModuleOutcomeControls}=await import('./business-module-outcome-journeys.mjs');
  await acceptModuleOutcomeControls({page,customerPage,teamPage,read,customerId,assignment,worker,owner:(await read('business/users'))[0],base,checks,out});
  await teamContext.close();await customerContext.close();
  await nav('dashboard','[data-queue-freshness]');await page.screenshot({path:path.join(out,'dashboard.png'),fullPage:true});
  await nav('recovery','[data-action=backup]');await page.click('[data-action=backup]');await page.waitForFunction(()=>document.body.textContent.includes('Backup created'));
  const backups=(await fs.readdir(path.join(data,'backups'))).filter(n=>n.endsWith('.tar.gz'));assert.equal(backups.length,1);const backup=path.join(data,'backups',backups[0]);checks.push('database and file-vault backup');
  await page.screenshot({path:path.join(out,'backup.png'),fullPage:true});
  // Create a post-backup record, then prove restore removes it and preserves saved data.
  await page.evaluate(async()=>{const r=await fetch('/api/crm/customers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'After backup fixture'})});if(!r.ok)throw Error('Post-backup fixture creation failed');});
  await browser.close();browser=undefined;await stop();
  const restore=execFileSync(node,[path.join(app,'server.mjs'),'restore',backup],{encoding:'utf8',env:{...process.env,BLACKLABEL_BUSINESS_DATA:data},timeout:20000});await fs.writeFile(path.join(out,'restore.log'),restore);assert.equal(JSON.parse(restore).restored,true);
  await start();const token=(await fs.readFile(path.join(data,'access.token'),'utf8')).trim();
  const headers={Authorization:`Bearer ${token}`};const response=await fetch(`${base}/api/crm/customers`,{headers});assert.equal(response.status,200);const restored=await response.json();assert.equal(restored.data.length,1);assert.equal(restored.data[0].id,customerId);
  assert.equal(await fetch(`${base}/api/files/files/${files[0].id}/content`,{headers}).then(r=>r.text()),fileText);checks.push('restart and verified restoration of customer records and file bytes');
  assert.deepEqual(browserErrors,[]);checks.push('no browser page errors');
  const evidence={kind:'installed-business-package-acceptance',checkedAt:new Date().toISOString(),buildId:manifest.buildId,sourceSha256:manifest.sourceSha256,archiveSha256:sha(await fs.readFile(archive)),checks,status:'runtime-and-interface-checks-passed',browserErrors,commercialAcceptance:'pending',unresolved:['All advertised claims and module interactions','Real provider send and delivery acceptance','Shared customer/team access','LaunchAgent installation and upgrade recovery','Verified customer download']};
  await fs.writeFile(path.join(out,'ACCEPTANCE.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}catch(error){if(page&&browser)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(out,'FAILURE.json'),JSON.stringify({error:error.message,stderr,checks,browserErrors,url:page?.url(),notice:page&&browser?await page.$eval('#notice',e=>e.textContent).catch(()=>null):null},null,2));throw error;}
finally{if(browser)await browser.close();await stop();}
