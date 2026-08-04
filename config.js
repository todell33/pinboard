// ======================================================================
// Pinboard account configuration.
//
// Fill in your own Supabase project's URL and "anon" public key here —
// see ACCOUNTS_SETUP.md for exactly where to find these (Supabase dashboard
// → Settings → API). Both values are safe to have in this file even though
// it's visible to anyone who views the app's source: the anon key is
// DESIGNED to be public — it identifies which Supabase project to talk to,
// but grants no access on its own. All real access control happens via Row
// Level Security policies (see schema.sql), which check who's actually
// signed in, not what key was used to connect.
// ======================================================================

const SUPABASE_URL = 'YOUR_SUPABASE_URL'; // e.g. 'https://abcdefgh.supabase.co'
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // starts with 'eyJ...'
