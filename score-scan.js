// ======================================================================
// ScoreScan — photograph a bowling monitor/scoresheet and extract scores
// via the Anthropic API's vision capability. Uses the user's own API key,
// stored only in localStorage, sent only to api.anthropic.com.
// ======================================================================

const SCAN_KEY_STORAGE = 'pinboard_anthropic_key';

const SCAN_PROMPT = `You are reading a photo of a bowling scoring display (either an electronic monitor/screen at a bowling alley, or a paper scoresheet). Extract the frame-by-frame data for ONE bowler's ONE game.

Bowling scoring basics for reference:
- 10 frames per game. Frames 1-9 have up to 2 balls each. Frame 10 has up to 3 balls if there's a strike or spare.
- A strike (all 10 pins on the first ball of a frame) is often shown as "X".
- A spare (remaining pins cleared on the second ball) is often shown as "/".
- A gutter ball / miss is often shown as "-" or "0".
- Electronic monitors typically show a grid: small boxes at the top of each frame for individual ball values, and a larger running cumulative score below each frame.

If multiple bowlers/lanes are visible in the photo, extract only the FIRST or clearly highlighted/active bowler's row — if you cannot confidently tell which row to use, say so in "notes" and still return your best guess for the most prominent row.

Respond with ONLY raw JSON (no markdown fences, no commentary), matching exactly this shape:
{
  "confidence": "high" | "medium" | "low",
  "total": <integer, the final cumulative score, or null if unreadable>,
  "frames": [
    {"b1": <integer 0-10 or null>, "b2": <integer 0-10 or null>, "b3": null},
    ... (9 frames like the above) ...,
    {"b1": <integer 0-10 or null>, "b2": <integer 0-10 or null>, "b3": <integer 0-10 or null, only for frame 10>}
  ],
  "notes": "<any ambiguity, e.g. 'multiple lanes visible, used leftmost' or 'frame 7 second ball unclear'>"
}

Rules for ball values:
- Convert "X" to 10.
- Convert "/" to the number of pins that completes 10 for that frame (e.g. if ball 1 was 7, "/" becomes 3).
- If a value is genuinely not visible or the image is too unclear for a specific ball, use null for that ball rather than guessing.
- frames array must have exactly 10 entries.
- Return valid JSON only — it will be parsed programmatically.`;

const ScoreScan = {
  apiKey: null,

  init(){
    this.apiKey = localStorage.getItem(SCAN_KEY_STORAGE) || null;
    this.updateKeyUI();

    document.getElementById('btnSaveApiKey').addEventListener('click', ()=>{
      const val = document.getElementById('inputApiKey').value.trim();
      if (!val){ toast('Enter a key first'); return; }
      if (!val.startsWith('sk-ant-')){
        if (!confirm('That doesn\'t look like a typical Anthropic key (usually starts with "sk-ant-"). Save anyway?')) return;
      }
      localStorage.setItem(SCAN_KEY_STORAGE, val);
      this.apiKey = val;
      document.getElementById('inputApiKey').value = '';
      this.updateKeyUI();
      toast('API key saved');
    });

    document.getElementById('btnClearApiKey').addEventListener('click', ()=>{
      localStorage.removeItem(SCAN_KEY_STORAGE);
      this.apiKey = null;
      this.updateKeyUI();
      toast('API key removed');
    });

    document.getElementById('btnScanScore').addEventListener('click', ()=>{
      if (!this.apiKey){
        toast('Add an API key in Settings first');
        Views.show('settings');
        return;
      }
      // The main scan button always targets the first game; per-game "Scan this game"
      // links (shown when a session has multiple games) set scanTargetIndex explicitly
      // before triggering this same file input.
      if (typeof AddSheet !== 'undefined') AddSheet.scanTargetIndex = 0;
      document.getElementById('scanFileInput').value = '';
      document.getElementById('scanFileInput').click();
    });

    document.getElementById('scanFileInput').addEventListener('change', (e)=>{
      const file = e.target.files && e.target.files[0];
      if (file) this.handleImage(file);
    });
  },

  updateKeyUI(){
    const status = document.getElementById('scanKeyStatus');
    if (this.apiKey){
      const masked = this.apiKey.slice(0,10) + '···' + this.apiKey.slice(-4);
      status.textContent = 'Ready — using key ' + masked;
    } else {
      status.textContent = 'Not set up — add an API key to scan photos';
    }
  },

  async handleImage(file){
    const statusEl = document.getElementById('scanStatus');
    const btn = document.getElementById('btnScanScore');
    statusEl.style.display = 'flex';
    statusEl.className = 'scan-status';
    statusEl.innerHTML = `<span class="spinner" style="border-color:var(--maple-dim); border-top-color:transparent;"></span> Reading photo…`;
    btn.disabled = true;

    try{
      const { base64, mediaType } = await this.fileToBase64(file);
      const result = await this.callVisionApi(base64, mediaType);

      if (result.total == null && (!result.frames || result.frames.every(f=>f.b1==null))){
        statusEl.className = 'scan-status error';
        statusEl.textContent = 'Couldn\'t read a score from that photo. Try a closer, well-lit shot of the frame grid.';
        btn.disabled = false;
        return;
      }

      AddSheet.applyScanResult(result);

      const confidenceNote = result.confidence === 'low' ? ' (low confidence — check carefully)' :
                              result.confidence === 'medium' ? ' (double-check the highlighted frames)' : '';
      statusEl.className = 'scan-status success';
      statusEl.textContent = 'Scanned' + confidenceNote + (result.notes ? ' — ' + result.notes : '');
    } catch(e){
      console.error(e);
      statusEl.className = 'scan-status error';
      statusEl.textContent = e.message || 'Scan failed — check your API key and connection.';
    } finally {
      btn.disabled = false;
    }
  },

  fileToBase64(file){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        const result = reader.result; // data:image/jpeg;base64,....
        const match = /^data:(.+);base64,(.*)$/.exec(result);
        if (!match){ reject(new Error('Could not read image file')); return; }
        resolve({ mediaType: match[1], base64: match[2] });
      };
      reader.onerror = ()=> reject(new Error('Could not read image file'));
      reader.readAsDataURL(file);
    });
  },

  async callVisionApi(base64, mediaType){
    const allowedTypes = ['image/jpeg','image/png','image/webp','image/gif'];
    const finalMediaType = allowedTypes.includes(mediaType) ? mediaType : 'image/jpeg';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: finalMediaType, data: base64 } },
            { type: 'text', text: SCAN_PROMPT }
          ]
        }]
      })
    });

    if (res.status === 401){
      throw new Error('API key rejected — check it in Settings.');
    }
    if (res.status === 429){
      throw new Error('Rate limited — wait a moment and try again.');
    }
    if (!res.ok){
      const body = await res.text().catch(()=> '');
      throw new Error('API error ' + res.status + (body ? ': ' + body.slice(0,150) : ''));
    }

    const data = await res.json();
    const textBlock = (data.content || []).find(c => c.type === 'text');
    if (!textBlock) throw new Error('No response from vision model.');

    let cleaned = textBlock.text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    let parsed;
    try{
      parsed = JSON.parse(cleaned);
    } catch(e){
      throw new Error('Could not parse the scan result. Try again with a clearer photo.');
    }

    if (parsed.frames && Array.isArray(parsed.frames)){
      parsed.frames = parsed.frames.slice(0,10).map(f => ({
        b1: normalizePinCount(f.b1), b2: normalizePinCount(f.b2), b3: normalizePinCount(f.b3)
      }));
      while (parsed.frames.length < 10) parsed.frames.push({b1:null,b2:null,b3:null});
    }
    if (typeof parsed.total !== 'number') parsed.total = null;

    return parsed;
  }
};
