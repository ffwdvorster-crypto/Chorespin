// docs/app.js — full replacement

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- UI refs ---------- */
const authRow      = document.getElementById('authRow');
const loginPanel   = document.getElementById('loginPanel');
const logoutRow    = document.getElementById('logoutRow');
const emailEl      = document.getElementById('email');
const passEl       = document.getElementById('password');
const btnSignin    = document.getElementById('btnSignin');
const btnSignup    = document.getElementById('btnSignup');
const btnLogout    = document.getElementById('btnLogout');

const memberRow    = document.getElementById('memberRow');
const memberSelect = document.getElementById('memberSelect');
const refreshBtn   = document.getElementById('refresh');

const eligibleWrap = document.getElementById('eligible');
const whoEl        = document.getElementById('who');
const wheelEl      = document.getElementById('wheel');

const spinRow      = document.getElementById('spinRow');
const spinBtn      = document.getElementById('spin');
const resultPill   = document.getElementById('result');
const startBtn     = document.getElementById('start');

const activeRow    = document.getElementById('activeRow');
const activeTitle  = document.getElementById('activeTitle');
const activeTime   = document.getElementById('activeTime');
const submitBtn    = document.getElementById('submit');

const statusEl     = document.getElementById('status');

/* Add-chore (parent only) refs — safe if block not present */
const addChoreWrap = document.getElementById('addChore');
const chTitle      = document.getElementById('chTitle');
const chMinutes    = document.getElementById('chMinutes');
const chPoints     = document.getElementById('chPoints');
const chAudience   = document.getElementById('chAudience');
const btnAddChore  = document.getElementById('btnAddChore');

/* ---------- state ---------- */
let session = null;
let members = [];
let currentMember = null;
let eligibleChores = [];
let pickedChore = null;
let activeAssignment = null;
let tmr = null;

/* ---------- init ---------- */
init();

supabase.auth.onAuthStateChange((_evt, sess) => {
  session = sess;
  renderAuth();
  if (session) loadMembers();
});

async function init() {
  const { data: s } = await supabase.auth.getSession();
  session = s.session;
  renderAuth();

  // wire events
  if (refreshBtn) refreshBtn.onclick = () => loadAll();
  if (memberSelect) memberSelect.onchange = () => {
    currentMember = members.find(m => m.id === memberSelect.value);
    loadAll();
  };
  if (spinBtn) spinBtn.onclick = onSpin;
  if (startBtn) startBtn.onclick = startAssignment;
  if (submitBtn) submitBtn.onclick = submitAssignment;

  if (btnSignin) btnSignin.onclick = handleSignin;
  if (btnSignup) btnSignup.onclick = handleSignup;
  if (btnLogout) btnLogout.onclick = handleLogout;
  if (btnAddChore) btnAddChore.onclick = addChore;

  if (session) await loadMembers();

  // register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}

/* ---------- auth ---------- */
function renderAuth() {
  if (!session) {
    authRow.innerHTML = `You’re not signed in. Use an <a href="./accept.html">invite link</a> or sign in below.`;
    show(loginPanel, true);
    show(logoutRow, false);
    show(memberRow, false);
    show(eligibleWrap, false);
    show(spinRow, false);
    show(activeRow, false);
    show(addChoreWrap, false);
  } else {
    authRow.innerHTML = `Signed in as <span class="success">${session.user.email}</span>`;
    show(loginPanel, false);
    show(logoutRow, true);
  }
}

async function handleSignin() {
  try {
    statusEl.textContent = 'Signing in…';
    const { error } = await supabase.auth.signInWithPassword({
      email: (emailEl?.value || '').trim(),
      password: (passEl?.value || '')
    });
    if (error) throw error;
    statusEl.textContent = '✅ Signed in.';
  } catch (e) { statusEl.textContent = '❌ ' + (e.message || e); }
}

async function handleSignup() {
  try {
    statusEl.textContent = 'Creating account…';
    const email = (emailEl?.value || '').trim();
    const password = (passEl?.value || '');
    const { error: e1 } = await supabase.auth.signUp({ email, password });
    if (e1) throw e1;
    const { error: e2 } = await supabase.auth.signInWithPassword({ email, password });
    if (e2) throw e2;
    statusEl.textContent = '✅ Account ready. You are signed in.';
  } catch (e) { statusEl.textContent = '❌ ' + (e.message || e); }
}

async function handleLogout() {
  try { await supabase.auth.signOut(); statusEl.textContent = '👋 Logged out.'; }
  catch (e) { statusEl.textContent = '❌ ' + (e.message || e); }
}

/* ---------- data loads ---------- */
async function loadMembers() {
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .eq('user_id', session.user.id);

  if (error) { statusEl.textContent = '❌ '+error.message; return; }

  members = data || [];
  if (!members.length) {
    show(memberRow, false);
    statusEl.textContent = 'No member profile yet. Use an invite link to join a household.';
    return;
  }

  // populate dropdown
  show(memberRow, true);
  memberSelect.innerHTML = members
    .map(m => `<option value="${m.id}">${m.display_name} (${m.role})</option>`)
    .join('');
  currentMember = members[0];

  await loadAll();
}

async function loadAll() {
  resultPill.style.display = 'none';
  startBtn.style.display = 'none';
  show(spinRow, true);
  whoEl.textContent = currentMember.display_name;
  toggleParentUI();
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

  if (error && error.code !== 'PGRST116') { // 116 = no rows found
    statusEl.textContent = '❌ '+error.message; return;
  }

  activeAssignment = data || null;
  if (activeAssignment) {
    show(activeRow, true);
    activeTitle.textContent = `${activeAssignment.chore.title} (${activeAssignment.chore.minutes} min)`;
    runTimer(new Date(activeAssignment.ends_at));
    show(spinRow, false);
  } else {
    show(activeRow, false);
  }
}

async function loadEligibleChores() {
  const { data: chores, error } = await supabase
    .from('chores')
    .select('*')
    .eq('household_id', currentMember.household_id)
    .eq('active', true);

  if (error) { statusEl.textContent = '❌ '+error.message; return; }

  const { data: rules, error: e2 } = await supabase
    .from('chore_eligibility')
    .select('chore_id, mode')
    .eq('member_id', currentMember.id);

  if (e2) { statusEl.textContent = '❌ '+e2.message; return; }

  // audience filter
  const byAudience = chores.filter(c => {
    if (c.audience === 'any') return true;
    if (c.audience === 'kids') return currentMember.role === 'child';
    if (c.audience === 'adults') return currentMember.role === 'parent';
    return false;
  });

  // allow/deny rules
  const ruleMap = new Map(rules.map(r => [r.chore_id, r.mode]));
  const allowedSet = new Set(rules.filter(r => r.mode === 'allow').map(r => r.chore_id));

  eligibleChores = byAudience.filter(c => {
    const mode = ruleMap.get(c.id);
    if (mode === 'deny') return false;
    // if any allows exist for this member, require allow for those chores
    if (allowedSet.size > 0) return allowedSet.has(c.id) || !ruleMap.has(c.id);
    return true;
  });

  wheelEl.innerHTML = eligibleChores.length
    ? eligibleChores.map(c => `<div class="slice">${c.title} · ${c.minutes}m</div>`).join('')
    : `<span class="muted">No eligible chores found. Ask a parent to add/adjust chores.</span>`;

  show(eligibleWrap, true);
}

/* ---------- spin & assignment ---------- */
function pickWeighted(items) {
  const total = items.reduce((a,c)=>a+(c.weight||1),0);
  let r = Math.random()*total;
  for (const c of items) { r -= (c.weight||1); if (r <= 0) return c; }
  return items[items.length-1];
}

function onSpin() {
  if (!eligibleChores.length) { statusEl.textContent = 'No eligible chores right now.'; return; }
  pickedChore = pickWeighted(eligibleChores);
  resultPill.textContent = `🎯 ${pickedChore.title} (${pickedChore.minutes} min)`;
  resultPill.style.display = '';
  startBtn.style.display = '';
  // tiny read-out
  try {
    const u = new SpeechSynthesisUtterance(`Your chore is ${pickedChore.title}. You have ${pickedChore.minutes} minutes.`);
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch {}
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
    show(spinRow, false);
    show(activeRow, true);
    activeTitle.textContent = `${pickedChore.title} (${pickedChore.minutes} min)`;
    runTimer(new Date(activeAssignment.ends_at));
    statusEl.textContent = '👟 Timer started!';
  } catch(e) {
    statusEl.textContent = '❌ '+(e.message||e);
  } finally {
    startBtn.disabled = false;
  }
}

// Seed defaults for the current household (run once)
export async function seedDefaultsForHousehold(householdId) {
  if (!householdId) throw new Error('No householdId');
  // chores
  const { error: choresErr } = await supabase.rpc('create_default_chores', { p_household_id: householdId });
  if (choresErr) throw choresErr;
  // rewards
  const { error: rewardsErr } = await supabase.rpc('create_default_rewards', { p_household_id: householdId });
  if (rewardsErr) throw rewardsErr;
  return true;
}
// Example usage after you resolve the active household:
await seedDefaultsForHousehold(activeHouseholdId);
alert('Default chores and rewards loaded!');

function runTimer(endsAt) {
  clearInterval(tmr);
  const tick = () => {
    const ms = endsAt - new Date();
    if (ms <= 0) { activeTime.textContent = `00:00`; clearInterval(tmr); return; }
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
    await loadActive();
  } catch(e) {
    statusEl.textContent = '❌ '+(e.message||e);
  } finally {
    submitBtn.disabled = false;
  }
}

/* ---------- parent-only: add chore ---------- */
function toggleParentUI() {
  if (!addChoreWrap) return;
  show(addChoreWrap, currentMember?.role === 'parent');
}

async function addChore() {
  try {
    const title = (chTitle?.value || '').trim();
    const minutes = Number(chMinutes?.value || 0);
    const points  = Number(chPoints?.value || 10);
    const audience = chAudience?.value || 'any';

    if (!title || !minutes) { statusEl.textContent = 'Please enter title and minutes.'; return; }

    const { error } = await supabase.from('chores').insert({
      household_id: currentMember.household_id,
      title, minutes, points, audience, active: true, weight: 1
    });
    if (error) throw error;

    if (chTitle) chTitle.value = '';
    if (chMinutes) chMinutes.value = '';
    if (chPoints) chPoints.value = '';
    statusEl.textContent = '✅ Chore added.';
    await loadEligibleChores();
  } catch (e) {
    statusEl.textContent = '❌ ' + (e.message || e);
  }
}

/* ---------- helpers ---------- */
function show(el, on) { if (!el) return; el.style.display = on ? '' : 'none'; }

/* === BEGIN: ChoreSpin seed hook (adult-only) ===
   Paste this at the very bottom of docs/app.js (or keep it in a separate file).
   It only wires a global function and optional keyboard shortcut.
*/
(async () => {
  // Bail if supabase is not ready
  if (typeof supabase === 'undefined') return;

  // Expose a tiny global to run the seed once you are signed in as an ADULT.
  window.__seedDefaults = async function() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Sign in first');

      // Try to locate your adult household
      const { data: m, error } = await supabase
        .from('members')
        .select('household_id, role')
        .eq('user_id', user.id)
        .eq('role', 'adult')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!m?.household_id) throw new Error('No adult household found for this user');

      // Lazy import helper
      const mod = await import('./seedHelpers.js');
      await mod.seedDefaultsForHousehold(supabase, m.household_id);
      alert('Starter chores + rewards loaded! (idempotent)');
    } catch (e) {
      alert('Seed error: ' + (e?.message || e));
    }
  };

  // Optional: Ctrl+Alt+S to seed (you can remove this)
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.altKey && ev.key.toLowerCase() === 's') {
      window.__seedDefaults();
    }
  });
})();
/* === END: ChoreSpin seed hook === */
