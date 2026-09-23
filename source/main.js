import { initializeApp } from "firebase/app";
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, setDoc, deleteDoc, collection, onSnapshot, writeBatch } from "firebase/firestore";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "firebase/auth";

const $ = (s,r=document)=>r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => "$" + (Math.round(n*100)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const signed = n => { n=Math.round(n*100)/100; return (n<0?"−":n>0?"+":"")+money(Math.abs(n)); };
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const plural = (n,w,p) => `${n} ${n===1?w:(p||w+"s")}`;

/* ---------- dates (all local time) ---------- */
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parseYmd = s => { const [y,m,d]=String(s).split("-").map(Number); return new Date(y,m-1,d); };
const startOfDay = d => new Date(d.getFullYear(),d.getMonth(),d.getDate());
const addDays = (d,n) => new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const daysBetween = (a,b) => Math.round((startOfDay(b)-startOfDay(a))/86400000);
const daysInMonth = (y,m) => new Date(y,m+1,0).getDate();
const toLocalInput = iso => { const d=new Date(iso); return ymd(d)+"T"+pad(d.getHours())+":"+pad(d.getMinutes()); };
const fmtMD = d => d.toLocaleDateString("en-US",{month:"short",day:"numeric"});
const fmtMDY = d => d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
const fmtRange = (a,b) => a.getFullYear()===b.getFullYear() ? `${fmtMD(a)} – ${fmtMD(b)}, ${b.getFullYear()}` : `${fmtMDY(a)} – ${fmtMDY(b)}`;
const today = () => startOfDay(new Date());

const PERIODS = ["day","week","month","year"];
function periodRange(p,a){
  a=startOfDay(a); const y=a.getFullYear(), m=a.getMonth();
  if(p==="day") return {from:a,to:addDays(a,1)};
  if(p==="week"){ const f=addDays(a,-a.getDay()); return {from:f,to:addDays(f,7)}; }
  if(p==="month") return {from:new Date(y,m,1),to:new Date(y,m+1,1)};
  return {from:new Date(y,0,1),to:new Date(y+1,0,1)};
}
function shiftAnchor(p,a,n){
  if(p==="day") return addDays(a,n);
  if(p==="week") return addDays(a,7*n);
  if(p==="month") return new Date(a.getFullYear(),a.getMonth()+n,1);
  return new Date(a.getFullYear()+n,0,1);
}
function isCurrent(p,a){ const r=periodRange(p,a), t=new Date(); return t>=r.from && t<r.to; }
function periodLabel(p,a){
  const r=periodRange(p,a), thisYear=new Date().getFullYear();
  if(p==="day"){ const o={weekday:"short",month:"short",day:"numeric"}; if(a.getFullYear()!==thisYear) o.year="numeric"; return a.toLocaleDateString("en-US",o); }
  if(p==="week"){ const e=addDays(r.to,-1); return r.from.getMonth()===e.getMonth() ? `${fmtMD(r.from)} – ${e.getDate()}` : `${fmtMD(r.from)} – ${fmtMD(e)}`; }
  if(p==="month") return a.toLocaleDateString("en-US",{month:"long",year:"numeric"});
  return String(a.getFullYear());
}
function periodNoun(p,a){
  if(isCurrent(p,a)) return {day:"today",week:"this week",month:"this month",year:"this year"}[p];
  return p==="day"?"on "+periodLabel(p,a):"in "+periodLabel(p,a);
}

/* ---------- starfield ---------- */
(function stars(){
  const c=$("#stars"), ctx=c.getContext("2d"); let pts=[], raf;
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function size(){
    const dpr=Math.min(2,window.devicePixelRatio||1); c.width=innerWidth*dpr; c.height=innerHeight*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
    const n=Math.round(innerWidth*innerHeight/2600); pts=[];
    for(let i=0;i<n;i++) pts.push({x:Math.random()*innerWidth,y:Math.random()*innerHeight,r:Math.random()<.08?1.4:Math.random()*.9+.2,a:Math.random()*.7+.25,tw:Math.random()<.18,ph:Math.random()*6.28,hue:Math.random()<.15?(Math.random()<.5?"190,230,255":"215,190,255"):"255,255,255"});
    draw(0);
  }
  function draw(t){
    ctx.clearRect(0,0,innerWidth,innerHeight);
    for(const p of pts){ const a=p.tw?p.a*(.55+.45*Math.sin(t/900+p.ph)):p.a; ctx.fillStyle=`rgba(${p.hue},${a})`; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.283); ctx.fill(); }
  }
  function loop(t){ draw(t); raf=setTimeout(()=>requestAnimationFrame(loop),80); }
  size(); addEventListener("resize",()=>{clearTimeout(raf);size();if(!reduce)loop(0);});
  if(!reduce) requestAnimationFrame(loop);
})();

/* ---------- storage: Firebase ----------
   Data lives at users/{uid}/{collection}/{id}. Firestore keeps its own offline copy;
   a small localStorage copy lets the page draw instantly before sign-in resolves. */
const COLLS = ["purchases","saved","categories","income","budgets","recurring"];
const state = Object.fromEntries(COLLS.map(k=>[k,{}]));
let user = null, online = navigator.onLine, pendingSync = false;
const CACHE_PREFIX = "ledger-cache-", LAST_UID = "ledger-last-uid";
function readLS(k){ try{ const r=localStorage.getItem(k); return r?JSON.parse(r):null; }catch(e){ return null; } }
function writeCache(){ if(!user) return; try{ localStorage.setItem(CACHE_PREFIX+user.uid, JSON.stringify(state)); }catch(e){} }

const fbApp = initializeApp(window.LEDGER_FIREBASE_CONFIG);
let fdb;
try{ fdb = initializeFirestore(fbApp,{ localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch(e){ fdb = getFirestore(fbApp); }
const auth = getAuth(fbApp);

function put(coll,id,body){
  state[coll][id] = body; writeCache();
  if(!user) return Promise.resolve();
  return setDoc(doc(fdb,"users",user.uid,coll,id), body).catch(()=>toast("Couldn't save — try again"));
}
function del(coll,id){
  delete state[coll][id]; writeCache();
  if(!user) return Promise.resolve();
  return deleteDoc(doc(fdb,"users",user.uid,coll,id)).catch(()=>toast("Couldn't delete — try again"));
}

/* ---------- ui state ---------- */
const ui = {
  view:"home", period:"month", anchor:today(),
  filter:null,           // history filter: {from,to,cat,title,back}
  avg:{preset:"month"},  // averages range
  confirm:null, catEdit:null, catConfirm:null, catAdd:false
};

/* ---------- queries ---------- */
const rows = coll => Object.entries(state[coll]).map(([id,x])=>({id,...x}));
const inRange = (ts,from,to) => { const t=new Date(ts); return t>=from && t<to; };
const sum = a => a.reduce((s,x)=>s+(+x.amount||0),0);
function purchasesIn(from,to,cat){ return rows("purchases").filter(p=>inRange(p.ts,from,to)&&(!cat||p.category===cat)).sort((a,b)=>b.ts.localeCompare(a.ts)); }
function incomeIn(from,to){ return rows("income").filter(p=>inRange(p.ts,from,to)).sort((a,b)=>b.ts.localeCompare(a.ts)); }
function categoriesList(){
  const names = new Set(Object.values(state.categories).map(c=>c.name));
  for(const k of ["purchases","saved","recurring","budgets"]) Object.values(state[k]).forEach(p=>p.category&&names.add(p.category));
  return [...names].sort((a,b)=>a.localeCompare(b));
}
function addCategory(v){
  v=(v||"").trim().replace(/\s+/g," ");
  if(!v) return null;
  const existing = categoriesList().find(c=>c.toLowerCase()===v.toLowerCase());
  if(existing) return existing;
  put("categories", uid(), {name:v});
  return v;
}
function usage(name){
  const n=k=>Object.values(state[k]).filter(x=>x.category===name).length;
  return {p:n("purchases"),s:n("saved"),r:n("recurring"),b:n("budgets")};
}

/* ---------- recurring ---------- */
const FREQS = {weekly:"Weekly",biweekly:"Every 2 weeks",monthly:"Monthly",yearly:"Yearly"};
const PER_MONTH = {weekly:52/12,biweekly:26/12,monthly:1,yearly:1/12};
function advance(d,freq,anchorDay){
  if(freq==="weekly") return addDays(d,7);
  if(freq==="biweekly") return addDays(d,14);
  if(freq==="monthly"){ const y=d.getFullYear(), m=d.getMonth()+1; return new Date(y,m,Math.min(anchorDay,daysInMonth(y,m))); }
  const y=d.getFullYear()+1, m=d.getMonth(); return new Date(y,m,Math.min(anchorDay,daysInMonth(y,m)));
}
// Log every charge whose date has arrived. Purchase ids are derived from the charge date,
// so two devices doing this at once write the same documents instead of duplicates.
let serverSynced = {};
function processRecurring(){
  if(!user || !serverSynced.recurring || !serverSynced.purchases) return;
  const t=today(); let posted=0;
  for(const r of rows("recurring")){
    if(r.paused || !r.next) continue;
    let next=parseYmd(r.next), guard=0;
    if(next>t) continue;
    while(next<=t && guard++<400){
      const pid="rec-"+r.id+"-"+ymd(next).replace(/-/g,"");
      if(!state.purchases[pid]){
        put("purchases",pid,{category:r.category,amount:r.amount,note:r.name||"",ts:new Date(next.getFullYear(),next.getMonth(),next.getDate(),9).toISOString(),fromRecurring:r.id});
        posted++;
      }
      next=advance(next,r.freq,r.day||next.getDate());
    }
    const {id,...body}=r; put("recurring",id,{...body,next:ymd(next)});
  }
  if(posted){ toast(`Logged ${plural(posted,"recurring charge")}`); render(); }
}

/* ---------- category rename / delete ---------- */
async function renameCategory(oldName,newName){
  newName=(newName||"").trim().replace(/\s+/g," ");
  if(!newName||newName===oldName){ render(); return; }
  const existing = categoriesList().find(c=>c.toLowerCase()===newName.toLowerCase()&&c!==oldName);
  const target = existing || newName;
  const runs=[]; let hasDoc=false;
  for(const [id,c] of Object.entries(state.categories)){
    if(c.name===oldName){ if(existing||hasDoc) runs.push(del("categories",id)); else { hasDoc=true; runs.push(put("categories",id,{name:target})); } }
  }
  if(!hasDoc&&!existing) runs.push(put("categories",uid(),{name:target}));
  for(const k of ["purchases","saved","recurring","budgets"])
    for(const [id,x] of Object.entries(state[k])) if(x.category===oldName) runs.push(put(k,id,{...x,category:target}));
  render(); await Promise.all(runs);
  toast(existing?`Merged into ${target}`:`Renamed to ${target}`);
}
async function deleteCategory(name){
  const runs=[];
  for(const [id,c] of Object.entries(state.categories)) if(c.name===name) runs.push(del("categories",id));
  for(const k of ["purchases","saved","recurring","budgets"])
    for(const [id,x] of Object.entries(state[k])) if(x.category===name) runs.push(del(k,id));
  render(); await Promise.all(runs); toast(`Deleted ${name}`);
}

/* ---------- icons ---------- */
const chevL='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>';
const chevR='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 5 5-5 5"/></svg>';
const planet='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="5.5"/><ellipse cx="12" cy="12" rx="11" ry="3.6" transform="rotate(-20 12 12)"/></svg>';
const ICON = {
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/></svg>',
  budgets:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12l6 6"/></svg>',
  averages:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20h16"/><path d="M7 16v-5M12 16V7M17 16v-8"/></svg>',
  recurring:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5"/><path d="M4 20v-4.5h4.5"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
};

/* ---------- render ---------- */
let pendingRender=false;
function render(){ if(pendingRender) return; pendingRender=true; requestAnimationFrame(()=>{ pendingRender=false; paint(); }); }
function paint(){
  const app=$("#app"), focusId=document.activeElement&&document.activeElement.id;
  const v=ui.view;
  app.innerHTML = v==="history"?historyHTML() : v==="earned"?earnedHTML() : v==="saved"?savedHTML()
    : v==="budgets"?budgetsHTML() : v==="averages"?averagesHTML() : v==="recurring"?recurringHTML() : homeHTML();
  paintTabs();
  if(ui.catAdd){ const i=$("#cat-new"); if(i&&focusId!=="cat-new") i.focus(); }
  if(ui.catEdit){ const i=$("#cat-rename"); if(i&&document.activeElement!==i){ i.focus(); i.setSelectionRange(i.value.length,i.value.length); } }
}
function paintTabs(){
  const t=$("#tabs"); if(!user){ t.hidden=true; return; }
  t.hidden=false;
  const tab=({history:ui.filter&&ui.filter.back==="budgets"?"budgets":"home",earned:"home",saved:"home"})[ui.view]||ui.view;
  const b=(k,label)=>`<button class="tab ${tab===k?"on":""}" data-act="tab" data-tab="${k}" ${tab===k?'aria-current="page"':""}>${ICON[k]}<span>${label}</span></button>`;
  t.innerHTML = `<div class="tabs-in">${b("home","Home")}${b("budgets","Budgets")}
    <button class="fab" data-act="add" aria-label="Add">${ICON.plus}</button>
    ${b("averages","Averages")}${b("recurring","Recurring")}</div>`;
}
const topbar = (extra="") => `<div class="top"><div class="brand">${planet}Ledger</div>${extra}</div>`;
const back = (to="home",label="Overview") => `<button class="back" data-act="go" data-view="${to}">${chevL} ${label}</button>`;
const confirmBtns = (yes,id) => `<span class="confirm"><button class="mini yes" data-act="${yes}" data-id="${esc(id)}">Delete</button><button class="mini" data-act="nope">Keep</button></span>`;

function periodControls(){
  const cur=isCurrent(ui.period,ui.anchor);
  return `<div class="seg" role="tablist" aria-label="Time period">${PERIODS.map(p=>`<button role="tab" aria-selected="${ui.period===p}" data-act="period" data-p="${p}">${p[0].toUpperCase()+p.slice(1)}</button>`).join("")}</div>
    <div class="pnav">
      <button class="icon-btn" data-act="prev" aria-label="Previous ${ui.period}">${chevL}</button>
      <div class="lbl">${esc(periodLabel(ui.period,ui.anchor))}${cur?"":` <button class="today" data-act="today">Today</button>`}</div>
      <button class="icon-btn" data-act="next" aria-label="Next ${ui.period}" ${cur?"disabled":""}>${chevR}</button>
    </div>`;
}

function catRow(c,max,total){
  if(ui.catEdit===c.name){
    return `<div class="cat"><div class="cat-edit">
      <input type="text" id="cat-rename" maxlength="40" value="${esc(c.name)}" aria-label="New name for ${esc(c.name)}">
      <button class="mini go" data-act="cat-save" data-cat="${esc(c.name)}">Save</button>
      <button class="mini" data-act="cat-cancel">Cancel</button></div></div>`;
  }
  if(ui.catConfirm===c.name){
    const u=usage(c.name), parts=[];
    if(u.p) parts.push(plural(u.p,"purchase")+" (all time)");
    if(u.s) parts.push(plural(u.s,"saved purchase"));
    if(u.r) parts.push(plural(u.r,"recurring charge"));
    if(u.b) parts.push(plural(u.b,"budget"));
    return `<div class="cat"><div class="cat-warn">Delete <b>${esc(c.name)}</b>${parts.length?` and its ${parts.join(", ")}`:""}? This can't be undone.
      <div class="confirm"><button class="mini yes" data-act="cat-del-yes" data-cat="${esc(c.name)}">Delete</button><button class="mini" data-act="cat-cancel">Keep</button></div></div></div>`;
  }
  return `<div class="cat">
    <button class="cat-open" data-act="cat" data-cat="${esc(c.name)}">
      <div class="row"><span class="name">${esc(c.name)}</span><span class="num">${money(c.sum)}</span></div>
      <div class="sub">${plural(c.n,"purchase")}${total>0&&c.sum>0?" · "+Math.round(c.sum/total*100)+"%":""}</div>
      <div class="track"><div class="fill" style="width:${(c.sum/max*100).toFixed(1)}%"></div></div>
    </button>
    <div class="tools"><button class="mini" data-act="cat-edit" data-cat="${esc(c.name)}" aria-label="Rename ${esc(c.name)}">Edit</button><button class="mini del" data-act="cat-del" data-cat="${esc(c.name)}" aria-label="Delete ${esc(c.name)}">✕</button></div>
  </div>`;
}

function homeHTML(){
  const {from,to}=periodRange(ui.period,ui.anchor);
  const items=purchasesIn(from,to), total=sum(items), earned=sum(incomeIn(from,to)), net=earned-total;
  const byCat={}; items.forEach(p=>{ const c=byCat[p.category]||(byCat[p.category]={sum:0,n:0}); c.sum+=p.amount; c.n++; });
  const cats=categoriesList().map(n=>({name:n,sum:byCat[n]?.sum||0,n:byCat[n]?.n||0})).sort((a,b)=>b.sum-a.sum||a.name.localeCompare(b.name));
  const max=Math.max(1,...cats.map(c=>c.sum));
  const [whole,cents]=money(total).split(".");
  const addRow = ui.catAdd ? `<div class="cat"><div class="cat-edit">
      <input type="text" id="cat-new" maxlength="40" placeholder="New category, e.g. Groceries" aria-label="New category name">
      <button class="mini go" data-act="cat-add-save">Add</button><button class="mini" data-act="cat-cancel">Cancel</button></div></div>` : "";
  return topbar() + periodControls() + `
    <div class="total">
      <button class="total-main" data-act="all">
        <div class="k">Spent ${esc(periodNoun(ui.period,ui.anchor))}</div>
        <div class="v">${whole}<small>.${cents}</small></div>
        <div class="meta"><span>${plural(items.length,"purchase")}</span><span>View history →</span></div>
      </button>
      <div class="stats">
        <button class="stat" data-act="earned"><span class="sk">Earned</span><span class="sv earn">${money(earned)}</span></button>
        <div class="stat"><span class="sk">Net gain</span><span class="sv ${net>0?"pos":net<0?"neg":""}">${signed(net)}</span></div>
      </div>
    </div>
    <h2>Categories <button class="h-add" data-act="cat-add">+ Add</button></h2>
    <div class="list">${addRow}${cats.length? cats.map(c=>catRow(c,max,total)).join("") : (ui.catAdd?"":`<div class="empty">No categories yet. Tap <b>+</b> below to log your first purchase.</div>`)}</div>
    ${footerHTML()}`;
}

function itemRow(p,{withCat=true,income=false}={}){
  const d=new Date(p.ts), t=d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
  const name = income ? (p.note||"Money earned") : (p.note||p.category);
  const sub = income ? t : `${withCat&&p.note?esc(p.category)+" · ":""}${t}`;
  const tag = p.fromRecurring?'<span class="tag rec">recurring</span>':p.fromSaved?'<span class="tag">saved</span>':"";
  const pre = income?"e":"";
  return `<div class="item">
    <div class="main"><div class="name">${esc(name)}${tag}</div><div class="sub">${sub}</div></div>
    <div class="amt ${income?"earn":""}">${income?"+":""}${money(p.amount)}</div>
    <div class="tools">${ui.confirm===p.id ? confirmBtns(pre+"del-yes",p.id)
      : `<button class="mini" data-act="${pre}edit" data-id="${esc(p.id)}">Edit</button><button class="mini del" data-act="${pre}del" data-id="${esc(p.id)}" aria-label="Delete">✕</button>`}</div></div>`;
}
function grouped(items,fn){
  const g={}; items.forEach(p=>{ const d=new Date(p.ts).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}); (g[d]=g[d]||[]).push(p); });
  return Object.entries(g).map(([d,ps])=>`<div class="day">${esc(d)}</div><div class="list">${ps.map(fn).join("")}</div>`).join("");
}
function historyHTML(){
  const f=ui.filter||{...periodRange(ui.period,ui.anchor),cat:null,back:"home"};
  const items=purchasesIn(f.from,f.to,f.cat), total=sum(items);
  const rangeTxt = f.title ? fmtRange(f.from,addDays(f.to,-1)) : periodLabel(ui.period,ui.anchor);
  return (f.back==="home"?topbar()+periodControls():topbar()) + `
    ${f.back==="budgets"?back("budgets","Budgets"):back()}
    <div class="vhead"><div class="t">${esc(f.title||f.cat||"All spending")}</div>
      <div class="s"><b>${money(total)}</b> across ${plural(items.length,"purchase")} · ${esc(rangeTxt)}</div></div>
    ${items.length? grouped(items,p=>itemRow(p,{withCat:!f.cat})) : `<div class="list"><div class="empty">Nothing logged here yet.</div></div>`}`;
}
function earnedHTML(){
  const {from,to}=periodRange(ui.period,ui.anchor), items=incomeIn(from,to);
  return topbar()+periodControls()+`${back()}
    <div class="vhead"><div class="t">Money earned</div><div class="s"><b>${money(sum(items))}</b> from ${plural(items.length,"entry","entries")} · ${esc(periodLabel(ui.period,ui.anchor))}</div></div>
    ${items.length? grouped(items,p=>itemRow(p,{income:true})) : `<div class="list"><div class="empty">No money earned logged for this ${ui.period}.</div></div>`}
    <div class="btnrow mt"><button class="btn" data-act="add-earn">+ Add money earned</button></div>`;
}
function savedHTML(){
  const list=rows("saved").sort((a,b)=>(a.note||a.category).localeCompare(b.note||b.category));
  return topbar()+`${back()}
    <div class="vhead"><div class="t">Saved purchases</div><div class="s">Tap one to log it now. They also appear under <b>+</b> for one-tap logging.</div></div>
    <div class="list">${list.length? list.map(s=>`<div class="sv-item">
        <button class="sv-add" data-act="use" data-id="${esc(s.id)}"><span class="plus">+</span>
          <span class="main"><span class="name">${esc(s.note||s.category)}</span><span class="sub">${s.note?esc(s.category):"Saved purchase"}</span></span>
          <span class="amt num">${money(s.amount)}</span></button>
        <div class="tools">${ui.confirm===s.id?confirmBtns("sdel-yes",s.id)
          :`<button class="mini" data-act="sedit" data-id="${esc(s.id)}">Edit</button><button class="mini del" data-act="sdel" data-id="${esc(s.id)}" aria-label="Delete saved purchase">✕</button>`}</div>
      </div>`).join("") : `<div class="empty">No saved purchases yet.</div>`}</div>
    <div class="btnrow mt"><button class="btn" data-act="add-saved">+ New saved purchase</button></div>`;
}

/* ---------- budgets ---------- */
function budgetInfo(b){
  const from=parseYmd(b.start), end=parseYmd(b.end), to=addDays(end,1), t=today();
  const spent=sum(purchasesIn(from,to,b.category||null)), left=b.amount-spent, pct=b.amount>0?spent/b.amount:0;
  const status = t<from?"upcoming" : t>end?"ended" : "active";
  const daysLeft = status==="active" ? daysBetween(t,end)+1 : status==="upcoming" ? daysBetween(from,end)+1 : 0;
  return {from,end,to,spent,left,pct,status,daysLeft};
}
function budgetsHTML(){
  const order={active:0,upcoming:1,ended:2};
  const list=rows("budgets").map(b=>({...b,...budgetInfo(b)})).sort((a,b)=>order[a.status]-order[b.status] || a.end-b.end);
  const card=b=>{
    const over=b.left<0, warn=!over&&b.pct>=.85, st=over?"over":warn?"warn":"ok";
    let foot;
    if(b.status==="upcoming") foot=`Starts ${fmtMD(b.from)} · runs ${plural(b.daysLeft,"day")}`;
    else if(b.status==="ended") foot=`Ended ${fmtMD(b.end)}`;
    else foot=`${plural(b.daysLeft,"day")} left${b.left>0?` · ${money(b.left/b.daysLeft)}/day to stay on track`:""}`;
    const pill = over?"Over":b.status==="ended"?"Ended":b.status==="upcoming"?"Upcoming":warn?"Almost out":"On track";
    return `<div class="bcard ${b.status}">
      <button class="bmain" data-act="budget-open" data-id="${esc(b.id)}">
        <div class="row"><span class="name">${esc(b.name||b.category||"Budget")}</span><span class="pill ${b.status==="active"||over?st:""}">${pill}</span></div>
        <div class="sub">${b.name?esc(b.category||"All spending")+" · ":b.category?"":"All spending · "}${esc(fmtRange(b.from,b.end))}</div>
        <div class="bnum"><span class="big ${over?"neg":""}">${money(Math.abs(b.left))}</span> ${over?"over":"left"}</div>
        <div class="sub">${money(b.spent)} of ${money(b.amount)} spent</div>
        <div class="track big"><div class="fill ${st}" style="width:${Math.min(100,b.pct*100).toFixed(1)}%"></div></div>
        <div class="sub">${foot}</div>
      </button>
      <div class="bfoot">${ui.confirm===b.id?confirmBtns("bdel-yes",b.id)
        :`<button class="mini" data-act="bedit" data-id="${esc(b.id)}">Edit</button><button class="mini del" data-act="bdel" data-id="${esc(b.id)}" aria-label="Delete budget">✕</button>`}</div>
    </div>`;
  };
  return topbar(list.length?`<button class="h-add" data-act="budget-new">+ New</button>`:"")+`
    <div class="vhead"><div class="t">Budgets</div><div class="s">Set an amount for a date range and see what's left.</div></div>
    ${list.length? `<div class="stack">${list.map(card).join("")}</div>`
      : `<div class="list"><div class="empty">No budgets yet.<br>Try one for this month — say, $300 for Food.</div></div>
         <div class="btnrow mt"><button class="btn primary" data-act="budget-new">+ Create a budget</button></div>`}`;
}

/* ---------- averages ---------- */
const PRESETS = {
  month:["This month",()=>{const t=today();return[new Date(t.getFullYear(),t.getMonth(),1),t];}],
  d30:["Last 30 days",()=>{const t=today();return[addDays(t,-29),t];}],
  m3:["Last 3 months",()=>{const t=today();return[new Date(t.getFullYear(),t.getMonth()-2,1),t];}],
  year:["This year",()=>{const t=today();return[new Date(t.getFullYear(),0,1),t];}],
  all:["All time",()=>{const t=today(); const ds=[...rows("purchases"),...rows("income")].map(p=>startOfDay(new Date(p.ts)).getTime()); return[ds.length?new Date(Math.min(...ds)):t,t];}]
};
function avgRange(){
  if(ui.avg.preset!=="custom"){ const [f,t]=PRESETS[ui.avg.preset][1](); return {from:f,end:t}; }
  return {from:parseYmd(ui.avg.from), end:parseYmd(ui.avg.to)};
}
const DAYS_PER = {day:1,week:7,month:365.2425/12,year:365.2425};
function averagesHTML(){
  const {from,end}=avgRange(), t=today();
  const effEnd = end>t ? t : end;
  const days = daysBetween(from,effEnd)+1;
  const chips = Object.entries(PRESETS).map(([k,[l]])=>`<button class="chip" data-act="avg-preset" data-p="${k}" aria-pressed="${ui.avg.preset===k}">${l}</button>`).join("");
  const inputs = `<div class="daterow"><label>From<input type="date" id="avg-from" value="${ymd(from)}"></label><label>To<input type="date" id="avg-to" value="${ymd(end)}"></label></div>`;
  let body;
  if(days<=0){ body=`<div class="list"><div class="empty">Pick a start date on or before the end date${from>t?", and not in the future":""}.</div></div>`; }
  else{
    const to=addDays(effEnd,1), items=purchasesIn(from,to), spent=sum(items), earned=sum(incomeIn(from,to));
    const per=u=>spent/days*DAYS_PER[u];
    const byCat={}; items.forEach(p=>byCat[p.category]=(byCat[p.category]||0)+p.amount);
    const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]), maxc=Math.max(1,...cats.map(c=>c[1]));
    const u=ui.avg.unit||"month", netM=(earned-spent)/days*DAYS_PER.month;
    body = `
      <div class="total avg">
        <div class="total-main static">
          <div class="k">Total spent</div>
          <div class="v sm">${money(spent)}</div>
          <div class="meta"><span>${plural(items.length,"purchase")} over ${plural(days,"day")}</span><span>${esc(fmtRange(from,effEnd))}</span></div>
        </div>
        <div class="tiles">${["day","week","month","year"].map(k=>`<div class="tile"><span class="sk">Per ${k}</span><span class="sv">${money(per(k))}</span></div>`).join("")}</div>
      </div>
      <div class="mini-stats">
        <div><span class="sk">Earned / month</span><span class="sv earn">${money(earned/days*DAYS_PER.month)}</span></div>
        <div><span class="sk">Net / month</span><span class="sv ${netM>0?"pos":netM<0?"neg":""}">${signed(netM)}</span></div>
      </div>
      <h2>By category <span class="seg sm">${["week","month","year"].map(k=>`<button data-act="avg-unit" data-u="${k}" aria-selected="${u===k}">per ${k}</button>`).join("")}</span></h2>
      <div class="list">${cats.length?cats.map(([n,s])=>`<div class="cat static"><div class="cat-open">
          <div class="row"><span class="name">${esc(n)}</span><span class="num">${money(s/days*DAYS_PER[u])}</span></div>
          <div class="track"><div class="fill" style="width:${(s/maxc*100).toFixed(1)}%"></div></div></div></div>`).join("")
        :`<div class="empty">No spending in this range.</div>`}</div>
      <p class="note">Averages divide what you spent by the ${plural(days,"day")} in the range${end>t?" (counting up to today)":""}, then scale up: a week is 7 days, a month is 30.44 days, a year is 365.24 days.</p>`;
  }
  return topbar()+`<div class="vhead"><div class="t">Averages</div><div class="s">Average spending over any stretch of time.</div></div>
    <div class="chips presets">${chips}</div>${inputs}${body}`;
}

/* ---------- recurring ---------- */
function recurringHTML(){
  const list=rows("recurring").sort((a,b)=>(a.paused-b.paused)||(a.next||"").localeCompare(b.next||""));
  const active=list.filter(r=>!r.paused), monthly=active.reduce((s,r)=>s+r.amount*(PER_MONTH[r.freq]||1),0);
  return topbar(list.length?`<button class="h-add" data-act="rec-new">+ New</button>`:"")+`
    <div class="vhead"><div class="t">Recurring</div>
      <div class="s">${list.length?`About <b>${money(monthly)}</b>/month across ${plural(active.length,"charge")}`:"Subscriptions, rent, anything that repeats."}</div></div>
    ${list.length?`<div class="list">${list.map(r=>{
      const next=r.next?parseYmd(r.next):null, dueIn=next?daysBetween(today(),next):null;
      const when = r.paused?"Paused":dueIn===0?"due today":dueIn===1?"next tomorrow":next?`next ${fmtMD(next)}`:"";
      return `<div class="item ${r.paused?"paused":""}">
        <div class="main"><div class="name">${esc(r.name||r.category)}</div><div class="sub">${esc(FREQS[r.freq])} · ${when}</div></div>
        <div class="amt">${money(r.amount)}</div>
        <div class="tools">${ui.confirm===r.id?confirmBtns("rdel-yes",r.id)
          :`<button class="mini" data-act="redit" data-id="${esc(r.id)}">Edit</button><button class="mini del" data-act="rdel" data-id="${esc(r.id)}" aria-label="Delete recurring charge">✕</button>`}</div></div>`;
    }).join("")}</div>
    <p class="note">Each charge is logged as a purchase on its date, the next time the app is open. Deleting one here stops future charges; past ones stay in your history.</p>`
    :`<div class="list"><div class="empty">Nothing recurring yet.<br>Add things like Spotify, rent, or a gym membership.</div></div>
      <div class="btnrow mt"><button class="btn primary" data-act="rec-new">+ Add a recurring charge</button></div>`}`;
}

/* ---------- sheets ---------- */
// Redraws keep the sheet's scroll position and skip the slide-in animation.
function sheet(html,cls=""){
  const old=$("#sheetRoot .sheet"), top=old?old.scrollTop:0;
  $("#sheetRoot").innerHTML=`<div class="scrim" data-sheet="scrim"><div class="sheet ${cls} ${old?"":"enter"}" role="dialog" aria-modal="true" aria-labelledby="sh-t">${html}</div></div>`;
  if(old) $("#sheetRoot .sheet").scrollTop=top;
}
function closeSheet(){ $("#sheetRoot").innerHTML=""; $("#sheetRoot").onclick=null; document.onkeydown=null; render(); }
function catPicker(f,{allowAll=false}={}){
  const cats=categoriesList(); if(f.category&&!cats.includes(f.category)) cats.push(f.category);
  return `<div class="field"><div class="lab">Category</div>
    <div class="chips">${allowAll?`<button class="chip" data-sheet="pick" data-cat="" aria-pressed="${!f.category}">All spending</button>`:""}${cats.map(c=>`<button class="chip" data-sheet="pick" data-cat="${esc(c)}" aria-pressed="${c===f.category}">${esc(c)}</button>`).join("")}
      <button class="chip new" data-sheet="newcat">+ New category</button></div>
    ${f.newOpen?`<div class="newcat"><input type="text" id="f-newcat" placeholder="e.g. Groceries" maxlength="40"><button class="btn primary slim" data-sheet="addcat">Add</button></div>`:""}</div>`;
}
const amountField = f => `<div class="field"><label for="f-amt">Amount</label><div class="amount-in"><span>$</span><input type="number" id="f-amt" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${esc(f.amount)}"></div></div>`;
const err = m => { const e=$("#f-err"); if(e) e.textContent=m; return false; };
const amt2 = s => Math.round(parseFloat(s)*100)/100;
// Shared form runner: draw() renders the sheet, read() pulls inputs into f, save() returns true to close.
function runSheet(f,{cls="",draw,read,save,extra}){
  const redraw=()=>{ sheet(draw(),cls); const n=$("#f-newcat"); if(n) n.focus(); };
  function addCat(){ read(); const name=addCategory($("#f-newcat")?.value); if(!name) return; f.category=name; f.newOpen=false; redraw(); }
  document.onkeydown=e=>{ if(e.key==="Escape") closeSheet(); if(e.key==="Enter"&&e.target.id==="f-newcat"){ e.preventDefault(); addCat(); } };
  $("#sheetRoot").onclick=e=>{
    const t=e.target.closest("[data-sheet]"); if(!t) return;
    const a=t.dataset.sheet;
    if(a==="scrim"){ if(e.target===t) closeSheet(); return; }
    if(a==="cancel") return closeSheet();
    if(a==="pick"){ read(); f.category=t.dataset.cat; redraw(); return; }
    if(a==="newcat"){ read(); f.newOpen=!f.newOpen; redraw(); return; }
    if(a==="addcat") return addCat();
    if(a==="save"){ read(); if(save()) closeSheet(); return; }
    if(extra){ read(); extra(a,t,redraw); }
  };
  redraw();
}

// one-time purchases, saved purchases, money earned
function openSheet(kind,id){
  const saving=kind==="saved"||kind==="sedit", income=kind==="earn"||kind==="eedit", editing=kind==="edit"||kind==="sedit"||kind==="eedit";
  const src=kind==="edit"?state.purchases[id]:kind==="sedit"?state.saved[id]:kind==="eedit"?state.income[id]:null;
  if(editing&&!src) return;
  const f={category:src?.category||"",amount:src?String(src.amount):"",note:src?.note||"",ts:src?.ts||new Date().toISOString(),newOpen:false,when:"now"};
  const isNew = kind==="once"||kind==="earn";
  const orig=JSON.stringify([f.category,+f.amount||0,f.note.trim(),f.ts]);
  const titles={once:"One-time purchase",saved:"New saved purchase",edit:"Edit purchase",sedit:"Edit saved purchase",earn:"Money earned",eedit:"Edit money earned"};
  const hints={once:"Pick a category, enter the amount, and choose when.",saved:"Set it up once, then log it with one tap from the + menu.",
    edit:"Change anything, including the date.",sedit:"Changes apply the next time you log it.",earn:"Enter what came in and when.",eedit:"Change anything, including the date."};
  const hasDate=kind==="edit"||kind==="eedit";
  runSheet(f,{cls:(saving?"saving ":"")+(income?"income":""),
    draw:()=>`<h3 id="sh-t">${titles[kind]}</h3><p class="hint">${hints[kind]}</p>
      ${income?"":catPicker(f)}${amountField(f)}
      <div class="field"><label for="f-note">${income?"Source":"Name"} (optional)</label><input type="text" id="f-note" maxlength="60" placeholder="${income?"e.g. Paycheck, DoorDash":saving?"e.g. Chipotle bowl":"e.g. Walmart run"}" value="${esc(f.note)}"></div>
      ${hasDate?`<div class="field"><label for="f-ts">Date &amp; time</label><input type="datetime-local" id="f-ts" value="${toLocalInput(f.ts)}"></div>`:""}
      ${isNew?`<div class="field"><div class="lab">When</div>
        <div class="chips">${[["now","Just now"],["yesterday","Yesterday"],["custom","Pick a date"]].map(([k,l])=>`<button class="chip" data-sheet="when" data-w="${k}" aria-pressed="${f.when===k}">${l}</button>`).join("")}</div>
        ${f.when==="custom"?`<input type="datetime-local" id="f-ts" class="mt8" value="${toLocalInput(f.ts)}" aria-label="Date and time">`:""}</div>`:""}
      <p class="err" id="f-err"></p>
      <div class="btnrow"><button class="btn" data-sheet="cancel">Cancel</button><button class="btn primary" data-sheet="save">${kind==="saved"?"Save to saved purchases":"Save"}</button></div>`,
    read:()=>{ const a=$("#f-amt"); if(a) f.amount=a.value; const n=$("#f-note"); if(n) f.note=n.value; const t=$("#f-ts"); if(t&&t.value&&t.value!==toLocalInput(f.ts)) f.ts=new Date(t.value).toISOString(); },
    save:()=>{
      const amt=amt2(f.amount), note=f.note.trim();
      if(editing&&JSON.stringify([f.category,amt||0,note,f.ts])===orig) return true;
      if(!income&&!f.category) return err("Pick a category or add a new one.");
      if(!(amt>0)) return err("Enter an amount greater than $0.");
      const when = f.when==="now" ? new Date() : f.when==="yesterday" ? (()=>{const d=new Date(); d.setDate(d.getDate()-1); return d;})() : new Date(f.ts);
      if(isNew && isNaN(when)) return err("Pick a date and time.");
      const whenNote = f.when==="now" ? "" : " · "+fmtMD(when);
      if(kind==="once"){ put("purchases",uid(),{category:f.category,amount:amt,note,ts:when.toISOString()}); toast("Logged "+money(amt)+" · "+f.category+whenNote); }
      if(kind==="edit"){ put("purchases",id,{...src,category:f.category,amount:amt,note,ts:f.ts}); toast("Purchase updated"); }
      if(kind==="saved"){ put("saved",uid(),{category:f.category,amount:amt,note}); toast("Added to saved purchases"); }
      if(kind==="sedit"){ put("saved",id,{category:f.category,amount:amt,note}); toast("Saved purchase updated"); }
      if(kind==="earn"){ put("income",uid(),{amount:amt,note,ts:when.toISOString()}); toast("Logged +"+money(amt)+" earned"+whenNote); }
      if(kind==="eedit"){ put("income",id,{...src,amount:amt,note,ts:f.ts}); toast("Money earned updated"); }
      return true;
    },
    extra:(a,el,redraw)=>{ if(a==="when"){ f.when=el.dataset.w; if(f.when==="custom"&&!f.customSet){ f.ts=new Date().toISOString(); f.customSet=true; } redraw(); if(f.when==="custom") $("#f-ts")?.focus(); } }});
  if(kind==="earn") setTimeout(()=>$("#f-amt")?.focus(),0);
}

function openBudgetSheet(id){
  const src=id?state.budgets[id]:null; if(id&&!src) return;
  const t=today();
  const f={name:src?.name||"",category:src?.category||"",amount:src?String(src.amount):"",
    start:src?.start||ymd(new Date(t.getFullYear(),t.getMonth(),1)), end:src?.end||ymd(new Date(t.getFullYear(),t.getMonth()+1,0)),newOpen:false};
  const orig=JSON.stringify([f.name.trim(),f.category,+f.amount||0,f.start,f.end]);
  const quick={week:"This week",month:"This month",d30:"Next 30 days",rest:"Rest of year"};
  runSheet(f,{
    draw:()=>`<h3 id="sh-t">${id?"Edit budget":"New budget"}</h3><p class="hint">Purchases in the date range${f.category?" and category":""} count against it.</p>
      ${amountField(f)}
      <div class="field"><div class="lab">Dates</div>
        <div class="chips">${Object.entries(quick).map(([k,l])=>`<button class="chip" data-sheet="quick" data-q="${k}">${l}</button>`).join("")}</div>
        <div class="daterow"><label>Start<input type="date" id="f-start" value="${f.start}"></label><label>End<input type="date" id="f-end" value="${f.end}"></label></div></div>
      ${catPicker(f,{allowAll:true})}
      <div class="field"><label for="f-name">Name (optional)</label><input type="text" id="f-name" maxlength="40" placeholder="e.g. September food" value="${esc(f.name)}"></div>
      <p class="err" id="f-err"></p>
      <div class="btnrow"><button class="btn" data-sheet="cancel">Cancel</button><button class="btn primary" data-sheet="save">Save budget</button></div>`,
    read:()=>{ f.amount=$("#f-amt").value; f.name=$("#f-name").value; f.start=$("#f-start").value||f.start; f.end=$("#f-end").value||f.end; },
    save:()=>{
      const amt=amt2(f.amount), name=f.name.trim();
      if(id&&JSON.stringify([name,f.category,amt||0,f.start,f.end])===orig) return true;
      if(!(amt>0)) return err("Enter a budget amount greater than $0.");
      if(!f.start||!f.end) return err("Pick a start and end date.");
      if(parseYmd(f.end)<parseYmd(f.start)) return err("The end date is before the start date.");
      put("budgets",id||uid(),{name,category:f.category||null,amount:amt,start:f.start,end:f.end});
      toast(id?"Budget updated":"Budget created"); return true;
    },
    extra:(a,el,redraw)=>{
      if(a!=="quick") return;
      const t=today(), q=el.dataset.q;
      if(q==="week"){ const s=addDays(t,-t.getDay()); f.start=ymd(s); f.end=ymd(addDays(s,6)); }
      if(q==="month"){ f.start=ymd(new Date(t.getFullYear(),t.getMonth(),1)); f.end=ymd(new Date(t.getFullYear(),t.getMonth()+1,0)); }
      if(q==="d30"){ f.start=ymd(t); f.end=ymd(addDays(t,29)); }
      if(q==="rest"){ f.start=ymd(t); f.end=ymd(new Date(t.getFullYear(),11,31)); }
      redraw();
    }});
}

function openRecurringSheet(id){
  const src=id?state.recurring[id]:null; if(id&&!src) return;
  const f={name:src?.name||"",category:src?.category||"",amount:src?String(src.amount):"",freq:src?.freq||"monthly",next:src?.next||ymd(today()),paused:!!src?.paused,newOpen:false};
  const orig=JSON.stringify([f.name.trim(),f.category,+f.amount||0,f.freq,f.next,f.paused]);
  runSheet(f,{
    draw:()=>`<h3 id="sh-t">${id?"Edit recurring charge":"New recurring charge"}</h3>
      <p class="hint">It's logged as a purchase automatically on each date.${id?"":" If the first date is in the past, the missed charges are logged too."}</p>
      <div class="field"><label for="f-name">Name</label><input type="text" id="f-name" maxlength="40" placeholder="e.g. Spotify" value="${esc(f.name)}"></div>
      ${catPicker(f)}${amountField(f)}
      <div class="field"><div class="lab">How often</div><div class="seg wrap">${Object.entries(FREQS).map(([k,l])=>`<button data-sheet="freq" data-f="${k}" aria-selected="${f.freq===k}">${l}</button>`).join("")}</div></div>
      <div class="field"><label for="f-next">${id?"Next charge":"First charge"}</label><input type="date" id="f-next" value="${f.next}"></div>
      ${id?`<label class="check"><input type="checkbox" id="f-paused" ${f.paused?"checked":""}> Paused — don't log new charges</label>`:""}
      <p class="err" id="f-err"></p>
      <div class="btnrow"><button class="btn" data-sheet="cancel">Cancel</button><button class="btn primary" data-sheet="save">Save</button></div>`,
    read:()=>{ f.name=$("#f-name").value; f.amount=$("#f-amt").value; f.next=$("#f-next").value||f.next; const p=$("#f-paused"); if(p) f.paused=p.checked; },
    save:()=>{
      const amt=amt2(f.amount), name=f.name.trim();
      if(id&&JSON.stringify([name,f.category,amt||0,f.freq,f.next,f.paused])===orig) return true;
      if(!name) return err("Give it a name, like Spotify or Rent.");
      if(!f.category) return err("Pick a category or add a new one.");
      if(!(amt>0)) return err("Enter an amount greater than $0.");
      if(!f.next) return err("Pick the date of the charge.");
      const day = (!src||f.next!==src.next) ? parseYmd(f.next).getDate() : (src.day||parseYmd(f.next).getDate());
      put("recurring",id||uid(),{name,category:f.category,amount:amt,freq:f.freq,next:f.next,day,paused:f.paused});
      toast(id?"Recurring charge updated":"Recurring charge added");
      setTimeout(processRecurring,50); return true;
    },
    extra:(a,el,redraw)=>{ if(a==="freq"){ f.freq=el.dataset.f; redraw(); } }});
}

function openAddMenu(){
  const saved=rows("saved").sort((a,b)=>(a.note||a.category).localeCompare(b.note||b.category));
  sheet(`<h3 id="sh-t">Add</h3>
    <div class="addgrid">
      <button class="addopt one" data-sheet="once"><span class="dot">+</span><span>One-time purchase</span></button>
      <button class="addopt ea" data-sheet="earn"><span class="dot">$</span><span>Money earned</span></button>
      <button class="addopt sv" data-sheet="saved"><span class="dot">★</span><span>New saved purchase</span></button>
    </div>
    <div class="lab">Quick add from saved</div>
    ${saved.length?`<div class="quick">${saved.map(s=>`<button class="qchip" data-sheet="use" data-id="${esc(s.id)}"><span>${esc(s.note||s.category)}</span><b>${money(s.amount)}</b></button>`).join("")}</div>
      <button class="linkbtn" data-sheet="manage">Manage saved purchases</button>`
    :`<p class="hint">Saved purchases show up here so you can log them in one tap.</p>`}`,"addmenu");
  document.onkeydown=e=>{ if(e.key==="Escape") closeSheet(); };
  $("#sheetRoot").onclick=e=>{
    const t=e.target.closest("[data-sheet]"); if(!t) return;
    const a=t.dataset.sheet;
    if(a==="scrim"){ if(e.target===t) closeSheet(); return; }
    if(a==="once"||a==="earn"||a==="saved") return openSheet(a);
    if(a==="manage"){ closeSheet(); go("saved"); return; }
    if(a==="use"){ logSaved(t.dataset.id); closeSheet(); }
  };
}
function logSaved(id){
  const s=state.saved[id]; if(!s) return;
  put("purchases",uid(),{category:s.category,amount:s.amount,note:s.note||"",ts:new Date().toISOString(),fromSaved:true});
  toast("Logged "+money(s.amount)+" · "+(s.note||s.category));
}

let toastT;
function toast(msg){ $("#toastRoot").innerHTML=`<div class="toast" role="status">${esc(msg)}</div>`; clearTimeout(toastT); toastT=setTimeout(()=>$("#toastRoot").innerHTML="",2400); }

/* ---------- navigation & events ---------- */
function go(view){ ui.view=view; ui.confirm=null; ui.catEdit=null; ui.catConfirm=null; ui.catAdd=false; if(view!=="history") ui.filter=null; window.scrollTo({top:0}); render(); }

$("#app").addEventListener("keydown", e=>{
  if(e.target.id==="cat-new"){
    if(e.key==="Enter"){ e.preventDefault(); const n=addCategory(e.target.value); ui.catAdd=false; render(); if(n) toast("Added "+n); }
    if(e.key==="Escape"){ ui.catAdd=false; render(); }
  }
  if(e.target.id==="cat-rename"){
    if(e.key==="Enter"){ e.preventDefault(); const old=ui.catEdit; ui.catEdit=null; renameCategory(old,e.target.value); }
    if(e.key==="Escape"){ ui.catEdit=null; render(); }
  }
});
$("#app").addEventListener("change", e=>{
  if(e.target.id==="avg-from"||e.target.id==="avg-to"){
    const f=$("#avg-from").value, t=$("#avg-to").value; if(!f||!t) return;
    ui.avg={...ui.avg,preset:"custom",from:f,to:t}; render();
  }
});
document.addEventListener("click", e=>{
  const t=e.target.closest("[data-act]"); if(!t||!t.closest("#app,#tabs")) return;
  const a=t.dataset.act, id=t.dataset.id, cat=t.dataset.cat;
  if(!/^[esbr]?del$/.test(a)) ui.confirm=null;
  if(!a.startsWith("cat-")){ ui.catEdit=null; ui.catConfirm=null; ui.catAdd=false; }
  switch(a){
    case "tab": return go(t.dataset.tab);
    case "go": return go(t.dataset.view);
    case "add": return openAddMenu();
    case "period": ui.period=t.dataset.p; ui.anchor=today(); break;
    case "prev": ui.anchor=shiftAnchor(ui.period,ui.anchor,-1); break;
    case "next": if(!isCurrent(ui.period,ui.anchor)) ui.anchor=shiftAnchor(ui.period,ui.anchor,1); break;
    case "today": ui.anchor=today(); break;
    case "all": ui.filter=null; return go("history");
    case "cat": { const r=periodRange(ui.period,ui.anchor); ui.view="history"; ui.filter={...r,cat,back:"home"}; window.scrollTo({top:0}); break; }
    case "earned": return go("earned");
    case "budget-open": { const b=state.budgets[id]; if(!b) return; const i=budgetInfo(b); ui.view="history"; ui.filter={from:i.from,to:i.to,cat:b.category||null,title:b.name||b.category||"Budget",back:"budgets"}; window.scrollTo({top:0}); break; }
    case "budget-new": return openBudgetSheet();
    case "bedit": return openBudgetSheet(id);
    case "rec-new": return openRecurringSheet();
    case "redit": return openRecurringSheet(id);
    case "add-earn": return openSheet("earn");
    case "add-saved": return openSheet("saved");
    case "edit": return openSheet("edit",id);
    case "eedit": return openSheet("eedit",id);
    case "sedit": return openSheet("sedit",id);
    case "del": case "edel": case "sdel": case "bdel": case "rdel": ui.confirm=id; break;
    case "nope": break;
    case "del-yes": del("purchases",id); toast("Purchase deleted"); break;
    case "edel-yes": del("income",id); toast("Entry deleted"); break;
    case "sdel-yes": del("saved",id); toast("Saved purchase deleted"); break;
    case "bdel-yes": del("budgets",id); toast("Budget deleted"); break;
    case "rdel-yes": del("recurring",id); toast("Recurring charge deleted"); break;
    case "use": logSaved(id); break;
    case "avg-preset": ui.avg={...ui.avg,preset:t.dataset.p}; break;
    case "avg-unit": ui.avg={...ui.avg,unit:t.dataset.u}; break;
    case "cat-add": ui.catAdd=true; ui.catEdit=null; ui.catConfirm=null; break;
    case "cat-add-save": { const n=addCategory($("#cat-new")?.value); ui.catAdd=false; if(n) toast("Added "+n); break; }
    case "cat-edit": ui.catEdit=cat; ui.catConfirm=null; ui.catAdd=false; break;
    case "cat-del": ui.catConfirm=cat; ui.catEdit=null; ui.catAdd=false; break;
    case "cat-cancel": ui.catEdit=null; ui.catConfirm=null; ui.catAdd=false; break;
    case "cat-save": { const v=$("#cat-rename")?.value||""; ui.catEdit=null; renameCategory(cat,v); return; }
    case "cat-del-yes": ui.catConfirm=null; deleteCategory(cat); return;
    case "export": exportData(); return;
    case "import": openImport(); return;
    case "signout": signOut(auth); return;
  }
  render();
});

/* ---------- account footer, import / export ---------- */
function footerHTML(){
  const s = !online ? "Offline — changes sync when you're back online" : pendingSync ? "Syncing…" : "Synced";
  return `<div class="status">${s}</div>
    <div class="acct">${user?esc(user.email):""} · <button class="linkbtn" data-act="export">Back up</button> · <button class="linkbtn" data-act="import">Import</button> · <button class="linkbtn" data-act="signout">Sign out</button></div>`;
}
function exportData(){
  const blob = new Blob([JSON.stringify({app:"ledger",version:2,exportedAt:new Date().toISOString(),...state},null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="ledger-backup-"+ymd(new Date())+".json";
  document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
  toast("Backup downloaded");
}
async function importData(obj){
  let n=0; const writes=[];
  for(const coll of COLLS){
    const r = obj && obj[coll]; if(!r||typeof r!=="object") continue;
    for(const [id,body] of Object.entries(r)){
      if(!body||typeof body!=="object"||!/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue;
      state[coll][id]=body; writes.push([coll,id,body]); n++;
    }
  }
  writeCache(); render();
  for(let i=0;i<writes.length;i+=400){
    const b=writeBatch(fdb);
    writes.slice(i,i+400).forEach(([coll,id,body])=>b.set(doc(fdb,"users",user.uid,coll,id),body));
    b.commit().catch(()=>toast("Some items didn't save — try importing again"));
  }
  return n;
}
function openImport(){
  sheet(`<h3 id="sh-t">Import data</h3>
    <p class="hint">Paste the data you copied from the old Ledger, or pick a backup file. Anything already here stays; matching items are updated.</p>
    <div class="field"><label for="imp-text">Paste data</label><textarea id="imp-text" rows="6" placeholder='{"purchases": …}'></textarea></div>
    <div class="field"><label for="imp-file">Or choose a backup file</label><input type="file" id="imp-file" accept=".json,application/json"></div>
    <p class="err" id="f-err"></p>
    <div class="btnrow"><button class="btn" data-sheet="cancel">Cancel</button><button class="btn primary" data-sheet="go">Import</button></div>`);
  document.onkeydown=e=>{ if(e.key==="Escape") closeSheet(); };
  $("#sheetRoot").onclick = async e=>{
    const t=e.target.closest("[data-sheet]"); if(!t) return;
    const a=t.dataset.sheet;
    if(a==="scrim"){ if(e.target===t) closeSheet(); return; }
    if(a==="cancel") return closeSheet();
    if(a==="go"){
      let text=$("#imp-text").value.trim(); const file=$("#imp-file").files[0];
      if(!text&&file) text=await file.text();
      if(!text) return err("Paste your data or choose a file first.");
      let obj; try{ obj=JSON.parse(text); }catch(x){ return err("That doesn't look like Ledger data. Copy it again from the old Ledger's Export button."); }
      const n=await importData(obj);
      if(!n) return err("No Ledger items found in that data.");
      closeSheet(); toast(`Imported ${plural(n,"item")}`); setTimeout(processRecurring,100);
    }
  };
}

/* ---------- sign-in screen ---------- */
const authUI = { mode:"signin", busy:false, err:"", email:"" };
function authHTML(){
  const create = authUI.mode==="create";
  return `<div class="auth">
    <div class="brand big">${planet}Ledger</div>
    <p class="auth-sub">${create?"Create your account. You'll use it to sign in on your phone and laptop.":"Sign in to see your spending on any device."}</p>
    <form id="authForm" class="auth-card" novalidate>
      <div class="field"><label for="a-email">Email</label><input type="email" id="a-email" autocomplete="email" value="${esc(authUI.email)}" required></div>
      <div class="field"><label for="a-pass">Password</label><input type="password" id="a-pass" autocomplete="${create?"new-password":"current-password"}" required minlength="6">${create?'<div class="hint small">At least 6 characters.</div>':""}</div>
      <p class="err">${esc(authUI.err)}</p>
      <button class="btn primary wide" type="submit" ${authUI.busy?"disabled":""}>${authUI.busy?"One sec…":create?"Create account":"Sign in"}</button>
      <div class="auth-links">
        <button type="button" class="linkbtn" data-auth="toggle">${create?"I already have an account":"First time? Create an account"}</button>
        ${create?"":'<button type="button" class="linkbtn" data-auth="reset">Forgot password?</button>'}
      </div>
    </form></div>`;
}
const AUTH_ERRORS = {
  "auth/invalid-credential":"Email or password is wrong.",
  "auth/wrong-password":"Email or password is wrong.",
  "auth/user-not-found":"No account with that email yet — tap “Create an account”.",
  "auth/email-already-in-use":"That email already has an account — sign in instead.",
  "auth/invalid-email":"That email address doesn't look right.",
  "auth/weak-password":"Use at least 6 characters.",
  "auth/too-many-requests":"Too many tries. Wait a minute and try again.",
  "auth/network-request-failed":"No internet connection. Connect and try again.",
  "auth/operation-not-allowed":"Email/Password sign-in isn't turned on in Firebase yet (Authentication → Sign-in method)."
};
function paintAuth(){ $("#app").innerHTML = authHTML(); paintTabs(); }
document.addEventListener("submit", async e=>{
  if(e.target.id!=="authForm") return;
  e.preventDefault();
  const email=$("#a-email").value.trim(), pass=$("#a-pass").value;
  authUI.email=email;
  if(!email||!pass){ authUI.err="Enter your email and password."; return paintAuth(); }
  authUI.busy=true; authUI.err=""; paintAuth();
  try{
    if(authUI.mode==="create") await createUserWithEmailAndPassword(auth,email,pass);
    else await signInWithEmailAndPassword(auth,email,pass);
  }catch(x){ authUI.busy=false; authUI.err=AUTH_ERRORS[x.code]||("Couldn't sign in ("+(x.code||"unknown error")+")."); paintAuth(); }
});
document.addEventListener("click", async e=>{
  const t=e.target.closest("[data-auth]"); if(!t) return;
  if(t.dataset.auth==="toggle"){ authUI.email=$("#a-email")?.value.trim()||authUI.email; authUI.mode=authUI.mode==="create"?"signin":"create"; authUI.err=""; paintAuth(); }
  if(t.dataset.auth==="reset"){
    const email=$("#a-email").value.trim(); authUI.email=email;
    if(!email){ authUI.err="Type your email above first, then tap Forgot password."; return paintAuth(); }
    try{ await sendPasswordResetEmail(auth,email); authUI.err=""; paintAuth(); toast("Reset link sent — check your email"); }
    catch(x){ authUI.err=AUTH_ERRORS[x.code]||"Couldn't send the reset email."; paintAuth(); }
  }
});

/* ---------- boot ---------- */
let unsubs=[];
function startSync(){
  unsubs.forEach(u=>u()); unsubs=[]; serverSynced={};
  const ready={}, pend={};
  COLLS.forEach(coll=>{
    unsubs.push(onSnapshot(collection(fdb,"users",user.uid,coll),{includeMetadataChanges:true},snap=>{
      const next={}; snap.docs.forEach(d=>{ next[d.id]=d.data(); });
      state[coll]=next; ready[coll]=true; pend[coll]=snap.metadata.hasPendingWrites;
      if(!snap.metadata.fromCache && !serverSynced[coll]){ serverSynced[coll]=true; if(coll==="recurring"||coll==="purchases") setTimeout(processRecurring,0); }
      pendingSync = COLLS.some(k=>pend[k]);
      if(COLLS.every(k=>ready[k])) writeCache();
      if(!document.querySelector(".scrim") && !ui.catEdit && !ui.catAdd) render();
    }, x=>{ console.error(x); toast("Couldn't load your data — check your Firestore rules"); }));
  });
}
function loadCacheFor(id){ const c=readLS(CACHE_PREFIX+id); COLLS.forEach(k=>state[k]=(c&&c[k])||{}); }

const lastUid = readLS(LAST_UID);
if(lastUid){ loadCacheFor(lastUid); user={uid:lastUid,email:readLS("ledger-last-email")||""}; paint(); user=null; }

onAuthStateChanged(auth, u=>{
  if(u){
    const switched = !user || user.uid!==u.uid;
    user=u;
    try{ localStorage.setItem(LAST_UID,JSON.stringify(u.uid)); localStorage.setItem("ledger-last-email",JSON.stringify(u.email||"")); }catch(x){}
    if(switched){ if(u.uid!==lastUid) loadCacheFor(u.uid); authUI.busy=false; paint(); startSync(); }
  }else{
    user=null; unsubs.forEach(x=>x()); unsubs=[];
    COLLS.forEach(k=>state[k]={});
    try{ localStorage.removeItem(LAST_UID); }catch(x){}
    paintAuth();
  }
});
addEventListener("online",()=>{ online=true; if(user) render(); });
addEventListener("offline",()=>{ online=false; if(user) render(); });
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"&&user){ processRecurring(); render(); } });

if("serviceWorker" in navigator){ addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{})); }
