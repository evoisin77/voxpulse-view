const $ = (s) => document.querySelector(s);
const state = { campaigns: [], stats: {}, events: [] };
let toastTimer;
function toast(message) { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),3500); }
async function api(url, options={}) {
 const headers = new Headers(options.headers || {});
 if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type","application/json");
 const response = await fetch(url,{...options,headers,credentials:"same-origin"});
 const data = await response.json().catch(()=>({error:"Unexpected server response."}));
 if (!response.ok) { if(response.status===401) showLogin(); throw new Error(data.error || "Request failed."); }
 return data;
}
function showLogin(){ $("#appView").classList.add("hidden"); $("#setupView").classList.add("hidden"); $("#loginView").classList.remove("hidden"); }
function showSetup(){ $("#appView").classList.add("hidden"); $("#loginView").classList.add("hidden"); $("#setupView").classList.remove("hidden"); }
function showApp(username){ $("#loginView").classList.add("hidden"); $("#setupView").classList.add("hidden"); $("#appView").classList.remove("hidden"); $("#userName").textContent=username||"Admin"; }
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function fmtDate(v){if(!v)return "—"; const d=new Date(v.includes("T")?v:v.replace(" ","T")+"Z");return Number.isNaN(d.getTime())?"—":d.toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}
async function refresh(){
 const data=await api("/api/summary"); state.campaigns=data.campaigns||[];state.stats=data.stats||{};
 $("#statCampaigns").textContent=state.stats.campaigns||0;$("#statRunning").textContent=state.stats.running||0;$("#statLeads").textContent=state.stats.leads||0;$("#statCalls").textContent=state.stats.activeCalls||0;$("#navCampaignCount").textContent=state.campaigns.length;
 renderCampaigns(); await loadEvents();
}
function renderCampaigns(){
 const q=$("#campaignSearch").value.trim().toLowerCase();
 const rows=state.campaigns.filter(c=>c.name.toLowerCase().includes(q)||c.provider.toLowerCase().includes(q));
 $("#tableCount").textContent=rows.length+" campaign"+(rows.length===1?"":"s");
 $("#campaignRows").innerHTML=rows.length?rows.map(c=>`<tr><td><div class="campaign-name"><span class="campaign-icon">◉</span><div>${esc(c.name)}<span class="subline">Created ${esc(fmtDate(c.created_at))}</span></div></div></td><td>${esc(c.provider)}</td><td>—<span class="subline">${esc(c.lead_list||"No list assigned")}</span></td><td>${c.channels}</td><td>${esc(fmtDate(c.last_dial_at))}</td><td><span class="status-pill ${c.status==="running"?"good":"stopped"}">${esc(c.status==="running"?"Running":"Stopped")}</span></td><td><button class="btn outline" data-edit="${c.id}">Edit</button> <button class="btn outline" data-delete-campaign="${c.id}">Delete</button></td></tr>`).join(""):'<tr><td colspan="7" class="empty-cell">No campaigns yet. Select “New campaign” to create your first one.</td></tr>';
 $("#campaignRows").querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>editCampaign(Number(b.dataset.edit))));
 $("#campaignRows").querySelectorAll("[data-delete-campaign]").forEach(b=>b.addEventListener("click",async()=>{
   const c=state.campaigns.find(x=>x.id===Number(b.dataset.deleteCampaign));
   if(!c || !confirm("Delete campaign '"+c.name+"' and all its imported leads? This cannot be undone.")) return;
   try {
     await api("/api/campaigns/"+c.id+"/action",{method:"POST",body:JSON.stringify({action:"delete"})});
     await refresh();
     toast("Campaign deleted.");
   } catch(e) { toast(e.message); }
 }));
}
async function loadEvents(){try{state.events=await api("/api/events");$("#activityList").innerHTML=state.events.length?state.events.slice(0,5).map(e=>`<div class="activity-item"><span class="activity-dot">✦</span><div class="activity-copy"><b>${esc(e.kind.replaceAll("_"," "))}</b><small>${esc(e.detail||"Campaign management event")} · ${esc(fmtDate(e.created_at))}</small></div></div>`).join(""):'<div class="empty-state">Your campaign activity will appear here.</div>';}catch{}}
function openModal(id){$(id).classList.remove("hidden");}
function closeModals(){$$(".modal").forEach(m=>m.classList.add("hidden"));}
function $$(s){return [...document.querySelectorAll(s)];}
function editCampaign(id){const c=state.campaigns.find(x=>x.id===id);if(!c)return;const f=$("#campaignForm");for(const k of ["id","name","provider","message","lead_list","channels","ring_time","answer_time"])f.elements[k].value=c[k]??"";f.elements.caller_ids.value=(c.caller_ids||(c.caller_id?[c.caller_id]:[])).join(", ");$("#ivrFile").value="";const p=$("#ivrPreview");if(c.ivr_url){p.src=c.ivr_url;p.classList.remove("hidden");}else{p.removeAttribute("src");p.classList.add("hidden");}$("#modalTitle").textContent="Edit campaign";$("#formError").textContent="";openModal("#campaignModal");}
function newCampaign(){const f=$("#campaignForm");f.reset();f.elements.id.value="";f.elements.channels.value=1;f.elements.ring_time.value=30;f.elements.answer_time.value=120;$("#ivrPreview").removeAttribute("src");$("#ivrPreview").classList.add("hidden");$("#modalTitle").textContent="Create campaign";$("#formError").textContent="";openModal("#campaignModal");}
$("#ivrFile").addEventListener("change",()=>{const file=$("#ivrFile").files[0],p=$("#ivrPreview");if(file){p.src=URL.createObjectURL(file);p.classList.remove("hidden");}else{p.removeAttribute("src");p.classList.add("hidden");}});
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();$("#loginError").textContent="";const f=new FormData(e.currentTarget);try{const d=await api("/api/login",{method:"POST",body:JSON.stringify({username:f.get("username"),password:f.get("password")})});showApp(d.username);await refresh();}catch(err){$("#loginError").textContent=err.message;}});
$("#logoutBtn").addEventListener("click",async()=>{try{await api("/api/logout",{method:"POST"});}catch{}showLogin();});
$("#newCampaignBtn").addEventListener("click",newCampaign);
$("#refreshBtn").addEventListener("click",()=>refresh().then(()=>toast("Campaigns refreshed.")).catch(e=>toast(e.message)));
$("#campaignSearch").addEventListener("input",renderCampaigns);
$("#campaignForm").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),id=f.get("id"),body={};["name","provider","message","lead_list"].forEach(k=>body[k]=f.get(k));body.caller_ids=String(f.get("caller_ids")||"").split(/[\\n,;]+/).map(x=>x.trim()).filter(Boolean);["channels","ring_time","answer_time"].forEach(k=>body[k]=Number(f.get(k)));try{const saved=await api(id?"/api/campaigns/"+id:"/api/campaigns",{method:id?"PATCH":"POST",body:JSON.stringify(body)});const file=$("#ivrFile").files[0];if(file){const fd=new FormData();fd.append("file",file);const response=await fetch("/api/campaigns/"+saved.id+"/ivr",{method:"POST",body:fd,credentials:"same-origin"}),data=await response.json();if(!response.ok)throw new Error(data.error||"Audio upload failed.");}closeModals();await refresh();toast(id?"Campaign updated.":"Campaign created.");}catch(err){$("#formError").textContent=err.message;}});
$("#leadForm").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const id=f.get("campaign_id");const d=await api("/api/campaigns/"+id+"/leads",{method:"POST",body:f});closeModals();await refresh();toast(`Imported ${d.added} unique leads.`);}catch(err){$("#leadError").textContent=err.message;}});
$$("[data-close]").forEach(el=>el.addEventListener("click",closeModals));
$("#viewEventsBtn").addEventListener("click",()=>toast(state.events.length?state.events.length+" recent events loaded.":"No events yet."));

async function renderPage(page){
 const labels={overview:"Overview",campaigns:"Campaigns",leads:"Lead lists",reports:"Reports",providers:"SIP providers",settings:"Settings"};
 $("#crumbName").textContent=labels[page]||"Overview";
 $("#overviewWorkspace").classList.toggle("hidden",!["overview","campaigns"].includes(page));
 const w=$("#managementWorkspace");
 w.classList.toggle("hidden",["overview","campaigns"].includes(page));
 if(["overview","campaigns"].includes(page)){
   $("#pageTitle").textContent=page==="campaigns"?"Campaigns":"Campaign overview";
   $("#pageSubtitle").textContent=page==="campaigns"?"Create, edit and organize campaigns.":"Monitor campaign and lead activity.";
   $("#newCampaignBtn").classList.remove("hidden");
   return;
 }
 $("#newCampaignBtn").classList.add("hidden");
 $("#pageTitle").textContent=labels[page]||page;
 $("#pageSubtitle").textContent="Management console · Live dialing remains disabled.";
 w.innerHTML='<div class="panel"><p>Loading '+esc(labels[page]||page)+'…</p></div>';
 try{
  if(page==="providers"){
   const rows=await api("/api/providers");
   w.innerHTML=`<div class="panel"><div class="panel-head"><div><h2>SIP providers</h2><p class="muted">Store trunk details for configuration. No calls are placed.</p></div></div>
   <form id="providerForm"><div class="form-grid">
   <label>Provider name<input name="name" required maxlength="80"></label><label>SIP host<input name="host" required maxlength="255" placeholder="sip.provider.example"></label>
   <label>Port<input name="port" type="number" min="1" max="65535" value="5060" required></label>
   <label>Transport<select name="transport"><option>udp</option><option>tcp</option><option>tls</option></select></label>
   <label>Username<input name="username" maxlength="120"></label><label>Secret/password<input name="secret" type="password" autocomplete="new-password"></label></div>
   <p class="tiny muted">Secrets are encrypted at rest. Keep this page private.</p><div id="providerError" class="error"></div><button class="btn primary">Save provider</button></form></div>
   <div class="table-card"><div class="table-wrap"><table><thead><tr><th>NAME</th><th>HOST</th><th>PORT</th><th>TRANSPORT</th><th>USERNAME</th><th>SECRET</th><th></th></tr></thead><tbody>
   ${rows.length?rows.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.host)}</td><td>${p.port}</td><td>${esc(p.transport)}</td><td>${esc(p.username||"—")}</td><td>${p.hasSecret?"Saved":"Not set"}</td><td><button class="btn outline" data-del-provider="${p.id}">Delete</button></td></tr>`).join(""):'<tr><td colspan="7">No providers configured.</td></tr>'}
   </tbody></table></div></div>`;
   $("#providerForm").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),b=Object.fromEntries(f);b.port=Number(b.port);try{await api("/api/providers",{method:"POST",body:JSON.stringify(b)});toast("Provider saved.");renderPage("providers");}catch(err){$("#providerError").textContent=err.message;}});
   w.querySelectorAll("[data-del-provider]").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("Delete this provider configuration?"))return;try{await api("/api/providers/"+b.dataset.delProvider,{method:"DELETE"});renderPage("providers");}catch(e){toast(e.message);}}));
  } else if(page==="settings"){
   const a=await api("/api/settings");
   w.innerHTML=`<div class="panel"><h2>Asterisk Manager Interface (AMI)</h2><p class="muted">Save connection details and test TCP reachability. Use a restricted AMI account; never expose AMI publicly.</p>
   <form id="amiForm"><div class="form-grid"><label>AMI host<input name="host" value="${esc(a.amiHost)}" required></label><label>AMI port<input name="port" type="number" min="1" max="65535" value="${esc(a.amiPort)}" required></label><label>AMI username<input name="username" value="${esc(a.amiUsername)}" required></label><label>AMI secret<input name="secret" type="password" autocomplete="new-password" placeholder="${a.hasAmiSecret?"Saved; blank keeps existing secret":"Enter secret"}"></label></div><p class="tiny muted">TCP test does not verify AMI login. Calls remain disabled regardless of test result.</p><div id="amiError" class="error"></div><button class="btn primary">Save AMI settings</button> <button type="button" id="amiTest" class="btn outline">Test TCP connection</button></form>
   <hr><h2>Safety status</h2><p>Live dialing: <b>Disabled</b></p><p>Channel limit: ${a.maxChannels}</p><p>Consent and DND enforcement must be implemented and verified before any live dialing is enabled.</p></div>
   <div class="panel"><h2>Do-not-call list</h2><form id="dndForm"><div class="form-grid"><label>Phone number<input name="phone" required placeholder="+234…"></label><label>Reason (optional)<input name="reason" maxlength="200"></label></div><div id="dndError" class="error"></div><button class="btn primary">Add number</button></form><div id="dndRows">Loading…</div></div>`;
   $("#amiForm").addEventListener("submit",async e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.currentTarget));b.port=Number(b.port);try{await api("/api/settings/ami",{method:"PUT",body:JSON.stringify(b)});$("#amiError").textContent="Settings saved.";e.currentTarget.elements.secret.value="";}catch(err){$("#amiError").textContent=err.message;}});
   $("#amiTest").addEventListener("click",async()=>{try{const d=await api("/api/settings/ami-test",{method:"POST",body:"{}"});$("#amiError").textContent=d.note;}catch(e){$("#amiError").textContent=e.message;}});
   async function loadDnd(){const ds=await api("/api/dnd");$("#dndRows").innerHTML=ds.length?'<div class="table-wrap"><table><thead><tr><th>PHONE</th><th>REASON</th><th></th></tr></thead><tbody>'+ds.map(d=>`<tr><td>${esc(d.phone)}</td><td>${esc(d.reason)}</td><td><button class="btn outline" data-dnd-del="${d.id}">Remove</button></td></tr>`).join("")+'</tbody></table></div>':'<p class="muted">No DND entries yet.</p>';$("#dndRows").querySelectorAll("[data-dnd-del]").forEach(b=>b.addEventListener("click",async()=>{try{await api("/api/dnd/"+b.dataset.dndDel,{method:"DELETE"});loadDnd();}catch(e){toast(e.message);}}));}
   $("#dndForm").addEventListener("submit",async e=>{e.preventDefault();try{await api("/api/dnd",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});e.currentTarget.reset();$("#dndError").textContent="";loadDnd();}catch(err){$("#dndError").textContent=err.message;}});
   loadDnd();
  } else if(page==="reports"){
   const r=await api("/api/reports"),t=r.totals||{};
   w.innerHTML=`<div class="stats-grid"><article class="stat-card"><div class="stat-top">Total leads</div><div class="stat-value">${t.total||0}</div></article><article class="stat-card"><div class="stat-top">Queued</div><div class="stat-value">${t.queued||0}</div></article><article class="stat-card"><div class="stat-top">Answered (recorded)</div><div class="stat-value">${t.answered||0}</div></article><article class="stat-card"><div class="stat-top">Failed (recorded)</div><div class="stat-value">${t.failed||0}</div></article></div>
   <div class="table-card"><div class="table-wrap"><table><thead><tr><th>CAMPAIGN</th><th>PROVIDER</th><th>STATUS</th><th>LEADS</th><th>QUEUED</th><th>ANSWERED</th><th>FAILED</th></tr></thead><tbody>${r.byCampaign.length?r.byCampaign.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.provider)}</td><td>${esc(c.status)}</td><td>${c.leads||0}</td><td>${c.queued||0}</td><td>${c.answered||0}</td><td>${c.failed||0}</td></tr>`).join(""):'<tr><td colspan="7">No campaign data yet.</td></tr>'}</tbody></table></div></div>
   <div class="panel"><h2>Recent events</h2>${r.events.length?r.events.map(e=>`<div class="activity-item"><div class="activity-copy"><b>${esc(e.kind.replaceAll("_"," "))}</b><small>${esc(e.detail)} · ${esc(fmtDate(e.created_at))}</small></div></div>`).join(""):'<p class="muted">No events recorded yet.</p>'}</div>`;
  } else if(page==="leads"){
   const rows=await api("/api/lead-lists");
   w.innerHTML=`<div class="panel"><h2>Lead lists</h2><p class="muted">Lead lists are grouped under campaigns. Import CSV through the existing campaign import workflow.</p><button id="openLeadImport" class="btn primary">Import CSV</button></div><div class="table-card"><div class="table-wrap"><table><thead><tr><th>CAMPAIGN</th><th>LIST NAME</th><th>TOTAL</th><th>QUEUED</th><th>ANSWERED</th><th>FAILED</th></tr></thead><tbody>${rows.length?rows.map(c=>`<tr><td>${esc(c.campaign)}</td><td>${esc(c.listName||"Default list")}</td><td>${c.total||0}</td><td>${c.queued||0}</td><td>${c.answered||0}</td><td>${c.failed||0}</td></tr>`).join(""):'<tr><td colspan="6">Create a campaign to begin importing leads.</td></tr>'}</tbody></table></div></div>`;
   $("#openLeadImport").addEventListener("click",()=>{const sel=$("#leadCampaign");sel.innerHTML=state.campaigns.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");if(!state.campaigns.length){toast("Create a campaign first.");return;}$("#leadError").textContent="";$("#leadForm").reset();openModal("#leadModal");});
  }
 }catch(e){w.innerHTML=`<div class="panel"><h2>Could not load ${esc(labels[page]||page)}</h2><p class="error">${esc(e.message)}</p><button class="btn outline" id="retryPage">Retry</button></div>`;$("#retryPage").addEventListener("click",()=>renderPage(page));}
}
$$(".nav-item").forEach(btn=>btn.addEventListener("click",()=>{
 $$(".nav-item").forEach(x=>x.classList.remove("active"));btn.classList.add("active");
 renderPage(btn.dataset.page);
}));
async function boot(){try{const s=await api("/api/session");if(s.setupRequired){showSetup();return;}if(s.authenticated){showApp(s.username);await refresh();}else showLogin();}catch{showSetup();}}
boot();
