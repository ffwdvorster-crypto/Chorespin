import { createClient } from '@supabase/supabase-js'

// Vite reads variables injected by GitHub Actions
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) console.warn('Supabase env vars missing')

export const supabase = createClient(url, key)
