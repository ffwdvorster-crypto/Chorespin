import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

export default function App() {
  const [status, setStatus] = useState('Checking Supabase…')

  useEffect(() => {
    (async () => {
      // Simple connectivity check that doesn't require any tables
      const { data, error } = await supabase.auth.getSession()
      if (error) setStatus('❌ Supabase connection error: ' + error.message)
      else setStatus('✅ Connected to Supabase. (Tables coming next!)')
    })()
  }, [])

  const speak = (t) => {
    try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch {}
  }

  return (
    <div style="display:flex;min-height:100dvh;align-items:center;justify-content:center;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#111;color:#eee;text-align:center;padding:24px">
      <div>
        <h1 style="margin:0 0 12px">ChoreSpin</h1>
        <p style="opacity:.8">{status}</p>
        <button onClick={()=>speak('Welcome to ChoreSpin!')}
          style="margin-top:16px;padding:10px 14px;border-radius:10px;border:1px solid #333;background:#222;color:#fff">
          🔊 Test Voice
        </button>
        <p style="margin-top:14px;opacity:.6;font-size:12px">Install to Home Screen for the best experience.</p>
      </div>
    </div>
  )
}
