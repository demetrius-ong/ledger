import { initializeApp } from "firebase/app";
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, setDoc, deleteDoc, collection, onSnapshot, writeBatch } from "firebase/firestore";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "firebase/auth";

"use strict";
const $ = (s,r=document)=>r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => "$" + (Math.round(n*100)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const monthKey = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
const monthLabel = k => { const [y,m]=k.split("-").map(Number); return new Date(y,m-1,1).toLocaleDateString("en-US",{month:"long",year:"numeric"}); };
const shiftMonth = (k,n) => { const [y,m]=k.split("-").map(Number); return monthKey(new Date(y,m-1+n,1)); };
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const toLocalInput = iso => { const d=new Date(iso); const p=n=>String(n).padStart(2,"0"); return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes()); };

/* ---------- starfield: drawn once, a few stars twinkle ---------- */
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

/* ---------- storage: Firebase (Firestore + Auth) ----------
   Data lives at users/{uid}/{purchases|saved|categories|income}/{id}.
   Firestore keeps its own offline copy in this device's storage, and a
   small localStorage copy lets the page draw instantly before sign-in resolves. */
const COLLS = ["purchases","saved","categories","income"];
const state = { purchases:{}, saved:{}, categories:{}, income:{} };
let user = null, mode = "cache", online = navigator.onLine, pendingSync = false;
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
const nowKey = monthKey(new Date());
const ui = { view:"overview", month:nowKey, cat:null, confirm:null, catEdit:null, catConfirm:null, catAdd:false };

function categoriesList(){
  const names = new Set(Object.values(state.categories).map(c=>c.name));
  Object.values(state.purchases).forEach(p=>p.category&&names.add(p.category));
  Object.values(state.saved).forEach(p=>p.category&&names.add(p.category));
  return [...names].sort((a,b)=>a.localeCompare(b));
}
function monthIncome(k){ return Object.entries(state.income).map(([id,p])=>({id,...p})).filter(p=>monthKey(new Date(p.ts))===k).sort((a,b)=>b.ts.localeCompare(a.ts)); }
function addCategory(v){
  v=(v||"").trim().replace(/\s+/g," ");
  if(!v) return null;
  const existing = categoriesList().find(c=>c.toLowerCase()===v.toLowerCase());
  if(existing) return existing;
  put("categories", uid(), {name:v});
  return v;
}
function monthPurchases(k){ return Object.entries(state.purchases).map(([id,p])=>({id,...p})).filter(p=>monthKey(new Date(p.ts))===k).sort((a,b)=>b.ts.localeCompare(a.ts)); }
function usage(name){
  return { p:Object.values(state.purchases).filter(x=>x.category===name).length, s:Object.values(state.saved).filter(x=>x.category===name).length };
}

/* ---------- category rename / delete ---------- */
async function renameCategory(oldName,newName){
  newName=newName.trim().replace(/\s+/g," ");
  if(!newName||newName===oldName){ render(); return; }
  const existing = categoriesList().find(c=>c.toLowerCase()===newName.toLowerCase()&&c!==oldName);
  const target = existing || newName;
  const jobs=[];
  let hasDoc=false;
  for(const [id,c] of Object.entries(state.categories)){
    if(c.name===oldName){ if(existing||hasDoc) jobs.push(()=>del("categories",id)); else { hasDoc=true; jobs.push(()=>put("categories",id,{name:target})); } }
  }
  if(!hasDoc&&!existing) jobs.push(()=>put("categories",uid(),{name:target}));
  for(const [id,p] of Object.entries(state.purchases)) if(p.category===oldName) jobs.push(()=>put("purchases",id,{...p,category:target}));
  for(const [id,s] of Object.entries(state.saved)) if(s.category===oldName) jobs.push(()=>put("saved",id,{...s,category:target}));
  const runs = jobs.map(j=>j()); render(); await Promise.all(runs);
  toast(existing?`Merged into ${target}`:`Renamed to ${target}`);
}
async function deleteCategory(name){
  const runs=[];
  for(const [id,c] of Object.entries(state.categories)) if(c.name===name) runs.push(del("categories",id));
  for(const [id,p] of Object.entries(state.purchases)) if(p.category===name) runs.push(del("purchases",id));
  for(const [id,s] of Object.entries(state.saved)) if(s.category===name) runs.push(del("saved",id));
  render(); await Promise.all(runs); toast(`Deleted ${name}`);
}

/* ---------- render ---------- */
const chevL='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>';
const chevR='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 5 5-5 5"/></svg>';
const planet='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="5.5"/><ellipse cx="12" cy="12" rx="11" ry="3.6" transform="rotate(-20 12 12)"/></svg>';

let pendingRender=false;
function render(){
  if(pendingRender) return; pendingRender=true;
  requestAnimationFrame(()=>{ pendingRender=false; paint(); });
}
function paint(){
  const app=$("#app");
  const focusId=document.activeElement&&document.activeElement.id;
  if(ui.view==="overview") app.innerHTML = overviewHTML();
  else if(ui.view==="history") app.innerHTML = historyHTML();
  else if(ui.view==="earned") app.innerHTML = earnedHTML();
  else app.innerHTML = savedHTML();
  if(ui.catAdd){ const i=$("#cat-new"); if(i&&focusId!=="cat-new") i.focus(); }
  if(focusId==="cat-rename"||ui.catEdit){ const i=$("#cat-rename"); if(i&&document.activeElement!==i){ i.focus(); i.setSelectionRange(i.value.length,i.value.length); } }
}

function headerHTML(){
  return `<div class="top"><div class="brand">${planet}Ledger</div>
    <div class="month-nav">
      <button class="icon-btn" data-act="prev" aria-label="Previous month">${chevL}</button>
      <div class="lbl">${esc(monthLabel(ui.month))}</div>
      <button class="icon-btn" data-act="next" aria-label="Next month" ${ui.month>=nowKey?"disabled":""}>${chevR}</button>
    </div></div>`;
}

function catRow(c,max,total){
  if(ui.catEdit===c.name){
    return `<div class="cat"><div class="cat-edit">
      <input type="text" id="cat-rename" maxlength="40" value="${esc(c.name)}" aria-label="New name for ${esc(c.name)}">
      <button class="mini go" data-act="cat-save" data-cat="${esc(c.name)}">Save</button>
      <button class="mini" data-act="cat-cancel">Cancel</button></div></div>`;
  }
  if(ui.catConfirm===c.name){
    const u=usage(c.name);
    const parts=[]; if(u.p) parts.push(`${u.p} purchase${u.p===1?"":"s"} (all months)`); if(u.s) parts.push(`${u.s} saved purchase${u.s===1?"":"s"}`);
    return `<div class="cat"><div class="cat-warn">Delete <b>${esc(c.name)}</b>${parts.length?` and its ${parts.join(" and ")}`:""}? This can't be undone.
      <div class="confirm"><button class="mini yes" data-act="cat-del-yes" data-cat="${esc(c.name)}">Delete</button><button class="mini" data-act="cat-cancel">Keep</button></div></div></div>`;
  }
  return `<div class="cat">
    <button class="cat-open" data-act="cat" data-cat="${esc(c.name)}">
      <div class="row"><span class="name">${esc(c.name)}</span><span class="num">${money(c.sum)}</span></div>
      <div class="sub">${c.n} purchase${c.n===1?"":"s"}${total>0&&c.sum>0?" · "+Math.round(c.sum/total*100)+"%":""}</div>
      <div class="track"><div class="fill" style="width:${(c.sum/max*100).toFixed(1)}%"></div></div>
    </button>
    <div class="tools"><button class="mini" data-act="cat-edit" data-cat="${esc(c.name)}" aria-label="Rename ${esc(c.name)}">Edit</button><button class="mini del" data-act="cat-del" data-cat="${esc(c.name)}" aria-label="Delete ${esc(c.name)}">✕</button></div>
  </div>`;
}

function signed(n){ n=Math.round(n*100)/100; return (n<0?"−":n>0?"+":"")+money(Math.abs(n)); }

function overviewHTML(){
  const items = monthPurchases(ui.month);
  const total = items.reduce((s,p)=>s+p.amount,0);
  const earned = monthIncome(ui.month).reduce((s,p)=>s+p.amount,0);
  const net = earned-total;
  const byCat = {};
  items.forEach(p=>{ byCat[p.category]=byCat[p.category]||{sum:0,n:0}; byCat[p.category].sum+=p.amount; byCat[p.category].n++; });
  const cats = categoriesList().map(n=>({name:n,sum:byCat[n]?.sum||0,n:byCat[n]?.n||0})).sort((a,b)=>b.sum-a.sum||a.name.localeCompare(b.name));
  const max = Math.max(1,...cats.map(c=>c.sum));
  const [whole,cents] = money(total).split(".");
  const savedCount = Object.keys(state.saved).length;
  const isNow = ui.month===nowKey;
  const addRow = ui.catAdd ? `<div class="cat"><div class="cat-edit">
      <input type="text" id="cat-new" maxlength="40" placeholder="New category name, e.g. Groceries" aria-label="New category name">
      <button class="mini go" data-act="cat-add-save">Add</button>
      <button class="mini" data-act="cat-cancel">Cancel</button></div></div>` : "";
  return headerHTML() + `
    <div class="total">
      <button class="total-main" data-act="all" aria-label="See all spending this month">
        <div class="k">Spent ${isNow?"this month":"in "+esc(monthLabel(ui.month).split(" ")[0])}</div>
        <div class="v">${whole}<small>.${cents}</small></div>
        <div class="meta"><span>${items.length} purchase${items.length===1?"":"s"}</span><span>View history →</span></div>
      </button>
      <div class="stats">
        <button class="stat" data-act="earned"><span class="sk">Earned</span><span class="sv earn">${money(earned)}</span></button>
        <div class="stat"><span class="sk">Net gain</span><span class="sv ${net>0?"pos":net<0?"neg":""}">${signed(net)}</span></div>
      </div>
    </div>
    <div class="actions">
      <button class="act one" data-act="add-once"><span class="dot">+</span><span>One-time purchase<small>Log it now</small></span></button>
      <button class="act sv" data-act="add-saved"><span class="dot">★</span><span>Saved purchase<small>Reuse later</small></span></button>
      <button class="act ea" data-act="add-earn"><span class="dot">$</span><span>Money earned<small>Paychecks, gigs, gifts — anything coming in</small></span></button>
    </div>
    <button class="saved-tab" data-act="saved"><span>Saved purchases — tap to add quickly</span><span class="count">${savedCount}</span></button>
    <h2>Categories <button class="h-add" data-act="cat-add">+ Add category</button></h2>
    <div class="list">${addRow}${cats.length? cats.map(c=>catRow(c,max,total)).join("") : (ui.catAdd?"":`<div class="empty">No categories yet. Add one above or log a one-time purchase.</div>`)}</div>
    ${footerHTML()}`;
}

function itemRow(p, withCat, income){
  const t = new Date(p.ts).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
  const confirming = ui.confirm===p.id;
  const name = income ? (p.note||"Money earned") : (p.note||p.category);
  const sub = income ? t : `${withCat&&p.note?esc(p.category)+" · ":""}${t}`;
  const pre = income ? "e" : "";
  return `<div class="item">
    <div class="main"><div class="name">${esc(name)}${p.fromSaved?'<span class="tag">saved</span>':""}</div>
    <div class="sub">${sub}</div></div>
    <div class="amt ${income?"earn":""}">${income?"+":""}${money(p.amount)}</div>
    <div class="tools">${confirming
      ? `<span class="confirm"><button class="mini yes" data-act="${pre}del-yes" data-id="${p.id}">Delete</button><button class="mini" data-act="del-no">Keep</button></span>`
      : `<button class="mini" data-act="${pre}edit" data-id="${p.id}">Edit</button><button class="mini del" data-act="${pre}del" data-id="${p.id}" aria-label="Delete">✕</button>`}
    </div></div>`;
}

function grouped(items, fn){
  const groups = {};
  items.forEach(p=>{ const d=new Date(p.ts).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}); (groups[d]=groups[d]||[]).push(p); });
  return Object.entries(groups).map(([d,ps])=>`<div class="day">${esc(d)}</div><div class="list">${ps.map(fn).join("")}</div>`).join("");
}

function historyHTML(){
  let items = monthPurchases(ui.month);
  if(ui.cat) items = items.filter(p=>p.category===ui.cat);
  const total = items.reduce((s,p)=>s+p.amount,0);
  return headerHTML() + `
    <button class="back" data-act="home">${chevL} Overview</button>
    <div class="vhead"><div class="t">${ui.cat?esc(ui.cat):"All spending"}</div>
      <div class="s"><b>${money(total)}</b> across ${items.length} purchase${items.length===1?"":"s"} in ${esc(monthLabel(ui.month))}</div></div>
    ${items.length? grouped(items,p=>itemRow(p,!ui.cat,false))
      : `<div class="list"><div class="empty">Nothing logged ${ui.cat?"in this category ":""}for ${esc(monthLabel(ui.month))}.</div></div>`}`;
}

function earnedHTML(){
  const items = monthIncome(ui.month);
  const total = items.reduce((s,p)=>s+p.amount,0);
  return headerHTML() + `
    <button class="back" data-act="home">${chevL} Overview</button>
    <div class="vhead"><div class="t">Money earned</div>
      <div class="s"><b>${money(total)}</b> from ${items.length} entr${items.length===1?"y":"ies"} in ${esc(monthLabel(ui.month))}</div></div>
    ${items.length? grouped(items,p=>itemRow(p,false,true))
      : `<div class="list"><div class="empty">No money earned logged for ${esc(monthLabel(ui.month))}.</div></div>`}
    <div class="btnrow" style="margin-top:14px"><button class="btn" data-act="add-earn">+ Add money earned</button></div>`;
}

function savedHTML(){
  const list = Object.entries(state.saved).map(([id,s])=>({id,...s})).sort((a,b)=>(a.note||a.category).localeCompare(b.note||b.category));
  return `<div class="top"><div class="brand">${planet}Ledger</div></div>
    <button class="back" data-act="home">${chevL} Overview</button>
    <div class="vhead"><div class="t">Saved purchases</div><div class="s">Tap one to log it right now with today's date and time.</div></div>
    <div class="list">${list.length? list.map(s=>{
      const confirming = ui.confirm===s.id;
      return `<div class="sv-item">
        <button class="sv-add" data-act="use" data-id="${s.id}">
          <span class="plus">+</span>
          <span class="main"><span class="name">${esc(s.note||s.category)}</span><span class="sub" style="display:block">${s.note?esc(s.category):"Saved purchase"}</span></span>
          <span class="amt num">${money(s.amount)}</span>
        </button>
        <div class="tools">${confirming
          ? `<span class="confirm"><button class="mini yes" data-act="sdel-yes" data-id="${s.id}">Delete</button><button class="mini" data-act="del-no">Keep</button></span>`
          : `<button class="mini" data-act="sedit" data-id="${s.id}">Edit</button><button class="mini del" data-act="sdel" data-id="${s.id}" aria-label="Delete saved purchase">✕</button>`}</div>
      </div>`;}).join("") : `<div class="empty">No saved purchases yet.</div>`}
    </div>
    <div class="btnrow" style="margin-top:14px"><button class="btn" data-act="add-saved">+ New saved purchase</button></div>`;
}

/* ---------- form sheet ---------- */
// kinds: once | edit (purchase) · saved | sedit (saved purchase) · earn | eedit (money earned)
function openSheet(kind, id){
  const saving = kind==="saved"||kind==="sedit";
  const income = kind==="earn"||kind==="eedit";
  const editing = kind==="edit"||kind==="sedit"||kind==="eedit";
  const src = kind==="edit"?state.purchases[id]:kind==="sedit"?state.saved[id]:kind==="eedit"?state.income[id]:null;
  if(editing && !src) return;
  const f = { category: src?.category || "", amount: src? String(src.amount) : "", note: src?.note || "", ts: src?.ts || new Date().toISOString(), newOpen:false };
  const orig = JSON.stringify([f.category, Number(f.amount)||0, f.note.trim(), f.ts]);
  const titles = {once:"One-time purchase",saved:"New saved purchase",edit:"Edit purchase",sedit:"Edit saved purchase",earn:"Money earned",eedit:"Edit money earned"};
  const hints = {once:"Pick a category, enter the amount, and save. Today's date is recorded automatically.",
    saved:"Set it up once. It goes into your Saved purchases tab — tap it there whenever you buy it.",
    edit:"Change anything, including the date.",sedit:"Changes apply the next time you tap it.",
    earn:"Enter what came in. Today's date is recorded automatically.",eedit:"Change anything, including the date."};
  const hasDate = kind==="edit"||kind==="eedit";
  function draw(){
    const cats = categoriesList();
    if(f.category && !cats.includes(f.category)) cats.push(f.category);
    $("#sheetRoot").innerHTML = `<div class="scrim" data-sheet="scrim"><div class="sheet ${saving?"saving":""} ${income?"income":""}" role="dialog" aria-modal="true" aria-labelledby="sh-t">
      <h3 id="sh-t">${titles[kind]}</h3><p class="hint">${hints[kind]}</p>
      ${income?"":`<div class="field"><div class="lab">Category</div>
        <div class="chips">${cats.map(c=>`<button class="chip" data-sheet="pick" data-cat="${esc(c)}" aria-pressed="${c===f.category}">${esc(c)}</button>`).join("")}
          <button class="chip new" data-sheet="newcat">+ New category</button></div>
        ${f.newOpen?`<div class="newcat"><input type="text" id="f-newcat" placeholder="e.g. Groceries" maxlength="40"><button class="btn primary" style="flex:none;padding:10px 14px" data-sheet="addcat">Add</button></div>`:""}
      </div>`}
      <div class="field"><label for="f-amt">Amount</label><div class="amount-in"><span>$</span><input type="number" id="f-amt" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${esc(f.amount)}"></div></div>
      <div class="field"><label for="f-note">${income?"Source":"Name"} (optional)</label><input type="text" id="f-note" maxlength="60" placeholder="${income?"e.g. Paycheck, DoorDash":saving?"e.g. Chipotle bowl":"e.g. Walmart run"}" value="${esc(f.note)}"></div>
      ${hasDate?`<div class="field"><label for="f-ts">Date &amp; time</label><input type="datetime-local" id="f-ts" value="${toLocalInput(f.ts)}"></div>`:""}
      <p class="err" id="f-err"></p>
      <div class="btnrow"><button class="btn" data-sheet="cancel">Cancel</button><button class="btn primary" data-sheet="save">${kind==="saved"?"Save to saved purchases":"Save"}</button></div>
    </div></div>`;
    if(f.newOpen) $("#f-newcat").focus();
    else if(!editing && (income || f.category)) $("#f-amt").focus();
  }
  function sync(){
    const a=$("#f-amt"); if(a) f.amount=a.value;
    const n=$("#f-note"); if(n) f.note=n.value;
    const t=$("#f-ts"); if(t&&t.value&&t.value!==toLocalInput(f.ts)) f.ts=new Date(t.value).toISOString();
  }
  function close(){ $("#sheetRoot").innerHTML=""; $("#sheetRoot").onclick=null; document.removeEventListener("keydown",onKey); render(); }
  function onKey(e){ if(e.key==="Escape") close(); if(e.key==="Enter"&&e.target.id==="f-newcat"){ e.preventDefault(); addCat(); } }
  function addCat(){
    sync();
    const name = addCategory($("#f-newcat")?.value);
    if(!name) return;
    f.category = name; f.newOpen=false; draw();
  }
  $("#sheetRoot").onclick = e=>{
    const t=e.target.closest("[data-sheet]"); if(!t) return;
    const a=t.dataset.sheet;
    if(a==="scrim" && e.target===t) return close();
    if(a==="cancel") return close();
    if(a==="pick"){ sync(); f.category=t.dataset.cat; draw(); }
    if(a==="newcat"){ sync(); f.newOpen=!f.newOpen; draw(); }
    if(a==="addcat") addCat();
    if(a==="save"){
      sync();
      const amt = Math.round(parseFloat(f.amount)*100)/100;
      const note=f.note.trim();
      // Editing with nothing changed: just close, same as Cancel.
      if(editing && JSON.stringify([f.category, amt||0, note, f.ts])===orig) return close();
      if(!income && !f.category) return $("#f-err").textContent="Pick a category or add a new one.";
      if(!(amt>0)) return $("#f-err").textContent="Enter an amount greater than $0.";
      if(kind==="once"){ put("purchases",uid(),{category:f.category,amount:amt,note,ts:new Date().toISOString()}); toast("Logged "+money(amt)+" · "+f.category); }
      if(kind==="edit"){ put("purchases",id,{...src,category:f.category,amount:amt,note,ts:f.ts}); toast("Purchase updated"); }
      if(kind==="saved"){ put("saved",uid(),{category:f.category,amount:amt,note}); toast("Added to saved purchases"); }
      if(kind==="sedit"){ put("saved",id,{category:f.category,amount:amt,note}); toast("Saved purchase updated"); }
      if(kind==="earn"){ put("income",uid(),{amount:amt,note,ts:new Date().toISOString()}); toast("Logged +"+money(amt)+" earned"); }
      if(kind==="eedit"){ put("income",id,{...src,amount:amt,note,ts:f.ts}); toast("Money earned updated"); }
      close();
    }
  };
  document.addEventListener("keydown",onKey);
  draw();
}

let toastT;
function toast(msg){ $("#toastRoot").innerHTML=`<div class="toast" role="status">${esc(msg)}</div>`; clearTimeout(toastT); toastT=setTimeout(()=>$("#toastRoot").innerHTML="",2200); }

/* ---------- events ---------- */
$("#app").addEventListener("keydown", e=>{
  if(e.target.id==="cat-new"){
    if(e.key==="Enter"){ e.preventDefault(); const n=addCategory(e.target.value); ui.catAdd=false; render(); if(n) toast("Added "+n); }
    if(e.key==="Escape"){ ui.catAdd=false; render(); }
    return;
  }
  if(e.target.id!=="cat-rename") return;
  if(e.key==="Enter"){ e.preventDefault(); const old=ui.catEdit; ui.catEdit=null; renameCategory(old,e.target.value); }
  if(e.key==="Escape"){ ui.catEdit=null; render(); }
});
$("#app").addEventListener("click", e=>{
  const t=e.target.closest("[data-act]"); if(!t) return;
  const a=t.dataset.act, id=t.dataset.id, cat=t.dataset.cat;
  if(a!=="del"&&a!=="sdel"&&a!=="edel") ui.confirm=null;
  if(!a.startsWith("cat-")){ ui.catEdit=null; ui.catConfirm=null; ui.catAdd=false; }
  switch(a){
    case "prev": ui.month=shiftMonth(ui.month,-1); break;
    case "next": if(ui.month<nowKey) ui.month=shiftMonth(ui.month,1); break;
    case "all": ui.view="history"; ui.cat=null; window.scrollTo({top:0}); break;
    case "cat": ui.view="history"; ui.cat=cat; window.scrollTo({top:0}); break;
    case "saved": ui.view="saved"; window.scrollTo({top:0}); break;
    case "export": exportData(); return;
    case "import": openImport(); return;
    case "signout": signOut(auth); return;
    case "earned": ui.view="earned"; window.scrollTo({top:0}); break;
    case "add-earn": return openSheet("earn");
    case "eedit": return openSheet("eedit",id);
    case "edel": ui.confirm=id; break;
    case "edel-yes": del("income",id); toast("Entry deleted"); break;
    case "cat-add": ui.catAdd=true; ui.catEdit=null; ui.catConfirm=null; break;
    case "cat-add-save": { const n=addCategory($("#cat-new")?.value); ui.catAdd=false; if(n) toast("Added "+n); break; }
    case "home": ui.view="overview"; ui.cat=null; window.scrollTo({top:0}); break;
    case "add-once": return openSheet("once");
    case "add-saved": return openSheet("saved");
    case "edit": return openSheet("edit",id);
    case "sedit": return openSheet("sedit",id);
    case "del": case "sdel": ui.confirm=id; break;
    case "del-no": break;
    case "del-yes": del("purchases",id); toast("Purchase deleted"); break;
    case "sdel-yes": del("saved",id); toast("Saved purchase deleted"); break;
    case "cat-edit": ui.catEdit=cat; ui.catConfirm=null; ui.catAdd=false; break;
    case "cat-del": ui.catConfirm=cat; ui.catEdit=null; ui.catAdd=false; break;
    case "cat-cancel": ui.catEdit=null; ui.catConfirm=null; ui.catAdd=false; break;
    case "cat-save": { const v=$("#cat-rename")?.value||""; ui.catEdit=null; renameCategory(cat,v); return; }
    case "cat-del-yes": ui.catConfirm=null; deleteCategory(cat); return;
    case "use": {
      const s=state.saved[id]; if(!s) return;
      put("purchases",uid(),{category:s.category,amount:s.amount,note:s.note||"",ts:new Date().toISOString(),fromSaved:true});
      ui.month=nowKey; t.classList.add("done"); toast("Logged "+money(s.amount)+" · "+(s.note||s.category));
      setTimeout(render,600); return;
    }
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
  const blob = new Blob([JSON.stringify({app:"ledger",version:1,exportedAt:new Date().toISOString(),...state},null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="ledger-backup-"+new Date().toISOString().slice(0,10)+".json";
  document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
  toast("Backup downloaded");
}
async function importData(obj){
  let n=0; const writes=[];
  for(const coll of COLLS){
    const rows = obj && obj[coll]; if(!rows||typeof rows!=="object") continue;
    for(const [id,body] of Object.entries(rows)){
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
  $("#sheetRoot").innerHTML = `<div class="scrim" data-imp="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="imp-t">
    <h3 id="imp-t">Import data</h3>
    <p class="hint">Paste the data you copied from the old Ledger, or pick a backup file. Anything already here stays; matching items are updated.</p>
    <div class="field"><label for="imp-text">Paste data</label><textarea id="imp-text" rows="6" placeholder='{"purchases": …}'></textarea></div>
    <div class="field"><label for="imp-file">Or choose a backup file</label><input type="file" id="imp-file" accept=".json,application/json"></div>
    <p class="err" id="imp-err"></p>
    <div class="btnrow"><button class="btn" data-imp="cancel">Cancel</button><button class="btn primary" data-imp="go">Import</button></div>
  </div></div>`;
  const close=()=>{ $("#sheetRoot").innerHTML=""; $("#sheetRoot").onclick=null; render(); };
  $("#sheetRoot").onclick = async e=>{
    const t=e.target.closest("[data-imp]"); if(!t) return;
    const a=t.dataset.imp;
    if(a==="scrim"&&e.target!==t) return;
    if(a==="scrim"||a==="cancel") return close();
    if(a==="go"){
      let text=$("#imp-text").value.trim();
      const file=$("#imp-file").files[0];
      if(!text&&file) text=await file.text();
      if(!text) return $("#imp-err").textContent="Paste your data or choose a file first.";
      let obj; try{ obj=JSON.parse(text); }catch(err){ return $("#imp-err").textContent="That doesn't look like Ledger data. Copy it again from the old Ledger's Export button."; }
      const n=await importData(obj);
      if(!n) return $("#imp-err").textContent="No Ledger items found in that data.";
      close(); toast(`Imported ${n} item${n===1?"":"s"}`);
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
      <p class="err" id="a-err">${esc(authUI.err)}</p>
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
function paintAuth(){ $("#app").innerHTML = authHTML(); }
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
  }catch(err){ authUI.busy=false; authUI.err=AUTH_ERRORS[err.code]||("Couldn't sign in ("+(err.code||"unknown error")+")."); paintAuth(); }
});
document.addEventListener("click", async e=>{
  const t=e.target.closest("[data-auth]"); if(!t) return;
  if(t.dataset.auth==="toggle"){ authUI.email=$("#a-email")?.value.trim()||authUI.email; authUI.mode=authUI.mode==="create"?"signin":"create"; authUI.err=""; paintAuth(); }
  if(t.dataset.auth==="reset"){
    const email=$("#a-email").value.trim(); authUI.email=email;
    if(!email){ authUI.err="Type your email above first, then tap Forgot password."; return paintAuth(); }
    try{ await sendPasswordResetEmail(auth,email); authUI.err=""; paintAuth(); toast("Reset link sent — check your email"); }
    catch(err){ authUI.err=AUTH_ERRORS[err.code]||"Couldn't send the reset email."; paintAuth(); }
  }
});

/* ---------- boot ---------- */
let unsubs=[];
function startSync(){
  unsubs.forEach(u=>u()); unsubs=[];
  const ready={}, pend={};
  COLLS.forEach(coll=>{
    unsubs.push(onSnapshot(collection(fdb,"users",user.uid,coll),{includeMetadataChanges:true},snap=>{
      const next={}; snap.docs.forEach(d=>{ next[d.id]=d.data(); });
      state[coll]=next; ready[coll]=true; pend[coll]=snap.metadata.hasPendingWrites;
      pendingSync = COLLS.some(k=>pend[k]);
      if(COLLS.every(k=>ready[k])) writeCache();
      mode="db";
      if(!document.querySelector(".scrim") && !ui.catEdit && !ui.catAdd) render();
    }, err=>{ console.error(err); toast("Couldn't load your data — check your Firestore rules"); }));
  });
}
function loadCacheFor(uid){ const c=readLS(CACHE_PREFIX+uid); COLLS.forEach(k=>state[k]=(c&&c[k])||{}); }

// Instant first paint from the last signed-in account's local copy.
const lastUid = readLS(LAST_UID);
if(lastUid){ loadCacheFor(lastUid); user={uid:lastUid,email:readLS("ledger-last-email")||""}; paint(); user=null; }

onAuthStateChanged(auth, u=>{
  if(u){
    const switched = !user || user.uid!==u.uid;
    user=u;
    try{ localStorage.setItem(LAST_UID,JSON.stringify(u.uid)); localStorage.setItem("ledger-last-email",JSON.stringify(u.email||"")); }catch(e){}
    if(switched){ if(u.uid!==lastUid) loadCacheFor(u.uid); authUI.busy=false; paint(); startSync(); }
  }else{
    user=null; unsubs.forEach(x=>x()); unsubs=[];
    COLLS.forEach(k=>state[k]={});
    try{ localStorage.removeItem(LAST_UID); }catch(e){}
    paintAuth();
  }
});
addEventListener("online",()=>{ online=true; if(user) render(); });
addEventListener("offline",()=>{ online=false; if(user) render(); });

if("serviceWorker" in navigator){ addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{})); }
