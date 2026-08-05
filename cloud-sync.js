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
    // Explicitly pass redirectTo as the exact page Pinboard is currently running from —
    // window.location.href already includes the full path (e.g. ".../pinboard/"), so this
    // correctly returns to the right address whether Pinboard is on GitHub Pages, localhost, or
    // wrapped in the Android APK's TWA. (Earlier version of this omitted redirectTo entirely,
    // assuming Supabase would infer the right page on its own — in practice this sometimes fell
    // back to the bare site origin instead of the full path, landing on a 404. Being explicit
    // here removes that ambiguity.)
    const { error } = await this.client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
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

// ======================================================================
// Friends — usernames, friend requests, per-friend stat sharing, and shared
// groups (teams/leagues). Layered on top of CloudSync's existing Supabase
// client rather than duplicating auth/session handling — every method here
// assumes CloudSync.isSignedIn() is already true, and callers are expected
// to check that first (the UI only shows Friends-related actions when
// signed in, same pattern as everywhere else in the app).
//
// This is the one part of Pinboard where one person's data becomes visible
// to another — every method here maps directly to a specific, narrow
// server-side rule (see schema.sql's RLS policies and the two
// security-definer functions), not just something this client-side code
// happens to also check. The real enforcement lives in the database.
// ======================================================================
const Friends = {
  get client(){ return CloudSync.client; },
  get uid(){ return CloudSync.session ? CloudSync.session.user.id : null; },

  // ---------- Username ----------

  // Checks format + availability without claiming it — used for live feedback while someone's
  // still typing, before they've committed to saving it.
  async checkUsernameAvailable(username){
    const normalized = (username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(normalized)){
      return { available: false, reason: 'Usernames must be 3-20 characters: letters, numbers, and underscores only.' };
    }
    const { data, error } = await this.client.from('user_preferences').select('user_id').eq('username', normalized).maybeSingle();
    if (error) throw error;
    if (data && data.user_id !== this.uid){
      return { available: false, reason: 'That username is already taken.' };
    }
    return { available: true, reason: '' };
  },

  async setUsername(username){
    const normalized = (username || '').trim().toLowerCase();
    const check = await this.checkUsernameAvailable(normalized);
    if (!check.available) return check;
    const { error } = await this.client.from('user_preferences').upsert({ user_id: this.uid, username: normalized });
    if (error){
      // A unique-constraint race (two people claiming the same name at nearly the same moment)
      // surfaces here as a raw Postgres error rather than the friendlier message above, since
      // the earlier availability check can't fully close that tiny window — this still reports
      // it clearly rather than as a generic failure.
      if (error.message && error.message.includes('duplicate key')){
        return { available: false, reason: 'That username was just taken — try another.' };
      }
      throw error;
    }
    return { available: true, reason: '' };
  },

  async getMyUsername(){
    const { data, error } = await this.client.from('user_preferences').select('username').eq('user_id', this.uid).maybeSingle();
    if (error) throw error;
    return data ? data.username : null;
  },

  // ---------- Friend search & requests ----------

  // Returns { userId, username } or null. Never returns anything about the CALLER's own
  // account when they search their own name (there's nothing to friend-request there), and
  // never exposes anything except the username itself — email, theme, stats_layout are all
  // technically selectable per the RLS policy's simplicity tradeoff (see schema.sql's comment)
  // but this method only ever reads/returns the username column.
  async findByUsername(username){
    const normalized = (username || '').trim().toLowerCase();
    if (!normalized) return null;
    const { data, error } = await this.client.from('user_preferences').select('user_id, username').eq('username', normalized).maybeSingle();
    if (error) throw error;
    if (!data || data.user_id === this.uid) return null;
    return { userId: data.user_id, username: data.username };
  },

  async sendFriendRequest(targetUserId){
    const { error } = await this.client.from('friendships').insert({
      requester_id: this.uid, recipient_id: targetUserId, status: 'pending'
    });
    if (error){
      // The unique-pair rule is enforced by a unique EXPRESSION INDEX (see schema.sql), not a
      // named table constraint — Postgres reports a violation of it as an error mentioning the
      // INDEX's name, "friendships_unique_pair_idx", which is what's matched here.
      if (error.message && error.message.includes('friendships_unique_pair_idx')){
        throw new Error('You\'ve already got a pending or existing friendship with this person.');
      }
      throw error;
    }
  },

  // Returns { incoming: [...], outgoing: [...] }, each entry { friendshipId, userId, username }.
  // Two separate queries rather than one, since "pending requests I need to act on" (incoming)
  // and "requests I'm waiting on someone else for" (outgoing) are shown in different parts of
  // the UI and want different labels/actions.
  async getPendingRequests(){
    const [incomingRes, outgoingRes] = await Promise.all([
      this.client.from('friendships').select('id, requester_id').eq('recipient_id', this.uid).eq('status', 'pending'),
      this.client.from('friendships').select('id, recipient_id').eq('requester_id', this.uid).eq('status', 'pending')
    ]);
    if (incomingRes.error) throw incomingRes.error;
    if (outgoingRes.error) throw outgoingRes.error;

    const otherIds = [
      ...incomingRes.data.map(r => r.requester_id),
      ...outgoingRes.data.map(r => r.recipient_id)
    ];
    const usernameMap = await this._usernamesFor(otherIds);

    return {
      incoming: incomingRes.data.map(r => ({ friendshipId: r.id, userId: r.requester_id, username: usernameMap[r.requester_id] || '(unknown)' })),
      outgoing: outgoingRes.data.map(r => ({ friendshipId: r.id, userId: r.recipient_id, username: usernameMap[r.recipient_id] || '(unknown)' }))
    };
  },

  async acceptFriendRequest(friendshipId){
    const { error } = await this.client.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
    if (error) throw error;
  },

  // Covers both "decline a pending request" and "remove an existing friend" — both are just
  // deleting the friendship row, per the RLS policy allowing either party to delete it.
  async removeFriendship(friendshipId){
    const { error } = await this.client.from('friendships').delete().eq('id', friendshipId);
    if (error) throw error;
  },

  // Returns accepted friends as [{ friendshipId, userId, username }].
  async getFriends(){
    const { data, error } = await this.client.from('friendships')
      .select('id, requester_id, recipient_id')
      .eq('status', 'accepted')
      .or(`requester_id.eq.${this.uid},recipient_id.eq.${this.uid}`);
    if (error) throw error;

    const otherIds = data.map(r => r.requester_id === this.uid ? r.recipient_id : r.requester_id);
    const usernameMap = await this._usernamesFor(otherIds);

    return data.map(r => {
      const otherId = r.requester_id === this.uid ? r.recipient_id : r.requester_id;
      return { friendshipId: r.id, userId: otherId, username: usernameMap[otherId] || '(unknown)' };
    });
  },

  async _usernamesFor(userIds){
    if (!userIds.length) return {};
    const { data, error } = await this.client.from('user_preferences').select('user_id, username').in('user_id', userIds);
    if (error) throw error;
    const map = {};
    data.forEach(row => { map[row.user_id] = row.username; });
    return map;
  },

  // ---------- Per-friend stat sharing ----------
  // STAT_KEYS mirrors the check constraint on friend_shares.stat_key in schema.sql exactly —
  // if that list ever changes there, it needs to change here too.
  STAT_KEYS: [
    { key: 'overall_average', label: 'Overall average' },
    { key: 'games_played', label: 'Games played' },
    { key: 'high_game', label: 'High game' },
    { key: 'recent_trend', label: 'Last 30 days average' }
  ],

  // Returns which stat keys THIS user currently shares with a specific friend, as a plain array
  // of stat_key strings (e.g. ['overall_average', 'games_played']) — absence from the array
  // means not shared, matching the opt-in-only model.
  async getMySharesWith(friendUserId){
    const { data, error } = await this.client.from('friend_shares').select('stat_key').eq('owner_id', this.uid).eq('friend_id', friendUserId);
    if (error) throw error;
    return data.map(r => r.stat_key);
  },

  async setShareWith(friendUserId, statKey, shared){
    if (shared){
      const { error } = await this.client.from('friend_shares').upsert({ owner_id: this.uid, friend_id: friendUserId, stat_key: statKey });
      if (error) throw error;
    } else {
      const { error } = await this.client.from('friend_shares').delete()
        .eq('owner_id', this.uid).eq('friend_id', friendUserId).eq('stat_key', statKey);
      if (error) throw error;
    }
  },

  // Fetches whatever a friend has chosen to share, via the get_friend_stats() security-definer
  // function — this is a live computation on Supabase's side (not a client-side aggregation of
  // raw rows this user was never given access to), returning ONLY the stat types that friend
  // has explicitly turned on. Returns {} for a friend sharing nothing (a real, valid state, not
  // an error), and also {} (indistinguishably) if the two people aren't actually friends — see
  // the function's own comment in schema.sql for why that ambiguity is intentional.
  async getFriendStats(friendUserId){
    const { data, error } = await this.client.rpc('get_friend_stats', { friend_user_id: friendUserId });
    if (error) throw error;
    const result = {};
    (data || []).forEach(row => { result[row.stat_key] = row.stat_value; });
    return result;
  },

  // ---------- Groups (shared teams/leagues) ----------

  async createGroup(name, maxMembers){
    const { data, error } = await this.client.from('groups').insert({
      name: (name || '').trim(), creator_id: this.uid, max_members: maxMembers
    }).select().single();
    if (error) throw error;
    // Creating a group doesn't automatically add the creator as a member via any trigger — do
    // that explicitly here, in the same flow, so a freshly-created group isn't empty from the
    // creator's own perspective.
    const { error: memberError } = await this.client.from('group_members').insert({ group_id: data.id, user_id: this.uid });
    if (memberError) throw memberError;
    return data;
  },

  // Returns groups this user is a member of (including ones they created), as
  // [{ id, name, creatorId, maxMembers, memberCount, isCreator }].
  async getMyGroups(){
    const { data: memberRows, error: memberError } = await this.client.from('group_members').select('group_id').eq('user_id', this.uid);
    if (memberError) throw memberError;
    const groupIds = memberRows.map(r => r.group_id);
    if (!groupIds.length) return [];

    const { data: groups, error: groupsError } = await this.client.from('groups').select('*').in('id', groupIds);
    if (groupsError) throw groupsError;

    const { data: allMembers, error: allMembersError } = await this.client.from('group_members').select('group_id').in('group_id', groupIds);
    if (allMembersError) throw allMembersError;
    const countByGroup = {};
    allMembers.forEach(m => { countByGroup[m.group_id] = (countByGroup[m.group_id] || 0) + 1; });

    return groups.map(g => ({
      id: g.id, name: g.name, creatorId: g.creator_id, maxMembers: g.max_members,
      memberCount: countByGroup[g.id] || 0, isCreator: g.creator_id === this.uid
    }));
  },

  // Returns a group's members as [{ userId, username, isCreator }].
  async getGroupMembers(groupId){
    const { data: members, error } = await this.client.from('group_members').select('user_id').eq('group_id', groupId);
    if (error) throw error;
    const { data: groupRow, error: groupError } = await this.client.from('groups').select('creator_id').eq('id', groupId).single();
    if (groupError) throw groupError;

    const usernameMap = await this._usernamesFor(members.map(m => m.user_id));
    return members.map(m => ({
      userId: m.user_id, username: usernameMap[m.user_id] || '(unknown)', isCreator: m.user_id === groupRow.creator_id
    }));
  },

  // Invites (directly adds) a user to a group by username — per "anyone can invite people to
  // the league/team" this doesn't require the invitee's acceptance, matching a real bowling
  // team roster where a captain or teammate just adds someone. If the group is already at its
  // max_members, the database trigger (group_size_check) rejects the insert with a clear error.
  async inviteToGroupByUsername(groupId, username){
    const found = await this.findByUsername(username);
    if (!found) throw new Error(`No Pinboard user found with the username "${username}".`);
    const { error } = await this.client.from('group_members').insert({ group_id: groupId, user_id: found.userId });
    if (error){
      if (error.message && error.message.includes('maximum')) throw error; // the trigger's own message is already clear
      if (error.message && error.message.includes('duplicate key')) throw new Error(`${found.username} is already in this group.`);
      throw error;
    }
    return found;
  },

  // Removing a member: allowed for the group's creator removing anyone, or anyone removing
  // themself (leaving) — both cases are just this one call, since the RLS policy on
  // group_members already enforces exactly that distinction; this client code doesn't need its
  // own permission check duplicating it.
  async removeFromGroup(groupId, userId){
    const { error } = await this.client.from('group_members').delete().eq('group_id', groupId).eq('user_id', userId);
    if (error) throw error;
  },

  // Fetches every game logged by every member of a group, under that group's linked
  // league/tournament, via the get_group_games() security-definer function — see that
  // function's comment in schema.sql. Returns [] if the caller isn't actually a member.
  async getGroupGames(groupId){
    const { data, error } = await this.client.rpc('get_group_games', { target_group_id: groupId });
    if (error) throw error;
    return data || [];
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
