import { supabase } from './supabaseClient.js';

const statusEl = document.getElementById('status');

async function check() {
  try {
    // Simple call that doesn't need tables — just proves the client works
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    statusEl.textContent = '✅ Connected to Supabase. (Tables coming next!)';
  } catch (e) {
    statusEl.textContent = '❌ Supabase connection error: ' + (e?.message || e);
  }
}
check();

document.getElementById('voice').onclick = () => {
  try {
    const u = new SpeechSynthesisUtterance('Welcome to ChoreSpin!');
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch {}
};

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
