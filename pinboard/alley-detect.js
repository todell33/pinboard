// ======================================================================
// AlleyDetect — quietly detects which bowling alley you're actually at, using
// the browser's geolocation plus Google Places Nearby Search (bowling
// alleys only). Selects based on the real nearest bowling alley Google
// finds — not limited to alleys you've already saved — reusing a saved
// alley on a confident name match, or creating a new one if it's a place
// you haven't logged at before. Never overrides a choice you've made yourself.
//
// All Google API calls go through a small personal proxy (a Cloudflare
// Worker you deploy yourself — see SETUP.md) instead of calling Google
// directly with a key stored in this browser. The proxy holds the real
// Google API key server-side, so it's never present anywhere in this app's
// code, network requests, or downloaded files — only PROXY_URL (the
// address of your own deployed Worker) is stored here, and that alone is
// useless to anyone without also controlling that Worker.
// ======================================================================

const PROXY_URL_STORAGE = 'pinboard_proxy_url';

const AlleyDetect = {
  proxyUrl: null,

  init(){
    this.proxyUrl = (localStorage.getItem(PROXY_URL_STORAGE) || '').replace(/\/$/, '') || null;
    this.updateProxyUI();

    const btnSave = document.getElementById('btnSaveProxyUrl');
    if (btnSave){
      btnSave.addEventListener('click', ()=>{
        const val = document.getElementById('inputProxyUrl').value.trim().replace(/\/$/, '');
        if (!val){ toast('Enter your Worker URL first'); return; }
        if (!/^https:\/\//.test(val)){ toast('URL should start with https://'); return; }
        localStorage.setItem(PROXY_URL_STORAGE, val);
        this.proxyUrl = val;
        document.getElementById('inputProxyUrl').value = '';
        this.updateProxyUI();
        toast('Proxy URL saved');
      });
    }
    const btnClear = document.getElementById('btnClearProxyUrl');
    if (btnClear){
      btnClear.addEventListener('click', ()=>{
        localStorage.removeItem(PROXY_URL_STORAGE);
        this.proxyUrl = null;
        this.updateProxyUI();
        toast('Proxy URL removed');
      });
    }
    const btnTest = document.getElementById('btnTestAlleyDetection');
    if (btnTest){
      btnTest.addEventListener('click', ()=> this.testDetection());
    }
  },

  updateProxyUI(){
    const status = document.getElementById('proxyUrlStatus');
    if (!status) return;
    if (this.proxyUrl){
      status.textContent = 'Ready — using ' + this.proxyUrl;
    } else {
      status.textContent = 'Not set up — add your Worker URL to enable location features (see SETUP.md)';
    }
  },

  // Entry point called when the Add Game sheet opens. Silently does nothing if there's no
  // proxy configured, geolocation isn't available, or nothing nearby is found — this is a
  // convenience layered on top of manual selection, never a requirement. Unlike matching
  // against a fixed list, this is based purely on where you actually are: whatever real
  // bowling alley Google Places finds you at gets selected, creating it in your saved Alleys
  // list first if it isn't already there (so it's a one-tap pick next time too), rather than
  // only ever recognizing alleys you'd already typed in manually.
  async detectAndApply(){
    const result = await this.runDetection();
    if (result.ok){
      const alleySel = document.getElementById('inputAlley');
      if (alleySel){
        if (result.wasNewlyCreated && typeof AddSheet !== 'undefined') AddSheet.populateAlleyPicker();
        alleySel.value = result.alley.id;
        toast('📍 Detected ' + result.alley.name);
      }
    } else {
      // Silent by design during normal game logging: denied permission, offline, no nearby
      // results, etc. are all normal outcomes for a background convenience feature — never
      // interrupt logging a game over this. Still logged to the console for troubleshooting,
      // and reachable via Settings → "Test Detection Now" for anyone trying to diagnose why
      // it isn't working on their device.
      console.warn('AlleyDetect: skipped auto-detection —', result.reason);
    }
  },

  // Runs the same detection logic as detectAndApply, but returns a structured result describing
  // exactly what happened at each step instead of silently swallowing the outcome — this is what
  // powers the visible "Test Detection Now" button in Settings, so someone whose detection isn't
  // working can actually see which specific step failed rather than guessing blindly.
  async runDetection(){
    if (!this.proxyUrl) return { ok:false, reason: 'No proxy URL is saved in Settings — see SETUP.md to deploy your own.' };
    if (!('geolocation' in navigator)) return { ok:false, reason: 'This browser does not support geolocation.' };

    let coords;
    try{
      coords = await this.getCurrentPosition();
    } catch(e){
      return { ok:false, reason: e.message || 'Could not get your location.' };
    }

    let places;
    try{
      places = await this.nearbyBowlingAlleys(coords.latitude, coords.longitude);
    } catch(e){
      return { ok:false, reason: e.message || 'The proxy request failed.', coords };
    }

    if (!places.length){
      return { ok:false, reason: 'No bowling alleys found within 500m of your current location.', coords };
    }

    // Places results are already ordered by proximity for a Nearby Search — the first result
    // is simply the closest real bowling alley to the current location.
    const nearest = places[0];
    const wasNewlyCreated = !Store.settings.alleys.some(a => stringSimilarity(nearest.name, a.name) >= 0.6);
    const alley = this.findOrCreateAlley(nearest.name);
    if (!alley){
      return { ok:false, reason: 'Found "' + nearest.name + '" nearby, but saving it failed (storage issue).', coords };
    }

    return { ok:true, alley, wasNewlyCreated, coords, nearestName: nearest.name, resultCount: places.length };
  },

  // Wired to the "📍 Test Detection Now" button in Settings — runs the exact same detection
  // logic as real game logging, but always shows the outcome (success or the specific failure
  // reason) instead of failing silently, so this is diagnosable from the phone itself.
  async testDetection(){
    const statusEl = document.getElementById('alleyDetectTestStatus');
    if (!statusEl) return;
    statusEl.style.display = '';
    statusEl.textContent = 'Testing… (your browser may ask for location permission)';

    const result = await this.runDetection();
    if (result.ok){
      const verb = result.wasNewlyCreated ? 'Added and selected' : 'Found existing match:';
      statusEl.textContent = `✓ ${verb} "${result.alley.name}" (${result.resultCount} alley${result.resultCount===1?'':'s'} found nearby).`;
    } else {
      statusEl.textContent = '✗ ' + result.reason;
    }
  },

  // Reuses an existing saved alley if the detected name is a confident fuzzy match for one
  // (so GPS jitter or Google's exact naming doesn't spawn "Thunderbird Lanes" and "Thunderbird
  // Bowling Lanes" as two separate entries for the same physical place), otherwise creates a
  // new alley from the detected name and returns it.
  findOrCreateAlley(detectedName){
    let best = null;
    Store.settings.alleys.forEach(alley=>{
      const score = stringSimilarity(detectedName, alley.name);
      if (score >= 0.6 && (!best || score > best.score)) best = alley;
    });
    if (best) return best;
    return Store.addAlley(detectedName);
  },

  getCurrentPosition(){
    return new Promise((resolve, reject)=>{
      navigator.geolocation.getCurrentPosition(
        (pos)=> resolve(pos.coords),
        (err)=> reject(new Error('Location unavailable: ' + err.message)),
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 } // indoor GPS fixes can be slow; 5-minute cache is plenty for "which alley am I at"
      );
    });
  },

  async nearbyBowlingAlleys(lat, lng){
    // Routed through your own Worker proxy rather than calling Google directly — see the
    // module comment at the top of this file for why.
    const res = await fetch(`${this.proxyUrl}/places/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-FieldMask': 'places.displayName,places.location'
      },
      body: JSON.stringify({
        includedTypes: ['bowling_alley'],
        maxResultCount: 5,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: 500.0 } // 500m: a bowling alley you're standing in/right next to
        }
      })
    });

    if (!res.ok){
      const body = await res.text().catch(()=>'');
      throw new Error('Proxy/Places error ' + res.status + (body ? ': ' + body.slice(0,150) : ''));
    }
    const data = await res.json();
    return (data.places || []).map(p => ({
      name: p.displayName ? p.displayName.text : '',
      lat: p.location ? p.location.latitude : null,
      lng: p.location ? p.location.longitude : null
    })).filter(p => p.name);
  },

  // Wider-radius, richer-field search used by the Lane Finder page — separate from the tight
  // 500m/5-result auto-detect search above, since Lane Finder needs address/rating for display
  // and a much larger radius (up to the Places API's own 50km cap) rather than "which alley am
  // I standing in right now."
  async searchWideArea(lat, lng){
    const res = await fetch(`${this.proxyUrl}/places/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // places.name is the field that actually holds the full resource path (e.g.
        // "places/ChIJ...") that a subsequent Place Details lookup needs. places.id is a
        // related but distinct bare-ID field — kept here too since it's a cheap, useful
        // stable identifier, but it is NOT a valid Details request path on its own.
        'X-Goog-FieldMask': 'places.id,places.name,places.displayName,places.location,places.formattedAddress,places.rating,places.userRatingCount'
      },
      body: JSON.stringify({
        includedTypes: ['bowling_alley'],
        maxResultCount: 20, // Places API's own maximum for Nearby Search
        locationRestriction: {
          // 50000m (50km, ~31mi) is the Places API's own documented maximum radius for Nearby
          // Search — a hard external limit, not a choice made here. This means the "50 mi" filter
          // option can only ever show alleys the API is physically able to search for in the
          // first place; LaneFinder surfaces that constraint in its status text rather than
          // silently pretending to search further than the API allows.
          circle: { center: { latitude: lat, longitude: lng }, radius: 50000.0 }
        }
      })
    });

    if (!res.ok){
      const body = await res.text().catch(()=>'');
      throw new Error('Proxy/Places error ' + res.status + (body ? ': ' + body.slice(0,150) : ''));
    }
    const data = await res.json();
    return (data.places || []).map(p => ({
      // p.name is the full "places/ChIJ..." resource path — this is what a Details lookup
      // actually needs. Falling back to a manually-prefixed p.id only covers the (unexpected)
      // case where name is somehow missing but id isn't, so a lookup can still be attempted
      // rather than silently having no id at all.
      id: p.name || (p.id ? 'places/' + p.id : null),
      name: p.displayName ? p.displayName.text : '',
      address: p.formattedAddress || '',
      rating: typeof p.rating === 'number' ? p.rating : null,
      ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      lat: p.location ? p.location.latitude : null,
      lng: p.location ? p.location.longitude : null
    })).filter(p => p.name && p.lat != null && p.lng != null);
  },

  // Fetches richer details (phone, website, opening hours) for one specific place, using its
  // Places API resource id — called only when someone actually taps into a result on Lane
  // Finder, not for every result in the list, since these fields sit in a pricier field tier
  // than the basic search fields and there's no reason to pay for them for places nobody opens.
  async placeDetails(placeId){
    if (!placeId){
      // A missing/empty id would otherwise build a broken request — fail clearly here instead,
      // before any network call is attempted.
      throw new Error('This alley has no valid Places ID, so its details can\'t be looked up.');
    }
    // Normalize defensively: the Details lookup needs the full "places/ChIJ..." resource path,
    // not just the bare id. Accept either shape here so this can't silently break again if the
    // exact field search results carry ever varies.
    const resourcePath = placeId.startsWith('places/') ? placeId : 'places/' + placeId;
    const fields = 'nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,currentOpeningHours';

    const res = await fetch(`${this.proxyUrl}/places/details/${encodeURIComponent(resourcePath)}?fields=${encodeURIComponent(fields)}`, {
      method: 'GET'
    });
    if (!res.ok){
      const body = await res.text().catch(()=>'');
      throw new Error('Proxy/Places error ' + res.status + (body ? ': ' + body.slice(0,150) : ''));
    }
    const data = await res.json();
    const hours = data.currentOpeningHours || data.regularOpeningHours || null;
    return {
      phone: data.nationalPhoneNumber || data.internationalPhoneNumber || '',
      website: data.websiteUri || '',
      // weekdayDescriptions is a pre-formatted array like ["Monday: 10:00 AM – 11:00 PM", ...]
      // from Google — using it directly avoids re-implementing timezone-aware hour formatting.
      hoursText: hours && Array.isArray(hours.weekdayDescriptions) ? hours.weekdayDescriptions : null,
      openNow: hours && typeof hours.openNow === 'boolean' ? hours.openNow : null
    };
  }
};

// Great-circle (haversine) distance between two lat/lng points, in miles — used by Lane Finder
// to show and filter by distance, since Places API returns coordinates but not distance itself.
function distanceMiles(lat1, lng1, lat2, lng2){
  const toRad = d => d * Math.PI / 180;
  const R = 3958.8; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ======================================================================
// AlleyDetailSheet — shown when someone taps a Lane Finder result. Fetches richer
// Place Details (phone, website, hours) on demand for just that one alley, and
// shows an embedded Google Map via the same proxy (which redirects to Google's
// real embed URL with the key attached server-side).
// ======================================================================
const AlleyDetailSheet = {
  init(){
    const btnClose = document.getElementById('btnCloseAlleyDetailSheet');
    if (btnClose){
      btnClose.addEventListener('click', ()=> this.close());
    }
    const overlay = document.getElementById('alleyDetailSheetOverlay');
    if (overlay){
      overlay.addEventListener('click', (e)=>{
        if (e.target.id==='alleyDetailSheetOverlay') this.close();
      });
    }
    const btnTestMap = document.getElementById('btnTestMapsEmbed');
    if (btnTestMap){
      btnTestMap.addEventListener('click', ()=> this.testMapsEmbed());
    }
  },

  // Wired to "🗺️ Test Map Now" in Settings — renders a map independent of Lane Finder or any
  // specific alley, using fixed, well-known coordinates (the Empire State Building) so this
  // works even without location permission or a prior search. This isolates whether the PROXY
  // itself is reachable and correctly configured, separate from anything about how the alley
  // detail sheet wires things together — useful because a broken proxy/key typically shows an
  // error message baked INTO the map image by Google's own servers, which this code has no way
  // to detect or read (an iframe's cross-origin content isn't inspectable by the embedding
  // page), so seeing a real map here is the most reliable way to confirm it's actually working.
  testMapsEmbed(){
    const wrap = document.getElementById('mapsEmbedTestWrap');
    const iframe = document.getElementById('mapsEmbedTestFrame');
    if (typeof AlleyDetect === 'undefined' || !AlleyDetect.proxyUrl){
      toast('Add your proxy URL in Settings first');
      return;
    }
    iframe.src = `${AlleyDetect.proxyUrl}/maps/embed?lat=40.7484&lng=-73.9857&zoom=15`;
    wrap.style.display = '';
    toast('If this shows a real map, your proxy is working. If it shows a gray box or a Google error message, check the setup guide.');
  },

  close(){
    document.getElementById('alleyDetailSheetOverlay').classList.remove('active');
  },

  async open(placeId){
    const basic = (typeof LaneFinder !== 'undefined' && LaneFinder.resultsById[placeId]) || null;
    if (!basic){
      toast('Could not find that alley\'s info — try refreshing the list');
      return;
    }

    // Show immediately with whatever we already have from the list (name, distance, address,
    // rating) rather than waiting on the network — the Place Details fetch below only adds to
    // this, it doesn't replace it, so there's no flash of empty content while it loads.
    document.getElementById('alleyDetailSheetTitle').textContent = basic.name;
    const summaryBits = [
      basic.distance != null ? `${basic.distance.toFixed(1)} mi away` : null,
      basic.rating != null ? `★ ${basic.rating.toFixed(1)}${basic.ratingCount!=null ? ` (${basic.ratingCount})` : ''}` : null
    ].filter(Boolean);
    document.getElementById('alleyDetailSheetSummary').textContent = summaryBits.join(' · ');

    document.getElementById('alleyDetailSheetContact').innerHTML = basic.address
      ? `<div class="league-detail-info-row"><span class="icon">📍</span>${escapeHtml(basic.address)}</div>`
      : '';
    document.getElementById('alleyDetailSheetHoursWrap').style.display = 'none';
    document.getElementById('alleyDetailSheetStatus').textContent = 'Loading hours, phone, and website…';

    this.renderMap(basic);
    document.getElementById('alleyDetailSheetOverlay').classList.add('active');

    if (typeof AlleyDetect === 'undefined' || !AlleyDetect.proxyUrl){
      document.getElementById('alleyDetailSheetStatus').textContent = '';
      return;
    }

    try{
      const details = await AlleyDetect.placeDetails(placeId);
      this.renderDetails(basic, details);
      document.getElementById('alleyDetailSheetStatus').textContent = '';
    } catch(e){
      document.getElementById('alleyDetailSheetStatus').textContent = '✗ ' + (e.message || 'Could not load extra details for this alley.');
    }
  },

  renderMap(basic){
    const wrap = document.getElementById('alleyDetailSheetMapWrap');
    const iframe = document.getElementById('alleyDetailSheetMap');
    if (typeof AlleyDetect === 'undefined' || !AlleyDetect.proxyUrl || basic.lat == null || basic.lng == null){
      wrap.style.display = 'none';
      return;
    }
    // The proxy redirects this to Google's real Maps Embed URL with the actual key attached
    // server-side — Pinboard's own code never sees or sends the real key at any point.
    iframe.src = `${AlleyDetect.proxyUrl}/maps/embed?lat=${basic.lat}&lng=${basic.lng}&zoom=15`;
    wrap.style.display = '';
  },

  renderDetails(basic, details){
    const contactEl = document.getElementById('alleyDetailSheetContact');
    const rows = [];
    if (basic.address) rows.push(`<div class="league-detail-info-row"><span class="icon">📍</span>${escapeHtml(basic.address)}</div>`);
    if (details.phone){
      const telHref = 'tel:' + details.phone.replace(/[^\d+]/g,'');
      rows.push(`<div class="league-detail-info-row"><span class="icon">📞</span><a class="contact-link" href="${telHref}">${escapeHtml(details.phone)}</a></div>`);
    }
    if (details.website){
      rows.push(`<div class="league-detail-info-row"><span class="icon">🌐</span><a class="contact-link" href="${escapeHtml(details.website)}" target="_blank" rel="noopener">Visit website</a></div>`);
    }
    contactEl.innerHTML = rows.join('');

    const hoursWrap = document.getElementById('alleyDetailSheetHoursWrap');
    const hoursEl = document.getElementById('alleyDetailSheetHours');
    if (details.hoursText && details.hoursText.length){
      // Google's weekdayDescriptions array is always Monday-first; JS's Date.getDay() is
      // Sunday-first (0=Sunday), so shift by 1 (with wraparound) to find today's matching row.
      const jsDay = new Date().getDay();
      const todayIndex = jsDay === 0 ? 6 : jsDay - 1;
      hoursEl.innerHTML = details.hoursText.map((line, i) =>
        `<div class="hours-row ${i===todayIndex?'today':''}">${escapeHtml(line)}</div>`
      ).join('');
      hoursWrap.style.display = '';
    } else {
      hoursWrap.style.display = 'none';
    }
  }
};

const LaneFinder = {
  radiusMiles: 10,
  lastResults: null, // cached so switching the radius filter re-filters instantly without a new API call
  lastCoords: null,
  resultsById: {}, // keyed lookup so the detail sheet can find a result's basic info by id without re-searching

  init(){
    const toggle = document.getElementById('laneFinderRadiusToggle');
    if (toggle){
      toggle.querySelectorAll('.ctx-btn').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          toggle.querySelectorAll('.ctx-btn').forEach(b=>b.classList.remove('active'));
          btn.classList.add('active');
          this.radiusMiles = parseInt(btn.dataset.radius);
          this.renderResults(); // re-filter from cache, no new API call needed
        });
      });
    }
    const btnRefresh = document.getElementById('btnRefreshLaneFinder');
    if (btnRefresh){
      btnRefresh.addEventListener('click', ()=> this.search());
    }
    const listEl = document.getElementById('laneFinderList');
    if (listEl){
      listEl.addEventListener('click', (e)=>{
        const card = e.target.closest('.lane-card[data-place-id]');
        if (card) AlleyDetailSheet.open(card.dataset.placeId);
      });
    }
  },

  // Called when the Lane Finder view is opened — searches fresh each time the page is visited,
  // since the person may have moved since their last visit and a stale list would be misleading.
  onViewShown(){
    this.search();
  },

  async search(){
    const statusEl = document.getElementById('laneFinderStatus');
    const listEl = document.getElementById('laneFinderList');
    if (!statusEl || !listEl) return;

    if (typeof AlleyDetect === 'undefined' || !AlleyDetect.proxyUrl){
      statusEl.textContent = 'Add your proxy URL in Settings → Location Features to use Lane Finder (see SETUP.md).';
      listEl.innerHTML = '';
      return;
    }
    if (!('geolocation' in navigator)){
      statusEl.textContent = 'This browser does not support location — Lane Finder needs it to find alleys near you.';
      listEl.innerHTML = '';
      return;
    }

    statusEl.textContent = 'Finding your location…';
    listEl.innerHTML = '';

    let coords;
    try{
      coords = await AlleyDetect.getCurrentPosition();
    } catch(e){
      statusEl.textContent = '✗ ' + (e.message || 'Could not get your location.');
      return;
    }

    statusEl.textContent = 'Searching for bowling alleys nearby…';
    let places;
    try{
      places = await AlleyDetect.searchWideArea(coords.latitude, coords.longitude);
    } catch(e){
      statusEl.textContent = '✗ ' + (e.message || 'The search failed.');
      return;
    }

    this.lastResults = places.map(p => Object.assign({}, p, {
      distance: distanceMiles(coords.latitude, coords.longitude, p.lat, p.lng)
    })).sort((a,b) => a.distance - b.distance);
    this.lastCoords = coords;
    this.resultsById = {};
    this.lastResults.forEach(p => { if (p.id) this.resultsById[p.id] = p; });

    this.renderResults();
  },

  renderResults(){
    const statusEl = document.getElementById('laneFinderStatus');
    const listEl = document.getElementById('laneFinderList');
    if (!statusEl || !listEl || !this.lastResults) return;

    const filtered = this.lastResults.filter(p => p.distance <= this.radiusMiles);

    // The Places API itself can't search beyond ~31 miles (its own documented 50km cap) — so if
    // someone picks the 50 mi filter, be upfront that results are limited to whatever the API's
    // search radius actually reached, rather than implying a true 50-mile search happened.
    const apiCapNote = this.radiusMiles > 31
      ? ' (results limited to ~31 miles — the maximum search radius Google\'s Places API allows)'
      : '';

    if (!filtered.length){
      statusEl.textContent = `No bowling alleys found within ${this.radiusMiles} miles${apiCapNote}.`;
      listEl.innerHTML = '';
      return;
    }

    statusEl.textContent = `${filtered.length} alley${filtered.length===1?'':'s'} found within ${this.radiusMiles} miles${apiCapNote}.`;
    listEl.innerHTML = filtered.map(p => this.cardHTML(p)).join('');
  },

  cardHTML(p){
    const ratingHTML = p.rating != null
      ? `<div class="lane-card-row"><span class="icon">★</span><span class="lane-card-rating">${p.rating.toFixed(1)}</span>${p.ratingCount!=null ? ` <span style="opacity:0.7;">(${p.ratingCount})</span>` : ''}</div>`
      : '';
    const addressHTML = p.address
      ? `<div class="lane-card-row"><span class="icon">📍</span>${escapeHtml(p.address)}</div>`
      : '';
    const tappable = !!p.id;
    return `
      <div class="lane-card ${tappable?'tappable':''}" ${tappable?`data-place-id="${escapeHtml(p.id)}"`:''}>
        <div class="lane-card-name">${escapeHtml(p.name)}</div>
        <div class="lane-card-row"><span class="icon">🚗</span><span class="lane-card-distance">${p.distance.toFixed(1)} mi away</span></div>
        ${addressHTML}
        ${ratingHTML}
      </div>
    `;
  }
};

// Simple, dependency-free string similarity (normalized token overlap + substring bonus).
// Not as precise as a proper edit-distance library, but sufficient for matching casual name
// variations like "Thunderbird Lanes" vs "Thunderbird Bowling Lanes" without adding a dependency.
// Used by AlleyDetect.findOrCreateAlley, not LaneFinder.
function stringSimilarity(a, b){
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const tokensA = new Set(na.split(/\s+/));
  const tokensB = new Set(nb.split(/\s+/));
  const intersection = [...tokensA].filter(t => tokensB.has(t));
  const union = new Set([...tokensA, ...tokensB]);
  return union.size ? intersection.length / union.size : 0;
}
