// docs/app.js
// ChoreSpin — unified app controller (adult/child, tabs, spin, timer, submit, rewards)
//
// Requirements:
// - supabaseClient.js must export { supabase } (ES module).
// - SQL RPCs installed (create_default_chores, create_default_rewards) if you plan to seed.
// - Tables: households, members, chores, assignments, rewards, redemptions, chore_eligibility (optional), view member_points (optional).
//
// Notes:
// - Role normalization: we treat 'adult' as the canonical role. Any legacy 'parent' is considered adult too.
// - If your index.html does NOT have the expected placeholders, this script will render its own minimal UI in <body>.
// - Spin lock: by default we lock locally when an assignment is started. If your RPC returns an assignment id,
//   we store it and unlock after submit → (review by adult still happens on the adult UI).
//
// ---------------------------------------------------------------------------------------

import { supabase } from './supabaseClient.js';

// Optional seed helper (safe to ignore if not present)
let seedHelper = null;
try {
  seedHelper = await import('./seedHelpers.js');
} catch (_) { /* optional */ }

// -------------------------------
// Utilities & State
// -------------------------------

function isAdultRole(role) {
  return role === 'adult' || role === 'parent';
}

const state = {
  user: null,
  householdId: null,
  myAdult: false,
  members: [],
  activeMemberId: null,
  chores: [],
  rewards: [],
  points: 0,
  lastAssignmentId: null, // assignment id returned by start_assignment RPC
  spinLocked: false,
  ttsEnabled: true,
  tickAudio: null,
};

async function speak(text) {
  if (!state.ttsEnabled) return;
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
  } catch {}
}

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.substring(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c == null) return;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
}

function setSpinLock(locked, reason = '') {
  state.spinLocked = locked;
  localStorage.setItem('cs_spin_locked', JSON.stringify({ locked, reason, ts: Date.now(), memberId: state.activeMemberId }));
}

function loadSpinLock() {
  try {
    const obj = JSON.parse(localStorage.getItem('cs_spin_locked') || '{}');
    if (obj && obj.memberId === state.activeMemberId) {
      state.spinLocked = !!obj.locked;
      return;
    }
  } catch {}
  state.spinLocked = false;
}

// -------------------------------
// Auth & Bootstrap
// -------------------------------

async function bootstrap() {
  // Tick sound
  try {
    state.tickAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
  } catch {}

  // Try existing session
  const { data: { user } } = await supabase.auth.getUser();
  state.user = user;

  renderShell();

  if (!state.user) {
    renderAuth();
    return;
  }

  await afterLogin();
}

async function afterLogin() {
  // Find an adult membership (or any membership to get household)
  const { data: myMember, error: memErr } = await supabase
    .from('members')
    .select('household_id, role, display_name, id')
    .eq('user_id', state.user.id)
    .limit(1)
    .maybeSingle();

  if (memErr) {
    toast('Error reading membership: ' + memErr.message, true);
    renderAuth();
    return;
  }

  if (!myMember) {
    toast('No membership found. Ask an adult to add you to a household.', true);
    renderAuth();
    return;
  }

  state.householdId = myMember.household_id;
  state.myAdult = isAdultRole(myMember.role);

  await loadMembers();
  await selectActiveMember(myMember.id || null); // default to self if they’re a member-row; adults can switch later
  await refreshRewardsAndPoints();

  renderApp();
}

// -------------------------------
// Data Loaders
// -------------------------------

async function loadMembers() {
  const { data, error } = await supabase
    .from('members')
    .select('id, display_name, role, user_id')
    .eq('household_id', state.householdId)
    .order('display_name', { ascending: true });

  if (error) {
    toast('Failed to load members: ' + error.message, true);
    state.members = [];
  } else {
    state.members = data || [];
  }
}

async function loadEligibleChores(forMemberId) {
  // Basic filter: audience matches member role or 'any', active = true
  // Optionally respect chore_eligibility if you use it.
  const member = state.members.find(m => m.id === forMemberId);
  const audienceNeeded = isAdultRole(member?.role) ? ['adults', 'any'] : ['kids', 'any'];

  // Fetch active chores for the household
  const { data, error } = await supabase
    .from('chores')
    .select('id, title, minutes, points, audience, weight, active')
    .eq('household_id', state.householdId)
    .eq('active', true);

  if (error) {
    toast('Failed to load chores: ' + error.message, true);
    state.chores = [];
    return;
  }

  const filtered = (data || []).filter(c => audienceNeeded.includes(c.audience));
  // TODO: honor chore_eligibility allow/deny if table is used (requires additional queries)
  state.chores = filtered;
}

async function refreshRewardsAndPoints() {
  // Rewards
  const { data: rewards, error: rerr } = await supabase
    .from('rewards')
    .select('id, title, cost_points, active')
    .eq('household_id', state.householdId)
    .eq('active', true)
    .order('cost_points', { ascending: true });

  if (!rerr && rewards) state.rewards = rewards;

  // Points view (member_points)
  if (state.activeMemberId) {
    let pts = 0;
    try {
      const { data: vp, error: perr } = await supabase
        .from('member_points')
        .select('member_id, points_balance')
        .eq('member_id', state.activeMemberId)
        .maybeSingle();
      if (!perr && vp && typeof vp.points_balance === 'number') pts = vp.points_balance;
    } catch {
      // fallback: unknown view; leave 0
    }
    state.points = pts;
  }
}

// -------------------------------
// Spin & Assignment
// -------------------------------

function weightedRandom(items) {
  // items: [{weight, item}]
  const total = items.reduce((a, b) => a + (b.weight || 1), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= (it.weight || 1);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function buildWheelSlices(chores) {
  // Map chores to slices
  const slices = chores.map(c => ({ label: c.title, weight: c.weight || 1, chore: c }));
  return slices;
}

async function startAssignment(memberId, chore) {
  // Calls RPC start_assignment(member_id, chore_id)
  const { data, error } = await supabase.rpc('start_assignment', {
    p_member_id: memberId,
    p_chore_id: chore.id
  });

  if (error) throw error;
  // Expect RPC to return assignment id or object; try common shapes
  let id = null;
  if (!data) {
    // Some RPCs return void; still lock client-side
  } else if (typeof data === 'string') {
    id = data
