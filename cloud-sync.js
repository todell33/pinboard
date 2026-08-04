// ======================================================================
// CloudSync — replaces SheetsSync entirely. Handles Google sign-in (via
// Supabase Auth) and syncing Pinboard's data to a real per-user database
// instead of a personal Google Sheet, so data now follows an ACCOUNT rather
// than a browser or a spreadsheet.
//
// Design for this first milestone (deliberately simple, per project scope):
//   - No offline support. Every save pushes to Supabase immediately; if that
//     fails (no connection), the person sees an error rather than the app
//     silently queuing work for later.
//   - No migration yet from old localStorage-only or Sheets-synced data —
//     signing in for the first time starts a person with a clean slate in
//     the database. (Planned as a later addition, not part of this milestone.)
//   - localStorage is still used underneath as a fast local cache of
//     whatever was last loaded from the database, purely so the rest of the
//     app's ~100 existing Store.* call sites can stay synchronous and
//     unchanged — Store.save() still writes to localStorage first (instant,
//     as before), then this module pushes the same data to Supabase in the
//     background. Supabase is the source of truth; localStorage is a cache
//     of it, not a fallback data store in its own right.
//
// Requires config.js (same folder) to be filled in with your own Supabase
// project URL and anon key — see ACCOUNTS_SETUP.md.
// ======================================================================

const CloudSync = {
  client: null,
  session: null,
  _pushTimer: null,
  _busy: false,

  isConfigured(){
    return typeof SUPABASE_URL !== 'undefined' && typeof SUPABASE_ANON_KEY !== 'undefined' &&
      SUPABASE_URL && SUPABASE_ANON_KEY &&
      SUPABASE_URL.indexOf('YOUR_SUPABASE_URL') === -1;
  },

  isSignedIn(){
    return !!this.session;
  },

  async init(){
    this.updateUI();

    if (!this.isConfigured()){
      const hint = document.getElementById('accountsSetupHint');
      if (hint){
        hint.innerHTML = `Accounts aren't set up yet. This app needs a free Supabase project before sign-in works. See <b>ACCOUNTS_SETUP.md</b> included with this app for a walkthrough, then fill in <code>config.js</code>.`;
      }
      return;
    }

    // Supabase's browser client is loaded from a CDN script tag in index.html (see that file) —
    // `supabase` here is the global it exposes, not something this file defines.
    this.client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const { data } = await this.client.auth.getSession();
    this.session = data.session || null;

    // Keep session state in sync if it changes in another tab, or refreshes in the background.
    this.client.auth.onAuthStateChange((_event, session) => {
      this.session = session;
      this.updateUI();
    });

    this.updateUI();

    const btnSignIn = document.getElementById('btnCloudSignIn');
    if (btnSignIn){
      btnSignIn.addEventListener('click', ()=> this.signIn());
    }
    const btnSignOut = document.getElementById('btnCloudSignOut');
    if (btnSignOut){
      btnSignOut.addEventListener('click', ()=> this.signOut());
    }

    if (this.session){
      await this.pullAll();
    }
  },

  updateUI(){
    const status = document.getElementById('cloudAccountStatus');
    const btnSignIn = document.getElementById('btnCloudSignIn');
    const btnSignOut = document.getElementById('btnCloudSignOut');
    if (!status) return;

    if (!this.isConfigured()){
      status.textContent = 'Not set up — see ACCOUNTS_SETUP.md';
      if (btnSignIn) btnSignIn.style.display = 'none';
      if (btnSignOut) btnSignOut.style.display = 'none';
      return;
    }

    if (this.session){
      const email = this.session.user?.email || 'your account';
      status.textContent = `Signed in as ${email}`;
      if (btnSignIn) btnSignIn.style.display = 'none';
      if (btnSignOut) btnSignOut.style.display = '';
    } else {
      status.textContent = 'Not signed in — your data stays on this device only until you sign in';
      if (btnSignIn) btnSignIn.style.display = '';
      if (btnSignOut) btnSignOut.style.display = 'none';
    }
  },

  async signIn(){
    if (!this.client) return;
    // redirectTo defaults to the current page, so this works the same whether Pinboard is
    // running from GitHub Pages, localhost, or wrapped in the Android APK's TWA.
    const { error } = await this.client.auth.signInWithOAuth({ provider: 'google' });
    if (error){
      toast('Sign-in failed: ' + error.message);
    }
    // On success, the browser navigates away to Google and back — init() runs again on
    // return and picks up the new session from getSession(), so nothing else to do here.
  },

  async signOut(){
    if (!this.client) return;
    await this.client.auth.signOut();
    this.session = null;
    this.updateUI();
    toast('Signed out — this device\'s data stays as it was at last sync');
  },

  // Loads everything for the signed-in user from Supabase into Store (and, via Store.save(),
  // into localStorage as the local cache), replacing whatever was there before. Called once
  // right after sign-in — this is a full replace, not a merge, since this milestone doesn't
  // yet handle migrating or reconciling pre-existing local-only data (see module comment).
  async pullAll(){
    if (!this.session) return;
    const uid = this.session.user.id;

    try{
      const [gamesRes, ballsRes, alleysRes, leaguesRes, tournamentsRes, prefsRes] = await Promise.all([
        this.client.from('games').select('*').eq('user_id', uid),
        this.client.from('balls').select('*').eq('user_id', uid),
        this.client.from('alleys').select('*').eq('user_id', uid),
        this.client.from('leagues').select('*').eq('user_id', uid),
        this.client.from('tournaments').select('*').eq('user_id', uid),
        this.client.from('user_preferences').select('*').eq('user_id', uid).maybeSingle()
      ]);

      const firstError = [gamesRes, ballsRes, alleysRes, leaguesRes, tournamentsRes, prefsRes]
        .find(r => r.error)?.error;
      if (firstError) throw firstError;

      Store.games = (gamesRes.data || []).map(rowToGame);
      Store.settings.balls = (ballsRes.data || []).map(rowToBall);
      Store.settings.alleys = (alleysRes.data || []).map(rowToAlley);
      Store.settings.leagues = (leaguesRes.data || []).map(rowToLeague);
      Store.settings.tournaments = (tournamentsRes.data || []).map(rowToTournament);
      const defaultBall = (ballsRes.data || []).find(b => b.is_default);
      Store.settings.defaultBallId = defaultBall ? defaultBall.id : null;

      // Persist the freshly-pulled data into localStorage directly (bypassing Store.save()'s
      // own push-back-to-cloud side effect here, since we just pulled this exact data FROM the
      // cloud — pushing it right back would be a pointless round trip).
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Store.games));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(Store.settings));

      if (typeof Render !== 'undefined') Render.all();
      toast('Synced with your account');
    } catch(e){
      console.error('CloudSync.pullAll failed:', e);
      toast('Could not load your data from the cloud: ' + (e.message || 'unknown error'));
    }
  },

  // Called by Store.save() after every local mutation. Pushes the CURRENT full state of
  // in-memory Store to Supabase. Simple full-replace-per-table approach (delete rows that no
  // longer exist locally, upsert the rest) rather than tracking fine-grained diffs — acceptable
  // for personal-scale data volumes, and far simpler to get correct for this first milestone.
  async push(){
    if (!this.session || !this.client) return;
    if (this._busy){
      // A push is already in flight; queue exactly one more after it finishes rather than
      // stacking up unbounded overlapping requests if saves happen in quick succession.
      this._pendingPush = true;
      return;
    }
    this._busy = true;
    try{
      await this._pushNow();
    } catch(e){
      console.error('CloudSync.push failed:', e);
      toast('Could not save to your account — check your connection. (Saved on this device.)');
    } finally{
      this._busy = false;
      if (this._pendingPush){
        this._pendingPush = false;
        this.push();
      }
    }
  },

  async _pushNow(){
    const uid = this.session.user.id;

    const gameRows = Store.games.map(g => gameToRow(g, uid));
    const ballRows = Store.settings.balls.map(b => ballToRow(b, uid, b.id === Store.settings.defaultBallId));
    const alleyRows = Store.settings.alleys.map(a => alleyToRow(a, uid));
    const leagueRows = Store.settings.leagues.map(l => leagueToRow(l, uid));
    const tournamentRows = Store.settings.tournaments.map(t => tournamentToRow(t, uid));

    // Upsert current rows, then delete anything belonging to this user that ISN'T in the
    // current set (covers deletions — a game/ball/league/tournament removed locally needs to
    // disappear from the database too, not just stop being upserted).
    await Promise.all([
      this._syncTable('games', gameRows, uid),
      this._syncTable('balls', ballRows, uid),
      this._syncTable('alleys', alleyRows, uid),
      this._syncTable('leagues', leagueRows, uid),
      this._syncTable('tournaments', tournamentRows, uid)
    ]);

    const { error: prefsError } = await this.client.from('user_preferences').upsert({
      user_id: uid,
      theme: (typeof Theme !== 'undefined' && Theme.current) || 'dark',
      stats_layout: Store.settings.statsLayout || null
    });
    if (prefsError) throw prefsError;
  },

  async _syncTable(table, rows, uid){
    if (rows.length){
      const { error } = await this.client.from(table).upsert(rows);
      if (error) throw error;
    }
    const currentIds = rows.map(r => r.id);
    let query = this.client.from(table).delete().eq('user_id', uid);
    if (currentIds.length){
      query = query.not('id', 'in', `(${currentIds.map(id => `"${id}"`).join(',')})`);
    }
    const { error: deleteError } = await query;
    if (deleteError) throw deleteError;
  }
};

// ---------- Row <-> app-object mapping ----------
// Deliberately explicit rather than clever/generic, so it's obvious exactly which field maps to
// which on both sides — this is the kind of code where a subtle bug (a swapped field, a missed
// null-check) silently corrupts someone's data, so clarity matters more than brevity here.

function gameToRow(g, uid){
  return {
    id: g.id, user_id: uid, date: g.date, context: g.context,
    league_name: g.leagueName || '', score: g.score, notes: g.notes || '',
    frames_json: g.frames || null, created_at: g.createdAt || new Date().toISOString(),
    ball_id: g.ballId || null, alley_id: g.alleyId || null, league_id: g.leagueId || null,
    lane_condition: g.laneCondition || null, tournament_id: g.tournamentId || null
  };
}
function rowToGame(r){
  return {
    id: r.id, date: r.date, context: r.context, leagueName: r.league_name || '',
    score: r.score, notes: r.notes || '', frames: r.frames_json || null,
    createdAt: r.created_at, ballId: r.ball_id, alleyId: r.alley_id, leagueId: r.league_id,
    laneCondition: r.lane_condition, tournamentId: r.tournament_id
  };
}

function ballToRow(b, uid, isDefault){
  return {
    id: b.id, user_id: uid, name: b.name, brand: b.brand || '', coverstock: b.coverstock || '',
    core_type: b.coreType || '', rg: b.rg || '', differential: b.differential || '',
    weight: b.weight || '', hook_potential: b.hookPotential || '', spec_notes: b.specNotes || '',
    is_default: !!isDefault
  };
}
function rowToBall(r){
  return {
    id: r.id, name: r.name, brand: r.brand || '', coverstock: r.coverstock || '',
    coreType: r.core_type || '', rg: r.rg || '', differential: r.differential || '',
    weight: r.weight || '', hookPotential: r.hook_potential || '', specNotes: r.spec_notes || '',
    lastLookupAt: null
  };
}

function alleyToRow(a, uid){
  return { id: a.id, user_id: uid, name: a.name };
}
function rowToAlley(r){
  return { id: r.id, name: r.name };
}

function leagueToRow(l, uid){
  return {
    id: l.id, user_id: uid, name: l.name, alley_id: l.alleyId || null,
    team_name: l.teamName || '', team_size: l.teamSize || null,
    season_start: l.seasonStart || '', season_end: l.seasonEnd || '',
    day_of_week: l.dayOfWeek != null ? l.dayOfWeek : null, time: l.time || '',
    notes: l.notes || '', manually_completed: !!l.manuallyCompleted,
    placement: l.placement || '', placement_notes: l.placementNotes || ''
  };
}
function rowToLeague(r){
  return {
    id: r.id, name: r.name, alleyId: r.alley_id, teamName: r.team_name || '',
    teamSize: r.team_size, seasonStart: r.season_start || '', seasonEnd: r.season_end || '',
    dayOfWeek: r.day_of_week, time: r.time || '', notes: r.notes || '',
    manuallyCompleted: !!r.manually_completed, placement: r.placement || '',
    placementNotes: r.placement_notes || ''
  };
}

function tournamentToRow(t, uid){
  return {
    id: t.id, user_id: uid, name: t.name, alley_id: t.alleyId || null,
    format: t.format || '', entry_fee: t.entryFee || '', date_mode: t.dateMode || 'single',
    single_date: t.singleDate || '', range_start: t.rangeStart || '', range_end: t.rangeEnd || '',
    notes: t.notes || '', manually_completed: !!t.manuallyCompleted,
    placement: t.placement || '', placement_notes: t.placementNotes || ''
  };
}
function rowToTournament(r){
  return {
    id: r.id, name: r.name, alleyId: r.alley_id, format: r.format || '',
    entryFee: r.entry_fee || '', dateMode: r.date_mode || 'single',
    singleDate: r.single_date || '', rangeStart: r.range_start || '', rangeEnd: r.range_end || '',
    notes: r.notes || '', manuallyCompleted: !!r.manually_completed,
    placement: r.placement || '', placementNotes: r.placement_notes || ''
  };
}
