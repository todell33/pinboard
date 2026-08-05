// ======================================================================
// PINBOARD — Bowling Tracker
// Local-first storage with optional account sign-in and cloud sync
// ======================================================================

const STORAGE_KEY = 'pinboard_games_v1';
const SETTINGS_KEY = 'pinboard_settings_v1';
const THEME_KEY = 'pinboard_theme_v1';

// ---------- Data model ----------
// game = { id, date: 'YYYY-MM-DD', context: 'league'|'open', leagueId, leagueName, score, frames: [...] | null, notes, createdAt, ballId, alleyId }
// league = { id, name, alleyId, teamName, teamSize, seasonStart, seasonEnd, dayOfWeek (0-6, 0=Sun), time ('HH:MM'), notes }

// ---------- Theme ----------
// Applied as early as possible (see the inline bootstrap script in <head>) to avoid a flash of
// the wrong theme on load. This module handles the Settings toggle and keeps everything else
// (meta theme-color, chart colors) in sync after that initial application.
const Theme = {
  current: 'dark',

  load(){
    try{
      this.current = localStorage.getItem(THEME_KEY) || 'dark';
    }catch(e){
      this.current = 'dark'; // localStorage unavailable (e.g. file://) — just default quietly
    }
    return this.current;
  },

  apply(theme){
    this.current = theme;
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    this.updateMetaThemeColor();
    try{ localStorage.setItem(THEME_KEY, theme); }catch(e){ /* non-fatal; theme just won't persist */ }
  },

  updateMetaThemeColor(){
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    // read the live --walnut value so this always matches whatever the CSS actually renders,
    // rather than duplicating the hex codes here and risking them drifting out of sync
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--walnut').trim();
    if (bg) meta.setAttribute('content', bg);
  },

  toggle(theme){
    this.apply(theme);
    this.updateSettingsUI();
    // charts embed their colors directly as SVG hex fills rather than CSS variables (inline SVG
    // doesn't benefit from CSS custom properties the way HTML elements do), so they need an
    // explicit re-render to pick up the new palette rather than updating automatically like
    // everything else on the page does.
    if (typeof Render !== 'undefined') Render.all();
  },

  updateSettingsUI(){
    const darkChip = document.getElementById('chipThemeDark');
    const lightChip = document.getElementById('chipThemeLight');
    if (darkChip) darkChip.classList.toggle('selected', this.current !== 'light');
    if (lightChip) lightChip.classList.toggle('selected', this.current === 'light');
  }
};

// ---------- Stats widget registry ----------
// Each BUILT-IN widget has a stable id (used in saved layouts — never rename these), a human
// label for the edit-mode picker, and the section-head title shown above it on the live page.
// These 5 aren't expressible as a clean {variable, metric} breakdown (trend is a time series,
// distribution is a histogram, recentForm is a comparison) so they stay as fixed, hand-built
// widgets — unchanged from before.
const STATS_WIDGET_CATALOG = [
  { id: 'summary',     label: 'Games / High / Low',      title: null }, // no section-head; it's the hero block
  { id: 'trend',       label: 'Score Trend',              title: 'Score Trend' },
  { id: 'recentForm',  label: 'Last 5 vs Season',         title: 'Last 5 vs Season' },
  { id: 'distribution',label: 'Score Distribution',       title: 'Score Distribution' },
  { id: 'strikeSpare', label: 'Strike / Spare Rate',       title: 'Strike / Spare Rate' }
];

// CUSTOM widgets are generated from a {variable, metric, chartType} combination the person picks
// in the "+ Add Custom Widget" flow, rather than being hardcoded one-per-breakdown. This is what
// makes "every variable that's logged" and "choose how it's visualized" both possible without
// needing a new hand-built widget for every combination.
const STATS_VARIABLES = [
  { id: 'ball',          label: 'Ball',           keyFn: g => g.ballId || null,      nameFn: id => Store.ballName(id) },
  { id: 'alley',         label: 'Alley',          keyFn: g => g.alleyId || null,     nameFn: id => Store.alleyName(id) },
  { id: 'league',        label: 'League',         keyFn: g => g.leagueId || null,    nameFn: id => { const l = Store.leagueById(id); return l ? l.name : ''; } },
  { id: 'laneCondition', label: 'Lane Condition', keyFn: g => g.laneCondition || null, nameFn: id => id },
  { id: 'context',       label: 'League vs Open', keyFn: g => g.context || null,     nameFn: id => id==='league' ? 'League' : 'Open' }
];

const STATS_METRICS = [
  { id: 'average', label: 'Average Score', compute: games => Stats.average(games), fmt: v => v.toFixed(1) },
  { id: 'high',    label: 'High Score',    compute: games => Stats.high(games),    fmt: v => String(v) },
  { id: 'low',     label: 'Low Score',     compute: games => Stats.low(games),     fmt: v => String(v) },
  { id: 'total',   label: 'Total Pins',    compute: games => games.reduce((s,g)=>s+g.score,0), fmt: v => String(v) },
  { id: 'count',   label: 'Games Played',  compute: games => games.length,         fmt: v => String(v) }
];

const STATS_CHART_TYPES = [
  { id: 'bar',    label: 'Bar' },
  { id: 'line',   label: 'Line' },
  { id: 'number', label: 'Number only' }
];

// The exact widgets, in the exact order, that the Stats page has always shown — this is what
// "keep the default as-is" means concretely: a fresh install (or anyone who hasn't customized
// yet) gets precisely today's layout, just now expressed as data instead of hardcoded HTML.
const DEFAULT_STATS_LAYOUT = [
  { id: 'summary', visible: true },
  { id: 'trend', visible: true },
  { id: 'recentForm', visible: true },
  { id: 'distribution', visible: true },
  { id: 'strikeSpare', visible: false }
];

const Store = {
  games: [],
  settings: {
    leagueName: '',      // legacy: last free-typed league name, kept only for old-data fallback display
    lastSync: null,
    lastLeagueId: null,   // most recently used league, to speed up repeat entry
    balls: [],            // [{id, name}]
    defaultBallId: null,
    alleys: [],            // [{id, name}]
    leagues: [],            // [{id, name, alleyId, teamName, teamSize, seasonStart, seasonEnd, dayOfWeek, time, notes}]
    tournaments: [],        // [{id, name, alleyId, format, entryFee, dateMode, singleDate, rangeStart, rangeEnd, notes}]
    statsLayout: null       // set on first load to DEFAULT_STATS_LAYOUT; null here just marks "not yet initialized"
  },

  load(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      this.games = raw ? JSON.parse(raw) : [];
    }catch(e){ this.games = []; }
    try{
      const s = localStorage.getItem(SETTINGS_KEY);
      const parsed = s ? JSON.parse(s) : {};
      this.settings = Object.assign(
        { leagueName:'', lastSync:null, lastLeagueId:null, balls:[], defaultBallId:null, alleys:[], leagues:[] },
        parsed
      );
      // defensive: ensure arrays are the right shape even if old data predates this feature
      if (!Array.isArray(this.settings.balls)) this.settings.balls = [];
      if (!Array.isArray(this.settings.alleys)) this.settings.alleys = [];
      if (!Array.isArray(this.settings.leagues)) this.settings.leagues = [];
      if (!Array.isArray(this.settings.tournaments)) this.settings.tournaments = [];
      // backfill spec fields on balls added before the AI lookup feature existed
      this.settings.balls.forEach(b=>{
        const blank = this.blankBallSpecs();
        Object.keys(blank).forEach(key=>{
          if (b[key] === undefined) b[key] = blank[key];
        });
      });
      // backfill fields on leagues created before the completion/placement feature existed,
      // so they behave like any other league rather than showing "undefined" anywhere
      this.settings.leagues.forEach(l=>{
        if (l.manuallyCompleted === undefined) l.manuallyCompleted = false;
        if (l.placement === undefined) l.placement = '';
        if (l.placementNotes === undefined) l.placementNotes = '';
      });
      // migrate any lingering old-style per-league alley default map into real league entities,
      // so people upgrading from the prior version don't lose that association
      let migrated = false;
      if (parsed.leagueAlleyDefaults && typeof parsed.leagueAlleyDefaults === 'object'){
        Object.keys(parsed.leagueAlleyDefaults).forEach(name=>{
          if (!this.settings.leagues.some(l=>l.name===name)){
            this.settings.leagues.push(this.blankLeague(name, parsed.leagueAlleyDefaults[name]));
            migrated = true;
          }
        });
      }
      // Initialize the Stats layout to today's exact default on first load, or repair it if it's
      // missing/malformed. A layout entry is either a BUILT-IN widget (id matches an entry in
      // STATS_WIDGET_CATALOG) or a CUSTOM widget (kind:'custom', with its own variable/metric/
      // chartType) — repair keeps any recognizable entry of either kind and drops anything else,
      // rather than assuming every entry is a fixed catalog id the way earlier versions did.
      if (!Array.isArray(this.settings.statsLayout) || !this.settings.statsLayout.length){
        this.settings.statsLayout = DEFAULT_STATS_LAYOUT.map(w => Object.assign({}, w));
        migrated = true;
      } else {
        const knownBuiltinIds = new Set(STATS_WIDGET_CATALOG.map(w=>w.id));
        const knownVariableIds = new Set(STATS_VARIABLES.map(v=>v.id));
        const knownMetricIds = new Set(STATS_METRICS.map(m=>m.id));

        // Migrate the old fixed byBall/byAlley/byLeague catalog entries (from the previous
        // version, before custom widgets existed) into the new custom-widget shape, preserving
        // their visibility and defaulting to a bar chart — the same visual they always had.
        const legacyVariableMap = { byBall: 'ball', byAlley: 'alley', byLeague: 'league' };

        const repaired = [];
        this.settings.statsLayout.forEach(w=>{
          if (legacyVariableMap[w.id]){
            repaired.push({
              id: 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
              kind: 'custom', variable: legacyVariableMap[w.id], metric: 'average', chartType: 'bar',
              visible: !!w.visible
            });
            migrated = true;
            return;
          }
          if (w.kind === 'custom'){
            if (knownVariableIds.has(w.variable) && knownMetricIds.has(w.metric)){
              repaired.push(w);
            } else {
              migrated = true; // drop a custom widget referencing a variable/metric that no longer exists
            }
            return;
          }
          if (knownBuiltinIds.has(w.id)){
            repaired.push(w);
          } else {
            migrated = true; // drop an unrecognized built-in id (e.g. renamed/removed in an update)
          }
        });

        const presentBuiltinIds = new Set(repaired.filter(w=>w.kind!=='custom').map(w=>w.id));
        STATS_WIDGET_CATALOG.forEach(w=>{
          if (!presentBuiltinIds.has(w.id)){ repaired.push({ id: w.id, visible: false }); migrated = true; }
        });

        if (repaired.length !== this.settings.statsLayout.length) migrated = true;
        this.settings.statsLayout = repaired;
      }
      if (migrated){
        // persist immediately — otherwise these fixes exist only in memory and would be lost
        // if the person closes the app before some unrelated action happens to trigger a save
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
      }
    }catch(e){
      this.settings = { leagueName:'', lastSync:null, lastLeagueId:null, balls:[], defaultBallId:null, alleys:[], leagues:[], tournaments:[], statsLayout: DEFAULT_STATS_LAYOUT.map(w=>Object.assign({}, w)) };
    }
  },

  save(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.games));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    }catch(e){
      console.error('Store.save() failed — localStorage unavailable:', e);
      if (typeof toast === 'function'){
        toast('Can\'t save — open this app over http/https, not as a local file');
      }
      return false;
    }
    if (typeof CloudSync !== 'undefined' && CloudSync.isSignedIn()) {
      CloudSync.push();
    }
    return true;
  },

  addGame(game){
    game.id = game.id || ('g_' + Date.now() + '_' + Math.random().toString(36).slice(2,8));
    game.createdAt = game.createdAt || new Date().toISOString();
    this.games.push(game);
    this.games.sort((a,b)=> a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    const saved = this.save();
    if (!saved){
      // roll back the in-memory add so app state doesn't silently diverge from what's actually persisted
      this.games = this.games.filter(g => g.id !== game.id);
    }
    return saved;
  },

  deleteGame(id){
    this.games = this.games.filter(g => g.id !== id);
    this.save();
  },

  replaceAll(games){
    this.games = games;
    this.games.sort((a,b)=> a.date.localeCompare(b.date) || (a.createdAt||'').localeCompare(b.createdAt||''));
    this.save();
  },

  filtered(ctx){
    if (ctx === 'all') return this.games;
    return this.games.filter(g => g.context === ctx);
  },

  // ---- Ball lineup ----
  blankBallSpecs(){
    return {
      brand: '', coverstock: '', coreType: '', rg: '', differential: '',
      weight: '', hookPotential: '', specNotes: '', lastLookupAt: null
    };
  },
  // model is required (this is what shows after the brand, e.g. "Phaze II"); brand is optional
  // but expected to be filled in via the Add Ball form now that brand is collected up front,
  // rather than only later through the ball detail edit sheet.
  addBall(model, brand){
    const trimmedModel = (model||'').trim();
    if (!trimmedModel) return null;
    const ball = Object.assign(
      { id: 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), name: trimmedModel },
      this.blankBallSpecs(),
      { brand: (brand||'').trim() }
    );
    this.settings.balls.push(ball);
    const wasDefault = !this.settings.defaultBallId;
    if (wasDefault) this.settings.defaultBallId = ball.id;
    const saved = this.save();
    if (!saved){
      // roll back the in-memory add so app state doesn't silently diverge from what's actually persisted
      this.settings.balls = this.settings.balls.filter(b => b.id !== ball.id);
      if (wasDefault) this.settings.defaultBallId = null;
      return null;
    }
    return ball;
  },
  updateBall(id, fields){
    const ball = this.settings.balls.find(b=>b.id===id);
    if (!ball) return null;
    Object.assign(ball, fields);
    this.save();
    return ball;
  },
  removeBall(id){
    this.settings.balls = this.settings.balls.filter(b => b.id !== id);
    if (this.settings.defaultBallId === id){
      this.settings.defaultBallId = this.settings.balls.length ? this.settings.balls[0].id : null;
    }
    this.save();
  },
  setDefaultBall(id){
    this.settings.defaultBallId = id;
    this.save();
  },
  // Balls are displayed as "Brand - Model" everywhere in the app (dropdowns, game detail,
  // custom widget breakdowns, etc.) since this is the single function all of those call
  // through — falls back to just the model name if brand is blank (e.g. older balls added
  // before brand was collected at creation time).
  ballName(id){
    const b = this.settings.balls.find(x=>x.id===id);
    if (!b) return '';
    return b.brand ? `${b.brand} - ${b.name}` : b.name;
  },
  ballById(id){
    return this.settings.balls.find(b=>b.id===id) || null;
  },

  // ---- Alleys ----
  addAlley(name){
    const trimmed = name.trim();
    if (!trimmed) return null;
    const alley = { id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), name: trimmed };
    this.settings.alleys.push(alley);
    this.save();
    return alley;
  },
  removeAlley(id){
    this.settings.alleys = this.settings.alleys.filter(a => a.id !== id);
    this.settings.leagues.forEach(l=>{ if (l.alleyId === id) l.alleyId = null; });
    this.save();
  },
  alleyName(id){
    const a = this.settings.alleys.find(x=>x.id===id);
    return a ? a.name : '';
  },

  // ---- Leagues ----
  blankLeague(name, alleyId){
    return {
      id: 'lg_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      name: name || '', alleyId: alleyId || null, teamName: '', teamSize: null,
      seasonStart: '', seasonEnd: '', dayOfWeek: null, time: '', notes: '',
      manuallyCompleted: false,   // lets a league be closed out before its season end date, or reopened
      placement: '',               // e.g. "3rd of 12 teams"
      placementNotes: ''           // free text: points behind, playoffs result, etc.
    };
  },
  addLeague(fields){
    const name = (fields.name||'').trim();
    if (!name) return null;
    const league = Object.assign(this.blankLeague(name), fields, { name });
    this.settings.leagues.push(league);
    this.save();
    return league;
  },
  updateLeague(id, fields){
    const league = this.settings.leagues.find(l=>l.id===id);
    if (!league) return null;
    Object.assign(league, fields);
    this.save();
    return league;
  },
  removeLeague(id){
    this.settings.leagues = this.settings.leagues.filter(l => l.id !== id);
    this.save();
  },
  leagueById(id){
    return this.settings.leagues.find(l=>l.id===id) || null;
  },
  // A league is "completed" once its season end date has passed, or it's been manually marked
  // done (e.g. closing it out early, or a league with no end date set at all). This is derived
  // rather than stored as an independent flag so it can never drift out of sync with the date —
  // the only stored override is manuallyCompleted, for cases where the date isn't the right signal.
  isLeagueCompleted(league){
    if (league.manuallyCompleted) return true;
    if (!league.seasonEnd) return false;
    const todayStr = new Date().toISOString().slice(0,10);
    return league.seasonEnd < todayStr;
  },
  // Back-compat: some games predate the league entity model and only have a free-text leagueName.
  // Resolve a display name for a game that may have either leagueId (new) or leagueName (old).
  leagueDisplayName(game){
    if (game.leagueId){
      const l = this.leagueById(game.leagueId);
      if (l) return l.name;
    }
    return game.leagueName || 'League';
  },

  // ---- Tournaments ----
  // Structurally the same entity shape as League (alley, completion/placement, notes), but with
  // date semantics suited to a one-off or short event instead of a recurring weekly schedule:
  // dateMode is 'single' (one date) or 'range' (a start/end span), chosen per tournament.
  blankTournament(name, alleyId){
    return {
      id: 'tn_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      name: name || '', alleyId: alleyId || null,
      format: '', entryFee: '',
      dateMode: 'single', singleDate: '', rangeStart: '', rangeEnd: '',
      notes: '',
      manuallyCompleted: false,
      placement: '',
      placementNotes: ''
    };
  },
  addTournament(fields){
    const name = (fields.name||'').trim();
    if (!name) return null;
    const tournament = Object.assign(this.blankTournament(name), fields, { name });
    this.settings.tournaments.push(tournament);
    this.save();
    return tournament;
  },
  updateTournament(id, fields){
    const tournament = this.settings.tournaments.find(t=>t.id===id);
    if (!tournament) return null;
    Object.assign(tournament, fields);
    this.save();
    return tournament;
  },
  removeTournament(id){
    this.settings.tournaments = this.settings.tournaments.filter(t => t.id !== id);
    this.save();
  },
  tournamentById(id){
    return this.settings.tournaments.find(t=>t.id===id) || null;
  },
  // Completed once its relevant end date has passed (the single date itself for a one-day
  // event, or the range end for a multi-day one), or manually marked done — same derivation
  // pattern as isLeagueCompleted, for the same reason (never drift out of sync with the date).
  isTournamentCompleted(tournament){
    if (tournament.manuallyCompleted) return true;
    const endDate = tournament.dateMode === 'range' ? tournament.rangeEnd : tournament.singleDate;
    if (!endDate) return false;
    const todayStr = new Date().toISOString().slice(0,10);
    return endDate < todayStr;
  },
  // Back-compat mirror of leagueDisplayName, for games tied to a tournament instead of a league.
  tournamentDisplayName(game){
    if (game.tournamentId){
      const t = this.tournamentById(game.tournamentId);
      if (t) return t.name;
    }
    return 'Tournament';
  },

  // ---- Stats page layout (widget visibility + order) ----
  getStatsLayout(){
    return this.settings.statsLayout || DEFAULT_STATS_LAYOUT.map(w=>Object.assign({}, w));
  },
  setStatsLayout(layout){
    this.settings.statsLayout = layout;
    this.save();
  },
  resetStatsLayout(){
    this.settings.statsLayout = DEFAULT_STATS_LAYOUT.map(w=>Object.assign({}, w));
    this.save();
  }
};

// ---------- Stats helpers ----------
const Stats = {
  average(games){
    if (!games.length) return null;
    const sum = games.reduce((a,g)=>a+g.score,0);
    return sum / games.length;
  },
  recentAverage(games, n){
    const slice = games.slice(-n);
    return this.average(slice);
  },
  trendDelta(games, n){
    // compare avg of last n vs avg of the n before that
    if (games.length < 2) return null;
    const recent = games.slice(-n);
    const prior = games.slice(-(n*2), -n);
    if (!prior.length) return null;
    const rA = this.average(recent), pA = this.average(prior);
    if (rA==null||pA==null) return null;
    return rA - pA;
  },
  high(games){ return games.length ? Math.max(...games.map(g=>g.score)) : null; },
  low(games){ return games.length ? Math.min(...games.map(g=>g.score)) : null; },
  distribution(games){
    // buckets of 20 pins from 0-300
    const buckets = new Array(15).fill(0); // 0-19,20-39...280-299
    games.forEach(g=>{
      let idx = Math.floor(g.score/20);
      if (idx>14) idx=14;
      if (idx<0) idx=0;
      buckets[idx]++;
    });
    return buckets;
  }
};

// ---------- Session grouping ----------
// A "session" is the set of games logged together for one outing: same date, same context
// (league/open), and same league if applicable. This mirrors how the multi-game entry form
// already saves a batch of games — grouping them back together for display is the natural
// inverse of that, and matches how bowling actually happens (a set of games, not one in isolation).
function groupIntoSessions(games){
  const groups = {};
  const order = [];
  games.forEach(g=>{
    const key = [g.date, g.context, g.leagueId||'', g.tournamentId||'', g.alleyId||'', g.laneCondition||''].join('|');
    if (!groups[key]){
      groups[key] = { date: g.date, context: g.context, leagueId: g.leagueId||null, tournamentId: g.tournamentId||null, alleyId: g.alleyId||null, laneCondition: g.laneCondition||null, games: [] };
      order.push(key);
    }
    groups[key].games.push(g);
  });
  return order.map(key=>{
    const grp = groups[key];
    // keep each session's games in the order they were originally entered (createdAt), so
    // "Game 1/2/3" in the detail view matches what was actually typed during that session
    grp.games.sort((a,b)=> (a.createdAt||'').localeCompare(b.createdAt||''));
    grp.count = grp.games.length;
    grp.average = Stats.average(grp.games);
    grp.high = Stats.high(grp.games);
    grp.low = Stats.low(grp.games);
    grp.total = grp.games.reduce((sum,g)=> sum + g.score, 0);
    // representative id used for expand/collapse and detail lookups — the first game's id,
    // stable across re-renders as long as the underlying games aren't reordered
    grp.sessionId = grp.games[0].id;
    return grp;
  });
}

// ---------- Frame scoring (standard 10-pin) ----------
function scoreFrames(frames){
  // frames: array of up to 10, each { b1, b2, b3 } (b3 only frame 10), values 0-10 or null, 'X'/'/' handled as numbers already resolved to pins
  let total = 0;
  const rolls = [];
  frames.forEach((f, idx)=>{
    if (idx < 9){
      if (f.b1===10){ rolls.push(10); }
      else { rolls.push(f.b1||0); rolls.push(f.b2||0); }
    } else {
      rolls.push(f.b1||0);
      if (f.b2!=null) rolls.push(f.b2);
      if (f.b3!=null) rolls.push(f.b3);
    }
  });
  let rollIdx = 0;
  const frameScores = [];
  for (let i=0;i<10;i++){
    if (i<9){
      if (rolls[rollIdx]===10){ // strike
        const bonus = (rolls[rollIdx+1]||0)+(rolls[rollIdx+2]||0);
        frameScores.push(10+bonus);
        rollIdx+=1;
      } else {
        const two = (rolls[rollIdx]||0)+(rolls[rollIdx+1]||0);
        if (two===10){ // spare
          const bonus = rolls[rollIdx+2]||0;
          frameScores.push(10+bonus);
        } else {
          frameScores.push(two);
        }
        rollIdx+=2;
      }
    } else {
      // 10th frame: sum whatever was entered
      const f = frames[9];
      let sum = (f.b1||0)+(f.b2||0)+(f.b3||0);
      frameScores.push(sum);
    }
  }
  total = frameScores.reduce((a,b)=>a+b,0);
  return { total, frameScores };
}

// ---------- Views / Navigation ----------
const Views = {
  current: 'home',
  show(name){
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    const targetView = document.getElementById('view-'+name);
    targetView.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
    this.current = name;
    // main itself has a max-width cap sized for single-column reading pages — a two-column
    // page's own max-width:none only affects ITS width, not its parent's, so main needs its own
    // matching toggle here to actually let two-column pages use the full available width.
    document.querySelector('main').classList.toggle('main-two-col', targetView.classList.contains('view-two-col'));
    Render.all();
    window.scrollTo(0,0);
    // Only auto-close on mobile/tablet widths — on desktop the drawer is a permanent sidebar
    // (see the @media (min-width: 1100px) rules) and should stay visible through navigation.
    if (window.innerWidth < 1100) Drawer.close();
  }
};

// ---------- Left drawer nav ----------
const Drawer = {
  open(){
    document.getElementById('drawer').classList.add('open');
    document.getElementById('drawerBackdrop').classList.add('open');
  },
  close(){
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('drawerBackdrop').classList.remove('open');
  },
  toggle(){
    const isOpen = document.getElementById('drawer').classList.contains('open');
    if (isOpen) this.close(); else this.open();
  }
};

// ---------- Desktop two-column master-detail layout ----------
// On phones (and any viewport under 1100px), every "detail" sheet (viewing a game/league/
// tournament/ball/alley, or the Add/Edit forms for them) works exactly as it always has: a
// bottom sheet that overlays the current page. At 1100px and wider, qualifying pages instead
// show their list on the left and the detail content in a permanent right column — so the SAME
// sheet element needs to physically live in two different places depending on screen width,
// rather than duplicating its markup or render logic.
//
// This module does that relocation. Each sheet keeps a record of where it originally lived (its
// "mobile home" — a fixed anchor point at the end of the DOM, same as today) so it can always be
// moved back there if the viewport shrinks below the breakpoint again.
const DetailColumn = {
  DESKTOP_BREAKPOINT: 1100,
  // sheetId -> { mobileAnchor: Comment node marking original position, pageId: which view's
  // .page-detail-col this sheet belongs to when relocated }
  registry: {},

  isDesktop(){
    return window.innerWidth >= this.DESKTOP_BREAKPOINT;
  },

  // Called once per sheet, the first time it's ever relocated — records an HTML comment node
  // immediately before the sheet in the DOM as a permanent "put it back here" marker, so moving
  // it to a page's right column and later moving it back doesn't depend on remembering an index
  // or sibling that might itself have moved.
  ensureRegistered(sheetId, pageId){
    if (this.registry[sheetId]) return;
    const el = document.getElementById(sheetId);
    if (!el) return;
    const anchor = document.createComment('detail-column-anchor:' + sheetId);
    el.parentNode.insertBefore(anchor, el);
    this.registry[sheetId] = { mobileAnchor: anchor, pageId };
  },

  // Moves a sheet to the correct location for the CURRENT viewport width — its page's
  // .page-detail-col if desktop-width and that container exists, otherwise back to its
  // original mobile anchor point. Safe to call repeatedly; it's a no-op if the sheet is already
  // in the right place (checked via parentNode, not by re-inserting unconditionally, so this
  // doesn't reset scroll position or cause unnecessary reflow on every call).
  relocate(sheetId, pageId){
    this.ensureRegistered(sheetId, pageId);
    const entry = this.registry[sheetId];
    if (!entry) return; // sheet doesn't exist in the DOM (shouldn't happen, but don't crash if a caller passes a bad id)
    const el = document.getElementById(sheetId);
    if (!el) return;

    const desktopCol = this.isDesktop() ? document.querySelector(`#view-${entry.pageId} .page-detail-col`) : null;

    if (desktopCol){
      if (el.parentNode !== desktopCol) desktopCol.appendChild(el);
      this.hidePlaceholder(entry.pageId);
    } else {
      if (el.parentNode !== entry.mobileAnchor.parentNode || el.previousSibling !== entry.mobileAnchor){
        entry.mobileAnchor.parentNode.insertBefore(el, entry.mobileAnchor.nextSibling);
      }
    }
  },

  hidePlaceholder(pageId){
    const placeholder = document.querySelector(`#view-${pageId} .page-detail-placeholder`);
    if (placeholder) placeholder.style.display = 'none';
  },
  showPlaceholder(pageId){
    const placeholder = document.querySelector(`#view-${pageId} .page-detail-placeholder`);
    if (placeholder) placeholder.style.display = '';
  },

  // Called whenever a sheet closes — on desktop this means going back to the placeholder
  // (nothing selected) rather than the sheet just vanishing off-screen the way a mobile overlay
  // does. Safe to call even on mobile (the placeholder isn't visible there regardless, and
  // sheets aren't relocated at all below the breakpoint, so this only matters when it's needed).
  onSheetClosed(pageId){
    if (this.isDesktop()) this.showPlaceholder(pageId);
  },

  // Re-homes every previously-relocated sheet on resize, so dragging a browser window across
  // the breakpoint (rather than a full page reload) still ends up in the right state — a
  // sheet that's mid-open shouldn't silently vanish or end up trapped in the wrong layout.
  init(){
    let lastIsDesktop = this.isDesktop();
    window.addEventListener('resize', ()=>{
      const nowDesktop = this.isDesktop();
      if (nowDesktop === lastIsDesktop) return; // only act when actually crossing the breakpoint, not on every resize pixel
      lastIsDesktop = nowDesktop;
      Object.keys(this.registry).forEach(sheetId=>{
        const entry = this.registry[sheetId];
        const el = document.getElementById(sheetId);
        const isOpen = el && el.classList.contains('active');
        this.relocate(sheetId, entry.pageId);
        // If a sheet was actively open when we crossed INTO desktop width, show it in the
        // column immediately rather than requiring the person to re-click the item.
        if (isOpen && nowDesktop) this.hidePlaceholder(entry.pageId);
        if (isOpen && !nowDesktop){ /* mobile overlay behavior already handles showing it visually via the existing .active class + CSS */ }
      });
    });
  }
};


const Chart = {
  // Reads the current value of a CSS custom property (e.g. '--brass') directly from the page,
  // so inline SVG — which can't reference var() the way HTML elements can — always matches
  // whichever theme (dark or light) is actually active, without duplicating color values here.
  cssVar(name){
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },

  line(containerId, games, opts={}){
    const el = document.getElementById(containerId);
    if (!games.length){
      el.innerHTML = `<div class="chart-empty">No games logged yet for this view.</div>`;
      return;
    }
    const w = 600, h = 180, pad = 28;
    const scores = games.map(g=>g.score);
    const minS = Math.max(0, Math.min(...scores) - 15);
    const maxS = Math.min(300, Math.max(...scores) + 15);
    const range = Math.max(maxS-minS, 20);

    const n = games.length;
    const xStep = n>1 ? (w-pad*2)/(n-1) : 0;
    const xy = (i,score)=>{
      const x = pad + i*xStep;
      const y = h-pad - ((score-minS)/range)*(h-pad*2);
      return [x,y];
    };

    // running average line
    let runSum=0;
    const avgPts = scores.map((s,i)=>{ runSum+=s; return runSum/(i+1); });

    const scorePts = scores.map((s,i)=> xy(i,s));
    const avgPtsXY = avgPts.map((s,i)=> xy(i,s));

    const scorePath = scorePts.map((p,i)=> (i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
    const avgPath = avgPtsXY.map((p,i)=> (i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');

    const gridLineColor = this.cssVar('--line');
    const dimTextColor = this.cssVar('--maple-dim');
    const gutterColor = this.cssVar('--gutter-green');
    const brassColor = this.cssVar('--brass');
    const brassBrightColor = this.cssVar('--brass-bright');
    const pinRedColor = this.cssVar('--pin-red');
    const bgColor = this.cssVar('--walnut-2');

    // gridlines (3 horizontal)
    let grid = '';
    for(let i=0;i<=2;i++){
      const y = pad + i*((h-pad*2)/2);
      const val = Math.round(maxS - i*(range/2));
      grid += `<line x1="${pad}" y1="${y}" x2="${w-pad}" y2="${y}" stroke="${gridLineColor}" stroke-width="1"/>`;
      grid += `<text x="2" y="${y+3}" font-family="Space Mono, monospace" font-size="9" fill="${dimTextColor}" opacity="0.6">${val}</text>`;
    }

    const lastPt = scorePts[scorePts.length-1];

    el.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;">
        ${grid}
        <path d="${avgPath}" fill="none" stroke="${gutterColor}" stroke-width="2" stroke-dasharray="4 3" opacity="0.9"/>
        <path d="${scorePath}" fill="none" stroke="${brassColor}" stroke-width="2.5"/>
        ${scorePts.map((p,i)=>`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i===scorePts.length-1?4.5:2.5}" fill="${i===scorePts.length-1?brassBrightColor:pinRedColor}" stroke="${bgColor}" stroke-width="1"/>`).join('')}
      </svg>
      <div style="display:flex; justify-content:space-between; font-family:'Space Mono',monospace; font-size:9px; color:${dimTextColor}; opacity:0.6; padding:2px 4px 6px;">
        <span>${fmtDateShort(games[0].date)}</span>
        <span style="display:flex; align-items:center; gap:4px;"><span style="width:10px;height:2px;background:${brassColor};display:inline-block;"></span>Score &nbsp; <span style="width:10px;height:2px;background:${gutterColor};display:inline-block;"></span>Avg</span>
        <span>${fmtDateShort(games[games.length-1].date)}</span>
      </div>
    `;
  },

  distribution(containerId, games){
    const el = document.getElementById(containerId);
    if (!games.length){ el.innerHTML = `<div class="chart-empty">No games yet.</div>`; return; }
    const buckets = Stats.distribution(games);
    const max = Math.max(...buckets, 1);
    const w = 600, h = 140, pad=24;
    const barW = (w-pad*2)/buckets.length;

    const emptyBarColor = this.cssVar('--line');
    const filledBarColor = this.cssVar('--pin-red');
    const textColor = this.cssVar('--maple');
    const dimTextColor = this.cssVar('--maple-dim');

    let bars = '';
    buckets.forEach((count,i)=>{
      const bh = (count/max)*(h-pad*2-10);
      const x = pad + i*barW;
      const y = h-pad-bh;
      const isEmpty = count===0;
      bars += `<rect x="${(x+1).toFixed(1)}" y="${y.toFixed(1)}" width="${(barW-2).toFixed(1)}" height="${bh.toFixed(1)}" fill="${isEmpty?emptyBarColor:filledBarColor}" rx="1"/>`;
      if (count>0){
        bars += `<text x="${(x+barW/2).toFixed(1)}" y="${(y-4).toFixed(1)}" font-family="Space Mono,monospace" font-size="9" fill="${textColor}" text-anchor="middle">${count}</text>`;
      }
    });
    let labels = '';
    [0,4,8,12].forEach(i=>{
      const x = pad + i*barW + barW/2;
      labels += `<text x="${x.toFixed(1)}" y="${h-6}" font-family="Space Mono,monospace" font-size="8" fill="${dimTextColor}" opacity="0.6" text-anchor="middle">${i*20}</text>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;">${bars}${labels}</svg>`;
  }
};

// ---------- Stats widgets: one render function per catalog entry ----------
// Each function receives the already-filtered game list (respecting the All/League/Open
// context and the league sub-filter) and renders into a container whose id is
// `statsWidget-<id>` — created fresh by Render.statsView() just before these run.
const StatsWidgets = {
  render(widget, games){
    if (widget.kind === 'custom'){
      this.renderCustomWidget(widget, games);
      return;
    }
    const fn = this.renderers[widget.id];
    if (fn) fn(games);
  },

  // Human-readable title for a custom widget, e.g. "Average Score by Ball" or "Games Played by
  // Lane Condition" — built from the metric + variable labels rather than stored redundantly,
  // so renaming a label in the registry automatically updates every existing custom widget's title.
  customWidgetTitle(widget){
    const metric = STATS_METRICS.find(m=>m.id===widget.metric);
    const variable = STATS_VARIABLES.find(v=>v.id===widget.variable);
    if (!metric || !variable) return 'Custom Widget';
    return `${metric.label} by ${variable.label}`;
  },

  // Groups games by the widget's chosen variable, computes the widget's chosen metric per group,
  // and renders using whichever chart type was picked — this one function replaces what used to
  // be three separate hand-written widgets (byBall/byAlley/byLeague), generalized to any variable.
  renderCustomWidget(widget, games){
    const containerId = 'statsWidget-' + widget.id;
    const el = document.getElementById(containerId);
    if (!el) return;
    el.className = 'chart-card';

    const variable = STATS_VARIABLES.find(v=>v.id===widget.variable);
    const metric = STATS_METRICS.find(m=>m.id===widget.metric);
    if (!variable || !metric){
      el.innerHTML = `<div class="chart-empty">This widget's settings are no longer valid — edit or remove it.</div>`;
      return;
    }

    const groups = {};
    const groupOrder = []; // preserves first-seen order, used for the "line" chart type's x-axis
    games.forEach(g=>{
      const key = variable.keyFn(g);
      if (key==null) return; // games missing this variable are excluded from that breakdown, same as before
      if (!groups[key]){ groups[key] = []; groupOrder.push(key); }
      groups[key].push(g);
    });

    const rows = groupOrder.map(key => ({
      name: variable.nameFn(key),
      value: metric.compute(groups[key]),
      count: groups[key].length
    })).filter(r => r.name && r.value != null); // skip groups whose name lookup failed (e.g. deleted entity) or with no computable value

    if (!rows.length){
      el.innerHTML = `<div class="chart-empty">No games have "${escapeHtml(variable.label)}" set yet — pick one when logging a game to see this breakdown.</div>`;
      return;
    }

    if (widget.chartType === 'number'){
      this.renderNumberList(el, rows, metric);
    } else if (widget.chartType === 'line'){
      this.renderLineBreakdown(el, rows, metric, variable);
    } else {
      this.renderBarBreakdown(el, rows, metric);
    }
  },

  // Bar: sorted highest-value-first horizontal bar list — the original visual style all three
  // legacy breakdown widgets used.
  renderBarBreakdown(el, rows, metric){
    const sorted = [...rows].sort((a,b)=> b.value - a.value);
    const maxVal = Math.max(...sorted.map(r=>r.value), 1);
    el.innerHTML = sorted.map(r => `
      <div style="margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
          <span style="color:var(--maple);">${escapeHtml(r.name)}</span>
          <span style="color:var(--maple-dim); font-family:var(--mono);">${metric.fmt(r.value)} · ${r.count}g</span>
        </div>
        <div style="background:var(--line); border-radius:3px; height:8px; overflow:hidden;">
          <div style="background:var(--brass); height:100%; width:${Math.max(4,(r.value/maxVal)*100)}%; border-radius:3px;"></div>
        </div>
      </div>
    `).join('');
  },

  // Number only: a plain sorted list with no visual bar — for when the bar itself isn't wanted,
  // just the figures.
  renderNumberList(el, rows, metric){
    const sorted = [...rows].sort((a,b)=> b.value - a.value);
    el.innerHTML = sorted.map(r => `
      <div style="display:flex; justify-content:space-between; align-items:baseline; padding:8px 0; border-bottom:1px solid var(--line);">
        <span style="font-size:13px; color:var(--maple);">${escapeHtml(r.name)}</span>
        <span style="font-family:var(--disp); font-size:20px; color:var(--brass-bright);">${metric.fmt(r.value)}</span>
      </div>
    `).join('');
  },

  // Line: connects each group's value in the order those groups first appeared across the
  // filtered games (roughly chronological, since games are stored/filtered in date order) —
  // useful for seeing how, say, your average per lane condition compares across the categories
  // you've actually encountered, plotted left-to-right. Reuses the same inline-SVG approach as
  // the main trend chart, reading live theme colors the same way.
  renderLineBreakdown(el, rows, metric){
    const w = 600, h = 160, pad = 28;
    const values = rows.map(r=>r.value);
    const minV = Math.min(...values), maxV = Math.max(...values);
    const range = Math.max(maxV - minV, 1);
    const n = rows.length;
    const xStep = n>1 ? (w-pad*2)/(n-1) : 0;
    const xy = (i,v)=>{
      const x = pad + i*xStep;
      const y = h-pad - ((v-minV)/range)*(h-pad*2);
      return [x,y];
    };
    const pts = values.map((v,i)=>xy(i,v));
    const path = pts.map((p,i)=> (i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');

    const brassColor = Chart.cssVar('--brass');
    const brassBrightColor = Chart.cssVar('--brass-bright');
    const dimTextColor = Chart.cssVar('--maple-dim');
    const bgColor = Chart.cssVar('--walnut-2');

    const labels = rows.map((r,i)=>{
      const x = pad + i*xStep;
      return `<text x="${x.toFixed(1)}" y="${h-6}" font-family="Space Mono,monospace" font-size="8" fill="${dimTextColor}" text-anchor="middle">${escapeHtml(r.name.slice(0,10))}</text>`;
    }).join('');

    el.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;">
        <path d="${path}" fill="none" stroke="${brassColor}" stroke-width="2.5"/>
        ${pts.map((p,i)=>`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${brassBrightColor}" stroke="${bgColor}" stroke-width="1"/>`).join('')}
        ${labels}
      </svg>
      <div style="display:flex; justify-content:space-between; font-family:'Space Mono',monospace; font-size:9px; color:${dimTextColor}; padding:2px 4px 6px;">
        <span>${metric.fmt(minV)}</span>
        <span>${metric.fmt(maxV)}</span>
      </div>
    `;
  },

  renderers: {
    summary(games){
      const el = document.getElementById('statsWidget-summary');
      if (!el) return;
      el.className = 'stat-hero';
      el.innerHTML = `
        <div class="stat-hero-row">
          <div class="stat-block">
            <span class="stat-eyebrow">Games</span>
            <div class="stat-number" style="font-size:32px;">${games.length}</div>
          </div>
          <div class="stat-divider"></div>
          <div class="stat-block">
            <span class="stat-eyebrow">High Game</span>
            <div class="stat-number accent" style="font-size:32px;">${games.length ? Stats.high(games) : '—'}</div>
          </div>
          <div class="stat-divider"></div>
          <div class="stat-block">
            <span class="stat-eyebrow">Low Game</span>
            <div class="stat-number" style="font-size:32px;">${games.length ? Stats.low(games) : '—'}</div>
          </div>
        </div>
      `;
    },

    trend(games){
      Chart.line('statsWidget-trend', games);
    },

    distribution(games){
      Chart.distribution('statsWidget-distribution', games);
    },

    recentForm(games){
      const el = document.getElementById('statsWidget-recentForm');
      if (!el) return;
      el.className = 'chart-card';
      const seasonAvg = Stats.average(games);
      const recentAvg = Stats.recentAverage(games, 5);
      if (seasonAvg==null){
        el.innerHTML = `<div class="chart-empty">Log a few games to see this.</div>`;
        return;
      }
      const diff = recentAvg - seasonAvg;
      const diffStr = diff>0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
      const color = diff>0 ? 'var(--gutter-green-bright)' : (diff<0 ? 'var(--pin-red-bright)' : 'var(--maple-dim)');
      el.innerHTML = `
        <div style="display:flex; justify-content:space-around; text-align:center; padding: 10px 0;">
          <div>
            <div style="font-family:var(--mono); font-size:10px; color:var(--maple-dim); text-transform:uppercase; letter-spacing:1px;">Last 5</div>
            <div style="font-family:var(--disp); font-size:28px; margin-top:4px;">${recentAvg.toFixed(1)}</div>
          </div>
          <div>
            <div style="font-family:var(--mono); font-size:10px; color:var(--maple-dim); text-transform:uppercase; letter-spacing:1px;">Season</div>
            <div style="font-family:var(--disp); font-size:28px; margin-top:4px;">${seasonAvg.toFixed(1)}</div>
          </div>
          <div>
            <div style="font-family:var(--mono); font-size:10px; color:var(--maple-dim); text-transform:uppercase; letter-spacing:1px;">Diff</div>
            <div style="font-family:var(--disp); font-size:28px; margin-top:4px; color:${color};">${diffStr}</div>
          </div>
        </div>
      `;
    },

    // Strike/spare rate only means anything for games logged frame-by-frame — simple total-only
    // entries have no per-frame data to inspect, so they're silently excluded from this one widget
    // (they still count everywhere else, like the trend chart or overall average).
    strikeSpare(games){
      const el = document.getElementById('statsWidget-strikeSpare');
      if (!el) return;
      el.className = 'chart-card';
      const framedGames = games.filter(g => Array.isArray(g.frames) && g.frames.length === 10);
      if (!framedGames.length){
        el.innerHTML = `<div class="chart-empty">No frame-by-frame games yet — use "Enter frame-by-frame instead" when logging a game to see strike/spare rates.</div>`;
        return;
      }
      let strikes = 0, spares = 0, opens = 0, firstBallFrames = 0;
      framedGames.forEach(g=>{
        g.frames.slice(0,9).forEach(f=>{
          if (f.b1==null) return; // frame wasn't actually filled in (shouldn't normally happen, but guard anyway)
          firstBallFrames++;
          if (f.b1===10) strikes++;
          else if ((f.b1||0)+(f.b2||0) === 10) spares++;
          else opens++;
        });
        // 10th frame: count its first ball the same way for consistency
        const f10 = g.frames[9];
        if (f10 && f10.b1!=null){
          firstBallFrames++;
          if (f10.b1===10) strikes++;
          else if ((f10.b1||0)+(f10.b2||0)===10) spares++;
          else opens++;
        }
      });
      const pct = n => firstBallFrames ? ((n/firstBallFrames)*100).toFixed(1) : '0.0';
      el.innerHTML = `
        <div style="display:flex; justify-content:space-around; text-align:center; padding: 10px 0;">
          <div>
            <div style="font-family:var(--mono); font-size:10px; color:var(--maple-dim); text-transform:uppercase; letter-spacing:1px;">Strikes</div>
            <div style="font-family:var(--disp); font-size:26px; margin-top:4px; color:var(--brass-bright);">${pct(strikes)}%</div>
          </div>
          <div>
            <div style="font-family:var(--mono); font-size:10px; color:var(--maple-dim); text-transform:uppercase; letter-spacing:1px;">Spares</div>
            <div style="font-family:var(--disp); font-size:26px; margin-top:4px; color:var(--gutter-green-bright);">${pct(spares)}%</div>
          </div>
          <div>
            <div style="font-family:var(--mono); font-size:10px; color:var(--maple-dim); text-transform:uppercase; letter-spacing:1px;">Opens</div>
            <div style="font-family:var(--disp); font-size:26px; margin-top:4px;">${pct(opens)}%</div>
          </div>
        </div>
        <div class="small-note" style="text-align:center; margin-top:4px;">Based on ${framedGames.length} frame-by-frame game${framedGames.length===1?'':'s'} (${firstBallFrames} frames)</div>
      `;
    }
  }
};

// ---------- Stats layout editor (drag-to-reorder + show/hide) ----------
// Uses pointer events rather than native HTML5 drag-and-drop, since the native drag API is
// notoriously unreliable on mobile touchscreens (no drag image, inconsistent touch handling
// across browsers) — pointer events work uniformly for mouse, touch, and stylus.
const StatsLayoutEditor = {
  workingLayout: [], // a working copy edited live in the sheet; only committed to Store on Done
  dragState: null,   // { fromIndex, rowHeight, startY, currentY, row } while a drag is in progress

  open(){
    // Deep-copy so cancelling (closing without Done) never mutates the real saved layout
    this.workingLayout = Store.getStatsLayout().map(w => Object.assign({}, w));
    this.render();
    document.getElementById('statsEditorOverlay').classList.add('active');
  },

  close(){
    document.getElementById('statsEditorOverlay').classList.remove('active');
  },

  done(){
    Store.setStatsLayout(this.workingLayout);
    this.close();
    Render.all(); // refresh the live Stats page behind the sheet with the new layout
    toast('Analytics layout updated');
  },

  resetToDefault(){
    if (!confirm('Reset Analytics back to the default widgets and order?')) return;
    this.workingLayout = DEFAULT_STATS_LAYOUT.map(w => Object.assign({}, w));
    this.render();
  },

  // Adds a brand-new custom widget (visible by default, appended to the end) to the working
  // layout and re-renders the editor list to show it immediately.
  addCustomWidget(widget){
    this.workingLayout.push(Object.assign({ visible: true }, widget));
    this.render();
  },

  updateCustomWidget(id, fields){
    const widget = this.workingLayout.find(w=>w.id===id);
    if (widget) Object.assign(widget, fields);
    this.render();
  },

  removeCustomWidget(id){
    this.workingLayout = this.workingLayout.filter(w=>w.id!==id);
    this.render();
  },

  render(){
    const el = document.getElementById('statsEditorList');
    if (!el) return;
    el.innerHTML = this.workingLayout.map((w, idx) => {
      let label, isCustom = false;
      if (w.kind === 'custom'){
        label = StatsWidgets.customWidgetTitle(w);
        isCustom = true;
      } else {
        const meta = STATS_WIDGET_CATALOG.find(c => c.id === w.id);
        if (!meta) return '';
        label = meta.label;
      }
      const labelAttrs = isCustom ? `data-edit-custom="${w.id}" style="cursor:pointer;"` : '';
      return `
        <div class="stats-editor-row" data-widget-id="${w.id}" data-index="${idx}">
          <span class="stats-editor-drag-handle" data-drag-handle="${w.id}">⠿</span>
          <span class="stats-editor-label ${w.visible?'':'hidden-widget'}" ${labelAttrs}>${escapeHtml(label)}${isCustom?' <span style="opacity:0.5;">✎</span>':''}</span>
          <label class="stats-toggle">
            <input type="checkbox" data-toggle-id="${w.id}" ${w.visible?'checked':''} />
            <span class="stats-toggle-track"></span>
          </label>
        </div>
      `;
    }).join('');

    // Toggle visibility
    el.querySelectorAll('[data-toggle-id]').forEach(input=>{
      input.addEventListener('change', (e)=>{
        const id = e.target.dataset.toggleId;
        const w = this.workingLayout.find(w=>w.id===id);
        if (w) w.visible = e.target.checked;
        this.render(); // re-render so the label dims/brightens to match, and to rebind handles cleanly
      });
    });

    // Tapping a custom widget's label opens the builder sheet pre-filled for editing
    el.querySelectorAll('[data-edit-custom]').forEach(label=>{
      label.addEventListener('click', (e)=>{
        const id = e.currentTarget.dataset.editCustom;
        const widget = this.workingLayout.find(w=>w.id===id);
        if (widget) CustomWidgetBuilder.openEdit(widget);
      });
    });

    // Drag-to-reorder via pointer events on the handle only (so toggling the switch or reading
    // the label never accidentally starts a drag)
    el.querySelectorAll('[data-drag-handle]').forEach(handle=>{
      handle.addEventListener('pointerdown', (e)=> this.startDrag(e));
    });
  },

  startDrag(e){
    const row = e.target.closest('.stats-editor-row');
    if (!row) return;
    e.preventDefault();
    const list = document.getElementById('statsEditorList');
    const rows = Array.from(list.querySelectorAll('.stats-editor-row'));
    this.dragState = {
      fromIndex: parseInt(row.dataset.index),
      rowHeight: row.getBoundingClientRect().height,
      startY: e.clientY,
      row,
      rows
    };
    row.classList.add('dragging');
    // Pointer capture keeps move/up events targeted at this row even if the finger/cursor
    // strays outside its bounds mid-drag — not universally implemented (missing in some older
    // or embedded WebViews, and in jsdom), so this degrades gracefully rather than breaking
    // the whole drag interaction if it's unavailable.
    try{ row.setPointerCapture(e.pointerId); }catch(err){ /* proceed without capture */ }

    const onMove = (moveEvent)=> this.handleDragMove(moveEvent);
    const onUp = (upEvent)=> this.endDrag(upEvent, onMove, onUp);
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', onUp);
  },

  handleDragMove(e){
    if (!this.dragState) return;
    const { startY, rowHeight, fromIndex, rows } = this.dragState;
    const deltaY = e.clientY - startY;
    const slots = Math.round(deltaY / rowHeight);
    let targetIndex = Math.max(0, Math.min(rows.length-1, fromIndex + slots));
    this.dragState.currentTargetIndex = targetIndex;

    // Visually shift the other rows out of the way via transform, without touching the DOM
    // order yet — the actual array reorder + re-render only happens once, on drop, which is
    // both simpler to reason about and avoids fighting the browser mid-drag.
    rows.forEach((r, idx)=>{
      if (r === this.dragState.row) return;
      let shift = 0;
      if (fromIndex < targetIndex && idx > fromIndex && idx <= targetIndex) shift = -rowHeight;
      else if (fromIndex > targetIndex && idx >= targetIndex && idx < fromIndex) shift = rowHeight;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
      r.style.transition = 'transform 0.15s ease';
    });
    this.dragState.row.style.transform = `translateY(${deltaY}px)`;
  },

  endDrag(e, onMove, onUp){
    if (!this.dragState) return;
    const { row, fromIndex, rows } = this.dragState;
    const targetIndex = this.dragState.currentTargetIndex != null ? this.dragState.currentTargetIndex : fromIndex;

    row.removeEventListener('pointermove', onMove);
    row.removeEventListener('pointerup', onUp);
    row.removeEventListener('pointercancel', onUp);
    try{ row.releasePointerCapture(e.pointerId); }catch(err){ /* already released, ignore */ }

    rows.forEach(r=>{ r.style.transform=''; r.style.transition=''; });
    row.classList.remove('dragging');

    if (targetIndex !== fromIndex){
      const [moved] = this.workingLayout.splice(fromIndex, 1);
      this.workingLayout.splice(targetIndex, 0, moved);
    }
    this.dragState = null;
    this.render(); // rebuild from the (possibly reordered) array, restoring correct data-index values
  }
};

// ---------- Custom widget builder (variable + metric + chart type picker) ----------
const CustomWidgetBuilder = {
  editingId: null,       // null while creating a new widget; set to the widget id while editing one
  selectedChartType: 'bar',

  populateSelects(){
    const varSel = document.getElementById('inputCustomWidgetVariable');
    const metricSel = document.getElementById('inputCustomWidgetMetric');
    if (varSel) varSel.innerHTML = STATS_VARIABLES.map(v => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join('');
    if (metricSel) metricSel.innerHTML = STATS_METRICS.map(m => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
  },

  setChartType(type){
    this.selectedChartType = type;
    document.querySelectorAll('#customWidgetBuilderOverlay [data-chart-type]').forEach(chip=>{
      chip.classList.toggle('selected', chip.dataset.chartType === type);
    });
  },

  openAdd(){
    this.editingId = null;
    document.getElementById('customWidgetBuilderTitle').textContent = 'Add Custom Widget';
    this.populateSelects();
    document.getElementById('inputCustomWidgetVariable').value = 'ball';
    document.getElementById('inputCustomWidgetMetric').value = 'average';
    this.setChartType('bar');
    document.getElementById('btnDeleteCustomWidget').style.display = 'none';
    document.getElementById('customWidgetBuilderOverlay').classList.add('active');
  },

  openEdit(widget){
    this.editingId = widget.id;
    document.getElementById('customWidgetBuilderTitle').textContent = 'Edit Custom Widget';
    this.populateSelects();
    document.getElementById('inputCustomWidgetVariable').value = widget.variable;
    document.getElementById('inputCustomWidgetMetric').value = widget.metric;
    this.setChartType(widget.chartType || 'bar');
    document.getElementById('btnDeleteCustomWidget').style.display = '';
    document.getElementById('customWidgetBuilderOverlay').classList.add('active');
  },

  close(){
    document.getElementById('customWidgetBuilderOverlay').classList.remove('active');
  },

  save(){
    const variable = document.getElementById('inputCustomWidgetVariable').value;
    const metric = document.getElementById('inputCustomWidgetMetric').value;
    const chartType = this.selectedChartType;

    if (this.editingId){
      StatsLayoutEditor.updateCustomWidget(this.editingId, { variable, metric, chartType });
    } else {
      StatsLayoutEditor.addCustomWidget({
        id: 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
        kind: 'custom', variable, metric, chartType
      });
    }
    this.close();
  },

  delete(){
    if (!this.editingId) return;
    if (confirm('Remove this custom widget?')){
      StatsLayoutEditor.removeCustomWidget(this.editingId);
      this.close();
    }
  }
};

// Clamp/validate a pin count coming from an untrusted vision-model scan
function normalizePinCount(v){
  if (v==null || v==='') return null;
  const n = typeof v === 'number' ? v : parseInt(v);
  if (isNaN(n)) return null;
  return Math.max(0, Math.min(10, n));
}

function fmtDateShort(iso){
  const d = new Date(iso+'T12:00:00');
  return d.toLocaleDateString(undefined,{month:'short', day:'numeric'});
}
function fmtDateLong(iso){
  const d = new Date(iso+'T12:00:00');
  return d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric', year:'numeric'});
}

// ---------- Render ----------
const Render = {
  lastSessionsById: {},        // populated by homeChartAndList(), keyed by session.sessionId
  lastHistorySessionsById: {}, // populated by historyList(), keyed by session.sessionId

  all(){
    this.homeStats();
    if (Views.current==='home') this.homeChartAndList();
    if (Views.current==='history') this.historyList();
    if (Views.current==='stats') this.statsView();
    if (Views.current==='leagues' && typeof LeaguesUI !== 'undefined') LeaguesUI.render();
    if (Views.current==='tournaments' && typeof TournamentsUI !== 'undefined') TournamentsUI.render();
    if (Views.current==='lanefinder' && typeof LaneFinder !== 'undefined') LaneFinder.onViewShown();
    if (Views.current==='balls' && typeof BallsUI !== 'undefined') BallsUI.render();
    if (Views.current==='friends' && typeof FriendsUI !== 'undefined') FriendsUI.render();
    if (Views.current==='settings' && typeof SettingsUI !== 'undefined') SettingsUI.render();
  },

  homeStats(){
    const all = Store.games;
    const league = Store.filtered('league');
    const overallAvg = Stats.average(all);
    const leagueAvg = Stats.average(league);

    document.getElementById('statOverall').textContent = overallAvg!=null ? overallAvg.toFixed(1) : '—';
    document.getElementById('statLeague').textContent = leagueAvg!=null ? leagueAvg.toFixed(1) : '—';

    const overallDelta = Stats.trendDelta(all, 5);
    const leagueDelta = Stats.trendDelta(league, 5);
    setDeltaEl('statOverallDelta', overallDelta);
    setDeltaEl('statLeagueDelta', leagueDelta);

    // pin rack visualization: show progress toward next 10-pin average milestone
    const rack = document.getElementById('pinrack');
    rack.innerHTML = '';
    const baseAvg = overallAvg || 0;
    const milestone = Math.ceil((baseAvg+1)/10)*10; // next multiple of 10 above current avg
    const prevMilestone = milestone-10;
    const progress = milestone>prevMilestone ? Math.max(0,Math.min(1,(baseAvg-prevMilestone)/(milestone-prevMilestone))) : 0;
    const litCount = all.length ? Math.round(progress*10) : 0;
    for(let i=0;i<10;i++){
      const pin = document.createElement('div');
      pin.className = 'pin ' + (i<litCount ? 'up':'down');
      rack.appendChild(pin);
    }
  },

  homeChartAndList(){
    const ctx = document.querySelector('#chartCtxToggle .ctx-btn.active').dataset.ctx;
    const games = Store.filtered(ctx);
    Chart.line('trendChart', games);

    const listEl = document.getElementById('recentGamesList');
    // Group ALL games into sessions first, then take the 5 most recent sessions — this shows
    // recent outings rather than recent individual score entries, which would otherwise let one
    // multi-game session crowd out everything else in a short "recent" list.
    const allSessions = groupIntoSessions(Store.games);
    const recentSessions = [...allSessions].reverse().slice(0,5);
    this.lastSessionsById = {};
    recentSessions.forEach(s => this.lastSessionsById[s.sessionId] = s);
    listEl.innerHTML = recentSessions.length ? recentSessions.map(sessionRowHTML).join('') : emptyStateHTML();
    attachRowHandlers(listEl);
  },

  historyList(){
    const ctx = document.querySelector('#historyCtxToggle .ctx-btn.active').dataset.ctx;
    const games = Store.filtered(ctx);
    const sessions = [...groupIntoSessions(games)].reverse();
    const listEl = document.getElementById('historyList');
    // History's lookup cache is separate from Home's, since the two views can show an
    // overlapping-but-different set of sessions (different context filters) at the same time.
    this.lastHistorySessionsById = {};
    sessions.forEach(s => this.lastHistorySessionsById[s.sessionId] = s);
    listEl.innerHTML = sessions.length ? sessions.map(sessionRowHTML).join('') : emptyStateHTML();
    attachHistoryRowHandlers(listEl);
  },

  statsView(){
    const ctx = document.querySelector('#statsCtxToggle .ctx-btn.active').dataset.ctx;

    // The league-specific filter only makes sense within the League context — hide it otherwise.
    const filterField = document.getElementById('statsLeagueFilterField');
    const filterSelect = document.getElementById('statsLeagueFilter');
    let games;
    if (ctx === 'league'){
      if (filterField) filterField.style.display = '';
      this.populateStatsLeagueFilter();
      const selectedLeagueId = filterSelect ? filterSelect.value : '';
      const leagueGames = Store.filtered('league');
      games = selectedLeagueId ? leagueGames.filter(g => g.leagueId === selectedLeagueId) : leagueGames;
    } else {
      if (filterField) filterField.style.display = 'none';
      games = Store.filtered(ctx);
    }

    // Date range filter applies on top of the context/league filter above — the two are
    // independent axes (e.g. "just this league, but only this season"), so this always runs
    // regardless of which context tab is active.
    games = this.applyStatsDateRange(games);

    const container = document.getElementById('statsWidgetsContainer');
    if (!container) return;
    const layout = Store.getStatsLayout();
    const visibleWidgets = layout.filter(w => w.visible);

    if (!visibleWidgets.length){
      container.innerHTML = `<div class="empty-state"><div class="pin down"></div><p>No widgets are turned on. Tap <b>Edit</b> above to add some.</p></div>`;
      return;
    }

    // Build a fresh container div per widget (with its own section-head + card wrapper, matching
    // the exact markup the page always used) so each widget's render function can target a stable,
    // predictable element by id — the same pattern Chart.line/Chart.distribution already expect.
    // The "summary" widget is the one exception: it replaces itself with a .stat-hero block (no
    // card wrapper), matching how it always looked before this became configurable.
    container.innerHTML = visibleWidgets.map(w => {
      let title, containerId;
      if (w.kind === 'custom'){
        title = StatsWidgets.customWidgetTitle(w);
        containerId = w.id;
      } else {
        const meta = STATS_WIDGET_CATALOG.find(c => c.id === w.id);
        if (!meta) return '';
        title = meta.title;
        containerId = w.id;
      }
      const heading = title ? `<div class="section-head"><span class="section-title">${escapeHtml(title)}</span></div>` : '';
      const cardClass = w.id === 'summary' ? '' : 'chart-card';
      return `<div class="stats-widget" data-widget-id="${w.id}">${heading}<div id="statsWidget-${containerId}" class="${cardClass}"></div></div>`;
    }).join('');

    visibleWidgets.forEach(w => StatsWidgets.render(w, games));
  },

  // Populate the Stats league filter dropdown from configured leagues, preserving the
  // current selection across re-renders (e.g. after logging a new game) where possible.
  populateStatsLeagueFilter(){
    const sel = document.getElementById('statsLeagueFilter');
    if (!sel) return;
    const currentValue = sel.value;
    const leagues = Store.settings.leagues;
    sel.innerHTML = '<option value="">All Leagues</option>' +
      leagues.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    if (leagues.some(l => l.id === currentValue)){
      sel.value = currentValue;
    }
  },

  // Filters games down to whichever date range is currently selected on the Stats page: a
  // rolling window (last 30/90 days from today), a custom start/end range, or no filtering at
  // all ("All Time", the default). Comparisons are plain string comparisons since game.date is
  // always stored as 'YYYY-MM-DD', which sorts identically to a real date comparison.
  applyStatsDateRange(games){
    const activeBtn = document.querySelector('#statsDateRangeToggle .ctx-btn.active');
    const range = activeBtn ? activeBtn.dataset.range : 'all';
    const customFields = document.getElementById('statsCustomRangeFields');

    if (range === 'all'){
      if (customFields) customFields.style.display = 'none';
      return games;
    }

    if (range === 'custom'){
      if (customFields) customFields.style.display = '';
      const startVal = document.getElementById('statsRangeStart').value;
      const endVal = document.getElementById('statsRangeEnd').value;
      if (!startVal && !endVal) return games; // no bounds picked yet — don't filter anything out
      return games.filter(g => (!startVal || g.date >= startVal) && (!endVal || g.date <= endVal));
    }

    // Rolling window presets (30/90 days)
    if (customFields) customFields.style.display = 'none';
    const days = parseInt(range);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0,10);
    return games.filter(g => g.date >= cutoffStr);
  }
};

function setDeltaEl(id, delta){
  const el = document.getElementById(id);
  if (delta==null){ el.textContent=''; el.className='stat-delta'; return; }
  const rounded = delta.toFixed(1);
  if (Math.abs(delta) < 0.05){ el.textContent = 'steady'; el.className='stat-delta'; return; }
  el.textContent = (delta>0?'▲ +':'▼ ')+rounded+' last 5';
  el.className = 'stat-delta ' + (delta>0?'up':'down');
}

function sessionRowHTML(session){
  const firstGame = session.games[0];
  const isMultiGame = session.count > 1;
  const tagClass = firstGame.context === 'league' ? 'league' : (firstGame.context === 'tournament' ? 'tournament' : 'open');
  const tagLabel = contextTagLabel(firstGame);

  const alleyName = session.alleyId ? Store.alleyName(session.alleyId) : '';
  const metaBits = alleyName;
  const isOverallPR = session.high === Stats.high(Store.games) && Store.games.length>1;

  // single-game sessions show just the score, exactly as before; multi-game sessions show
  // the average as the headline number with a small badge indicating how many games it covers
  const scoreBoxContent = isMultiGame
    ? `<span class="session-avg-num">${session.average.toFixed(1)}</span><span class="session-score-label">avg</span><span class="games-count-badge">${session.count}g</span>`
    : `${firstGame.score}`;

  const subLine = isMultiGame
    ? `High ${session.high} · Low ${session.low}${metaBits ? ' · '+metaBits : ''}`
    : metaBits;

  return `
    <div class="game-row" data-session-id="${session.sessionId}">
      <div class="game-score-box ${isMultiGame?'multi-game':''} ${isOverallPR && !isMultiGame ?'pr':''}">${scoreBoxContent}</div>
      <div class="game-meta">
        <div class="game-date">${fmtDateLong(session.date)}<span class="game-tag ${tagClass}">${escapeHtml(tagLabel)}</span></div>
        ${subLine ? `<div class="game-sub">${escapeHtml(subLine)}</div>` : ''}
        ${(!isMultiGame && firstGame.notes) ? `<div class="game-sub">${escapeHtml(firstGame.notes)}</div>` : ''}
      </div>
      <div class="game-chevron">›</div>
    </div>
  `;
}

function emptyStateHTML(){
  return `
    <div class="empty-state">
      <div class="pin up"></div>
      <p>No games logged yet. Tap the red button to record your first score.</p>
    </div>
  `;
}

// Resolves the display label for a game's context tag — used everywhere a game or session row
// shows its League/Tournament/Open badge, so this three-way branch only needs to exist once.
function contextTagLabel(g){
  if (g.context === 'league') return Store.leagueDisplayName(g);
  if (g.context === 'tournament') return Store.tournamentDisplayName(g);
  return 'Open';
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function attachRowHandlers(container){
  container.querySelectorAll('.game-row[data-session-id]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const sessionId = row.dataset.sessionId;
      const session = Render.lastSessionsById[sessionId];
      if (!session) return;
      if (session.count > 1){
        openSessionDetail(session);
      } else {
        openDetail(session.games[0].id);
      }
    });
  });
}

function attachHistoryRowHandlers(container){
  container.querySelectorAll('.game-row[data-session-id]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const sessionId = row.dataset.sessionId;
      const session = Render.lastHistorySessionsById[sessionId];
      if (!session) return;
      if (session.count > 1){
        openSessionDetail(session);
      } else {
        openDetail(session.games[0].id);
      }
    });
  });
}

// ---------- Toast ----------
function toast(msg, ms=2200){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=> t.classList.remove('show'), ms);
}

// ---------- Add Game Sheet ----------
// ---------- Settings: Ball lineup, Alleys ----------
const SettingsUI = {
  render(){
    this.renderAlleys();
    this.renderUsernameVisibility();
  },

  renderUsernameVisibility(){
    const group = document.getElementById('usernameSettingsGroup');
    if (!group) return;
    const signedIn = typeof CloudSync !== 'undefined' && CloudSync.isSignedIn();
    group.style.display = signedIn ? '' : 'none';
    if (signedIn && typeof FriendsUI !== 'undefined') FriendsUI.loadCurrentUsername();
  },

  renderAlleys(){
    const el = document.getElementById('alleyList');
    if (!el) return;
    const alleys = Store.settings.alleys;
    if (!alleys.length){
      el.innerHTML = `<div class="lineup-empty">No alleys added yet.</div>`;
      return;
    }
    el.innerHTML = alleys.map(a => `
      <div class="lineup-row" data-id="${a.id}">
        <span class="lineup-name">${escapeHtml(a.name)}</span>
        <button class="lineup-delete" data-action="delete-alley" data-id="${a.id}">Remove</button>
      </div>
    `).join('');
  },

  init(){
    const btnAddAlley = document.getElementById('btnAddAlley');
    if (btnAddAlley){
      btnAddAlley.addEventListener('click', ()=>{
        const input = document.getElementById('inputNewAlley');
        const name = input.value.trim();
        if (!name){ toast('Enter an alley name'); return; }
        Store.addAlley(name);
        input.value = '';
        this.renderAlleys();
        toast('Alley added');
      });
    }

    const alleyList = document.getElementById('alleyList');
    if (alleyList){
      alleyList.addEventListener('click', (e)=>{
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = btn.dataset.id;
        if (btn.dataset.action === 'delete-alley'){
          if (confirm('Remove this alley? Any leagues using it as their alley will be cleared to "None".')){
            Store.removeAlley(id);
            this.renderAlleys();
            if (typeof LeaguesUI !== 'undefined') LeaguesUI.render();
            toast('Alley removed');
          }
        }
      });
    }
  }
};

// ---------- Balls page (its own top-level nav destination) ----------
const BallsUI = {
  render(){
    const el = document.getElementById('ballsPageList');
    if (!el) return;
    const balls = Store.settings.balls;
    if (!balls.length){
      el.innerHTML = `
        <div class="empty-state">
          <div class="pin up"></div>
          <p>No balls added yet. Add your lineup here to pick from it quickly when logging games.</p>
        </div>
      `;
      return;
    }
    el.innerHTML = balls.map(b => `
      <div class="lineup-row" data-id="${b.id}">
        <button class="lineup-star ${b.id===Store.settings.defaultBallId?'active':''}" data-action="star-ball" data-id="${b.id}" title="Set as default">★</button>
        <span class="lineup-name" data-action="open-ball" data-id="${b.id}" style="cursor:pointer;">${escapeHtml(Store.ballName(b.id))}${b.coverstock||b.coreType?' <span style="opacity:0.5; font-size:11px;">(specs saved)</span>':''}</span>
        <button class="lineup-delete" data-action="delete-ball" data-id="${b.id}">Remove</button>
      </div>
    `).join('');
  },

  init(){
    const btnAdd = document.getElementById('btnAddBallPage');
    if (btnAdd){
      btnAdd.addEventListener('click', ()=> this.openAddSheet());
    }
    const btnCancel = document.getElementById('btnCancelAddBall');
    if (btnCancel){
      btnCancel.addEventListener('click', ()=> this.closeAddSheet());
    }
    const btnSave = document.getElementById('btnSaveAddBall');
    if (btnSave){
      btnSave.addEventListener('click', ()=> this.saveAddSheet());
    }
    const addBallOverlay = document.getElementById('addBallOverlay');
    if (addBallOverlay){
      addBallOverlay.addEventListener('click', (e)=>{
        if (e.target.id==='addBallOverlay') this.closeAddSheet();
      });
    }

    const list = document.getElementById('ballsPageList');
    if (list){
      list.addEventListener('click', (e)=>{
        const nameEl = e.target.closest('[data-action="open-ball"]');
        if (nameEl){
          openBallDetail(nameEl.dataset.id);
          return;
        }
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = btn.dataset.id;
        if (btn.dataset.action === 'star-ball'){
          Store.setDefaultBall(id);
          this.render();
        } else if (btn.dataset.action === 'delete-ball'){
          if (confirm('Remove this ball from your lineup?')){
            Store.removeBall(id);
            this.render();
            toast('Ball removed');
          }
        }
      });
    }
  },

  openAddSheet(){
    document.getElementById('inputAddBallBrand').value = '';
    document.getElementById('inputAddBallModel').value = '';
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('addBallOverlay', 'balls');
    document.getElementById('addBallOverlay').classList.add('active');
  },

  closeAddSheet(){
    document.getElementById('addBallOverlay').classList.remove('active');
    if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('balls');
  },

  saveAddSheet(){
    const brand = document.getElementById('inputAddBallBrand').value.trim();
    const model = document.getElementById('inputAddBallModel').value.trim();
    if (!model){ toast('Enter the ball\'s model name'); return; }
    const ball = Store.addBall(model, brand);
    if (!ball){
      // Store.save() (called inside addBall) already surfaced its own toast if this was a
      // storage failure (e.g. running from file://) — nothing more to say here.
      return;
    }
    this.closeAddSheet();
    this.render();
    toast('Ball added');
  }
};

// ---------- Ball Detail Sheet ----------
let ballDetailId = null;

function openBallDetail(id){
  const b = Store.ballById(id);
  if (!b) return;
  ballDetailId = id;
  if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('ballDetailOverlay', 'balls');
  document.getElementById('ballDetailTitle').textContent = b.name;
  renderBallDetailSpecs(b);
  renderBallDetailStats(b);
  renderBallDetailHistory(b);
  showBallSpecForm(false);
  document.getElementById('ballDetailOverlay').classList.add('active');
}

function renderBallDetailSpecs(b){
  const el = document.getElementById('ballDetailSpecs');
  const rows = [
    ['Brand', b.brand],
    ['Coverstock type', b.coverstock],
    ['Ball type', b.coreType],
    ['RG', b.rg],
    ['Differential', b.differential],
    ['Weight', b.weight ? b.weight + ' lbs' : ''],
    ['Hook potential', b.hookPotential]
  ].filter(([,v]) => v);

  if (!rows.length && !b.specNotes){
    el.innerHTML = `<div class="chart-empty">No specs saved yet. Tap the ✎ icon to add them.</div>`;
    return;
  }
  el.innerHTML = rows.map(([label,val]) =>
    `<div class="league-detail-info-row"><span style="min-width:110px; display:inline-block; opacity:0.7;">${label}</span><span>${escapeHtml(String(val))}</span></div>`
  ).join('') + (b.specNotes ? `<div class="league-detail-notes">${escapeHtml(b.specNotes)}</div>` : '');
}

// Games/average/high/low across every logged game that used this ball — same pattern as
// League Detail's statistics section, just filtered by ballId instead of leagueId.
function renderBallDetailStats(b){
  const games = Store.games.filter(g => g.ballId === b.id);
  const el = document.getElementById('ballDetailStats');
  if (!games.length){
    el.innerHTML = `<div class="chart-empty">No games logged with this ball yet.</div>`;
    return;
  }
  const avg = Stats.average(games);
  const high = Stats.high(games);
  const low = Stats.low(games);
  el.innerHTML = `
    <div class="league-detail-stats-row">
      <div class="session-summary-stat">
        <span class="session-summary-num">${games.length}</span>
        <span class="session-summary-label">Games</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${avg.toFixed(1)}</span>
        <span class="session-summary-label">Scratch Avg</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num" style="color:var(--brass-bright);">${high}</span>
        <span class="session-summary-label">Scratch High</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${low}</span>
        <span class="session-summary-label">Scratch Low</span>
      </div>
    </div>
  `;
}

// Every session that used this ball, grouped and drillable exactly like League Detail's
// history section — tapping a session opens Session Detail (or straight to Game Detail for
// a single-game session), same as everywhere else in the app.
function renderBallDetailHistory(b){
  const games = Store.games.filter(g => g.ballId === b.id);
  const el = document.getElementById('ballDetailHistory');
  if (!games.length){
    el.innerHTML = `<div class="empty-state"><div class="pin down"></div><p>No games logged with this ball yet.</p></div>`;
    return;
  }
  const sessions = [...groupIntoSessions(games)].reverse();
  // separate lookup cache, mirroring Home/History/LeagueDetail each keeping their own, so
  // opening this sheet doesn't clobber whichever session lookup another view currently has active
  Render.lastBallDetailSessionsById = {};
  sessions.forEach(s => Render.lastBallDetailSessionsById[s.sessionId] = s);
  el.innerHTML = sessions.map(sessionRowHTML).join('');
  el.querySelectorAll('.game-row[data-session-id]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const session = Render.lastBallDetailSessionsById[row.dataset.sessionId];
      if (!session) return;
      if (session.count > 1){
        openSessionDetail(session);
      } else {
        openDetail(session.games[0].id);
      }
    });
  });
}

function showBallSpecForm(show){
  const specsWrap = document.getElementById('ballDetailSpecsWrap');
  if (specsWrap) specsWrap.style.display = show ? 'none' : '';
  const statsHistoryWrap = document.getElementById('ballDetailStatsHistoryWrap');
  if (statsHistoryWrap) statsHistoryWrap.style.display = show ? 'none' : '';
  document.getElementById('ballSpecForm').style.display = show ? '' : 'none';
  document.getElementById('btnSaveBallSpecs').style.display = show ? '' : 'none';
  if (show){
    const b = Store.ballById(ballDetailId);
    if (!b) return;
    document.getElementById('inputBallBrand').value = b.brand || '';
    document.getElementById('inputBallWeight').value = b.weight || '';
    document.getElementById('inputBallCoverstock').value = b.coverstock || '';
    document.getElementById('inputBallCoreType').value = b.coreType || '';
    document.getElementById('inputBallRg').value = b.rg || '';
    document.getElementById('inputBallDiff').value = b.differential || '';
    document.getElementById('inputBallHook').value = b.hookPotential || '';
    document.getElementById('inputBallSpecNotes').value = b.specNotes || '';
  }
}

function saveBallSpecForm(){
  if (!ballDetailId) return;
  const fields = {
    brand: document.getElementById('inputBallBrand').value.trim(),
    weight: document.getElementById('inputBallWeight').value.trim(),
    coverstock: document.getElementById('inputBallCoverstock').value.trim(),
    coreType: document.getElementById('inputBallCoreType').value.trim(),
    rg: document.getElementById('inputBallRg').value.trim(),
    differential: document.getElementById('inputBallDiff').value.trim(),
    hookPotential: document.getElementById('inputBallHook').value.trim(),
    specNotes: document.getElementById('inputBallSpecNotes').value.trim()
  };
  const updated = Store.updateBall(ballDetailId, fields);
  if (!updated) return;
  renderBallDetailSpecs(updated);
  showBallSpecForm(false);
  BallsUI.render();
  toast('Specs saved');
}

function closeBallDetail(){
  document.getElementById('ballDetailOverlay').classList.remove('active');
  ballDetailId = null;
  if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('balls');
}

// ---------- My Friends tab ----------
let friendDetailId = null; // the OTHER user's userId, while the friend detail sheet is open
let groupDetailId = null;  // the group's id, while the group detail sheet is open

const FriendsUI = {
  activeTab: 'friends',

  render(){
    const signedIn = typeof CloudSync !== 'undefined' && CloudSync.isSignedIn();
    document.getElementById('friendsSignedOutNotice').style.display = signedIn ? 'none' : '';
    document.getElementById('friendsSignedInContent').style.display = signedIn ? '' : 'none';
    if (!signedIn) return;

    this.renderFriendsList();
    if (this.activeTab === 'requests') this.renderRequests();
    if (this.activeTab === 'groups') this.renderGroups();
  },

  init(){
    // ---------- Tab switching ----------
    const tabToggle = document.getElementById('friendsTabToggle');
    if (tabToggle){
      tabToggle.querySelectorAll('.ctx-btn').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          tabToggle.querySelectorAll('.ctx-btn').forEach(b=>b.classList.remove('active'));
          btn.classList.add('active');
          this.activeTab = btn.dataset.tab;
          ['friends','requests','groups'].forEach(t=>{
            document.getElementById('friendsTabPanel-'+t).style.display = (t===this.activeTab) ? '' : 'none';
          });
          this.render();
        });
      });
    }

    // ---------- Username (Settings page) ----------
    const btnSaveUsername = document.getElementById('btnSaveUsername');
    if (btnSaveUsername){
      btnSaveUsername.addEventListener('click', async ()=>{
        const input = document.getElementById('inputUsername');
        const note = document.getElementById('usernameFieldNote');
        const val = input.value.trim();
        if (!val){ toast('Enter a username first'); return; }
        btnSaveUsername.disabled = true;
        try{
          const result = await Friends.setUsername(val);
          if (result.available){
            note.textContent = '';
            document.getElementById('usernameStatus').textContent = 'Your username: ' + val.toLowerCase();
            input.value = '';
            toast('Username saved');
          } else {
            note.textContent = result.reason;
          }
        } catch(e){
          console.error('setUsername failed:', e);
          toast('Could not save username — check your connection');
        } finally {
          btnSaveUsername.disabled = false;
        }
      });
    }

    // ---------- Friend search ----------
    const btnFriendSearch = document.getElementById('btnFriendSearch');
    if (btnFriendSearch){
      btnFriendSearch.addEventListener('click', ()=> this.doFriendSearch());
    }
    const inputFriendSearch = document.getElementById('inputFriendSearch');
    if (inputFriendSearch){
      inputFriendSearch.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') this.doFriendSearch(); });
    }

    // ---------- Friends list clicks (open detail) ----------
    const friendsList = document.getElementById('friendsList');
    if (friendsList){
      friendsList.addEventListener('click', (e)=>{
        const row = e.target.closest('[data-friend-user-id]');
        if (row) this.openFriendDetail(row.dataset.friendUserId, row.dataset.friendshipId, row.dataset.username);
      });
    }

    // ---------- Requests: accept/decline ----------
    const incomingList = document.getElementById('incomingRequestsList');
    if (incomingList){
      incomingList.addEventListener('click', async (e)=>{
        const btn = e.target.closest('button');
        if (!btn) return;
        const friendshipId = btn.dataset.friendshipId;
        try{
          if (btn.dataset.action === 'accept-request'){
            await Friends.acceptFriendRequest(friendshipId);
            toast('Friend request accepted');
          } else if (btn.dataset.action === 'decline-request'){
            await Friends.removeFriendship(friendshipId);
            toast('Request declined');
          }
          this.renderRequests();
          this.renderFriendsList();
        } catch(e){
          console.error('Request action failed:', e);
          toast('Something went wrong — check your connection');
        }
      });
    }
    const outgoingList = document.getElementById('outgoingRequestsList');
    if (outgoingList){
      outgoingList.addEventListener('click', async (e)=>{
        const btn = e.target.closest('[data-action="cancel-request"]');
        if (!btn) return;
        try{
          await Friends.removeFriendship(btn.dataset.friendshipId);
          toast('Request canceled');
          this.renderRequests();
        } catch(e){
          console.error('Cancel request failed:', e);
          toast('Something went wrong — check your connection');
        }
      });
    }

    // ---------- Friend Detail sheet ----------
    const btnCloseFriendDetail = document.getElementById('btnCloseFriendDetail');
    if (btnCloseFriendDetail){
      btnCloseFriendDetail.addEventListener('click', ()=> this.closeFriendDetail());
    }
    const friendDetailOverlay = document.getElementById('friendDetailOverlay');
    if (friendDetailOverlay){
      friendDetailOverlay.addEventListener('click', (e)=>{
        if (e.target.id === 'friendDetailOverlay') this.closeFriendDetail();
      });
    }
    const btnRemoveFriend = document.getElementById('btnRemoveFriend');
    if (btnRemoveFriend){
      btnRemoveFriend.addEventListener('click', async ()=>{
        if (!friendDetailId) return;
        if (!confirm('Remove this friend? They\'ll need to send a new request to reconnect.')) return;
        try{
          const friends = await Friends.getFriends();
          const match = friends.find(f => f.userId === friendDetailId);
          if (match) await Friends.removeFriendship(match.friendshipId);
          this.closeFriendDetail();
          this.renderFriendsList();
          toast('Friend removed');
        } catch(e){
          console.error('Remove friend failed:', e);
          toast('Something went wrong — check your connection');
        }
      });
    }
    const shareToggles = document.getElementById('friendShareToggles');
    if (shareToggles){
      shareToggles.addEventListener('change', async (e)=>{
        const checkbox = e.target.closest('input[type="checkbox"][data-stat-key]');
        if (!checkbox || !friendDetailId) return;
        try{
          await Friends.setShareWith(friendDetailId, checkbox.dataset.statKey, checkbox.checked);
        } catch(e){
          console.error('setShareWith failed:', e);
          toast('Could not save sharing preference — check your connection');
          checkbox.checked = !checkbox.checked; // revert the visible toggle since the save failed
        }
      });
    }

    // ---------- Groups tab ----------
    const groupsList = document.getElementById('groupsList');
    if (groupsList){
      groupsList.addEventListener('click', (e)=>{
        const row = e.target.closest('[data-group-id]');
        if (row) this.openGroupDetail(row.dataset.groupId);
      });
    }
    const btnAddGroup = document.getElementById('btnAddGroup');
    if (btnAddGroup){
      btnAddGroup.addEventListener('click', ()=> this.openAddGroup());
    }
    const btnCancelAddGroup = document.getElementById('btnCancelAddGroup');
    if (btnCancelAddGroup){
      btnCancelAddGroup.addEventListener('click', ()=> this.closeAddGroup());
    }
    const btnSaveAddGroup = document.getElementById('btnSaveAddGroup');
    if (btnSaveAddGroup){
      btnSaveAddGroup.addEventListener('click', ()=> this.saveAddGroup());
    }

    // ---------- Group Detail sheet ----------
    const btnCloseGroupDetail = document.getElementById('btnCloseGroupDetail');
    if (btnCloseGroupDetail){
      btnCloseGroupDetail.addEventListener('click', ()=> this.closeGroupDetail());
    }
    const groupDetailOverlay = document.getElementById('groupDetailOverlay');
    if (groupDetailOverlay){
      groupDetailOverlay.addEventListener('click', (e)=>{
        if (e.target.id === 'groupDetailOverlay') this.closeGroupDetail();
      });
    }
    const btnGroupInvite = document.getElementById('btnGroupInvite');
    if (btnGroupInvite){
      btnGroupInvite.addEventListener('click', ()=> this.inviteToGroup());
    }
    const groupMembersList = document.getElementById('groupMembersList');
    if (groupMembersList){
      groupMembersList.addEventListener('click', async (e)=>{
        const btn = e.target.closest('[data-action="remove-member"]');
        if (!btn || !groupDetailId) return;
        if (!confirm('Remove this person from the group?')) return;
        try{
          await Friends.removeFromGroup(groupDetailId, btn.dataset.userId);
          this.renderGroupDetail();
        } catch(e){
          console.error('Remove member failed:', e);
          toast('Something went wrong — check your connection');
        }
      });
    }
    const btnDeleteGroup = document.getElementById('btnDeleteGroup');
    if (btnDeleteGroup){
      btnDeleteGroup.addEventListener('click', async ()=>{
        if (!groupDetailId) return;
        if (!confirm('Delete this group entirely? This removes it for every member, not just you.')) return;
        try{
          const { error } = await CloudSync.client.from('groups').delete().eq('id', groupDetailId);
          if (error) throw error;
          this.closeGroupDetail();
          this.renderGroups();
          toast('Group deleted');
        } catch(e){
          console.error('Delete group failed:', e);
          toast('Something went wrong — check your connection');
        }
      });
    }
  },

  // ---------- Username ----------
  async loadCurrentUsername(){
    try{
      const username = await Friends.getMyUsername();
      const status = document.getElementById('usernameStatus');
      if (status) status.textContent = username ? ('Your username: ' + username) : 'Not set — pick one so friends can find you';
    } catch(e){
      console.error('loadCurrentUsername failed:', e);
    }
  },

  // ---------- Friend search ----------
  async doFriendSearch(){
    const input = document.getElementById('inputFriendSearch');
    const resultEl = document.getElementById('friendSearchResult');
    const query = input.value.trim();
    if (!query){ toast('Enter a username to search'); return; }
    resultEl.innerHTML = `<div class="small-note">Searching…</div>`;
    try{
      const found = await Friends.findByUsername(query);
      if (!found){
        resultEl.innerHTML = `<div class="small-note">No user found with that username.</div>`;
        return;
      }
      resultEl.innerHTML = `
        <div class="lineup-row">
          <span class="lineup-name">${escapeHtml(found.username)}</span>
          <button class="btn btn-primary" id="btnSendFriendRequest" style="padding:8px 14px;">Add Friend</button>
        </div>
      `;
      document.getElementById('btnSendFriendRequest').addEventListener('click', async ()=>{
        try{
          await Friends.sendFriendRequest(found.userId);
          toast('Friend request sent to ' + found.username);
          resultEl.innerHTML = '';
          input.value = '';
          this.renderRequests();
        } catch(e){
          console.error('sendFriendRequest failed:', e);
          toast(e.message || 'Could not send friend request');
        }
      });
    } catch(e){
      console.error('doFriendSearch failed:', e);
      resultEl.innerHTML = `<div class="small-note">Search failed — check your connection.</div>`;
    }
  },

  // ---------- Friends list ----------
  async renderFriendsList(){
    const el = document.getElementById('friendsList');
    if (!el) return;
    try{
      const friends = await Friends.getFriends();
      if (!friends.length){
        el.innerHTML = `<div class="lineup-empty">No friends yet — search for a username above to send a request.</div>`;
        return;
      }
      el.innerHTML = friends.map(f => `
        <div class="lineup-row" data-friend-user-id="${f.userId}" data-friendship-id="${f.friendshipId}" data-username="${escapeHtml(f.username)}" style="cursor:pointer;">
          <span class="lineup-name">${escapeHtml(f.username)}</span>
        </div>
      `).join('');
    } catch(e){
      console.error('renderFriendsList failed:', e);
      el.innerHTML = `<div class="small-note">Could not load friends — check your connection.</div>`;
    }
  },

  // ---------- Requests ----------
  async renderRequests(){
    const incomingEl = document.getElementById('incomingRequestsList');
    const outgoingEl = document.getElementById('outgoingRequestsList');
    if (!incomingEl || !outgoingEl) return;
    try{
      const { incoming, outgoing } = await Friends.getPendingRequests();

      incomingEl.innerHTML = incoming.length ? incoming.map(r => `
        <div class="lineup-row">
          <span class="lineup-name">${escapeHtml(r.username)}</span>
          <button class="btn btn-primary" data-action="accept-request" data-friendship-id="${r.friendshipId}" style="padding:6px 12px; margin-right:6px;">Accept</button>
          <button class="lineup-delete" data-action="decline-request" data-friendship-id="${r.friendshipId}">Decline</button>
        </div>
      `).join('') : `<div class="lineup-empty">No incoming requests.</div>`;

      outgoingEl.innerHTML = outgoing.length ? outgoing.map(r => `
        <div class="lineup-row">
          <span class="lineup-name">${escapeHtml(r.username)}</span>
          <span class="small-note" style="margin-right:8px;">Pending</span>
          <button class="lineup-delete" data-action="cancel-request" data-friendship-id="${r.friendshipId}">Cancel</button>
        </div>
      `).join('') : `<div class="lineup-empty">No sent requests.</div>`;
    } catch(e){
      console.error('renderRequests failed:', e);
      incomingEl.innerHTML = `<div class="small-note">Could not load requests — check your connection.</div>`;
    }
  },

  // ---------- Friend Detail ----------
  async openFriendDetail(userId, friendshipId, username){
    friendDetailId = userId;
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('friendDetailOverlay', 'friends');
    document.getElementById('friendDetailTitle').textContent = username;
    document.getElementById('friendDetailOverlay').classList.add('active');

    const statsEl = document.getElementById('friendSharedStats');
    statsEl.textContent = 'Loading…';
    try{
      const [stats, mySharedKeys] = await Promise.all([
        Friends.getFriendStats(userId),
        Friends.getMySharesWith(userId)
      ]);

      const sharedKeys = Object.keys(stats);
      statsEl.innerHTML = sharedKeys.length ? sharedKeys.map(key => {
        const label = (Friends.STAT_KEYS.find(s => s.key === key) || {}).label || key;
        return `<div class="league-detail-info-row"><span>${escapeHtml(label)}</span><span style="margin-left:auto; font-weight:600;">${escapeHtml(stats[key])}</span></div>`;
      }).join('') : `<div class="small-note">${escapeHtml(username)} hasn't shared any stats with you yet.</div>`;

      document.getElementById('friendShareToggles').innerHTML = Friends.STAT_KEYS.map(s => `
        <label class="settings-row" style="cursor:pointer;">
          <span class="settings-label" style="font-size:14px; font-weight:400;">${escapeHtml(s.label)}</span>
          <input type="checkbox" data-stat-key="${s.key}" ${mySharedKeys.includes(s.key) ? 'checked' : ''} style="width:20px; height:20px;" />
        </label>
      `).join('');
    } catch(e){
      console.error('openFriendDetail load failed:', e);
      statsEl.textContent = 'Could not load shared stats — check your connection.';
    }
  },

  closeFriendDetail(){
    document.getElementById('friendDetailOverlay').classList.remove('active');
    friendDetailId = null;
    if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('friends');
  },

  // ---------- Groups list ----------
  async renderGroups(){
    const el = document.getElementById('groupsList');
    if (!el) return;
    try{
      const groups = await Friends.getMyGroups();
      if (!groups.length){
        el.innerHTML = `<div class="lineup-empty">No groups yet — create one to share stats with a whole team or league.</div>`;
        return;
      }
      el.innerHTML = groups.map(g => `
        <div class="league-card" data-group-id="${g.id}" style="cursor:pointer;">
          <div class="league-card-name">${escapeHtml(g.name)}${g.isCreator ? ' <span class="league-card-badge current">Creator</span>' : ''}</div>
          <div class="league-card-row"><span class="icon">i</span>${g.memberCount} / ${g.maxMembers} members</div>
        </div>
      `).join('');
    } catch(e){
      console.error('renderGroups failed:', e);
      el.innerHTML = `<div class="small-note">Could not load groups — check your connection.</div>`;
    }
  },

  // ---------- Add Group ----------
  openAddGroup(){
    document.getElementById('inputNewGroupName').value = '';
    document.getElementById('inputNewGroupMaxMembers').value = '6';
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('addGroupOverlay', 'friends');
    document.getElementById('addGroupOverlay').classList.add('active');
  },
  closeAddGroup(){
    document.getElementById('addGroupOverlay').classList.remove('active');
    if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('friends');
  },
  async saveAddGroup(){
    const name = document.getElementById('inputNewGroupName').value.trim();
    const maxMembers = parseInt(document.getElementById('inputNewGroupMaxMembers').value, 10);
    if (!name){ toast('Enter a group name'); return; }
    if (!maxMembers || maxMembers < 2 || maxMembers > 50){ toast('Max members must be between 2 and 50'); return; }
    try{
      await Friends.createGroup(name, maxMembers);
      this.closeAddGroup();
      this.renderGroups();
      toast('Group created');
    } catch(e){
      console.error('createGroup failed:', e);
      toast('Could not create group — check your connection');
    }
  },

  // ---------- Group Detail ----------
  async openGroupDetail(groupId){
    groupDetailId = groupId;
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('groupDetailOverlay', 'friends');
    document.getElementById('groupDetailOverlay').classList.add('active');
    await this.renderGroupDetail();
  },

  async renderGroupDetail(){
    if (!groupDetailId) return;
    try{
      const groups = await Friends.getMyGroups();
      const group = groups.find(g => g.id === groupDetailId);
      if (!group){
        toast('This group no longer exists');
        this.closeGroupDetail();
        return;
      }
      document.getElementById('groupDetailTitle').textContent = group.name;
      document.getElementById('groupDetailInfo').textContent = `${group.memberCount} / ${group.maxMembers} members`;
      document.getElementById('btnDeleteGroup').style.display = group.isCreator ? '' : 'none';
      document.getElementById('groupInviteStatus').textContent = '';

      const members = await Friends.getGroupMembers(groupDetailId);
      document.getElementById('groupMembersList').innerHTML = members.map(m => `
        <div class="lineup-row">
          <span class="lineup-name">${escapeHtml(m.username)}${m.isCreator ? ' <span class="league-card-badge current">Creator</span>' : ''}</span>
          ${group.isCreator && !m.isCreator ? `<button class="lineup-delete" data-action="remove-member" data-user-id="${m.userId}">Remove</button>` : ''}
        </div>
      `).join('');

      const games = await Friends.getGroupGames(groupDetailId);
      const gamesEl = document.getElementById('groupGamesList');
      if (!games.length){
        gamesEl.innerHTML = `<div class="small-note">No games logged under this group's linked league/tournament yet. Link a league or tournament to this group (edit it and set its Group) for games to show up here.</div>`;
      } else {
        gamesEl.innerHTML = games.slice(0, 30).map(g => `
          <div class="league-detail-info-row">
            <span>${escapeHtml(g.username || 'Unknown')} — ${escapeHtml(fmtDateLong(g.date))}</span>
            <span style="margin-left:auto; font-weight:600;">${g.score}</span>
          </div>
        `).join('');
      }
    } catch(e){
      console.error('renderGroupDetail failed:', e);
      toast('Could not load group details — check your connection');
    }
  },

  closeGroupDetail(){
    document.getElementById('groupDetailOverlay').classList.remove('active');
    groupDetailId = null;
    if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('friends');
  },

  async inviteToGroup(){
    if (!groupDetailId) return;
    const input = document.getElementById('inputGroupInviteUsername');
    const status = document.getElementById('groupInviteStatus');
    const username = input.value.trim();
    if (!username){ toast('Enter a username to invite'); return; }
    status.textContent = 'Inviting…';
    try{
      const found = await Friends.inviteToGroupByUsername(groupDetailId, username);
      input.value = '';
      await this.renderGroupDetail(); // clears status as part of its own render, so the success message below must come AFTER this, not before
      document.getElementById('groupInviteStatus').textContent = `${found.username} added to the group.`;
      this.renderGroups();
    } catch(e){
      console.error('inviteToGroup failed:', e);
      status.textContent = e.message || 'Could not invite that user.';
    }
  }
};

// ---------- Leagues tab ----------
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const LeaguesUI = {
  editingId: null, // null while adding a new league; set to a league id while editing an existing one
  statusFilter: 'current', // 'current' | 'completed' | 'all' — which leagues show in the list

  render(){
    const el = document.getElementById('leaguesList');
    if (!el) return;
    const all = Store.settings.leagues;
    const leagues = all.filter(l => this.matchesStatusFilter(l));

    if (!all.length){
      el.innerHTML = `
        <div class="empty-state">
          <div class="pin up"></div>
          <p>No leagues set up yet. Add one to track its schedule, alley, and team details, and pick it quickly when logging games.</p>
        </div>
      `;
      return;
    }
    if (!leagues.length){
      const msg = this.statusFilter === 'current'
        ? 'No current leagues. Completed leagues are under the Completed tab above.'
        : 'No completed leagues yet.';
      el.innerHTML = `<div class="empty-state"><div class="pin down"></div><p>${msg}</p></div>`;
      return;
    }
    el.innerHTML = leagues.map(l => this.cardHTML(l)).join('');
    el.querySelectorAll('.league-card').forEach(card=>{
      card.addEventListener('click', ()=> openLeagueDetail(card.dataset.id));
    });
  },

  matchesStatusFilter(l){
    const completed = Store.isLeagueCompleted(l);
    if (this.statusFilter === 'current') return !completed;
    if (this.statusFilter === 'completed') return completed;
    return true; // 'all'
  },

  cardHTML(l){
    const alleyName = l.alleyId ? Store.alleyName(l.alleyId) : '';
    const scheduleStr = this.scheduleSummary(l);
    const seasonStr = this.seasonSummary(l);
    const completed = Store.isLeagueCompleted(l);
    const badge = completed
      ? `<span class="league-card-badge completed">Completed</span>`
      : (l.seasonStart || l.seasonEnd ? `<span class="league-card-badge current">Current</span>` : '');
    return `
      <div class="league-card ${completed?'completed':''}" data-id="${l.id}">
        <div class="league-card-name">${escapeHtml(l.name)}${badge}</div>
        ${l.teamName ? `<div class="league-card-row"><span class="icon">👥</span><span class="league-card-team">${escapeHtml(l.teamName)}</span>${l.teamSize?` · ${l.teamSize} bowlers`:''}</div>` : ''}
        ${scheduleStr ? `<div class="league-card-row"><span class="icon">📅</span>${scheduleStr}</div>` : ''}
        ${seasonStr ? `<div class="league-card-row"><span class="icon">🗓️</span>${seasonStr}</div>` : ''}
        ${alleyName ? `<div class="league-card-row"><span class="icon">📍</span>${escapeHtml(alleyName)}</div>` : ''}
        ${l.placement ? `<div class="league-card-row"><span class="icon">🏆</span><span class="league-card-placement">${escapeHtml(l.placement)}</span></div>` : ''}
      </div>
    `;
  },

  scheduleSummary(l){
    if (l.dayOfWeek==null || l.dayOfWeek==='') return '';
    const day = DAY_NAMES[parseInt(l.dayOfWeek)];
    const time = l.time ? this.formatTime(l.time) : '';
    return time ? `${day}s, ${time}` : `${day}s`;
  },
  seasonSummary(l){
    if (!l.seasonStart && !l.seasonEnd) return '';
    if (l.seasonStart && l.seasonEnd) return `${fmtDateShort(l.seasonStart)} – ${fmtDateShort(l.seasonEnd)}`;
    return l.seasonStart ? `Starts ${fmtDateShort(l.seasonStart)}` : `Ends ${fmtDateShort(l.seasonEnd)}`;
  },
  formatTime(hhmm){
    const [h,m] = hhmm.split(':').map(Number);
    const period = h>=12 ? 'PM':'AM';
    const h12 = ((h+11)%12)+1;
    return `${h12}:${String(m).padStart(2,'0')} ${period}`;
  },

  populateAlleySelect(){
    const sel = document.getElementById('inputLgAlley');
    if (!sel) return;
    sel.innerHTML = '<option value="">None selected</option>' +
      Store.settings.alleys.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  },

  openAdd(){
    this.editingId = null;
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('leagueSheetOverlay', 'leagues');
    document.getElementById('leagueSheetTitle').textContent = 'Add League';
    document.getElementById('inputLgName').value = '';
    document.getElementById('inputLgTeamName').value = '';
    document.getElementById('inputLgTeamSize').value = '';
    document.getElementById('inputLgSeasonStart').value = '';
    document.getElementById('inputLgSeasonEnd').value = '';
    document.getElementById('inputLgDay').value = '';
    document.getElementById('inputLgTime').value = '';
    document.getElementById('inputLgNotes').value = '';
    document.getElementById('inputLgPlacement').value = '';
    document.getElementById('inputLgPlacementNotes').value = '';
    this.populateAlleySelect();
    document.getElementById('inputLgAlley').value = '';
    document.getElementById('btnDeleteLeague').style.display = 'none';
    document.getElementById('btnLgAddToCalendar').style.display = 'none';
    // A brand-new league has no completion status or placement to show/edit yet —
    // those only become relevant once a league actually exists.
    document.getElementById('lgStatusBanner').style.display = 'none';
    document.getElementById('lgPlacementSection').style.display = 'none';
    document.getElementById('btnLgToggleCompleted').style.display = 'none';
    document.getElementById('leagueSheetOverlay').classList.add('active');
  },

  openEdit(id){
    const l = Store.leagueById(id);
    if (!l) return;
    this.editingId = id;
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('leagueSheetOverlay', 'leagues');
    document.getElementById('leagueSheetTitle').textContent = 'Edit League';
    document.getElementById('inputLgName').value = l.name || '';
    document.getElementById('inputLgTeamName').value = l.teamName || '';
    document.getElementById('inputLgTeamSize').value = l.teamSize || '';
    document.getElementById('inputLgSeasonStart').value = l.seasonStart || '';
    document.getElementById('inputLgSeasonEnd').value = l.seasonEnd || '';
    document.getElementById('inputLgDay').value = (l.dayOfWeek!=null && l.dayOfWeek!=='') ? String(l.dayOfWeek) : '';
    document.getElementById('inputLgTime').value = l.time || '';
    document.getElementById('inputLgNotes').value = l.notes || '';
    document.getElementById('inputLgPlacement').value = l.placement || '';
    document.getElementById('inputLgPlacementNotes').value = l.placementNotes || '';
    this.populateAlleySelect();
    document.getElementById('inputLgAlley').value = l.alleyId || '';
    document.getElementById('btnDeleteLeague').style.display = '';
    // Only offer calendar sync once there's enough info to build a recurring event from
    const canSync = l.dayOfWeek!=null && l.dayOfWeek!=='' && l.time && l.seasonStart && l.seasonEnd;
    document.getElementById('btnLgAddToCalendar').style.display = canSync ? '' : 'none';
    this.renderStatusUI(l);
    document.getElementById('leagueSheetOverlay').classList.add('active');
  },

  // Shows the current/completed banner, reveals placement fields once a league is completed,
  // and labels the manual toggle button appropriately in either direction.
  renderStatusUI(l){
    const completed = Store.isLeagueCompleted(l);
    const banner = document.getElementById('lgStatusBanner');
    const placementSection = document.getElementById('lgPlacementSection');
    const toggleBtn = document.getElementById('btnLgToggleCompleted');

    banner.style.display = 'flex';
    if (completed){
      banner.className = 'lg-status-banner is-completed';
      const autoNote = l.manuallyCompleted ? 'Marked completed manually.' : 'Season end date has passed.';
      banner.innerHTML = `<span>✓</span><span>This league is completed. ${autoNote}</span>`;
      placementSection.style.display = '';
    } else {
      banner.className = 'lg-status-banner is-current';
      banner.innerHTML = `<span>●</span><span>This league is current.</span>`;
      placementSection.style.display = 'none';
    }

    toggleBtn.style.display = '';
    if (l.manuallyCompleted){
      toggleBtn.textContent = 'Mark as Current Again';
    } else if (completed){
      // season end date already passed — nothing to "mark" manually, it's already completed by date
      toggleBtn.textContent = 'Reopen This League (Season Not Actually Over)';
    } else {
      toggleBtn.textContent = 'Mark as Completed Now';
    }
  },

  toggleCompleted(){
    if (!this.editingId) return;
    const l = Store.leagueById(this.editingId);
    if (!l) return;
    const completed = Store.isLeagueCompleted(l);
    if (l.manuallyCompleted){
      // undo a manual completion
      Store.updateLeague(this.editingId, { manuallyCompleted: false });
    } else if (completed){
      // date-based completion — "reopening" means pushing the season end date forward isn't
      // something we can guess, so instead we clear it and let the person set a new one if they want
      Store.updateLeague(this.editingId, { seasonEnd: '' });
      toast('Season end date cleared — set a new one if you want automatic completion again');
    } else {
      Store.updateLeague(this.editingId, { manuallyCompleted: true });
    }
    const updated = Store.leagueById(this.editingId);
    document.getElementById('inputLgSeasonEnd').value = updated.seasonEnd || '';
    this.renderStatusUI(updated);
    this.render();
  },

  close(){
    document.getElementById('leagueSheetOverlay').classList.remove('active');
    if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('leagues');
  },

  readForm(){
    const dayVal = document.getElementById('inputLgDay').value;
    return {
      name: document.getElementById('inputLgName').value.trim(),
      teamName: document.getElementById('inputLgTeamName').value.trim(),
      teamSize: document.getElementById('inputLgTeamSize').value ? parseInt(document.getElementById('inputLgTeamSize').value) : null,
      alleyId: document.getElementById('inputLgAlley').value || null,
      seasonStart: document.getElementById('inputLgSeasonStart').value || '',
      seasonEnd: document.getElementById('inputLgSeasonEnd').value || '',
      dayOfWeek: dayVal!=='' ? parseInt(dayVal) : null,
      time: document.getElementById('inputLgTime').value || '',
      notes: document.getElementById('inputLgNotes').value.trim(),
      placement: document.getElementById('inputLgPlacement').value.trim(),
      placementNotes: document.getElementById('inputLgPlacementNotes').value.trim()
    };
  },

  save(){
    const fields = this.readForm();
    if (!fields.name){ toast('Enter a league name'); return; }
    if (fields.seasonStart && fields.seasonEnd && fields.seasonStart > fields.seasonEnd){
      toast('Season end date is before the start date'); return;
    }

    if (this.editingId){
      Store.updateLeague(this.editingId, fields);
      toast('League updated');
    } else {
      const created = Store.addLeague(fields);
      if (!created){
        // Store.save() (called inside addLeague) already surfaced its own toast if this was a storage failure;
        // the only other reason addLeague returns null is a blank name, already caught above.
        return;
      }
      toast('League added');
    }
    this.close();
    this.render();
  },

  delete(){
    if (!this.editingId) return;
    if (confirm('Delete this league? Games already logged under it will keep their recorded league name but will no longer link to a live league profile.')){
      Store.removeLeague(this.editingId);
      this.close();
      this.render();
      toast('League deleted');
    }
  },

  // Build a recurring weekly calendar event spanning the league's season and hand it to the
  // phone's calendar app via a standard .ics file download — the universal way a web page can
  // create a calendar event without needing any app-specific integration or account access.
  addToCalendar(){
    const l = Store.leagueById(this.editingId);
    if (!l) return;
    if (l.dayOfWeek==null || l.dayOfWeek==='' || !l.time || !l.seasonStart || !l.seasonEnd){
      toast('Add a day, time, and season start/end first');
      return;
    }
    const ics = buildLeagueIcs(l);
    const blob = new Blob([ics], {type: 'text/calendar'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (l.name || 'league').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '-schedule.ics';
    a.click();
    URL.revokeObjectURL(url);
    toast('Calendar file downloaded — open it to add to your calendar');
  }
};

const TournamentsUI = {
  editingId: null,
  statusFilter: 'current',
  dateMode: 'single', // tracks the currently-selected chip in the open Add/Edit sheet

  render(){
    const el = document.getElementById('tournamentsList');
    if (!el) return;
    const all = Store.settings.tournaments;
    const tournaments = all.filter(t => this.matchesStatusFilter(t));

    if (!all.length){
      el.innerHTML = `
        <div class="empty-state">
          <div class="pin up"></div>
          <p>No tournaments added yet. Add one to track its dates, alley, and results, and log games against it separately from your regular sessions.</p>
        </div>
      `;
      return;
    }
    if (!tournaments.length){
      const msg = this.statusFilter === 'current'
        ? 'No upcoming or in-progress tournaments. Completed ones are under the Completed tab above.'
        : 'No completed tournaments yet.';
      el.innerHTML = `<div class="empty-state"><div class="pin down"></div><p>${msg}</p></div>`;
      return;
    }
    el.innerHTML = tournaments.map(t => this.cardHTML(t)).join('');
    el.querySelectorAll('.league-card').forEach(card=>{
      card.addEventListener('click', ()=> openTournamentDetail(card.dataset.id));
    });
  },

  matchesStatusFilter(t){
    const completed = Store.isTournamentCompleted(t);
    if (this.statusFilter === 'current') return !completed;
    if (this.statusFilter === 'completed') return completed;
    return true; // 'all'
  },

  // Reuses the .league-card visual style directly (same badges, same layout language) so
  // Tournaments feels like part of the same family as Leagues rather than a bolted-on system.
  cardHTML(t){
    const alleyName = t.alleyId ? Store.alleyName(t.alleyId) : '';
    const dateStr = this.dateSummary(t);
    const completed = Store.isTournamentCompleted(t);
    const badge = completed
      ? `<span class="league-card-badge completed">Completed</span>`
      : (dateStr ? `<span class="league-card-badge current">Current</span>` : '');
    return `
      <div class="league-card ${completed?'completed':''}" data-id="${t.id}">
        <div class="league-card-name">${escapeHtml(t.name)}${badge}</div>
        ${t.format ? `<div class="league-card-row"><span class="icon">🎳</span>${escapeHtml(t.format)}</div>` : ''}
        ${dateStr ? `<div class="league-card-row"><span class="icon">🗓️</span>${dateStr}</div>` : ''}
        ${alleyName ? `<div class="league-card-row"><span class="icon">📍</span>${escapeHtml(alleyName)}</div>` : ''}
        ${t.entryFee ? `<div class="league-card-row"><span class="icon">💵</span>${escapeHtml(t.entryFee)} entry</div>` : ''}
        ${t.placement ? `<div class="league-card-row"><span class="icon">🏆</span><span class="league-card-placement">${escapeHtml(t.placement)}</span></div>` : ''}
      </div>
    `;
  },

  dateSummary(t){
    if (t.dateMode === 'range'){
      if (!t.rangeStart && !t.rangeEnd) return '';
      if (t.rangeStart && t.rangeEnd) return `${fmtDateShort(t.rangeStart)} – ${fmtDateShort(t.rangeEnd)}`;
      return t.rangeStart ? `Starts ${fmtDateShort(t.rangeStart)}` : `Ends ${fmtDateShort(t.rangeEnd)}`;
    }
    return t.singleDate ? fmtDateShort(t.singleDate) : '';
  },

  populateAlleySelect(){
    const sel = document.getElementById('inputTnAlley');
    if (!sel) return;
    sel.innerHTML = '<option value="">None selected</option>' +
      Store.settings.alleys.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  },

  setDateMode(mode){
    this.dateMode = mode;
    document.querySelectorAll('#tournamentSheetOverlay [data-date-mode]').forEach(chip=>{
      chip.classList.toggle('selected', chip.dataset.dateMode === mode);
    });
    document.getElementById('tnSingleDateField').style.display = mode === 'single' ? '' : 'none';
    document.getElementById('tnRangeDateFields').style.display = mode === 'range' ? '' : 'none';
  },

  openAdd(){
    this.editingId = null;
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('tournamentSheetOverlay', 'tournaments');
    document.getElementById('tournamentSheetTitle').textContent = 'Add Tournament';
    document.getElementById('inputTnName').value = '';
    document.getElementById('inputTnFormat').value = '';
    document.getElementById('inputTnEntryFee').value = '';
    document.getElementById('inputTnSingleDate').value = '';
    document.getElementById('inputTnRangeStart').value = '';
    document.getElementById('inputTnRangeEnd').value = '';
    document.getElementById('inputTnNotes').value = '';
    document.getElementById('inputTnPlacement').value = '';
    document.getElementById('inputTnPlacementNotes').value = '';
    this.populateAlleySelect();
    document.getElementById('inputTnAlley').value = '';
    this.setDateMode('single');
    document.getElementById('btnDeleteTournament').style.display = 'none';
    // A brand-new tournament has no completion status or placement to show/edit yet.
    document.getElementById('tnStatusBanner').style.display = 'none';
    document.getElementById('tnPlacementSection').style.display = 'none';
    document.getElementById('btnTnToggleCompleted').style.display = 'none';
    document.getElementById('tournamentSheetOverlay').classList.add('active');
  },

  openEdit(id){
    const t = Store.tournamentById(id);
    if (!t) return;
    this.editingId = id;
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('tournamentSheetOverlay', 'tournaments');
    document.getElementById('tournamentSheetTitle').textContent = 'Edit Tournament';
    document.getElementById('inputTnName').value = t.name || '';
    document.getElementById('inputTnFormat').value = t.format || '';
    document.getElementById('inputTnEntryFee').value = t.entryFee || '';
    document.getElementById('inputTnSingleDate').value = t.singleDate || '';
    document.getElementById('inputTnRangeStart').value = t.rangeStart || '';
    document.getElementById('inputTnRangeEnd').value = t.rangeEnd || '';
    document.getElementById('inputTnNotes').value = t.notes || '';
    document.getElementById('inputTnPlacement').value = t.placement || '';
    document.getElementById('inputTnPlacementNotes').value = t.placementNotes || '';
    this.populateAlleySelect();
    document.getElementById('inputTnAlley').value = t.alleyId || '';
    this.setDateMode(t.dateMode || 'single');
    document.getElementById('btnDeleteTournament').style.display = '';
    this.renderStatusUI(t);
    document.getElementById('tournamentSheetOverlay').classList.add('active');
  },

  renderStatusUI(t){
    const completed = Store.isTournamentCompleted(t);
    const banner = document.getElementById('tnStatusBanner');
    const placementSection = document.getElementById('tnPlacementSection');
    const toggleBtn = document.getElementById('btnTnToggleCompleted');

    banner.style.display = 'flex';
    if (completed){
      banner.className = 'lg-status-banner is-completed';
      const autoNote = t.manuallyCompleted ? 'Marked completed manually.' : 'The date has passed.';
      banner.innerHTML = `<span>✓</span><span>This tournament is completed. ${autoNote}</span>`;
      placementSection.style.display = '';
    } else {
      banner.className = 'lg-status-banner is-current';
      banner.innerHTML = `<span>●</span><span>This tournament is upcoming or in progress.</span>`;
      placementSection.style.display = 'none';
    }

    toggleBtn.style.display = '';
    if (t.manuallyCompleted){
      toggleBtn.textContent = 'Mark as Current Again';
    } else if (completed){
      toggleBtn.textContent = 'Reopen This Tournament (Not Actually Over)';
    } else {
      toggleBtn.textContent = 'Mark as Completed Now';
    }
  },

  toggleCompleted(){
    if (!this.editingId) return;
    const t = Store.tournamentById(this.editingId);
    if (!t) return;
    const completed = Store.isTournamentCompleted(t);
    if (t.manuallyCompleted){
      Store.updateTournament(this.editingId, { manuallyCompleted: false });
    } else if (completed){
      // clear whichever date field was driving the auto-completion, same rationale as leagues:
      // we can't guess a new date, so just clear it and let the person set one if they want
      // automatic completion again
      if (t.dateMode === 'range'){
        Store.updateTournament(this.editingId, { rangeEnd: '' });
      } else {
        Store.updateTournament(this.editingId, { singleDate: '' });
      }
      toast('Date cleared — set a new one if you want automatic completion again');
    } else {
      Store.updateTournament(this.editingId, { manuallyCompleted: true });
    }
    const updated = Store.tournamentById(this.editingId);
    document.getElementById('inputTnSingleDate').value = updated.singleDate || '';
    document.getElementById('inputTnRangeEnd').value = updated.rangeEnd || '';
    this.renderStatusUI(updated);
    this.render();
  },

  close(){
    document.getElementById('tournamentSheetOverlay').classList.remove('active');
    if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('tournaments');
  },

  readForm(){
    return {
      name: document.getElementById('inputTnName').value.trim(),
      format: document.getElementById('inputTnFormat').value.trim(),
      entryFee: document.getElementById('inputTnEntryFee').value.trim(),
      alleyId: document.getElementById('inputTnAlley').value || null,
      dateMode: this.dateMode,
      singleDate: document.getElementById('inputTnSingleDate').value || '',
      rangeStart: document.getElementById('inputTnRangeStart').value || '',
      rangeEnd: document.getElementById('inputTnRangeEnd').value || '',
      notes: document.getElementById('inputTnNotes').value.trim(),
      placement: document.getElementById('inputTnPlacement').value.trim(),
      placementNotes: document.getElementById('inputTnPlacementNotes').value.trim()
    };
  },

  save(){
    const fields = this.readForm();
    if (!fields.name){ toast('Enter a tournament name'); return; }
    if (fields.dateMode === 'range' && fields.rangeStart && fields.rangeEnd && fields.rangeStart > fields.rangeEnd){
      toast('End date is before the start date'); return;
    }

    if (this.editingId){
      Store.updateTournament(this.editingId, fields);
      toast('Tournament updated');
    } else {
      const created = Store.addTournament(fields);
      if (!created){
        // Store.save() (called inside addTournament) already surfaced its own toast if this was
        // a storage failure; the only other reason addTournament returns null is a blank name,
        // already caught above.
        return;
      }
      toast('Tournament added');
    }
    this.close();
    this.render();
  },

  delete(){
    if (!this.editingId) return;
    if (confirm('Delete this tournament? Games already logged under it will remain in your history but will no longer link to a live tournament profile.')){
      Store.removeTournament(this.editingId);
      this.close();
      this.render();
      toast('Tournament deleted');
    }
  }
};

// Build a standard iCalendar (.ics) file with a single weekly-recurring event bounded by the
// league's season dates. This format is universally recognized by Android/Google Calendar,
// iOS/Apple Calendar, and Outlook — opening the downloaded file hands it straight to whichever
// calendar app the phone has set as default, with no API keys or account connection needed.
function buildLeagueIcs(league){
  const dayCodes = ['SU','MO','TU','WE','TH','FR','SA'];
  const untilDate = league.seasonEnd.replace(/-/g,'') + 'T235959Z';

  // Find the first occurrence of the league's weekday on/after the season start date
  const [time_h, time_m] = league.time.split(':').map(Number);
  let firstDate = new Date(league.seasonStart + 'T00:00:00');
  const targetDay = parseInt(league.dayOfWeek);
  while (firstDate.getDay() !== targetDay){
    firstDate.setDate(firstDate.getDate()+1);
  }
  const pad = n => String(n).padStart(2,'0');
  const dtStart = `${firstDate.getFullYear()}${pad(firstDate.getMonth()+1)}${pad(firstDate.getDate())}T${pad(time_h)}${pad(time_m)}00`;
  // default 2-hour block per session (typical league night length); adjustable by the person afterward in their calendar app
  const endDate = new Date(firstDate);
  endDate.setHours(time_h+2, time_m);
  const dtEnd = `${endDate.getFullYear()}${pad(endDate.getMonth()+1)}${pad(endDate.getDate())}T${pad(endDate.getHours())}${pad(time_m)}00`;

  const alleyName = league.alleyId ? Store.alleyName(league.alleyId) : '';
  const descParts = [];
  if (league.teamName) descParts.push('Team: ' + league.teamName);
  if (league.teamSize) descParts.push('Team size: ' + league.teamSize);
  if (league.notes) descParts.push(league.notes);

  const escapeIcs = s => String(s).replace(/[\\;,]/g, m=>'\\'+m).replace(/\n/g,'\\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pinboard//Bowling Tracker//EN',
    'BEGIN:VEVENT',
    'UID:' + league.id + '@pinboard',
    'DTSTART:' + dtStart,
    'DTEND:' + dtEnd,
    'RRULE:FREQ=WEEKLY;UNTIL=' + untilDate,
    'SUMMARY:' + escapeIcs(league.name + ' League'),
    descParts.length ? 'DESCRIPTION:' + escapeIcs(descParts.join(' — ')) : '',
    alleyName ? 'LOCATION:' + escapeIcs(alleyName) : '',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

// ---------- Shared Pin Keypad ----------
// A custom on-screen keypad for entering frame-by-frame ball results, used by both AddSheet and
// TnGameSheet in place of native text inputs — the phone's numeric keyboard has no way to enter
// a strike or spare, which was the actual problem this replaces. Rather than parsing typed
// characters like "X" or "/", this presents only the choices that are actually legal for the
// specific ball being entered (e.g. Spare is disabled unless there's already a valid, non-strike
// first ball to complete), which also makes entering an impossible score impossible.
// Renders a ball slot's stored pin value using standard bowling scoresheet notation — X for a
// strike, / for a spare (a second or third ball that completes a prior ball's remaining pins to
// exactly 10), or the plain number otherwise. Shared by both game-logging forms' frame grids.
function ballSlotLabel(frames, frameIdx, ballKey){
  const f = frames[frameIdx];
  const val = f['b'+ballKey];
  if (val == null) return '';
  if (val === 10 && (ballKey === '1' || (frameIdx === 9 && ballKey !== '1' && wasFreshRackFor(frames, frameIdx, ballKey)))){
    return 'X';
  }
  // Spare: this ball plus the immediately preceding ball in the same frame sum to exactly 10,
  // and the preceding ball wasn't itself a strike (which would mean this is a fresh rack, not a spare).
  if (ballKey === '2' && f.b1 != null && f.b1 !== 10 && (f.b1+val)===10) return '/';
  if (frameIdx === 9 && ballKey === '3' && f.b2 != null && f.b2 !== 10 && f.b1 === 10 && (f.b2+val)===10) return '/';
  if (frameIdx === 9 && ballKey === '3' && f.b2 != null && f.b1 !== 10 && (f.b1+f.b2)===10 && (f.b2+val)!==10) return String(val);
  return String(val);
}

// Helper for ballSlotLabel: in the 10th frame, a ball after the first can still legitimately be
// a fresh 10-pin rack (shown as X) rather than a spare, specifically when the prior ball(s) in
// that frame already completed a strike or spare, resetting the pins.
function wasFreshRackFor(frames, frameIdx, ballKey){
  const f = frames[frameIdx];
  if (ballKey === '2') return f.b1 === 10;
  if (ballKey === '3') return f.b2 === 10 || (f.b1 !== 10 && (f.b1+f.b2) === 10) || (f.b1 === 10 && f.b2 === 10);
  return false;
}

const PinKeypad = {
  frames: null,      // the specific game entry's frames array being edited
  frameIdx: null,     // 0-9
  ballKey: null,      // 'b1' | 'b2' | 'b3'
  onChange: null,     // callback invoked after any value change, so the caller can update its own total display

  // Opens the keypad for one specific ball slot. `frames` is the entry's frames array (mutated
  // directly), frameIdx/ballKey identify which slot, and onChange is called with no arguments
  // after every edit so the caller can refresh its own total/UI.
  open(frames, frameIdx, ballKey, onChange){
    this.frames = frames;
    this.frameIdx = frameIdx;
    this.ballKey = ballKey;
    this.onChange = onChange;
    this.render();
    document.getElementById('pinKeypadOverlay').classList.add('active');
  },

  close(){
    document.getElementById('pinKeypadOverlay').classList.remove('active');
    this.frames = null;
  },

  currentFrame(){
    return this.frames ? this.frames[this.frameIdx] : null;
  },

  // First ball of frames 1-9, or the 10th frame's first ball, can always be a strike (0-10, or X).
  // Second ball can be a strike ONLY in the 10th frame after a first-ball strike (a fresh rack).
  // The 10th frame's third ball is only reachable at all after a strike or spare already opened it.
  isStrikeAllowed(){
    const f = this.currentFrame();
    if (this.ballKey === 'b1') return true;
    if (this.frameIdx === 9){
      if (this.ballKey === 'b2') return f.b1 === 10; // fresh rack after a strike
      if (this.ballKey === 'b3') return (f.b1 === 10 && (f.b2 === 10 || (f.b1+f.b2)===10)) || (f.b1!==10 && (f.b1+f.b2)===10);
    }
    return false;
  },

  // Spare only makes sense as a second ball completing a non-strike first ball (frames 1-9), or
  // in the 10th frame when the current ball is completing a two-ball total of 10 against a fresh
  // (non-strike) first ball, or completing a spare-then-fill situation on ball 3.
  isSpareAllowed(){
    const f = this.currentFrame();
    if (this.frameIdx < 9){
      return this.ballKey === 'b2' && f.b1 != null && f.b1 !== 10;
    }
    // 10th frame
    if (this.ballKey === 'b2') return f.b1 != null && f.b1 !== 10;
    if (this.ballKey === 'b3'){
      // only meaningful if b1+b2 doesn't already sum past 10 in a way a spare wouldn't fit,
      // i.e. after a strike-then-non-strike ball 2, a spare on ball 3 completes that pair
      return f.b1 === 10 && f.b2 != null && f.b2 !== 10;
    }
    return false;
  },

  // Max pins selectable by number for the current ball, given what's already been entered —
  // e.g. if ball 1 was a 6, ball 2 can be at most 4 as a plain number (a full 10 there would be
  // entered via the Spare button instead, not as a raw "4" — this just bounds the numeric grid).
  maxForCurrentBall(){
    const f = this.currentFrame();
    if (this.frameIdx < 9){
      if (this.ballKey === 'b1') return 9; // 10 there is only reachable via Strike
      return f.b1 != null ? Math.max(0, 9 - f.b1) : 9; // leave 10-f.b1 reachable only via Spare
    }
    // 10th frame is more permissive since strikes/spares can reset the rack
    if (this.ballKey === 'b1') return 9;
    if (this.ballKey === 'b2'){
      if (f.b1 === 10) return 9; // fresh rack after a strike; 10 reachable via Strike button
      return f.b1 != null ? Math.max(0, 9 - f.b1) : 9;
    }
    // ball 3
    if (f.b1 === 10 && f.b2 === 10) return 9; // two strikes already; another fresh rack
    if (f.b1 === 10 && f.b2 != null) return Math.max(0, 9 - f.b2);
    if (f.b1 !== 10 && f.b1 != null && f.b2 != null && (f.b1+f.b2)===10) return 9; // spare already made; fresh rack
    return 9;
  },

  render(){
    const f = this.currentFrame();
    if (!f) return;
    const frameLabel = this.frameIdx === 9 ? 'Frame 10' : `Frame ${this.frameIdx+1}`;
    const ballLabel = this.ballKey === 'b1' ? 'Ball 1' : (this.ballKey === 'b2' ? 'Ball 2' : 'Ball 3');
    document.getElementById('pinKeypadFrameLabel').textContent = `${frameLabel}, ${ballLabel}`;

    const currentVal = f[this.ballKey];
    const isStrikeVal = currentVal === 10 && this.isStrikeAllowed();
    // "remaining" hint: how many pins are left standing going into this ball, when that's a
    // meaningful concept (i.e. this is a second/third ball completing a rack) — purely informational.
    let remainingText = '';
    if (this.ballKey === 'b2' && this.frameIdx < 9 && f.b1 != null && f.b1 !== 10){
      remainingText = (10 - f.b1) + ' pins standing';
    }
    document.getElementById('pinKeypadRemaining').textContent = remainingText;

    const maxNum = this.maxForCurrentBall();
    const numberGrid = document.getElementById('pinKeypadNumberGrid');
    let html = '';
    for (let n=0; n<=9; n++){
      const disabled = n > maxNum;
      const selected = (!isStrikeVal && currentVal === n);
      html += `<button type="button" class="pin-keypad-num-btn ${selected?'selected':''}" data-pin-num="${n}" ${disabled?'disabled':''}>${n}</button>`;
    }
    numberGrid.innerHTML = html;
    numberGrid.querySelectorAll('[data-pin-num]').forEach(btn=>{
      btn.addEventListener('click', ()=> this.setValue(parseInt(btn.dataset.pinNum)));
    });

    const strikeBtn = document.getElementById('btnPinStrike');
    const spareBtn = document.getElementById('btnPinSpare');
    const strikeAllowed = this.isStrikeAllowed();
    const spareAllowed = this.isSpareAllowed();
    strikeBtn.disabled = !strikeAllowed;
    strikeBtn.classList.toggle('selected', strikeAllowed && currentVal === 10);
    spareBtn.disabled = !spareAllowed;
    // A spare's stored value is derived (10 - first ball), so "selected" means the completed
    // pair actually sums to 10 via a non-strike first ball.
    const spareSelected = spareAllowed && currentVal != null && (
      (this.ballKey === 'b2' && f.b1 != null && (f.b1 + currentVal) === 10) ||
      (this.ballKey === 'b3' && f.b2 != null && (f.b2 + currentVal) === 10)
    );
    spareBtn.classList.toggle('selected', spareSelected);
  },

  setValue(n){
    const f = this.currentFrame();
    f[this.ballKey] = n;
    this.render();
    if (this.onChange) this.onChange();
  },

  setStrike(){
    if (!this.isStrikeAllowed()) return;
    this.setValue(10);
  },

  setSpare(){
    if (!this.isSpareAllowed()) return;
    const f = this.currentFrame();
    if (this.ballKey === 'b2'){
      this.setValue(Math.max(0, 10 - (f.b1||0)));
    } else if (this.ballKey === 'b3'){
      this.setValue(Math.max(0, 10 - (f.b2||0)));
    }
  },

  clear(){
    this.setValue(null);
  }
};

const AddSheet = {
  frameMode: false,        // shared across all games in the session (simple vs frame-by-frame entry)
  gamesCount: 1,           // how many games in this logging session
  entries: [],             // one entry per game: { score: number|null, frames: [...] }
  scanTargetIndex: 0,      // which game entry a photo scan result should populate

  open(){
    document.getElementById('inputDate').value = new Date().toISOString().slice(0,10);
    document.getElementById('inputNotes').value = '';
    document.getElementById('inputLaneCondition').value = '';
    this.setContext('league');
    this.frameMode = false;
    document.getElementById('toggleFrameMode').textContent = 'Enter frame-by-frame instead';
    this.hideReviewBanner();
    this.populateBallPicker();
    this.populateAlleyPicker();
    this.populateLeagueSelect();
    this.setGamesCount(1);
    document.getElementById('addSheetOverlay').classList.add('active');
    // Runs after the league-based alley auto-fill above, so a confident location match takes
    // precedence — you're more likely at whatever alley you're physically standing in right now
    // than at a league's usual alley if the two ever disagree (e.g. a makeup game elsewhere).
    if (typeof AlleyDetect !== 'undefined') AlleyDetect.detectAndApply();
  },
  close(){
    document.getElementById('addSheetOverlay').classList.remove('active');
  },
  populateBallPicker(){
    const sel = document.getElementById('inputBall');
    if (!sel) return; // defensive: guards against a stale cached HTML missing this element
    sel.innerHTML = '<option value="">None selected</option>' +
      Store.settings.balls.map(b => `<option value="${b.id}">${escapeHtml(Store.ballName(b.id))}</option>`).join('');
    sel.value = Store.settings.defaultBallId || '';
  },
  populateAlleyPicker(){
    const sel = document.getElementById('inputAlley');
    if (!sel) return;
    sel.innerHTML = '<option value="">None selected</option>' +
      Store.settings.alleys.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  },
  populateLeagueSelect(){
    const sel = document.getElementById('inputLeagueSelect');
    if (!sel) return;
    const leagues = Store.settings.leagues;
    sel.innerHTML = '<option value="">No league selected</option>' +
      leagues.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    // default to the most recently used league, if any, for quicker repeat entry
    const lastId = Store.settings.lastLeagueId;
    if (lastId && leagues.some(l=>l.id===lastId)){
      sel.value = lastId;
      this.applyLeagueDefaults(lastId);
    }
  },
  // When a league is chosen, auto-fill its associated alley (still editable per game).
  applyLeagueDefaults(leagueId){
    const league = Store.leagueById(leagueId);
    const alleySel = document.getElementById('inputAlley');
    if (league && league.alleyId && alleySel){
      alleySel.value = league.alleyId;
    }
  },
  setContext(val){
    document.getElementById('chipLeague').classList.toggle('selected', val==='league');
    document.getElementById('chipOpen').classList.toggle('selected', val==='open');
    this.context = val;
  },

  // ---- Games-played stepper ----
  setGamesCount(n){
    n = Math.max(1, Math.min(10, n));
    const growing = n > this.entries.length;
    this.gamesCount = n;
    // preserve any scores/frames already entered for games that still exist after a count change
    while (this.entries.length < n){
      this.entries.push({ score: null, frames: this.blankFrames() });
    }
    this.entries.length = n;
    document.getElementById('gamesCountDisplay').textContent = String(n);
    document.getElementById('btnGamesDown').disabled = (n<=1);
    document.getElementById('btnGamesUp').disabled = (n>=10);
    this.renderEntries();
  },
  blankFrames(){
    return new Array(10).fill(null).map(()=>({b1:null,b2:null,b3:null}));
  },

  // ---- Rendering per-game entry cards ----
  renderEntries(){
    const container = document.getElementById('gameEntriesContainer');
    if (!container) return;
    container.innerHTML = this.entries.map((entry, idx)=>{
      const cardLabel = this.entries.length > 1 ? `Game ${idx+1}` : 'Score';
      const scanLink = this.entries.length > 1
        ? `<button type="button" class="game-entry-scan-btn" data-scan-idx="${idx}">Scan this game</button>`
        : '';
      const body = this.frameMode ? this.frameGridHTML(idx, entry) : this.simpleScoreHTML(idx, entry);
      return `
        <div class="game-entry-card" data-idx="${idx}">
          <div class="game-entry-card-label"><span>${cardLabel}</span>${scanLink}</div>
          ${body}
        </div>
      `;
    }).join('');

    // wire simple score inputs
    container.querySelectorAll('.entry-score-input').forEach(inp=>{
      inp.addEventListener('input', (e)=>{
        const idx = parseInt(e.target.dataset.idx);
        const v = parseInt(e.target.value);
        this.entries[idx].score = isNaN(v) ? null : v;
      });
    });

    // wire frame ball slots to open the shared pin keypad instead of the native keyboard
    container.querySelectorAll('.frame-balls button.ball-slot').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const idx = parseInt(btn.dataset.idx);
        const f = parseInt(btn.dataset.f), b = btn.dataset.b;
        const frames = this.entries[idx].frames;
        PinKeypad.open(frames, f, 'b'+b, ()=>{
          this.updateFrameTotal(idx);
          this.refreshBallSlotLabels(idx);
        });
      });
    });

    // wire per-card scan links (only present when multiple games)
    container.querySelectorAll('[data-scan-idx]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        this.scanTargetIndex = parseInt(btn.dataset.scanIdx);
        const label = document.getElementById('scanBtnLabel');
        if (label) label.textContent = `Scan photo for Game ${this.scanTargetIndex+1}`;
        document.getElementById('scanFileInput').click();
      });
    });

    this.entries.forEach((_, idx)=> this.updateFrameTotal(idx));
  },

  simpleScoreHTML(idx, entry){
    return `<input type="number" class="big-score-input entry-score-input" data-idx="${idx}" min="0" max="300" placeholder="0" value="${entry.score!=null?entry.score:''}" />`;
  },

  // Re-renders just the ball-slot button labels for one game entry after a keypad edit — avoids
  // rebuilding the whole entries container (and losing focus/scroll position) for a single change.
  refreshBallSlotLabels(idx){
    const entry = this.entries[idx];
    if (!entry) return;
    document.querySelectorAll(`.frame-balls button.ball-slot[data-idx="${idx}"]`).forEach(btn=>{
      const f = parseInt(btn.dataset.f), b = btn.dataset.b;
      const val = entry.frames[f]['b'+b];
      btn.textContent = ballSlotLabel(entry.frames, f, b);
      btn.classList.toggle('filled', val != null);
    });
  },

  frameGridHTML(idx, entry){
    const frames = entry.frames;
    return `
      <div class="frame-grid">${frames.slice(0,9).map((f,i)=>`
        <div class="frame-cell">
          <span class="frame-num">F${i+1}</span>
          <div class="frame-balls">
            <button type="button" class="ball-slot ${f.b1!=null?'filled':''}" data-idx="${idx}" data-f="${i}" data-b="1">${ballSlotLabel(frames,i,'1')}</button>
            <button type="button" class="ball-slot ${f.b2!=null?'filled':''}" data-idx="${idx}" data-f="${i}" data-b="2">${ballSlotLabel(frames,i,'2')}</button>
          </div>
        </div>
      `).join('')}</div>
      <div class="frame-grid" style="grid-template-columns: 1fr;">
        <div class="frame-cell">
          <span class="frame-num">Frame 10 (up to 3 balls)</span>
          <div class="frame-balls">
            <button type="button" class="ball-slot ${frames[9].b1!=null?'filled':''}" data-idx="${idx}" data-f="9" data-b="1">${ballSlotLabel(frames,9,'1')}</button>
            <button type="button" class="ball-slot ${frames[9].b2!=null?'filled':''}" data-idx="${idx}" data-f="9" data-b="2">${ballSlotLabel(frames,9,'2')}</button>
            <button type="button" class="ball-slot ${frames[9].b3!=null?'filled':''}" data-idx="${idx}" data-f="9" data-b="3">${ballSlotLabel(frames,9,'3')}</button>
          </div>
          <span class="frame-total" data-total-idx="${idx}">Total: 0</span>
        </div>
      </div>
    `;
  },

  updateFrameTotal(idx){
    if (!this.frameMode) return;
    const entry = this.entries[idx];
    if (!entry) return;
    const validFrames = entry.frames.map(f=> f.b1==null ? {b1:0,b2:0,b3:0} : f);
    const {total} = scoreFrames(validFrames);
    entry.score = total;
    const disp = document.querySelector(`[data-total-idx="${idx}"]`);
    if (disp) disp.textContent = 'Total: ' + total;
  },

  toggleMode(){
    this.frameMode = !this.frameMode;
    document.getElementById('toggleFrameMode').textContent = this.frameMode ? 'Enter total score instead' : 'Enter frame-by-frame instead';
    this.renderEntries();
  },

  // Populate one game entry (by scanTargetIndex, or entry 0 for a single-game session) from a
  // ScoreScan result. Prefers frame-by-frame when the scan returned usable per-frame data;
  // falls back to total-only otherwise.
  applyScanResult(result){
    if (result.date){
      document.getElementById('inputDate').value = result.date;
    }
    const idx = this.scanTargetIndex || 0;
    if (!this.entries[idx]) return;

    if (Array.isArray(result.frames) && result.frames.length === 10){
      this.frameMode = true;
      document.getElementById('toggleFrameMode').textContent = 'Enter total score instead';
      this.entries[idx].frames = result.frames.map(f => ({
        b1: normalizePinCount(f.b1),
        b2: normalizePinCount(f.b2),
        b3: normalizePinCount(f.b3)
      }));
      this.renderEntries();
    } else if (typeof result.total === 'number'){
      this.entries[idx].score = result.total;
      this.renderEntries();
    }
    this.showReviewBanner();
    // reset scan targeting + label back to the default for next use
    this.scanTargetIndex = 0;
    const label = document.getElementById('scanBtnLabel');
    if (label) label.textContent = 'Scan score from photo';
  },

  showReviewBanner(){
    let banner = document.getElementById('scanReviewBanner');
    if (!banner){
      banner = document.createElement('div');
      banner.id = 'scanReviewBanner';
      banner.className = 'scan-review-banner';
      banner.innerHTML = `<span>✓</span><span>Scanned — please check each frame against your monitor before saving.</span>`;
      const title = document.querySelector('#addSheetOverlay .sheet-title');
      title.insertAdjacentElement('afterend', banner);
    }
    banner.style.display = 'flex';
  },
  hideReviewBanner(){
    const banner = document.getElementById('scanReviewBanner');
    if (banner) banner.style.display = 'none';
  },

  save(){
    const date = document.getElementById('inputDate').value;
    const leagueSel = document.getElementById('inputLeagueSelect');
    const leagueId = leagueSel ? (leagueSel.value || null) : null;
    const league = leagueId ? Store.leagueById(leagueId) : null;
    const notes = document.getElementById('inputNotes').value.trim();
    const ballSel = document.getElementById('inputBall');
    const alleySel = document.getElementById('inputAlley');
    const ballId = ballSel ? (ballSel.value || null) : null;
    const alleyId = alleySel ? (alleySel.value || null) : null;
    const laneConditionSel = document.getElementById('inputLaneCondition');
    const laneCondition = laneConditionSel ? (laneConditionSel.value || null) : null;

    if (!date){ toast('Pick a date'); return; }

    // Validate every game entry before saving any of them, so a bad game further down
    // the list doesn't leave the session half-saved.
    for (let i=0; i<this.entries.length; i++){
      const score = this.entries[i].score;
      if (score==null || isNaN(score) || score<0 || score>300){
        toast(this.entries.length>1 ? `Enter a valid score for Game ${i+1} (0–300)` : 'Enter a valid score (0–300)');
        return;
      }
    }

    const savedGames = [];
    for (let i=0; i<this.entries.length; i++){
      const entry = this.entries[i];
      const frames = this.frameMode ? entry.frames : null;
      const saved = Store.addGame({
        date, context: this.context,
        leagueId: this.context==='league' ? leagueId : null,
        leagueName: this.context==='league' && league ? league.name : '', // denormalized snapshot for display/back-compat
        score: entry.score, frames, notes, ballId, alleyId, laneCondition
      });
      if (!saved){
        // Store.save() already surfaced a toast explaining why (e.g. running from file://).
        // Stop here rather than continuing to add further games that also won't persist.
        return;
      }
      savedGames.push(entry.score);
    }

    if (this.context==='league' && leagueId){
      Store.settings.lastLeagueId = leagueId;
      Store.save();
    }
    this.close();
    toast(savedGames.length>1
      ? `${savedGames.length} games saved — ${savedGames.join(', ')}`
      : `Game saved — ${savedGames[0]}`);
    Render.all();
  }
};

// ---------- Tournament Game Logging Sheet ----------
// A dedicated logging form for tournament games, separate from the main Add Game sheet's
// League/Open toggle. The entry-rendering and frame-scoring logic here mirrors AddSheet's
// intentionally (same scoring math via the shared scoreFrames() function, same multi-game/
// frame-by-frame UX) but targets its own container/input IDs, since AddSheet's methods are
// wired directly to its own hardcoded element IDs rather than being parameterized.
const TnGameSheet = {
  frameMode: false,
  gamesCount: 1,
  entries: [],

  open(){
    if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('tnGameSheetOverlay', 'tournaments');
    document.getElementById('inputTnGameDate').value = new Date().toISOString().slice(0,10);
    document.getElementById('inputTnGameNotes').value = '';
    document.getElementById('inputTnGameLaneCondition').value = '';
    this.frameMode = false;
    document.getElementById('toggleTnFrameMode').textContent = 'Enter frame-by-frame instead';
    this.populateBallPicker();
    this.populateTournamentPicker();
    this.setGamesCount(1);
    document.getElementById('tnGameSheetOverlay').classList.add('active');
  },
  close(){
    document.getElementById('tnGameSheetOverlay').classList.remove('active');
    if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('tournaments');
  },

  populateBallPicker(){
    const sel = document.getElementById('inputTnGameBall');
    if (!sel) return;
    sel.innerHTML = '<option value="">None selected</option>' +
      Store.settings.balls.map(b => `<option value="${b.id}">${escapeHtml(Store.ballName(b.id))}</option>`).join('');
    sel.value = Store.settings.defaultBallId || '';
  },

  // Only current (not-yet-completed) tournaments are offered by default, since logging a game
  // against a tournament that's already been marked done would be an unusual, likely-mistaken
  // action — but if there genuinely are no current ones, fall back to showing all of them
  // rather than presenting an empty, unusable dropdown.
  populateTournamentPicker(){
    const sel = document.getElementById('inputTnGameTournament');
    if (!sel) return;
    const all = Store.settings.tournaments;
    let options = all.filter(t => !Store.isTournamentCompleted(t));
    if (!options.length) options = all;
    sel.innerHTML = '<option value="">Select a tournament</option>' +
      options.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  },

  // When a tournament is chosen, auto-fill its associated alley info by piggybacking on the
  // tournament's own alley — there's no separate alley picker in this sheet since a tournament
  // already has one place; games logged here are assumed to be at that same alley.
  selectedTournamentAlleyId(){
    const sel = document.getElementById('inputTnGameTournament');
    if (!sel || !sel.value) return null;
    const t = Store.tournamentById(sel.value);
    return t ? t.alleyId : null;
  },

  setGamesCount(n){
    n = Math.max(1, Math.min(10, n));
    this.gamesCount = n;
    while (this.entries.length < n){
      this.entries.push({ score: null, frames: this.blankFrames() });
    }
    this.entries.length = n;
    document.getElementById('tnGamesCountDisplay').textContent = String(n);
    document.getElementById('btnTnGamesDown').disabled = (n<=1);
    document.getElementById('btnTnGamesUp').disabled = (n>=10);
    this.renderEntries();
  },
  blankFrames(){
    return new Array(10).fill(null).map(()=>({b1:null,b2:null,b3:null}));
  },

  renderEntries(){
    const container = document.getElementById('tnGameEntriesContainer');
    if (!container) return;
    container.innerHTML = this.entries.map((entry, idx)=>{
      const cardLabel = this.entries.length > 1 ? `Game ${idx+1}` : 'Score';
      const body = this.frameMode ? this.frameGridHTML(idx, entry) : this.simpleScoreHTML(idx, entry);
      return `
        <div class="game-entry-card" data-idx="${idx}">
          <div class="game-entry-card-label"><span>${cardLabel}</span></div>
          ${body}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.entry-score-input').forEach(inp=>{
      inp.addEventListener('input', (e)=>{
        const idx = parseInt(e.target.dataset.idx);
        const v = parseInt(e.target.value);
        this.entries[idx].score = isNaN(v) ? null : v;
      });
    });

    container.querySelectorAll('.frame-balls button.ball-slot').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const idx = parseInt(btn.dataset.idx);
        const f = parseInt(btn.dataset.f), b = btn.dataset.b;
        const frames = this.entries[idx].frames;
        PinKeypad.open(frames, f, 'b'+b, ()=>{
          this.updateFrameTotal(idx);
          this.refreshBallSlotLabels(idx);
        });
      });
    });

    this.entries.forEach((_, idx)=> this.updateFrameTotal(idx));
  },

  simpleScoreHTML(idx, entry){
    return `<input type="number" class="big-score-input entry-score-input" data-idx="${idx}" min="0" max="300" placeholder="0" value="${entry.score!=null?entry.score:''}" />`;
  },

  refreshBallSlotLabels(idx){
    const entry = this.entries[idx];
    if (!entry) return;
    document.querySelectorAll(`#tnGameEntriesContainer .frame-balls button.ball-slot[data-idx="${idx}"]`).forEach(btn=>{
      const f = parseInt(btn.dataset.f), b = btn.dataset.b;
      const val = entry.frames[f]['b'+b];
      btn.textContent = ballSlotLabel(entry.frames, f, b);
      btn.classList.toggle('filled', val != null);
    });
  },

  frameGridHTML(idx, entry){
    const frames = entry.frames;
    return `
      <div class="frame-grid">${frames.slice(0,9).map((f,i)=>`
        <div class="frame-cell">
          <span class="frame-num">F${i+1}</span>
          <div class="frame-balls">
            <button type="button" class="ball-slot ${f.b1!=null?'filled':''}" data-idx="${idx}" data-f="${i}" data-b="1">${ballSlotLabel(frames,i,'1')}</button>
            <button type="button" class="ball-slot ${f.b2!=null?'filled':''}" data-idx="${idx}" data-f="${i}" data-b="2">${ballSlotLabel(frames,i,'2')}</button>
          </div>
        </div>
      `).join('')}</div>
      <div class="frame-grid" style="grid-template-columns: 1fr;">
        <div class="frame-cell">
          <span class="frame-num">Frame 10 (up to 3 balls)</span>
          <div class="frame-balls">
            <button type="button" class="ball-slot ${frames[9].b1!=null?'filled':''}" data-idx="${idx}" data-f="9" data-b="1">${ballSlotLabel(frames,9,'1')}</button>
            <button type="button" class="ball-slot ${frames[9].b2!=null?'filled':''}" data-idx="${idx}" data-f="9" data-b="2">${ballSlotLabel(frames,9,'2')}</button>
            <button type="button" class="ball-slot ${frames[9].b3!=null?'filled':''}" data-idx="${idx}" data-f="9" data-b="3">${ballSlotLabel(frames,9,'3')}</button>
          </div>
          <span class="frame-total" data-total-idx="${idx}">Total: 0</span>
        </div>
      </div>
    `;
  },

  updateFrameTotal(idx){
    if (!this.frameMode) return;
    const entry = this.entries[idx];
    if (!entry) return;
    const validFrames = entry.frames.map(f=> f.b1==null ? {b1:0,b2:0,b3:0} : f);
    const {total} = scoreFrames(validFrames);
    entry.score = total;
    const disp = document.querySelector(`#tnGameEntriesContainer [data-total-idx="${idx}"]`);
    if (disp) disp.textContent = 'Total: ' + total;
  },

  toggleMode(){
    this.frameMode = !this.frameMode;
    document.getElementById('toggleTnFrameMode').textContent = this.frameMode ? 'Enter total score instead' : 'Enter frame-by-frame instead';
    this.renderEntries();
  },

  save(){
    const tournamentId = document.getElementById('inputTnGameTournament').value || null;
    const date = document.getElementById('inputTnGameDate').value;
    const ballId = document.getElementById('inputTnGameBall').value || null;
    const laneCondition = document.getElementById('inputTnGameLaneCondition').value || null;
    const notes = document.getElementById('inputTnGameNotes').value.trim();

    if (!tournamentId){ toast('Select a tournament'); return; }
    if (!date){ toast('Pick a date'); return; }

    for (let i=0; i<this.entries.length; i++){
      const score = this.entries[i].score;
      if (score==null || isNaN(score) || score<0 || score>300){
        toast(this.entries.length>1 ? `Enter a valid score for Game ${i+1} (0–300)` : 'Enter a valid score (0–300)');
        return;
      }
    }

    const alleyId = this.selectedTournamentAlleyId();
    const savedGames = [];
    for (let i=0; i<this.entries.length; i++){
      const entry = this.entries[i];
      const frames = this.frameMode ? entry.frames : null;
      const saved = Store.addGame({
        date, context: 'tournament', tournamentId,
        leagueId: null, leagueName: '',
        score: entry.score, frames, notes, ballId, alleyId, laneCondition
      });
      if (!saved){
        // Store.save() already surfaced a toast explaining why (e.g. running from file://).
        return;
      }
      savedGames.push(entry.score);
    }

    this.close();
    toast(savedGames.length>1
      ? `${savedGames.length} tournament games saved — ${savedGames.join(', ')}`
      : `Tournament game saved — ${savedGames[0]}`);
    Render.all();
  }
};

// ---------- Detail Sheet ----------
let detailGameId = null;
function openDetail(id){
  const g = Store.games.find(x=>x.id===id);
  if (!g) return;
  detailGameId = id;
  // This sheet is reachable from several pages (Home, History, and from within Ball/League/
  // Tournament detail's own history lists) — relocate to whichever page is actually active
  // right now rather than assuming History specifically. Pages without a .page-detail-col
  // (like Home) simply fall back to the normal mobile-style overlay, which is correct there.
  if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('detailSheetOverlay', Views.current);
  document.getElementById('detailTitle').textContent = fmtDateLong(g.date);
  let framesHtml = '';
  if (g.frames){
    const {frameScores} = scoreFrames(g.frames.map(f=> f.b1==null?{b1:0,b2:0,b3:0}:f));
    framesHtml = `<div class="frame-grid">` + g.frames.slice(0,9).map((f,i)=>`
      <div class="frame-cell">
        <span class="frame-num">F${i+1}</span>
        <div style="font-family:var(--mono); font-size:13px;">${f.b1===10?'X':(f.b1??'-')} ${f.b1===10?'':(f.b2??'-')}</div>
        <span class="frame-total">${frameScores[i]}</span>
      </div>
    `).join('') + `</div>`;
  }
  const ballName = g.ballId ? Store.ballName(g.ballId) : '';
  const alleyName = g.alleyId ? Store.alleyName(g.alleyId) : '';
  document.getElementById('detailBody').innerHTML = `
    <div style="text-align:center; margin-bottom:16px;">
      <div style="font-family:var(--disp); font-size:56px; color:var(--brass-bright);">${g.score}</div>
      <span class="game-tag ${g.context}">${escapeHtml(contextTagLabel(g))}</span>
    </div>
    ${framesHtml}
    ${(ballName || alleyName) ? `
      <div class="field-row" style="margin-top:16px;">
        ${ballName ? `<div class="field"><label>Ball</label><div style="padding:10px 0;">${escapeHtml(ballName)}</div></div>` : ''}
        ${alleyName ? `<div class="field"><label>Alley</label><div style="padding:10px 0;">${escapeHtml(alleyName)}</div></div>` : ''}
      </div>
    ` : ''}
    ${g.laneCondition ? `<div class="field"><label>Lane Condition</label><div style="padding:10px 0;">${escapeHtml(g.laneCondition)}</div></div>` : ''}
    ${g.notes ? `<div class="field"><label>Notes</label><div style="padding:10px 0;">${escapeHtml(g.notes)}</div></div>` : ''}
  `;
  document.getElementById('detailSheetOverlay').classList.add('active');
}
function closeDetail(){
  document.getElementById('detailSheetOverlay').classList.remove('active');
  detailGameId = null;
  if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed(Views.current);
}

// ---------- Session Detail Sheet ----------
// Shown when tapping a multi-game session row from Home or History — lists each individual
// game within that session, tappable through to the existing single-game detail sheet for
// full frame-by-frame data.
function openSessionDetail(session){
  if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('sessionDetailOverlay', Views.current);
  const tagLabel = contextTagLabel(session.games[0]);
  document.getElementById('sessionDetailTitle').textContent = fmtDateLong(session.date) + ' — ' + tagLabel;

  const alleyName = session.alleyId ? Store.alleyName(session.alleyId) : '';
  const league = session.leagueId ? Store.leagueById(session.leagueId) : null;
  const scheduleStr = league ? LeaguesUI.scheduleSummary(league) : '';
  const metaLine = [scheduleStr, alleyName, session.laneCondition].filter(Boolean).join(' · ');

  document.getElementById('sessionDetailSummary').innerHTML = `
    ${metaLine ? `<div style="text-align:center; font-size:12px; color:var(--maple-dim); margin-bottom:12px;">${escapeHtml(metaLine)}</div>` : ''}
    <div class="session-summary">
      <div class="session-summary-stat">
        <span class="session-summary-num">${session.count}</span>
        <span class="session-summary-label">Games</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${session.total}</span>
        <span class="session-summary-label">Scratch Total</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${session.average.toFixed(1)}</span>
        <span class="session-summary-label">Scratch Avg</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num" style="color:var(--brass-bright);">${session.high}</span>
        <span class="session-summary-label">Scratch High</span>
      </div>
    </div>
  `;

  document.getElementById('sessionDetailGames').innerHTML = `
    <div class="session-game-list-header">
      <span class="session-game-num"></span>
      <span class="session-game-score-label">Scratch</span>
      <span></span>
    </div>
  ` + session.games.map((g,i)=>{
    const isHigh = g.score === session.high && session.count > 1;
    return `
      <div class="session-game-row" data-game-id="${g.id}">
        <span class="session-game-num">G${i+1}</span>
        <div class="session-game-score ${isHigh?'high-of-session':''}">${g.score}</div>
        <div class="session-game-note">${escapeHtml(g.notes||'')}</div>
        <span class="session-game-chevron">›</span>
      </div>
    `;
  }).join('');

  document.getElementById('sessionDetailGames').querySelectorAll('.session-game-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      closeSessionDetail();
      openDetail(row.dataset.gameId);
    });
  });

  document.getElementById('sessionDetailOverlay').classList.add('active');
}
function closeSessionDetail(){
  document.getElementById('sessionDetailOverlay').classList.remove('active');
  if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed(Views.current);
}

// ---------- League Detail Sheet ----------
// Shown when tapping a league card from the Leagues tab — shows the league's info, its
// scratch stats, and its game history (grouped into sessions, same as the main History tab),
// with an edit icon in the header for jumping to the existing add/edit form.
let leagueDetailId = null;

function openLeagueDetail(id){
  const l = Store.leagueById(id);
  if (!l) return;
  leagueDetailId = id;
  if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('leagueDetailOverlay', 'leagues');

  document.getElementById('leagueDetailTitle').textContent = l.name;
  renderLeagueDetailInfo(l);
  renderLeagueDetailStats(l);
  renderLeagueDetailHistory(l);

  document.getElementById('leagueDetailOverlay').classList.add('active');
}

function renderLeagueDetailInfo(l){
  const alleyName = l.alleyId ? Store.alleyName(l.alleyId) : '';
  const scheduleStr = LeaguesUI.scheduleSummary(l);
  const seasonStr = LeaguesUI.seasonSummary(l);
  const completed = Store.isLeagueCompleted(l);
  const badge = completed
    ? `<span class="league-card-badge completed">Completed</span>`
    : (l.seasonStart || l.seasonEnd ? `<span class="league-card-badge current">Current</span>` : '');

  document.getElementById('leagueDetailInfo').innerHTML = `
    <div class="league-detail-badge-row">${badge}</div>
    ${l.teamName ? `<div class="league-detail-info-row"><span class="icon">👥</span><span>${escapeHtml(l.teamName)}</span>${l.teamSize?` · ${l.teamSize} bowlers`:''}</div>` : ''}
    ${scheduleStr ? `<div class="league-detail-info-row"><span class="icon">📅</span>${scheduleStr}</div>` : ''}
    ${seasonStr ? `<div class="league-detail-info-row"><span class="icon">🗓️</span>${seasonStr}</div>` : ''}
    ${alleyName ? `<div class="league-detail-info-row"><span class="icon">📍</span>${escapeHtml(alleyName)}</div>` : ''}
    ${l.placement ? `<div class="league-detail-info-row"><span class="icon">🏆</span><span class="league-detail-placement">${escapeHtml(l.placement)}</span></div>` : ''}
    ${l.placementNotes ? `<div class="league-detail-notes">${escapeHtml(l.placementNotes)}</div>` : ''}
    ${l.notes ? `<div class="league-detail-notes">${escapeHtml(l.notes)}</div>` : ''}
  `;
}

function renderLeagueDetailStats(l){
  const games = Store.games.filter(g => g.leagueId === l.id);
  const el = document.getElementById('leagueDetailStats');
  if (!games.length){
    el.innerHTML = `<div class="chart-empty">No games logged for this league yet.</div>`;
    return;
  }
  const avg = Stats.average(games);
  const high = Stats.high(games);
  const low = Stats.low(games);
  el.innerHTML = `
    <div class="league-detail-stats-row">
      <div class="session-summary-stat">
        <span class="session-summary-num">${games.length}</span>
        <span class="session-summary-label">Games</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${avg.toFixed(1)}</span>
        <span class="session-summary-label">Scratch Avg</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num" style="color:var(--brass-bright);">${high}</span>
        <span class="session-summary-label">Scratch High</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${low}</span>
        <span class="session-summary-label">Scratch Low</span>
      </div>
    </div>
  `;
}

function renderLeagueDetailHistory(l){
  const games = Store.games.filter(g => g.leagueId === l.id);
  const el = document.getElementById('leagueDetailHistory');
  if (!games.length){
    el.innerHTML = `<div class="empty-state"><div class="pin down"></div><p>No games logged for this league yet.</p></div>`;
    return;
  }
  const sessions = [...groupIntoSessions(games)].reverse();
  // separate lookup cache, mirroring how Home/History each keep their own, so opening this
  // sheet doesn't clobber whichever session lookup the main History view currently has active
  Render.lastLeagueDetailSessionsById = {};
  sessions.forEach(s => Render.lastLeagueDetailSessionsById[s.sessionId] = s);
  el.innerHTML = sessions.map(sessionRowHTML).join('');
  el.querySelectorAll('.game-row[data-session-id]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const session = Render.lastLeagueDetailSessionsById[row.dataset.sessionId];
      if (!session) return;
      if (session.count > 1){
        openSessionDetail(session);
      } else {
        openDetail(session.games[0].id);
      }
    });
  });
}

function closeLeagueDetail(){
  document.getElementById('leagueDetailOverlay').classList.remove('active');
  leagueDetailId = null;
  if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('leagues');
}

let tournamentDetailId = null;

function openTournamentDetail(id){
  const t = Store.tournamentById(id);
  if (!t) return;
  tournamentDetailId = id;
  if (typeof DetailColumn !== 'undefined') DetailColumn.relocate('tournamentDetailOverlay', 'tournaments');

  document.getElementById('tournamentDetailTitle').textContent = t.name;
  renderTournamentDetailInfo(t);
  renderTournamentDetailStats(t);
  renderTournamentDetailHistory(t);

  document.getElementById('tournamentDetailOverlay').classList.add('active');
}

function renderTournamentDetailInfo(t){
  const alleyName = t.alleyId ? Store.alleyName(t.alleyId) : '';
  const dateStr = TournamentsUI.dateSummary(t);
  const completed = Store.isTournamentCompleted(t);
  const badge = completed
    ? `<span class="league-card-badge completed">Completed</span>`
    : (dateStr ? `<span class="league-card-badge current">Current</span>` : '');

  document.getElementById('tournamentDetailInfo').innerHTML = `
    <div class="league-detail-badge-row">${badge}</div>
    ${t.format ? `<div class="league-detail-info-row"><span class="icon">🎳</span><span>${escapeHtml(t.format)}</span></div>` : ''}
    ${dateStr ? `<div class="league-detail-info-row"><span class="icon">🗓️</span>${dateStr}</div>` : ''}
    ${alleyName ? `<div class="league-detail-info-row"><span class="icon">📍</span>${escapeHtml(alleyName)}</div>` : ''}
    ${t.entryFee ? `<div class="league-detail-info-row"><span class="icon">💵</span>${escapeHtml(t.entryFee)} entry</div>` : ''}
    ${t.placement ? `<div class="league-detail-info-row"><span class="icon">🏆</span><span class="league-detail-placement">${escapeHtml(t.placement)}</span></div>` : ''}
    ${t.placementNotes ? `<div class="league-detail-notes">${escapeHtml(t.placementNotes)}</div>` : ''}
    ${t.notes ? `<div class="league-detail-notes">${escapeHtml(t.notes)}</div>` : ''}
  `;
}

function renderTournamentDetailStats(t){
  const games = Store.games.filter(g => g.tournamentId === t.id);
  const el = document.getElementById('tournamentDetailStats');
  if (!games.length){
    el.innerHTML = `<div class="chart-empty">No games logged for this tournament yet.</div>`;
    return;
  }
  const avg = Stats.average(games);
  const high = Stats.high(games);
  const low = Stats.low(games);
  el.innerHTML = `
    <div class="league-detail-stats-row">
      <div class="session-summary-stat">
        <span class="session-summary-num">${games.length}</span>
        <span class="session-summary-label">Games</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${avg.toFixed(1)}</span>
        <span class="session-summary-label">Scratch Avg</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num" style="color:var(--brass-bright);">${high}</span>
        <span class="session-summary-label">Scratch High</span>
      </div>
      <div class="session-summary-stat">
        <span class="session-summary-num">${low}</span>
        <span class="session-summary-label">Scratch Low</span>
      </div>
    </div>
  `;
}

function renderTournamentDetailHistory(t){
  const games = Store.games.filter(g => g.tournamentId === t.id);
  const el = document.getElementById('tournamentDetailHistory');
  if (!games.length){
    el.innerHTML = `<div class="empty-state"><div class="pin down"></div><p>No games logged for this tournament yet.</p></div>`;
    return;
  }
  const sessions = [...groupIntoSessions(games)].reverse();
  // separate lookup cache, same pattern as every other detail sheet's own session cache, so
  // opening this doesn't clobber whichever session lookup another view currently has active
  Render.lastTournamentDetailSessionsById = {};
  sessions.forEach(s => Render.lastTournamentDetailSessionsById[s.sessionId] = s);
  el.innerHTML = sessions.map(sessionRowHTML).join('');
  el.querySelectorAll('.game-row[data-session-id]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const session = Render.lastTournamentDetailSessionsById[row.dataset.sessionId];
      if (!session) return;
      if (session.count > 1){
        openSessionDetail(session);
      } else {
        openDetail(session.games[0].id);
      }
    });
  });
}

function closeTournamentDetail(){
  document.getElementById('tournamentDetailOverlay').classList.remove('active');
  tournamentDetailId = null;
  if (typeof DetailColumn !== 'undefined') DetailColumn.onSheetClosed('tournaments');
}

// ---------- Event wiring ----------
// safeOn: wires a listener without throwing if the element is missing (e.g. a stale cached
// HTML file momentarily out of sync with a newer app.js after a deploy). A missing element
// means that one feature degrades; it must never be able to abort every listener wired after it.
function safeOn(id, event, handler){
  const el = document.getElementById(id);
  if (!el){
    console.warn('safeOn: element not found, skipping wire-up:', id);
    return;
  }
  el.addEventListener(event, handler);
}

document.addEventListener('DOMContentLoaded', ()=>{
  // Detect environments where localStorage is blocked outright (most commonly:
  // opening index.html directly via file:// instead of serving it over http/https).
  // This app is built entirely on localStorage, so this check happens before anything
  // else — a person tapping buttons that silently do nothing has no way to know why
  // without this, since every individual save/add action would otherwise fail quietly.
  let storageAvailable = true;
  try{
    const testKey = '__pinboard_storage_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
  }catch(e){
    storageAvailable = false;
  }
  if (!storageAvailable){
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:999; background:#8B2E2E; color:#F2E4C9; padding:14px 16px; font-family:Archivo,sans-serif; font-size:13px; line-height:1.5; text-align:center;';
    banner.innerHTML = 'This app can\'t save data opened this way. Please host it (e.g. GitHub Pages, Firebase) and open it over <b>http://</b> or <b>https://</b> instead of double-clicking the file — see SETUP.md.';
    document.body.prepend(banner);
  }

  // The theme itself was already applied by a tiny inline script in <head>, before this point,
  // specifically to avoid a flash of the wrong theme while the rest of the page loads. This just
  // brings the module's in-memory state and the meta theme-color tag in sync with that.
  Theme.load();
  Theme.updateMetaThemeColor();

  Store.load();
  Render.all();

  // Core navigation wiring happens first and is wrapped independently — this must
  // survive even if something later in this handler is broken by a version mismatch.
  try{
    document.querySelectorAll('.nav-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> Views.show(btn.dataset.view));
    });
  }catch(e){ console.error('Nav button wiring failed:', e); }

  try{
    safeOn('btnOpenDrawer', 'click', ()=> Drawer.toggle());
    safeOn('btnCloseDrawer', 'click', ()=> Drawer.close());
    safeOn('drawerBackdrop', 'click', ()=> Drawer.close());
  }catch(e){ console.error('Drawer wiring failed:', e); }

  try{
    safeOn('chipThemeDark', 'click', ()=> Theme.toggle('dark'));
    safeOn('chipThemeLight', 'click', ()=> Theme.toggle('light'));
    Theme.updateSettingsUI();
  }catch(e){ console.error('Theme toggle wiring failed:', e); }

  try{
    safeOn('fabAdd', 'click', ()=> AddSheet.open());
    safeOn('btnCancelAdd', 'click', ()=> AddSheet.close());
    safeOn('btnSaveGame', 'click', ()=> AddSheet.save());
    safeOn('chipLeague', 'click', ()=> AddSheet.setContext('league'));
    safeOn('chipOpen', 'click', ()=> AddSheet.setContext('open'));
    safeOn('toggleFrameMode', 'click', ()=> AddSheet.toggleMode());
    safeOn('inputLeagueSelect', 'change', (e)=> AddSheet.applyLeagueDefaults(e.target.value));
    safeOn('btnGamesDown', 'click', ()=> AddSheet.setGamesCount(AddSheet.gamesCount - 1));
    safeOn('btnGamesUp', 'click', ()=> AddSheet.setGamesCount(AddSheet.gamesCount + 1));
  }catch(e){ console.error('Add Game sheet wiring failed:', e); }

  try{
    safeOn('btnCloseDetail', 'click', closeDetail);
    safeOn('btnDeleteGame', 'click', ()=>{
      if (detailGameId && confirm('Delete this game?')){
        Store.deleteGame(detailGameId);
        closeDetail();
        Render.all();
        toast('Game deleted');
      }
    });
  }catch(e){ console.error('Detail sheet wiring failed:', e); }

  try{
    safeOn('btnCloseSessionDetail', 'click', closeSessionDetail);
    safeOn('sessionDetailOverlay', 'click', (e)=>{
      if (e.target.id==='sessionDetailOverlay') closeSessionDetail();
    });
  }catch(e){ console.error('Session detail sheet wiring failed:', e); }

  try{
    safeOn('btnCloseLeagueDetail', 'click', closeLeagueDetail);
    safeOn('leagueDetailOverlay', 'click', (e)=>{
      if (e.target.id==='leagueDetailOverlay') closeLeagueDetail();
    });
    safeOn('btnEditLeagueFromDetail', 'click', ()=>{
      if (!leagueDetailId) return;
      const id = leagueDetailId;
      closeLeagueDetail();
      LeaguesUI.openEdit(id);
    });
  }catch(e){ console.error('League detail sheet wiring failed:', e); }

  try{
    safeOn('btnCloseBallDetail', 'click', closeBallDetail);
    safeOn('ballDetailOverlay', 'click', (e)=>{
      if (e.target.id==='ballDetailOverlay') closeBallDetail();
    });
    safeOn('btnEditBallSpecs', 'click', ()=> showBallSpecForm(true));
    safeOn('btnSaveBallSpecs', 'click', ()=> saveBallSpecForm());
  }catch(e){ console.error('Ball detail sheet wiring failed:', e); }

  try{
    safeOn('btnEditStatsLayout', 'click', ()=> StatsLayoutEditor.open());
    safeOn('btnDoneStatsLayout', 'click', ()=> StatsLayoutEditor.done());
    safeOn('btnResetStatsLayout', 'click', ()=> StatsLayoutEditor.resetToDefault());
    safeOn('statsEditorOverlay', 'click', (e)=>{
      // Closing via backdrop tap discards unsaved changes, matching how every other sheet's
      // click-outside behaves in this app (Cancel-equivalent, not Done-equivalent).
      if (e.target.id==='statsEditorOverlay') StatsLayoutEditor.close();
    });
  }catch(e){ console.error('Stats layout editor wiring failed:', e); }

  try{
    safeOn('btnAddCustomWidget', 'click', ()=> CustomWidgetBuilder.openAdd());
    safeOn('btnCancelCustomWidget', 'click', ()=> CustomWidgetBuilder.close());
    safeOn('btnSaveCustomWidget', 'click', ()=> CustomWidgetBuilder.save());
    safeOn('btnDeleteCustomWidget', 'click', ()=> CustomWidgetBuilder.delete());
    safeOn('customWidgetBuilderOverlay', 'click', (e)=>{
      if (e.target.id==='customWidgetBuilderOverlay') CustomWidgetBuilder.close();
    });
    document.querySelectorAll('#customWidgetBuilderOverlay [data-chart-type]').forEach(chip=>{
      chip.addEventListener('click', ()=> CustomWidgetBuilder.setChartType(chip.dataset.chartType));
    });
  }catch(e){ console.error('Custom widget builder wiring failed:', e); }

  try{
    safeOn('btnAddLeague', 'click', ()=> LeaguesUI.openAdd());
    safeOn('btnCancelLeague', 'click', ()=> LeaguesUI.close());
    safeOn('btnSaveLeague', 'click', ()=> LeaguesUI.save());
    safeOn('btnDeleteLeague', 'click', ()=> LeaguesUI.delete());
    safeOn('btnLgAddToCalendar', 'click', ()=> LeaguesUI.addToCalendar());
    safeOn('btnLgToggleCompleted', 'click', ()=> LeaguesUI.toggleCompleted());
    safeOn('leagueSheetOverlay', 'click', (e)=>{
      if (e.target.id==='leagueSheetOverlay') LeaguesUI.close();
    });
  }catch(e){ console.error('League sheet wiring failed:', e); }

  try{
    safeOn('leaguesCtxToggle', 'click', (e)=>{
      const btn = e.target.closest('.ctx-btn');
      if (!btn) return;
      document.getElementById('leaguesCtxToggle').querySelectorAll('.ctx-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      LeaguesUI.statusFilter = btn.dataset.status;
      LeaguesUI.render();
    });
  }catch(e){ console.error('Leagues status filter wiring failed:', e); }

  try{
    safeOn('btnCloseTournamentDetail', 'click', closeTournamentDetail);
    safeOn('tournamentDetailOverlay', 'click', (e)=>{
      if (e.target.id==='tournamentDetailOverlay') closeTournamentDetail();
    });
    safeOn('btnEditTournamentFromDetail', 'click', ()=>{
      if (!tournamentDetailId) return;
      const id = tournamentDetailId;
      closeTournamentDetail();
      TournamentsUI.openEdit(id);
    });
  }catch(e){ console.error('Tournament detail sheet wiring failed:', e); }

  try{
    safeOn('btnAddTournament', 'click', ()=> TournamentsUI.openAdd());
    safeOn('btnCancelTournament', 'click', ()=> TournamentsUI.close());
    safeOn('btnSaveTournament', 'click', ()=> TournamentsUI.save());
    safeOn('btnDeleteTournament', 'click', ()=> TournamentsUI.delete());
    safeOn('btnTnToggleCompleted', 'click', ()=> TournamentsUI.toggleCompleted());
    safeOn('tournamentSheetOverlay', 'click', (e)=>{
      if (e.target.id==='tournamentSheetOverlay') TournamentsUI.close();
    });
    document.querySelectorAll('#tournamentSheetOverlay [data-date-mode]').forEach(chip=>{
      chip.addEventListener('click', ()=> TournamentsUI.setDateMode(chip.dataset.dateMode));
    });
  }catch(e){ console.error('Tournament sheet wiring failed:', e); }

  try{
    safeOn('tournamentsCtxToggle', 'click', (e)=>{
      const btn = e.target.closest('.ctx-btn');
      if (!btn) return;
      document.getElementById('tournamentsCtxToggle').querySelectorAll('.ctx-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      TournamentsUI.statusFilter = btn.dataset.status;
      TournamentsUI.render();
    });
  }catch(e){ console.error('Tournaments status filter wiring failed:', e); }

  try{
    safeOn('btnLogTournamentGame', 'click', ()=> TnGameSheet.open());
    safeOn('btnCancelTnGame', 'click', ()=> TnGameSheet.close());
    safeOn('btnSaveTnGame', 'click', ()=> TnGameSheet.save());
    safeOn('tnGameSheetOverlay', 'click', (e)=>{
      if (e.target.id==='tnGameSheetOverlay') TnGameSheet.close();
    });
    safeOn('toggleTnFrameMode', 'click', ()=> TnGameSheet.toggleMode());
    safeOn('btnTnGamesUp', 'click', ()=> TnGameSheet.setGamesCount(TnGameSheet.gamesCount+1));
    safeOn('btnTnGamesDown', 'click', ()=> TnGameSheet.setGamesCount(TnGameSheet.gamesCount-1));
  }catch(e){ console.error('Tournament game sheet wiring failed:', e); }

  try{
    safeOn('btnPinStrike', 'click', ()=> PinKeypad.setStrike());
    safeOn('btnPinSpare', 'click', ()=> PinKeypad.setSpare());
    safeOn('btnPinClear', 'click', ()=> PinKeypad.clear());
    safeOn('btnPinKeypadDone', 'click', ()=> PinKeypad.close());
    safeOn('pinKeypadOverlay', 'click', (e)=>{
      if (e.target.id==='pinKeypadOverlay') PinKeypad.close();
    });
  }catch(e){ console.error('Pin keypad wiring failed:', e); }

  try{
    ['chartCtxToggle','historyCtxToggle','statsCtxToggle','statsDateRangeToggle'].forEach(id=>{
      safeOn(id, 'click', (e)=>{
        const btn = e.target.closest('.ctx-btn');
        if (!btn) return;
        document.getElementById(id).querySelectorAll('.ctx-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        Render.all();
      });
    });
  }catch(e){ console.error('Context toggle wiring failed:', e); }

  try{
    safeOn('statsLeagueFilter', 'change', ()=> Render.all());
    safeOn('statsRangeStart', 'change', ()=> Render.all());
    safeOn('statsRangeEnd', 'change', ()=> Render.all());
  }catch(e){ console.error('Stats league filter wiring failed:', e); }

  try{
    safeOn('btnExport', 'click', ()=>{
      const blob = new Blob([JSON.stringify(Store.games,null,2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'pinboard-export.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    safeOn('btnClearData', 'click', ()=>{
      if (confirm('This will delete all locally stored games. This cannot be undone. Continue?')){
        Store.games = [];
        Store.save();
        Render.all();
        toast('Local data cleared');
      }
    });
  }catch(e){ console.error('Export/clear data wiring failed:', e); }

  try{
    // overlay click-outside-to-close
    safeOn('addSheetOverlay', 'click', (e)=>{
      if (e.target.id==='addSheetOverlay') AddSheet.close();
    });
    safeOn('detailSheetOverlay', 'click', (e)=>{
      if (e.target.id==='detailSheetOverlay') closeDetail();
    });
  }catch(e){ console.error('Overlay click-outside wiring failed:', e); }

  if (typeof CloudSync !== 'undefined'){
    try{ CloudSync.init(); }catch(e){ console.error('CloudSync init failed:', e); }
  }
  if (typeof FriendsUI !== 'undefined'){
    try{ FriendsUI.init(); }catch(e){ console.error('FriendsUI init failed:', e); }
  }
  if (typeof ScoreScan !== 'undefined'){
    try{ ScoreScan.init(); }catch(e){ console.error('ScoreScan init failed:', e); }
  }
  if (typeof SettingsUI !== 'undefined'){
    try{ SettingsUI.init(); }catch(e){ console.error('SettingsUI init failed:', e); }
  }
  if (typeof BallsUI !== 'undefined'){
    try{ BallsUI.init(); }catch(e){ console.error('BallsUI init failed:', e); }
  }
  if (typeof AlleyDetect !== 'undefined'){
    try{ AlleyDetect.init(); }catch(e){ console.error('AlleyDetect init failed:', e); }
  }
  if (typeof LaneFinder !== 'undefined'){
    try{ LaneFinder.init(); }catch(e){ console.error('LaneFinder init failed:', e); }
  }
  if (typeof DetailColumn !== 'undefined'){
    try{ DetailColumn.init(); }catch(e){ console.error('DetailColumn init failed:', e); }
  }
  if (typeof AlleyDetailSheet !== 'undefined'){
    try{ AlleyDetailSheet.init(); }catch(e){ console.error('AlleyDetailSheet init failed:', e); }
  }

  // Register service worker for offline/installability
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});
