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
</style></head><body>
<header><h1>Hey-Okay · Alert Desk</h1><input id="token" type="password" placeholder="Admin token"><button onclick="saveToken()">Connect</button><button onclick="ingest()">Run ingest now</button></header>
<main>
  <section><h2>Last 7 days</h2><div class="metrics" id="metrics">Connect with your admin token.</div></section>
  <section><h2>Waiting for review</h2><p class="muted">Severity 4+ from non-official sources, and anything the AI was unsure about. Nothing here reaches users until approved.</p><div id="pending"></div></section>
  <section><h2>Send a curated alert (concierge pilot)</h2>
    <form id="manual" onsubmit="sendManual(event)">
      <div><label>Category</label><select name="category"><option>transit</option><option>crime</option><option>public_safety</option><option>weather</option><option>health</option><option>infrastructure</option></select></div>
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
function saveToken(){TOKEN=$('#token').value;localStorage.setItem('hok_admin',TOKEN);load();}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'Content-Type':'application/json','x-admin-token':TOKEN,...(opts.headers||{})}});if(!r.ok)throw new Error(r.status+' '+(await r.text()));return r.json();}
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct=(x)=>x==null?'—':Math.round(x*100)+'%';
async function load(){
  try{
    const m=await api('/admin/api/metrics');
    $('#metrics').innerHTML=[['Alerts',m.alerts],['Pushed',m.pushed],['Rated relevant',pct(m.relevantRate)],['Beyond-NINA rate',pct(m.beyondNinaRate)],['Pushes / user / day',m.pushesPerUserPerDay.toFixed(2)],['Waiting for review',m.pendingReview]]
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
  }catch(e){$('#metrics').textContent='Could not load: '+e.message;}
}
async function approve(id){const t=$('#t-'+id).value,b=$('#b-'+id).value,s=Number($('#s-'+id).value);
  const r=await api('/admin/api/events/'+id+'/approve',{method:'POST',body:JSON.stringify({...(t&&{title:t}),...(b&&{body:b}),severity:s})});
  alert('Sent: '+r.alerts+' alerts, '+r.pushes+' pushes');load();}
async function reject(id){await api('/admin/api/events/'+id+'/reject',{method:'POST'});load();}
async function ingest(){const r=await api('/admin/api/ingest',{method:'POST'});alert(JSON.stringify(r,null,1));load();}
async function sendManual(ev){ev.preventDefault();const f=Object.fromEntries(new FormData(ev.target));
  for(const k of ['severity','lat','lon','radiusM'])f[k]=Number(f[k]); if(!f.sourceUrl)delete f.sourceUrl;
  try{const r=await api('/admin/api/manual-alert',{method:'POST',body:JSON.stringify(f)});$('#manualOut').textContent='Sent: '+r.alerts+' alerts, '+r.pushes+' pushes.';load();}
  catch(e){$('#manualOut').textContent='Failed: '+e.message;}}
if(TOKEN)load(); setInterval(()=>TOKEN&&load(),30000);
</script></body></html>`;
