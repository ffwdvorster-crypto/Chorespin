// Read your public vars from a tiny config file (no build step needed).
// We'll create /config.js in the next step.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Load ESM build of supabase-js directly from a CDN (no bundler required)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
