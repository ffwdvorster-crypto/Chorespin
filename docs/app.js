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

// --- Confetti (simple DOM confetti, no libs)
function confettiBurst() {
  const N = 120;
  const container = el('div', { style: {
    position: 'fixed', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: 9998
  }});
  document.body.appendChild(container);
  for (let i = 0; i < N; i++) {
    const piece = el('div', { style: {
      position: 'absolute',
      top: '-10px',
      left: Math.random() * 100 + '%',
      width: '6px',
      height: (6 + Math.random() * 8) + 'px',
      background: `hsl(${Math.floor(Math.random()*360)} 90% 55%)`,
      opacity: 0.9,
      transform: `rotate(${Math.random()*360}deg)`,
      borderRadius: '1px'
    }});
    container.appendChild(piece);
    const x = (Math.random() * 2 - 1) * 150; // drift
    const t = 1200 + Math.random() * 900;
    piece.animate([
      { transform: piece.style.transform, top: '-10px' },
      { transform: `translate(${x}px, 100vh) rotate(${Math.random()*720}deg)`, top: '100vh' }
    ], { duration: t, easing: 'ease-out', fill: 'forwards' });
  }
  setTimeout(() => container.remove(), 2200);
}

// --- Voice helpers (ensure first user gesture “unlocks” audio/TTS)
let voicesWarmed = false;
function warmVoices() {
  if (voicesWarmed) return;
  try {
    speechSynthesis.getVoices(); // populate
    const dummy = new SpeechSynthesisUtterance('');
    speechSynthesis.speak(dummy);
    speechSynthesis.cancel();
    voicesWarmed = true;
  } catch {}
}
function voiceToggleUI(container) {
  const label = el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '8px', fontSize: '12px', opacity: .8 }}, [
    el('input', { type: 'checkbox', checked: state.ttsEnabled ? 'checked' : null, onchange: (e) => {
      state.ttsEnabled = e.target.checked;
      if (state.ttsEnabled) warmVoices();
    }}),
    'Voice on'
  ]);
  container.appendChild(label);
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
  function renderShell() {
  if (document.getElementById('cs-root')) return;

  const root = el('div', { id: 'cs-root', style: { maxWidth: '900px', margin: '0 auto', padding: '12px' } });

  const header = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } }, [
    el('img', { id: 'cs-logo', src: './assets/logo-chorespin-light.png', alt: 'ChoreSpin', style: { height: '28px' } }),
    el('div', { id: 'cs-user-pill', style: { marginLeft: 'auto', fontSize: '14px', opacity: .8 } }, ['…']),
    el('button', {
      id: 'cs-signout',
      style: { padding: '6px 10px', border: '1px solid #ccc', borderRadius: '10px', cursor: 'pointer' },
      onclick: async () => {
        await supabase.auth.signOut();
        location.reload();
      }
    }, 'Sign out')
  ]);

  const tabbar = el('div', { id: 'cs-tabs', style: {
    display: 'flex', gap: '8px', borderBottom: '1px solid #ddd', paddingBottom: '8px', marginBottom: '12px', flexWrap: 'wrap'
  }});

  const main = el('div', { id: 'cs-main' });

  document.body.prepend(root);
  root.appendChild(header);
  root.appendChild(tabbar);
  root.appendChild(main);

  // Dark-mode logo swap
  try {
    const img = document.getElementById('cs-logo');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const swap = () => img.src = mq.matches ? './assets/logo-chorespin-dark.png' : './assets/logo-chorespin-light.png';
    swap(); mq.addEventListener('change', swap);
  } catch {}
}


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
    id = data;
  } else if (typeof data === 'object') {
    id = data.id || data.assignment_id || null;
  }
  state.lastAssignmentId = id;
  setSpinLock(true, 'active-assignment');
}

async function submitAssignment() {
  if (!state.lastAssignmentId) {
    // Try best-effort: find the most recent open assignment for this member
    try {
      const { data, error } = await supabase
        .from('assignments')
        .select('id, submitted, ends_at')
        .eq('member_id', state.activeMemberId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (!error && data && data.length) state.lastAssignmentId = data[0].id;
    } catch {}
  }

  if (!state.lastAssignmentId) throw new Error('No active assignment id');

  const { error } = await supabase.rpc('submit_assignment', {
    p_assignment_id: state.lastAssignmentId
  });
  if (error) throw error;

  // Locally unlock; official approval happens on adult review page
  setSpinLock(false, 'submitted');
  state.lastAssignmentId = null;
}

// -------------------------------
// Redemptions (request reward)
// -------------------------------

async function requestReward(rewardId) {
  // Basic insert; adult will approve elsewhere
  const body = {
    household_id: state.householdId,
    member_id: state.activeMemberId,
    reward_id: rewardId,
    status: 'pending'
  };
  const { error } = await supabase.from('redemptions').insert(body);
  if (error) throw error;
  toast('Reward requested! An adult will approve it.');
}

// -------------------------------
// Avatars (Storage: public bucket 'avatars')
// -------------------------------

async function uploadAvatar(file) {
  if (!file) return;
  const member = state.members.find(m => m.id === state.activeMemberId);
  if (!member) throw new Error('No member');

  const fileExt = file.name.split('.').pop().toLowerCase();
  const path = `${state.activeMemberId}/${Date.now()}.${fileExt}`;

  const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, {
    cacheControl: '3600',
    upsert: true
  });
  if (upErr) throw upErr;

  const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);

  const { error: updErr } = await supabase
    .from('members')
    .update({ avatar_url: pub.publicUrl })
    .eq('id', state.activeMemberId);
  if (updErr) throw updErr;

  toast('Avatar updated!');
  renderTabs(); // refresh avatar
}

// -------------------------------
// Seeding (one-time per household)
// -------------------------------

async function seedStarterPack() {
  if (!state.householdId) throw new Error('No household');
  if (!state.myAdult) throw new Error('Only adults can seed');

  if (seedHelper?.seedDefaultsForHousehold) {
    await seedHelper.seedDefaultsForHousehold(supabase, state.householdId);
  } else {
    // Call RPCs directly (works without helper)
    let e1 = (await supabase.rpc('create_default_chores', { p_household_id: state.householdId })).error;
    if (e1) throw e1;
    let e2 = (await supabase.rpc('create_default_rewards', { p_household_id: state.householdId })).error;
    if (e2) throw e2;
  }
  toast('Starter chores & rewards loaded (idempotent).');
  await loadEligibleChores(state.activeMemberId);
  await refreshRewardsAndPoints();
  renderTabs();
}

// -------------------------------
// UI — Shell + Tabs
// -------------------------------

function toast(msg, isErr = false) {
  console[isErr ? 'error' : 'log'](msg);
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', style: {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      background: isErr ? '#ffefef' : '#eef9ff', border: '1px solid #ccc', padding: '10px 14px',
      borderRadius: '10px', zIndex: 9999, maxWidth: '90%', boxShadow: '0 2px 6px rgba(0,0,0,.15)'
    }});
    document.body.appendChild(t);
  }
  t.style.background = isErr ? '#ffefef' : '#eef9ff';
  t.textContent = msg;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.remove(), 2600);
}

function renderShell() {
  // If the page already has containers, don't duplicate
  if (document.getElementById('cs-root')) return;

  const root = el('div', { id: 'cs-root', style: { maxWidth: '900px', margin: '0 auto', padding: '12px' } });

  const header = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } }, [
    el('img', { id: 'cs-logo', src: './assets/logo-chorespin-light.png', alt: 'ChoreSpin', style: { height: '28px' } }),
    el('div', { id: 'cs-user-pill', style: { marginLeft: 'auto', fontSize: '14px', opacity: .8 } }, ['…'])
  ]);

  const tabbar = el('div', { id: 'cs-tabs', style: {
    display: 'flex', gap: '8px', borderBottom: '1px solid #ddd', paddingBottom: '8px', marginBottom: '12px', flexWrap: 'wrap'
  }});

  const main = el('div', { id: 'cs-main' });

  document.body.prepend(root);
  root.appendChild(header);
  root.appendChild(tabbar);
  root.appendChild(main);

  // Dark-mode logo swap (if asset exists)
  try {
    const img = document.getElementById('cs-logo');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const swap = () => img.src = mq.matches ? './assets/logo-chorespin-dark.png' : './assets/logo-chorespin-light.png';
    swap(); mq.addEventListener('change', swap);
  } catch {}
}

function setUserPill() {
  const pill = document.getElementById('cs-user-pill');
  if (!pill) return;
  if (!state.user) {
    pill.textContent = 'Not signed in';
    return;
  }
  pill.innerHTML = `${state.user.email || 'Signed in'} · ${state.myAdult ? 'Adult' : 'Child'}`
}

function makeTabBtn(name, key) {
  return el('button', {
    class: 'cs-tab-btn',
    style: {
      padding: '8px 10px', border: '1px solid #ddd', borderRadius: '10px',
      background: '#fff', cursor: 'pointer'
    },
    onclick: () => renderTab(key)
  }, name);
}

function renderApp() {
  setUserPill();

  const tabs = document.getElementById('cs-tabs');
  tabs.innerHTML = '';

  // Member selector (left)
  const memberSel = el('select', { id: 'cs-member', style: { padding: '6px', borderRadius: '8px', border: '1px solid #ccc' }, onchange: async (e) => {
    await selectActiveMember(e.target.value);
    await refreshRewardsAndPoints();
    renderTab('wheel');
  }});
  for (const m of state.members) {
    const opt = el('option', { value: m.id }, m.display_name + (isAdultRole(m.role) ? ' (adult)' : ''));
    if (m.id === state.activeMemberId) opt.selected = true;
    memberSel.appendChild(opt);
  }
  tabs.appendChild(memberSel);

  // Tabs
  tabs.appendChild(makeTabBtn('Avatar', 'avatar'));
  tabs.appendChild(makeTabBtn('Wheel', 'wheel'));
  tabs.appendChild(makeTabBtn('Rewards', 'rewards'));
  tabs.appendChild(makeTabBtn('Points', 'points'));
  tabs.appendChild(makeTabBtn('Bonus', 'bonus'));

  // add voice toggle (and warm on first interaction)
voiceToggleUI(document.getElementById('cs-tabs'));
document.getElementById('cs-tabs').addEventListener('click', warmVoices, { once: true });

  
  if (state.myAdult) {
    const seedBtn = el('button', { style: { marginLeft: 'auto', padding: '8px 10px', border: '1px solid #ccc', borderRadius: '10px' }, onclick: seedStarterPack }, 'Load Starter Pack');
    tabs.appendChild(seedBtn);
  }

  renderTab('wheel');
}

async function selectActiveMember(memberId) {
  // pick default if missing
  if (!memberId && state.members.length) memberId = state.members[0].id;
  state.activeMemberId = memberId || null;
  loadSpinLock();
  await loadEligibleChores(state.activeMemberId);
}

function renderTab(key) {
  const main = document.getElementById('cs-main');
  main.innerHTML = '';

  switch (key) {
    case 'avatar': renderAvatarTab(main); break;
    case 'wheel': renderWheelTab(main); break;
    case 'rewards': renderRewardsTab(main); break;
    case 'points': renderPointsTab(main); break;
    case 'bonus': renderBonusTab(main); break;
    default: main.textContent = '…';
  }
}

// -------------------------------
// Avatar tab
// -------------------------------

function renderAvatarTab(main) {
  const member = state.members.find(m => m.id === state.activeMemberId);
  main.append(
    el('div', { class: 'card' }, [
      el('h3', {}, `Avatar — ${member?.display_name || ''}`),
      el('input', { type: 'file', accept: 'image/*', onchange: async (e) => {
        try { await uploadAvatar(e.target.files[0]); } catch (err) { toast(err.message || String(err), true); }
      }}),
      el('p', { class: 'muted' }, 'Pick a square-ish picture. We’ll crop it round in the UI.')
    ])
  );
}

// -------------------------------
// Wheel tab
// -------------------------------

function renderWheelTab(main) {
  const card = el('div', { class: 'card' });
  const title = el('h3', {}, 'Spin the Wheel');

  const info = el('div', { class: 'muted' }, state.spinLocked
    ? 'Spin locked: you have an active assignment pending approval. Submit it first.'
    : `Eligible chores: ${state.chores.length}`);

  const canvas = el('canvas', { id: 'cs-wheel', width: 360, height: 360, style: { maxWidth: '100%', display: 'block', margin: '10px auto' } });

  const spinBtn = el('button', {
    onclick: async () => {
      if (state.spinLocked) { toast('Finish your last task first 🙂'); return; }
      if (!state.chores.length) { toast('No chores available. Adults: seed or add chores.', true); return; }
      const pick = spinAnimation(canvas, buildWheelSlices(state.chores));
      // After spin ends, pick returns the chosen slice
      pick.then(async (slice) => {
        try {
          await speak(`${slice.chore.title}. Estimated ${slice.chore.minutes} minutes.`);
confettiBurst(); // 
          await startAssignment(state.activeMemberId, slice.chore);
          info.textContent = `Assigned: ${slice.chore.title} · ${slice.chore.minutes}m · ${slice.chore.points}pts`;
          toast(`Assignment started: ${slice.chore.title}`);
          renderWheelControls(ctrls, slice.chore);
        } catch (err) {
          toast(err.message || String(err), true);
        }
      });
    },
    style: { padding: '10px 14px', borderRadius: '10px', border: '1px solid #ccc', cursor: 'pointer' }
  }, 'Spin!');

  const ctrls = el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } });

  card.append(title, info, canvas, spinBtn, ctrls);
  main.append(card);

  drawWheel(canvas, buildWheelSlices(state.chores)); // initial paint
  renderWheelControls(ctrls, null);
}

function drawWheel(canvas, slices) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 10;

  ctx.clearRect(0, 0, W, H);
  if (!slices.length) {
    ctx.fillStyle = '#999'; ctx.textAlign = 'center'; ctx.font = '16px system-ui';
    ctx.fillText('No chores', cx, cy);
    return;
  }

  const totalWeight = slices.reduce((a, s) => a + (s.weight || 1), 0);
  let start = -Math.PI / 2;
  slices.forEach((s, i) => {
    const frac = (s.weight || 1) / totalWeight;
    const end = start + frac * Math.PI * 2;

    // glossy colors
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = `hsl(${(i * 47) % 360}deg 70% 55%)`;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // label
    const mid = (start + end) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(mid);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#000';
    ctx.font = '12px system-ui';
    ctx.fillText(s.label, r * 0.1, 0);
    ctx.restore();

    start = end;
  });

  // pointer
  ctx.beginPath();
  ctx.moveTo(cx + r + 4, cy);
  ctx.lineTo(cx + r + 24, cy - 8);
  ctx.lineTo(cx + r + 24, cy + 8);
  ctx.closePath();
  ctx.fillStyle = '#e91e63';
  ctx.fill();
}

function spinAnimation(canvas, slices) {
  return new Promise(resolve => {
    if (!slices.length) return resolve(null);
    const ctx = canvas.getContext('2d');
    let angle = 0;
    let speed = 0.45 + Math.random() * 0.35; // initial speed
    const friction = 0.985 + Math.random() * 0.01;

    const totalWeight = slices.reduce((a, s) => a + (s.weight || 1), 0);
    const targetSlice = weightedRandom(slices);
    // We won't force exact target; the randomness + friction makes a nice feel.

    const tick = () => {
      angle += speed;
      speed *= friction;

      // repaint rotated
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(angle);
      ctx.translate(-canvas.width / 2, -canvas.height / 2);
      drawWheel(canvas, slices); // draw in rotated system
      ctx.restore();

      try { state.tickAudio && state.tickAudio.play().catch(() => {}); } catch {}

      if (speed < 0.005) {
        // compute selected slice by angle
        const rad = ((-angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        let start = -Math.PI / 2;
        let sel = slices[0];
        for (const s of slices) {
          const frac = (s.weight || 1) / totalWeight;
          const end = start + frac * Math.PI * 2;
          if (rad >= start && rad < end) { sel = s; break; }
          start = end;
        }
        resolve(sel);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function renderWheelControls(ctrls, chosenChore) {
  ctrls.innerHTML = '';
  if (!chosenChore) {
    ctrls.append(el('span', { class: 'muted' }, 'Spin to get a task.'));
    return;
  }

  const startBtn = el('button', {
    onclick: async () => {
      try {
        await speak(`Starting ${chosenChore.title} now.`);
        // already started in spin handler; keep here as UX fallback
      } catch (err) { toast(err.message || String(err), true); }
    },
    style: { padding: '8px 12px', borderRadius: '10px', border: '1px solid #ccc', cursor: 'pointer' }
  }, 'Started');

  const submitBtn = el('button', {
    onclick: async () => {
      try {
        await submitAssignment();
        await speak('Submitted for review.');
        toast('Submitted! An adult will review.');
      } catch (err) {
        toast(err.message || String(err), true);
      }
    },
    style: { padding: '8px 12px', borderRadius: '10px', border: '1px solid #ccc', cursor: 'pointer' }
  }, 'Mark Done');

  ctrls.append(startBtn, submitBtn);
}

// -------------------------------
// Rewards tab
// -------------------------------

function renderRewardsTab(main) {
  const card = el('div', { class: 'card' }, [
    el('h3', {}, 'Rewards'),
  ]);

  const select = el('select', { id: 'cs-reward-sel', style: { padding: '8px', borderRadius: '8px', border: '1px solid #ccc', minWidth: '240px' } });
  select.appendChild(el('option', { value: '' }, '-- Choose a reward --'));

  state.rewards.forEach(r => {
    const disabled = state.points < r.cost_points;
    const opt = el('option', { value: r.id, disabled: disabled ? 'disabled' : null }, `${r.title} — ${r.cost_points} pts`);
    if (disabled) opt.textContent += ` (need ${r.cost_points - state.points} more)`;
    select.appendChild(opt);
  });

  const reqBtn = el('button', {
    onclick: async () => {
      const id = select.value;
      if (!id) return toast('Pick a reward first.');
      try {
        await requestReward(id);
      } catch (err) {
        toast(err.message || String(err), true);
      }
    },
    style: { padding: '8px 12px', borderRadius: '10px', border: '1px solid #ccc', cursor: 'pointer', marginLeft: '8px' }
  }, 'Request');

  const pts = el('div', { class: 'muted', style: { marginTop: '8px' } }, `Your points: ${state.points}`);

  card.append(select, reqBtn, pts);
  main.append(card);
}

// -------------------------------
// Points tab
// -------------------------------

function renderPointsTab(main) {
  const card = el('div', { class: 'card' }, [
    el('h3', {}, 'Points'),
    el('p', {}, `Current balance: ${state.points}`)
  ]);
  main.append(card);
}

// -------------------------------
// Bonus tab (simple listing idea)
// -------------------------------

function renderBonusTab(main) {
  const info = el('div', { class: 'card' }, [
    el('h3', {}, 'Bonus Tasks'),
    el('p', { class: 'muted' }, 'Ask an adult to add small “bonus” chores if you need a few extra points (e.g., make coffee for mom).')
  ]);
  main.append(info);
}

// -------------------------------
// Auth UI (fallback)
// -------------------------------

function renderAuth() {
  const main = document.getElementById('cs-main') || document.body;
  main.innerHTML = '';

  const box = el('div', { class: 'card' }, [
    el('h3', {}, 'Sign in'),
    el('input', { id: 'cs-email', type: 'email', placeholder: 'Email', style: { display: 'block', width: '100%', marginBottom: '6px', padding: '8px' } }),
    el('input', { id: 'cs-pass', type: 'password', placeholder: 'Password', style: { display: 'block', width: '100%', marginBottom: '6px', padding: '8px' } }),
    el('div', { style: { display: 'flex', gap: '8px' } }, [
      el('button', { onclick: signIn, style: btnStyle() }, 'Sign in'),
      el('button', { onclick: signUp, style: btnStyle() }, 'Sign up'),
    ])
  ]);

  const pill = document.getElementById('cs-user-pill');
  if (pill) pill.textContent = 'Not signed in';
  main.append(box);
}

function btnStyle() {
  return { padding: '8px 12px', borderRadius: '10px', border: '1px solid #ccc', cursor: 'pointer' };
}

async function signIn() {
  const email = document.getElementById('cs-email').value.trim();
  const pass = document.getElementById('cs-pass').value;
  const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if (error) return toast(error.message, true);
  const { data: { user } } = await supabase.auth.getUser();
  state.user = user;
  await afterLogin();
}

async function signUp() {
  const email = document.getElementById('cs-email').value.trim();
  const pass = document.getElementById('cs-pass').value;
  const { error } = await supabase.auth.signUp({ email, password: pass });
  if (error) return toast(error.message, true);
  toast('Account created. If email confirmation is on, confirm it; then sign in.');
}

// -------------------------------
// Start!
bootstrap();

// (Optional) keyboard shortcut for adults to seed: Ctrl+Alt+S
window.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && ev.altKey && ev.key.toLowerCase() === 's') {
    seedStarterPack().catch(e => toast(e.message || String(e), true));
  }
});
