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

const SUPABASE_URL = 'https://jwemynwctpsuwcsebwwlL.supabase.co'; // e.g. 'https://abcdefgh.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZW15bndjdHBzdXdjc2Vid3dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MzEzMDMsImV4cCI6MjEwMTQwNzMwM30.hTaNytBPwaUKGEZbEb60I0QT9HUMREn7jTd9dusOUTs'; // starts with 'eyJ...'
