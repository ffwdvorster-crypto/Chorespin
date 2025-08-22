import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// UI refs
const authRow = document.getElementById('authRow');
const memberRow = document.getElementById('memberRow');
const memberSelect = document.getElementById('memberSelect');
const eligibleWrap = document.getElementById('eligible');
const whoEl = document.getElementById('who');
const wheelEl = document.getElementById('wheel');
const spinRow = document.getElementById('spinRow');
const spinBtn = document.getElementById('spin');
const resultPill = document.getElementById('result');
const startBtn = document.getElementById('start');
const activeRow = document.getElementById('activeRow');
const activeTitle = document.getElementById('activeTitle');
const activeTime = document.getElementById('activeTime');
const submitBtn = document.getElementById('submit');
const refreshBtn = document.getElementById('refresh');
const statusEl = document.getElementById('status');

let session = null;
let members = [];
let currentMember = null;
let eligibleChores = [];
let pickedChore = null;
let activeAssignment = null;
let tmr = null;

init();

async function init() {
  authRow.textContent = 'Checking session…';
  const { data: s } = await supabase.auth.getSession();
  session = s.session;
  if (!session) {
    authRow.innerHTML = `You’re not signed in. <a href="./accept.html" style="color:#6ee7b7">Use an invite link</a> or sign in first.`;
    return;
  }
  authRow.innerHTML = `Signed in as <span class="success">${session.user.email}</span>`;
  await loadMembers();
  refreshBtn.onclick = () => loadAll();
  memberSelect.onchange = () => {
    currentMember = members.find(m => m.id === memberSelect.value);
    loadAll();
  };
  spinBtn.onclick = onSpin;
  startBtn.onclick = startAssignment;
  submitBtn.onclick = submitAssignment;
}

async function loadMembers() {
  // pull all member rows tied to the signed-in user
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .eq('user_id', session.user.id);

  if (error) { statusEl.textContent = '❌ '+error.message; return; }
  members = data || [];
  if (!members.length) {
    authRow.innerHTML += `<br><span class="muted">No member profile yet. Use an invite link to join a household.</span>`;
    return;
  }
  // show selector if multiple
  memberRow.style.display = '';
  memberSelect.innerHTML = members.map(m => `<option value="${m.id}">${m.display_name} (${m.role})</option>`).join('');
  currentMember = members[0];
  await loadAll();
}

async function loadAll() {
  resultPill.style.display = 'none';
  startBtn.style.display = 'none';
  spinRow.style.display = '';
  whoEl.textContent = currentMember.display_name;
  await loadActive();
  await loadEligibleChores();
}

async function loadActive() {
  clearInterval(tmr);
  const { data, error } = await supabase
    .from('assignments')
    .select('id, status, ends_at, chore:chore_id(title, minutes)')
    .eq('child_member_id', currentMember.id)
    .in('status', ['in_progress','submitted'])
    .order('starts_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') { // not found is fine
    statusEl.textContent = '❌ '+error.message; return;
  }
  activeAssignment = data || null;
  if (activeAssignment) {
    activeRow.style.display = '';
    activeTitle.textContent = `${activeAssignment.chore.title} (${activeAssignment.chore.minutes} min)`;
    runTimer(new Date(activeAssignment.ends_at));
    spinRow.style.display = 'none';
  } else {
    activeRow.style.display = 'none';
  }
}

async function loadEligibleChores() {
  // fetch chores in same household
  const { data: chores, error } = await supabase
    .from('chores')
    .select('*')
    .eq('household_id', currentMember.household_id)
    .eq('active', true);

  if (error) { statusEl.textContent = '❌ '+error.message; return; }

  // fetch explicit allow/deny for this member
  const { data: rules, error: e2 } = await supabase
    .from('chore_eligibility')
    .select('chore_id, mode')
    .eq('member_id', currentMember.id);

  if (e2) { statusEl.textContent = '❌ '+e2.message; return; }

  // filter by audience
  const byAudience = chores.filter(c => {
    if (c.audience === 'any') return true;
    if (c.audience === 'kids') return currentMember.role === 'child';
    if (c.audience === 'adults') return currentMember.role === 'parent';
    return false;
  });

  // apply allow/deny overrides
  const ruleMap = new Map(rules.map(r => [r.chore_id, r.mode]));
  eligibleChores = byAudience.filter(c => {
    const mode = ruleMap.get(c.id);
    if (mode === 'deny') return false;
    // if there exists at least one allow for this chore globally, this member must be allowed
    const anyAllow = rules.some(r => r.mode === 'allow' && r.chore_id === c.id)
      || false;
    return mode === 'allow' || !anyAllow;
  });

  // render wheel (simple chips)
  wheelEl.innerHTML = eligibleChores.map(c => `<div class="slice">${c.title} · ${c.minutes}m</div>`).join('');
  eligibleWrap.style.display = '';
}

function pickWeighted(items) {
  const total = items.reduce((a,c)=>a+(c.weight||1),0);
  let r = Math.random()*total;
  for (const c of items) { r -= (c.weight||1); if (r <= 0) return c; }
  return items[items.length-1];
}

function onSpin() {
  if (!eligibleChores.length) {
    statusEl.textContent = 'No eligible chores right now.'; return;
  }
  pickedChore = pickWeighted(eligibleChores);
  resultPill.textContent = `🎯 ${pickedChore.title} (${pickedChore.minutes} min)`;
  resultPill.style.display = '';
  startBtn.style.display = '';
}

async function startAssignment() {
  startBtn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('start_assignment', {
      p_member_id: currentMember.id,
      p_chore_id: pickedChore.id
    });
    if (error) throw error;
    activeAssignment = data;
    resultPill.style.display = 'none';
    startBtn.style.display = 'none';
    spinRow.style.display = 'none';
    activeRow.style.display = '';
    activeTitle.textContent = `${pickedChore.title} (${pickedChore.minutes} min)`;
    runTimer(new Date(activeAssignment.ends_at));
    statusEl.textContent = '👟 Timer started!';
  } catch(e) {
    statusEl.textContent = '❌ '+(e.message||e);
  } finally {
    startBtn.disabled = false;
  }
}

function runTimer(endsAt) {
  clearInterval(tmr);
  const tick = () => {
    const ms = endsAt - new Date();
    if (ms <= 0) {
      activeTime.textContent = `00:00`;
      clearInterval(tmr);
      return;
    }
    const m = Math.floor(ms/60000);
    const s = Math.floor((ms%60000)/1000);
    activeTime.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };
  tick();
  tmr = setInterval(tick, 250);
}

async function submitAssignment() {
  if (!activeAssignment) return;
  submitBtn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('submit_assignment', {
      p_assignment_id: activeAssignment.id
    });
    if (error) throw error;
    statusEl.textContent = (data.status === 'expired')
      ? '⏰ Time’s up — marked expired.'
      : '✅ Submitted for review.';
    // reload state
    await loadActive();
  } catch(e) {
    statusEl.textContent = '❌ '+(e.message||e);
  } finally {
    submitBtn.disabled = false;
  }
}

// Register the service worker for PWA/offline
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
