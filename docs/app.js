import { supabase } from './supabaseClient.js';

const statusEl = document.getElementById('status');
const btn = document.getElementById('voice');

async function check() {
  try {
    const { error } = await supabase.auth.getSession();
    if (error) throw error;
    statusEl.textContent = '✅ Connected to Supabase. (Tables coming next!)';
  } catch (e) {
    statusEl.textContent = '❌ Supabase connection error: ' + (e?.message || e);
  }
}
check();

btn.addEventListener('click', () => {
  try {
    const u = new SpeechSynthesisUtterance('Welcome to ChoreSpin!');
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
