// docs/app.js — ChoreSpin unified app
// - adult/child roles (adult is canonical; 'parent' treated as adult)
// - tabs: Avatar / Wheel / Rewards / Points / Bonus
// - glossy wheel + tick + TTS + confetti
// - spin lock (no new spin until submitted)
// - rewards request flow
// - avatar upload to storage bucket 'avatars'
// - seed button (calls create_default_chores/create_default_rewards)
// - dark-mode friendly styling + readable toast

import { supabase } from './supabaseClient.js';

// Optional seed helper (safe if missing)
let seedHelper = null;
try { seedHelper = await import('./seedHelpers.js'); } catch {}

// -------------------------------
// Style injector (high-contrast light/dark)
// -------------------------------
(function injectChoreSpinStyles(){
  const id = 'cs-autostyles';
  if (document.getElementById(id)) return;
  const css = `
  :root { color-scheme: light dark; }
  @media (prefers-color-scheme: light) {
    :root{
      --bg:#ffffff; --text:#111827; --muted:#4b5563;
      --card:#ffffff; --border:#d1d5db; --tab:#f3f4f6;
      --btn:#f8fafc; --btnText:#111827; --toast:#eef6ff; --toastText:#0b3d5c; --accent:#e11d48;
    }
  }
  @media (prefers-color-scheme: dark) {
    :root{
      --bg:#0b0f14; --text:#e5e7eb; --muted:#9ca3af;
      --card:#111827; --border:#374151; --tab:#0f172a;
      --btn:#1f2937; --btnText:#e5e7eb; --toast:#111827; --toastText:#e5e7eb; --accent:#f472b6;
    }
  }
  html, body { background: var(--bg); color: var(--text); }
  #cs-tabs {
    display:flex; flex-wrap:wrap; gap:8px; background:var(--tab);
    border:1px solid var(--border); border-radius:12px; padding:8px; margin-bottom:12px;
  }
  .cs-tab-btn, #seedBtn, #cs-signout, .cs-btn {
    background:var(--btn); color:var(--btnText); border:1px solid var(--border);
    border-radius:10px; padding:8px 12px; cursor:pointer;
  }
  .cs-tab-btn:hover, #seedBtn:hover, #cs-signout:hover, .cs-btn:hover { filter:brightness(1.06); }
  .card {
    background:var(--card); border:1px solid var(--border); border-radius:12px;
    padding:14px; margin:12px 0; box-shadow:0 1px 3px rgba(0,0,0,.08);
  }
  h3 { margin:0 0 10px 0; font-size:18px; }
  .muted { color:var(--muted); }
  #toast {
    position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
    background:var(--toast); color:var(--toastText);
    border:1px solid var(--border); border-radius:12px; padding:10px 14px;
    box-shadow:0 6px 24px rgba(0,0,0,.25); z-index:9999; max-width:92%;
  }
  #cs-wheel { border-radius:12px; border:1px solid var(--border); background:#000; }
  select, input, button {
    color:var(--text); background:var(--btn); border:1px solid var(--border); border-radius:10px;
  }
  `;
  const s = document.createElement('style');
  s.id = id; s.textContent = css; document.head.appendChild(s);
})();

// -------------------------------
// Utilities & State
// -------------------------------
function isAdultRole(role) { return role === 'adult' || role === 'parent'; }

const state = {
  user: null,
  householdId: null,
  myAdult: false,
  members: [],
  activeMemberId: null,
  chores: [],
  rewards: [],
  points: 0,
  lastAssignmentId: null,
  spinLocked: false,
  tickAudio: null,
  ttsEnabled: true
};

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style' && v && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  (Array.isArray(children)?children:[children]).forEach(c => n.append(c instanceof Node ? c : document.createTextNode(c)));
  return n;
}

function toast(msg, isErr=false){
  console[isErr?'error':'log'](msg);
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id:'toast' }); document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(t._h); t._h=setTimeout(()=>{ try{t.remove();}catch{} }, 2800);
}

function setSpinLock(locked, reason=''){ state.spinLocked = locked;
  localStorage.setItem('cs_spin_locked', JSON.stringify({locked,reason,memberId:state.activeMemberId,ts:Date.now()})); }
function loadSpinLock(){ try{
  const o = JSON.parse(localStorage.getItem('cs_spin_locked')||'{}');
  state.spinLocked = !!(o && o.memberId===state.activeMemberId && o.locked);
} catch{ state.spinLocked=false; } }

// --- Confetti (simple DOM confetti)
function confettiBurst(){
  const N=120, box=el('div',{style:{position:'fixed',inset:'0',pointerEvents:'none',overflow:'hidden',zIndex:9998}});
  document.body.appendChild(box);
  for(let i=0;i<N;i++){
    const p=el('div',{style:{position:'absolute',top:'-10px',left:Math.random()*100+'%',
      width:'6px',height:(6+Math.random()*8)+'px',background:`hsl(${Math.floor(Math.random()*360)} 90% 55%)`,
      opacity:.9,transform:`rotate(${Math.random()*360}deg)`,borderRadius:'1px'}});
    box.appendChild(p);
    const x=(Math.random()*2-1)*150, dur=1200+Math.random()*900;
    p.animate([{transform:p.style.transform,top:'-10px'},
               {transform:`translate(${x}px, 100vh) rotate(${Math.random()*720}deg)`,top:'100vh'}],
              {duration:dur,easing:'ease-out',fill:'forwards'});
  }
  setTimeout(()=>box.remove(),2200);
}

// --- Voice helpers
let voicesWarmed=false;
function warmVoices(){ if(voicesWarmed) return; try{
  speechSynthesis.getVoices();
  const u=new SpeechSynthesisUtterance(''); speechSynthesis.speak(u); speechSynthesis.cancel();
  voicesWarmed=true;
} catch{} }
async function speak(text){ if(!state.ttsEnabled) return; try{
  const u=new SpeechSynthesisUtterance(text); u.rate=1.0; speechSynthesis.cancel(); speechSynthesis.speak(u);
} catch{} }
function voiceToggleUI(container){
  const label=el('label',{style:{display:'inline-flex',alignItems:'center',gap:'6px',marginLeft:'8px',fontSize:'12px'}},[
    el('input',{type:'checkbox',checked:state.ttsEnabled?'checked':null, onchange:e=>{ state.ttsEnabled=e.target.checked; if(e.target.checked) warmVoices(); }}),
    'Voice on'
  ]);
  container.appendChild(label);
}

// -------------------------------
// Auth & Bootstrap
// -------------------------------
async function bootstrap(){
  try { state.tickAudio=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='); } catch {}
  const { data:{user} } = await supabase.auth.getUser(); state.user=user;
  renderShell();
  if(!state.user){ renderAuth(); return; }
  await afterLogin();
}

async function afterLogin(){
  const { data: myMember, error } = await supabase
    .from('members').select('household_id, role, display_name, id')
    .eq('user_id', state.user.id).limit(1).maybeSingle();
  if(error || !myMember){ toast('No membership found. Ask an adult to add you.', true); renderAuth(); return; }

  state.householdId=myMember.household_id; state.myAdult=isAdultRole(myMember.role);
  await loadMembers();
  await selectActiveMember(myMember.id || null);
  await refreshRewardsAndPoints();
  renderApp();
}

// -------------------------------
// Data Loaders
// -------------------------------
async function loadMembers(){
  const { data, error } = await supabase
    .from('members').select('id, display_name, role, user_id')
    .eq('household_id', state.householdId).order('display_name', {ascending:true});
  if(error){ toast('Failed to load members: '+error.message, true); state.members=[]; }
  else state.members=data||[];
}

async function loadEligibleChores(forMemberId){
  const m = state.members.find(x=>x.id===forMemberId);
  const audiences = isAdultRole(m?.role) ? ['adults','any'] : ['kids','any'];
  const { data, error } = await supabase
    .from('chores').select('id,title,minutes,points,audience,weight,active')
    .eq('household_id', state.householdId).eq('active', true);
  if(error){ toast('Failed to load chores: '+error.message, true); state.chores=[]; return; }
  state.chores = (data||[]).filter(c=>audiences.includes(c.audience));
  // TODO: add chore_eligibility allow/deny if needed
}

async function refreshRewardsAndPoints(){
  const { data: rewards } = await supabase
    .from('rewards').select('id,title,cost_points,active')
    .eq('household_id', state.householdId).eq('active', true).order('cost_points', {ascending:true});
  state.rewards = rewards || [];

  state.points = 0;
  if(state.activeMemberId){
    try {
      const { data: vp } = await supabase
        .from('member_points').select('member_id, points_balance')
        .eq('member_id', state.activeMemberId).maybeSingle();
      if(vp && typeof vp.points_balance==='number') state.points = vp.points_balance;
    } catch { /* view may not exist yet */ }
  }
}

// -------------------------------
// Spin & Assignment
// -------------------------------
function weightedRandom(items){ const total=items.reduce((a,b)=>a+(b.weight||1),0);
  let r=Math.random()*total; for(const it of items){ r -= (it.weight||1); if(r<=0) return it; } return items[items.length-1]; }
function buildWheelSlices(chores){ return chores.map(c=>({label:c.title, weight:c.weight||1, chore:c})); }

async function startAssignment(memberId, chore){
  const { data, error } = await supabase.rpc('start_assignment', { p_member_id:memberId, p_chore_id:chore.id });
  if(error) throw error;
  let id=null; if(data){ if(typeof data==='string') id=data; else if(typeof data==='object') id=data.id||data.assignment_id||null; }
  state.lastAssignmentId=id; setSpinLock(true,'active-assignment');
}

async function submitAssignment(){
  if(!state.lastAssignmentId){
    try{
      const { data } = await supabase.from('assignments')
        .select('id, submitted, ends_at').eq('member_id', state.activeMemberId)
        .order('created_at', {ascending:false}).limit(1);
      if(data && data.length) state.lastAssignmentId=data[0].id;
    }catch{}
  }
  if(!state.lastAssignmentId) throw new Error('No active assignment id');
  const { error } = await supabase.rpc('submit_assignment', { p_assignment_id: state.lastAssignmentId });
  if(error) throw error;
  setSpinLock(false,'submitted'); state.lastAssignmentId=null;
}

// -------------------------------
// Rewards
// -------------------------------
async function requestReward(rewardId){
  const body = { household_id:state.householdId, member_id:state.activeMemberId, reward_id:rewardId, status:'pending' };
  const { error } = await supabase.from('redemptions').insert(body);
  if(error) throw error;
  toast('Reward requested! An adult will approve.');
}

// -------------------------------
// Avatars (Storage bucket: avatars)
// -------------------------------
async function uploadAvatar(file){
  if(!file) return;
  const ext = (file.name.split('.').pop()||'png').toLowerCase();
  const path = `${state.activeMemberId}/${Date.now()}.${ext}`;
  const { error:upErr } = await supabase.storage.from('avatars').upload(path, file, { cacheControl:'3600', upsert:true });
  if(upErr) throw upErr;
  const { data:pub } = supabase.storage.from('avatars').getPublicUrl(path);
  const { error:updErr } = await supabase.from('members').update({ avatar_url: pub.publicUrl }).eq('id', state.activeMemberId);
  if(updErr) throw updErr;
  toast('Avatar updated!'); renderTabs();
}

// -------------------------------
// Seeding
// -------------------------------
async function seedStarterPack(){
  if(!state.householdId) throw new Error('No household');
  if(!state.myAdult) throw new Error('Adults only');
  if(seedHelper?.seedDefaultsForHousehold){
    await seedHelper.seedDefaultsForHousehold(supabase, state.householdId);
  } else {
    let e1 = (await supabase.rpc('create_default_chores', { p_household_id: state.householdId })).error; if(e1) throw e1;
    let e2 = (await supabase.rpc('create_default_rewards', { p_household_id: state.householdId })).error; if(e2) throw e2;
  }
  toast('Starter chores & rewards loaded.');
  await loadEligibleChores(state.activeMemberId);
  await refreshRewardsAndPoints();
  renderTabs();
}

// -------------------------------
/* UI Shell + Tabs */
// -------------------------------
function renderShell(){
  if(document.getElementById('cs-root')) return;
  const root = el('div',{id:'cs-root',style:{maxWidth:'900px',margin:'0 auto',padding:'12px'}});
  const header = el('div',{style:{display:'flex',alignItems:'center',gap:'12px',marginBottom:'12px'}},[
    el('img',{id:'cs-logo',src:'./assets/logo-chorespin-light.png',alt:'ChoreSpin',style:{height:'28px'}}),
    el('div',{id:'cs-user-pill',style:{marginLeft:'auto',fontSize:'14px',opacity:.85}},['…']),
    el('button',{id:'cs-signout', class:'cs-btn', onclick: async()=>{ await supabase.auth.signOut(); location.reload(); }},'Sign out')
  ]);
  const tabs = el('div',{id:'cs-tabs'});
  const main = el('div',{id:'cs-main'});
  document.body.prepend(root); root.append(header,tabs,main);

  // dark logo swap
  try{ const img=document.getElementById('cs-logo'); const mq=window.matchMedia('(prefers-color-scheme: dark)');
    const swap=()=>img.src = mq.matches ? './assets/logo-chorespin-dark.png' : './assets/logo-chorespin-light.png';
    swap(); mq.addEventListener('change', swap);
  }catch{}
}

function setUserPill(){
  const pill=document.getElementById('cs-user-pill');
  if(!pill) return;
  pill.innerHTML = state.user ? `${state.user.email||'Signed in'} · ${state.myAdult?'Adult':'Child'}` : 'Not signed in';
}

function makeTabBtn(name, key){ return el('button',{class:'cs-tab-btn',onclick:()=>renderTab(key)},name); }

function renderApp(){
  setUserPill();
  const tabs=document.getElementById('cs-tabs'); tabs.innerHTML='';
  // Member selector
  const sel=el('select',{id:'cs-member',onchange:async e=>{ await selectActiveMember(e.target.value); await refreshRewardsAndPoints(); renderTab('wheel'); }});
  for(const m of state.members){ const opt=el('option',{value:m.id}, m.display_name + (isAdultRole(m.role)?' (adult)':'')); if(m.id===state.activeMemberId) opt.selected=true; sel.appendChild(opt); }
  tabs.appendChild(sel);
  // tab buttons
  tabs.appendChild(makeTabBtn('Avatar','avatar'));
  tabs.appendChild(makeTabBtn('Wheel','wheel'));
  tabs.appendChild(makeTabBtn('Rewards','rewards'));
  tabs.appendChild(makeTabBtn('Points','points'));
  tabs.appendChild(makeTabBtn('Bonus','bonus'));
  if(state.myAdult){ tabs.appendChild(el('button',{id:'seedBtn',onclick:seedStarterPack},'Load Starter Pack')); }

  // voice toggle + warm on first interaction
  voiceToggleUI(tabs);
  tabs.addEventListener('click', warmVoices, { once:true });

  renderTab('wheel');
}

async function selectActiveMember(memberId){
  if(!memberId && state.members.length) memberId=state.members[0].id;
  state.activeMemberId=memberId||null;
  loadSpinLock();
  await loadEligibleChores(state.activeMemberId);
}

function renderTab(key){
  const main=document.getElementById('cs-main'); main.innerHTML='';
  if(key==='avatar') return renderAvatarTab(main);
  if(key==='wheel') return renderWheelTab(main);
  if(key==='rewards') return renderRewardsTab(main);
  if(key==='points') return renderPointsTab(main);
  if(key==='bonus') return renderBonusTab(main);
}

// ----- Avatar tab
function renderAvatarTab(main){
  const m = state.members.find(x=>x.id===state.activeMemberId);
  main.append(el('div',{class:'card'},[
    el('h3',{},`Avatar — ${m?.display_name||''}`),
    el('input',{type:'file',accept:'image/*',onchange: async e=>{ try{ await uploadAvatar(e.target.files[0]); }catch(err){ toast(err.message||String(err),true); }}}),
    el('p',{class:'muted'},'Tip: square-ish photo works best; we crop it round.')
  ]));
}

// ----- Wheel tab
function renderWheelTab(main){
  const card=el('div',{class:'card'});
  const title=el('h3',{},'Spin the Wheel');
  const info=el('div',{class:'muted'}, state.spinLocked
    ? 'Spin locked: finish your last task first.'
    : `Eligible chores: ${state.chores.length}`);
  const canvas=el('canvas',{id:'cs-wheel',width:360,height:360,style:{maxWidth:'100%',display:'block',margin:'10px auto'}});
  const ctrls=el('div',{style:{display:'flex',gap:'8px',marginTop:'10px',flexWrap:'wrap'}});
  const spinBtn=el('button',{class:'cs-btn', onclick: async ()=>{
    if(state.spinLocked){ toast('Finish your last task first 🙂'); return; }
    if(!state.chores.length){ toast('No chores available. Adults: seed or add chores.', true); return; }
    const slices=buildWheelSlices(state.chores);
    const selPromise=spinAnimation(canvas, slices);
    selPromise.then(async slice=>{
      try{
        await speak(`${slice.chore.title}. Estimated ${slice.chore.minutes} minutes.`);
        confettiBurst();
        await startAssignment(state.activeMemberId, slice.chore);
        info.textContent = `Assigned: ${slice.chore.title} · ${slice.chore.minutes}m · ${slice.chore.points}pts`;
        renderWheelControls(ctrls, slice.chore);
      }catch(err){ toast(err.message||String(err), true); }
    });
  }}, 'Spin!');
  card.append(title,info,canvas,spinBtn,ctrls); main.append(card);
  drawWheel(canvas, buildWheelSlices(state.chores));
  renderWheelControls(ctrls, null);
}

function drawWheel(canvas, slices){
  const ctx=canvas.getContext('2d'), W=canvas.width, H=canvas.height, cx=W/2, cy=H/2, r=Math.min(W,H)/2-10;
  ctx.clearRect(0,0,W,H);
  if(!slices.length){ ctx.fillStyle='#999'; ctx.textAlign='center'; ctx.font='16px system-ui'; ctx.fillText('No chores', cx, cy); return; }
  const total = slices.reduce((a,s)=>a+(s.weight||1),0);
  let start=-Math.PI/2;
  slices.forEach((s,i)=>{
    const frac=(s.weight||1)/total, end=start+frac*Math.PI*2;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,start,end); ctx.closePath();
    ctx.fillStyle = `hsl(${(i*47)%360} 70% 55%)`; ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
    const mid=(start+end)/2;
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(mid); ctx.textAlign='left'; ctx.fillStyle='#000'; ctx.font='12px system-ui';
    ctx.fillText(s.label, r*0.1, 0); ctx.restore();
    start=end;
  });
  // pointer
  ctx.beginPath(); ctx.moveTo(cx+r+4,cy); ctx.lineTo(cx+r+24,cy-8); ctx.lineTo(cx+r+24,cy+8); ctx.closePath();
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#e91e63';
  ctx.fill();
}

function spinAnimation(canvas, slices){
  return new Promise(resolve=>{
    if(!slices.length) return resolve(null);
    const ctx=canvas.getContext('2d'); let angle=0, speed=0.45+Math.random()*0.35, friction=0.985+Math.random()*0.01;
    const total = slices.reduce((a,s)=>a+(s.weight||1),0);
    const tick=()=>{
      angle+=speed; speed*=friction;
      ctx.save(); ctx.translate(canvas.width/2, canvas.height/2); ctx.rotate(angle); ctx.translate(-canvas.width/2,-canvas.height/2);
      drawWheel(canvas, slices); ctx.restore();
      try{ state.tickAudio && state.tickAudio.play().catch(()=>{});}catch{}
      if(speed<0.005){
        const rad=(( -angle % (2*Math.PI) ) + 2*Math.PI)%(2*Math.PI);
        let start=-Math.PI/2, sel=slices[0];
        for(const s of slices){ const frac=(s.weight||1)/total, end=start+frac*Math.PI*2;
          if(rad>=start && rad<end){ sel=s; break; } start=end; }
        resolve(sel); return;
      }
      requestAnimationFrame(tick);
    }; tick();
  });
}

function renderWheelControls(ctrls, chosen){
  ctrls.innerHTML='';
  if(!chosen){ ctrls.append(el('span',{class:'muted'},'Spin to get a task.')); return; }
  const started=el('button',{class:'cs-btn',onclick: async ()=>{ try{ await speak(`Starting ${chosen.title} now.`);}catch(e){}}},'Started');
  const done=el('button',{class:'cs-btn',onclick: async ()=>{ try{ await submitAssignment(); await speak('Submitted for review.'); toast('Submitted! An adult will review.'); } catch(err){ toast(err.message||String(err),true); }}},'Mark Done');
  ctrls.append(started, done);
}

// ----- Rewards tab
function renderRewardsTab(main){
  const card=el('div',{class:'card'},[ el('h3',{},'Rewards') ]);
  const sel=el('select',{id:'cs-reward',style:{minWidth:'240px'}}); sel.append(el('option',{value:''},'-- Choose a reward --'));
  state.rewards.forEach(r=>{
    const dis = state.points < r.cost_points;
    const o = el('option',{value:r.id, disabled: dis?'disabled':null},`${r.title} — ${r.cost_points} pts`);
    if(dis) o.textContent += ` (need ${r.cost_points - state.points} more)`;
    sel.append(o);
  });
  const btn=el('button',{class:'cs-btn',style:{marginLeft:'8px'},onclick: async()=>{
    const id=sel.value; if(!id) return toast('Pick a reward first.');
    try{ await requestReward(id); }catch(err){ toast(err.message||String(err),true); }
  }},'Request');
  const pts=el('div',{class:'muted',style:{marginTop:'8px'}},`Your points: ${state.points}`);
  card.append(sel,btn,pts); main.append(card);
}

// ----- Points tab
function renderPointsTab(main){
  main.append(el('div',{class:'card'},[ el('h3',{},'Points'), el('p',{},`Current balance: ${state.points}`) ]));
}

// ----- Bonus tab (placeholder)
function renderBonusTab(main){
  main.append(el('div',{class:'card'},[
    el('h3',{},'Bonus Tasks'),
    el('p',{class:'muted'},'Adults can add micro tasks later (e.g., “make coffee for mom”).')
  ]));
}

// ----- Auth UI
function renderAuth(){
  const main=document.getElementById('cs-main')||document.body; main.innerHTML='';
  const box=el('div',{class:'card'},[
    el('h3',{},'Sign in'),
    el('input',{id:'cs-email',type:'email',placeholder:'Email',style:{display:'block',width:'100%',marginBottom:'6px',padding:'8px'}}),
    el('input',{id:'cs-pass',type:'password',placeholder:'Password',style:{display:'block',width:'100%',marginBottom:'6px',padding:'8px'}}),
    el('div',{style:{display:'flex',gap:'8px'}},[
      el('button',{class:'cs-btn',onclick:signIn},'Sign in'),
      el('button',{class:'cs-btn',onclick:signUp},'Sign up')
    ])
  ]);
  const pill=document.getElementById('cs-user-pill'); if(pill) pill.textContent='Not signed in';
  main.append(box);
}
async function signIn(){
  const email=document.getElementById('cs-email').value.trim();
  const pass=document.getElementById('cs-pass').value;
  const { error } = await supabase.auth.signInWithPassword({ email, password:pass });
  if(error) return toast(error.message, true);
  const { data:{user} } = await supabase.auth.getUser(); state.user=user; await afterLogin();
}
async function signUp(){
  const email=document.getElementById('cs-email').value.trim();
  const pass=document.getElementById('cs-pass').value;
  const { error } = await supabase.auth.signUp({ email, password:pass });
  if(error) return toast(error.message, true);
  toast('Account created. If email confirmation is on, confirm then sign in.');
}

// -------------------------------
// Kickoff + optional seed shortcut
// -------------------------------
bootstrap();
window.addEventListener('keydown',(e)=>{ if(e.ctrlKey&&e.altKey&&e.key.toLowerCase()==='s'){ seedStarterPack().catch(err=>toast(err.message||String(err),true)); }});
