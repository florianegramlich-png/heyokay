/** Alert Desk: human review of severity ≥ 4 and low-confidence events, plus concierge-pilot curation. */
export const DESK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hey-Okay · Alert Desk</title>
<style>
  :root{--navy:#0D1B2A;--teal:#0A7EA4;--bg:#F5F3EE;--card:#FFFDF9;--line:#E2DED5;--muted:#5A6470;--orange:#B8561A}
  *{box-sizing:border-box} body{margin:0;font:15px/1.45 Inter,system-ui,sans-serif;background:var(--bg);color:var(--navy)}
  header{background:var(--navy);color:#F5F3EE;padding:16px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  header h1{font-size:18px;margin:0;flex:1} header input{padding:8px;border-radius:8px;border:0;min-width:220px}
  main{max-width:1100px;margin:0 auto;padding:24px;display:grid;gap:24px}
  section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
  h2{margin:0 0 12px;font-size:16px} .metrics{display:flex;gap:24px;flex-wrap:wrap}
  .metric b{display:block;font-size:22px} .metric span{color:var(--muted);font-size:13px}
  .ev{border-top:1px solid var(--line);padding:14px 0;display:grid;gap:6px} .ev:first-of-type{border-top:0}
  .sev{display:inline-block;min-width:26px;text-align:center;border-radius:6px;color:#fff;font-weight:700;padding:1px 6px}
  .s1,.s2{background:#5A6470}.s3{background:var(--teal)}.s4{background:var(--orange)}.s5{background:#8B1E1E}
  .muted{color:var(--muted);font-size:13px} details pre{white-space:pre-wrap;font-size:12px;background:#f0ede6;padding:10px;border-radius:8px;max-height:220px;overflow:auto}
  input,select,textarea{font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;width:100%}
  button{font:inherit;padding:8px 14px;border-radius:8px;border:0;cursor:pointer;background:var(--teal);color:#fff}
  button.reject{background:#8B1E1E} .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
  label{font-size:13px;color:var(--muted)} .count{font-size:12px;color:var(--muted)}
  table{border-collapse:collapse;width:100%;font-size:13px} td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line)}
  .h-ok{color:var(--teal)} .h-failing{color:#8B1E1E;font-weight:700} .h-stale{color:var(--orange);font-weight:700} .h-waiting{color:var(--muted)}
</style></head><body>
<header><h1>Hey-Okay · Alert Desk</h1><input id="token" type="password" placeholder="Admin token"><button onclick="saveToken()">Connect</button><button onclick="ingest()">Run ingest now</button></header>
<main>
  <section><h2>Last 7 days</h2><div class="metrics" id="metrics">Connect with your admin token.</div></section>
  <section><h2>Waiting for review</h2><p class="muted">Severity 4+ from non-official sources, and anything the AI was unsure about. Nothing here reaches users until approved. Every decision also becomes a label for the AI eval set.</p><div id="pending"></div><p class="row"><button onclick="exportLabels()">Download reviewed cases (eval set)</button><span class="muted">For <code>server/eval/cases/</code>. Remove names and personal details before committing.</span></p></section>
  <section><h2>Sources</h2><p class="muted">Every feed the worker polls, by country. Failing = the last poll failed; stale = no successful poll for 3 intervals. A fallback takes over where one is listed.</p><div id="sources"></div></section>
  <section><h2>Decision log</h2><p class="muted">Every step the pipeline took and every action here: how an item was read (model, prompt version), the review gate, the alert text and the verifier, who got it (as counts), approvals and rejections. No personal data.</p>
    <div class="row"><input id="dEvent" placeholder="Event id (optional)" style="max-width:320px"><select id="dKind" style="max-width:180px"><option value="">All steps</option><option>extract</option><option>review_gate</option><option>compose</option><option>rank</option><option>desk</option></select>
      <button onclick="loadDecisions()">Show</button><button onclick="decisionsCsv()">Download CSV</button></div><div id="decisions"></div></section>
  <section><h2>Active events</h2><p class="muted">Released events that haven't ended. "End now" sends an all-clear to everyone who got the alert.</p><div id="active"></div></section>
  <section><h2>Send a curated alert (concierge pilot)</h2>
    <form id="manual" onsubmit="sendManual(event)">
      <div><label>Category</label><select name="category"><option>transit</option><option>crime</option><option>public_safety</option><option>weather</option><option>health</option><option>infrastructure</option><option>recall</option><option>events</option></select></div>
      <div><label>Severity 1–5</label><input name="severity" type="number" min="1" max="5" value="3"></div>
      <div><label>Title (≤50) <span class="count" id="tc"></span></label><input name="title" maxlength="50" oninput="tc.textContent=this.value.length" required></div>
      <div><label>Body (≤100) <span class="count" id="bc"></span></label><input name="body" maxlength="100" oninput="bc.textContent=this.value.length" required></div>
      <div><label>Source name</label><input name="sourceName" value="Hey-Okay Redaktion" required></div>
      <div><label>Source URL</label><input name="sourceUrl" type="url"></div>
      <div><label>Area name</label><input name="areaName" value="Berlin-Friedrichshain" required></div>
      <div><label>Latitude</label><input name="lat" type="number" step="any" value="52.5155" required></div>
      <div><label>Longitude</label><input name="lon" type="number" step="any" value="13.4549" required></div>
      <div><label>Radius (m)</label><input name="radiusM" type="number" value="1500" required></div>
      <div><label>Language</label><select name="language"><option value="de">Deutsch</option><option value="en">English</option></select></div>
      <div style="align-self:end"><button>Send to affected users</button></div>
    </form><p class="muted" id="manualOut"></p>
  </section>
</main>
<script>
const $=(s)=>document.querySelector(s); let TOKEN=localStorage.getItem('hok_admin')||''; $('#token').value=TOKEN;
function saveToken(){TOKEN=$('#token').value;localStorage.setItem('hok_admin',TOKEN);load();loadDecisions();}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'Content-Type':'application/json','x-admin-token':TOKEN,...(opts.headers||{})}});if(!r.ok)throw new Error(r.status+' '+(await r.text()));return r.json();}
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct=(x)=>x==null?'—':Math.round(x*100)+'%';
async function load(){
  try{
    const m=await api('/admin/api/metrics');
    $('#metrics').innerHTML=[['Alerts',m.alerts],['Pushed',m.pushed],['Rated relevant',pct(m.relevantRate)],['Beyond-NINA rate',pct(m.beyondNinaRate)],['Pushes / user / day',m.pushesPerUserPerDay.toFixed(2)],['Waiting for review',m.pendingReview]]
      .map(([k,v])=>'<div class="metric"><b>'+v+'</b><span>'+k+'</span></div>').join('');
    const ai=await api('/admin/api/ai-usage');
    const eur=(x)=>'€'+(x??0).toFixed(2);
    $('#metrics').innerHTML+=[['AI today',eur(ai.today.eur)+(ai.budgetEur?' / '+eur(ai.budgetEur):'')],['AI calls today',ai.today.calls+(ai.today.skipped?' ('+ai.today.skipped+' over budget → template)':'')],['AI last 30 days',eur(ai.last30Eur)],['AI per user (30 d)',ai.perUser30dEur==null?'—':'€'+ai.perUser30dEur.toFixed(4)]]
      .map(([k,v])=>'<div class="metric"><b>'+v+'</b><span>'+k+'</span></div>').join('');
    const {events}=await api('/admin/api/pending');
    $('#pending').innerHTML=events.length?events.map(e=>\`
      <div class="ev" id="ev-\${e.id}">
        <div><span class="sev s\${e.severity}">\${e.severity}</span> <b>\${esc(e.title)}</b> <span class="muted">· \${esc(e.category)} · \${esc(e.areaName)} · confidence \${Math.round(e.confidence*100)}%</span></div>
        <div class="muted">\${esc(e.summary)}</div>
        <div class="muted">Sources: \${e.sources.map(s=>s.url?'<a href="'+esc(s.url)+'" target="_blank">'+esc(s.sourceName)+'</a>':esc(s.sourceName)).join(', ')}</div>
        <details><summary class="muted">Source text</summary><pre>\${esc(e.facts)}</pre></details>
        <div class="row"><input placeholder="Alert title (optional, ≤50)" maxlength="50" id="t-\${e.id}"><input placeholder="Alert body (optional, ≤100)" maxlength="100" id="b-\${e.id}">
          <select id="s-\${e.id}">\${[1,2,3,4,5].map(n=>'<option '+(n===e.severity?'selected':'')+'>'+n+'</option>').join('')}</select>
          <button onclick="approve('\${e.id}')">Approve &amp; send</button><button class="reject" onclick="reject('\${e.id}')">Reject</button></div>
      </div>\`).join(''):'<p class="muted">Nothing waiting.</p>';
    const {sources}=await api('/admin/api/sources');
    const ago=(t)=>{if(!t)return '—';const m=Math.round((Date.now()-Date.parse(t))/60000);return m<1?'just now':m<60?m+' min ago':Math.round(m/60)+' h ago';};
    $('#sources').innerHTML=sources.length?'<table><tr><th>Source</th><th>Country</th><th>Official</th><th>Health</th><th>Last OK</th><th>Last error</th><th>Fallback</th></tr>'+sources.map(s=>
      '<tr><td>'+(s.docs?'<a href="'+esc(s.docs)+'" target="_blank">'+esc(s.name)+'</a>':esc(s.name))+'<div class="muted">'+esc(s.key)+'</div></td><td>'+esc(s.country==='*'?'all':s.country)+'</td><td>'+(s.official?'yes':'—')+'</td><td class="h-'+s.health+'">'+s.health+'</td><td>'+ago(s.lastOkAt)+'</td><td>'+ago(s.lastErrorAt)+'</td><td>'+esc(s.fallback||'—')+'</td></tr>').join('')+'</table>'
      :'<p class="muted">No status yet. The worker reports after its first poll.</p>';
    const act=(await api('/admin/api/active')).events.filter(e=>e.status==='auto'||e.status==='approved');
    $('#active').innerHTML=act.length?act.map(e=>\`
      <div class="ev"><div class="row"><span class="sev s\${e.severity}">\${e.severity}</span> <b>\${esc(e.copyTitle||e.title)}</b>
        <span class="muted">· \${esc(e.category)} · \${esc((e.areaName||'').slice(0,60))}\${e.endsAt?' · until '+new Date(e.endsAt).toLocaleString():''}</span>
        <button class="reject" onclick="endEvent('\${e.id}')">End now (all clear)</button></div></div>\`).join(''):'<p class="muted">No active events.</p>';
  }catch(e){$('#metrics').textContent='Could not load: '+e.message;}
}
async function endEvent(id){if(!confirm('End this event and send an all-clear?'))return;const r=await api('/admin/api/events/'+id+'/end',{method:'POST'});alert('All-clear: '+r.alerts+' alerts, '+r.pushes+' pushes');load();}
async function approve(id){const t=$('#t-'+id).value,b=$('#b-'+id).value,s=Number($('#s-'+id).value);
  const r=await api('/admin/api/events/'+id+'/approve',{method:'POST',body:JSON.stringify({...(t&&{title:t}),...(b&&{body:b}),severity:s})});
  alert('Sent: '+r.alerts+' alerts, '+r.pushes+' pushes');load();}
function pickEvent(a){$('#dEvent').value=a.dataset.ev;loadDecisions();}
function dQuery(){const p=new URLSearchParams();const e=$('#dEvent').value.trim(),k=$('#dKind').value;if(e)p.set('eventId',e);if(k)p.set('kind',k);return p;}
async function loadDecisions(){const p=dQuery();p.set('limit','100');try{const {decisions}=await api('/admin/api/decisions?'+p);
  $('#decisions').innerHTML=decisions.length?'<table><tr><th>When</th><th>Step</th><th>Outcome</th><th>Event</th><th>Model / prompt</th><th>Detail</th></tr>'+decisions.map(d=>
    '<tr><td>'+esc(new Date(d.at).toLocaleString())+'</td><td>'+esc(d.kind)+(d.actor!=='pipeline'?' <span class="muted">('+esc(d.actor)+')</span>':'')+'</td><td>'+esc(d.outcome)+'</td><td>'+(d.eventId?'<a href="#" data-ev="'+esc(d.eventId)+'" onclick="pickEvent(this);return false">'+esc(d.eventId.slice(0,8))+'</a>':'—')+'</td><td class="muted">'+esc(d.model||'—')+'<br>'+esc(d.promptVersion||'')+'</td><td><details><summary class="muted">'+esc(String(d.detail.reason||d.detail.title||'').slice(0,80)||'show')+'</summary><pre>'+esc(JSON.stringify(d.detail,null,1))+'</pre></details></td></tr>').join('')+'</table>'
    :'<p class="muted">No decisions yet.</p>';}catch(e){$('#decisions').textContent='Could not load: '+e.message;}}
async function decisionsCsv(){try{const r=await fetch('/admin/api/decisions.csv?'+dQuery(),{headers:{'x-admin-token':TOKEN}});if(!r.ok)throw new Error(r.status);
  const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download='decisions-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(a.href);}catch(e){alert('Download failed: '+e.message);}}
async function exportLabels(){try{const f=await api('/admin/api/eval-export');if(!f.cases.length){alert('No reviewed events yet.');return;}
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(f,null,1)],{type:'application/json'}));a.download='desk-'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(a.href);}
  catch(e){alert('Export failed: '+e.message);}}
async function reject(id){await api('/admin/api/events/'+id+'/reject',{method:'POST'});load();}
async function ingest(){const r=await api('/admin/api/ingest',{method:'POST'});alert(JSON.stringify(r,null,1));load();}
async function sendManual(ev){ev.preventDefault();const f=Object.fromEntries(new FormData(ev.target));
  for(const k of ['severity','lat','lon','radiusM'])f[k]=Number(f[k]); if(!f.sourceUrl)delete f.sourceUrl;
  try{const r=await api('/admin/api/manual-alert',{method:'POST',body:JSON.stringify(f)});$('#manualOut').textContent='Sent: '+r.alerts+' alerts, '+r.pushes+' pushes.';load();}
  catch(e){$('#manualOut').textContent='Failed: '+e.message;}}
if(TOKEN){load();loadDecisions();} setInterval(()=>TOKEN&&load(),30000);
</script></body></html>`;
