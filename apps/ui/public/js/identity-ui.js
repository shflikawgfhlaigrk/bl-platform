import {setCredential, clearCredential} from './api.js';
const form=document.querySelector('#identity-form');
const status=document.querySelector('#identity-status');
const shell=document.querySelector('#app-shell');
const logout=document.querySelector('#identity-logout');
async function verify(token){
 const response=await fetch('/api/identity',{headers:{authorization:`Bearer ${token}`},cache:'no-store'});
 const data=await response.json();
 if(!response.ok) throw new Error(data.error?.message||'Sign-in credential rejected');
 setCredential(token,data.data);
 form.hidden=true;shell.hidden=false;logout.hidden=false;
}
form.addEventListener('submit',async event=>{
 event.preventDefault();const input=document.querySelector('#identity-token');const token=input.value;input.value='';
 try {await verify(token);location.reload();} catch(error){status.textContent=error.message;}
});
logout.addEventListener('click',()=>{clearCredential();location.reload();});
const token=sessionStorage.getItem('platformCredential');
if(token) verify(token).catch(error=>{clearCredential();status.textContent=error.message;});
