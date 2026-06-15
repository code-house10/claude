(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = {
    subtitles: [],
    activeIndex: -1,
    lastIndex: -1,
    lastWordIndex: -1,
    playerType: 'none',
    yt: null,
    ytReady: false,
    hls: null,
    offset: Number(localStorage.getItem('jm_sync') || 0),
    speed: Number(localStorage.getItem('jm_speed') || 1),
    autoPause: false,
    repeatStart: -1,
    repeatEnd: -1,
    repeatGuardUntil: 0,
    repeatWaiting: false,
    repeatTimer: null,
    repeatDelaySeconds: Math.min(5, Math.max(1, Number(localStorage.getItem('jm_repeat_delay') || 1))),
    listCenter: 0,
    renderRadius: 28,
    savedWords: readJSON('jm_saved_words', []),
    savedLines: readJSON('jm_saved_lines', []),
    currentDictWord: '',
    currentDictExamples: [],
    saveTimer: null,
    syncTicker: null,
    cloudClient: null,
    cloudLessons: [],
    cloudSyncTimer: null,
    cloudSyncInProgress: false,
    cloudSyncPending: false,
    cloudLastSyncAt: localStorage.getItem('jm_cloud_last_sync_at') || '',
    reviewQueue: [],
    reviewIndex: 0,
    reviewRevealed: false,
    isSeeking: false,
    seekGuardUntil: 0,
    lastSeekTarget: 0,
    lastSeekSubtitleTime: 0,
    hlsReady: false,
    videoBlobUrl: '',
    usingCachedVideo: false,
    cacheDbPromise: null,
    // High-frequency vocabulary highlighting
    highlightHF: localStorage.getItem('jm_highlight_hf') !== '0',
    hfWords: null,     // Set of high-frequency words (top 3000 minus A1 stopwords)
    hfCount: 0,        // distinct high-frequency (purple) words in the current file
    cefrAdv: null,     // { word: 'B1'|'B2'|'C1'|'C2' } — advanced CEFR words
    advCount: 0,       // distinct advanced (orange) words in the current file
    savedWordSet: null,// Set of stems for already-saved words/phrases
    savedCount: 0,     // distinct already-saved words in the current file (pink)
    // Pro video cache + failover
    coverageHit: new Set(),     // URLs that already crossed the auto-cache threshold this session
    autoCacheBusy: false,       // dedupe parallel auto-cache attempts
    failoverTried: new Set(),   // URLs we've already tried to swap to cache after an error
    // Lesson tag — used to group saved items into per-movie review decks.
    lessonTitle: localStorage.getItem('jm_lesson_title') || '',
    reviewDeck: null            // active deck filter inside Review cards
  };

  const el = {
    movie: $('moviePlayer'), videoBox: $('videoBox'), emptyVideo: $('emptyVideo'), ytHost: $('ytHost'),
    subtitleDock: $('subtitleDock'), dockEn: $('dockEn'), dockAr: $('dockAr'), statusText: $('statusText'),
    subtitleList: $('subtitleList'), listInfo: $('listInfo'), menuSheet: $('menuSheet'), menuStatus: $('menuStatus'),
    syncValue: $('syncValue'), speedBtn: $('speedBtn'), autoPauseBtn: $('autoPauseBtn'), repeatDelayValue: $('repeatDelayValue'), toast: $('toast')
  };

  function readJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } }
  function writeJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function debounceSave() { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveState, 700); }
  function saveState() {
    localStorage.setItem('jm_subtitles', JSON.stringify(state.subtitles));
    localStorage.setItem('jm_sync', String(state.offset));
    localStorage.setItem('jm_speed', String(state.speed));
    localStorage.setItem('jm_repeat_delay', String(state.repeatDelaySeconds));
    // Keep last lesson open on next visit. Browser blob: URLs cannot be restored after reload,
    // so only permanent video links are saved automatically.
    localStorage.setItem('jm_video_url', state.videoUrl && !String(state.videoUrl).startsWith('blob:') ? state.videoUrl : '');
    localStorage.setItem('jm_last_lesson_saved_at', new Date().toISOString());
    writeJSON('jm_saved_words', state.savedWords);
    writeJSON('jm_saved_lines', state.savedLines);
  }
  function toast(msg) { clearTimeout(window.__toastTimer); el.toast.textContent = msg; el.toast.classList.remove('hidden'); window.__toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 1800); }
  function setStatus(msg) { el.statusText.textContent = msg; if (el.menuStatus) el.menuStatus.textContent = msg; }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function plainText(html) { const d = document.createElement('div'); d.innerHTML = html || ''; return (d.textContent || d.innerText || '').replace(/\s+/g, ' ').trim(); }
  function cleanLine(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
  function shouldIgnoreSubtitle(text) { const t = cleanLine(text); return !t || /\[[^\]]+\]/.test(t); }
  function formatTime(sec) { sec = Math.max(0, Number(sec) || 0); const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s = Math.floor(sec%60); return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`; }
  function parseTime(t) { if (!t) return 0; const p = String(t).replace(',', '.').trim().split(':').map(Number); if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2]; if (p.length === 2) return p[0]*60 + p[1]; return p[0] || 0; }
  function secondsToSrtTime(total) { const ms = Math.round((total - Math.floor(total)) * 1000); const t = Math.max(0, Math.floor(total)); const h = Math.floor(t/3600); const m = Math.floor((t%3600)/60); const s = t%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`; }
  function tokenize(text) { return cleanLine(text).match(/[A-Za-zÀ-ÿ0-9]+(?:[-'][A-Za-zÀ-ÿ0-9]+)*/g) || []; }

  // Friendly lesson tag derived from a URL path or filename. Drops query
  // strings and extensions, decodes %20, trims to a reasonable length.
  function deriveLessonTitle(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    try {
      const u = raw.startsWith('http') ? new URL(raw) : null;
      const base = (u ? u.pathname.split('/').filter(Boolean).pop() : raw.split(/[\\/]/).pop()) || '';
      const dec = decodeURIComponent(base).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._-]+/g, ' ').trim();
      return dec.slice(0, 80) || (u ? u.hostname : raw);
    } catch { return raw.slice(0, 80); }
  }

  function setLessonTitle(title) {
    const t = cleanLine(title);
    if (!t) return;
    state.lessonTitle = t;
    try { localStorage.setItem('jm_lesson_title', t); } catch {}
  }
  function playphraseUrl(q) { return `https://www.playphrase.me/#/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}`; }
  function openPlayPhrase(q) { if (!q) return; window.open(playphraseUrl(q), '_blank', 'noopener,noreferrer'); }

  const PHRASAL_PARTICLES = new Set(['up','out','off','on','in','down','over','away','back','around','through','about','along','across','after','by','forward','together']);
  const COMMON_PHRASES = [
    'work out','figure out','find out','look up','look after','look for','look forward to','give up','give in','give back',
    'get down','get up','get out','get in','get over','get away','get away with','get back','get through','get along',
    'take off','take out','take over','take back','take down','pick up','put down','put up','put up with','come up','come up with',
    'turn out','turn up','turn down','turn off','turn on','go on','go off','go back','go through','break down','break up',
    'make up','make out','bring up','bring back','set up','hold on','keep up','keep on','keep out','keep away',
    'keep my head down','keep your head down','keep his head down','keep her head down','keep their head down',
    'fucked up','fuck up','mess up','calm down','slow down','knock it down','pay back','leave out','left out'
  ];
  const IRREGULAR_BASE = { worked:'work', working:'work', works:'work', figured:'figure', figuring:'figure', figures:'figure', found:'find', finding:'find', finds:'find', looked:'look', looking:'look', looks:'look', gave:'give', given:'give', giving:'give', gives:'give', got:'get', gotten:'get', getting:'get', gets:'get', took:'take', taken:'take', taking:'take', takes:'take', picked:'pick', picking:'pick', picks:'pick', put:'put', putting:'put', puts:'put', came:'come', coming:'come', comes:'come', turned:'turn', turning:'turn', turns:'turn', went:'go', gone:'go', going:'go', goes:'go', broke:'break', broken:'break', breaking:'break', breaks:'break', made:'make', making:'make', makes:'make', brought:'bring', bringing:'bring', brings:'bring', set:'set', setting:'set', sets:'set', held:'hold', holding:'hold', holds:'hold', kept:'keep', keeping:'keep', keeps:'keep', fucked:'fuck', fucking:'fuck', fucks:'fuck', messed:'mess', messing:'mess', messes:'mess', paid:'pay', paying:'pay', pays:'pay', left:'leave', leaving:'leave', leaves:'leave' };

  function baseVerb(token) {
    const t = String(token || '').toLowerCase();
    if (IRREGULAR_BASE[t]) return IRREGULAR_BASE[t];
    if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
    if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
    if (t.length > 4 && t.endsWith('s')) return t.slice(0, -1);
    return t;
  }

  // ════════════════════════════════════════════════════════════════
  // HIGH-FREQUENCY VOCABULARY HIGHLIGHTING
  //
  // When a subtitle file loads we highlight every word that belongs to the
  // top ~3000 most frequent English words, EXCEPT the trivial A1 function
  // words (the, a, an, of, with, …) which a learner already knows. This
  // focuses attention on the high-value vocabulary worth learning.
  //
  // The 3000-word list is the well-known Google Trillion-Word frequency list
  // (first20hours/google-10000-english, MIT), fetched once from jsDelivr and
  // cached in localStorage so it works offline afterwards. A small built-in
  // fallback covers the very first load if the device is offline.
  // ════════════════════════════════════════════════════════════════

  // Trivial A1 words to EXCLUDE from highlighting (already known by the learner).
  const A1_STOPWORDS = new Set([
    'the','a','an','and','or','but','so','if','then','than','as','because','while',
    'i','you','he','she','it','we','they','me','him','her','us','them',
    'my','your','his','its','our','their','mine','yours','hers','ours','theirs',
    'this','that','these','those','here','there',
    'is','am','are','was','were','be','been','being','do','does','did','done',
    'have','has','had','will','would','shall','should','can','could','may','might','must',
    'of','to','in','on','at','by','for','with','from','into','onto','off','out','up','down',
    'over','under','about','above','below','between','through','during','before','after',
    'not','no','yes','nor','too','very','just','only','also','even','still','again',
    'all','any','some','each','every','both','few','more','most','many','much','such','own',
    'one','two','three','four','five','six','seven','eight','nine','ten','zero','first','second',
    'who','whom','whose','which','what','when','where','why','how',
    'now','today','yes','ok','okay','well','oh','hey','hi','hello','bye',
    'am','pm','mr','mrs','ms','dr',
    "i'm","you're","he's","she's","it's","we're","they're","i've","you've","we've","they've",
    "don't","doesn't","didn't","won't","can't","couldn't","wouldn't","shouldn't","isn't","aren't","wasn't","weren't",
    "i'll","you'll","he'll","she'll","we'll","they'll","i'd","you'd","let's","that's","there's","what's","here's",
    'a','an','the','get','got','go','went','come','came','make','made','let'
  ]);

  // Small offline-first fallback so highlighting works before the full list
  // is fetched (or if the device is offline on the very first run).
  const HF_FALLBACK = ('people time year work day man woman child world life hand part eye place week '
    + 'case point government company number group problem fact money story friend family house home water '
    + 'room mother father parent boy girl school book student teacher country city week month morning night '
    + 'job business job market service idea question reason word name area body health power history team game '
    + 'minute hour moment level office word voice line war history party result change study food car door '
    + 'face name news age law door member car music sense field paper space term value music police picture '
    + 'feel become leave bring begin keep hold write stand hear let mean set meet pay sit speak run move live '
    + 'believe happen carry talk include continue learn change lead understand watch follow stop create speak '
    + 'read spend grow open walk win teach offer remember consider appear buy serve send build stay fall reach '
    + 'remain suggest raise pass sell require report decide pull return explain hope develop carry break receive '
    + 'agree support hit produce eat cover catch draw choose cause point listen realize push wait '
    + 'good new first last long great little own other old right big high different small large next early young '
    + 'important few public bad same able human local sure better best free true low late hard strong special clear '
    + 'recent certain personal open red difficult available likely short single medium past current happy serious '
    + 'ready simple left physical general environmental financial blue democratic dark various entire close legal '
    + 'religious cold final main green nice huge popular traditional cultural angry hungry tired afraid quick slow '
    + 'busy beautiful dangerous famous funny kind quiet rich safe scared sorry strange wrong heavy light deep wide '
    + 'really actually probably already however usually finally especially simply quickly slowly suddenly together '
    + 'almost enough nearly perhaps quite rather hardly exactly clearly mostly nearly').split(/\s+/);

  const HF_SOURCE = 'https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@master/google-10000-english-no-swears.txt';
  const HF_CACHE_KEY = 'jm_hf3000_words';
  const HF_LIMIT = 3000;

  function buildHfSet(words) {
    const set = new Set();
    for (const raw of words) {
      const w = String(raw || '').toLowerCase().trim();
      if (!w || w.length < 3) continue;     // skip 1–2 letter tokens
      if (A1_STOPWORDS.has(w)) continue;    // skip trivial A1 words
      set.add(w);
    }
    return set;
  }

  // Prefer the user's own bundled vocabulary (vocab-data.js → window.JM_VOCAB):
  // a curated CEFR-graded 3000+ word list with Arabic meanings, plus connected-
  // speech reductions. When present it becomes the authoritative, fully-offline
  // source for highlighting, dictionary meanings and the connected-speech guide,
  // so we skip the external jsDelivr fetches entirely.
  function initLocalVocab() {
    if (state.vocabReady) return true;
    const V = window.JM_VOCAB;
    if (!V || !V.cefr) return false;

    // Highlighting sources
    state.cefrLevels = V.cefr;                          // { word: 'A1'..'C2' }
    state.hfWords = new Set(Object.keys(V.cefr));       // all graded words = high-frequency set
    const adv = {};
    for (const [w, lv] of Object.entries(V.cefr)) {
      if (lv === 'B1' || lv === 'B2' || lv === 'C1' || lv === 'C2') adv[w] = lv;
    }
    state.cefrAdv = adv;

    // Instant offline Arabic meanings  { word: {ar,pos,level} }
    state.meanings = V.meanings || {};

    // Connected-speech reductions
    state.reductions = Array.isArray(V.reductions) ? V.reductions : [];
    state.reductionPatterns = Array.isArray(V.patterns) ? V.patterns : [];
    state.reductionByForm = new Map();
    state.reductionForms = new Set();
    for (const r of state.reductions) {
      // index by the connected form(s), tokenised the same way the renderer splits words
      const forms = String(r.connected || '').split('/').map(s => s.trim()).filter(Boolean);
      for (const f of forms) {
        const key = f.toLowerCase().replace(/[^a-z']/g, '').replace(/^'+|'+$/g, '');
        if (key.length >= 2) { state.reductionForms.add(key); if (!state.reductionByForm.has(key)) state.reductionByForm.set(key, r); }
      }
    }
    state.vocabReady = true;
    return true;
  }

  async function loadHighFreqWords() {
    if (initLocalVocab()) return state.hfWords;
    if (state.hfWords) return state.hfWords;
    // 1) cached list from a previous session
    try {
      const cached = localStorage.getItem(HF_CACHE_KEY);
      if (cached) {
        const arr = JSON.parse(cached);
        if (Array.isArray(arr) && arr.length) { state.hfWords = buildHfSet(arr); return state.hfWords; }
      }
    } catch {}
    // 2) fetch the canonical frequency list once, then cache it
    try {
      const res = await fetch(HF_SOURCE);
      if (res.ok) {
        const text = await res.text();
        const words = text.split(/\s+/).filter(Boolean).slice(0, HF_LIMIT);
        if (words.length > 500) {
          try { localStorage.setItem(HF_CACHE_KEY, JSON.stringify(words)); } catch {}
          state.hfWords = buildHfSet(words);
          return state.hfWords;
        }
      }
    } catch (e) { console.warn('High-frequency list fetch failed, using built-in fallback:', e); }
    // 3) offline fallback
    state.hfWords = buildHfSet(HF_FALLBACK);
    return state.hfWords;
  }

  // True when a token is a high-frequency learning word (and highlighting is on).
  function isHighFreqWord(token) {
    if (!state.highlightHF || !state.hfWords) return false;
    const t = String(token || '').toLowerCase();
    if (!t || t.length < 3 || A1_STOPWORDS.has(t)) return false;
    if (state.hfWords.has(t)) return true;
    const b = baseVerb(t);
    return b !== t && state.hfWords.has(b);
  }

  // ───────── CEFR B1–C2 advanced layer ─────────
  // On top of the high-frequency highlight, words that are also CEFR level
  // B1/B2/C1/C2 get a distinct ORANGE highlight — these are the high-value
  // words worth actively learning (e.g. recommend / recommendation). The
  // condition is that the word is ALSO a high-frequency word.
  //
  // Source: the open CEFR-J (A1–B2) + Octanove (C1–C2) vocabulary profiles.
  // We keep only B1+ entries, cache them, and intersect with the HF set.

  const CEFR_SOURCES = [
    'https://cdn.jsdelivr.net/gh/openlanguageprofiles/olp-en-cefrj@master/cefrj-vocabulary-profile-1.5.csv',
    'https://cdn.jsdelivr.net/gh/openlanguageprofiles/olp-en-cefrj@master/octanove-vocabulary-profile-c1c2-1.0.csv'
  ];
  const CEFR_CACHE_KEY = 'jm_cefr_adv_v1';
  const CEFR_RANK = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

  async function loadCefrAdvanced() {
    if (initLocalVocab()) return state.cefrAdv;
    if (state.cefrAdv) return state.cefrAdv;
    try {
      const c = localStorage.getItem(CEFR_CACHE_KEY);
      if (c) { const o = JSON.parse(c); if (o && typeof o === 'object') { state.cefrAdv = o; return o; } }
    } catch {}
    const map = {};
    let ok = false;
    for (const url of CEFR_SOURCES) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const text = await res.text();
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          const cells = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
          const level = cells.find(c => /^[abc][12]$/i.test(c));
          if (!level) continue;
          const lv = level.toUpperCase();
          if (lv === 'A1' || lv === 'A2') continue;     // keep B1+ only
          const head = cells.find(c => /^[a-zA-Z][a-zA-Z' -]*$/.test(c) && c.length > 1 && !/^[abc][12]$/i.test(c));
          if (!head) continue;
          const w = head.toLowerCase().trim();
          if (!w || w.length < 3) continue;
          if (!map[w] || CEFR_RANK[lv] < CEFR_RANK[map[w]]) map[w] = lv; // keep easiest level
          ok = true;
        }
      } catch (e) { console.warn('CEFR list fetch failed:', url, e); }
    }
    if (ok) { try { localStorage.setItem(CEFR_CACHE_KEY, JSON.stringify(map)); } catch {} state.cefrAdv = map; return map; }
    state.cefrAdv = {};   // empty → fall back to the heuristic below
    return state.cefrAdv;
  }

  // Candidate stems so derived forms match a base/headword entry
  // (recommendation → recommend, happily → happy, information → inform…).
  function derivationalStems(token) {
    const t = String(token || '').toLowerCase();
    const out = new Set([t, baseVerb(t)]);
    const rules = [
      [/(.{3,})ations?$/, '$1'], [/(.{3,})ations?$/, '$1ate'],
      [/(.{3,})tions?$/, '$1t'], [/(.{3,})sions?$/, '$1d'],
      [/(.{3,})ments?$/, '$1'], [/(.{3,})ness$/, '$1'],
      [/(.{3,})ities$/, '$1ity'], [/(.{3,})ity$/, '$1'],
      [/(.{3,})ously$/, '$1ous'], [/(.{3,})ous$/, '$1'],
      [/(.{3,})ively$/, '$1ive'], [/(.{3,})ive$/, '$1'],
      [/(.{3,})ically$/, '$1ic'], [/(.{3,})ally$/, '$1al'], [/(.{3,})ally$/, '$1'],
      [/(.{4,})ly$/, '$1'], [/(.{3,})ers?$/, '$1'],
      [/(.{3,})ance$/, '$1'], [/(.{3,})ence$/, '$1'],
      [/(.{3,})able$/, '$1'], [/(.{3,})ible$/, '$1'],
      [/(.{3,})ier$/, '$1y'], [/(.{3,})iest$/, '$1y'], [/(.{3,})ily$/, '$1y']
    ];
    for (const [re, rep] of rules) { if (re.test(t)) out.add(t.replace(re, rep)); }
    return [...out].filter(w => w && w.length >= 3);
  }

  // High-frequency membership that also accepts derived forms.
  function isHfLemma(token) {
    if (!state.hfWords) return false;
    for (const c of derivationalStems(token)) if (state.hfWords.has(c)) return true;
    return false;
  }

  // CEFR level (B1+) for a token via its stems, or '' if not advanced/unknown.
  function cefrLevelOf(token) {
    const map = state.cefrAdv;
    if (!map) return '';
    for (const c of derivationalStems(token)) { if (map[c]) return map[c]; }
    return '';
  }

  function heuristicAdvanced(t) {
    // Offline fallback: HF words that look morphologically advanced.
    return t.length >= 8 || /(?:tion|sion|ment|ness|ity|ous|ive|ance|ence|ical|ize|ise|ate|ify)$/.test(t);
  }

  // Returns the reduction key (e.g. 'gonna') if a token is a connected-speech
  // reduced form, else ''. Used to highlight + explain fast-speech forms.
  function reductionKey(token) {
    if (!state.highlightHF || !state.reductionForms) return '';
    const t = String(token || '').toLowerCase().replace(/[^a-z']/g, '').replace(/^'+|'+$/g, '');
    return state.reductionForms.has(t) ? t : '';
  }

  // Orange tier: high-frequency AND CEFR B1–C2 (the words worth learning).
  function isAdvancedWord(token) {
    if (!state.highlightHF) return false;
    const t = String(token || '').toLowerCase();
    if (!t || t.length < 3 || A1_STOPWORDS.has(t)) return false;
    if (!isHfLemma(t)) return false;                       // must be high-frequency
    if (state.cefrAdv && Object.keys(state.cefrAdv).length) return !!cefrLevelOf(t);
    return heuristicAdvanced(t);                           // offline fallback
  }

  // ───────── Already-saved tier (pink) ─────────
  // Rebuilds a Set of stems for every word/phrase the user has saved so each
  // recurrence (or derived form: recommend → recommendation) lights up as
  // pink in subtitles. Templates are excluded — they're patterns, not lemmas.
  function rebuildSavedWordSet() {
    const set = new Set();
    for (const w of (state.savedWords || [])) {
      if (!w?.word || w.kind === 'template') continue;
      const norm = String(w.word).toLowerCase().trim();
      if (!norm) continue;
      // Collect every constituent token (handles single words AND phrases),
      // then expand each with stem + derivational forms so inflected hits match.
      const tokens = norm.match(/[a-z0-9']+/g) || [];
      for (const t of tokens) {
        if (t.length < 2) continue;
        set.add(t);
        set.add(baseVerb(t));
        for (const s of derivationalStems(t)) set.add(s);
      }
    }
    state.savedWordSet = set;
  }

  function isSavedWord(token) {
    if (!state.savedWordSet || !state.savedWordSet.size) return false;
    const t = String(token || '').toLowerCase();
    if (t.length < 2 || A1_STOPWORDS.has(t)) return false;
    if (state.savedWordSet.has(t)) return true;
    for (const s of derivationalStems(t)) if (state.savedWordSet.has(s)) return true;
    return false;
  }

  // Count distinct highlighted words across the loaded subtitles (for the badge).
  // Mirrors wordHtml's precedence: a word is counted as advanced OR plain-HF,
  // never both.
  function recomputeHfCount() {
    state.hfCount = 0; state.advCount = 0; state.redCount = 0; state.savedCount = 0;
    if (!state.subtitles?.length) return;
    const hf = new Set(), adv = new Set(), red = new Set(), sav = new Set();
    for (const item of state.subtitles) {
      for (const tok of tokenize(item.en)) {
        const t = tok.toLowerCase();
        // Saved words are counted independently of the HF toggle — they're
        // always relevant to the user. The other tiers respect highlightHF.
        if (isSavedWord(t)) { sav.add(baseVerb(t)); continue; }
        if (!state.highlightHF || !state.hfWords) continue;
        const rk = reductionKey(t);
        if (rk) red.add(rk);
        else if (isAdvancedWord(t)) adv.add(t);
        else if (isHighFreqWord(t)) hf.add(state.hfWords.has(t) ? t : baseVerb(t));
      }
    }
    state.hfCount = hf.size;
    state.advCount = adv.size;
    state.redCount = red.size;
    state.savedCount = sav.size;
  }

  // Load both lists, then refresh the UI so highlights + the badge appear.
  function ensureHfThenRefresh() {
    Promise.all([loadHighFreqWords(), loadCefrAdvanced()]).then(() => {
      recomputeHfCount();
      renderList(state.listCenter);
      updateDock(null);
    }).catch(() => {});
  }

  function detectPhrasesInLine(line, clickedWord = '') {
    const lower = cleanLine(line).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const clicked = String(clickedWord || '').toLowerCase();
    const words = lower.match(/[a-z0-9']+/g) || [];
    const found = new Map();
    const add = (phrase, matched = '') => {
      phrase = String(phrase || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!phrase || !phrase.includes(' ')) return;
      if (clicked && !phrase.split(' ').some(w => w === clicked || baseVerb(w) === baseVerb(clicked))) return;
      found.set(phrase, matched || phrase);
    };
    COMMON_PHRASES.forEach(p => {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s+');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(lower)) add(p, p);
    });
    for (let i = 0; i < words.length - 1; i++) {
      const first = baseVerb(words[i]);
      const second = words[i + 1];
      if (PHRASAL_PARTICLES.has(second)) add(`${first} ${second}`, `${words[i]} ${second}`);
    }
    for (let i = 0; i < words.length - 2; i++) {
      const first = baseVerb(words[i]);
      const second = words[i + 1];
      const third = words[i + 2];
      if (PHRASAL_PARTICLES.has(third) || ['with','to','for','of','from','at'].includes(third)) add(`${first} ${second} ${third}`, `${words[i]} ${second} ${third}`);
    }
    return [...found.entries()].map(([phrase, matched]) => ({ phrase, matched }));
  }

  async function translatePhraseInContext(phrase, contextEn = '') {
    phrase = String(phrase || '').trim();
    if (!phrase) return '';
    // Lara is now reserved for subtitle-line translation only.
    // Saved words / phrases use MyMemory so they do not ask for Lara keys.
    try { return await translateMyMemory(phrase); } catch { return ''; }
  }


  const TEMPLATE_RULES = [
    {
      name: 'Repeated warning',
      re: /^how many times have i told you not to (.+?)([?.!]*)$/i,
      build: m => ({
        pattern: 'How many times have I told you not to [do something]?',
        slot: m[1],
        usageEn: 'Use it when you are annoyed because someone keeps doing something you warned them not to do.',
        usageAr: 'تستخدمها عندما تكون منزعجًا لأن شخصًا يكرر شيئًا حذرته منه أكثر من مرة.',
        examples: [
          { en: 'How many times have I told you not to touch my phone?', ar: 'كم مرة قلت لك ألا تلمس هاتفي؟' },
          { en: 'How many times have I told you not to interrupt me?', ar: 'كم مرة قلت لك ألا تقاطعني؟' },
          { en: 'How many times have I told you not to leave the door open?', ar: 'كم مرة قلت لك ألا تترك الباب مفتوحًا؟' }
        ]
      })
    },
    {
      name: 'Shouldn’t you be…?',
      re: /^(?:hey,?\s*)?should(?:n['’]t| not) you be (.+?)([?.!]*)$/i,
      build: m => ({
        pattern: "Shouldn't you be [somewhere / doing something]?",
        slot: m[1],
        usageEn: 'Use it to remind someone of where they should be or what they should be doing now.',
        usageAr: 'تستخدمها لتذكير شخص بالمكان الذي يفترض أن يكون فيه أو الشيء الذي يفترض أن يفعله الآن.',
        examples: [
          { en: "Shouldn't you be at school?", ar: 'ألا يفترض أن تكون في المدرسة؟' },
          { en: "Shouldn't you be getting ready?", ar: 'ألا يفترض أن تكون تستعد؟' },
          { en: "Shouldn't you be working right now?", ar: 'ألا يفترض أن تكون تعمل الآن؟' }
        ]
      })
    },
    {
      name: 'I got some time',
      re: /^(?:nah,?\s*)?i (?:got|have got|have) some time\.?$/i,
      build: () => ({
        pattern: 'I got some time.',
        slot: 'some time',
        usageEn: 'Use it when you want to say you are not in a hurry and have a little free time.',
        usageAr: 'تستخدمها عندما تريد أن تقول إن لديك بعض الوقت ولست مستعجلًا.',
        examples: [
          { en: 'I got some time before class.', ar: 'لدي بعض الوقت قبل الحصة.' },
          { en: 'I got some time if you want to talk.', ar: 'لدي بعض الوقت إذا أردت أن نتكلم.' },
          { en: 'I got some time before the meeting.', ar: 'لدي بعض الوقت قبل الاجتماع.' }
        ]
      })
    },
    {
      name: 'There is something left',
      re: /^(?:there['’]?s|there is|there are)\s+(?:some|any|a little|a few)?\s*(.+?)\s+left(?:\s+(?:on|in|at|for|with)\s+.+?)?([.!?]*)$/i,
      build: m => ({
        pattern: "There's some [thing] left.",
        slot: m[1],
        usageEn: 'Use it when you want to say that a little amount of something still remains.',
        usageAr: 'تستخدمها عندما تريد أن تقول إن هناك كمية بسيطة من شيء ما ما زالت موجودة.',
        examples: [
          { en: "There's some coffee left if you want a cup.", ar: 'باقي شوية قهوة لو تحب كوب.' },
          { en: "There's some pizza left in the fridge.", ar: 'باقي شوية بيتزا في الثلاجة.' },
          { en: "There's some money left after paying the bills.", ar: 'باقي بعض المال بعد دفع الفواتير.' }
        ]
      })
    },
    {
      name: 'Besides, I wanna…',
      re: /^(?:besides,?\s*)?i (?:wanna|want to) (.+?)([.!?]*)$/i,
      build: m => ({
        pattern: 'Besides, I wanna [do something].',
        slot: m[1],
        usageEn: 'Use it to add another reason for what you want to do.',
        usageAr: 'تستخدمها عندما تضيف سببًا آخر لما تريد فعله.',
        examples: [
          { en: 'Besides, I wanna finish this episode.', ar: 'وبعدين أنا عايز أنهي الحلقة دي.' },
          { en: 'Besides, I wanna talk to him first.', ar: 'ثم إنني أريد أن أتحدث معه أولًا.' },
          { en: 'Besides, I wanna make sure everything is okay.', ar: 'وفوق ذلك أريد أن أتأكد أن كل شيء بخير.' }
        ]
      })
    },
    {
      name: 'You like…?',
      re: /^(?:oh,?\s*)?you like (.+?)([?.!]*)$/i,
      build: m => ({
        pattern: 'You like [something]?',
        slot: m[1],
        usageEn: 'Use it in casual conversation when you discover someone likes something.',
        usageAr: 'تستخدمها في الكلام العادي عندما تكتشف أن شخصًا يحب شيئًا ما.',
        examples: [
          { en: 'You like this song?', ar: 'هل تحب هذه الأغنية؟' },
          { en: 'You like horror movies?', ar: 'هل تحب أفلام الرعب؟' },
          { en: 'You like that place?', ar: 'هل يعجبك ذلك المكان؟' }
        ]
      })
    },
    {
      name: 'I love…',
      re: /^i love (.+?)([!.]*)$/i,
      build: m => ({
        pattern: 'I love [something]!',
        slot: m[1],
        usageEn: 'Use it to react strongly and positively to something you really like.',
        usageAr: 'تستخدمها عندما تعبر بحماس أنك تحب شيئًا جدًا.',
        examples: [
          { en: 'I love that idea!', ar: 'أحب هذه الفكرة جدًا!' },
          { en: 'I love this show!', ar: 'أنا أحب هذا البرنامج!' },
          { en: 'I love the way you said that.', ar: 'أحب الطريقة التي قلت بها ذلك.' }
        ]
      })
    },
    {
      name: 'I did everything I could to…',
      re: /^i did everything i could to (.+?)([.!?]*)$/i,
      build: m => ({
        pattern: 'I did everything I could to [do something].',
        slot: m[1],
        usageEn: 'Use it when you want to say you tried your best to make something happen.',
        usageAr: 'تستخدمها عندما تريد أن تقول إنك بذلت كل ما تستطيع لتحقيق شيء ما.',
        examples: [
          { en: 'I did everything I could to help him.', ar: 'فعلت كل ما بوسعي لمساعدته.' },
          { en: 'I did everything I could to fix it.', ar: 'فعلت كل ما بوسعي لإصلاحه.' },
          { en: 'I did everything I could to reach her.', ar: 'فعلت كل ما بوسعي للتواصل معها.' }
        ]
      })
    },
    {
      name: 'By now you have worked out…',
      re: /^(?:and )?i['’]?m sure by now you['’]?ve (?:worked|figured) out (.+?)([.!?]*)$/i,
      build: m => ({
        pattern: "I'm sure by now you've worked out [something].",
        slot: m[1],
        usageEn: 'Use it when you think the other person has already understood or figured something out.',
        usageAr: 'تستخدمها عندما تعتقد أن الشخص الآخر فهم أو استنتج الأمر بالفعل.',
        examples: [
          { en: "I'm sure by now you've worked out the truth.", ar: 'أنا متأكد أنك الآن اكتشفت الحقيقة.' },
          { en: "I'm sure by now you've figured out what happened.", ar: 'أنا متأكد أنك الآن فهمت ما حدث.' },
          { en: "I'm sure by now you've worked out why I left.", ar: 'أنا متأكد أنك الآن عرفت لماذا رحلت.' }
        ]
      })
    }
  ];

  function makeDailyTemplateExamples(pattern, sourceText = '') {
    const p = String(pattern || '').trim();
    const src = cleanLine(sourceText).toLowerCase();
    const lower = p.toLowerCase();

    const pack = arr => arr
      .map(ex => typeof ex === 'string' ? { en: ex, ar: '' } : { en: cleanLine(ex.en || ''), ar: cleanLine(ex.ar || '') })
      .map(ex => ({ ...ex, en: /[.!?]$/.test(ex.en) ? ex.en : ex.en + '.' }))
      .filter(ex => ex.en && /[a-z]/i.test(ex.en) && !looksLikeBadTemplateExample(ex))
      .slice(0, 3);

    if (/there(?:'s| is| are)\s+.*\s+left/i.test(src) || /^there(?:'s| is| are).*\[thing\].*left/i.test(p)) {
      return pack([
        { en: "There's some coffee left if you want a cup.", ar: 'باقي شوية قهوة لو تحب كوب.' },
        { en: "There's some pizza left in the fridge.", ar: 'باقي شوية بيتزا في الثلاجة.' },
        { en: "There's some money left after paying the bills.", ar: 'باقي بعض المال بعد دفع الفواتير.' }
      ]);
    }

    if (/shouldn['’]?t you be/i.test(p)) {
      return pack([
        { en: "Shouldn't you be at work by now?", ar: 'ألا يفترض أن تكون في العمل الآن؟' },
        { en: "Shouldn't you be getting ready for your class?", ar: 'ألا يفترض أن تستعد لحصتك؟' },
        { en: "Shouldn't you be on your way to school?", ar: 'ألا يفترض أن تكون في طريقك إلى المدرسة؟' }
      ]);
    }

    if (/how many times have i told you not to/i.test(p)) {
      return pack([
        { en: 'How many times have I told you not to touch my phone?', ar: 'كم مرة قلت لك ألا تلمس هاتفي؟' },
        { en: 'How many times have I told you not to interrupt me?', ar: 'كم مرة قلت لك ألا تقاطعني؟' },
        { en: 'How many times have I told you not to leave the door open?', ar: 'كم مرة قلت لك ألا تترك الباب مفتوحًا؟' }
      ]);
    }

    if (/\bi got some time\b|\bi have some time\b|\bi have got some time\b/i.test(p)) {
      return pack([
        { en: 'I got some time before class.', ar: 'لدي بعض الوقت قبل الحصة.' },
        { en: 'I got some time if you want to talk.', ar: 'لدي بعض الوقت إذا أردت أن نتكلم.' },
        { en: 'I got some time before the meeting.', ar: 'لدي بعض الوقت قبل الاجتماع.' }
      ]);
    }

    if (/besides,? i (?:wanna|want to)/i.test(lower) || /^besides,?\s*i/i.test(lower)) {
      return pack([
        { en: 'Besides, I wanna finish this episode first.', ar: 'وبعدين أنا عايز أخلص الحلقة دي الأول.' },
        { en: 'Besides, I wanna talk to him before I decide.', ar: 'وفوق ذلك أريد أن أتحدث معه قبل أن أقرر.' },
        { en: 'Besides, I wanna make sure everything is okay.', ar: 'ثم إنني أريد أن أتأكد أن كل شيء بخير.' }
      ]);
    }

    if (/i (?:wanna|want to) \[do something\]/i.test(p)) {
      return pack([
        { en: 'I wanna finish this before I leave.', ar: 'أريد أن أنهي هذا قبل أن أخرج.' },
        { en: 'I wanna talk to you for a minute.', ar: 'أريد أن أتحدث معك لدقيقة.' },
        { en: 'I wanna make sure everything is okay.', ar: 'أريد أن أتأكد أن كل شيء بخير.' }
      ]);
    }

    if (/you like \[something\]/i.test(p)) {
      return pack([
        { en: 'You like this song?', ar: 'هل تعجبك هذه الأغنية؟' },
        { en: 'You like spicy food?', ar: 'هل تحب الأكل الحار؟' },
        { en: 'You like that place?', ar: 'هل يعجبك ذلك المكان؟' }
      ]);
    }

    if (/i love \[something\]/i.test(p)) {
      return pack([
        { en: 'I love this idea!', ar: 'أحب هذه الفكرة جدًا!' },
        { en: 'I love the way you explain things.', ar: 'أحب طريقتك في شرح الأمور.' },
        { en: 'I love that place!', ar: 'أنا أحب ذلك المكان جدًا!' }
      ]);
    }

    if (/i did everything i could to/i.test(p)) {
      return pack([
        { en: 'I did everything I could to help him.', ar: 'فعلت كل ما بوسعي لمساعدته.' },
        { en: 'I did everything I could to fix the problem.', ar: 'فعلت كل ما بوسعي لإصلاح المشكلة.' },
        { en: 'I did everything I could to reach her.', ar: 'فعلت كل ما بوسعي للتواصل معها.' }
      ]);
    }

    if (/i['’]?m sure by now you['’]?ve (?:worked|figured) out/i.test(p)) {
      return pack([
        { en: "I'm sure by now you've figured out what happened.", ar: 'أنا متأكد أنك الآن فهمت ما حدث.' },
        { en: "I'm sure by now you've worked out the truth.", ar: 'أنا متأكد أنك الآن اكتشفت الحقيقة.' },
        { en: "I'm sure by now you've figured out why I left.", ar: 'أنا متأكد أنك الآن عرفت لماذا رحلت.' }
      ]);
    }

    if (/have you got a problem/i.test(p) || /do you have a problem/i.test(p)) {
      return pack([
        { en: 'Have you got a problem with the app?', ar: 'هل لديك مشكلة في التطبيق؟' },
        { en: 'Have you got a problem with that?', ar: 'هل لديك اعتراض على ذلك؟' },
        { en: 'Have you got a problem with me?', ar: 'هل لديك مشكلة معي؟' }
      ]);
    }

    if (/have you got any plans|do you have any plans|have you made any plans/i.test(p)) {
      return pack([
        { en: 'Do you have any plans tonight?', ar: 'هل لديك أي خطط الليلة؟' },
        { en: 'Have you got any plans for the weekend?', ar: 'هل لديك أي خطط لعطلة نهاية الأسبوع؟' },
        { en: 'Have you made any plans for Eid yet?', ar: 'هل رتبت أي خطط للعيد حتى الآن؟' }
      ]);
    }

    // For unknown templates, do NOT create mechanical examples by random word replacement.
    // Bad examples are worse than no examples. The user can use "Generate with OpenRouter AI" to rebuild them with Puter AI, then MyMemory fallback.
    return [];
  }

  function genericTemplateFromLine(line) {
    const text = cleanLine(line).replace(/\s+/g, ' ').trim();
    if (!text || tokenize(text).length < 4) return null;

    if (/^(?:there['’]?s|there is|there are)\s+/i.test(text) && /\bleft\b/i.test(text)) {
      return {
        pattern: "There's some [thing] left.",
        slot: text,
        name: 'There is something left',
        usageEn: 'Use it when you want to say that a little amount of something still remains.',
        usageAr: 'تستخدمها عندما تريد أن تقول إن هناك كمية بسيطة من شيء ما ما زالت موجودة.',
        examples: makeDailyTemplateExamples("There's some [thing] left.", text)
      };
    }

    // Conservative fallback: only save templates when the structure is useful and can produce natural examples.
    // We intentionally avoid weak "first words + [...]" templates because they created incomplete English examples.
    if (/^i\s+(?:wanna|want to)\s+/i.test(text)) {
      return {
        pattern: 'I wanna [do something].',
        slot: text.replace(/^i\s+(?:wanna|want to)\s+/i, ''),
        name: 'I wanna...',
        usageEn: 'Use it when you want to say what you would like to do in a casual way.',
        usageAr: 'تستخدمها عندما تريد أن تقول ما ترغب في فعله بطريقة عادية وغير رسمية.',
        examples: makeDailyTemplateExamples('I wanna [do something].', text)
      };
    }

    if (/^i\s+(?:need|have) to\s+/i.test(text)) {
      const pattern = text.replace(/^i\s+(need|have) to\s+.+$/i, (m, v) => `I ${v.toLowerCase()} to [do something].`);
      return {
        pattern,
        slot: text,
        name: 'I need/have to...',
        usageEn: 'Use it when you want to talk about something necessary or important to do.',
        usageAr: 'تستخدمها عندما تتحدث عن شيء ضروري أو مهم أن تفعله.',
        examples: []
      };
    }

    return null;
  }

  function splitTemplateCandidateSentences(line) {
    const original = cleanLine(line)
      .replace(/^[\-–—]\s*/, '')
      .replace(/\s+[\-–—]\s+/g, ' | ')
      .trim();
    if (!original) return [];
    const parts = [];
    const push = v => {
      v = cleanLine(v).replace(/^[\-–—]\s*/, '').trim();
      if (!v || shouldIgnoreSubtitle(v)) return;
      if ((tokenize(v) || []).length < 3) return;
      if (!parts.some(x => x.toLowerCase() === v.toLowerCase())) parts.push(v);
    };
    push(original);
    original.split(/\s*\|\s*/).forEach(push);
    original.split(/(?<=[.!?])\s+/).forEach(push);
    return parts.slice(0, 8);
  }

  function smartGenericTemplateFromLine(line) {
    const candidates = splitTemplateCandidateSentences(line);
    for (const text of candidates) {
      const known = genericTemplateFromLine(text);
      if (known?.pattern) return { ...known, source: text, rule: known.name || 'Local smart template' };

      const t = text.replace(/[“”]/g, '"').replace(/[’]/g, "'").trim();
      const lower = t.toLowerCase();
      let m;

      if ((m = t.match(/^(.+?)\b(?:wanna|want to|going to|gonna)\b\s+(.+?)([.!?]*)$/i))) {
        const prefix = m[1].trim().replace(/\bi\s*$/i, 'I');
        const starter = /\bi\s*$/i.test(m[1]) ? 'I' : cleanLine(prefix);
        const modal = /gonna|going to/i.test(t) ? 'gonna' : (/wanna/i.test(t) ? 'wanna' : 'want to');
        return {
          pattern: `${starter} ${modal} [do something].`.replace(/^i\b/i, 'I'),
          slot: m[2],
          source: text,
          rule: 'AI-ready want/gonna template',
          usageEn: 'Use it when you want to say what someone wants or is going to do in a natural conversational way.',
          usageAr: 'تستخدمها عندما تريد أن تقول ما يريد شخص فعله أو ما ينوي فعله بطريقة محادثة طبيعية.',
          examples: []
        };
      }

      if ((m = t.match(/^(I|You|We|They|He|She)\s+(?:have|has|had|need|needs|needed)\s+to\s+(.+?)([.!?]*)$/i))) {
        const subject = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        const verb = lower.includes('need') ? (subject === 'He' || subject === 'She' ? 'needs' : 'need') : (subject === 'He' || subject === 'She' ? 'has' : 'have');
        return {
          pattern: `${subject} ${verb} to [do something].`,
          slot: m[2],
          source: text,
          rule: 'AI-ready necessity template',
          usageEn: 'Use it when you want to talk about something necessary or important to do.',
          usageAr: 'تستخدمها عندما تتحدث عن شيء ضروري أو مهم يجب فعله.',
          examples: []
        };
      }

      if ((m = t.match(/^(Shouldn['’]?t|Should|Can|Could|Would|Will|Do|Did|Does|Have|Has|Are|Is|Am)\s+(.+?)([?]*)$/i))) {
        const aux = m[1].replace('’', "'");
        let rest = m[2].replace(/[?!.]+$/g, '').trim();
        const words = tokenize(rest);
        if (words.length >= 2) {
          const keepCount = Math.min(4, Math.max(2, Math.floor(words.length * 0.45)));
          const head = rest.split(/\s+/).slice(0, keepCount).join(' ');
          return {
            pattern: `${aux[0].toUpperCase() + aux.slice(1).toLowerCase()} ${head} [something]?`,
            slot: rest.split(/\s+/).slice(keepCount).join(' '),
            source: text,
            rule: 'AI-ready question template',
            usageEn: 'Use it when asking a similar question in a different daily-life situation.',
            usageAr: 'تستخدمها عندما تريد أن تسأل سؤالًا مشابهًا في موقف يومي مختلف.',
            examples: []
          };
        }
      }

      if ((m = t.match(/^(Why|What|Where|When|How|Who)\s+(.+?)([?]*)$/i))) {
        const wh = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        const rest = m[2].replace(/[?!.]+$/g, '').trim();
        const words = rest.split(/\s+/);
        if (words.length >= 3) {
          const keepCount = Math.min(5, Math.max(2, Math.floor(words.length * 0.5)));
          return {
            pattern: `${wh} ${words.slice(0, keepCount).join(' ')} [something]?`,
            slot: words.slice(keepCount).join(' '),
            source: text,
            rule: 'AI-ready WH question template',
            usageEn: 'Use it when you want to ask the same kind of question in another situation.',
            usageAr: 'تستخدمها عندما تريد أن تسأل نفس نوع السؤال في موقف آخر.',
            examples: []
          };
        }
      }

      if ((m = t.match(/^(I|You|We|They|He|She)\s+(?:can|could|should|would|will|might|must)\s+(.+?)([.!?]*)$/i))) {
        const subject = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        const modal = (t.match(/\b(can|could|should|would|will|might|must)\b/i) || [,''])[1].toLowerCase();
        return {
          pattern: `${subject} ${modal} [do something].`,
          slot: m[2],
          source: text,
          rule: 'AI-ready modal template',
          usageEn: 'Use it when you want to express ability, advice, possibility, or intention with the same structure.',
          usageAr: 'تستخدمها عندما تريد التعبير عن القدرة أو النصيحة أو الاحتمال أو النية بنفس التركيب.',
          examples: []
        };
      }

      const words = t.replace(/[.!?]+$/g, '').split(/\s+/).filter(Boolean);
      if (words.length >= 5 && words.length <= 18 && /[a-z]/i.test(t)) {
        const keepCount = Math.min(5, Math.max(3, Math.floor(words.length * 0.55)));
        const ending = /[?]$/.test(t) ? '?' : '.';
        return {
          pattern: `${words.slice(0, keepCount).join(' ')} [something]${ending}`,
          slot: words.slice(keepCount).join(' '),
          source: text,
          rule: 'AI-ready general template',
          usageEn: 'Use it as a reusable sentence frame. Replace the bracketed part with details that fit your situation.',
          usageAr: 'تستخدمها كقالب قابل لإعادة الاستخدام، وتغير الجزء بين الأقواس حسب الموقف.',
          examples: []
        };
      }
    }
    return null;
  }

  function extractTemplateFromLine(line) {
    const candidates = splitTemplateCandidateSentences(line);
    for (const text of candidates) {
      for (const rule of TEMPLATE_RULES) {
        const m = text.match(rule.re);
        if (m) return { ...rule.build(m), source: text, rule: rule.name };
      }
      const generic = genericTemplateFromLine(text);
      if (generic?.pattern) return { ...generic, source: text, rule: generic.name || 'Local template' };
    }
    return smartGenericTemplateFromLine(line);
  }

  function stripJsonFence(text) {
    return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  function parseJsonLoose(text) {
    const raw = stripJsonFence(text);
    try { return JSON.parse(raw); } catch {}
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj) { try { return JSON.parse(obj[0]); } catch {} }
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) { try { return JSON.parse(arr[0]); } catch {} }
    return null;
  }


  const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
  const OPENROUTER_SETTINGS_CLOUD_WORD = '__openrouter_settings__';
  const OPENROUTER_FREE_MODEL_PRIORITY = [
    'openrouter/free',
    'openai/gpt-oss-20b:free',
    'qwen/qwen3-coder:free',
    'deepseek/deepseek-r1-0528:free',
    'google/gemma-3n-e4b-it:free',
    'mistralai/mistral-small-3.2-24b-instruct:free',
    'meta-llama/llama-3.3-70b-instruct:free'
  ];

  function isFreeOpenRouterModelId(model) {
    const id = cleanLine(model).toLowerCase();
    return Boolean(id && (id === 'openrouter/free' || id.endsWith(':free')));
  }

  function openRouterModelAlias(model) {
    const id = cleanLine(model).toLowerCase();
    if (!id || id === 'auto' || id === 'free' || id === 'openrouter') return 'openrouter/free';
    if (id === 'gpt-oss' || id === 'gpt-oss-20b' || id === 'openai/gpt-oss-20b') return 'openai/gpt-oss-20b:free';
    if (id === 'qwen' || id === 'qwen3' || id === 'qwen-coder' || id === 'qwen/qwen3-coder') return 'qwen/qwen3-coder:free';
    if (id === 'deepseek' || id === 'r1' || id === 'deepseek/deepseek-r1-0528') return 'deepseek/deepseek-r1-0528:free';
    if (isFreeOpenRouterModelId(id)) return cleanLine(model);
    return '';
  }

  function getOpenRouterConfig() {
    const apiKey = String(localStorage.getItem('jm_openrouter_api_key') || localStorage.getItem('jm_chats_llm_api_key') || '').trim();
    const storedModel = String(localStorage.getItem('jm_openrouter_model') || localStorage.getItem('jm_chats_llm_model') || 'openrouter/free').trim();
    const model = openRouterModelAlias(storedModel) || 'openrouter/free';
    if (storedModel && storedModel !== model) localStorage.setItem('jm_openrouter_model', model);
    return { apiKey, model };
  }

  function saveOpenRouterConfigToLocal() {
    const apiKey = String($('chatLlmKeyInput')?.value || '').trim();
    const rawModel = String($('chatLlmModelInput')?.value || '').trim();
    const model = openRouterModelAlias(rawModel || 'openrouter/free') || 'openrouter/free';
    if (apiKey) localStorage.setItem('jm_openrouter_api_key', apiKey); else localStorage.removeItem('jm_openrouter_api_key');
    localStorage.setItem('jm_openrouter_model', model);
    // Keep old keys in sync so older cached code can still read them after one refresh.
    if (apiKey) localStorage.setItem('jm_chats_llm_api_key', apiKey); else localStorage.removeItem('jm_chats_llm_api_key');
    localStorage.setItem('jm_chats_llm_model', model);
    if (rawModel && !isFreeOpenRouterModelId(model) && $('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = 'Only free OpenRouter models are allowed. I switched to openrouter/free.';
    if ($('chatLlmModelInput')) $('chatLlmModelInput').value = model;
    return { apiKey, model };
  }

  function isOpenRouterSettingsCloudItem(item) {
    const key = String(item?.key || '').toLowerCase();
    const word = String(item?.word || '').toLowerCase();
    return key === 'setting:openrouter' || word === OPENROUTER_SETTINGS_CLOUD_WORD;
  }

  function makeOpenRouterSettingsCloudItem() {
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey && !cfg.model) return null;
    const now = new Date().toISOString();
    return {
      kind: 'setting', hidden: true, key: 'setting:openrouter', word: OPENROUTER_SETTINGS_CLOUD_WORD,
      apiKey: cfg.apiKey, model: cfg.model || 'openrouter/free', savedAt: now, updatedAt: now
    };
  }

  function applyOpenRouterSettingsFromCloud(remoteWords = []) {
    const item = (remoteWords || []).find(isOpenRouterSettingsCloudItem);
    if (!item) return false;
    const apiKey = String(item.apiKey || '').trim();
    const model = openRouterModelAlias(String(item.model || 'openrouter/free').trim()) || 'openrouter/free';
    if (apiKey) localStorage.setItem('jm_openrouter_api_key', apiKey);
    localStorage.setItem('jm_openrouter_model', model);
    if (apiKey) localStorage.setItem('jm_chats_llm_api_key', apiKey);
    localStorage.setItem('jm_chats_llm_model', model);
    return Boolean(apiKey || model);
  }

  function openRouterErrorMessage(status, data) {
    const msg = data?.error?.message || data?.message || data?.error || data?.details || data?.raw || '';
    if (status === 404) return 'OpenRouter API proxy is missing. Upload the full Vercel project folder, not the HTML file only.';
    if (status === 401 || status === 403) return 'OpenRouter rejected the API key. Check the key or create a new OpenRouter key.';
    if (status === 402) return 'OpenRouter says this model is not free or has no credits. Use openrouter/free or another :free model.';
    if (status === 429) return 'OpenRouter free model rate limit. Try later or keep model as openrouter/free.';
    return msg || `OpenRouter failed (${status})`;
  }

  async function fetchOpenRouterFreeModels(apiKey = '') {
    try {
      const res = await fetch('/api/openrouter-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.models)) return data.models;
    } catch (e) { console.warn('OpenRouter proxy model lookup failed:', e); }
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/models`, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
      const data = await res.json().catch(() => ({}));
      const models = (Array.isArray(data?.data) ? data.data : [])
        .filter(m => isFreeOpenRouterModelId(m?.id || ''))
        .map(m => ({ id: m.id, name: m.name || m.id }));
      return [{ id: 'openrouter/free', name: 'Free Models Router' }, ...models];
    } catch (e) { console.warn('OpenRouter direct model lookup failed:', e); return [{ id: 'openrouter/free', name: 'Free Models Router' }]; }
  }

  async function getOpenRouterModelCandidates(cfg = {}) {
    const out = [];
    const add = (model) => { const id = openRouterModelAlias(model); if (id && !out.some(x => x.toLowerCase() === id.toLowerCase())) out.push(id); };
    add(cfg.model || 'openrouter/free');
    add('openrouter/free');
    try {
      const models = await fetchOpenRouterFreeModels(cfg.apiKey || '');
      for (const m of models || []) add(m?.id || m);
    } catch {}
    for (const m of OPENROUTER_FREE_MODEL_PRIORITY) add(m);
    return out.slice(0, 12);
  }

  async function callOpenRouterJson(prompt, { temperature = 0.25, maxTokens = 900, system = '' } = {}) {
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) throw new Error('OpenRouter key is missing. Open Menu → OpenRouter AI settings and save the key first.');
    const modelsToTry = await getOpenRouterModelCandidates(cfg);
    let lastError = '';
    for (const model of modelsToTry) {
      const payload = {
        apiKey: cfg.apiKey,
        model,
        messages: [
          { role: 'system', content: system || 'Return strict JSON only. No markdown. No explanations.' },
          { role: 'user', content: prompt }
        ],
        temperature,
        max_tokens: maxTokens
      };
      try {
        let res = await fetch('/api/openrouter-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        let raw = await res.text();
        let data = {}; try { data = JSON.parse(raw); } catch { data = { raw }; }
        if (!res.ok) {
          lastError = openRouterErrorMessage(res.status, data);
          if (res.status === 404) {
            res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey}`,
                'HTTP-Referer': location.origin,
                'X-OpenRouter-Title': 'Jungle Movie Learner'
              },
              body: JSON.stringify({ model, messages: payload.messages, temperature, max_tokens: maxTokens, stream: false })
            });
            raw = await res.text();
            try { data = JSON.parse(raw); } catch { data = { raw }; }
            if (!res.ok) { lastError = openRouterErrorMessage(res.status, data); continue; }
          } else {
            continue;
          }
        }
        const content = data?.content || data?.choices?.[0]?.message?.content || data?.output || data?.message || data?.raw || raw;
        const parsed = parseJsonLoose(content) || { raw: content };
        parsed.__model = model;
        return parsed;
      } catch (e) {
        lastError = e.message || String(e);
        console.warn('OpenRouter model failed:', model, e);
      }
    }
    throw new Error(lastError || 'No free OpenRouter model returned a valid response.');
  }

  async function callOpenRouterText(prompt, { temperature = 0.2, maxTokens = 350, system = '' } = {}) {
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) throw new Error('OpenRouter key is missing.');
    const modelsToTry = await getOpenRouterModelCandidates(cfg);
    let lastError = '';
    for (const model of modelsToTry) {
      const payload = {
        apiKey: cfg.apiKey,
        model,
        messages: [
          { role: 'system', content: system || 'Answer with the requested final text only.' },
          { role: 'user', content: prompt }
        ],
        temperature,
        max_tokens: maxTokens
      };
      try {
        let res = await fetch('/api/openrouter-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        let raw = await res.text();
        let data = {}; try { data = JSON.parse(raw); } catch { data = { raw }; }
        if (!res.ok) {
          lastError = openRouterErrorMessage(res.status, data);
          if (res.status === 404) {
            res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'HTTP-Referer': location.origin, 'X-OpenRouter-Title': 'Jungle Movie Learner' },
              body: JSON.stringify({ model, messages: payload.messages, temperature, max_tokens: maxTokens, stream: false })
            });
            raw = await res.text();
            try { data = JSON.parse(raw); } catch { data = { raw }; }
            if (!res.ok) { lastError = openRouterErrorMessage(res.status, data); continue; }
          } else {
            continue;
          }
        }
        const content = data?.content || data?.choices?.[0]?.message?.content || data?.output || data?.message || data?.raw || raw;
        return cleanLine(String(content || ''));
      } catch (e) { lastError = e.message || String(e); console.warn('OpenRouter text call failed:', model, e); }
    }
    throw new Error(lastError || 'OpenRouter failed.');
  }

  function chatsLlmBaseUrl() {
    return String(localStorage.getItem('jm_chats_llm_base_url') || 'https://chats-llm.com/api/v1').trim().replace(/\/$/, '');
  }


  const CHAT_LLM_FREE_MODEL_PRIORITY = [
  'moonshotai/kimi-k2.6:free',
  'stepfun/step-3.7-flash:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'z-ai/glm-4.5-air:free',
  'qwen/qwen3-coder:free',
  'poolside/laguna-m.1:free',
  'nex-agi/nex-n2-pro:free',
  'openrouter/free',
  'kilo-auto/free'
];

  function isFreeChatLlmModelId(model) {
    const id = cleanLine(model).toLowerCase();
    return Boolean(id && (id.endsWith(':free') || id === 'openrouter/free' || id === 'kilo-auto/free' || id.includes('/free')));
  }

  function chatLlmFreeAlias(model) {
    const id = cleanLine(model).toLowerCase();
    if (!id) return '';
    const aliases = {
      'auto': '',
      'free': 'openrouter/free',
      'openrouter': 'openrouter/free',
      'openrouter/free': 'openrouter/free',
      'kilo-auto/free': 'kilo-auto/free',
      'kilo/free': 'kilo-auto/free',
      'kimi': 'moonshotai/kimi-k2.6:free',
      'kimi-k2.6': 'moonshotai/kimi-k2.6:free',
      'moonshotai/kimi-k2.6': 'moonshotai/kimi-k2.6:free',
      'step': 'stepfun/step-3.7-flash:free',
      'stepfun/step-3.7-flash': 'stepfun/step-3.7-flash:free',
      'llama': 'meta-llama/llama-3.3-70b-instruct:free',
      'meta-llama/llama-3.3-70b-instruct': 'meta-llama/llama-3.3-70b-instruct:free',
      'gpt-oss-120b': 'openai/gpt-oss-120b:free',
      'openai/gpt-oss-120b': 'openai/gpt-oss-120b:free',
      'gpt-oss-20b': 'openai/gpt-oss-20b:free',
      'openai/gpt-oss-20b': 'openai/gpt-oss-20b:free',
      'qwen': 'qwen/qwen3-next-80b-a3b-instruct:free',
      'qwen/qwen3-next-80b-a3b-instruct': 'qwen/qwen3-next-80b-a3b-instruct:free'
    };
    if (aliases[id] !== undefined) return aliases[id];
    return isFreeChatLlmModelId(id) ? cleanLine(model) : '';
  }

  function chatLlmModelScore(id) {
    const lower = cleanLine(id).toLowerCase();
    const idx = CHAT_LLM_FREE_MODEL_PRIORITY.findIndex(x => x.toLowerCase() === lower);
    if (idx >= 0) return idx;
    if (/content-safety|guard|moderation|safety|lyria|image|vision|vl\b|audio|tts|speech|clip/.test(lower)) return 9999;
    if (/kimi|step|llama|qwen|gpt-oss|gemma|glm|hermes/.test(lower)) return 100;
    if (lower === 'openrouter/free' || lower === 'kilo-auto/free') return 120;
    return 500;
  }

  function chooseBestFreeChatLlmModel(models) {
    const ids = (Array.isArray(models) ? models : [])
      .map(m => cleanLine(m?.id || m))
      .filter(isFreeChatLlmModelId);
    const unique = [...new Set(ids)];
    for (const preferred of CHAT_LLM_FREE_MODEL_PRIORITY) {
      const found = unique.find(id => id.toLowerCase() === preferred.toLowerCase());
      if (found) return found;
    }
    unique.sort((a, b) => chatLlmModelScore(a) - chatLlmModelScore(b));
    return unique[0] || '';
  }

  async function chooseChatLlmModelDirect(cfg) {
    const explicit = chatLlmFreeAlias(cfg?.model || localStorage.getItem('jm_chats_llm_model') || '');
    if (explicit) return explicit;
    const apiKey = cleanLine(cfg?.apiKey || '');
    if (!apiKey) return 'openrouter/free';
    try {
      const res = await fetch(`${chatsLlmBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const data = await res.json().catch(() => ({}));
      const model = chooseBestFreeChatLlmModel(data?.data || []);
      if (model) {
        localStorage.setItem('jm_chats_llm_model', model);
        return model;
      }
    } catch (e) {
      console.warn('Direct Chats-LLM free models lookup failed:', e);
    }
    return 'openrouter/free';
  }


  async function getChatLlmFreeModelCandidatesDirect(cfg) {
    const out = [];
    const add = (m) => { const id = chatLlmFreeAlias(m); if (id && !out.some(x => x.toLowerCase() === id.toLowerCase())) out.push(id); };
    add(cfg?.model || localStorage.getItem('jm_chats_llm_model') || '');
    const apiKey = cleanLine(cfg?.apiKey || '');
    if (apiKey) {
      try {
        const res = await fetch(`${chatsLlmBaseUrl()}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
        const data = await res.json().catch(() => ({}));
        const ids = (Array.isArray(data?.data) ? data.data : [])
          .map(m => cleanLine(m?.id || m))
          .filter(isFreeChatLlmModelId)
          .sort((a, b) => chatLlmModelScore(a) - chatLlmModelScore(b));
        ids.forEach(add);
      } catch (e) { console.warn('Direct free model candidate lookup failed:', e); }
    }
    CHAT_LLM_FREE_MODEL_PRIORITY.forEach(add);
    add('openrouter/free');
    return out;
  }

  function normalizeAiTemplate(raw, sourceLine) {
    const t = raw?.template || raw || {};
    const examples = sanitizeTemplateExamples(Array.isArray(t.examples) ? t.examples.map(x => ({
      en: cleanLine(x?.en || x?.english || ''),
      ar: cleanLine(x?.ar || x?.arabic || ''),
      slot: cleanLine(x?.slot || x?.replacement || ''),
      source: 'ai-direct'
    })) : [], t.pattern || '', sourceLine);
    const out = {
      pattern: cleanLine(t.pattern || ''),
      slot: cleanLine(t.slot || ''),
      usageEn: cleanLine(t.usageEn || t.usage || ''),
      usageAr: cleanLine(t.usageAr || ''),
      examples,
      source: cleanLine(sourceLine || ''),
      rule: 'Chats-LLM extracted template'
    };
    if (!out.pattern || !/\[.+?\]/.test(out.pattern)) return null;
    if (looksLikeBadTemplateExample(out.pattern.replace(/\[.+?\]/g, 'something'))) return null;
    return out;
  }

  function buildTemplateExtractPrompt(line) {
    return `You are helping an Arabic-speaking English learner turn movie subtitle lines into reusable sentence templates.

TASK:
Analyze this English subtitle line and extract ONE useful, reusable sentence template.

STRICT RULES:
- Output JSON only. No markdown. No explanations.
- The template MUST contain one bracket placeholder like [do something], [someone], [something], [somewhere], or [time].
- Do not create a strange or incomplete template.
- Keep the original grammar, tone, and useful fixed phrase.
- Choose a template that can be reused in daily-life situations.
- Also give 3 complete natural daily-life examples using the same template.
- Translate usage and examples into natural Arabic.
- If the line contains more than one sentence, choose the most reusable one.

Return exactly this JSON:
{
  "template": {
    "pattern": "Reusable English template with [placeholder].",
    "slot": "the original part replaced by the placeholder",
    "usageEn": "When to use this template in simple English.",
    "usageAr": "شرح الاستخدام بالعربي.",
    "examples": [
      {"slot": "replacement", "en": "Complete natural English example.", "ar": "ترجمة عربية طبيعية."}
    ]
  }
}

Subtitle line: ${cleanLine(line)}`;
  }

  function buildTemplateExamplesPrompt(template, contextEn = '') {
    return `You are helping an Arabic-speaking English learner learn reusable sentence templates from movies.

TASK:
Given an English sentence template containing bracket placeholders like [do something], create 3 natural, complete, everyday English examples by replacing the bracket part with realistic daily-life situations. Also translate each example into natural Arabic.

STRICT RULES:
- Output JSON only. No markdown. No explanations.
- Do not return the template itself.
- Do not keep brackets [] in examples.
- Each English example must be a complete, natural sentence a native speaker could say in daily life.
- Examples must be useful for real situations, not strange movie-only situations.
- Avoid awkward phrases like "in my own situation", "examples of template", or sentences ending with a preposition.
- Keep the same grammar structure and tone of the template.
- Arabic translations should be natural and concise, not literal word-for-word.
- If the template is annoyed, funny, casual, or polite, keep that tone.

Return exactly this JSON shape:
{
  "examples": [
    {"slot": "replacement words used", "en": "Complete English example.", "ar": "الترجمة العربية الطبيعية."}
  ]
}

Template: ${cleanLine(template?.pattern || '')}
Original movie line/context: ${cleanLine(contextEn || template?.source || '')}
Original slot if known: ${cleanLine(template?.slot || '')}
Usage in English: ${cleanLine(template?.usageEn || '')}
Usage in Arabic: ${cleanLine(template?.usageAr || '')}`;
  }

  async function callChatsLlmDirect(prompt, cfg, { temperature = 0.3, maxTokens = 900 } = {}) {
    const apiKey = cleanLine(cfg?.apiKey || '');
    if (!apiKey) throw new Error('Chats-LLM key is missing. Open AI examples settings and save the key first.');
    const modelsToTry = await getChatLlmFreeModelCandidatesDirect(cfg);
    let lastError = '';
    for (const model of modelsToTry) {
      const res = await fetch(`${chatsLlmBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Return strict JSON only. Generate natural, complete daily-life English examples with natural Arabic translations. Never leave placeholders or brackets.' },
            { role: 'user', content: prompt }
          ],
          temperature,
          max_tokens: maxTokens,
          stream: false
        })
      });
      const raw = await res.text();
      let data = {};
      try { data = JSON.parse(raw); } catch { data = { raw }; }
      if (!res.ok) {
        lastError = chatLlmErrorMessage(res.status, data);
        if (res.status === 401 || res.status === 403) throw new Error(lastError);
        continue;
      }
      const content = data?.choices?.[0]?.message?.content || data?.output || data?.message || raw;
      const parsed = parseJsonLoose(content) || { raw: content };
      parsed.__model = model;
      return parsed;
    }
    throw new Error(lastError || 'No free Chats-LLM model returned a valid response.');
  }

  async function fetchTemplateFromChatLlm(line) {
    const cfg = (typeof getChatLlmConfig === 'function') ? getChatLlmConfig() : { apiKey: '', model: '' };
    const payload = { line: cleanLine(line), apiKey: cfg.apiKey || '', model: chatLlmFreeAlias(cfg.model || '') };
    try {
      const res = await fetch('/api/chats-llm-extract-template', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(chatLlmErrorMessage(res.status, data));
      const t = data.template || data;
      return normalizeAiTemplate(t, line);
    } catch (proxyError) {
      const msg = String(proxyError?.message || '');
      console.warn('AI template extraction proxy failed:', proxyError);
      if (!/proxy is missing|failed \(404\)|404/i.test(msg)) throw proxyError;
      setStatus('AI proxy is missing. Trying direct Chats-LLM connection from the browser...');
      const parsed = await callChatsLlmDirect(buildTemplateExtractPrompt(line), cfg, { temperature: 0.25, maxTokens: 950 });
      const out = normalizeAiTemplate(parsed, line);
      if (!out) throw new Error('Direct AI returned no valid reusable template.');
      return out;
    }
  }

  async function fetchTemplateFromOpenRouter(line) {
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) return null;
    const parsed = await callOpenRouterJson(buildTemplateExtractPrompt(line), {
      temperature: 0.22,
      maxTokens: 950,
      system: 'You are an English tutor. Return valid JSON only for one reusable sentence template.'
    });
    return normalizeAiTemplate(parsed, line);
  }

  async function extractTemplateFromLineAsync(line) {
    const local = extractTemplateFromLine(line);
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) return local;
    try {
      const ai = await fetchTemplateFromOpenRouter(line);
      if (ai?.pattern && /\[[^\]]+\]/.test(ai.pattern)) return ai;
    } catch (e) {
      console.warn('OpenRouter template extraction failed, using local template:', e);
      setStatus('OpenRouter template extraction failed. Local template fallback is active.');
    }
    return local;
  }

  async function translateTemplateMeaning(template, contextEn = '') {
    if (!template?.pattern) return '';
    // Lara is now used only for translating subtitle lines.
    // For template usage, prefer the human-written Arabic usage; otherwise use MyMemory.
    if (template.usageAr) return template.usageAr;
    if (template.usageEn) {
      try { return await translateMyMemory(template.usageEn); } catch {}
    }
    return '';
  }


  function looksLikeTemplatePlaceholderArabic(ar) {
    const text = cleanLine(ar || '');
    if (!text) return false;
    return /مثال\s*(يومي|تطبيقي)|نفس القالب|موقف مختلف|تركيبة|باستخدام نفس القالب/i.test(text);
  }

  function looksLikeBadTemplateExample(ex) {
    const text = cleanLine(typeof ex === 'string' ? ex : (ex?.en || ''));
    if (!text) return true;
    if (!/[a-z]/i.test(text)) return true;
    if (/\[.*?\]/.test(text)) return true;
    if (/\b(examples? of template|using the same template|same template|in my own situation)\b/i.test(text)) return true;
    if (/مثال تطبيقي|نفس القالب/i.test(text)) return true;
    if (/\bleft\s+on\s+in\b/i.test(text)) return true;
    if (/\b(left on|left at|left with)\s+(today|before|after|when)\b/i.test(text)) return true;
    if (/\b(on|in|at|for|with|to|of|from|by|about)\s+(on|in|at|for|with|to|of|from|by|about)\b/i.test(text)) return true;
    if (/\b(?:on|in|at|for|with|to|of|from|by|about|the|a|an)\s*[.!?]?$/i.test(text)) return true;
    const words = tokenize(text);
    if (words.length < 3) return true;
    return false;
  }

  function sanitizeTemplateExamples(examples, pattern = '', contextEn = '') {
    const clean = [];
    const seen = new Set();
    const push = ex => {
      const item = typeof ex === 'string'
        ? { en: cleanLine(ex), ar: '', note: '', alt: '' }
        : { en: cleanLine(ex?.en || ''), ar: cleanLine(ex?.ar || ''), note: cleanLine(ex?.note || ''), alt: cleanLine(ex?.alt || '') };
      if (!item.en || looksLikeBadTemplateExample(item)) return;
      if (looksLikeTemplatePlaceholderArabic(item.ar)) item.ar = '';
      if (!/[.!?]$/.test(item.en)) item.en += '.';
      const key = item.en.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      clean.push(item);
    };

    (Array.isArray(examples) ? examples : []).forEach(push);
    if (clean.length < 3) makeDailyTemplateExamples(pattern, contextEn).forEach(push);
    return clean.slice(0, 3);
  }

  function parseMyMemoryExamples(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    let jsonText = raw;
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) jsonText = match[0];
    try {
      const arr = JSON.parse(jsonText);
      if (Array.isArray(arr)) {
        return arr.map(x => ({
          en: cleanLine(x.en || x.english || x.segment || ''),
          ar: cleanLine(x.ar || x.arabic || x.translation || '')
        })).filter(x => x.en);
      }
    } catch {}
    return raw.split(/\n+/).map(line => {
      const cleaned = line.replace(/^\s*[-*\d.)]+\s*/, '').trim();
      const parts = cleaned.split(/\s+[—–-]\s+|\s+=\s+/);
      return { en: cleanLine(parts[0] || ''), ar: cleanLine(parts.slice(1).join(' - ') || '') };
    }).filter(x => x.en && /[a-z]/i.test(x.en)).slice(0, 3);
  }

  function templateSearchQueries(template, contextEn = '') {
    const pattern = cleanLine(template?.pattern || '');
    const source = cleanLine(contextEn || template?.source || '');
    const slot = cleanLine(template?.slot || '').replace(/[?.!,]+$/g, '');
    const lower = pattern.toLowerCase();
    const queries = [];
    const add = q => {
      q = cleanLine(q || '').replace(/\s+/g, ' ').trim();
      if (!q || q.length < 5) return;
      if (!queries.some(x => x.toLowerCase() === q.toLowerCase())) queries.push(q);
    };

    // Query MyMemory with complete, natural phrases only. Avoid placeholders.
    if (source && !looksLikeBadTemplateExample(source)) add(source);
    if (slot && slot.split(/\s+/).length >= 3 && !looksLikeBadTemplateExample(slot)) add(slot);

    if (/how many times have i told you not to/i.test(lower)) {
      add('How many times have I told you not to touch my phone?');
      add('How many times have I told you not to interrupt me?');
    } else if (/shouldn['’]?t you be/i.test(lower)) {
      add("Shouldn't you be at work by now?");
      add("Shouldn't you be getting ready?");
    } else if (/there(?:'s| is| are).*left/i.test(lower)) {
      add("There's some coffee left.");
      add("There's some pizza left in the fridge.");
    } else if (/besides.*i wanna/i.test(lower)) {
      add('Besides, I wanna finish this first.');
      add('Besides, I wanna talk to him first.');
    } else if (/you like/i.test(lower)) {
      add('You like this song?');
      add('You like horror movies?');
    } else if (/i love/i.test(lower)) {
      add('I love this show!');
      add('I love that idea!');
    } else if (/i did everything i could to/i.test(lower)) {
      add('I did everything I could to help him.');
      add('I did everything I could to fix it.');
    } else if (/worked out|figured out/i.test(lower)) {
      add("I'm sure by now you've figured out what happened.");
      add("I'm sure by now you've worked out the truth.");
    } else if (/i wanna/i.test(lower)) {
      add('I wanna finish this first.');
      add('I wanna talk to you for a minute.');
    } else if (/i (?:need|have) to/i.test(lower)) {
      add('I need to leave early today.');
      add('I have to finish this before tomorrow.');
    }
    // General MyMemory queries: use the original subtitle, fixed template prefix, and safe filled examples.
    const fixedPrefix = pattern.replace(/\[[^\]]+\]/g, '').replace(/\s+([?.!,])/g, '$1').replace(/\s+/g, ' ').trim();
    if (fixedPrefix && fixedPrefix.split(/\s+/).length >= 3) add(fixedPrefix.replace(/[?.!]+$/g, ''));
    makeGenericTemplateExamples(template, source || pattern).forEach(ex => add(ex.en));
    makeDailyTemplateExamples(pattern, source).forEach(ex => add(ex.en));

    return queries.slice(0, 10);
  }

  function fillTemplatePattern(pattern, replacement) {
    let out = cleanLine(pattern || '');
    const rep = cleanLine(replacement || 'something');
    out = out.replace(/\[[^\]]+\]/g, rep);
    out = out.replace(/\s+([?.!,])/g, '$1').replace(/\s+/g, ' ').trim();
    out = out.replace(/\bI wanna to\b/gi, 'I wanna').replace(/\bI want to to\b/gi, 'I want to');
    if (!/[.!?]$/.test(out)) out += /^(Should|Can|Could|Would|Will|Do|Did|Does|Have|Has|Are|Is|Am|Why|What|Where|When|How|Who)\b/i.test(out) ? '?' : '.';
    return out;
  }

  function templateFixedWords(pattern) {
    return tokenize(String(pattern || '').replace(/\[[^\]]+\]/g, ' '))
      .map(w => w.toLowerCase())
      .filter(w => !['something','someone','somewhere','anything','anyone','anywhere','thing','do','doing'].includes(w));
  }

  function templateMatchLoose(pattern, text) {
    const words = templateFixedWords(pattern);
    const t = cleanLine(text || '').toLowerCase();
    if (!words.length) return false;
    let hits = 0;
    for (const w of words) {
      if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) hits++;
    }
    return hits >= Math.min(words.length, Math.max(2, Math.ceil(words.length * 0.55)));
  }

  function isUsableTemplateExampleForPattern(pattern, text) {
    if (!text || looksLikeBadTemplateExample(text)) return false;
    if (matchesTemplatePattern(pattern, text)) return true;
    return templateMatchLoose(pattern, text);
  }

  function makeGenericTemplateExamples(template, contextEn = '') {
    const pattern = cleanLine(template?.pattern || template || '');
    if (!pattern || !/\[[^\]]+\]/.test(pattern)) return [];
    const lower = pattern.toLowerCase();
    const examples = [];
    const add = replacement => {
      const en = fillTemplatePattern(pattern, replacement);
      if (!looksLikeBadTemplateExample(en) && isUsableTemplateExampleForPattern(pattern, en)) examples.push({ en, ar: '', source: 'mymemory-generated-query' });
    };

    if (/\[do something\]/i.test(pattern)) {
      if (/^i\s+(?:need|have) to/i.test(lower)) {
        ['leave early today', 'finish this before tomorrow', 'call my manager after work'].forEach(add);
      } else if (/^i\s+(?:wanna|want to)/i.test(lower)) {
        ['finish this before I leave', 'talk to you for a minute', 'make sure everything is okay'].forEach(add);
      } else if (/^you\s+(?:need|have) to/i.test(lower)) {
        ['check your email', 'call him back', 'finish this before the meeting'].forEach(add);
      } else if (/^should/i.test(lower)) {
        ['call him now', 'wait outside', 'talk to her first'].forEach(add);
      } else if (/^can|^could/i.test(lower)) {
        ['help me with this', 'send me the file', 'call me later'].forEach(add);
      } else {
        ['finish this first', 'talk to him later', 'check it again'].forEach(add);
      }
    } else if (/\[somewhere\]|\[place\]/i.test(pattern)) {
      ['at work by now', 'on your way home', 'in the meeting already'].forEach(add);
    } else if (/\[someone\]/i.test(pattern)) {
      ['my brother', 'your teacher', 'the new manager'].forEach(add);
    } else if (/\[thing\]|\[something\]/i.test(pattern)) {
      if (/there(?:'s| is| are).*left/i.test(lower)) {
        ['some coffee', 'some pizza in the fridge', 'some money after paying the bills'].forEach(add);
      } else if (/you like/i.test(lower)) {
        ['this song', 'spicy food', 'that place'].forEach(add);
      } else if (/i love/i.test(lower)) {
        ['this idea', 'the way you explain things', 'that place'].forEach(add);
      } else if (/problem/i.test(lower)) {
        ['with the app', 'with that', 'with me'].forEach(add);
      } else if (/plan|plans/i.test(lower)) {
        ['for tonight', 'for the weekend', 'for Eid yet'].forEach(add);
      } else {
        ['this idea', 'the problem', 'what happened yesterday'].forEach(add);
      }
    }

    const seen = new Set();
    return examples.filter(ex => {
      const key = ex.en.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 3);
  }

  async function fetchMyMemoryExamplesPayload(query, limit = 5) {
    try {
      const res = await fetch('/api/mymemory-translate', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ mode: 'examples', query, source: 'en', target: 'ar', limit })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `MyMemory proxy failed (${res.status})`);
      return data;
    } catch (proxyError) {
      // Direct browser fallback for cases where the user uploaded HTML only.
      // MyMemory GET uses q + langpair exactly as documented.
      try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=${encodeURIComponent('en|ar')}`;
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.responseDetails || `MyMemory direct failed (${res.status})`);
        return {
          translatedText: data?.responseData?.translatedText || '',
          matches: (data?.matches || []).map(m => ({
            en: cleanLine(m.segment || m.sourceSegment || m.source || ''),
            ar: cleanLine(m.translation || m.targetSegment || m.target || ''),
            match: m.match || '',
            quality: m.quality || '',
            source: 'mymemory-direct'
          }))
        };
      } catch (directError) {
        console.warn('MyMemory proxy/direct lookup failed:', proxyError, directError);
        return { matches: [], translatedText: '' };
      }
    }
  }

  function matchesTemplatePattern(pattern, text) {
    pattern = cleanLine(pattern || '').toLowerCase();
    text = cleanLine(text || '');
    if (!text || looksLikeBadTemplateExample(text)) return false;
    if (/how many times have i told you not to/i.test(pattern)) return /^how many times have i told you not to\s+.+[?.!]?$/i.test(text);
    if (/shouldn['’]?t you be/i.test(pattern)) return /^(?:hey,?\s*)?should(?:n['’]t| not) you be\s+.+[?.!]?$/i.test(text);
    if (/there(?:'s| is| are).*left/i.test(pattern)) return /^(?:there['’]?s|there is|there are)\s+.+\s+left(?:\s+(?:in|for|after|if)\s+.+)?[.!?]?$/i.test(text) && !/\bleft\s+on\s+in\b/i.test(text);
    if (/besides.*i wanna/i.test(pattern)) return /^(?:besides,?\s*)?i (?:wanna|want to)\s+.+[.!?]?$/i.test(text);
    if (/you like/i.test(pattern)) return /^(?:oh,?\s*)?you like\s+.+[?.!]?$/i.test(text);
    if (/i love/i.test(pattern)) return /^i love\s+.+[!.]?$/i.test(text);
    if (/i did everything i could to/i.test(pattern)) return /^i did everything i could to\s+.+[.!?]?$/i.test(text);
    if (/worked out|figured out/i.test(pattern)) return /(?:worked|figured) out\s+.+[.!?]?$/i.test(text);
    if (/i wanna/i.test(pattern)) return /^i (?:wanna|want to)\s+.+[.!?]?$/i.test(text);
    if (/i (?:need|have) to/i.test(pattern)) return /^i\s+(?:need|have) to\s+.+[.!?]?$/i.test(text);
    return false;
  }

  function examplesFromCurrentSubtitles(template, contextEn = '') {
    if (!Array.isArray(state.subtitles) || !state.subtitles.length) return [];
    const ctx = cleanLine(contextEn || template?.source || '').toLowerCase();
    const seen = new Set();
    const out = [];
    for (const sub of state.subtitles) {
      const en = cleanLine(sub?.en || '').replace(/^[-–—]\s*/, '');
      if (!en || en.toLowerCase() === ctx) continue;
      if (!matchesTemplatePattern(template?.pattern || '', en)) continue;
      const key = en.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ en, ar: cleanLine(sub?.ar || ''), source: 'subtitle' });
      if (out.length >= 3) break;
    }
    return out;
  }


  function puterResponseToText(response) {
    if (typeof response === 'string') return response;
    if (!response) return '';
    if (typeof response.text === 'string') return response.text;
    if (typeof response.message?.content === 'string') return response.message.content;
    if (Array.isArray(response.message?.content)) return response.message.content.map(x => x?.text || x?.content || '').join('\n');
    if (typeof response.content === 'string') return response.content;
    if (Array.isArray(response.content)) return response.content.map(x => x?.text || x?.content || '').join('\n');
    try { return JSON.stringify(response); } catch { return String(response); }
  }

  function buildPuterTemplateExamplesPrompt(template, contextEn = '') {
    const pattern = cleanLine(template?.pattern || '');
    const source = cleanLine(contextEn || template?.source || '');
    const slot = cleanLine(template?.slot || template?.templateSlot || '');
    const usageEn = cleanLine(template?.usageEn || template?.templateUsageEn || '');
    const usageAr = cleanLine(template?.usageAr || template?.templateUsageAr || '');
    return `You are writing realistic English examples for an Arabic-speaking learner — lines that could appear in a movie, a TV show, or a real conversation.

TEMPLATE: ${pattern}
${source ? `ORIGINAL MOVIE LINE: ${source}` : ''}
${slot ? `ORIGINAL REPLACED PART: ${slot}` : ''}
${usageEn ? `WHEN NATIVES USE IT (EN): ${usageEn}` : ''}
${usageAr ? `WHEN NATIVES USE IT (AR): ${usageAr}` : ''}

GENERATE EXACTLY 3 REALISTIC EXAMPLES that sound like native everyday English.

CORE PRINCIPLES — follow strictly:
1. First decide how native speakers ACTUALLY use this template — register, situation, tone.
2. Build a realistic SITUATION around that usage, then fit the template in.
3. Never force the template just to fill the slot — if a phrasing sounds awkward, change the situation.
4. Prioritize natural conversation over template coverage.
5. Avoid textbook sentences. No drills like "I want to eat an apple." Aim for lines a real person would say.
6. Match register: if the template is casual, examples are casual; if it's formal, keep them formal.
7. If it's a question, every example must be a complete question.
8. If it expresses annoyance, the examples should sound naturally annoyed, not rude.
9. Vary situations across the 3 examples (don't reuse the same scene).
10. Replace every bracket placeholder like [do something], [someone], [somewhere] with realistic daily-life content. Never keep brackets.
11. PREFER words and phrases native speakers actually use in everyday conversation (movies, casual chat). If the template OR any word inside an example is FORMAL, OUTDATED, or RARE in daily speech, you MUST explicitly flag that and provide a more common alternative natives would say instead — fill the "alt" field with that natural rewrite (e.g. for "I shall depart" → "I'm gonna head out"). For already-natural lines leave "alt" empty.

For EACH example also write a one-line note (Arabic, دارجة) explaining WHY this template feels natural in that exact situation.
The "alt" field is optional per example — fill it only when a more common everyday English alternative exists; otherwise use an empty string.

Translations: natural EGYPTIAN COLLOQUIAL ARABIC (المصرية الدارجة), no formal MSA, no transliteration.

Return JSON ONLY (no markdown, no commentary) in this exact shape:
{"examples":[
  {"en":"...", "ar":"...", "note":"...", "alt":""},
  {"en":"...", "ar":"...", "note":"...", "alt":""},
  {"en":"...", "ar":"...", "note":"...", "alt":""}
]}

Good output example:
{"examples":[
  {"en":"Shouldn't you be at work by now?", "ar":"مش المفروض تكون في الشغل دلوقتي؟", "note":"موقف عتاب لطيف بين صحاب — طبيعي لما حد متأخر.", "alt":""},
  {"en":"Shouldn't you be getting ready for class?", "ar":"مش المفروض تكون بتجهّز للحصة؟", "note":"أم بتنبّه ابنها — استخدام يومي شائع.", "alt":""},
  {"en":"Shouldn't you be on your way to school?", "ar":"مش المفروض تكون في الطريق للمدرسة؟", "note":"موقف بيتي صباحي — جملة مألوفة جداً.", "alt":""}
]}`;
  }

  async function fetchTemplateExamplesFromPuter(template, contextEn = '') {
    if (!template?.pattern || !/\[[^\]]+\]/.test(template.pattern)) return [];
    if (!window.puter?.ai?.chat) throw new Error('Puter AI is not loaded. Check your internet connection or reload the page.');
    const prompt = buildPuterTemplateExamplesPrompt(template, contextEn);
    const modelCandidates = ['gpt-5.4-nano', 'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4o-mini'];
    let lastError = null;
    for (const model of modelCandidates) {
      try {
        const response = await window.puter.ai.chat(prompt, { model, temperature: 0.35, max_tokens: 900 });
        const text = puterResponseToText(response);
        const parsed = parseJsonLoose(text);
        const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.examples) ? parsed.examples : []);
        const examples = sanitizeTemplateExamples(rawList.map(x => ({
          en: cleanLine(x?.en || x?.english || ''),
          ar: cleanLine(x?.ar || x?.arabic || ''),
          note: cleanLine(x?.note || x?.why || ''),
          alt: cleanLine(x?.alt || x?.alternative || ''),
          source: 'puter-ai'
        })), template.pattern, contextEn || template.source || '');
        if (examples.length >= 3) return examples.slice(0, 3);
        if (examples.length) return await translateTemplateExamplesWithMyMemory(examples);
      } catch (e) {
        lastError = e;
        console.warn('Puter AI template examples failed with model', model, e);
      }
    }
    if (lastError) throw lastError;
    return [];
  }



  async function fetchTemplateExamplesFromOpenRouter(template, contextEn = '') {
    if (!template?.pattern || !/\[[^\]]+\]/.test(template.pattern)) return [];
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) return [];
    const prompt = buildPuterTemplateExamplesPrompt(template, contextEn);
    const parsed = await callOpenRouterJson(prompt, {
      temperature: 0.28,
      maxTokens: 900,
      system: 'You write realistic English examples for an Arabic learner. Return JSON only in the exact shape requested: {"examples":[{"en":"...","ar":"...","note":"..."},...]} — natural daily-life English with Egyptian colloquial Arabic and a short Arabic note about WHY each fits.'
    });
    const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.examples) ? parsed.examples : []);
    return sanitizeTemplateExamples(rawList.map(x => ({
      en: cleanLine(x?.en || x?.english || ''),
      ar: cleanLine(x?.ar || x?.arabic || ''),
      note: cleanLine(x?.note || x?.why || ''),
      alt: cleanLine(x?.alt || x?.alternative || ''),
      source: 'openrouter-ai'
    })), template.pattern, contextEn || template.source || '').slice(0, 3);
  }

  function buildOpenRouterSubtitlePrompt(text) {
    return buildPuterSubtitlePrompt(text) + '\n\nIMPORTANT: Return the Arabic translation only, no JSON and no notes.';
  }

  function buildOpenRouterSubtitleBatchPrompt(items) {
    return buildPuterSubtitleBatchPrompt(items);
  }

  async function translateOpenRouterSubtitle(text) {
    text = cleanLine(text || '');
    if (!text) return '';
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) throw new Error('OpenRouter key is missing.');
    const ar = await callOpenRouterText(buildOpenRouterSubtitlePrompt(text), {
      temperature: 0.18,
      maxTokens: 300,
      system: 'You are a professional subtitle translator. Return Arabic translation only.'
    });
    const clean = cleanPuterArabicTranslation(ar);
    if (clean) return clean;
    throw new Error('OpenRouter returned empty translation.');
  }

  async function translateOpenRouterSubtitleItems(items) {
    items = (items || []).map(x => ({ index: Number(x.index), text: cleanLine(x.text || x.en || '') })).filter(x => x.text);
    if (!items.length) return [];
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) throw new Error('OpenRouter key is missing.');
    const parsed = await callOpenRouterJson(buildOpenRouterSubtitleBatchPrompt(items), {
      temperature: 0.18,
      maxTokens: Math.min(2200, 260 + items.length * 190),
      system: 'You are a professional subtitle translator. Return valid JSON only.'
    });
    const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.translations) ? parsed.translations : []);
    return rawList.map(x => ({ index: Number(x?.index), ar: cleanPuterArabicTranslation(x?.ar || x?.arabic || x?.translation || '') })).filter(x => Number.isFinite(x.index) && x.ar);
  }

  const PUTER_SUBTITLE_MODELS = ['gpt-5.4-nano', 'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4o-mini'];

  function cleanPuterArabicTranslation(text) {
    text = cleanLine(text || '');
    text = text.replace(/^```(?:json|arabic|ar)?\s*/i, '').replace(/```$/g, '').trim();
    text = text.replace(/^\s*["'“”]+|["'“”]+\s*$/g, '').trim();
    text = text.replace(/^Arabic\s*:\s*/i, '').replace(/^الترجمة\s*[:：]\s*/i, '').trim();
    return text;
  }

  function buildPuterSubtitlePrompt(text) {
    text = cleanLine(text || '');
    return `You are a professional subtitle translator.

Translate this English movie/series subtitle line into natural Arabic.

ENGLISH:
${text}

RULES:
- Return Arabic translation only.
- No explanations.
- No quotation marks.
- Keep it concise and natural for subtitles.
- Preserve tone, slang, implied meaning, jokes, and emotion.
- Use natural Arabic that is easy for an Egyptian Arabic-speaking learner to understand.`;
  }

  function buildPuterSubtitleBatchPrompt(items) {
    const rows = (items || []).map(x => ({ index: Number(x.index), en: cleanLine(x.text || x.en || '') })).filter(x => x.en);
    return `You are a professional subtitle translator.

Translate these English movie/series subtitle lines into natural Arabic.
Return JSON only.

INPUT JSON:
${JSON.stringify(rows, null, 2)}

OUTPUT FORMAT:
[
  {"index": 0, "ar": "..."}
]

RULES:
- Return valid JSON only. No markdown. No explanations.
- Keep every original index exactly the same.
- Translate each line naturally for subtitle use.
- Keep translations concise.
- Preserve tone, slang, implied meaning, jokes, and emotion.
- Use natural Arabic that is easy for an Egyptian Arabic-speaking learner to understand.`;
  }

  async function translatePuterSubtitle(text) {
    text = cleanLine(text || '');
    if (!text) return '';
    if (!window.puter?.ai?.chat) throw new Error('Puter AI is not loaded. Check your internet connection or reload the page.');
    const prompt = buildPuterSubtitlePrompt(text);
    let lastError = null;
    for (const model of PUTER_SUBTITLE_MODELS) {
      try {
        const response = await window.puter.ai.chat(prompt, { model, temperature: 0.2, max_tokens: 260 });
        const ar = cleanPuterArabicTranslation(puterResponseToText(response));
        if (ar && !/[A-Za-z]{4,}/.test(ar.slice(0, 80))) return ar;
        if (ar) return ar;
      } catch (e) {
        lastError = e;
        console.warn('Puter subtitle translation failed with model', model, e);
      }
    }
    throw lastError || new Error('Puter AI subtitle translation failed.');
  }

  async function translatePuterSubtitleItems(items) {
    items = (items || []).map(x => ({ index: Number(x.index), text: cleanLine(x.text || x.en || '') })).filter(x => x.text);
    if (!items.length) return [];
    if (!window.puter?.ai?.chat) throw new Error('Puter AI is not loaded. Check your internet connection or reload the page.');
    const prompt = buildPuterSubtitleBatchPrompt(items);
    let lastError = null;
    for (const model of PUTER_SUBTITLE_MODELS) {
      try {
        const response = await window.puter.ai.chat(prompt, { model, temperature: 0.2, max_tokens: Math.min(1800, 220 + items.length * 180) });
        const text = puterResponseToText(response);
        const parsed = parseJsonLoose(text);
        const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.translations) ? parsed.translations : []);
        const rows = rawList.map(x => ({ index: Number(x?.index), ar: cleanPuterArabicTranslation(x?.ar || x?.arabic || x?.translation || '') })).filter(x => Number.isFinite(x.index) && x.ar);
        if (rows.length) return rows;
      } catch (e) {
        lastError = e;
        console.warn('Puter subtitle batch translation failed with model', model, e);
      }
    }
    throw lastError || new Error('Puter AI subtitle batch translation failed.');
  }

  // Subtitle translation is Puter AI only (natural, Egyptian-friendly).
  // OpenRouter is reserved for fetching template examples elsewhere.
  // MyMemory remains the last-resort fallback in case Puter is unreachable.
  async function translateSubtitlePreferred(text) {
    try {
      return await translatePuterSubtitle(text);
    } catch (e) {
      console.warn('Puter subtitle translation unavailable. Falling back to MyMemory:', e);
      setStatus('Puter AI translation unavailable. MyMemory fallback is active.');
      try { return await translateMyMemory(text); } catch {}
      throw e;
    }
  }

  async function translateSubtitlePreferredItems(items) {
    try {
      return await translatePuterSubtitleItems(items);
    } catch (e) {
      console.warn('Puter subtitle batch unavailable. Falling back to MyMemory:', e);
      setStatus('Puter AI batch translation unavailable. MyMemory fallback is active.');
      try { return await translateMyMemoryItems(items); } catch {}
      throw e;
    }
  }

  async function fetchTemplateExamplesFromChatLlm(template, contextEn = '') {
    // Chats-LLM is intentionally disabled for template examples.
    // Template examples now use MyMemory translation-memory lookup + MyMemory translation only.
    return [];
  }

  // Build a Puter-AI prompt that asks for natural Egyptian-Arabic translations
  // of template examples. Returns JSON keyed by index.
  function buildPuterExampleBatchPrompt(items) {
    const rows = (items || [])
      .map(x => ({ index: Number(x.index), en: cleanLine(x.en || x.text || '') }))
      .filter(x => x.en);
    return `You are translating short English example sentences for an Arabic learner.

Translate each English sentence into NATURAL EVERYDAY ARABIC that leans toward EGYPTIAN COLLOQUIAL ARABIC (المصرية الدارجة).
- Make it sound like how a real Egyptian friend would say it in daily life.
- Keep slang, jokes, and emotional tone.
- Do NOT use stiff formal Modern Standard Arabic.
- Do NOT add explanations or transliteration.
- Keep each translation short (subtitle-length).

Return JSON only in this exact shape:
{"translations":[${rows.map(r => `{"index":${r.index},"ar":"<egyptian arabic translation>"}`).join(',')}]}

ENGLISH ITEMS:
${rows.map(r => `${r.index}) ${r.en}`).join('\n')}`;
  }

  // Batch-translate English template examples to Arabic via Puter AI, with
  // an Egyptian-dialect bias. Falls back to MyMemory on failure.
  async function translateTemplateExamplesWithPuter(examples) {
    const items = (examples || [])
      .map((ex, index) => ({ index, en: cleanLine(ex?.en || '') }))
      .filter(x => x.en);
    if (!items.length) return [];
    if (!window.puter?.ai?.chat) throw new Error('Puter AI is not loaded.');
    const prompt = buildPuterExampleBatchPrompt(items);
    let lastError = null;
    for (const model of PUTER_SUBTITLE_MODELS) {
      try {
        const response = await window.puter.ai.chat(prompt, {
          model,
          temperature: 0.35,
          max_tokens: Math.min(1400, 200 + items.length * 140)
        });
        const text = puterResponseToText(response);
        const parsed = parseJsonLoose(text);
        const rawList = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.translations) ? parsed.translations : []);
        const rows = rawList
          .map(x => ({ index: Number(x?.index), ar: cleanPuterArabicTranslation(x?.ar || x?.arabic || x?.translation || '') }))
          .filter(x => Number.isFinite(x.index) && x.ar);
        if (rows.length) return rows;
      } catch (e) {
        lastError = e;
        console.warn('Puter example batch translation failed with model', model, e);
      }
    }
    throw lastError || new Error('Puter AI example translation failed.');
  }

  // Public entry point used after examples are generated. Tries Puter AI first
  // (Egyptian dialect, much more natural), then MyMemory as a fallback.
  // The original name is preserved so existing callers keep working.
  async function translateTemplateExamplesWithMyMemory(examples) {
    const list = sanitizeTemplateExamples(examples || []);
    if (!list.length) return [];
    const need = list.map((ex, index) => ({ ex, index })).filter(x => !x.ex.ar || looksLikeTemplatePlaceholderArabic(x.ex.ar));
    if (!need.length) return list.slice(0, 3);

    // Puter AI first — natural Egyptian-style Arabic.
    try {
      const rows = await translateTemplateExamplesWithPuter(need.map(x => ({ index: x.index, en: x.ex.en })));
      const map = new Map((rows || []).map(r => [Number(r.index), r.ar]));
      let filled = 0;
      for (const { ex, index } of need) {
        const ar = map.get(Number(index));
        if (ar) { ex.ar = cleanLine(ar); filled++; }
      }
      if (filled >= need.length) return list.slice(0, 3);
    } catch (e) {
      console.warn('Puter example translation unavailable. Falling back to MyMemory:', e);
    }

    // MyMemory fallback for whichever examples Puter couldn't translate.
    const stillNeed = list
      .map((ex, index) => ({ ex, index }))
      .filter(x => !x.ex.ar || looksLikeTemplatePlaceholderArabic(x.ex.ar));
    if (!stillNeed.length) return list.slice(0, 3);
    try {
      const translated = await translateMyMemoryItems(stillNeed.map(x => ({ index: x.index, text: x.ex.en })));
      for (const row of translated || []) {
        const idx = Number(row.index);
        if (list[idx] && row.ar) list[idx].ar = cleanLine(row.ar);
      }
    } catch (e) {
      console.warn('MyMemory template example translation failed:', e);
      for (const row of stillNeed) {
        try { row.ex.ar = await translateMyMemory(row.ex.en); } catch {}
      }
    }
    return list.slice(0, 3);
  }

  async function fetchTemplateExamplesFromMyMemory(template, contextEn = '') {
    const queries = templateSearchQueries(template, contextEn);
    if (!queries.length) return [];
    const examples = [];
    const seen = new Set();
    const pattern = template?.pattern || '';

    const addCandidate = (en, ar = '', source = 'mymemory') => {
      en = cleanLine(en || '');
      ar = cleanLine(ar || '');
      if (!en || looksLikeBadTemplateExample(en)) return;
      if (!isUsableTemplateExampleForPattern(pattern, en)) return;
      const key = en.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      examples.push({ en, ar, source });
    };

    for (const query of queries) {
      const data = await fetchMyMemoryExamplesPayload(query, 8);
      const matches = Array.isArray(data.matches) ? data.matches : [];
      for (const m of matches) {
        addCandidate(m.en || m.segment || '', m.ar || m.translation || '', m.source || 'mymemory');
        if (examples.length >= 3) return examples;
      }

      // If the TM does not return enough reusable examples, keep the complete query itself.
      // MyMemory will still be used to translate it to Arabic in translateTemplateExamplesWithMyMemory().
      addCandidate(query, '', 'mymemory-query');
      if (examples.length >= 3) return examples;
      await new Promise(resolve => setTimeout(resolve, 220));
    }
    return examples;
  }

  async function generateTemplateExamplesWithMyMemory(template, contextEn = '') {
    if (!template?.pattern) return [];

    // Priority now:
    // 1) Real matching lines already present in the uploaded subtitle file.
    // 2) OpenRouter free models if a key is saved.
    // 3) Puter AI fallback generates natural daily-life examples from the template.
    // 4) MyMemory translation-memory matches and translation fallback.
    // 5) Safe daily-life examples built from the template, then translated with MyMemory.
    let candidates = [];
    candidates = candidates.concat(examplesFromCurrentSubtitles(template, contextEn));

    if (candidates.length < 3 && getOpenRouterConfig().apiKey) {
      try {
        const openRouterExamples = await fetchTemplateExamplesFromOpenRouter(template, contextEn || template.source || '');
        candidates = candidates.concat(openRouterExamples);
      } catch (e) {
        console.warn('OpenRouter examples unavailable, falling back to Puter AI:', e);
        setStatus('OpenRouter examples unavailable. Puter AI fallback is active...');
      }
    }

    if (candidates.length < 3) {
      try {
        const aiExamples = await fetchTemplateExamplesFromPuter(template, contextEn || template.source || '');
        candidates = candidates.concat(aiExamples);
      } catch (e) {
        console.warn('Puter AI examples unavailable, falling back to MyMemory:', e);
        setStatus('Puter AI unavailable. Falling back to MyMemory examples...');
      }
    }

    if (candidates.length < 3) candidates = candidates.concat(await fetchTemplateExamplesFromMyMemory(template, contextEn));
    if (candidates.length < 3) candidates = candidates.concat(makeDailyTemplateExamples(template.pattern, contextEn || template.source || ''));
    if (candidates.length < 3) candidates = candidates.concat(makeGenericTemplateExamples(template, contextEn || template.source || ''));

    const clean = sanitizeTemplateExamples(candidates, template.pattern, contextEn || template.source || '');
    return await translateTemplateExamplesWithMyMemory(clean);
  }

  async function ensureNaturalTemplateExamples(template, contextEn = '', force = false) {
    let baseExamples = sanitizeTemplateExamples(template.examples || [], template.pattern, contextEn || template.source || '');
    const hasBadOriginal = (template.examples || []).some(ex => looksLikeBadTemplateExample(ex) || looksLikeTemplatePlaceholderArabic(ex?.ar));
    const needsArabic = baseExamples.some(ex => !ex.ar || looksLikeTemplatePlaceholderArabic(ex.ar));

    if (!force && baseExamples.length >= 3 && !hasBadOriginal && !needsArabic) {
      return { ...template, examples: baseExamples };
    }

    const fresh = await generateTemplateExamplesWithMyMemory(template, contextEn || template.source || '');
    if (fresh.length) baseExamples = fresh;

    const translatedExamples = await translateTemplateExamplesWithMyMemory(baseExamples);
    const finalExamples = sanitizeTemplateExamples(translatedExamples.length ? translatedExamples : baseExamples, template.pattern, contextEn || template.source || '');
    return { ...template, examples: finalExamples };
  }

  async function refreshTemplateExamplesByIndex(index) {
    const item = state.savedWords[Number(index)];
    if (!item || item.kind !== 'template') return toast('Template not found');
    setStatus('Generating natural daily examples with OpenRouter AI...');
    const template = {
      pattern: item.word,
      source: item.contextEn || '',
      slot: item.templateSlot || '',
      examples: item.examples || []
    };
    const improved = await ensureNaturalTemplateExamples(template, item.contextEn || '', true);
    item.examples = improved.examples;
    item.updatedAt = new Date().toISOString();
    state.savedWords[index] = normalizeSavedWord(item);
    writeJSON('jm_saved_words', state.savedWords.map(normalizeSavedWord));
    debounceSave();
    scheduleCloudLibrarySync();
    showSaved('templates');
    toast('Examples updated with AI');
    setStatus('Template examples updated with OpenRouter/Puter and synced');
  }

  async function refreshAllTemplateExamples() {
    const templateIndexes = state.savedWords
      .map((item, index) => ({ item, index }))
      .filter(x => x.item && x.item.kind === 'template');
    if (!templateIndexes.length) return toast('No saved templates yet');
    setStatus('Improving templates with OpenRouter/Puter examples...');
    let count = 0;
    for (const { item, index } of templateIndexes) {
      const template = { pattern: item.word, source: item.contextEn || '', slot: item.templateSlot || '', examples: item.examples || [] };
      const improved = await ensureNaturalTemplateExamples(template, item.contextEn || '', true);
      state.savedWords[index] = normalizeSavedWord({ ...item, examples: improved.examples, updatedAt: new Date().toISOString() });
      count++;
      if (count % 5 === 0) { writeJSON('jm_saved_words', state.savedWords.map(normalizeSavedWord)); scheduleCloudLibrarySync(); setStatus(`Improved ${count} templates...`); }
    }
    writeJSON('jm_saved_words', state.savedWords.map(normalizeSavedWord));
    debounceSave();
    scheduleCloudLibrarySync();
    showSaved('templates');
    toast(`${count} template examples improved with AI`);
    setStatus('MyMemory template examples saved to cloud sync queue');
  }

  function persistSavedWordsAfterTemplateEdit() {
    state.savedWords = state.savedWords
      .map(normalizeSavedWord)
      .filter(x => x.word && !isHiddenCloudSettingsItem(x));
    writeJSON('jm_saved_words', state.savedWords);
    if (typeof rebuildSavedWordSet === 'function') rebuildSavedWordSet();
    if (state.subtitles?.length) { recomputeHfCount(); renderList(state.listCenter); updateDock(null); }
    debounceSave();
  }

  async function syncTemplateDeletionToCloud(count, itemLabel = 'template') {
    const ok = await syncSavedItemsToCloud({ silent: true, reason: 'template-delete' });
    if (ok) {
      setStatus(`${count} ${itemLabel}${count === 1 ? '' : 's'} deleted from Supabase`);
      toast(count === 1 ? 'Template deleted and synced' : `${count} templates deleted and synced`);
    } else {
      setStatus(`${count} ${itemLabel}${count === 1 ? '' : 's'} deleted locally. Cloud sync failed; try Sync saved items.`);
      toast('Deleted locally. Cloud sync failed');
    }
  }

  async function deleteTemplateByIndex(index) {
    index = Number(index);
    const item = state.savedWords[index];
    if (!item || item.kind !== 'template') return toast('Template not found');
    const label = cleanLine(item.word || 'this template');
    if (!confirm(`Delete this saved template?\n\n${label}`)) return;
    state.savedWords.splice(index, 1);
    persistSavedWordsAfterTemplateEdit();
    showSaved('templates');
    setStatus('Deleting template from Supabase...');
    await syncTemplateDeletionToCloud(1, 'template');
  }

  function getSelectedTemplateIndexes() {
    return [...document.querySelectorAll('[data-template-select]:checked')]
      .map(input => Number(input.dataset.templateSelect))
      .filter(index => Number.isInteger(index) && state.savedWords[index]?.kind === 'template');
  }

  async function deleteSelectedTemplates() {
    const indexes = [...new Set(getSelectedTemplateIndexes())].sort((a, b) => b - a);
    if (!indexes.length) return toast('Select one or more templates first');
    if (!confirm(`Delete ${indexes.length} selected saved template${indexes.length === 1 ? '' : 's'}?`)) return;
    for (const index of indexes) state.savedWords.splice(index, 1);
    persistSavedWordsAfterTemplateEdit();
    showSaved('templates');
    setStatus('Deleting selected templates from Supabase...');
    await syncTemplateDeletionToCloud(indexes.length, 'template');
  }

  async function deleteAllTemplates() {
    const count = state.savedWords.filter(x => x.kind === 'template').length;
    if (!count) return toast('No saved templates to delete');
    if (!confirm(`Delete ALL saved templates?\n\nThis will remove ${count} templates from this device and Supabase. Saved words, phrases, and lines will stay.`)) return;
    state.savedWords = state.savedWords.filter(x => x.kind !== 'template');
    persistSavedWordsAfterTemplateEdit();
    showSaved('templates');
    setStatus('Deleting all templates from Supabase...');
    await syncTemplateDeletionToCloud(count, 'template');
  }

  const CLOUD_CONFIG = {
    url: 'https://gyybwibqkasakgwfpkxz.supabase.co',
    key: 'sb_publishable_ZvjDNnkXMcXMrmVQDdWQwg_mSJPKW8L',
    userCode: 'Romioo@1985'
  };
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  function lineKey(item) {
    return `${Math.round((item?.startTime || 0) * 1000)}-${cleanLine(item?.en || '').slice(0, 80).toLowerCase()}`;
  }

  function normalizeSavedLine(line) {
    const now = new Date().toISOString();
    return {
      ...line,
      key: line.key || lineKey(line),
      ar: line.ar || '',
      sourceTitle: cleanLine(line.sourceTitle || ''),
      savedAt: line.savedAt || now,
      dueAt: line.dueAt || now,
      phase: line.phase || (Number(line.intervalDays) > 0 ? 'review' : 'learning'),
      learningStep: Number(line.learningStep || 0),
      intervalDays: Number(line.intervalDays || 0),
      ease: Number(line.ease || 2.5),
      reviewCount: Number(line.reviewCount || 0),
      lapses: Number(line.lapses || 0),
      lastReviewedAt: line.lastReviewedAt || '',
      lastRating: line.lastRating || ''
    };
  }


  function wordKey(word) {
    return `word:${String(word || '').trim().toLowerCase()}`;
  }

  function normalizeSavedWord(word) {
    const now = new Date().toISOString();
    const cleanWord = String(word?.word || '').trim();
    const explicitKind = String(word?.kind || '').toLowerCase();
    const kind = explicitKind === 'template' ? 'template' : (explicitKind === 'phrase' || /\s+/.test(cleanWord) ? 'phrase' : 'word');
    return {
      ...word,
      kind,
      word: cleanWord,
      key: word.key || wordKey(cleanWord),
      ar: word.ar || '',
      contextEn: word.contextEn || '',
      contextAr: word.contextAr || '',
      examples: Array.isArray(word.examples) ? word.examples : [],
      sourceLineKey: word.sourceLineKey || '',
      sourceTitle: cleanLine(word.sourceTitle || ''),
      startTime: Number(word.startTime || 0),
      savedAt: word.savedAt || now,
      dueAt: word.dueAt || now,
      // SRS phase fields (Anki-style learning steps in m/h, then review in d).
      phase: word.phase || (Number(word.intervalDays) > 0 ? 'review' : 'learning'),
      learningStep: Number(word.learningStep || 0),
      intervalDays: Number(word.intervalDays || 0),
      ease: Number(word.ease || 2.5),
      reviewCount: Number(word.reviewCount || 0),
      lapses: Number(word.lapses || 0),
      lastReviewedAt: word.lastReviewedAt || '',
      lastRating: word.lastRating || ''
    };
  }

  function loadScript(src) { return new Promise((resolve, reject) => { const existing = [...document.scripts].find(s => s.src === src); if (existing) return resolve(); const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); }); }



  function savedWordMergeKey(item) {
    const kind = String(item?.kind || 'word').toLowerCase();
    return `${kind}:${String(item?.word || '').trim().toLowerCase()}`;
  }

  function savedLineMergeKey(item) {
    return String(item?.key || lineKey(item) || `${Math.round((item?.startTime || 0) * 1000)}:${cleanLine(item?.en || '').slice(0, 80).toLowerCase()}`);
  }

  function itemDateValue(item) {
    const raw = item?.updatedAt || item?.lastReviewedAt || item?.savedAt || item?.createdAt || '';
    const t = raw ? Date.parse(raw) : 0;
    return Number.isFinite(t) ? t : 0;
  }

  function mergeByKey(localArr, remoteArr, keyFn, normalizeFn) {
    const map = new Map();
    const put = (item, source) => {
      const normalized = normalizeFn(item);
      const key = keyFn(normalized);
      if (!key || key === 'word:' || key === 'phrase:') return;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...normalized, _source: source });
        return;
      }
      const existingDate = itemDateValue(existing);
      const incomingDate = itemDateValue(normalized);
      const chosen = incomingDate >= existingDate
        ? { ...existing, ...normalized }
        : { ...normalized, ...existing };
      // Preserve review metadata conservatively so progress is not lost.
      chosen.reviewCount = Math.max(Number(existing.reviewCount || 0), Number(normalized.reviewCount || 0));
      chosen.knownCount = Math.max(Number(existing.knownCount || 0), Number(normalized.knownCount || 0));
      const dueA = existing.dueAt ? Date.parse(existing.dueAt) : 0;
      const dueB = normalized.dueAt ? Date.parse(normalized.dueAt) : 0;
      if (dueA && dueB) chosen.dueAt = dueA <= dueB ? existing.dueAt : normalized.dueAt;
      else chosen.dueAt = existing.dueAt || normalized.dueAt || chosen.dueAt;
      map.set(key, chosen);
    };
    (remoteArr || []).forEach(x => put(x, 'remote'));
    (localArr || []).forEach(x => put(x, 'local'));
    return [...map.values()].map(({_source, ...x}) => normalizeFn(x));
  }

  function normalizeLibraryState() {
    state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word && !isHiddenCloudSettingsItem(x));
    state.savedLines = state.savedLines.map(normalizeSavedLine).filter(x => x.en || x.ar);
  }

  function cloudSyncLabel() {
    return state.cloudLastSyncAt ? `Last cloud sync: ${new Date(state.cloudLastSyncAt).toLocaleString()}` : 'Not synced yet';
  }

  const VIDEO_CACHE_DB = 'jungle_movie_video_cache_v1';
  const VIDEO_CACHE_STORE = 'videos';

  function isCacheableVideoUrl(url) {
    url = String(url || '').trim();
    if (!/^https?:\/\//i.test(url)) return false;
    if (extractYtId(url)) return false;
    if (/\.m3u8(?:[?#]|$)/i.test(url)) return false;
    return true;
  }

  function openVideoCacheDb() {
    if (state.cacheDbPromise) return state.cacheDbPromise;
    state.cacheDbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB is not supported on this browser.'));
      const req = indexedDB.open(VIDEO_CACHE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(VIDEO_CACHE_STORE)) db.createObjectStore(VIDEO_CACHE_STORE, { keyPath: 'url' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Cannot open video cache.'));
    });
    return state.cacheDbPromise;
  }

  async function getCachedVideo(url) {
    try {
      const db = await openVideoCacheDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_CACHE_STORE, 'readonly');
        const req = tx.objectStore(VIDEO_CACHE_STORE).get(url);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('Video cache read failed', e);
      return null;
    }
  }

  async function putCachedVideo(url, blob, meta = {}) {
    const db = await openVideoCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_CACHE_STORE, 'readwrite');
      tx.objectStore(VIDEO_CACHE_STORE).put({
        url,
        blob,
        size: blob.size,
        type: blob.type || meta.type || 'video/mp4',
        title: meta.title || '',
        savedAt: new Date().toISOString()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Could not save video cache.'));
    });
  }

  async function removeCachedVideo(url) {
    const db = await openVideoCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_CACHE_STORE, 'readwrite');
      tx.objectStore(VIDEO_CACHE_STORE).delete(url);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Could not delete cached video.'));
    });
  }

  function humanSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  async function fetchVideoBlobWithProgress(url) {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`Video download failed: ${res.status}`);
    const type = res.headers.get('content-type') || 'video/mp4';
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !res.body.getReader) {
      setStatus('Downloading video cache...');
      return await res.blob();
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total) setStatus(`Caching video ${Math.round(received / total * 100)}% • ${humanSize(received)} / ${humanSize(total)}`);
      else setStatus(`Caching video... ${humanSize(received)}`);
      await new Promise(r => setTimeout(r, 0));
    }
    return new Blob(chunks, { type });
  }

  async function cacheCurrentVideo() {
    const url = state.videoUrl && !String(state.videoUrl).startsWith('blob:') ? state.videoUrl : (localStorage.getItem('jm_video_url') || '');
    if (!isCacheableVideoUrl(url)) {
      toast('This video type cannot be cached. Use a direct MP4/WebM URL.');
      setStatus('Cache works best with direct MP4/WebM links, not YouTube, HLS/M3U8, or local blob links.');
      return;
    }
    try {
      const existing = await getCachedVideo(url);
      if (existing?.blob) {
        toast(`Already cached: ${humanSize(existing.size)}`);
        setStatus(`Cached video ready: ${humanSize(existing.size)}`);
        return;
      }
      if (!confirm('Download and save this video on this device for faster seeking? Large movies may need storage space.')) return;
      setStatus('Starting video cache download...');
      const blob = await fetchVideoBlobWithProgress(url);
      await putCachedVideo(url, blob, { title: document.title, type: blob.type });
      localStorage.setItem('jm_video_cache_url', url);
      toast('Video cached on this device');
      setStatus(`Cached video saved: ${humanSize(blob.size)}. Reopening and deep seeking should be faster.`);
      await loadUrl(url, { useCache: true, autoplay: false });
    } catch (e) {
      console.error(e);
      toast('Could not cache this video');
      setStatus('Video cache failed. The server may block CORS downloads, or device storage may be full.');
    }
  }

  async function cachedPlaybackUrl(originalUrl, opts = {}) {
    state.usingCachedVideo = false;
    if (!isCacheableVideoUrl(originalUrl)) return originalUrl;
    const cached = await getCachedVideo(originalUrl);
    if (!cached?.blob) {
      if (opts.forceCache) toast('No cached video found for this link');
      return originalUrl;
    }
    if (state.videoBlobUrl) {
      try { URL.revokeObjectURL(state.videoBlobUrl); } catch {}
      state.videoBlobUrl = '';
    }
    state.videoBlobUrl = URL.createObjectURL(cached.blob);
    state.usingCachedVideo = true;
    setStatus(`Using cached video • ${humanSize(cached.size)}`);
    return state.videoBlobUrl;
  }

  async function useCachedVideo() {
    const url = state.videoUrl || localStorage.getItem('jm_video_url') || localStorage.getItem('jm_video_cache_url') || '';
    if (!url) return toast('No video link found');
    await loadUrl(url, { useCache: true, forceCache: true, autoplay: false });
  }

  async function clearCurrentVideoCache() {
    const url = state.videoUrl || localStorage.getItem('jm_video_url') || localStorage.getItem('jm_video_cache_url') || '';
    if (!url) return toast('No cached video selected');
    try {
      await removeCachedVideo(url);
      localStorage.removeItem('jm_video_cache_url');
      if (state.videoBlobUrl) { try { URL.revokeObjectURL(state.videoBlobUrl); } catch {} state.videoBlobUrl = ''; }
      state.usingCachedVideo = false;
      toast('Video cache cleared');
      setStatus('Cached video removed from this device.');
    } catch (e) {
      console.error(e);
      toast('Could not clear cache');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // PRO VIDEO CACHE — auto-save once watched + silent failover
  //
  // 1. AUTO-CACHE  When the user has watched >= AUTO_CACHE_THRESHOLD of a
  //    cacheable URL, we silently download the blob to IndexedDB (after a
  //    one-time consent prompt). The user's "yes/no" is remembered forever
  //    via localStorage so it never asks again.
  //
  // 2. FAILOVER    If the original URL errors out later (link expired,
  //    server hiccup, CORS change), the player swaps to the cached blob
  //    transparently. No interrupted lessons.
  // ════════════════════════════════════════════════════════════════

  const AUTO_CACHE_THRESHOLD = 0.80;
  const AUTO_CACHE_CONSENT_KEY = 'jm_auto_cache_consent'; // 'ask' | 'yes' | 'no'

  function getAutoCacheConsent() {
    const v = localStorage.getItem(AUTO_CACHE_CONSENT_KEY);
    return v === 'yes' || v === 'no' ? v : 'ask';
  }
  function setAutoCacheConsent(v) { localStorage.setItem(AUTO_CACHE_CONSENT_KEY, v); }

  // Called on every timeupdate of the HTML5 video. Cheap: bails out fast for
  // non-cacheable URLs and after the first hit per URL per session.
  function checkAutoCacheThreshold() {
    if (state.playerType !== 'html5') return;
    if (state.usingCachedVideo) return;                // already on cache
    if (state.autoCacheBusy) return;
    const url = state.videoUrl;
    if (!url || state.coverageHit.has(url)) return;
    if (!isCacheableVideoUrl(url)) return;
    const dur = el.movie.duration || 0;
    if (!dur || !isFinite(dur)) return;
    const pct = el.movie.currentTime / dur;
    if (pct < AUTO_CACHE_THRESHOLD) return;
    state.coverageHit.add(url);
    triggerAutoCache(url).catch(e => console.warn('Auto-cache failed:', e));
  }

  async function triggerAutoCache(url) {
    // Skip silently when the same URL is already cached.
    try {
      const existing = await getCachedVideo(url);
      if (existing?.blob) { setStatus(`Already cached • ${humanSize(existing.size)}`); return; }
    } catch {}

    let consent = getAutoCacheConsent();
    if (consent === 'no') return;
    if (consent === 'ask') {
      // One-time ask. Phrased so the user understands the recovery value.
      const ok = confirm(
        "You've watched most of this video.\n\n" +
        "Save it on this device so it keeps working even if the link expires or the host has a hiccup?\n\n" +
        "(Stored in your browser only. You can clear it any time from Menu → Video cache.)"
      );
      consent = ok ? 'yes' : 'no';
      setAutoCacheConsent(consent);
      if (!ok) return;
    }

    if (state.autoCacheBusy) return;
    state.autoCacheBusy = true;
    try {
      setStatus('Auto-caching this video for offline / fallback…');
      const blob = await fetchVideoBlobWithProgress(url);
      await putCachedVideo(url, blob, { title: document.title, type: blob.type });
      localStorage.setItem('jm_video_cache_url', url);
      toast(`Cached for offline (${humanSize(blob.size)})`);
      setStatus(`Auto-cached • ${humanSize(blob.size)}. If the link fails later, the player switches to your cache silently.`);
    } catch (e) {
      console.warn('Auto-cache failed', e);
      setStatus('Auto-cache failed — the host may block CORS downloads. You can still cache manually from Menu → Video cache.');
    } finally {
      state.autoCacheBusy = false;
    }
  }

  // Called when <video> fires an error. Tries to switch to a cached copy of
  // the same URL once per URL per session, so a flaky link recovers seamlessly.
  async function handleVideoFailover() {
    if (state.playerType !== 'html5') return;
    if (state.usingCachedVideo) return;
    const url = state.videoUrl;
    if (!url || state.failoverTried.has(url)) return;
    state.failoverTried.add(url);
    try {
      const cached = await getCachedVideo(url);
      if (!cached?.blob) return;       // nothing to fall back to
      toast('Original link failed — switching to your cache');
      setStatus('Original URL is not responding. Loading from your cache…');
      await loadUrl(url, { useCache: true, forceCache: true, autoplay: true });
    } catch (e) {
      console.warn('Failover check failed', e);
    }
  }

  function parseSrt(content) {
    const blocks = String(content || '').replace(/\r/g, '').trim().split(/\n\s*\n/);
    const out = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(x => x.trim()).filter(Boolean);
      const timeIndex = lines.findIndex(l => l.includes('-->'));
      if (timeIndex < 0) continue;
      const [a, b] = lines[timeIndex].split('-->').map(x => x.trim());
      const textLines = lines.slice(timeIndex + 1);
      if (!textLines.length) continue;
      const ar = textLines.filter(l => /[\u0600-\u06FF]/.test(l)).join('<br>');
      const en = textLines.filter(l => !/[\u0600-\u06FF]/.test(l)).join(' ');
      const text = en || textLines.join(' ');
      if (shouldIgnoreSubtitle(text)) continue;
      out.push({ startTime: parseTime(a), endTime: parseTime(b), en: text, ar, time: formatTime(parseTime(a)) });
    }
    out.sort((x, y) => x.startTime - y.startTime);
    return out;
  }

  function parseHtmlTable(content) {
    const d = document.createElement('div'); d.innerHTML = content;
    const rows = [...d.querySelectorAll('tr')];
    const out = [];
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (tds.length < 2) continue;
      const time = tds[0].innerText.trim();
      const en = tds[1].innerHTML.trim();
      const ar = tds[2]?.innerHTML.trim() || '';
      if (!time.includes(':') || shouldIgnoreSubtitle(en)) continue;
      out.push({ startTime: parseTime(time), endTime: 0, en, ar, time: formatTime(parseTime(time)) });
    }
    for (let i=0;i<out.length;i++) out[i].endTime = Math.min(out[i].startTime + 6, (out[i+1]?.startTime ?? out[i].startTime + 6) - .01);
    return out;
  }

  function handleSubtitleContent(content) {
    const lower = content.toLowerCase();
    state.subtitles = (lower.includes('<table') || lower.includes('<tr')) ? parseHtmlTable(content) : parseSrt(content);
    state.activeIndex = -1; state.lastIndex = -1; state.lastWordIndex = -1; state.listCenter = 0; state.repeatStart = -1; state.repeatEnd = -1;
    setStatus(`${state.subtitles.length} subtitles loaded`);
    renderList(0);
    updateDock(null);
    saveState();
    // Load the high-frequency word list (cached after first time), then
    // re-render so key words get highlighted automatically.
    ensureHfThenRefresh();
  }

  function findIndexAt(time) {
    let lo = 0, hi = state.subtitles.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const item = state.subtitles[mid];
      if (time < item.startTime) hi = mid - 1;
      else if (time > item.endTime) { ans = mid; lo = mid + 1; }
      else return mid;
    }
    return -1;
  }

  function getMediaTime() {
    if (state.playerType === 'html5') return el.movie.currentTime || 0;
    if (state.playerType === 'youtube' && state.yt?.getCurrentTime) return state.yt.getCurrentTime() || 0;
    return 0;
  }

  function subtitleTimeToMediaTime(time) {
    // syncLoop uses: subtitleTime = mediaTime - offset
    // so a click on subtitle time must seek to: subtitleTime + offset.
    return Math.max(0, (Number(time) || 0) + state.offset - 0.08);
  }

  function waitForEvent(target, names, timeout = 4500, predicate = null) {
    names = Array.isArray(names) ? names : [names];
    return new Promise(resolve => {
      let done = false;
      const cleanup = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        names.forEach(n => target.removeEventListener(n, onEvent));
        resolve(ok);
      };
      const onEvent = () => { if (!predicate || predicate()) cleanup(true); };
      names.forEach(n => target.addEventListener(n, onEvent, { passive: true }));
      const timer = setTimeout(() => cleanup(predicate ? !!predicate() : false), timeout);
      if (predicate && predicate()) cleanup(true);
    });
  }

  function getBufferedAhead(target) {
    const ranges = el.movie.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (target >= ranges.start(i) && target <= ranges.end(i)) return Math.max(0, ranges.end(i) - target);
    }
    return 0;
  }

  function canUseTimeFragment(url) {
    if (!url || url.startsWith('blob:') || /\.m3u8(?:[?#]|$)/i.test(url)) return false;
    return /^https?:/i.test(url) || /\.(mp4|webm|ogg)(?:[?#]|$)/i.test(url);
  }

  function urlWithTimeFragment(url, target) {
    const base = String(url || '').split('#')[0];
    return `${base}#t=${Math.max(0, target).toFixed(2)}`;
  }

  async function playMediaElement() {
    el.movie.playbackRate = state.speed;
    if (el.movie.paused) {
      try { await el.movie.play(); } catch (e) {
        // Mobile browsers may require one user gesture; the seek still happens, and the user can press play.
      }
    }
  }

  async function html5SmartSeek(target, play = true, opts = {}) {
    const token = Date.now() + Math.random();
    state.seekToken = token;
    state.isSeeking = true;
    state.seekGuardUntil = performance.now() + 1800;
    state.lastSeekTarget = target;
    setStatus(`Seeking ${formatTime(target)}...`);

    const finish = ok => {
      if (state.seekToken === token) {
        state.isSeeking = false;
        state.seekGuardUntil = performance.now() + 500;
        if (ok) setStatus(`Ready at ${formatTime(el.movie.currentTime || target)}`);
      }
      return ok;
    };

    try {
      if (!Number.isFinite(el.movie.duration) || el.movie.readyState < 1) {
        try { el.movie.load(); } catch {}
        await waitForEvent(el.movie, ['loadedmetadata','durationchange'], 6000, () => el.movie.readyState >= 1 || Number.isFinite(el.movie.duration));
      }

      el.movie.playbackRate = state.speed;
      try { el.movie.currentTime = target; } catch {}
      if (play) playMediaElement();

      let ok = await waitForEvent(el.movie, ['seeked','canplay','playing','timeupdate'], 5200, () => {
        const near = Math.abs((el.movie.currentTime || 0) - target) < 2.2;
        return near && (el.movie.readyState >= 2 || getBufferedAhead(target) > 0.5);
      });

      if (!ok && !state.usingCachedVideo && canUseTimeFragment(state.videoUrl)) {
        // Some MP4/CDN links freeze on deep seeks unless the browser starts the request with a media fragment.
        setStatus('Recovering stream near requested scene...');
        const src = urlWithTimeFragment(state.videoUrl, target);
        try { el.movie.pause(); } catch {}
        el.movie.src = src;
        try { el.movie.load(); } catch {}
        await waitForEvent(el.movie, ['loadedmetadata','durationchange'], 6500, () => el.movie.readyState >= 1 || Number.isFinite(el.movie.duration));
        try { if (Math.abs((el.movie.currentTime || 0) - target) > 3) el.movie.currentTime = target; } catch {}
        if (play) await playMediaElement();
        ok = await waitForEvent(el.movie, ['playing','canplay','timeupdate','seeked'], 6500, () => {
          const near = Math.abs((el.movie.currentTime || 0) - target) < 3.5 || (el.movie.currentTime || 0) > target - 4;
          return near && (el.movie.readyState >= 2 || !el.movie.paused);
        });
      }

      if (!ok) {
        setStatus('The video link is slow or does not support reliable seeking. Try MP4 with byte-range support or HLS/M3U8.');
        toast('Seek is stuck: use Recover video or a better direct MP4/HLS link');
      }
      return finish(ok);
    } catch (err) {
      console.warn('Smart seek failed', err);
      setStatus('Could not seek this video link reliably.');
      toast('Video seek failed');
      return finish(false);
    }
  }

  function seekMedia(time, play=true, opts = {}) {
    const target = subtitleTimeToMediaTime(time);
    state.lastSeekSubtitleTime = Number(time) || 0;
    if (state.playerType === 'html5') { html5SmartSeek(target, play, opts); }
    if (state.playerType === 'youtube' && state.yt?.seekTo) {
      state.seekGuardUntil = performance.now() + 900;
      state.lastSeekTarget = target;
      state.yt.seekTo(target, true);
      if (play) state.yt.playVideo();
      if (state.yt.setPlaybackRate) state.yt.setPlaybackRate(state.speed);
    }
  }

  function updateWordProgress(item, currentTime) {
    const words = tokenize(item.en);
    if (!words.length) return -1;
    const duration = Math.max(.5, item.endTime - item.startTime);
    const ratio = Math.min(1, Math.max(0, (currentTime - item.startTime) / duration));
    return Math.min(words.length - 1, Math.floor(ratio * words.length));
  }

  function wordHtml(text, activeWordIndex = -1) {
    const raw = cleanLine(text);
    const parts = raw.split(/([A-Za-zÀ-ÿ0-9]+(?:[-'][A-Za-zÀ-ÿ0-9]+)*)/g);
    let wordNo = -1;
    return parts.map(part => {
      if (/^[A-Za-zÀ-ÿ0-9]+(?:[-'][A-Za-zÀ-ÿ0-9]+)*$/.test(part)) {
        wordNo++;
        const active = wordNo === activeWordIndex ? ' active' : '';
        // Precedence: saved (pink, top — most personal) → reduction (teal) →
        // CEFR B1–C2 (orange) → high-freq (purple).
        let tier = '', extraAttr = '';
        if (isSavedWord(part)) tier = ' saved';
        else if (state.highlightHF) {
          const redKey = reductionKey(part);
          if (redKey) { tier = ' reduction'; extraAttr = ` data-reduction="${escapeHtml(redKey)}"`; }
          else if (isAdvancedWord(part)) { tier = ' cefr'; const lv = cefrLevelOf(part); if (lv) extraAttr = ` data-level="${lv}"`; }
          else if (isHighFreqWord(part)) tier = ' hf';
        }
        return `<span class="word${active}${tier}" data-word="${escapeHtml(part)}"${extraAttr}>${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    }).join('');
  }

  function updateDock(item, wordIndex = -1) {
    if (!item) {
      if (state.lastIndex >= 0) item = state.subtitles[state.lastIndex]; else { el.subtitleDock.classList.add('hidden'); return; }
      wordIndex = state.lastWordIndex;
    }
    el.subtitleDock.classList.remove('hidden');
    el.dockEn.innerHTML = wordHtml(item.en, wordIndex);
    el.dockAr.innerHTML = item.ar || '';
    updateDockRepeatButtons();
  }

  function syncLoop() {
    if (state.playerType !== 'none' && state.subtitles.length) {
      const now = performance.now();
      const mediaTime = getMediaTime() - state.offset;

      if (state.isSeeking && now < state.seekGuardUntil) {
        state.syncTicker = requestAnimationFrame(syncLoop);
        return;
      }

      if (state.repeatStart >= 0 && state.repeatEnd >= 0 && now > state.repeatGuardUntil && !state.repeatWaiting) {
        const end = state.subtitles[state.repeatEnd]?.endTime ?? 0;
        if (mediaTime >= end) {
          beginRepeatDelay();
        }
      }

      let idx = state.activeIndex;
      const current = state.subtitles[idx];
      if (!current || mediaTime < current.startTime || mediaTime > current.endTime) idx = findIndexAt(mediaTime);

      if (idx >= 0) {
        const item = state.subtitles[idx];
        const wordIdx = updateWordProgress(item, mediaTime);
        if (idx !== state.activeIndex || wordIdx !== state.lastWordIndex) {
          state.activeIndex = idx; state.lastIndex = idx; state.lastWordIndex = wordIdx;
          updateDock(item, wordIdx);
          if (Math.abs(idx - state.listCenter) > 14) renderList(idx);
          highlightCard(idx);
        }
        if (state.autoPause && mediaTime >= item.endTime - 0.05 && state.repeatStart < 0) pauseMedia();
      } else if (state.lastIndex >= 0) {
        state.activeIndex = -1;
        updateDock(null);
      }
    }
    state.syncTicker = requestAnimationFrame(syncLoop);
  }

  function pauseMedia() { if (state.playerType === 'html5') el.movie.pause(); if (state.playerType === 'youtube' && state.yt?.pauseVideo) state.yt.pauseVideo(); }
  function playMedia() { if (state.playerType === 'html5') el.movie.play().catch(()=>{}); if (state.playerType === 'youtube' && state.yt?.playVideo) state.yt.playVideo(); }

  function beginRepeatDelay() {
    if (state.repeatWaiting || state.repeatStart < 0 || state.repeatEnd < 0 || !state.subtitles[state.repeatStart]) return;
    const gapMs = Math.min(5, Math.max(1, Number(state.repeatDelaySeconds || 1))) * 1000;
    state.repeatWaiting = true;
    state.repeatGuardUntil = performance.now() + gapMs + 900;
    pauseMedia();
    setStatus(`Repeat pause ${state.repeatDelaySeconds}s...`);
    clearTimeout(state.repeatTimer);
    state.repeatTimer = setTimeout(() => {
      state.repeatWaiting = false;
      if (state.repeatStart >= 0 && state.repeatEnd >= 0 && state.subtitles[state.repeatStart]) {
        seekMedia(state.subtitles[state.repeatStart].startTime, true);
        state.repeatGuardUntil = performance.now() + 900;
      }
    }, gapMs);
  }

  function renderList(center = state.listCenter) {
    state.listCenter = Math.max(0, Math.min(center, state.subtitles.length - 1));
    const start = Math.max(0, state.listCenter - state.renderRadius);
    const end = Math.min(state.subtitles.length, state.listCenter + state.renderRadius + 1);
    el.listInfo.textContent = state.subtitles.length
      ? `Showing ${start+1}-${end} of ${state.subtitles.length}`
        + (state.savedCount ? ` · 🌸 ${state.savedCount} saved` : '')
        + (state.highlightHF && state.hfCount ? ` · 🟣 ${state.hfCount} key` : '')
        + (state.highlightHF && state.advCount ? ` · 🟠 ${state.advCount} B1–C2` : '')
        + (state.highlightHF && state.redCount ? ` · 🟢 ${state.redCount} reductions` : '')
      : 'Upload SRT to start';
    const chunks = [];
    if (start > 0) chunks.push(`<button class="small-btn" data-render-center="${Math.max(0,start-state.renderRadius)}">Load previous</button>`);
    for (let i=start; i<end; i++) chunks.push(cardHtml(i, state.subtitles[i]));
    if (end < state.subtitles.length) chunks.push(`<button class="small-btn" data-render-center="${Math.min(state.subtitles.length-1,end+state.renderRadius)}">Load next</button>`);
    el.subtitleList.innerHTML = chunks.join('');
    highlightCard(state.lastIndex);
  }

  function repeatLabel(i) {
    if (state.repeatStart < 0 || state.repeatEnd < 0) return 'Repeat';
    if (i < state.repeatStart || i > state.repeatEnd) return i < state.repeatStart ? 'Extend ↑' : 'Extend ↓';
    if (state.repeatStart === state.repeatEnd) return 'Stop loop';
    if (i === state.repeatStart) return 'Loop start';
    if (i === state.repeatEnd) return 'Loop end';
    return 'In loop';
  }

  function cardHtml(i, item) {
    const active = i === state.lastIndex ? ' active' : '';
    const repeatOn = state.repeatStart >= 0 && i >= state.repeatStart && i <= state.repeatEnd;
    return `<article id="card-${i}" class="subtitle-card${active}" data-index="${i}">
      <div class="card-en">${wordHtml(item.en, i === state.lastIndex ? state.lastWordIndex : -1)}</div>
      <div id="ar-${i}" class="card-ar">${item.ar || ''}</div>
      <div class="card-actions">
        <button type="button" class="play-btn" data-play="${i}">العب <span class="time-chip">${item.time}</span></button>
        <button type="button" class="repeat-btn${repeatOn ? ' active' : ''}" data-repeat="${i}">${repeatLabel(i)}</button>
      </div>
      <div class="line-action-strip" aria-label="Line actions">
        <button type="button" class="action-icon copy" data-line-action="copy" data-index="${i}" aria-label="Copy line" title="Copy line">📋</button>
        <button type="button" class="action-icon translate" data-line-action="translate" data-index="${i}" aria-label="Translate line with Puter AI" title="Translate with Puter AI">🌐</button>
        <button type="button" class="action-icon save" data-line-action="save" data-index="${i}" aria-label="Save line" title="Save line">★</button>
        <button type="button" class="action-icon phrase" data-line-action="phrases" data-index="${i}" aria-label="Save phrase chunks" title="Save phrase chunks">🧩</button>
        <button type="button" class="action-icon template" data-line-action="template" data-index="${i}" aria-label="Save sentence template" title="Save sentence template">🧱</button>
        <button type="button" class="action-icon playphrase" data-line-action="playphrase" data-index="${i}" aria-label="Search in PlayPhrase" title="Search in PlayPhrase">▶</button>
      </div>
    </article>`;
  }

  function highlightCard(idx) {
    document.querySelectorAll('.subtitle-card.active').forEach(x => x.classList.remove('active'));
    if (idx >= 0) $('card-' + idx)?.classList.add('active');
  }

  function jumpToCard(idx) {
    if (idx < 0) return;
    renderList(idx);
    setTimeout(() => $('card-' + idx)?.scrollIntoView({behavior:'smooth', block:'center'}), 40);
  }

  function currentSubtitleIndex() {
    return state.lastIndex >= 0 ? state.lastIndex : (state.activeIndex >= 0 ? state.activeIndex : -1);
  }

  function updateDockRepeatButtons() {
    const one = $('loopCurrentBtn'), start = $('loopStartBtn'), end = $('loopEndBtn'), off = $('loopOffBtn');
    if (!one || !start || !end || !off) return;
    const i = currentSubtitleIndex();
    const inLoop = state.repeatStart >= 0 && state.repeatEnd >= 0 && i >= state.repeatStart && i <= state.repeatEnd;
    one.classList.toggle('active', state.repeatStart === i && state.repeatEnd === i);
    start.classList.toggle('active', state.repeatStart === i);
    end.classList.toggle('active', state.repeatEnd === i && state.repeatStart !== state.repeatEnd);
    off.classList.toggle('active', state.repeatStart >= 0);
    one.textContent = inLoop ? '⟲ Looping' : '⟲ One';
  }

  function setRepeatRange(start, end, playFromStart = true) {
    if (!state.subtitles.length) return;
    start = Math.max(0, Math.min(Number(start), state.subtitles.length - 1));
    end = Math.max(0, Math.min(Number(end), state.subtitles.length - 1));
    state.repeatStart = Math.min(start, end);
    state.repeatEnd = Math.max(start, end);
    state.repeatWaiting = false;
    clearTimeout(state.repeatTimer);
    state.repeatGuardUntil = performance.now() + 300;
    renderList(currentSubtitleIndex() >= 0 ? currentSubtitleIndex() : state.repeatStart);
    updateDockRepeatButtons();
    if (playFromStart) seekMedia(state.subtitles[state.repeatStart].startTime, true);
    toast(state.repeatStart === state.repeatEnd ? 'Repeating current subtitle' : `Looping ${state.repeatEnd - state.repeatStart + 1} subtitles`);
    debounceSave();
  }

  function repeatCurrentSubtitle() {
    const i = currentSubtitleIndex();
    if (i < 0) return toast('No active subtitle yet');
    setRepeatRange(i, i, true);
    jumpToCard(i);
  }

  function setLoopStartFromCurrent() {
    const i = currentSubtitleIndex();
    if (i < 0) return toast('No active subtitle yet');
    if (state.repeatEnd >= 0) setRepeatRange(i, state.repeatEnd, true);
    else setRepeatRange(i, i, true);
    toast('Loop start set. Go to another subtitle and tap B End.');
    jumpToCard(i);
  }

  function setLoopEndFromCurrent() {
    const i = currentSubtitleIndex();
    if (i < 0) return toast('No active subtitle yet');
    const start = state.repeatStart >= 0 ? state.repeatStart : i;
    setRepeatRange(start, i, true);
    jumpToCard(i);
  }

  function stopRepeat() {
    state.repeatStart = -1;
    state.repeatEnd = -1;
    state.repeatWaiting = false;
    clearTimeout(state.repeatTimer);
    updateDockRepeatButtons();
    renderList(currentSubtitleIndex() >= 0 ? currentSubtitleIndex() : state.listCenter);
    toast('Repeat off');
    debounceSave();
  }

  function hideLineActionMenus() {
    document.querySelectorAll('.line-action-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.menu-trigger.active').forEach(b => b.classList.remove('active'));
  }

  function toggleLineActionMenu(index, btn) {
    const menu = document.querySelector(`[data-action-menu-for="${index}"]`);
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    hideLineActionMenus();
    if (willOpen) {
      menu.classList.remove('hidden');
      btn?.classList.add('active');
      requestAnimationFrame(() => menu.scrollIntoView({behavior:'smooth', block:'nearest'}));
    }
  }

  async function translateMyMemory(text) {
    text = String(text || '').trim();
    if (!text) return '';
    try {
      const res = await fetch('/api/mymemory-translate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text, source:'en', target:'ar' }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      return data.translatedText || '';
    } catch (proxyError) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent('en|ar')}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.responseDetails || proxyError?.message || 'MyMemory translation failed');
      return data?.responseData?.translatedText || '';
    }
  }

  async function translateMyMemoryItems(items) {
    try {
      const res = await fetch('/api/mymemory-translate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ items, source:'en', target:'ar' }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      return data.translated || [];
    } catch (proxyError) {
      const translated = [];
      for (const raw of items || []) {
        const text = String(raw?.text || '').trim();
        if (!text) continue;
        let ar = '';
        try { ar = await translateMyMemory(text); } catch {}
        translated.push({ index: raw?.index, text, ar });
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return translated;
    }
  }

  const LARA_SETTINGS_CLOUD_WORD = '__lara_settings__';
  const LARA_PAUSE_UNTIL_KEY = 'jm_lara_pause_until';
  const LARA_LAST_ERROR_KEY = 'jm_lara_last_error';

  function laraPauseRemainingMs() {
    const until = Number(localStorage.getItem(LARA_PAUSE_UNTIL_KEY) || 0);
    return Math.max(0, until - Date.now());
  }

  function isLaraTemporarilyPaused() {
    return laraPauseRemainingMs() > 0;
  }

  function pauseLaraAfterQuota(minutes = 30, message = '') {
    const until = Date.now() + (Number(minutes) || 30) * 60 * 1000;
    localStorage.setItem(LARA_PAUSE_UNTIL_KEY, String(until));
    if (message) localStorage.setItem(LARA_LAST_ERROR_KEY, String(message).slice(0, 600));
  }

  function clearLaraPause() {
    localStorage.removeItem(LARA_PAUSE_UNTIL_KEY);
    localStorage.removeItem(LARA_LAST_ERROR_KEY);
  }

  function isLaraQuotaLikeMessage(msg) {
    return /api_translation_chars|quota|exceeded|limit/i.test(String(msg || ''));
  }

  function laraPauseText() {
    const ms = laraPauseRemainingMs();
    if (!ms) return '';
    const mins = Math.ceil(ms / 60000);
    return `Lara is paused for about ${mins} min after a quota response. MyMemory fallback is active.`;
  }

  function getLaraConfig() {
    return {
      accessKeyId: String(localStorage.getItem('jm_lara_access_key_id') || '').trim(),
      accessKeySecret: String(localStorage.getItem('jm_lara_access_key_secret') || '').trim()
    };
  }

  function saveLaraConfigToLocal() {
    const accessKeyId = String($('laraKeyIdInput')?.value || '').trim();
    const accessKeySecret = String($('laraSecretInput')?.value || '').trim();
    if (accessKeyId) localStorage.setItem('jm_lara_access_key_id', accessKeyId); else localStorage.removeItem('jm_lara_access_key_id');
    if (accessKeySecret) localStorage.setItem('jm_lara_access_key_secret', accessKeySecret); else localStorage.removeItem('jm_lara_access_key_secret');
    return { accessKeyId, accessKeySecret };
  }

  function isLaraSettingsCloudItem(item) {
    const key = String(item?.key || '').toLowerCase();
    const word = String(item?.word || '').toLowerCase();
    return key === 'setting:lara' || word === LARA_SETTINGS_CLOUD_WORD;
  }

  function makeLaraSettingsCloudItem() {
    const cfg = getLaraConfig();
    if (!cfg.accessKeyId || !cfg.accessKeySecret) return null;
    const now = new Date().toISOString();
    return {
      kind: 'setting',
      hidden: true,
      key: 'setting:lara',
      word: LARA_SETTINGS_CLOUD_WORD,
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      savedAt: now,
      updatedAt: now
    };
  }

  function applyLaraSettingsFromCloud(remoteWords = []) {
    const item = (remoteWords || []).find(isLaraSettingsCloudItem);
    if (!item) return false;
    const accessKeyId = String(item.accessKeyId || '').trim();
    const accessKeySecret = String(item.accessKeySecret || '').trim();
    if (!accessKeyId || !accessKeySecret) return false;
    localStorage.setItem('jm_lara_access_key_id', accessKeyId);
    localStorage.setItem('jm_lara_access_key_secret', accessKeySecret);
    return true;
  }


  const CHAT_LLM_SETTINGS_CLOUD_WORD = '__chats_llm_settings__';

  function getChatLlmConfig() {
    return getOpenRouterConfig();
  }

  function saveChatLlmConfigToLocal() {
    return saveOpenRouterConfigToLocal();
  }

  function isChatLlmSettingsCloudItem(item) {
    const key = String(item?.key || '').toLowerCase();
    const word = String(item?.word || '').toLowerCase();
    return key === 'setting:chats-llm' || word === CHAT_LLM_SETTINGS_CLOUD_WORD;
  }

  function isHiddenCloudSettingsItem(item) {
    return isLaraSettingsCloudItem(item) || isChatLlmSettingsCloudItem(item) || isOpenRouterSettingsCloudItem(item);
  }

  function makeChatLlmSettingsCloudItem() {
    const cfg = getChatLlmConfig();
    if (!cfg.apiKey && !cfg.model) return null;
    const now = new Date().toISOString();
    return {
      kind: 'setting',
      hidden: true,
      key: 'setting:chats-llm',
      word: CHAT_LLM_SETTINGS_CLOUD_WORD,
      apiKey: cfg.apiKey,
      model: cfg.model,
      savedAt: now,
      updatedAt: now
    };
  }

  function applyChatLlmSettingsFromCloud(remoteWords = []) {
    const item = (remoteWords || []).find(isChatLlmSettingsCloudItem);
    if (!item) return false;
    const apiKey = String(item.apiKey || '').trim();
    const model = chatLlmFreeAlias(String(item.model || '').trim());
    if (apiKey) localStorage.setItem('jm_chats_llm_api_key', apiKey);
    if (model) localStorage.setItem('jm_chats_llm_model', model);
    return Boolean(apiKey || model);
  }

  async function saveChatLlmSettingsToCloud({ silent = false } = {}) {
    const cfg = getChatLlmConfig();
    if (!cfg.apiKey) {
      if (!silent) toast('Enter OpenRouter key first');
      return false;
    }
    return await syncSavedItemsToCloud({ silent, reason: 'chats-llm-settings' });
  }

  function openChatLlmSettings(message = '') {
    openMenu(false);
    const cfg = getOpenRouterConfig();
    if ($('chatLlmKeyInput')) $('chatLlmKeyInput').value = cfg.apiKey;
    if ($('chatLlmModelInput')) $('chatLlmModelInput').value = cfg.model || 'openrouter/free';
    if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = message || 'OpenRouter AI is active when you save a key. Free models only. It will translate subtitle lines and generate template examples first, then Puter AI/MyMemory fallbacks are used if OpenRouter fails.';
    openModal('aiTemplateModal');
  }

  function chatLlmErrorMessage(status, data) {
    if (status === 404) return 'AI examples API proxy is missing. Upload the full Vercel project folder, not the HTML file only.';
    if (status === 401 || status === 403) return 'Chats-LLM rejected the API key. Check the key or Vercel environment variable.';
    if (status === 402) return 'Chats-LLM says the selected model is not free or has no available credits. The app now auto-selects free models only; clear the model field and test again.';
    if (status === 429) return 'Chats-LLM rate limit exceeded on the free model. Try again later or leave model empty so the app can choose another free model.';
    return data?.error || data?.details || `Chats-LLM failed (${status})`;
  }

  function savedWordsForCloud() {
    const visibleWords = state.savedWords
      .filter(x => !isHiddenCloudSettingsItem(x))
      .map(normalizeSavedWord)
      .filter(x => x.word && !isHiddenCloudSettingsItem(x));
    const hiddenSettings = [makeLaraSettingsCloudItem(), makeChatLlmSettingsCloudItem(), makeOpenRouterSettingsCloudItem()].filter(Boolean);
    return [...visibleWords, ...hiddenSettings];
  }

  async function saveLaraSettingsToCloud({ silent = false } = {}) {
    const cfg = getLaraConfig();
    if (!cfg.accessKeyId || !cfg.accessKeySecret) {
      if (!silent) toast('Enter Lara keys first');
      return false;
    }
    return await syncSavedItemsToCloud({ silent, reason: 'lara-settings' });
  }

  function laraApiErrorMessage(status, data) {
    if (status === 404) return 'Lara API proxy is missing. Upload the full Vercel project folder, not the HTML file only.';
    const source = data?.credentialSource ? ` Source: ${data.credentialSource}.` : '';
    if (status === 401 || status === 403) return `Lara rejected the credentials.${source} Check Access Key ID and Secret.`;
    const raw = data?.error || data?.details || data?.message || '';
    if (isLaraQuotaLikeMessage(raw)) {
      return `Lara API returned a quota/limit response for the credentials being used.${source} The app will use MyMemory fallback. If your dashboard still shows characters available, the API credentials may belong to a different Lara API plan/account, or Vercel may still have old environment variables.`;
    }
    return (raw ? `${raw}${source}` : `Lara failed (${status})${source}`);
  }

  function getLaraPayload(extra = {}) {
    const cfg = getLaraConfig();
    const payload = {
      source: 'en',
      target: 'ar',
      style: 'fluid',
      instructions: [
        'Translate movie and series subtitle dialogue into natural Arabic.',
        'Keep the translation concise and suitable for subtitles.',
        'Preserve names, jokes, emotion, slang, tone, and implied meaning.',
        'Do not add explanations, notes, or quotation marks.'
      ],
      ...extra
    };
    if (cfg.accessKeyId && cfg.accessKeySecret) payload.credentials = cfg;
    return payload;
  }

  function openLaraSettings(message = '') {
    openMenu(false);
    const cfg = getLaraConfig();
    if ($('laraKeyIdInput')) $('laraKeyIdInput').value = cfg.accessKeyId;
    if ($('laraSecretInput')) $('laraSecretInput').value = cfg.accessKeySecret;
    if ($('laraSettingsStatus')) {
      const pause = laraPauseText();
      const last = localStorage.getItem(LARA_LAST_ERROR_KEY) || '';
      $('laraSettingsStatus').textContent = message || pause || (last ? `Last Lara issue: ${last}` : 'Add credentials here, or use Vercel environment variables.');
    }
    openModal('laraModal');
  }

  async function requestLaraApi(extra = {}) {
    const res = await fetch('/api/lara-translate', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(getLaraPayload(extra))
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function translateLaraPure(text) {
    const { res, data } = await requestLaraApi({ text });
    if (!res.ok) throw new Error(laraApiErrorMessage(res.status, data));
    return { text: data.translatedText || '', credentialSource: data.credentialSource || '' };
  }

  async function translateLara(text) {
    if (isLaraTemporarilyPaused()) {
      setStatus(laraPauseText());
      try { return await translateMyMemory(text); } catch {}
    }
    const { res, data } = await requestLaraApi({ text });
    if (!res.ok) {
      const msg = laraApiErrorMessage(res.status, data);
      if (isLaraQuotaLikeMessage(msg)) {
        console.warn('Lara quota/plan issue. Falling back to MyMemory:', data);
        pauseLaraAfterQuota(30, msg);
        setStatus('Lara returned a quota response. MyMemory fallback is active for now.');
        try { return await translateMyMemory(text); } catch {}
      }
      throw new Error(msg);
    }
    return data.translatedText || '';
  }

  async function translateLaraItems(items) {
    if (isLaraTemporarilyPaused()) {
      setStatus(laraPauseText());
      try { return await translateMyMemoryItems(items); } catch {}
    }
    const { res, data } = await requestLaraApi({ items });
    if (!res.ok) {
      const msg = laraApiErrorMessage(res.status, data);
      if (isLaraQuotaLikeMessage(msg)) {
        console.warn('Lara quota/plan issue. Falling back to MyMemory batch:', data);
        pauseLaraAfterQuota(30, msg);
        setStatus('Lara returned a quota response. MyMemory fallback is active for subtitle translation.');
        try { return await translateMyMemoryItems(items); } catch {}
      }
      throw new Error(msg);
    }
    return data.translated || [];
  }

  async function translateLine(idx) {
    const item = state.subtitles[idx]; if (!item) return;
    setStatus('Translating line with OpenRouter/Puter...');
    try {
      item.ar = await translateSubtitlePreferred(cleanLine(item.en));
      $('ar-' + idx) && ($('ar-' + idx).innerHTML = escapeHtml(item.ar));
      if (idx === state.lastIndex) updateDock(item, state.lastWordIndex);
      debounceSave(); scheduleCloudLibrarySync(); toast('Puter AI translation done');
    } catch (e) {
      console.warn(e);
      toast('Translation failed');
      setStatus(e.message || 'Puter AI subtitle translation failed.');
    }
  }

  async function translateAllPuter() {
    const jobs = state.subtitles.map((it, index) => ({ index, text: cleanLine(it.en) })).filter(x => x.text && !state.subtitles[x.index].ar);
    if (!jobs.length) return toast('Nothing to translate');
    openMenu(false); setStatus(`Puter AI translating ${jobs.length} lines naturally...`);
    const chunkSize = 8;
    let done = 0;
    for (let i=0; i<jobs.length; i+=chunkSize) {
      const items = jobs.slice(i, i+chunkSize);
      try {
        const rows = await translateSubtitlePreferredItems(items);
        const rowMap = new Map((rows || []).map(row => [Number(row.index), row.ar || '']));
        for (const item of items) {
          const ar = rowMap.get(Number(item.index));
          if (state.subtitles[item.index] && ar) {
            state.subtitles[item.index].ar = ar;
            done++;
          }
        }
        setStatus(`Puter AI translated ${done}/${jobs.length}`);
        renderList(state.listCenter); debounceSave(); scheduleCloudLibrarySync();
      } catch (e) {
        console.warn(e);
        setStatus('Batch failed. Translating remaining lines one by one...');
        for (const item of items) {
          try {
            const ar = await translateSubtitlePreferred(item.text);
            if (state.subtitles[item.index] && ar) {
              state.subtitles[item.index].ar = ar;
              done++;
            }
          } catch (inner) { console.warn(inner); }
          await new Promise(r => setTimeout(r, 250));
        }
        renderList(state.listCenter); debounceSave(); scheduleCloudLibrarySync();
      }
      await new Promise(r => setTimeout(r, 900));
    }
    saveState(); setStatus('Puter AI subtitle translation finished'); toast('Puter AI translation finished');
  }

  // Backward-compatible name used by existing menu wiring.
  async function translateAllLara() { return translateAllPuter(); }

  async function translateAllAzure() {
    const jobs = state.subtitles.map((it, index) => ({ index, text: cleanLine(it.en) })).filter(x => x.text && !state.subtitles[x.index].ar);
    if (!jobs.length) return toast('Nothing to translate');
    openMenu(false); setStatus(`Azure translating ${jobs.length} lines...`);
    const chunkSize = 45;
    let done = 0;
    for (let i=0; i<jobs.length; i+=chunkSize) {
      const items = jobs.slice(i, i+chunkSize);
      let tries = 0;
      while (tries < 3) {
        try {
          const res = await fetch('/api/azure-translate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ items }) });
          if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); tries++; continue; }
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          for (const row of data.translated || []) { if (state.subtitles[row.index]) state.subtitles[row.index].ar = row.ar || ''; done++; }
          setStatus(`Azure translated ${done}/${jobs.length}`); renderList(state.listCenter); debounceSave(); break;
        } catch (e) { tries++; if (tries >= 3) { toast('Azure stopped on one batch'); break; } await new Promise(r => setTimeout(r, 2500)); }
      }
      await new Promise(r => setTimeout(r, 900));
    }
    saveState(); setStatus('Azure translation finished'); toast('Translation finished');
  }

  // ════════════════════════════════════════════════════════════════
  // NATURAL TTS via Puter (AWS Polly under the hood, neural engine)
  //
  // Every existing call site — dock 🔊, dict, examples, smart cards, dialogue
  // play-all, reductions, speaking coach — goes through speak()/speakText(),
  // which both delegate to speakNatural() here. So flipping this on instantly
  // upgrades the whole app to human-quality voices.
  //
  // Falls back to the browser SpeechSynthesis API silently if Puter TTS isn't
  // available (offline, blocked, or the user disabled it). A small in-memory
  // LRU cache keys returned <audio> elements by (voice, engine, text) so
  // repeats are instant and don't burn network.
  // ════════════════════════════════════════════════════════════════

  // Voice catalogue is split by ENGINE because Puter (AWS Polly) and Inworld
  // expose different voice names. The picker iterates only voices belonging to
  // the currently selected engine — switching engine snaps to the engine's first
  // voice automatically.
  const TTS_VOICE_OPTIONS = [
    // Inworld (premium-natural, server proxy)
    { id: 'Clive',   label: '🎙️ Clive (M, UK)',   lang: 'en-GB', engine: 'inworld' },
    { id: 'Ashley',  label: '🎙️ Ashley (F, US)',  lang: 'en-US', engine: 'inworld' },
    { id: 'Edward',  label: '🎙️ Edward (M, US)',  lang: 'en-US', engine: 'inworld' },
    { id: 'Olivia',  label: '🎙️ Olivia (F, UK)',  lang: 'en-GB', engine: 'inworld' },
    // ElevenLabs (premium-natural, server proxy). voiceId values are official.
    { id: '21m00Tcm4TlvDq8ikWAM', label: '🎤 Rachel (F, US)',  lang: 'en-US', engine: 'eleven' },
    { id: 'pNInz6obpgDQGcFmaJgB', label: '🎤 Adam (M, US)',    lang: 'en-US', engine: 'eleven' },
    { id: 'EXAVITQu4vr4xnSDxMaL', label: '🎤 Bella (F, US)',   lang: 'en-US', engine: 'eleven' },
    { id: 'ErXwobaYiN019PkySvjV', label: '🎤 Antoni (M, US)',  lang: 'en-US', engine: 'eleven' },
    { id: 'AZnzlk1XvdvUeBnXmlld', label: '🎤 Domi (F, US)',    lang: 'en-US', engine: 'eleven' },
    // Groq PlayAI TTS (fast, free tier, server proxy)
    { id: 'Fritz-PlayAI',    label: '⚡ Fritz (M)',   lang: 'en-US', engine: 'groq' },
    { id: 'Quinn-PlayAI',    label: '⚡ Quinn (F)',   lang: 'en-US', engine: 'groq' },
    { id: 'Mason-PlayAI',    label: '⚡ Mason (M)',   lang: 'en-US', engine: 'groq' },
    { id: 'Aaliyah-PlayAI',  label: '⚡ Aaliyah (F)', lang: 'en-US', engine: 'groq' },
    { id: 'Atlas-PlayAI',    label: '⚡ Atlas (M)',   lang: 'en-US', engine: 'groq' },
    // Puter (Polly neural, free in-browser SDK)
    { id: 'Joanna',  label: '🇺🇸 Joanna (F)',     lang: 'en-US', engine: 'puter' },
    { id: 'Matthew', label: '🇺🇸 Matthew (M)',    lang: 'en-US', engine: 'puter' },
    { id: 'Salli',   label: '🇺🇸 Salli (F)',      lang: 'en-US', engine: 'puter' },
    { id: 'Joey',    label: '🇺🇸 Joey (M)',       lang: 'en-US', engine: 'puter' },
    { id: 'Amy',     label: '🇬🇧 Amy (F)',        lang: 'en-GB', engine: 'puter' },
    { id: 'Brian',   label: '🇬🇧 Brian (M)',      lang: 'en-GB', engine: 'puter' }
  ];
  // Engines available for the user to pick. Order also defines the fallback
  // cascade when the chosen engine fails: inworld → eleven → groq → puter → browser.
  const TTS_PROVIDERS = ['inworld', 'eleven', 'groq', 'puter', 'browser'];
  const TTS_INWORLD_DELIVERY = 'BALANCED';
  const TTS_INWORLD_MODEL = 'inworld-tts-2';
  const TTS_CACHE = new Map();   // key → HTMLAudioElement
  const TTS_CACHE_LIMIT = 60;
  let currentTtsAudio = null;

  function getTtsSettings() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem('jm_tts_settings') || '{}'); } catch { raw = {}; }
    const provider = TTS_PROVIDERS.includes(raw.provider)
      ? raw.provider
      : (raw.usePuter === false ? 'browser' : 'inworld');   // default Inworld, honour legacy usePuter
    // Pick a voice that belongs to the chosen provider; fall back to the first one.
    const enginePool = TTS_VOICE_OPTIONS.filter(v => v.engine === provider);
    const wantedVoice = raw.voice && enginePool.some(v => v.id === raw.voice)
      ? raw.voice
      : (enginePool[0]?.id || 'Clive');
    return {
      provider,
      voice: wantedVoice,
      rate: Number(raw.rate || 1)
    };
  }
  function setTtsSettings(patch) {
    const next = { ...getTtsSettings(), ...patch };
    localStorage.setItem('jm_tts_settings', JSON.stringify(next));
    return next;
  }

  function cancelTts() {
    try { if (currentTtsAudio) { currentTtsAudio.pause(); currentTtsAudio.currentTime = 0; } } catch {}
    try { window.speechSynthesis?.cancel(); } catch {}
    currentTtsAudio = null;
  }

  function speakBrowserFallback(text, opts = {}) {
    if (!text || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = opts.lang || 'en-US'; u.rate = opts.rate || 0.95; u.pitch = opts.pitch || 1;
      const voices = window.speechSynthesis.getVoices();
      // For per-speaker variation on the browser engine we shift pitch slightly
      // so A and B sound different even with only one OS voice.
      const v = voices.find(x => x.lang === u.lang) || voices.find(x => /^en/i.test(x.lang));
      if (v) u.voice = v;
      if (opts.onended) u.onend = opts.onended;
      window.speechSynthesis.speak(u);
    } catch (e) { console.warn('Browser TTS failed:', e); }
  }

  // Pick a contrasting voice from the same engine — opposite gender when the
  // labels declare one — so two speakers in a dialogue sound different.
  function pickContrastingVoice(engine, currentVoiceId) {
    const pool = TTS_VOICE_OPTIONS.filter(v => v.engine === engine && v.id !== currentVoiceId);
    if (!pool.length) return null;
    const cur = TTS_VOICE_OPTIONS.find(v => v.id === currentVoiceId);
    const isF = cur && /\(F[,\s)]/.test(cur.label);
    const isM = cur && /\(M[,\s)]/.test(cur.label);
    if (isF) { const m = pool.find(v => /\(M[,\s)]/.test(v.label)); if (m) return m; }
    if (isM) { const f = pool.find(v => /\(F[,\s)]/.test(v.label)); if (f) return f; }
    return pool[0];
  }

  // Fetch + base64-MP3 → <audio> for Inworld (via our /api/inworld-tts proxy).
  async function ttsViaInworld(text, voice) {
    const res = await fetch('/api/inworld-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: voice.id,
        model: TTS_INWORLD_MODEL,
        speakingRate: 1,
        deliveryMode: TTS_INWORLD_DELIVERY,
        language: voice.lang || 'AUTO'
      })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`Inworld ${res.status}: ${data.error || res.statusText}`);
    }
    const data = await res.json();
    if (!data.audioContent) throw new Error('Inworld returned no audio');
    const audio = new Audio(`data:audio/mp3;base64,${data.audioContent}`);
    // Preload so .play() starts immediately on user gesture.
    audio.preload = 'auto';
    return audio;
  }

  async function ttsViaPuter(text, voice) {
    if (!window.puter?.ai?.txt2speech) throw new Error('Puter TTS unavailable');
    const audio = await window.puter.ai.txt2speech(text, {
      language: voice.lang,
      voice: voice.id,
      engine: 'neural'
    });
    if (!audio) throw new Error('Puter TTS returned no audio');
    return audio;
  }

  // Shared helper for server-proxy engines that return { audioContent, mimeType }.
  async function ttsViaProxy(endpoint, payload, label) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`${label} ${res.status}: ${data.error || res.statusText}`);
    }
    const data = await res.json();
    if (!data.audioContent) throw new Error(`${label} returned no audio`);
    const mime = data.mimeType || 'audio/mpeg';
    const audio = new Audio(`data:${mime};base64,${data.audioContent}`);
    audio.preload = 'auto';
    return audio;
  }

  async function ttsViaEleven(text, voice) {
    return ttsViaProxy('/api/eleven-tts', { text, voice: voice.id }, 'ElevenLabs');
  }

  async function ttsViaGroq(text, voice) {
    return ttsViaProxy('/api/groq-tts', { text, voice: voice.id }, 'Groq');
  }

  // Map provider name → fetcher. Each must return an HTMLAudioElement.
  const TTS_FETCHERS = {
    inworld: (t, v) => ttsViaInworld(t, v),
    eleven:  (t, v) => ttsViaEleven(t, v),
    groq:    (t, v) => ttsViaGroq(t, v),
    puter:   (t, v) => ttsViaPuter(t, v)
  };

  // Pick a sensible voice for a given engine, preferring the user's last choice.
  function defaultVoiceFor(engine, preferredId) {
    if (preferredId) {
      const m = TTS_VOICE_OPTIONS.find(v => v.id === preferredId && v.engine === engine);
      if (m) return m;
    }
    return TTS_VOICE_OPTIONS.find(v => v.engine === engine);
  }

  async function playFromAudio(audio, rate, onended) {
    audio.playbackRate = rate || 1;
    currentTtsAudio = audio;
    audio.onended = () => { if (currentTtsAudio === audio) currentTtsAudio = null; if (onended) onended(); };
    audio.onerror = () => { if (currentTtsAudio === audio) currentTtsAudio = null; if (onended) onended(); };
    await audio.play();
  }

  // Try one engine; on success return true, on failure throw to caller.
  // `cfg` may carry { rate, onended, pitch }. `preferredId` is the voice ID
  // the caller asked for (overrides global settings, e.g. per-speaker dialogue).
  async function attemptEngine(engine, text, preferredId, cfg) {
    if (engine === 'browser') {
      speakBrowserFallback(text, { onended: cfg.onended, rate: cfg.rate, pitch: cfg.pitch });
      return true;
    }
    if (engine === 'puter' && !window.puter?.ai?.txt2speech) throw new Error('Puter SDK not loaded');
    const voice = defaultVoiceFor(engine, preferredId);
    if (!voice) throw new Error(`No voice configured for ${engine}`);
    const key = `${engine}::${voice.id}::${text}`;
    let audio = TTS_CACHE.get(key);
    if (!audio) {
      audio = await TTS_FETCHERS[engine](text, voice);
      TTS_CACHE.set(key, audio);
      if (TTS_CACHE.size > TTS_CACHE_LIMIT) {
        const oldest = TTS_CACHE.keys().next().value;
        TTS_CACHE.delete(oldest);
      }
    } else {
      try { audio.currentTime = 0; } catch {}
    }
    await playFromAudio(audio, cfg.rate, cfg.onended);
    return true;
  }

  // opts:
  //   voice    — override voice ID (must belong to a supported engine; we
  //              detect the engine from the voice and try it FIRST in the
  //              cascade, falling back to user's chosen engine etc.)
  //   rate     — playback rate (1 = normal). Lets Dialogue Practice slow down.
  //   pitch    — browser fallback only (used to differentiate A/B if forced).
  //   onended  — called after audio finishes (for chaining playback).
  async function speakNatural(text, opts = {}) {
    text = String(text || '').trim();
    if (!text) return;
    const cfg = getTtsSettings();
    cancelTts();
    const safeText = text.length > 2500 ? text.slice(0, 2500) : text;
    const rate = Number.isFinite(Number(opts.rate)) ? Number(opts.rate) : cfg.rate;

    // If the caller asked for a specific voice, find its engine and try that
    // first. The chosen engine still leads the cascade for unrecognised voices.
    const overrideVoice = opts.voice
      ? TTS_VOICE_OPTIONS.find(v => v.id === opts.voice)
      : null;
    const lead = overrideVoice ? overrideVoice.engine : cfg.provider;
    const leadVoiceId = overrideVoice ? overrideVoice.id : cfg.voice;
    const cascade = [lead, ...TTS_PROVIDERS.filter(p => p !== lead)];

    for (const engine of cascade) {
      try {
        // Use the override voice only when we're still on its engine; once we
        // fall back to a different engine we let it pick its own first voice.
        const voiceForThis = engine === lead ? leadVoiceId : cfg.voice;
        await attemptEngine(engine, safeText, voiceForThis, { rate, onended: opts.onended, pitch: opts.pitch });
        return;
      } catch (e) {
        console.warn(`TTS engine "${engine}" failed, trying next:`, e?.message || e);
      }
    }
    console.error('All TTS engines failed for:', safeText);
  }

  // Legacy entry points — every old call site routes through here, so flipping
  // to natural voices is automatic. opts can pass { onended } for sequencing.
  function speak(text, opts) { speakNatural(text, opts); }
  function saveWord(word, ar='', extra = {}) {
    word = String(word || '').trim();
    if (!word) return;
    const key = word.toLowerCase();
    const normalizedPayload = normalizeSavedWord({ word, ar, savedAt: new Date().toISOString(), ...extra });
    const existing = state.savedWords.find(x => String(x.word || '').toLowerCase() === key);
    if (existing) {
      existing.ar = existing.ar || normalizedPayload.ar || '';
      existing.kind = normalizedPayload.kind;
      existing.contextEn = existing.contextEn || normalizedPayload.contextEn || '';
      existing.contextAr = existing.contextAr || normalizedPayload.contextAr || '';
      if ((!existing.examples || !existing.examples.length) && normalizedPayload.examples?.length) existing.examples = normalizedPayload.examples;
      existing.sourceLineKey = existing.sourceLineKey || normalizedPayload.sourceLineKey || '';
      existing.startTime = existing.startTime || normalizedPayload.startTime || 0;
      Object.assign(existing, normalizeSavedWord(existing));
      toast(normalizedPayload.kind === 'template' ? 'Template already saved' : (normalizedPayload.kind === 'phrase' ? 'Phrase already saved' : 'Word already saved'));
    } else {
      state.savedWords.unshift(normalizedPayload);
      toast(normalizedPayload.kind === 'template' ? 'Template saved' : (normalizedPayload.kind === 'phrase' ? 'Phrase saved' : 'Word saved'));
    }
    writeJSON('jm_saved_words', state.savedWords.map(normalizeSavedWord));
    rebuildSavedWordSet();
    if (state.subtitles?.length) { recomputeHfCount(); renderList(state.listCenter); updateDock(null); }
    debounceSave();
    scheduleCloudLibrarySync();
  }

  async function savePhraseFromSubtitle(phrase, idx = state.lastIndex) {
    phrase = String(phrase || '').trim().toLowerCase();
    const item = state.subtitles[idx];
    if (!phrase || !item) return;
    setStatus(`Saving phrase: ${phrase}`);
    const contextEn = cleanLine(item.en);
    const contextAr = item.ar || '';
    const ar = await translatePhraseInContext(phrase, contextEn);
    saveWord(phrase, ar, { kind: 'phrase', contextEn, contextAr, sourceLineKey: lineKey(item), startTime: item.startTime || 0, sourceTitle: state.lessonTitle || '' });
    setStatus('Phrase saved for smart review');
  }

  async function saveDetectedPhrasesFromLine(idx) {
    const item = state.subtitles[idx];
    if (!item) return;
    const phrases = detectPhrasesInLine(item.en);
    if (!phrases.length) return toast('No phrase chunks found in this line');
    let saved = 0;
    for (const p of phrases.slice(0, 6)) {
      await savePhraseFromSubtitle(p.phrase, idx);
      saved++;
    }
    toast(`${saved} phrase${saved === 1 ? '' : 's'} saved`);
  }

  async function saveTemplateFromSubtitle(idx = state.lastIndex) {
    const item = state.subtitles[idx];
    if (!item) return;
    setStatus('Extracting sentence template...');
    const template = await extractTemplateFromLineAsync(item.en);
    if (!template || !template.pattern) return toast('No useful template found. Try a longer line or use Extract templates on the full SRT.');
    setStatus('Saving sentence template...');
    const contextEn = cleanLine(item.en);
    const contextAr = item.ar || '';
    const ar = await translateTemplateMeaning(template, contextEn);
    const naturalTemplate = await ensureNaturalTemplateExamples(template, contextEn);
    saveWord(naturalTemplate.pattern, ar || naturalTemplate.usageAr || '', {
      kind: 'template',
      contextEn,
      contextAr,
      sourceLineKey: lineKey(item),
      sourceTitle: state.lessonTitle || '',
      startTime: item.startTime || 0,
      templateSlot: naturalTemplate.slot || '',
      templateUsageEn: naturalTemplate.usageEn || '',
      templateUsageAr: naturalTemplate.usageAr || '',
      templateRule: naturalTemplate.rule || naturalTemplate.name || '',
      examples: naturalTemplate.examples || []
    });
    setStatus('Template saved for smart review');
  }

  async function saveTemplatesFromAllSubtitles() {
    if (!state.subtitles.length) return toast('Upload subtitles first');
    openMenu(false);
    let saved = 0;
    const seen = new Set(state.savedWords.filter(x => x.kind === 'template').map(x => String(x.word || '').toLowerCase()));
    for (let i = 0; i < state.subtitles.length; i++) {
      const template = await extractTemplateFromLineAsync(state.subtitles[i].en);
      if (!template?.pattern) continue;
      const key = template.pattern.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const item = state.subtitles[i];
      const ar = await translateTemplateMeaning(template, cleanLine(item.en));
      const naturalTemplate = await ensureNaturalTemplateExamples(template, cleanLine(item.en));
      state.savedWords.unshift(normalizeSavedWord({
        kind: 'template',
        word: naturalTemplate.pattern,
        ar: ar || naturalTemplate.usageAr || '',
        contextEn: cleanLine(item.en),
        contextAr: item.ar || '',
        sourceLineKey: lineKey(item),
        sourceTitle: state.lessonTitle || '',
        startTime: item.startTime || 0,
        templateSlot: naturalTemplate.slot || '',
        templateUsageEn: naturalTemplate.usageEn || '',
        templateUsageAr: naturalTemplate.usageAr || '',
        templateRule: naturalTemplate.rule || naturalTemplate.name || '',
        examples: naturalTemplate.examples || [],
        savedAt: new Date().toISOString()
      }));
      saved++;
      if (saved % 5 === 0) { writeJSON('jm_saved_words', state.savedWords.map(normalizeSavedWord)); debounceSave(); scheduleCloudLibrarySync(); setStatus(`Saved ${saved} templates...`); }
      if (saved >= 40) break;
    }
    writeJSON('jm_saved_words', state.savedWords.map(normalizeSavedWord)); debounceSave(); scheduleCloudLibrarySync();
    toast(saved ? `${saved} templates saved` : 'No new templates found');
    setStatus(saved ? `${saved} sentence templates saved to cloud sync queue` : 'No new templates found');
  }

  async function saveLine(idx, translateIfMissing = true) {
    const item = state.subtitles[idx]; if (!item) return;
    const key = lineKey(item);
    let ar = item.ar || '';
    if (!ar && translateIfMissing) {
      setStatus('Translating line with OpenRouter/Puter before saving...');
      try { ar = await translateSubtitlePreferred(cleanLine(item.en)); item.ar = ar; if ($('ar-' + idx)) $('ar-' + idx).innerHTML = escapeHtml(ar); if (idx === state.lastIndex) updateDock(item, state.lastWordIndex); } catch (e) { console.warn(e); ar = ''; setStatus('AI translation failed while saving line. Saved without Arabic translation.'); }
    }
    const existing = state.savedLines.find(x => x.key === key);
    if (existing) { existing.ar = existing.ar || ar; toast('Line already saved'); }
    else state.savedLines.unshift(normalizeSavedLine({...item, ar, key, savedAt:new Date().toISOString(), sourceTitle: state.lessonTitle || ''}));
    writeJSON('jm_saved_lines', state.savedLines); debounceSave(); toast('Line saved'); scheduleCloudLibrarySync();
  }
  async function copyLine(idx) {
    const item = state.subtitles[idx]; if (!item) return;
    const text = cleanLine(item.en);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('Clipboard API unavailable');
      toast('Copied');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed'); }
      ta.remove();
    }
  }

  // Generate 5 natural example sentences for a word or phrasal verb, each with
  // an Egyptian-colloquial Arabic translation + a short note explaining why
  // the word sounds natural in that specific context.
  function buildPuterWordExamplesPrompt(term, contextEn = '') {
    const isPhrase = String(term).includes(' ');
    return `You are writing realistic English example sentences for an Egyptian Arabic-speaking learner.

TARGET ${isPhrase ? 'PHRASE / PHRASAL VERB' : 'WORD'}: "${term}"
${contextEn ? `LEARNER FIRST MET IT IN: "${contextEn}"` : ''}

GENERATE EXACTLY 5 SHORT, REALISTIC EXAMPLES that sound like native everyday English (lines you'd hear in a movie, a TV show, or a real conversation).

CORE PRINCIPLES — follow these strictly:
1. First decide HOW native speakers actually use "${term}" — register (casual / neutral / formal), typical situations, common collocations.
2. Then build a realistic situation around that usage. Do NOT shoehorn the word into random contexts.
3. If "${term}" is rare, formal, technical, or literary — pick the kind of context where a native speaker WOULD naturally use it (news, business, academic, dramatic). Don't pretend it's casual when it isn't.
4. Never force the word into a sentence. If a sentence sounds awkward, change the SITUATION until the word feels right.
5. Prioritize natural conversation over vocabulary coverage.
6. Avoid textbook-style sentences and obvious vocabulary drills. No "I will go to the shop to buy bread" mechanical patterns.
7. Don't write something a native would find weird or stilted.
8. Vary the situations — don't reuse the same scene 5 times.
9. Use the natural inflected form when needed (e.g. "recommended", "recommendation" instead of bare "recommend").
10. PREFER words and phrases that native speakers actually use in everyday conversation (movies, casual chat). If "${term}" itself is FORMAL, ACADEMIC, OUTDATED, or RARE in daily speech, you MUST explicitly say so AND give a more common alternative that natives would use instead — fill the "alt" field (e.g. for "endeavor" → "try"; for "commence" → "start"; for "purchase" → "buy"). For common conversational targets leave "alt" empty.

For EACH example, ALSO write a one-line Arabic note (المصرية الدارجة) explaining WHY the word fits this exact situation.
The "alt" field is optional per example — fill it only when a more common everyday alternative exists for the target word in that line; otherwise use an empty string.

Translations must be NATURAL EGYPTIAN COLLOQUIAL ARABIC (المصرية الدارجة) — friendly, not formal MSA, no transliteration, no quotation marks.

Return JSON ONLY, no other text:
{"examples":[
  {"en":"...","ar":"...","note":"...","alt":""},
  {"en":"...","ar":"...","note":"...","alt":""},
  {"en":"...","ar":"...","note":"...","alt":""},
  {"en":"...","ar":"...","note":"...","alt":""},
  {"en":"...","ar":"...","note":"...","alt":""}
]}`;
  }

  async function fetchWordExamplesFromPuter(term, contextEn = '') {
    if (!window.puter?.ai?.chat) throw new Error('Puter AI is not loaded.');
    const prompt = buildPuterWordExamplesPrompt(term, contextEn);
    let lastError = null;
    for (const model of PUTER_SUBTITLE_MODELS) {
      try {
        const resp = await window.puter.ai.chat(prompt, { model, temperature: 0.4, max_tokens: 800 });
        const parsed = parseJsonLoose(puterResponseToText(resp));
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.examples) ? parsed.examples : []);
        const rows = list
          .map(x => ({
            en: cleanLine(x?.en || x?.english || ''),
            ar: cleanPuterArabicTranslation(x?.ar || x?.arabic || ''),
            note: cleanLine(x?.note || x?.why || x?.reason || ''),
            alt: cleanLine(x?.alt || x?.alternative || x?.commonAlt || '')
          }))
          .filter(x => x.en)
          .slice(0, 5);
        if (rows.length) return rows;
      } catch (e) { lastError = e; console.warn('Puter word examples failed with model', model, e); }
    }
    throw lastError || new Error('No examples');
  }

  // Translate a word/phrase to short natural Egyptian Arabic. Puter first,
  // MyMemory fallback so it always returns something usable.
  async function translateTermPreferred(term, contextEn = '') {
    term = cleanLine(term);
    if (!term) return '';
    if (window.puter?.ai?.chat) {
      const isPhrase = term.includes(' ');
      const prompt = `Translate the English ${isPhrase ? 'phrase' : 'word'} "${term}" into SHORT natural Egyptian colloquial Arabic (المصرية الدارجة)${contextEn ? ` as used in: "${contextEn}"` : ''}. Return ONLY the Arabic, no notes, no quotes.`;
      for (const model of PUTER_SUBTITLE_MODELS) {
        try {
          const r = await window.puter.ai.chat(prompt, { model, temperature: 0.2, max_tokens: 80 });
          const ar = cleanPuterArabicTranslation(puterResponseToText(r));
          if (ar) return ar;
        } catch (e) { console.warn('Puter term translation failed:', e); }
      }
    }
    try { return await translateMyMemory(term); } catch { return ''; }
  }

  // Build dict-example HTML rows, each with its own 🔊 speak button.
  function renderDictExampleRows(examples) {
    return examples.map(ex => `<div class="example">
      <div class="ex-head"><button class="ex-speak" data-speak-ex="${escapeHtml(ex.en)}" title="Speak">🔊</button></div>
      <p class="ex-en" dir="ltr">${escapeHtml(ex.en)}</p>
      <p class="ex-ar" dir="rtl">${escapeHtml(ex.ar || 'تعذر ترجمة المثال')}</p>
      ${ex.note ? `<p class="ex-note" dir="rtl">💡 ${escapeHtml(ex.note)}</p>` : ''}
      ${ex.alt ? `<div class="ex-alt"><span class="ex-alt-label">💬 Natives more often say</span><span class="ex-alt-text" dir="ltr">${escapeHtml(ex.alt)}</span><button class="ex-speak" data-speak-ex="${escapeHtml(ex.alt)}" title="Speak alternative">🔊</button></div>` : ''}
    </div>`).join('');
  }

  // Accepts a single word OR a compound phrase (e.g. "wake up").
  async function openDict(rawTerm, idx = state.lastIndex) {
    // Keep internal spaces so phrasal verbs survive; strip other punctuation.
    const term = String(rawTerm || '').replace(/[^A-Za-zÀ-ÿ0-9' -]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!term) return;
    const isPhrase = term.includes(' ');
    const item = state.subtitles[idx];
    const contextEn = item ? cleanLine(item.en) : '';
    state.currentDictWord = term;
    state.currentDictExamples = [];
    $('dictWord').textContent = term;
    $('dictTranslation').textContent = 'Searching…';
    $('dictContext').innerHTML = idx >= 0 && item ? wordHtml(item.en, -1) : '';

    // Instant offline data from the bundled vocabulary: CEFR level + POS badge
    // and the curated Arabic meaning (shown immediately, before any network).
    initLocalVocab();
    const meta = (state.meanings && state.meanings[term.toLowerCase()]) || null;
    const lvl = (meta && meta.level) || cefrLevelOf(term) || (state.cefrLevels && state.cefrLevels[term.toLowerCase()]) || '';
    if ($('dictMeta')) {
      const chips = [];
      if (lvl) chips.push(`<span class="cefr-badge lvl-${lvl}">${lvl}</span>`);
      if (meta && meta.pos) chips.push(`<span class="pos-badge">${escapeHtml(meta.pos)}</span>`);
      $('dictMeta').innerHTML = chips.join(' ');
    }
    if (meta && meta.ar) $('dictTranslation').textContent = meta.ar;   // instant curated meaning

    // Phrase chips: when a SINGLE word was clicked, surface the compound
    // phrases in the line so the user can open the full phrasal-verb card.
    if ($('dictPhrases')) {
      const phrases = (item && !isPhrase) ? detectPhrasesInLine(item.en, term) : [];
      $('dictPhrases').innerHTML = phrases.length
        ? `<div class="phrase-suggestions"><b>🧩 Compound / phrasal verbs here</b><p>Tap to open the full card: meaning, 5 Egyptian examples &amp; pronunciation.</p>${phrases.map(p => `<button class="phrase-save-btn" data-open-term="${escapeHtml(p.phrase)}" data-index="${idx}">▸ ${escapeHtml(p.phrase)}</button>`).join('')}</div>`
        : '';
    }
    $('dictExamples').innerHTML = '';
    openModal('dictModal');
    speak(term);
    $('dictPlayPhraseBtn').onclick = () => openPlayPhrase(term);
    $('dictSpeakBtn').onclick = () => speak(term);
    $('dictSaveBtn').onclick = () => saveWord(term, $('dictTranslation').textContent || '', {
      kind: isPhrase ? 'phrase' : 'word',
      contextEn, contextAr: item?.ar || '',
      sourceLineKey: item ? lineKey(item) : '',
      sourceTitle: state.lessonTitle || '',
      startTime: item?.startTime || 0,
      examples: state.currentDictExamples || []
    });

    // Translation — use the curated offline meaning if we have one; otherwise
    // Egyptian Puter first, MyMemory fallback.
    if (!(meta && meta.ar)) {
      try { $('dictTranslation').textContent = await translateTermPreferred(term, contextEn); }
      catch { $('dictTranslation').textContent = 'Translation failed'; }
    }

    // Examples — 5 from Puter AI (Egyptian), fallback to dictionary API + MyMemory.
    $('dictExamples').innerHTML = '<div class="example">✨ Puter AI is writing 5 Egyptian examples…</div>';
    try {
      const rows = await fetchWordExamplesFromPuter(term, contextEn);
      if (!rows.length) throw new Error('empty');
      // Guard: the modal may have been reused for another term while we awaited.
      if (state.currentDictWord !== term) return;
      state.currentDictExamples = rows;
      $('dictExamples').innerHTML = renderDictExampleRows(rows);
    } catch (puterErr) {
      console.warn('Puter examples unavailable, falling back to dictionary API:', puterErr);
      try {
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`);
        const data = await res.json(); const examples = [];
        for (const m of data?.[0]?.meanings || []) for (const d of m.definitions || []) if (d.example) examples.push(d.example);
        const topExamples = [...new Set(examples)].slice(0, 5);
        if (!topExamples.length) throw new Error('No examples');
        $('dictExamples').innerHTML = '<div class="example">Translating examples…</div>';
        const rows = [];
        for (const ex of topExamples) {
          let ar = '';
          try { ar = await translateMyMemory(ex); } catch {}
          rows.push({ en: ex, ar: ar || '' });
        }
        if (state.currentDictWord !== term) return;
        state.currentDictExamples = rows;
        $('dictExamples').innerHTML = renderDictExampleRows(rows);
      } catch { $('dictExamples').innerHTML = '<div class="example">No examples found.</div>'; }
    }
  }

  function showSaved(type) {
    const body = $('savedBody');
    const isWords = type === 'words';
    const isPhrases = type === 'phrases';
    const isTemplates = type === 'templates';
    $('savedTitle').textContent = isTemplates ? 'Saved templates' : (isPhrases ? 'Saved phrases' : (isWords ? 'Saved words' : 'Saved lines'));
    state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word);
    state.savedLines = state.savedLines.map(normalizeSavedLine);
    const wordItems = isTemplates ? state.savedWords.filter(x => x.kind === 'template') : (isPhrases ? state.savedWords.filter(x => x.kind === 'phrase') : state.savedWords.filter(x => x.kind === 'word'));
    const arr = (isWords || isPhrases || isTemplates) ? wordItems : state.savedLines;
    const countLabel = isTemplates ? 'templates' : (isPhrases ? 'phrases' : (isWords ? 'words' : 'lines'));
    const header = `<div class="saved-folder-head"><b>${arr.length} saved ${countLabel}</b><small>Tap any title to open meaning, context, examples, and review options.</small>${isTemplates ? '<div class="saved-actions template-clean-actions"><button class="small-btn" data-refresh-all-template-examples>Generate all with OpenRouter/Puter</button><button class="small-btn danger" data-delete-selected-templates>Delete selected</button><button class="small-btn danger" data-delete-all-templates>Delete all templates</button></div><small class="delete-hint">Tick templates you want to remove, or open one template and delete it only. Deletions sync to Supabase.</small>' : ''}</div>`;
    if (!arr.length) { body.innerHTML = header + '<p>No saved items yet.</p>'; openModal('savedModal'); return; }
    body.innerHTML = header + arr.map((x, i) => {
      if (isWords || isPhrases || isTemplates) {
        const originalIndex = state.savedWords.indexOf(x);
        const exLimit = x.kind === 'template' ? 3 : 5;
        const displayExamples = x.kind === 'template' ? sanitizeTemplateExamples(x.examples || [], x.word, x.contextEn || '') : (Array.isArray(x.examples) ? x.examples.slice(0, exLimit) : []);
        const examples = displayExamples.length ? `<div class="saved-section"><b>Examples <small class="example-source">Puter AI · Egyptian</small></b>${displayExamples.slice(0, exLimit).map(ex => `<div class="saved-example">${(ex.en || ex) ? `<button class="ex-speak" data-speak-ex="${escapeHtml(ex.en || ex)}" title="Speak">🔊</button>` : ''}<p dir="ltr">${escapeHtml(ex.en || ex)}</p>${ex.ar ? `<p dir="rtl">${escapeHtml(ex.ar)}</p>` : ''}</div>`).join('')}</div>` : '';
        const usage = x.kind === 'template' ? `<div class="saved-section template-usage"><b>When to use it</b>${x.templateUsageEn ? `<p dir="ltr">${escapeHtml(x.templateUsageEn)}</p>` : ''}${x.templateUsageAr ? `<p dir="rtl" class="ar">${escapeHtml(x.templateUsageAr)}</p>` : ''}${x.templateSlot ? `<small>Original slot: ${escapeHtml(x.templateSlot)}</small>` : ''}</div>` : '';
        const label = x.kind === 'template' ? 'Template' : (x.kind === 'phrase' ? 'Phrase' : 'Word');
        return `<details class="saved-details ${x.kind === 'phrase' ? 'phrase-item' : ''} ${x.kind === 'template' ? 'template-item' : ''}">
          <summary>${x.kind === 'template' ? `<label class="saved-select-check" onclick="event.stopPropagation()" title="Select for deletion"><input type="checkbox" data-template-select="${originalIndex}" /></label>` : ''}<span class="saved-type-chip ${x.kind === 'template' ? 'template-chip' : ''}">${label}</span><b dir="ltr">${escapeHtml(x.word)}</b><span class="due-chip">Due: ${formatDue(x.dueAt)}</span></summary>
          <div class="saved-detail-body">
            ${x.ar ? `<div class="saved-section"><b>Meaning / usage</b><p dir="rtl">${escapeHtml(x.ar)}</p></div>` : ''}
            ${usage}
            ${x.contextEn ? `<div class="saved-section"><b>Movie context</b><p dir="ltr">${escapeHtml(x.contextEn)}</p>${x.contextAr ? `<p dir="rtl" class="ar">${escapeHtml(x.contextAr)}</p>` : ''}</div>` : ''}
            ${examples}
            <div class="saved-actions">${x.kind === 'template' ? `<button class="small-btn" data-refresh-template-examples="${originalIndex}">Generate with OpenRouter AI</button><button class="small-btn danger" data-delete-template-index="${originalIndex}">Delete template</button>` : ''}<button class="small-btn" data-pp-word="${escapeHtml(x.word)}">PlayPhrase</button><button class="small-btn" data-review-one="word:${originalIndex}">Review</button></div>
          </div>
        </details>`;
      }
      return `<details class="saved-details">
        <summary><b dir="ltr">${escapeHtml(cleanLine(x.en))}</b><span class="due-chip">Due: ${formatDue(x.dueAt)}</span></summary>
        <div class="saved-detail-body">
          ${x.ar ? `<div class="saved-section"><b>Arabic translation</b><p dir="rtl">${escapeHtml(x.ar)}</p></div>` : ''}
          <div class="saved-actions"><button class="small-btn" data-saved-play="${i}">Play</button><button class="small-btn" data-pp-line="${i}">PlayPhrase</button><button class="small-btn" data-review-one="line:${i}">Review</button></div>
        </div>
      </details>`;
    }).join('');
    openModal('savedModal');
  }

  function formatDue(iso) {
    const d = new Date(iso || Date.now()); const diff = d.getTime() - Date.now();
    if (diff <= 0) return 'now';
    const mins = Math.ceil(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.ceil(mins/60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.ceil(hrs/24)}d`;
  }

  function getDueReviewCards(filterDeck) {
    state.savedLines = state.savedLines.map(normalizeSavedLine);
    state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word);
    const now = Date.now();
    const matchDeck = (item) => {
      if (!filterDeck || filterDeck === '__all__') return true;
      const t = (item.sourceTitle || '').trim() || '__none__';
      return t === filterDeck;
    };
    const lineCards = state.savedLines
      .filter(x => new Date(x.dueAt || 0).getTime() <= now && matchDeck(x))
      .map(x => ({ type: 'line', key: x.key, item: x }));
    const wordCards = state.savedWords
      .filter(x => new Date(x.dueAt || 0).getTime() <= now && matchDeck(x))
      .map(x => ({ type: 'word', key: x.key || wordKey(x.word), item: x }));
    return [...wordCards, ...lineCards].sort((a, b) => new Date(a.item.dueAt || 0) - new Date(b.item.dueAt || 0));
  }

  // Group ALL saved items (due or not) by their sourceTitle, with due counts.
  // Returns [{ key, label, due, total }] sorted by due count desc.
  function reviewDecks() {
    state.savedLines = state.savedLines.map(normalizeSavedLine);
    state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word);
    const now = Date.now();
    const map = new Map();
    const bump = (item) => {
      const raw = (item.sourceTitle || '').trim();
      const key = raw || '__none__';
      const label = raw || 'Other (no movie tagged)';
      const ent = map.get(key) || { key, label, due: 0, total: 0 };
      ent.total++;
      if (new Date(item.dueAt || 0).getTime() <= now) ent.due++;
      map.set(key, ent);
    };
    state.savedWords.forEach(bump);
    state.savedLines.forEach(bump);
    return [...map.values()].sort((a, b) => (b.due - a.due) || (b.total - a.total) || a.label.localeCompare(b.label));
  }

  function allReviewItems() {
    return [
      ...state.savedWords.map(normalizeSavedWord).filter(x => x.word).map(x => ({ type:'word', key:x.key || wordKey(x.word), item:x })),
      ...state.savedLines.map(normalizeSavedLine).map(x => ({ type:'line', key:x.key, item:x }))
    ];
  }

  // ════════════════════════════════════════════════════════════════
  // SMART REVIEW CARDS
  //
  // Five card modes are picked per-card based on item kind and maturity:
  //   recognize     — EN → AR (current behaviour, default for new cards)
  //   produce       — AR → EN, user TYPES the answer (active recall, harder)
  //   cloze         — context sentence with the target blanked out
  //   listen        — TTS speaks the EN, user recalls AR (listening practice)
  //   template-fill — template pattern + meaning, user recalls a usage example
  //
  // The picker favours easier modes for new cards and adds harder modes as
  // the card matures. The user can disable any mode in the in-review settings
  // panel — disabled modes simply drop out of the rotation.
  //
  // Again-cards are re-queued 3–5 positions ahead instead of disappearing
  // until the next session (the previous behaviour was a known weakness).
  // ════════════════════════════════════════════════════════════════

  const SMART_MODES = ['recognize', 'produce', 'cloze', 'listen', 'template-fill'];

  function getSmartReviewSettings() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem('jm_smart_review_settings') || '{}'); } catch { raw = {}; }
    const enabled = raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {};
    return {
      enabled: {
        recognize:       enabled.recognize       !== false,
        produce:         enabled.produce         !== false,
        cloze:           enabled.cloze           !== false,
        listen:          enabled.listen          !== false,
        'template-fill': enabled['template-fill'] !== false
      },
      autoSpeak: raw.autoSpeak === true
    };
  }

  function setSmartReviewSettings(patch) {
    const cur = getSmartReviewSettings();
    const next = { ...cur, ...patch, enabled: { ...cur.enabled, ...(patch?.enabled || {}) } };
    localStorage.setItem('jm_smart_review_settings', JSON.stringify(next));
    return next;
  }

  function speakText(text, lang = 'en-US') {
    // Delegates to the unified Puter-natural pipeline. The lang hint is
    // implicit in the chosen voice (en-US / en-GB) — we ignore it here so
    // the user's chosen voice always wins.
    speakNatural(text);
    return;
    // eslint-disable-next-line no-unreachable
    if (!text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = lang; u.rate = 0.95; u.pitch = 1;
      // Prefer a native English voice if the browser exposes one — falls back silently.
      const voices = window.speechSynthesis.getVoices();
      const en = voices.find(v => /en-US/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang));
      if (en) u.voice = en;
      window.speechSynthesis.speak(u);
    } catch (e) { console.warn('TTS failed:', e); }
  }

  // Normalise an answer for comparison: lowercase, strip diacritics + punctuation,
  // collapse whitespace. Keeps Arabic letters and Latin letters intact.
  function normalizeAnswer(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s']/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Tiny Levenshtein distance — good enough to flag typos in short subtitle words.
  function editDistance(a, b) {
    a = a || ''; b = b || '';
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }

  // Returns 'exact' | 'almost' | 'wrong'. "almost" lets the user grade themselves
  // honestly: we don't auto-mark, we just hint.
  function validateAnswer(typed, expected) {
    const t = normalizeAnswer(typed), e = normalizeAnswer(expected);
    if (!t || !e) return 'wrong';
    if (t === e) return 'exact';
    // Accept "house" when expected is "the house" or vice versa.
    if (e.includes(t) || t.includes(e)) return 'almost';
    const dist = editDistance(t, e);
    if (dist <= Math.max(1, Math.floor(e.length * 0.15))) return 'almost';
    return 'wrong';
  }

  function pickCardMode(card) {
    const { enabled } = getSmartReviewSettings();
    const item = card.item;
    const isWord = card.type === 'word';
    const count = Number(item.reviewCount || 0);
    const hasCloze = isWord && !!(item.contextEn || item.templateUsageEn);
    const isTemplate = isWord && item.kind === 'template';
    const isPhrase   = isWord && item.kind === 'phrase';

    // Build a weighted pool based on maturity.
    const pool = [];
    if (enabled.recognize) pool.push('recognize');
    if (isTemplate && enabled['template-fill']) {
      pool.push('template-fill', 'template-fill'); // double weight for templates
    }
    if (count >= 1 && enabled.listen)  pool.push('listen');
    if (count >= 2 && hasCloze && enabled.cloze) pool.push('cloze');
    if (count >= 3 && enabled.produce && !isTemplate) pool.push('produce');
    // Mature cards (≥6 reviews) get harder modes more often.
    if (count >= 6) {
      if (enabled.produce && !isTemplate) pool.push('produce');
      if (enabled.cloze && hasCloze) pool.push('cloze');
    }
    if (!pool.length) pool.push('recognize');

    // Deterministic-ish: tie mode to (key + reviewCount) so the same review
    // session shows the same mode for a card even after a state re-render.
    const seed = (String(card.key) + ':' + count).split('').reduce((s, c) => s + c.charCodeAt(0), 0);
    return pool[seed % pool.length];
  }

  function buildClozeFrontAndAnswer(item) {
    const target = String(item.word || '').trim();
    const ctx = String(item.templateUsageEn || item.contextEn || '').trim();
    if (!target || !ctx) return null;
    // Find the target as a whole-word, case-insensitive.
    const re = new RegExp('\\b' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (!re.test(ctx)) return null;
    return {
      front: ctx.replace(re, '_____'),
      answer: target
    };
  }

  function ensureSessionState(reset = false) {
    if (reset || !state.smartSession) {
      state.smartSession = {
        startedAt: Date.now(),
        counts: { recognize: 0, produce: 0, cloze: 0, listen: 0, 'template-fill': 0 },
        grades: { again: 0, hard: 0, good: 0, easy: 0 },
        totalRated: 0,
        // Queue holds card-IDs in review order; we manage Again re-queueing here.
        queueIds: [],
        finishedIds: new Set()
      };
    }
    return state.smartSession;
  }

  function bumpStreakIfFirstRating() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const last = localStorage.getItem('jm_review_streak_last') || '';
      let streak = Number(localStorage.getItem('jm_review_streak_count') || 0);
      if (last === today) return; // already counted today
      const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      streak = last === yest ? streak + 1 : 1;
      localStorage.setItem('jm_review_streak_last', today);
      localStorage.setItem('jm_review_streak_count', String(streak));
    } catch {}
  }

  function getStreak() {
    return Number(localStorage.getItem('jm_review_streak_count') || 0);
  }

  function cardId(card) { return `${card.type}:${card.key}`; }

  function showReviewCards() {
    openMenu(false);
    // Open the modal on the DECK PICKER step — the user chooses which movie/
    // source to review (or "All"). Picking enters the actual review loop.
    state.reviewDeck = null;
    $('savedTitle').textContent = 'Review decks';
    renderReviewDecks();
    openModal('savedModal');
  }

  function startReviewSession(deckKey) {
    state.reviewDeck = deckKey || '__all__';
    state.reviewQueue = getDueReviewCards(state.reviewDeck);
    state.reviewIndex = 0;
    state.reviewRevealed = false;
    state.reviewTyped = '';
    state.reviewFeedback = '';
    ensureSessionState(true);
    state.smartSession.queueIds = state.reviewQueue.map(cardId);
    const deckLabel = state.reviewDeck === '__all__'
      ? 'All decks'
      : (reviewDecks().find(d => d.key === state.reviewDeck)?.label || 'Deck');
    $('savedTitle').textContent = `Review · ${deckLabel}`;
    renderReviewCard();
  }

  // Decks list shown when the user first opens Review cards. Each entry is one
  // saved-from-movie group with a due/total count and a Start button.
  function renderReviewDecks() {
    const body = $('savedBody');
    const decks = reviewDecks();
    const totalDue = decks.reduce((n, d) => n + d.due, 0);
    if (!decks.length) {
      body.innerHTML = `<div class="review-empty"><b>No saved cards yet</b><p>Save words, phrases, or lines while watching to build your decks.</p></div>`;
      return;
    }
    const renderDeck = (d) => `<button class="deck-row${d.due ? '' : ' is-empty'}" data-review-start-deck="${escapeHtml(d.key)}" ${d.due ? '' : 'disabled'}>
      <div class="deck-icon">📽️</div>
      <div class="deck-main">
        <div class="deck-name" dir="ltr">${escapeHtml(d.label)}</div>
        <div class="deck-meta">${d.total} card${d.total === 1 ? '' : 's'} saved</div>
      </div>
      <div class="deck-due">${d.due > 0 ? `<b>${d.due}</b><small>due now</small>` : `<span class="deck-clear">✓</span>`}</div>
    </button>`;
    body.innerHTML = `
      <p class="hint-small">Pick a movie / series to start reviewing — each deck holds the words, phrases and lines you saved from it.</p>
      <div class="deck-list">
        ${totalDue > 0 ? `<button class="deck-row deck-row-all" data-review-start-deck="__all__">
          <div class="deck-icon">🎬</div>
          <div class="deck-main">
            <div class="deck-name">All decks</div>
            <div class="deck-meta">Mixed review across every movie</div>
          </div>
          <div class="deck-due"><b>${totalDue}</b><small>due now</small></div>
        </button>` : ''}
        ${decks.map(renderDeck).join('')}
      </div>
    `;
  }

  function showSingleReviewCard(type, index) {
    const item = type === 'word' ? state.savedWords[Number(index)] : state.savedLines[Number(index)];
    if (!item) return;
    state.reviewQueue = [{ type, key: type === 'word' ? (item.key || wordKey(item.word)) : item.key, item: type === 'word' ? normalizeSavedWord(item) : normalizeSavedLine(item) }];
    state.reviewIndex = 0;
    state.reviewRevealed = false;
    state.reviewTyped = '';
    state.reviewFeedback = '';
    ensureSessionState(true);
    state.smartSession.queueIds = state.reviewQueue.map(cardId);
    $('savedTitle').textContent = type === 'word' ? 'Review word' : 'Review line';
    renderReviewCard();
    openModal('savedModal');
  }

  function renderSmartSessionStats() {
    const s = state.smartSession;
    if (!s) return '';
    const streak = getStreak();
    return `<div class="smart-stats">
      <span class="ss-chip"><b>${s.totalRated}</b> rated</span>
      <span class="ss-chip again">${s.grades.again} again</span>
      <span class="ss-chip good">${s.grades.good + s.grades.easy} got</span>
      <span class="ss-chip streak">🔥 ${streak}d streak</span>
    </div>`;
  }

  function renderSmartSettingsPanel() {
    const { enabled, autoSpeak } = getSmartReviewSettings();
    const opt = (k, label) => `<label class="mode-chip ${enabled[k] ? 'on' : ''}"><input type="checkbox" data-smart-mode="${k}" ${enabled[k] ? 'checked' : ''}><span>${label}</span></label>`;
    return `<details class="smart-settings"><summary>⚙️ Card modes</summary>
      <div class="mode-row">
        ${opt('recognize', '👁️ Recognize')}
        ${opt('produce', '⌨️ Produce')}
        ${opt('cloze', '🧩 Cloze')}
        ${opt('listen', '🔊 Listen')}
        ${opt('template-fill', '📐 Template')}
      </div>
      <label class="mode-chip wide ${autoSpeak ? 'on' : ''}"><input type="checkbox" data-smart-autospeak ${autoSpeak ? 'checked' : ''}><span>Auto-speak on flip</span></label>
    </details>`;
  }

  function renderReviewCard() {
    const body = $('savedBody');
    if (!state.savedLines.length && !state.savedWords.length) {
      body.innerHTML = '<p>No saved words or lines yet.</p>';
      return;
    }
    const due = state.reviewQueue;
    if (!due.length) {
      const s = state.smartSession;
      const stats = s && s.totalRated > 0
        ? `<div class="session-summary">
            <div class="ss-line"><b>Total:</b> ${s.totalRated} cards</div>
            <div class="ss-line"><b>Easy:</b> ${s.grades.easy} · <b>Good:</b> ${s.grades.good} · <b>Hard:</b> ${s.grades.hard} · <b>Again:</b> ${s.grades.again}</div>
            <div class="ss-line"><b>Retention:</b> ${Math.round(((s.totalRated - s.grades.again) / s.totalRated) * 100)}%</div>
            <div class="ss-line"><b>🔥 Streak:</b> ${getStreak()} day(s)</div>
          </div>`
        : '';
      const all = allReviewItems().sort((a,b)=>new Date(a.item.dueAt)-new Date(b.item.dueAt));
      const next = all[0]?.item;
      body.innerHTML = `<div class="review-empty"><b>All cards reviewed ✅</b>${stats}<p>Next review: ${formatDue(next?.dueAt)}</p><div class="review-empty-actions"><button class="small-btn" data-review-back-to-decks>← Back to decks</button><button class="small-btn" data-show-saved-lines>Open saved lines</button></div></div>`;
      return;
    }

    const card = due[state.reviewIndex] || due[0];
    const item = card.item;
    const isWord = card.type === 'word';
    const mode = pickCardMode(card);
    card.__mode = mode;
    const en = isWord ? item.word : cleanLine(item.en);
    const ar = item.ar || (isWord ? 'لا توجد ترجمة محفوظة لهذه الكلمة أو العبارة' : 'لا توجد ترجمة محفوظة');
    const badge = isWord ? (item.kind === 'template' ? '📐 Template' : (item.kind === 'phrase' ? '💬 Phrase' : '🔤 Word')) : '📜 Line';
    const modeLabel = ({ recognize: '👁️ Recognize', produce: '⌨️ Produce', cloze: '🧩 Cloze', listen: '🔊 Listen', 'template-fill': '📐 Template fill' })[mode] || mode;
    const reviewContext = isWord
      ? `${item.templateUsageEn ? `<div class="review-context" dir="ltr">${escapeHtml(item.templateUsageEn)}</div>` : ''}${item.templateUsageAr ? `<div class="review-context ar" dir="rtl">${escapeHtml(item.templateUsageAr)}</div>` : ''}${item.contextEn ? `<div class="review-context" dir="ltr">${escapeHtml(item.contextEn)}</div>` : ''}${item.contextAr ? `<div class="review-context ar" dir="rtl">${escapeHtml(item.contextAr)}</div>` : ''}`
      : '';

    // ─── Per-mode FRONT ───
    let frontHtml = '';
    let answerHint = ''; // text to validate typed input against, if mode supports typing
    if (mode === 'recognize') {
      frontHtml = `<div class="review-front" dir="ltr">${escapeHtml(en)}</div>`;
    } else if (mode === 'listen') {
      frontHtml = `<div class="review-front listen-front" dir="ltr">
        <button class="speak-big" data-review-speak data-speak-text="${escapeHtml(en)}">🔊 Tap to listen</button>
        <p class="hint-small">Recall the Arabic meaning, then reveal.</p>
      </div>`;
    } else if (mode === 'produce') {
      answerHint = en;
      const typedAttr = state.reviewTyped ? ` value="${escapeHtml(state.reviewTyped)}"` : '';
      frontHtml = `<div class="review-front produce-front" dir="rtl">${escapeHtml(ar)}
        <input class="answer-input" type="text" dir="ltr" placeholder="Type the English…" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" data-review-answer${typedAttr} />
        <div class="answer-feedback ${state.reviewFeedback || ''}">${
          state.reviewFeedback === 'exact' ? '✅ Exact match'
          : state.reviewFeedback === 'almost' ? '🟡 Almost right — check spelling'
          : state.reviewFeedback === 'wrong' ? '❌ Not quite — reveal and grade yourself'
          : ''
        }</div>
      </div>`;
    } else if (mode === 'cloze') {
      const cl = buildClozeFrontAndAnswer(item);
      if (!cl) {
        // Fall back to recognize when no usable context exists.
        frontHtml = `<div class="review-front" dir="ltr">${escapeHtml(en)}</div>`;
        card.__mode = 'recognize';
      } else {
        answerHint = cl.answer;
        const typedAttr = state.reviewTyped ? ` value="${escapeHtml(state.reviewTyped)}"` : '';
        frontHtml = `<div class="review-front cloze-front" dir="ltr">${escapeHtml(cl.front)}
          <input class="answer-input" type="text" dir="ltr" placeholder="Fill in the blank…" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" data-review-answer${typedAttr} />
          <div class="answer-feedback ${state.reviewFeedback || ''}">${
            state.reviewFeedback === 'exact' ? '✅ Exact match'
            : state.reviewFeedback === 'almost' ? '🟡 Almost right'
            : state.reviewFeedback === 'wrong' ? '❌ Not quite' : ''
          }</div>
        </div>`;
      }
    } else if (mode === 'template-fill') {
      frontHtml = `<div class="review-front template-front" dir="ltr">
        <div class="template-pattern">${escapeHtml(item.word)}</div>
        ${item.templateUsageAr ? `<div class="template-meaning" dir="rtl">${escapeHtml(item.templateUsageAr)}</div>` : ''}
        <p class="hint-small">Recall a natural English example using this pattern.</p>
      </div>`;
    }

    // ─── BACK (always the same: full answer + context) ───
    const backHtml = `<div class="review-back ${state.reviewRevealed ? '' : 'hidden'}" dir="rtl">
      <div class="back-main">${escapeHtml(ar)}</div>
      <div class="back-en" dir="ltr">${escapeHtml(en)}</div>
      ${reviewContext}
    </div>`;

    body.innerHTML = `${renderSmartSessionStats()}
      ${renderSmartSettingsPanel()}
      <div class="review-card" data-review-key="${escapeHtml(card.key)}" data-review-type="${card.type}" data-review-mode="${mode}" data-answer="${escapeHtml(answerHint)}">
        <div class="review-count">
          <button class="review-back-btn" data-review-back-to-decks title="Back to decks">←</button>
          <span>${state.reviewIndex + 1} / ${due.length} due · ${badge} · <span class="mode-tag">${modeLabel}</span></span>
          ${item.sourceTitle ? `<span class="review-source" dir="ltr" title="Saved from ${escapeHtml(item.sourceTitle)}">📽️ ${escapeHtml(item.sourceTitle.slice(0,30))}${item.sourceTitle.length > 30 ? '…' : ''}</span>` : ''}
        </div>
        ${frontHtml}
        <div class="card-toolbar">
          <button class="small-btn speak-btn" data-review-speak data-speak-text="${escapeHtml(en)}" title="Speak">🔊</button>
          ${answerHint ? `<button class="small-btn check-btn" data-review-check>Check</button>` : ''}
          ${!state.reviewRevealed ? `<button class="small-btn reveal-btn" data-review-reveal>Show meaning</button>` : ''}
        </div>
        ${backHtml}
        <div class="review-actions">
          <button class="small-btn again" data-review-grade="again">Again<span class="rg-when">${previewGradeInterval(item, 'again')}</span></button>
          <button class="small-btn hard"  data-review-grade="hard">Hard<span class="rg-when">${previewGradeInterval(item, 'hard')}</span></button>
          <button class="small-btn good"  data-review-grade="good">Good<span class="rg-when">${previewGradeInterval(item, 'good')}</span></button>
          <button class="small-btn easy"  data-review-grade="easy">Easy<span class="rg-when">${previewGradeInterval(item, 'easy')}</span></button>
        </div>
      </div>`;

    // Auto-speak on flip for listen mode (also if user enabled global auto-speak).
    if (mode === 'listen' || (state.reviewRevealed && getSmartReviewSettings().autoSpeak)) {
      try { setTimeout(() => speakText(en), 80); } catch {}
    }

    // Focus the answer input for produce/cloze so the user can start typing
    // immediately, and put the caret at the end if there's preserved text.
    if (mode === 'produce' || mode === 'cloze') {
      setTimeout(() => {
        const input = body.querySelector('[data-review-answer]');
        if (input) {
          input.focus();
          try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
        }
      }, 30);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // ANKI-STYLE SRS — phases + learning steps in m/h, review in days.
  //
  // PHASES
  //   learning    — new card stepping through short intervals (1m, 10m)
  //   review      — graduated card scheduled in days with ease factor
  //   relearning  — review card that lapsed; one short step then back to review
  //                 with the lapsed interval halved.
  //
  // BUTTONS  (Anki convention)
  //   Again — reset to first learning step (1m)
  //   Hard  — repeat current step (or interval × 1.2 in review)
  //   Good  — next step / graduate / interval × ease
  //   Easy  — jump straight to 4 days from learning, or interval × ease × 1.3 in review
  //
  // Every grade button gets a PREVIEW label ("Again 1m · Hard 10m · Good 1d ·
  // Easy 4d") computed without committing — pure-function clone + simulate.
  // ════════════════════════════════════════════════════════════════

  const LEARNING_STEPS_MS = [60_000, 10 * 60_000];      // 1 minute, 10 minutes
  const RELEARNING_STEPS_MS = [10 * 60_000];             // 10 minutes
  const GRADUATE_INTERVAL_DAYS = 1;
  const EASY_GRADUATE_DAYS = 4;
  const MIN_EASE_FACTOR = 1.3;
  const MAX_INTERVAL_DAYS = 365;

  function fuzzInterval(iv) {
    if (iv < 7) return iv;
    const delta = (Math.random() * 2 - 1) * iv * 0.15;
    return Math.max(1, Math.round(iv + delta));
  }
  function clampInterval(iv) { return Math.min(MAX_INTERVAL_DAYS, Math.max(0, iv)); }

  // Format ms-until-due as a compact Anki-style label.
  function formatDuration(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    if (ms < 60_000)   return '<1m';
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 86400_000) {
      const h = ms / 3600_000;
      return h < 10 ? `${h.toFixed(1).replace(/\.0$/, '')}h` : `${Math.round(h)}h`;
    }
    const days = ms / 86400_000;
    if (days < 30)  return `${Math.round(days)}d`;
    if (days < 365) return `${Math.round(days / 30)}mo`;
    return `${(days / 365).toFixed(1)}y`;
  }

  // Pure mutator: produces the next state for a card given a grade.
  // Used both for committing reviews AND for the preview labels on buttons.
  function applyReviewGrade(item, grade, now = new Date(), opts = {}) {
    const useFuzz = opts.fuzz !== false; // preview disables fuzz for stable labels
    item.reviewCount = Number(item.reviewCount || 0) + 1;
    item.lastReviewedAt = now.toISOString();
    item.lastRating = grade;
    let phase = item.phase || (Number(item.intervalDays) > 0 ? 'review' : 'learning');
    let step = Number(item.learningStep || 0);
    let interval = Number(item.intervalDays || 0);
    let ease = Number(item.ease || 2.5);
    let dueMs;

    const inLearningPhase = phase === 'learning' || phase === 'relearning';
    if (inLearningPhase) {
      const steps = phase === 'learning' ? LEARNING_STEPS_MS : RELEARNING_STEPS_MS;
      if (grade === 'again') {
        step = 0;
        dueMs = now.getTime() + steps[0];
      } else if (grade === 'hard') {
        // Repeat current step (Anki HARD in learning).
        if (step >= steps.length) step = steps.length - 1;
        dueMs = now.getTime() + steps[Math.max(0, step)];
      } else if (grade === 'good') {
        step += 1;
        if (step >= steps.length) {
          // Graduate. From relearning, resume at the pre-lapse interval (we
          // kept it via intervalDays). From fresh learning, 1 day.
          phase = 'review';
          interval = phase === 'review' && Number(item.intervalDays) > 0
            ? Math.max(1, Math.round(Number(item.intervalDays)))
            : GRADUATE_INTERVAL_DAYS;
          if (useFuzz) interval = clampInterval(fuzzInterval(interval));
          dueMs = now.getTime() + interval * 86400_000;
        } else {
          dueMs = now.getTime() + steps[step];
        }
      } else if (grade === 'easy') {
        // Jump out of learning to a comfortable 4-day interval.
        phase = 'review';
        interval = EASY_GRADUATE_DAYS;
        if (useFuzz) interval = clampInterval(fuzzInterval(interval));
        dueMs = now.getTime() + interval * 86400_000;
      }
    } else {
      // ── review phase ──
      if (grade === 'again') {
        ease = Math.max(MIN_EASE_FACTOR, ease - 0.20);
        item.lapses = Number(item.lapses || 0) + 1;
        // Halve the pre-lapse interval to use after the relearning step graduates.
        interval = Math.max(1, Math.round(interval * 0.5));
        phase = 'relearning';
        step = 0;
        dueMs = now.getTime() + RELEARNING_STEPS_MS[0];
      } else if (grade === 'hard') {
        ease = Math.max(MIN_EASE_FACTOR, ease - 0.15);
        interval = Math.max(1, Math.round(interval * 1.2));
        if (useFuzz) interval = clampInterval(fuzzInterval(interval));
        dueMs = now.getTime() + interval * 86400_000;
      } else if (grade === 'good') {
        interval = Math.max(1, Math.round(interval * ease));
        if (useFuzz) interval = clampInterval(fuzzInterval(interval));
        dueMs = now.getTime() + interval * 86400_000;
      } else if (grade === 'easy') {
        interval = Math.max(1, Math.round(interval * (ease + 0.5)));
        ease += 0.15;
        if (useFuzz) interval = clampInterval(fuzzInterval(interval));
        dueMs = now.getTime() + interval * 86400_000;
      }
    }

    item.phase = phase;
    item.learningStep = step;
    item.intervalDays = interval;
    item.ease = ease;
    item.dueAt = new Date(dueMs).toISOString();
  }

  // Returns the human-readable "next due" label for a given grade, without
  // mutating the card. Used to label the Again/Hard/Good/Easy buttons.
  function previewGradeInterval(item, grade) {
    try {
      const clone = JSON.parse(JSON.stringify(item));
      applyReviewGrade(clone, grade, new Date(), { fuzz: false });
      const ms = new Date(clone.dueAt).getTime() - Date.now();
      return formatDuration(ms);
    } catch { return ''; }
  }

  function gradeReview(key, grade, type = '') {
    let item = null;
    if (type === 'word' || String(key).startsWith('word:')) item = state.savedWords.find(x => (x.key || wordKey(x.word)) === key);
    else item = state.savedLines.find(x => x.key === key);
    if (!item) return;

    const sess = ensureSessionState();
    sess.totalRated++;
    sess.grades[grade] = (sess.grades[grade] || 0) + 1;
    const cur = state.reviewQueue[state.reviewIndex];
    if (cur?.__mode) sess.counts[cur.__mode] = (sess.counts[cur.__mode] || 0) + 1;
    bumpStreakIfFirstRating();

    applyReviewGrade(item, grade);
    state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word);
    state.savedLines = state.savedLines.map(normalizeSavedLine);
    writeJSON('jm_saved_words', state.savedWords);
    writeJSON('jm_saved_lines', state.savedLines);
    scheduleCloudLibrarySync();

    // Re-queueing: Again cards bubble back into THIS session 3–5 slots ahead
    // so the user actually re-sees them (proper SRS behaviour).
    if (grade === 'again' && state.reviewQueue.length > 1) {
      const card = state.reviewQueue.splice(state.reviewIndex, 1)[0];
      const rest = state.reviewQueue.length;
      const insertAt = Math.min(rest, state.reviewIndex + 3 + Math.floor(Math.random() * 3));
      state.reviewQueue.splice(insertAt, 0, card);
      // Stay on the SAME index so we land on the next card.
    } else {
      state.reviewQueue.splice(state.reviewIndex, 1);
      // Keep the same index — splice shifts the next card into our slot.
      if (state.reviewIndex >= state.reviewQueue.length) state.reviewIndex = 0;
    }

    state.reviewRevealed = false;
    state.reviewTyped = '';
    state.reviewFeedback = '';
    renderReviewCard();
  }


  async function getCloudClient() {
    if (!CLOUD_CONFIG.url || !CLOUD_CONFIG.key || !CLOUD_CONFIG.userCode) throw new Error('Cloud config is missing.');
    if (!window.supabase?.createClient) await loadScript(SUPABASE_CDN);
    if (!state.cloudClient) state.cloudClient = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.key);
    return state.cloudClient;
  }

  function scheduleCloudLibrarySync() {
    clearTimeout(state.cloudSyncTimer);
    state.cloudSyncTimer = setTimeout(() => syncSavedItemsToCloud({ silent: true, reason: 'auto' }), 900);
  }

  async function syncSavedItemsToCloud({ silent = true, reason = 'manual' } = {}) {
    if (state.cloudSyncInProgress) {
      state.cloudSyncPending = true;
      return false;
    }
    state.cloudSyncInProgress = true;
    try {
      normalizeLibraryState();
      const sb = await getCloudClient();
      const payload = {
        user_code: CLOUD_CONFIG.userCode,
        saved_phrases: state.savedLines.map(normalizeSavedLine),
        saved_words: savedWordsForCloud(),
        updated_at: new Date().toISOString()
      };
      const { error } = await sb.from('user_library').upsert(payload, { onConflict: 'user_code' });
      if (error) throw error;
      state.cloudLastSyncAt = payload.updated_at;
      localStorage.setItem('jm_cloud_last_sync_at', state.cloudLastSyncAt);
      if (!silent) {
        setStatus(`Saved items synced to Supabase • ${state.savedWords.length} words/phrases/templates • ${state.savedLines.length} lines`);
        toast('Saved items synced to cloud');
      } else if (reason === 'auto') {
        setStatus(`Auto-synced saved items • ${state.savedWords.length + state.savedLines.length} cards`);
      }
      return true;
    } catch (e) {
      console.warn('Cloud sync failed:', e);
      if (!silent) {
        toast('Cloud sync failed');
        alert('Cloud sync failed: ' + (e.message || e));
      }
      return false;
    } finally {
      state.cloudSyncInProgress = false;
      if (state.cloudSyncPending) {
        state.cloudSyncPending = false;
        scheduleCloudLibrarySync();
      }
    }
  }

  async function loadSavedItemsFromCloud({ silent = true, merge = true } = {}) {
    try {
      const sb = await getCloudClient();
      const { data, error } = await sb.from('user_library').select('saved_phrases,saved_words,updated_at').eq('user_code', CLOUD_CONFIG.userCode).maybeSingle();
      if (error) throw error;
      if (data) {
        const remoteLines = Array.isArray(data.saved_phrases) ? data.saved_phrases : [];
        const remoteWordsRaw = Array.isArray(data.saved_words) ? data.saved_words : [];
        const restoredLara = applyLaraSettingsFromCloud(remoteWordsRaw);
        const restoredChatLlm = applyChatLlmSettingsFromCloud(remoteWordsRaw);
        const restoredOpenRouter = applyOpenRouterSettingsFromCloud(remoteWordsRaw);
        const remoteWords = remoteWordsRaw.filter(x => !isHiddenCloudSettingsItem(x));
        if (merge) {
          state.savedLines = mergeByKey(state.savedLines, remoteLines, savedLineMergeKey, normalizeSavedLine);
          state.savedWords = mergeByKey(state.savedWords, remoteWords, savedWordMergeKey, normalizeSavedWord).filter(x => x.word && !isHiddenCloudSettingsItem(x));
        } else {
          state.savedLines = remoteLines.map(normalizeSavedLine);
          state.savedWords = remoteWords.map(normalizeSavedWord).filter(x => x.word && !isHiddenCloudSettingsItem(x));
        }
        if (restoredLara && $('laraSettingsStatus')) $('laraSettingsStatus').textContent = 'Lara settings restored from cloud.';
        if ((restoredOpenRouter || restoredChatLlm) && $('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = 'OpenRouter settings restored from cloud.';
        writeJSON('jm_saved_lines', state.savedLines);
        writeJSON('jm_saved_words', state.savedWords);
        saveState();
        state.cloudLastSyncAt = data.updated_at || new Date().toISOString();
        localStorage.setItem('jm_cloud_last_sync_at', state.cloudLastSyncAt);
        if (!silent) {
          setStatus(`Loaded saved items from Supabase • ${state.savedWords.length} words/phrases/templates • ${state.savedLines.length} lines`);
          toast('Saved items loaded from cloud');
        }
        return true;
      }
      if (!silent) toast('No saved items in cloud yet');
      return false;
    } catch (e) {
      console.warn('Cloud load failed:', e);
      if (!silent) {
        toast('Cloud load failed');
        alert('Cloud load failed: ' + (e.message || e));
      }
      return false;
    }
  }

  // Backward-compatible names used elsewhere in the app.
  const upsertCloudUserLibrary = (silent = true) => syncSavedItemsToCloud({ silent, reason: 'compat' });
  const loadCloudUserLibrary = () => loadSavedItemsFromCloud({ silent: true, merge: true });

  function buildCurrentSrtText() {
    return state.subtitles.map((item, i) => `${i + 1}\n${secondsToSrtTime(item.startTime)} --> ${secondsToSrtTime(item.endTime)}\n${cleanLine(item.en)}${item.ar ? '\n' + cleanLine(item.ar) : ''}`).join('\n\n');
  }

  async function saveLessonToCloud() {
    openMenu(false);
    if (!state.subtitles.length) return toast('Upload SRT first');
    const title = prompt('Lesson name:', `Lesson ${new Date().toLocaleDateString()}`);
    if (!title) return;
    try {
      const sb = await getCloudClient();
      const payload = {
        user_code: CLOUD_CONFIG.userCode,
        title,
        video_url: state.videoUrl && !String(state.videoUrl).startsWith('blob:') ? state.videoUrl : '',
        video_type: state.playerType,
        sync: state.offset,
        dialogue: state.subtitles,
        saved_phrases: state.savedLines.map(normalizeSavedLine),
        saved_words: state.savedWords.map(normalizeSavedWord),
        subtitle_text: buildCurrentSrtText(),
        created_at: new Date().toISOString()
      };
      const { error } = await sb.from('lessons').insert(payload);
      if (error) throw error;
      await upsertCloudUserLibrary(true);
      toast('Lesson saved to cloud');
    } catch (e) { console.error(e); toast('Cloud save failed'); alert('Cloud save failed: ' + (e.message || e)); }
  }

  async function showCloudLibrary() {
    openMenu(false);
    $('savedTitle').textContent = 'Cloud library';
    $('savedBody').innerHTML = `<p>Loading cloud lessons...</p><p class="cloud-sync-hint">${escapeHtml(cloudSyncLabel())}</p>`;
    openModal('savedModal');
    try {
      const sb = await getCloudClient();
      const { data, error } = await sb.from('lessons').select('id,title,video_url,video_type,sync,dialogue,saved_phrases,saved_words,subtitle_text,created_at').eq('user_code', CLOUD_CONFIG.userCode).order('created_at', { ascending:false });
      if (error) throw error;
      state.cloudLessons = data || [];
      $('savedBody').innerHTML = `<div class="saved-item cloud-tools"><b>Saved items sync</b><p>${escapeHtml(cloudSyncLabel())}</p><div class="saved-actions"><button class="small-btn" data-sync-saved-cloud>Sync saved now</button><button class="small-btn" data-load-saved-cloud>Load saved</button></div><small>Words, phrases, saved lines, translations, context, and review progress are stored in Supabase user_library.</small></div>` + (state.cloudLessons.length ? state.cloudLessons.map((l,i)=>`<div class="saved-item cloud-lesson"><b>${escapeHtml(l.title || 'Untitled')}</b><p dir="ltr">${escapeHtml(l.video_url || 'No video link')}</p><small>${new Date(l.created_at).toLocaleString()} • ${Array.isArray(l.dialogue) ? l.dialogue.length : 0} lines</small><div class="saved-actions"><button class="small-btn" data-cloud-load="${i}">Open</button><button class="small-btn" data-cloud-edit="${i}">Edit</button><button class="small-btn danger" data-cloud-delete="${i}">Delete</button></div></div>`).join('') : '<p>No cloud lessons yet.</p>');
    } catch (e) { console.error(e); $('savedBody').innerHTML = '<p>Cloud load failed.</p>'; }
  }


  function pickSubtitleTextFile() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.srt,.txt,.html,.htm';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => resolve(null);
        r.readAsText(file);
      };
      input.click();
    });
  }

  async function editCloudLesson(i) {
    const lesson = state.cloudLessons[Number(i)]; if (!lesson) return;
    const title = prompt('Lesson title:', lesson.title || 'Untitled');
    if (title === null) return;
    const videoUrl = prompt('Video link / URL:', lesson.video_url || '');
    if (videoUrl === null) return;
    let sync = prompt('Sync offset seconds:', String(Number(lesson.sync || 0)));
    if (sync === null) return;
    sync = Number(sync || 0);

    let dialogue = Array.isArray(lesson.dialogue) ? lesson.dialogue : [];
    let subtitleText = lesson.subtitle_text || '';
    if (confirm('Do you want to replace this lesson subtitles with a new SRT/HTML file?')) {
      const text = await pickSubtitleTextFile();
      if (text) {
        const lower = text.toLowerCase();
        dialogue = (lower.includes('<table') || lower.includes('<tr')) ? parseHtmlTable(text) : parseSrt(text);
        subtitleText = text;
      } else {
        toast('No subtitle file selected');
      }
    }

    try {
      const sb = await getCloudClient();
      const payload = { title: title || 'Untitled', video_url: videoUrl || '', sync, dialogue, subtitle_text: subtitleText };
      const { error } = await sb.from('lessons').update(payload).eq('id', lesson.id).eq('user_code', CLOUD_CONFIG.userCode);
      if (error) throw error;
      toast('Cloud lesson updated');
      await showCloudLibrary();
    } catch (e) { console.error(e); alert('Cloud edit failed: ' + (e.message || e)); }
  }

  async function deleteCloudLesson(i) {
    const lesson = state.cloudLessons[Number(i)]; if (!lesson) return;
    if (!confirm(`Delete lesson "${lesson.title || 'Untitled'}" from cloud?`)) return;
    try {
      const sb = await getCloudClient();
      const { error } = await sb.from('lessons').delete().eq('id', lesson.id).eq('user_code', CLOUD_CONFIG.userCode);
      if (error) throw error;
      toast('Cloud lesson deleted');
      await showCloudLibrary();
    } catch (e) { console.error(e); alert('Cloud delete failed: ' + (e.message || e)); }
  }

  async function loadCloudLesson(i) {
    const lesson = state.cloudLessons[Number(i)]; if (!lesson) return;
    state.subtitles = Array.isArray(lesson.dialogue) ? lesson.dialogue.filter(x => !shouldIgnoreSubtitle(x.en)).map(x => ({...x, time: x.time || formatTime(x.startTime)})) : [];
    state.savedLines = Array.isArray(lesson.saved_phrases) ? lesson.saved_phrases.map(normalizeSavedLine) : state.savedLines;
    state.savedWords = Array.isArray(lesson.saved_words) ? lesson.saved_words.filter(x => !isHiddenCloudSettingsItem(x)).map(normalizeSavedWord).filter(x => x.word) : state.savedWords;
    state.offset = Number(lesson.sync || 0); state.activeIndex = -1; state.lastIndex = -1; state.listCenter = 0; state.videoUrl = lesson.video_url || '';
    saveState(); scheduleCloudLibrarySync(); updateControls(); renderList(0); closeModal('savedModal');
    if (state.videoUrl) await loadUrl(state.videoUrl);
    toast('Lesson restored');
  }

  // ════════════════════════════════════════════════════════════════
  // SPEAKING COACH — shadow & reply practice with pronunciation analysis
  //
  // Flow: listen (TTS or scene clip) → record your reply (Web Speech API)
  //       → analysis (word-diff, speaking pace, Puter AI feedback).
  //
  // Two modes:
  //   echo  — repeat the exact scene line. We word-diff your transcript
  //           against the target and highlight the words you stumbled on,
  //           and compare your pace to the scene's original pace.
  //   reply — answer in your own words. There's no fixed target, so Puter AI
  //           judges whether your reply fits and conveys a natural meaning.
  //
  // Honest limit: the browser Speech API returns a transcript + an overall
  // confidence, NOT phoneme-level scoring. "Pronunciation" feedback is
  // inferred from which words were misheard + the confidence + Puter AI's
  // read of the transcript. It's a practical guide, not a phonetics lab.
  // ════════════════════════════════════════════════════════════════

  function speechRecognitionSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // Start one capture turn. Resolves with { transcript, confidence, durationMs, words }.
  // onInterim(text) is called with the live partial transcript while speaking.
  function startSpeechCapture({ lang = 'en-US', onInterim } = {}) {
    return new Promise((resolve, reject) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { reject(new Error('unsupported')); return; }
      const rec = new SR();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;

      let finalText = '';
      let bestConfidence = 0;
      let startedAt = 0;
      let endedAt = 0;
      let settled = false;
      state.speakRecognition = rec;

      rec.onaudiostart = () => { startedAt = performance.now(); };
      rec.onspeechend = () => { endedAt = performance.now(); };
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) {
            finalText += res[0].transcript + ' ';
            if (typeof res[0].confidence === 'number' && res[0].confidence > 0) {
              bestConfidence = Math.max(bestConfidence, res[0].confidence);
            }
          } else {
            interim += res[0].transcript;
          }
        }
        if (onInterim) onInterim((finalText + ' ' + interim).trim());
      };
      rec.onerror = (e) => {
        if (settled) return;
        settled = true;
        state.speakRecognition = null;
        reject(new Error(e.error || 'speech-error'));
      };
      rec.onend = () => {
        if (settled) return;
        settled = true;
        state.speakRecognition = null;
        if (!startedAt) startedAt = performance.now();
        if (!endedAt) endedAt = performance.now();
        const transcript = cleanLine(finalText);
        const words = tokenize(transcript);
        resolve({
          transcript,
          confidence: bestConfidence,
          durationMs: Math.max(0, endedAt - startedAt),
          words
        });
      };

      try { rec.start(); } catch (err) { settled = true; state.speakRecognition = null; reject(err); }
    });
  }

  function stopSpeechCapture() {
    try { state.speakRecognition?.stop(); } catch {}
  }

  // LCS-based alignment: marks each TARGET word as 'match' or 'miss' relative
  // to what the learner actually said.
  function alignWords(targetWords, saidWords) {
    const a = targetWords.map(w => normalizeAnswer(w));
    const b = saidWords.map(w => normalizeAnswer(w));
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const marks = targetWords.map(w => ({ word: w, status: 'miss' }));
    let i = 0, j = 0, matched = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { marks[i].status = 'match'; matched++; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return { marks, matched, total: n };
  }

  function computeWpm(wordCount, durationMs) {
    const mins = durationMs / 60000;
    if (mins <= 0) return 0;
    return Math.round(wordCount / mins);
  }

  function scenePaceWpm(item) {
    if (!item) return 0;
    const dur = (Number(item.endTime) || 0) - (Number(item.startTime) || 0);
    const words = tokenize(item.en).length;
    if (dur <= 0 || !words) return 0;
    return Math.round(words / (dur / 60));
  }

  function playClipOnce(item) {
    if (!item || !state.videoUrl || state.playerType === 'none') { toast('No video clip — using voice'); speakText(cleanLine(item?.en || '')); return; }
    const dur = Math.max(0.4, (Number(item.endTime) || 0) - (Number(item.startTime) || 0));
    seekMedia(item.startTime, true);
    clearTimeout(state.speakClipTimer);
    state.speakClipTimer = setTimeout(() => pauseMedia(), (dur * 1000) / (state.speed || 1) + 180);
  }

  function buildSpeakingPrompt(ctx) {
    const { mode, characterLine, target, transcript, wpm, scenePace, confidence, accuracy, missedWords } = ctx;
    const common = `You are a friendly English speaking coach for an Egyptian Arabic-speaking learner.
The learner is practicing speaking by responding to a movie scene line.

SCENE LINE (what the character said):
"${characterLine}"

WHAT THE LEARNER SAID (auto-transcribed from their voice, may contain small recognition errors):
"${transcript || '(nothing was captured)'}"

MEASUREMENTS:
- Speaking pace: ${wpm} words/min${scenePace ? ` (scene pace was about ${scenePace} words/min)` : ''}
- Recognition confidence: ${Math.round((confidence || 0) * 100)}%
${mode === 'echo' ? `- Target line to repeat: "${target}"\n- Word accuracy vs target: ${Math.round((accuracy || 0) * 100)}%\n- Words likely stumbled: ${missedWords && missedWords.length ? missedWords.join(', ') : 'none'}` : ''}`;

    if (mode === 'echo') {
      return `${common}

TASK: The learner was trying to REPEAT the target line exactly (shadowing).
Judge how close they got, point out the specific words they likely mispronounced or dropped, and give one concrete pronunciation tip.

Return JSON ONLY, no extra text, in exactly this shape:
{
  "score": <integer 0-100 overall>,
  "meaning": "<one short English sentence: how accurate the repetition was>",
  "pronunciation": "<one short English sentence about likely pronunciation issues, naming specific words if any>",
  "fluency": "<one short English sentence about pace and naturalness>",
  "better": "<one improved, natural English sentence the learner could say next time>",
  "ar": "<جملة تشجيع ونصيحة قصيرة بالعربية المصرية الدارجة>"
}`;
    }

    // REPLY MODE — focused on grammar/word-choice CORRECTION so the learner
    // sees exactly what to fix, with the natural replacement word/phrase and a
    // short reason. Empty arrays are fine — only flag real issues.
    return `${common}

TASK: The learner was REPLYING to the scene in their OWN WORDS to convey a sensible meaning. Their reply does NOT need to match the original line.

Be a strict but kind correction coach:
1. Decide whether their reply makes sense as a response to the scene line (give "meaning_match" 0–100).
2. List concrete CORRECTIONS — grammar mistakes, missing articles, wrong tenses, awkward phrasing. For each: the wrong span, the natural fix, and a one-line reason.
3. List specific WORD CHOICES the learner used that have a more natural / idiomatic alternative — e.g. "very big" → "huge". Reason in one short line.
4. Provide one polished version of their reply (corrected_version) preserving their meaning.

Return JSON ONLY, no extra text, in exactly this shape:
{
  "score": <integer 0-100 overall communication score>,
  "meaning_match": <integer 0-100: does the reply fit the scene meaning>,
  "meaning": "<one short English sentence: what their reply conveys vs what fits the scene>",
  "fluency": "<one short English sentence about pace and naturalness>",
  "corrections": [
    {"wrong": "<exact wrong span from learner's reply>", "right": "<natural fix>", "reason": "<short why>"}
  ],
  "word_choices": [
    {"used": "<word the learner used>", "suggested": "<more natural word/phrase>", "why": "<short why>"}
  ],
  "corrected_version": "<the learner's reply rewritten correctly, keeping their meaning>",
  "better": "<one alternative, even more natural way to say it>",
  "ar": "<جملة تشجيع ونصيحة قصيرة بالعربية المصرية الدارجة، تذكر أهم خطأ لو فيه>"
}`;
  }

  async function analyzeSpeakingAttempt(ctx) {
    if (!window.puter?.ai?.chat) throw new Error('Puter AI is not loaded.');
    const prompt = buildSpeakingPrompt(ctx);
    let lastError = null;
    for (const model of PUTER_SUBTITLE_MODELS) {
      try {
        const response = await window.puter.ai.chat(prompt, { model, temperature: 0.3, max_tokens: 500 });
        const parsed = parseJsonLoose(puterResponseToText(response));
        if (parsed && typeof parsed === 'object') {
          const cleanArr = (arr, keys) => Array.isArray(arr)
            ? arr.map(x => {
                const o = {};
                for (const k of keys) o[k] = cleanLine(x?.[k] || '');
                return o;
              }).filter(o => Object.values(o).some(v => v))
            : [];
          return {
            score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
            meaning_match: Number.isFinite(parsed.meaning_match) ? Math.max(0, Math.min(100, parsed.meaning_match)) : null,
            meaning: cleanLine(parsed.meaning || ''),
            pronunciation: cleanLine(parsed.pronunciation || ''),
            fluency: cleanLine(parsed.fluency || ''),
            better: cleanLine(parsed.better || ''),
            ar: cleanLine(parsed.ar || ''),
            corrections: cleanArr(parsed.corrections, ['wrong', 'right', 'reason']),
            word_choices: cleanArr(parsed.word_choices, ['used', 'suggested', 'why']),
            corrected_version: cleanLine(parsed.corrected_version || '')
          };
        }
      } catch (e) { lastError = e; console.warn('Puter speaking analysis failed with model', model, e); }
    }
    throw lastError || new Error('Speaking analysis failed.');
  }

  function openSpeakingCoach(index) {
    const idx = Number(index);
    const item = state.subtitles[idx];
    if (!item) { toast('Pick a subtitle line first'); return; }
    openMenu(false);
    state.speak = {
      index: idx,
      mode: 'echo',
      step: 'intro',     // intro | recording | analyzing | result
      transcript: '',
      interim: '',
      result: null,      // { transcript, confidence, durationMs, words, wpm, accuracy, marks, missedWords }
      analysis: null,
      error: ''
    };
    renderSpeakCoach();
    openModal('speakModal');
  }

  function renderSpeakCoach() {
    const body = $('speakBody');
    const s = state.speak;
    if (!s) return;
    const item = state.subtitles[s.index];
    if (!item) { body.innerHTML = '<p>Line not found.</p>'; return; }
    const en = cleanLine(item.en);
    const ar = item.ar || '';
    const supported = speechRecognitionSupported();

    const modeToggle = `<div class="speak-modes">
      <button class="speak-mode ${s.mode === 'echo' ? 'on' : ''}" data-speak-mode="echo">🪞 Echo<small>repeat the line</small></button>
      <button class="speak-mode ${s.mode === 'reply' ? 'on' : ''}" data-speak-mode="reply">💬 Reply<small>your own words</small></button>
    </div>`;

    const sceneCard = `<div class="speak-scene">
      <div class="speak-scene-label">${s.mode === 'echo' ? 'Repeat this line' : 'Respond to this line'}</div>
      <div class="speak-line-en" dir="ltr">${escapeHtml(en)}</div>
      ${ar ? `<div class="speak-line-ar" dir="rtl">${escapeHtml(ar)}</div>` : ''}
      <div class="speak-listen-row">
        <button class="small-btn speak-listen" data-speak-listen="tts">🔊 Hear voice</button>
        <button class="small-btn speak-listen" data-speak-listen="clip">▶ Play scene clip</button>
      </div>
    </div>`;

    let stepHtml = '';
    if (s.step === 'intro') {
      if (supported) {
        stepHtml = `<div class="speak-record-area">
          <button class="mic-big" data-speak-record><span class="mic-ic">🎙️</span><span>Tap &amp; speak ${s.mode === 'echo' ? 'the line' : 'your reply'}</span></button>
          <p class="hint-small">Allow microphone access when asked. Speak clearly, then pause — it stops automatically.</p>
        </div>`;
      } else {
        stepHtml = `<div class="speak-record-area">
          <p class="hint-small">⚠️ Your browser doesn't support voice capture. Use Chrome/Edge for full pronunciation analysis, or type what you'd say below for meaning feedback.</p>
          <textarea class="answer-input speak-typed" rows="2" dir="ltr" placeholder="Type what you would say…" data-speak-typed></textarea>
          <button class="full-btn" data-speak-analyze-typed>Analyze meaning</button>
        </div>`;
      }
    } else if (s.step === 'recording') {
      stepHtml = `<div class="speak-record-area recording">
        <button class="mic-big rec" data-speak-stop><span class="mic-ic pulse">🔴</span><span>Listening… tap to stop</span></button>
        <div class="speak-interim" dir="ltr">${escapeHtml(s.interim || '…')}</div>
      </div>`;
    } else if (s.step === 'analyzing') {
      stepHtml = `<div class="speak-record-area"><div class="speak-spinner">🧠 Puter AI is analyzing your speaking…</div></div>`;
    } else if (s.step === 'result') {
      stepHtml = renderSpeakResult(item);
    }

    body.innerHTML = `${modeToggle}${sceneCard}${s.error ? `<div class="speak-error">${escapeHtml(s.error)}</div>` : ''}${stepHtml}`;
    bindSpeakControls();
  }

  function renderSpeakResult(item) {
    const s = state.speak;
    const r = s.result || {};
    const a = s.analysis;
    const scene = scenePaceWpm(item);

    // Transcript with per-word diff for echo mode.
    let transcriptHtml;
    if (s.mode === 'echo' && r.marks) {
      const diff = r.marks.map(m => `<span class="dw ${m.status}">${escapeHtml(m.word)}</span>`).join(' ');
      transcriptHtml = `<div class="speak-diff" dir="ltr">${diff}</div>
        <div class="speak-said" dir="ltr"><b>You said:</b> ${escapeHtml(r.transcript || '—')}</div>`;
    } else {
      transcriptHtml = `<div class="speak-said" dir="ltr"><b>You said:</b> ${escapeHtml(r.transcript || '—')}</div>`;
    }

    // Pace comparison.
    const paceClass = (() => {
      if (!scene || !r.wpm) return '';
      const ratio = r.wpm / scene;
      if (ratio < 0.7) return 'slow';
      if (ratio > 1.4) return 'fast';
      return 'good';
    })();
    const paceLabel = paceClass === 'slow' ? 'A bit slow' : paceClass === 'fast' ? 'A bit fast' : paceClass === 'good' ? 'Natural pace' : '';

    const metrics = `<div class="speak-metrics">
      ${s.mode === 'echo' && typeof r.accuracy === 'number' ? `<div class="sm-chip"><b>${Math.round(r.accuracy * 100)}%</b><span>word accuracy</span></div>` : ''}
      <div class="sm-chip"><b>${r.wpm || 0}</b><span>your pace (wpm)</span></div>
      ${scene ? `<div class="sm-chip ${paceClass}"><b>${scene}</b><span>scene pace${paceLabel ? ' · ' + paceLabel : ''}</span></div>` : ''}
      ${typeof r.confidence === 'number' ? `<div class="sm-chip"><b>${Math.round(r.confidence * 100)}%</b><span>clarity</span></div>` : ''}
    </div>`;

    const score = a ? `<div class="speak-score">
        <svg viewBox="0 0 36 36" class="score-ring"><path class="ring-bg" d="M18 2.5a15.5 15.5 0 1 1 0 31 15.5 15.5 0 0 1 0-31"/><path class="ring-fg" stroke-dasharray="${(a.score / 100) * 97.4}, 97.4" d="M18 2.5a15.5 15.5 0 1 1 0 31 15.5 15.5 0 0 1 0-31"/></svg>
        <div class="score-num">${a.score}<small>/100</small></div>
      </div>` : '';

    // Reply mode gets dedicated correction blocks: a meaning-fit chip, a
    // wrong→right list, a word-choice list, and the corrected version of
    // exactly what the learner said (with a 🔊 button).
    const correctionsHtml = (s.mode === 'reply' && a && a.corrections?.length) ? `
      <div class="an-card corrections"><b>✏️ Corrections</b>
        ${a.corrections.map(c => `<div class="corr-row">
          <div class="corr-line"><span class="corr-wrong" dir="ltr">${escapeHtml(c.wrong)}</span><span class="corr-arrow">→</span><span class="corr-right" dir="ltr">${escapeHtml(c.right)}</span>${c.right ? `<button class="ex-speak" data-speak-ex="${escapeHtml(c.right)}" title="Speak">🔊</button>` : ''}</div>
          ${c.reason ? `<div class="corr-reason" dir="ltr">${escapeHtml(c.reason)}</div>` : ''}
        </div>`).join('')}
      </div>` : '';
    const wordChoicesHtml = (s.mode === 'reply' && a && a.word_choices?.length) ? `
      <div class="an-card wordchoices"><b>🎨 Word choices</b>
        ${a.word_choices.map(w => `<div class="corr-row">
          <div class="corr-line"><span class="corr-wrong" dir="ltr">${escapeHtml(w.used)}</span><span class="corr-arrow">→</span><span class="corr-right" dir="ltr">${escapeHtml(w.suggested)}</span>${w.suggested ? `<button class="ex-speak" data-speak-ex="${escapeHtml(w.suggested)}" title="Speak">🔊</button>` : ''}</div>
          ${w.why ? `<div class="corr-reason" dir="ltr">${escapeHtml(w.why)}</div>` : ''}
        </div>`).join('')}
      </div>` : '';
    const correctedVer = (s.mode === 'reply' && a && a.corrected_version) ? `
      <div class="an-card corrected"><b>📝 Your reply, corrected</b>
        <p dir="ltr">${escapeHtml(a.corrected_version)}</p>
        <button class="small-btn speak-listen" data-speak-say="${escapeHtml(a.corrected_version)}">🔊</button>
      </div>` : '';
    const meaningMatch = (s.mode === 'reply' && a && typeof a.meaning_match === 'number') ? `
      <div class="an-card mmatch"><b>🎯 Meaning fit</b><p dir="ltr">Your reply matches the scene meaning <b>${a.meaning_match}%</b>.</p></div>` : '';

    const cards = a ? `<div class="speak-analysis">
      ${meaningMatch}
      ${a.meaning ? `<div class="an-card meaning"><b>🎯 Meaning</b><p dir="ltr">${escapeHtml(a.meaning)}</p></div>` : ''}
      ${correctionsHtml}
      ${wordChoicesHtml}
      ${correctedVer}
      ${a.pronunciation ? `<div class="an-card pron"><b>🗣️ Pronunciation</b><p dir="ltr">${escapeHtml(a.pronunciation)}</p></div>` : ''}
      ${a.fluency ? `<div class="an-card flu"><b>🌊 Fluency</b><p dir="ltr">${escapeHtml(a.fluency)}</p></div>` : ''}
      ${a.better ? `<div class="an-card better"><b>✨ Try saying</b><p dir="ltr">${escapeHtml(a.better)}</p><button class="small-btn speak-listen" data-speak-say="${escapeHtml(a.better)}">🔊</button></div>` : ''}
      ${a.ar ? `<div class="an-card ar"><b>💪 نصيحة</b><p dir="rtl">${escapeHtml(a.ar)}</p></div>` : ''}
    </div>` : (s.analysisError ? `<div class="speak-error">${escapeHtml(s.analysisError)}</div>` : '');

    return `<div class="speak-result">
      ${score}
      ${metrics}
      ${transcriptHtml}
      ${cards}
      <div class="speak-result-actions">
        <button class="small-btn" data-speak-retry>🔁 Try again</button>
        <button class="small-btn primary-pill" data-speak-next>➡ Next line</button>
      </div>
    </div>`;
  }

  function bindSpeakControls() {
    const body = $('speakBody');
    if (!body) return;
    const s = state.speak;

    body.querySelectorAll('[data-speak-mode]').forEach(b => b.onclick = () => {
      s.mode = b.dataset.speakMode; s.step = 'intro'; s.result = null; s.analysis = null; s.error = ''; renderSpeakCoach();
    });
    body.querySelectorAll('[data-speak-listen]').forEach(b => b.onclick = () => {
      const item = state.subtitles[s.index];
      if (b.dataset.speakListen === 'clip') playClipOnce(item);
      else speakText(cleanLine(item.en));
    });
    body.querySelectorAll('[data-speak-say]').forEach(b => b.onclick = () => speakText(b.dataset.speakSay));

    const recBtn = body.querySelector('[data-speak-record]');
    if (recBtn) recBtn.onclick = () => startSpeakRecording();
    const stopBtn = body.querySelector('[data-speak-stop]');
    if (stopBtn) stopBtn.onclick = () => stopSpeechCapture();

    const analyzeTyped = body.querySelector('[data-speak-analyze-typed]');
    if (analyzeTyped) analyzeTyped.onclick = () => {
      const typed = body.querySelector('[data-speak-typed]')?.value || '';
      if (!cleanLine(typed)) { toast('Type something first'); return; }
      runSpeakAnalysis({ transcript: cleanLine(typed), confidence: 0, durationMs: 0, words: tokenize(typed) });
    };

    const retry = body.querySelector('[data-speak-retry]');
    if (retry) retry.onclick = () => { s.step = 'intro'; s.result = null; s.analysis = null; s.error = ''; renderSpeakCoach(); };
    const next = body.querySelector('[data-speak-next]');
    if (next) next.onclick = () => {
      const ni = Math.min(state.subtitles.length - 1, s.index + 1);
      openSpeakingCoach(ni);
    };
  }

  async function startSpeakRecording() {
    const s = state.speak;
    s.step = 'recording'; s.interim = ''; s.error = '';
    renderSpeakCoach();
    try {
      const capture = await startSpeechCapture({
        onInterim: (text) => { s.interim = text; const live = $('speakBody')?.querySelector('.speak-interim'); if (live) live.textContent = text || '…'; }
      });
      if (!capture.transcript) {
        s.step = 'intro'; s.error = "Didn't catch that — try again, a bit louder."; renderSpeakCoach(); return;
      }
      runSpeakAnalysis(capture);
    } catch (e) {
      s.step = 'intro';
      s.error = e.message === 'not-allowed'
        ? 'Microphone blocked. Allow mic access in your browser settings and retry.'
        : e.message === 'no-speech'
          ? "Didn't hear anything — try again."
          : 'Voice capture failed: ' + (e.message || e);
      renderSpeakCoach();
    }
  }

  async function runSpeakAnalysis(capture) {
    const s = state.speak;
    const item = state.subtitles[s.index];
    const target = cleanLine(item.en);
    const targetWords = tokenize(target);
    const wpm = computeWpm(capture.words.length, capture.durationMs);

    let accuracy, marks, missedWords;
    if (s.mode === 'echo') {
      const al = alignWords(targetWords, capture.words);
      marks = al.marks;
      accuracy = al.total ? al.matched / al.total : 0;
      missedWords = al.marks.filter(m => m.status === 'miss').map(m => m.word);
    }

    s.result = { ...capture, wpm, accuracy, marks, missedWords };
    s.step = 'analyzing';
    s.analysis = null;
    s.analysisError = '';
    renderSpeakCoach();

    try {
      s.analysis = await analyzeSpeakingAttempt({
        mode: s.mode,
        characterLine: target,
        target,
        transcript: capture.transcript,
        wpm,
        scenePace: scenePaceWpm(item),
        confidence: capture.confidence,
        accuracy,
        missedWords
      });
    } catch (e) {
      s.analysisError = 'AI analysis unavailable: ' + (e.message || e) + '. Your pace & word accuracy above are still valid.';
    }
    s.step = 'result';
    renderSpeakCoach();
  }

  // ════════════════════════════════════════════════════════════════
  // DIALOGUE PRACTICE — context-weaving saved vocab into natural dialogue
  //
  // The user picks any subset of saved words/phrases/lines, optionally types
  // a situation ("at a café"), chooses an AI provider, and the model writes
  // a short natural daily-life dialogue weaving in every selected term, plus
  // an Egyptian-Arabic translation per line. The goal is contextual recall:
  // hearing the words embedded in connected speech makes them stick without
  // active effort during real conversations.
  //
  // History is kept in localStorage so the user can replay previous dialogues
  // without burning AI quota again.
  // ════════════════════════════════════════════════════════════════

  const DIALOGUE_HISTORY_KEY = 'jm_dialogues';
  const DIALOGUE_HISTORY_MAX = 30;

  function dialogueHistory() {
    return readJSON(DIALOGUE_HISTORY_KEY, []);
  }
  function saveDialogueToHistory(entry) {
    const list = dialogueHistory();
    list.unshift(entry);
    while (list.length > DIALOGUE_HISTORY_MAX) list.pop();
    writeJSON(DIALOGUE_HISTORY_KEY, list);
  }
  function deleteDialogueFromHistory(id) {
    writeJSON(DIALOGUE_HISTORY_KEY, dialogueHistory().filter(d => d.id !== id));
  }

  function buildDialoguePrompt(items, opts) {
    const situation = cleanLine(opts.situation || '');
    const length = opts.length || 'short';   // short | medium | long
    const turns = length === 'long' ? '10-12' : (length === 'medium' ? '6-8' : '4-6');
    const list = items.map((it, i) => `${i + 1}. "${cleanLine(it.term)}"${it.ar ? ` (= ${it.ar})` : ''}`).join('\n');
    const fillersBlock = opts.naturalFillers
      ? `- Sprinkle SPARINGLY (max 1 per 3 turns) natural conversational fillers and reactions IN-TEXT so any TTS reads them aloud:
    • Hesitation: "uh", "um", "hmm", "well…"
    • Reactions: "oh!", "wow", "really?", "huh"
    • Laughter: write "haha", "hehe" (no asterisks, no brackets — plain text only).
    • Surprise/sigh: write "oh my", "ugh", "ahh".
  Use them where a real speaker WOULD naturally hesitate or react. Never break the meaning. Do NOT use SSML, brackets, or asterisks — plain text only so every voice engine reads them.`
      : `- Keep speech clean and direct. No filler words or interjections.`;
    return `You are writing a short, realistic English dialogue that sounds like native everyday speech — the kind of lines you'd hear in a movie, a TV show, or a real conversation.

TARGET TERMS the learner wants to practice:
${list}

CORE PRINCIPLES — follow strictly:
1. The target terms must be used NATURALLY and ONLY when they fit the context.
2. Never force a target term into a sentence just to make it appear.
3. If a term feels unnatural in the situation you started with, CHANGE THE SITUATION to one where natives would actually use it.
4. Prioritize natural conversation over vocabulary coverage. If covering every term ruins authenticity, prefer authenticity — but try hard to cover them all by picking the right situation first.
5. Each line should sound like something a real person would actually say in daily life.
6. Avoid textbook-style sentences and obvious vocabulary drills.
7. Do not write anything a native speaker would find strange or awkward.
8. If a target term is rare, formal, technical, or literary — pick the kind of context where natives WOULD use it (work meeting, news, dramatic moment) instead of pretending it's casual.
9. Don't repeat any target term unnecessarily.
10. The dialogue should feel authentic, spontaneous, conversational.
11. PREFER words and phrases native speakers actually use in everyday conversation (movies, casual chat). The dialogue around the target terms must use the most common everyday wording, not formal vocabulary.
12. If a TARGET term itself is FORMAL, OUTDATED, or RARE in daily speech, include that target in a context where natives WOULD use it AND in its target_notes entry fill the "alt" field with a more common alternative that natives normally say instead (e.g. for "endeavor" → "try"; for "purchase" → "buy"). For common conversational targets leave "alt" empty.

PROCESS for each target term: first decide HOW native speakers actually use it, then build a situation around that usage, then write the line.

FORMAT REQUIREMENTS:
- ${turns} turns total, alternating A / B / A / B.
- Use contractions and natural connectors ("yeah, well, actually, by the way, look…").
- Use the natural inflected form when needed (e.g. "recommended" not bare "recommend").
${fillersBlock}
- Situation: ${situation || "you pick — choose the most believable everyday context for these particular terms (café, work chat, calling a friend, planning a trip, asking for advice, dating, family dinner, dramatic news, etc.)"}
- For EACH line, an EGYPTIAN COLLOQUIAL ARABIC translation (المصرية الدارجة) — friendly, not formal MSA, no transliteration. Translate the meaning naturally; you don't need to keep fillers if they sound awkward in Arabic.
- Keep each line short enough to say in one breath.

Also produce one short ARABIC note PER target term explaining WHY that term sounds natural in the situation you built (one sentence, دارجة).

Return JSON ONLY in this exact shape:
{
  "situation": "<one short English sentence describing the setting>",
  "situation_ar": "<same setting in Egyptian Arabic>",
  "turns": [
    {"speaker": "A", "en": "...", "ar": "..."},
    {"speaker": "B", "en": "...", "ar": "..."}
  ],
  "target_notes": [
    {"term": "<one of the target terms>", "note": "<short Arabic note explaining why it fits naturally here>", "alt": "<more common everyday English alternative if the target is formal/rare, otherwise empty string>"}
  ]
}`;
  }

  async function generateDialoguePuter(items, opts) {
    if (!window.puter?.ai?.chat) throw new Error('Puter AI is not loaded.');
    const prompt = buildDialoguePrompt(items, opts);
    let lastError = null;
    for (const model of PUTER_SUBTITLE_MODELS) {
      try {
        const resp = await window.puter.ai.chat(prompt, { model, temperature: 0.55, max_tokens: 1400 });
        const parsed = parseJsonLoose(puterResponseToText(resp));
        if (parsed && Array.isArray(parsed.turns) && parsed.turns.length) return parsed;
      } catch (e) { lastError = e; console.warn('Puter dialogue failed with model', model, e); }
    }
    throw lastError || new Error('Puter dialogue generation failed.');
  }

  async function generateDialogueOpenRouter(items, opts) {
    const cfg = getOpenRouterConfig();
    if (!cfg.apiKey) throw new Error('Add an OpenRouter key first (Menu → Settings → OpenRouter).');
    const prompt = buildDialoguePrompt(items, opts);
    const parsed = await callOpenRouterJson(prompt, {
      temperature: 0.55,
      maxTokens: 1400,
      system: 'You write natural daily-life English dialogues with Egyptian Arabic translations. Return JSON only.'
    });
    if (parsed && Array.isArray(parsed.turns) && parsed.turns.length) return parsed;
    throw new Error('OpenRouter returned no dialogue.');
  }

  async function generateDialogue(items, opts) {
    if (opts.provider === 'openrouter') {
      try { return await generateDialogueOpenRouter(items, opts); }
      catch (e) {
        console.warn('OpenRouter dialogue unavailable, trying Puter:', e);
        return await generateDialoguePuter(items, opts);
      }
    }
    try { return await generateDialoguePuter(items, opts); }
    catch (e) {
      const cfg = getOpenRouterConfig();
      if (cfg.apiKey) { console.warn('Puter failed, trying OpenRouter:', e); return await generateDialogueOpenRouter(items, opts); }
      throw e;
    }
  }

  // ───────── Dialogue Practice picker UI ─────────

  function dialogueAvailableItems() {
    // Flatten saved words/phrases + saved lines into one list with kind+term+ar.
    initLocalVocab();
    const out = [];
    for (const w of (state.savedWords || [])) {
      if (!w.word) continue;
      out.push({ id: 'w:' + (w.key || wordKey(w.word)), kind: w.kind || 'word', term: w.word, ar: w.ar || '' });
    }
    for (const l of (state.savedLines || [])) {
      if (!l.en) continue;
      out.push({ id: 'l:' + (l.key || ''), kind: 'line', term: cleanLine(l.en), ar: cleanLine(l.ar || '') });
    }
    return out;
  }

  function ensureDialogueState(reset = false) {
    if (reset || !state.dialogue) {
      const ttsCfg = getTtsSettings();
      const voiceA = ttsCfg.voice;
      const voiceB = pickContrastingVoice(ttsCfg.provider, voiceA)?.id || voiceA;
      state.dialogue = {
        step: 'picker',            // picker | generating | result | history
        selectedIds: new Set(),
        filterKind: 'all',         // all | word | phrase | line
        search: '',
        situation: '',
        length: 'short',
        provider: 'puter',
        // Per-speaker voices + speech rate + interjection toggle. Voices are
        // restricted to the current TTS engine's pool in the picker UI.
        voiceA,
        voiceB,
        rate: 0.95,
        naturalFillers: true,
        result: null,
        error: ''
      };
    }
    return state.dialogue;
  }

  function openDialoguePractice() {
    openMenu(false);
    ensureDialogueState(true);
    renderDialogue();
    openModal('dialogueModal');
  }

  function renderDialogue() {
    const s = state.dialogue;
    const body = $('dialogueBody');
    if (!body || !s) return;
    if (s.step === 'picker')     return renderDialoguePicker(body);
    if (s.step === 'generating') return renderDialogueGenerating(body);
    if (s.step === 'result')     return renderDialogueResult(body);
    if (s.step === 'history')    return renderDialogueHistory(body);
  }

  // Compact A/B voice button. Shows speaker letter + voice short label,
  // tap to cycle within the current engine's pool, long-press not needed.
  function renderDialogueVoiceBtn(speaker, voiceId) {
    const cfg = getTtsSettings();
    const v = TTS_VOICE_OPTIONS.find(x => x.id === voiceId && x.engine === cfg.provider)
           || TTS_VOICE_OPTIONS.find(x => x.engine === cfg.provider)
           || TTS_VOICE_OPTIONS[0];
    const label = v ? v.label.replace(/ \([FM][^)]*\)$/, '') : voiceId;
    const colorClass = speaker === 'A' ? 'd-vox-a' : 'd-vox-b';
    return `<button class="d-vox ${colorClass}" data-d-voice-cycle="${speaker}">
      <span class="d-vox-spkr">${speaker}</span>
      <span class="d-vox-name">${escapeHtml(label)}</span>
      <span class="d-vox-test" data-d-voice-test="${speaker}" title="Preview">🔊</span>
    </button>`;
  }

  // ───── Autocomplete suggestions ─────
  // Top-5 best matches that are NOT already selected. Ranks by:
  //  1. Term starts with the query  (highest)
  //  2. Term contains the query at a word boundary
  //  3. Term contains the query anywhere
  // Falls back to most-recently-saved.
  function dialogueSuggestions(q, limit = 5) {
    const s = state.dialogue;
    const items = dialogueAvailableItems().filter(it => !s.selectedIds.has(it.id));
    if (!q) return items.slice(0, limit);
    const ql = q.toLowerCase();
    const score = (it) => {
      const t = it.term.toLowerCase();
      if (t.startsWith(ql)) return 100 - Math.abs(t.length - ql.length);
      if (new RegExp(`\\b${ql.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`).test(t)) return 60;
      if (t.includes(ql)) return 30;
      if ((it.ar || '').includes(q)) return 15;
      return 0;
    };
    return items
      .map(it => ({ it, s: score(it) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(x => x.it);
  }

  function renderDialogueSuggest() {
    const wrap = $('dSuggest');
    if (!wrap) return;
    const input = $('dSearch');
    const focused = input && document.activeElement === input;
    const s = state.dialogue;
    const q = (s.search || '').trim();
    // Show the panel when the input is focused. With no query we suggest the
    // most-recently-saved items; with a query we suggest matches.
    if (!focused) { wrap.classList.add('hidden'); return; }
    const list = dialogueSuggestions(q, 6);
    if (!list.length) {
      wrap.classList.remove('hidden');
      wrap.innerHTML = `<div class="d-sugg-empty">No matches in your saved items.</div>`;
      return;
    }
    if (typeof s.suggestIdx !== 'number' || s.suggestIdx < 0 || s.suggestIdx >= list.length) s.suggestIdx = -1;
    wrap.classList.remove('hidden');
    wrap.innerHTML = list.map((it, i) => `<button class="d-sugg-item${i===s.suggestIdx?' on':''}" data-d-sugg-add="${escapeHtml(it.id)}" tabindex="-1">
      <span class="d-kind d-kind-${it.kind}">${it.kind==='line'?'📜':(it.kind==='phrase'?'💬':(it.kind==='template'?'📐':'🔤'))}</span>
      <span class="d-sugg-term" dir="ltr">${escapeHtml(it.term.slice(0,50))}</span>
      ${it.ar ? `<span class="d-sugg-ar" dir="rtl">${escapeHtml(it.ar.slice(0,28))}</span>` : ''}
      <span class="d-sugg-add">+</span>
    </button>`).join('');
  }

  // Keyboard handlers on the search input: ↑/↓ to move, Enter to add, Esc clears.
  function handleDialogueSearchKeydown(e) {
    const s = state.dialogue;
    const list = dialogueSuggestions(s.search, 6);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      s.suggestIdx = list.length ? (s.suggestIdx + 1) % list.length : -1;
      renderDialogueSuggest();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      s.suggestIdx = list.length ? (s.suggestIdx <= 0 ? list.length - 1 : s.suggestIdx - 1) : -1;
      renderDialogueSuggest();
    } else if (e.key === 'Enter') {
      if (s.suggestIdx >= 0 && list[s.suggestIdx]) {
        e.preventDefault();
        addDialogueSuggestion(list[s.suggestIdx].id, /*clearSearch*/ true);
      }
    } else if (e.key === 'Escape') {
      if (s.search) { s.search = ''; e.target.value = ''; s.suggestIdx = -1; renderDialoguePickerMain(); renderDialogueSuggest(); }
      else { e.target.blur(); }
    }
  }

  // Adds a suggestion to the selection while KEEPING the search input focused
  // so the user can type the next term immediately.
  function addDialogueSuggestion(id, clearSearch) {
    const s = state.dialogue;
    s.selectedIds.add(id);
    if (clearSearch) { s.search = ''; const input = $('dSearch'); if (input) input.value = ''; }
    s.suggestIdx = -1;
    renderDialoguePickerMain();
    renderDialogueSuggest();
    const input = $('dSearch'); if (input) input.focus();
  }

  // SHELL renderer — builds the search input + filters + main wrapper ONCE.
  // The search <input> never gets destroyed by subsequent renders, so typing
  // keeps focus and the caret stays put naturally.
  function renderDialoguePicker(body) {
    const s = state.dialogue;
    body.innerHTML = `
      <div class="d-toolbar">
        <div class="d-search-wrap">
          <input id="dSearch" class="text-input d-search" type="search" placeholder="🔎 Search saved items…" autocomplete="off" />
          <div id="dSuggest" class="d-suggest hidden"></div>
        </div>
        <div id="dFilters" class="d-filters"></div>
      </div>
      <div id="dPickerMain"></div>
    `;
    const input = body.querySelector('#dSearch');
    input.value = s.search || '';
    input.addEventListener('input', (e) => {
      s.search = e.target.value;
      s.suggestIdx = -1;
      renderDialoguePickerFilters();
      renderDialoguePickerMain();
      renderDialogueSuggest();
    });
    input.addEventListener('focus', () => renderDialogueSuggest());
    input.addEventListener('blur', () => {
      // Delay so a click on a suggestion fires before the dropdown hides.
      setTimeout(() => { const el = $('dSuggest'); if (el) el.classList.add('hidden'); }, 180);
    });
    input.addEventListener('keydown', handleDialogueSearchKeydown);
    renderDialoguePickerFilters();
    renderDialoguePickerMain();
  }

  // Re-rendered when the user changes filter kind (chip highlight only).
  function renderDialoguePickerFilters() {
    const s = state.dialogue;
    const wrap = $('dFilters');
    if (!wrap) return;
    wrap.innerHTML = ['all','word','phrase','line']
      .map(k => `<button class="d-filter${s.filterKind===k?' on':''}" data-d-filter="${k}">${k==='all'?'All':(k==='word'?'🔤 Words':(k==='phrase'?'💬 Phrases':'📜 Lines'))}</button>`)
      .join('');
  }

  // MAIN renderer — recomputed on filter change, selection toggle, etc.
  // Does NOT touch the search input or its container, so focus is preserved.
  function renderDialoguePickerMain() {
    const s = state.dialogue;
    const main = $('dPickerMain');
    if (!main) return;
    const all = dialogueAvailableItems();
    const q = (s.search || '').toLowerCase();
    const filtered = all.filter(it => {
      if (s.filterKind !== 'all' && it.kind !== s.filterKind) return false;
      if (!q) return true;
      return it.term.toLowerCase().includes(q) || (it.ar || '').includes(q);
    });
    const orRouterReady = !!getOpenRouterConfig().apiKey;

    const items = filtered.length ? filtered.map(it => {
      const checked = s.selectedIds.has(it.id);
      const arShort = it.ar ? ` <span class="d-ar" dir="rtl">${escapeHtml(it.ar.slice(0,40))}</span>` : '';
      return `<label class="d-item ${checked ? 'on' : ''}" data-d-toggle="${escapeHtml(it.id)}">
        <input type="checkbox" ${checked ? 'checked' : ''} />
        <span class="d-kind d-kind-${it.kind}">${it.kind === 'line' ? '📜' : (it.kind === 'phrase' ? '💬' : (it.kind === 'template' ? '📐' : '🔤'))}</span>
        <span class="d-term" dir="ltr">${escapeHtml(it.term.slice(0,60))}</span>${arShort}
      </label>`;
    }).join('') : '<p class="hint-small" style="padding:14px;text-align:center">No saved items match this filter. Save some words / phrases first.</p>';

    const sel = s.selectedIds.size;
    const histCount = dialogueHistory().length;

    main.innerHTML = `
      <div class="d-pick-summary">
        <b>${sel}</b> selected
        ${sel > 0 ? `<button class="small-btn" data-d-clear>Clear</button>` : ''}
        ${histCount > 0 ? `<button class="small-btn" data-d-history>📚 History (${histCount})</button>` : ''}
      </div>
      <div class="d-list">${items}</div>
      <details class="d-options" ${sel > 0 ? 'open' : ''}>
        <summary>⚙️ Dialogue options</summary>
        <label class="d-field">
          <span>Situation (optional)</span>
          <input id="dSituation" class="text-input" dir="ltr" placeholder="e.g. at a coffee shop, calling a friend…" value="${escapeHtml(s.situation)}" />
        </label>
        <div class="d-field">
          <span>Length</span>
          <div class="d-seg">
            ${['short','medium','long'].map(L => `<button class="d-seg-btn${s.length===L?' on':''}" data-d-length="${L}">${L === 'short' ? '4–6 turns' : (L === 'medium' ? '6–8 turns' : '10–12 turns')}</button>`).join('')}
          </div>
        </div>
        <div class="d-field">
          <span>AI engine</span>
          <div class="d-seg">
            <button class="d-seg-btn${s.provider==='puter'?' on':''}" data-d-provider="puter">🎙️ Puter AI<small>free · Egyptian voice</small></button>
            <button class="d-seg-btn${s.provider==='openrouter'?' on':''}${orRouterReady?'':' disabled'}" data-d-provider="openrouter" ${orRouterReady?'':'title="Set an OpenRouter key first"'}>🤖 OpenRouter<small>${orRouterReady ? 'free models' : 'needs key'}</small></button>
          </div>
        </div>

        <div class="d-field">
          <span>Voices (per speaker)</span>
          <div class="d-voice-row">
            ${renderDialogueVoiceBtn('A', s.voiceA)}
            ${renderDialogueVoiceBtn('B', s.voiceB)}
          </div>
          <small class="d-hint">Tap to cycle voices in the active TTS engine. Speaker A vs B get different voices so the conversation sounds real.</small>
        </div>

        <div class="d-field">
          <span>Speaking speed</span>
          <div class="d-seg">
            ${[
              { v: 0.7,  l: '0.7×', sub: 'slow / clear' },
              { v: 0.85, l: '0.85×', sub: 'relaxed' },
              { v: 0.95, l: '0.95×', sub: 'natural' },
              { v: 1.0,  l: '1.0×', sub: 'normal' }
            ].map(o => `<button class="d-seg-btn${Math.abs((s.rate||0.95)-o.v)<0.02?' on':''}" data-d-rate="${o.v}">${o.l}<small>${o.sub}</small></button>`).join('')}
          </div>
        </div>

        <div class="d-field">
          <span>Natural interjections</span>
          <div class="d-seg">
            <button class="d-seg-btn${s.naturalFillers?' on':''}" data-d-fillers="1">😄 On<small>haha / uh / oh / hmm</small></button>
            <button class="d-seg-btn${!s.naturalFillers?' on':''}" data-d-fillers="0">🚫 Off<small>clean speech</small></button>
          </div>
        </div>
      </details>
      <button class="full-btn d-generate" ${sel === 0 ? 'disabled' : ''} data-d-generate>✨ Generate dialogue with ${sel} ${sel === 1 ? 'term' : 'terms'}</button>
    `;
    // Situation input is recreated whenever options re-render, so we attach
    // its listener here every time. (Search lives in the shell — no rewire.)
    const sit = main.querySelector('#dSituation');
    if (sit) sit.oninput = (e) => { s.situation = e.target.value; };
  }

  function renderDialogueGenerating(body) {
    const s = state.dialogue;
    body.innerHTML = `<div class="d-generating">
      <div class="d-spin">🧠</div>
      <p><b>${s.provider === 'openrouter' ? 'OpenRouter' : 'Puter AI'} is writing your dialogue…</b></p>
      <p class="hint-small">Weaving ${s.selectedIds.size} term${s.selectedIds.size === 1 ? '' : 's'} into a natural conversation.</p>
      <button class="small-btn" data-d-back>← Back to picker</button>
    </div>`;
  }

  function highlightTargetsInLine(en, terms) {
    let html = escapeHtml(en);
    // Highlight longest terms first so multi-word phrases match before their components.
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    for (const t of sorted) {
      if (!t) continue;
      const esc = escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b(${esc}\\w*)\\b`, 'gi');
      html = html.replace(re, '<mark class="d-hit">$1</mark>');
    }
    return html;
  }

  function renderDialogueResult(body) {
    const s = state.dialogue;
    const r = s.result;
    if (!r) { body.innerHTML = `<p class="hint-small">No dialogue yet.</p>`; return; }
    const terms = (r.targets || []).map(t => t.term);
    const voiceA = s.voiceA || getTtsSettings().voice;
    const voiceB = s.voiceB || voiceA;
    const turnsHtml = (r.turns || []).map((t, i) => {
      const isB = t.speaker === 'B';
      const vid = isB ? voiceB : voiceA;
      return `<div class="d-turn d-${isB ? 'b' : 'a'}">
      <span class="d-spkr">${escapeHtml(t.speaker || (i % 2 === 0 ? 'A' : 'B'))}</span>
      <div class="d-turn-body">
        <div class="d-en" dir="ltr">${highlightTargetsInLine(cleanLine(t.en), terms)}</div>
        ${t.ar ? `<div class="d-ar-line" dir="rtl">${escapeHtml(cleanLine(t.ar))}</div>` : ''}
        <button class="ex-speak" data-speak-ex="${escapeHtml(cleanLine(t.en))}" data-speak-voice="${escapeHtml(vid)}" data-speak-rate="${s.rate || 0.95}" title="Speak">🔊</button>
      </div>
    </div>`;
    }).join('');

    const targetsBar = `<div class="d-targets">${(r.targets || []).map(t => `<span class="d-target-chip" dir="ltr">${escapeHtml(t.term)}</span>`).join('')}</div>`;
    const notesHtml = (r.targetNotes && r.targetNotes.length)
      ? `<details class="d-notes"><summary>💡 لماذا اختير هذا الموقف لكل كلمة</summary>${r.targetNotes.map(n => `<div class="d-note-row">
          <span class="d-note-term" dir="ltr">${escapeHtml(n.term)}</span>
          ${n.note ? `<span class="d-note-text" dir="rtl">${escapeHtml(n.note)}</span>` : ''}
          ${n.alt ? `<div class="d-note-alt"><span class="d-note-alt-label">💬 Natives more often say</span><span class="d-note-alt-text" dir="ltr">${escapeHtml(n.alt)}</span><button class="ex-speak" data-speak-ex="${escapeHtml(n.alt)}" title="Speak alternative">🔊</button></div>` : ''}
        </div>`).join('')}</details>`
      : '';

    body.innerHTML = `
      <div class="d-result-head">
        <button class="small-btn" data-d-back>← Pick again</button>
        <button class="small-btn primary-pill" data-d-play-all>▶ Play all</button>
      </div>
      ${r.situation ? `<div class="d-situation"><b>${escapeHtml(r.situation)}</b>${r.situation_ar ? `<p dir="rtl">${escapeHtml(r.situation_ar)}</p>` : ''}</div>` : ''}
      ${targetsBar}
      ${notesHtml}
      <div class="d-dialogue">${turnsHtml}</div>
      <div class="d-result-foot">
        <button class="small-btn" data-d-regenerate>🔄 Regenerate</button>
        <button class="small-btn" data-d-save-result>${r.savedAt ? '✓ Saved' : '💾 Save'}</button>
      </div>
    `;
  }

  function renderDialogueHistory(body) {
    const list = dialogueHistory();
    if (!list.length) { body.innerHTML = `<div class="d-result-head"><button class="small-btn" data-d-back>← Picker</button></div><p class="hint-small" style="padding:14px;text-align:center">No saved dialogues yet.</p>`; return; }
    const items = list.map(d => `<div class="d-hist-item">
      <div class="d-hist-meta">
        <b dir="ltr">${escapeHtml(d.situation || 'Dialogue')}</b>
        <small>${(d.targets || []).length} term${(d.targets || []).length === 1 ? '' : 's'} · ${(d.turns || []).length} turns · ${new Date(d.savedAt || d.id || Date.now()).toLocaleDateString()}</small>
      </div>
      <div class="d-hist-actions">
        <button class="small-btn" data-d-open-hist="${escapeHtml(d.id)}">Open</button>
        <button class="small-btn danger" data-d-del-hist="${escapeHtml(d.id)}">✕</button>
      </div>
    </div>`).join('');
    body.innerHTML = `<div class="d-result-head"><button class="small-btn" data-d-back>← Picker</button><b>📚 Saved dialogues</b></div><div class="d-hist-list">${items}</div>`;
  }

  async function startDialogueGeneration() {
    const s = state.dialogue;
    const all = dialogueAvailableItems();
    const picked = all.filter(it => s.selectedIds.has(it.id));
    if (!picked.length) { toast('Pick at least one item'); return; }
    s.step = 'generating';
    renderDialogue();
    try {
      const result = await generateDialogue(
        picked.map(it => ({ term: it.term, ar: it.ar })),
        { situation: s.situation, length: s.length, provider: s.provider, naturalFillers: s.naturalFillers }
      );
      s.result = {
        id: 'd_' + Date.now(),
        createdAt: new Date().toISOString(),
        targets: picked.map(it => ({ id: it.id, term: it.term, ar: it.ar })),
        situation: cleanLine(result.situation || ''),
        situation_ar: cleanLine(result.situation_ar || ''),
        turns: (result.turns || []).map(t => ({
          speaker: String(t.speaker || '').toUpperCase() === 'B' ? 'B' : 'A',
          en: cleanLine(t.en || ''),
          ar: cleanPuterArabicTranslation(t.ar || '')
        })),
        targetNotes: Array.isArray(result.target_notes)
          ? result.target_notes.map(n => ({
              term: cleanLine(n?.term || ''),
              note: cleanLine(n?.note || ''),
              alt:  cleanLine(n?.alt  || n?.alternative || '')
            })).filter(n => n.term && (n.note || n.alt))
          : [],
        provider: s.provider
      };
      s.step = 'result';
      s.error = '';
    } catch (e) {
      s.step = 'picker';
      s.error = e.message || String(e);
      toast('Dialogue generation failed');
    }
    renderDialogue();
    if (s.error) $('dialogueBody').insertAdjacentHTML('afterbegin', `<div class="speak-error">${escapeHtml(s.error)}</div>`);
  }

  // Play all turns one after another, alternating between speaker A's and
  // speaker B's chosen voices so the conversation actually sounds like two
  // people. Uses the picker's chosen speech rate.
  function playDialogueAll() {
    const s = state.dialogue;
    if (!s?.result?.turns?.length) return;
    cancelTts();
    const voiceA = s.voiceA || getTtsSettings().voice;
    const voiceB = s.voiceB || voiceA;
    const rate = s.rate || 0.95;
    const queue = s.result.turns
      .map(t => ({ text: cleanLine(t.en), voice: t.speaker === 'B' ? voiceB : voiceA }))
      .filter(x => x.text);
    let i = 0;
    const speakNext = () => {
      if (i >= queue.length) return;
      const t = queue[i++];
      speakNatural(t.text, { voice: t.voice, rate, onended: () => setTimeout(speakNext, 260) });
    };
    speakNext();
  }

  // ───────── Connected speech (reductions) reference ─────────

  function reductionCardHtml(r) {
    return `<div class="red-card">
      <div class="red-top">
        <div class="red-forms">
          <span class="red-full" dir="ltr">${escapeHtml(r.full)}</span>
          <span class="red-arrow">→</span>
          <span class="red-connected" dir="ltr">${escapeHtml(r.connected)}</span>
          <button class="ex-speak" data-speak-ex="${escapeHtml(r.connected.replace(/\/.*$/, '').trim())}" title="Speak">🔊</button>
        </div>
      </div>
      <div class="red-pron"><span dir="ltr">🅴 ${escapeHtml(r.eng || '')}</span>${r.ar ? `<span dir="rtl">🅰 ${escapeHtml(r.ar)}</span>` : ''}</div>
      ${r.example ? `<div class="red-ex" dir="ltr">“${escapeHtml(r.example)}” <button class="ex-speak" data-speak-ex="${escapeHtml(r.example)}" title="Speak">🔊</button></div>` : ''}
      ${r.meaning ? `<div class="red-mean" dir="rtl">${escapeHtml(r.meaning)}</div>` : ''}
    </div>`;
  }

  function showReduction(key) {
    initLocalVocab();
    const r = state.reductionByForm && state.reductionByForm.get(String(key || '').toLowerCase());
    if (!r) { showConnectedSpeech(); return; }
    $('reductionBody').innerHTML = `${reductionCardHtml(r)}
      <p class="hint-small" style="margin-top:10px">This is a fast-speech reduction — natives say it this way in casual conversation.</p>
      <button class="full-btn" data-open-connected>📚 See all connected-speech forms</button>`;
    openModal('reductionModal');
    speak(r.connected.replace(/\/.*$/, '').trim());
  }

  function showConnectedSpeech() {
    initLocalVocab();
    openMenu(false);
    const reds = state.reductions || [];
    const patterns = state.reductionPatterns || [];
    if (!reds.length) { $('reductionBody').innerHTML = '<p>Connected-speech data not loaded.</p>'; openModal('reductionModal'); return; }

    // Group reductions by their source group.
    const groups = {};
    for (const r of reds) { (groups[r.group] = groups[r.group] || []).push(r); }

    const patternsHtml = patterns.length ? `<details class="red-group" open><summary>📐 Patterns / القواعد</summary>${patterns.map(p => `<div class="red-pattern"><b dir="ltr">${escapeHtml(p.rule)}</b>${p.ar ? `<p dir="rtl">${escapeHtml(p.ar)}</p>` : ''}${p.ex ? `<p class="red-pattern-ex" dir="ltr">${escapeHtml(p.ex)}</p>` : ''}</div>`).join('')}</details>` : '';

    const groupsHtml = Object.entries(groups).map(([g, list]) =>
      `<details class="red-group"><summary>${escapeHtml(g)} <span class="red-count">${list.length}</span></summary>${list.map(reductionCardHtml).join('')}</details>`
    ).join('');

    $('reductionBody').innerHTML = `<p class="hint-small">Why fast English is hard to catch: these are the words that get “swallowed” in natural speech. Tap 🔊 to hear each one.</p>${patternsHtml}${groupsHtml}`;
    openModal('reductionModal');
  }

  // ════════════════════════════════════════════════════════════════
  // CUSTOM-WORD LOOKUP — any word, even outside the loaded movie.
  //
  // Reuses openDict() entirely (translation + 5 Puter examples + Save), so
  // every quality we already invested in (Egyptian Arabic, "alt" hints,
  // natural-context notes, TTS) applies automatically. This function just
  // collects the term, remembers recent lookups, and hands off.
  // ════════════════════════════════════════════════════════════════

  const ADD_WORD_RECENT_KEY = 'jm_recent_lookups';
  const ADD_WORD_RECENT_MAX = 10;

  function recentLookups() {
    return readJSON(ADD_WORD_RECENT_KEY, []);
  }
  function pushRecentLookup(term) {
    const t = cleanLine(term).toLowerCase();
    if (!t) return;
    const list = recentLookups().filter(x => x.toLowerCase() !== t);
    list.unshift(t);
    writeJSON(ADD_WORD_RECENT_KEY, list.slice(0, ADD_WORD_RECENT_MAX));
  }

  function renderAddWordRecent() {
    const wrap = $('addWordRecent');
    if (!wrap) return;
    const list = recentLookups();
    if (!list.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<p class="add-word-recent-label">Recent</p>` + list.map(t =>
      `<button class="add-word-chip" data-add-recent="${escapeHtml(t)}" dir="ltr">${escapeHtml(t)}</button>`
    ).join('');
  }

  function openAddWordModal() {
    openMenu(false);
    renderAddWordRecent();
    openModal('addWordModal');
    setTimeout(() => { const inp = $('addWordInput'); if (inp) { inp.value = ''; inp.focus(); } }, 60);
  }

  function submitAddWord(termOverride) {
    const inp = $('addWordInput');
    // Guard: when this is wired as a click handler the first arg is a
    // PointerEvent, not a term. Only accept strings as the override.
    const override = typeof termOverride === 'string' ? termOverride : '';
    const raw = override || (inp ? inp.value : '');
    const term = cleanLine(raw);
    if (!term) { toast('Type a word first'); inp?.focus(); return; }
    pushRecentLookup(term);
    closeModal('addWordModal');
    // idx = -1 → no subtitle context; openDict handles that gracefully and
    // simply doesn't show "phrases in this line" suggestions.
    openDict(term, -1);
  }

  function openMenu(show=true) {
    el.menuSheet.classList.toggle('hidden', !show);
    // Hide the floating menu button while the sheet is open so it doesn't
    // poke through the backdrop. Re-shows after close.
    const fab = $('fabMenuBtn'); if (fab) fab.style.display = show ? 'none' : '';
  }
  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) {
    $(id).classList.add('hidden');
    // Stop any in-flight speech capture / TTS when the coach closes.
    if (id === 'speakModal') { stopSpeechCapture(); try { window.speechSynthesis?.cancel(); } catch {} clearTimeout(state.speakClipTimer); }
  }
  function updateControls() {
    el.syncValue.textContent = `${state.offset.toFixed(2)}s`;
    el.speedBtn.textContent = `${state.speed.toFixed(1)}x`;
    el.autoPauseBtn.textContent = state.autoPause ? 'On' : 'Off';
    if (el.repeatDelayValue) el.repeatDelayValue.textContent = `${state.repeatDelaySeconds}s`;
    const hb = $('highlightHfBtn'); if (hb) hb.textContent = state.highlightHF ? 'On' : 'Off';
    const tts = (typeof getTtsSettings === 'function') ? getTtsSettings() : null;
    const eb = $('ttsEngineBtn');
    if (eb && tts) {
      const label = ({ inworld: '🎙️ Inworld', eleven: '🎤 ElevenLabs', groq: '⚡ Groq', puter: '🤖 Puter', browser: '💻 Browser' })[tts.provider] || tts.provider;
      eb.textContent = label;
    }
    const vb = $('ttsVoiceBtn');
    if (vb && tts) {
      const v = TTS_VOICE_OPTIONS.find(x => x.id === tts.voice && x.engine === tts.provider) || TTS_VOICE_OPTIONS.find(x => x.engine === tts.provider) || TTS_VOICE_OPTIONS[0];
      vb.textContent = tts.provider === 'browser' ? '— OS default' : v.label.replace(/ \([FM][^)]*\)$/, '');
      vb.disabled = tts.provider === 'browser';
    }
    const acBtn = $('autoCacheBtn');
    if (acBtn && typeof getAutoCacheConsent === 'function') {
      const c = getAutoCacheConsent();
      acBtn.textContent = c === 'yes' ? 'Always' : (c === 'no' ? 'Off' : 'Ask');
    }
  }

  async function loadUrl(url, opts = {}) {
    url = String(url || '').trim(); if (!url) return;
    const originalUrl = url;
    state.videoUrl = originalUrl;
    // Tag the active lesson from the URL only if we don't already have a
    // user-supplied title (e.g. the SRT filename, which is usually nicer).
    if (!state.lessonTitle && !originalUrl.startsWith('blob:')) setLessonTitle(deriveLessonTitle(originalUrl));
    state.isSeeking = false;
    state.hlsReady = false;
    state.usingCachedVideo = false;
    if (!originalUrl.startsWith('blob:')) localStorage.setItem('jm_video_url', state.videoUrl);
    closeModal('urlModal');
    const yt = extractYtId(originalUrl);
    el.emptyVideo.classList.add('hidden');
    if (yt) return loadYouTube(yt);
    state.playerType = 'html5';
    el.ytHost.classList.add('hidden');
    el.movie.classList.remove('hidden');
    destroyHls();
    el.movie.preload = 'auto';
    el.movie.playsInline = true;
    setStatus('Loading video...');

    let playbackUrl = originalUrl;
    if (opts.useCache !== false && !originalUrl.startsWith('blob:')) playbackUrl = await cachedPlaybackUrl(originalUrl, opts);

    if (/\.m3u8(?:[?#]|$)/i.test(playbackUrl)) await attachHls(playbackUrl);
    else {
      try { el.movie.pause(); } catch {}
      el.movie.src = playbackUrl;
      try { el.movie.load(); } catch {}
      await waitForEvent(el.movie, ['loadedmetadata','canplay'], 4500, () => el.movie.readyState >= 1);
      if (opts.autoplay !== false) playMediaElement();
    }
    el.movie.playbackRate = state.speed;
    if (!state.usingCachedVideo) setStatus('Video loaded');
  }

  function extractYtId(url) { const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/); return m?.[1] || null; }
  async function loadYouTube(id) { state.playerType = 'youtube'; el.movie.classList.add('hidden'); el.ytHost.classList.remove('hidden'); if (!window.YT?.Player) { await loadScript('https://www.youtube.com/iframe_api'); await new Promise(r => { window.onYouTubeIframeAPIReady = r; setTimeout(r, 1500); }); } if (state.yt?.loadVideoById) state.yt.loadVideoById(id); else state.yt = new YT.Player('ytPlayer', { videoId:id, playerVars:{playsinline:1, rel:0, modestbranding:1}, events:{onReady:e=>{e.target.playVideo(); if (e.target.setPlaybackRate) e.target.setPlaybackRate(state.speed);}} }); }
  function destroyHls() { if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; } }
  async function attachHls(url) {
    if (el.movie.canPlayType('application/vnd.apple.mpegurl')) {
      el.movie.src = url;
      try { el.movie.load(); } catch {}
      await waitForEvent(el.movie, ['loadedmetadata','canplay'], 5000, () => el.movie.readyState >= 1);
      playMediaElement();
      state.hlsReady = true;
      return;
    }
    await loadScript('https://cdn.jsdelivr.net/npm/hls.js@latest');
    if (window.Hls?.isSupported()) {
      state.hls = new Hls({
        enableWorker: true,
        backBufferLength: 90,
        maxBufferLength: 45,
        maxMaxBufferLength: 120,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 15000
      });
      state.hls.on(Hls.Events.MANIFEST_PARSED, () => { state.hlsReady = true; playMediaElement(); setStatus('HLS video ready'); });
      state.hls.on(Hls.Events.ERROR, (event, data) => {
        console.warn('HLS error', data);
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { state.hls.startLoad(); setStatus('Recovering video network...'); }
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { state.hls.recoverMediaError(); setStatus('Recovering video media...'); }
        else { destroyHls(); toast('HLS playback failed'); }
      });
      state.hls.loadSource(url);
      state.hls.attachMedia(el.movie);
    } else toast('HLS not supported');
  }


  async function recoverVideoPlayback() {
    if (state.playerType !== 'html5') {
      const idx = currentSubtitleIndex();
      if (idx >= 0) seekMedia(state.subtitles[idx].startTime, true);
      return;
    }
    const idx = currentSubtitleIndex();
    const srtTime = idx >= 0 ? state.subtitles[idx].startTime : Math.max(0, (el.movie.currentTime || 0) - state.offset);
    const target = subtitleTimeToMediaTime(srtTime);
    toast('Recovering video...');
    if (canUseTimeFragment(state.videoUrl)) {
      try { el.movie.pause(); } catch {}
      el.movie.src = urlWithTimeFragment(state.videoUrl, target);
      try { el.movie.load(); } catch {}
      await waitForEvent(el.movie, ['loadedmetadata','canplay'], 6500, () => el.movie.readyState >= 1);
    }
    await html5SmartSeek(target, true, { forceReload: true });
  }

  document.addEventListener('click', e => {
    const wordEl = e.target.closest('.word'); if (wordEl) { e.stopPropagation(); pauseMedia(); if (wordEl.dataset.reduction) { showReduction(wordEl.dataset.reduction); } else { openDict(wordEl.dataset.word, Number(e.target.closest('[data-index]')?.dataset.index ?? state.lastIndex)); } return; }
    const renderBtn = e.target.closest('[data-render-center]'); if (renderBtn) return renderList(Number(renderBtn.dataset.renderCenter));
    const play = e.target.closest('[data-play]'); if (play) { const i = Number(play.dataset.play); state.repeatStart = -1; state.repeatEnd = -1; state.activeIndex = i; state.lastIndex = i; renderList(i); updateDock(state.subtitles[i], -1); seekMedia(state.subtitles[i].startTime, true); return; }
    const rep = e.target.closest('[data-repeat]'); if (rep) {
      const i = Number(rep.dataset.repeat);
      if (state.repeatStart < 0 || state.repeatEnd < 0) {
        setRepeatRange(i, i, true);
        toast('Repeat starts here');
      } else if ((state.repeatStart === i && state.repeatEnd === i) || (i >= state.repeatStart && i <= state.repeatEnd)) {
        stopRepeat();
      } else {
        setRepeatRange(Math.min(state.repeatStart, i), Math.max(state.repeatEnd, i), true);
      }
      renderList(i);
      return;
    }
    const lineMenu = e.target.closest('[data-line-menu]'); if (lineMenu) { const i = Number(lineMenu.dataset.lineMenu); toggleLineActionMenu(i, lineMenu); return; }
    const lineAction = e.target.closest('[data-line-action]'); if (lineAction) {
      e.preventDefault();
      e.stopPropagation();
      const i = Number(lineAction.dataset.index);
      const action = lineAction.dataset.lineAction;
      hideLineActionMenus();
      if (!state.subtitles[i]) return;
      if (action === 'copy') return copyLine(i);
      if (action === 'translate') return translateLine(i);
      if (action === 'save') return saveLine(i);
      if (action === 'phrases') return saveDetectedPhrasesFromLine(i);
      if (action === 'template') return saveTemplateFromSubtitle(i);
      if (action === 'playphrase') return openPlayPhrase(cleanLine(state.subtitles[i]?.en));
      return;
    }
    const openTermBtn = e.target.closest('[data-open-term]'); if (openTermBtn) { openDict(openTermBtn.dataset.openTerm, Number(openTermBtn.dataset.index)); return; }
    const recentBtn = e.target.closest('[data-add-recent]'); if (recentBtn) { submitAddWord(recentBtn.dataset.addRecent); return; }
    const speakExBtn = e.target.closest('[data-speak-ex]');
    if (speakExBtn) {
      const opts = {};
      if (speakExBtn.dataset.speakVoice) opts.voice = speakExBtn.dataset.speakVoice;
      if (speakExBtn.dataset.speakRate) opts.rate = Number(speakExBtn.dataset.speakRate);
      speakNatural(speakExBtn.dataset.speakEx, opts);
      return;
    }
    if (e.target.closest('[data-open-connected]')) { closeModal('reductionModal'); showConnectedSpeech(); return; }

    // ── Dialogue practice ─────────────────────────────────────────
    // Picker actions only update the dynamic main area + suggestion list, so
    // the search input keeps focus and the caret while the user types.
    const dPick = (typeof renderDialoguePickerMain === 'function')
      ? () => { renderDialoguePickerMain(); renderDialogueSuggest(); }
      : renderDialogue;
    const dPickWithFilters = () => { dPick(); if (typeof renderDialoguePickerFilters === 'function') renderDialoguePickerFilters(); };

    const dSuggAdd = e.target.closest('[data-d-sugg-add]');
    if (dSuggAdd) { e.preventDefault(); addDialogueSuggestion(dSuggAdd.dataset.dSuggAdd, true); return; }
    const dTog = e.target.closest('[data-d-toggle]');
    if (dTog) { const id = dTog.dataset.dToggle; const s = ensureDialogueState(); if (s.selectedIds.has(id)) s.selectedIds.delete(id); else s.selectedIds.add(id); dPick(); return; }
    const dFil = e.target.closest('[data-d-filter]'); if (dFil) { ensureDialogueState().filterKind = dFil.dataset.dFilter; dPickWithFilters(); return; }
    if (e.target.closest('[data-d-clear]')) { ensureDialogueState().selectedIds.clear(); dPick(); return; }
    const dLen = e.target.closest('[data-d-length]'); if (dLen) { ensureDialogueState().length = dLen.dataset.dLength; dPick(); return; }
    const dProv = e.target.closest('[data-d-provider]'); if (dProv) { if (dProv.classList.contains('disabled')) { toast('Add an OpenRouter key in Settings first'); return; } ensureDialogueState().provider = dProv.dataset.dProvider; dPick(); return; }
    const dRate = e.target.closest('[data-d-rate]'); if (dRate) { ensureDialogueState().rate = Number(dRate.dataset.dRate) || 0.95; dPick(); return; }
    const dFill = e.target.closest('[data-d-fillers]'); if (dFill) { ensureDialogueState().naturalFillers = dFill.dataset.dFillers === '1'; dPick(); return; }
    // Voice cycling for speaker A / B — restricted to the active TTS engine.
    const dVoiceTest = e.target.closest('[data-d-voice-test]');
    if (dVoiceTest) {
      e.stopPropagation();
      const sp = dVoiceTest.dataset.dVoiceTest; const ds = ensureDialogueState();
      const vid = sp === 'A' ? ds.voiceA : ds.voiceB;
      speakNatural(`Hi, I'm speaker ${sp}.`, { voice: vid, rate: ds.rate });
      return;
    }
    const dVoiceCycle = e.target.closest('[data-d-voice-cycle]');
    if (dVoiceCycle) {
      const sp = dVoiceCycle.dataset.dVoiceCycle; const ds = ensureDialogueState();
      const cfg = getTtsSettings();
      const pool = TTS_VOICE_OPTIONS.filter(v => v.engine === cfg.provider);
      if (!pool.length) { toast(`No voices for ${cfg.provider}`); return; }
      const curId = sp === 'A' ? ds.voiceA : ds.voiceB;
      const idx = pool.findIndex(v => v.id === curId);
      const next = pool[(idx + 1) % pool.length];
      if (sp === 'A') ds.voiceA = next.id; else ds.voiceB = next.id;
      if (typeof renderDialoguePickerMain === 'function') renderDialoguePickerMain();
      else renderDialogue();
      speakNatural(`Speaker ${sp} — ${next.id}.`, { voice: next.id, rate: ds.rate });
      return;
    }
    if (e.target.closest('[data-d-generate]')) { startDialogueGeneration(); return; }
    if (e.target.closest('[data-d-back]')) { const s = ensureDialogueState(); s.step = 'picker'; renderDialogue(); return; }
    if (e.target.closest('[data-d-regenerate]')) { startDialogueGeneration(); return; }
    if (e.target.closest('[data-d-play-all]')) { playDialogueAll(); return; }
    if (e.target.closest('[data-d-history]')) { ensureDialogueState().step = 'history'; renderDialogue(); return; }
    if (e.target.closest('[data-d-save-result]')) { const s = ensureDialogueState(); if (s.result) { s.result.savedAt = new Date().toISOString(); saveDialogueToHistory(s.result); toast('Dialogue saved'); renderDialogue(); } return; }
    const dOpenH = e.target.closest('[data-d-open-hist]'); if (dOpenH) { const id = dOpenH.dataset.dOpenHist; const d = dialogueHistory().find(x => x.id === id); if (d) { const s = ensureDialogueState(); s.result = d; s.step = 'result'; renderDialogue(); } return; }
    const dDelH = e.target.closest('[data-d-del-hist]'); if (dDelH) { deleteDialogueFromHistory(dDelH.dataset.dDelHist); renderDialogue(); return; }
    const savePhrase = e.target.closest('[data-save-phrase]'); if (savePhrase) { savePhraseFromSubtitle(savePhrase.dataset.savePhrase, Number(savePhrase.dataset.index)); return; }
    const refreshOneTemplate = e.target.closest('[data-refresh-template-examples]'); if (refreshOneTemplate) { refreshTemplateExamplesByIndex(refreshOneTemplate.dataset.refreshTemplateExamples); return; }
    const refreshAllTemplates = e.target.closest('[data-refresh-all-template-examples]'); if (refreshAllTemplates) { refreshAllTemplateExamples(); return; }
    const deleteOneTemplate = e.target.closest('[data-delete-template-index]'); if (deleteOneTemplate) { deleteTemplateByIndex(deleteOneTemplate.dataset.deleteTemplateIndex); return; }
    const deleteSelectedTemplatesBtn = e.target.closest('[data-delete-selected-templates]'); if (deleteSelectedTemplatesBtn) { deleteSelectedTemplates(); return; }
    const deleteAllTemplatesBtn = e.target.closest('[data-delete-all-templates]'); if (deleteAllTemplatesBtn) { deleteAllTemplates(); return; }
    const ppWord = e.target.closest('[data-pp-word]'); if (ppWord) { openPlayPhrase(ppWord.dataset.ppWord); return; }
    const ppLine = e.target.closest('[data-pp-line]'); if (ppLine) { const item = state.savedLines[Number(ppLine.dataset.ppLine)]; if (item) openPlayPhrase(cleanLine(item.en)); return; }
    const reviewOne = e.target.closest('[data-review-one]'); if (reviewOne) { const [type, index] = reviewOne.dataset.reviewOne.split(':'); showSingleReviewCard(type, index); return; }
    const savedPlay = e.target.closest('[data-saved-play]'); if (savedPlay) { const item = state.savedLines[Number(savedPlay.dataset.savedPlay)]; if (item) { const idx = state.subtitles.findIndex(s => lineKey(s) === item.key || Math.abs((s.startTime||0)-(item.startTime||0)) < .08); closeModal('savedModal'); if (idx >= 0) { renderList(idx); seekMedia(state.subtitles[idx].startTime, true); jumpToCard(idx); } else toast('Open the original lesson first'); } return; }
    const syncSavedCloudBtn = e.target.closest('[data-sync-saved-cloud]'); if (syncSavedCloudBtn) { syncSavedItemsToCloud({ silent: false, reason: 'manual' }); return; }
    const loadSavedCloudBtn = e.target.closest('[data-load-saved-cloud]'); if (loadSavedCloudBtn) { loadSavedItemsFromCloud({ silent: false, merge: true }).then(() => { showSaved('lines'); }); return; }
    const cloudLoad = e.target.closest('[data-cloud-load]'); if (cloudLoad) { loadCloudLesson(cloudLoad.dataset.cloudLoad); return; }
    const cloudEdit = e.target.closest('[data-cloud-edit]'); if (cloudEdit) { editCloudLesson(cloudEdit.dataset.cloudEdit); return; }
    const cloudDelete = e.target.closest('[data-cloud-delete]'); if (cloudDelete) { deleteCloudLesson(cloudDelete.dataset.cloudDelete); return; }
    if (e.target.closest('[data-review-reveal]')) { state.reviewRevealed = true; renderReviewCard(); return; }
    const gradeBtn = e.target.closest('[data-review-grade]'); if (gradeBtn) { const card = e.target.closest('[data-review-key]'); if (card) gradeReview(card.dataset.reviewKey, gradeBtn.dataset.reviewGrade, card.dataset.reviewType || ''); return; }
    // Smart-card extras: TTS speak, check typed answer, mode toggles
    const speakBtn = e.target.closest('[data-review-speak]');
    if (speakBtn) {
      const text = speakBtn.dataset.speakText || e.target.closest('[data-review-key]')?.querySelector('.review-front')?.textContent || '';
      speakText(text);
      return;
    }
    if (e.target.closest('[data-review-check]')) {
      const card = e.target.closest('[data-review-key]');
      const input = card?.querySelector('[data-review-answer]');
      const expected = card?.dataset.answer || '';
      if (input) {
        state.reviewTyped = input.value;
        state.reviewFeedback = validateAnswer(input.value, expected);
        // Auto-reveal on exact match — saves a tap.
        if (state.reviewFeedback === 'exact') state.reviewRevealed = true;
        renderReviewCard();
      }
      return;
    }
    const modeChk = e.target.closest('[data-smart-mode]');
    if (modeChk) {
      const k = modeChk.dataset.smartMode;
      const cur = getSmartReviewSettings();
      setSmartReviewSettings({ enabled: { ...cur.enabled, [k]: modeChk.checked } });
      renderReviewCard();
      return;
    }
    if (e.target.closest('[data-smart-autospeak]')) {
      const cb = e.target.closest('[data-smart-autospeak]');
      setSmartReviewSettings({ autoSpeak: cb.checked });
      return;
    }
    const deckStart = e.target.closest('[data-review-start-deck]');
    if (deckStart) { startReviewSession(deckStart.dataset.reviewStartDeck); return; }
    if (e.target.closest('[data-review-back-to-decks]')) { showReviewCards(); return; }
    if (e.target.closest('[data-show-saved-lines]')) { showSaved('lines'); return; }
    if (!e.target.closest('.line-action-menu')) hideLineActionMenus();
    if (e.target.matches('[data-close-modal]')) closeModal(e.target.dataset.closeModal);
  });

  // Enter key inside the smart-card answer input → trigger Check, just like
  // the on-screen button. Keeps the user's hands on the keyboard.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('[data-review-answer]');
    if (!input) return;
    e.preventDefault();
    const card = e.target.closest('[data-review-key]');
    const expected = card?.dataset.answer || '';
    state.reviewTyped = input.value;
    state.reviewFeedback = validateAnswer(input.value, expected);
    if (state.reviewFeedback === 'exact') state.reviewRevealed = true;
    renderReviewCard();
  });

  $('menuBtn').onclick = () => openMenu(true); $('closeMenuBtn').onclick = () => openMenu(false); document.querySelector('.sheet-backdrop').onclick = () => openMenu(false);
  // Floating menu button (bottom-left) — same handler, always within thumb reach.
  if ($('fabMenuBtn')) $('fabMenuBtn').onclick = () => openMenu(true);
  // Auto-cache consent toggle — cycles Ask → Yes → No → Ask.
  if ($('autoCacheBtn')) $('autoCacheBtn').onclick = () => {
    const cur = getAutoCacheConsent();
    const next = cur === 'ask' ? 'yes' : (cur === 'yes' ? 'no' : 'ask');
    setAutoCacheConsent(next);
    updateControls();
    toast(({ ask: 'Auto-cache: ask once', yes: 'Auto-cache: always on', no: 'Auto-cache: off' })[next]);
  };

  // Menu search: live-filter buttons by label/text. Auto-expands any section
  // that contains a match and collapses ones that don't, so the user can scan
  // results without scrolling through every section.
  (function wireMenuSearch() {
    const input = $('menuSearchInput'); if (!input) return;
    const sectionsEl = $('menuSections');
    const emptyHint = $('menuEmptyHint');
    const defaultOpen = new Set(['lesson']);

    function applyFilter(raw) {
      const q = String(raw || '').trim().toLowerCase();
      const sections = sectionsEl?.querySelectorAll('.menu-section') || [];
      let anyVisible = false;

      sections.forEach(sec => {
        const buttons = sec.querySelectorAll('.m-btn');
        let visibleInSection = 0;
        buttons.forEach(btn => {
          if (!q) {
            btn.classList.remove('hidden', 'search-match');
            visibleInSection++;
            return;
          }
          const hay = (btn.textContent + ' ' + (btn.dataset.label || '')).toLowerCase();
          const match = hay.includes(q);
          btn.classList.toggle('hidden', !match);
          btn.classList.toggle('search-match', match);
          if (match) visibleInSection++;
        });

        sec.classList.toggle('search-hidden', q && visibleInSection === 0);
        if (q) {
          sec.open = visibleInSection > 0;
        } else {
          sec.open = defaultOpen.has(sec.dataset.section);
        }
        if (visibleInSection > 0) anyVisible = true;
      });

      if (emptyHint) emptyHint.classList.toggle('hidden', !q || anyVisible);
    }

    input.addEventListener('input', e => applyFilter(e.target.value));
    // Reset filter every time the menu opens so the user starts from a clean slate.
    const origOpenMenu = openMenu;
    window.__resetMenuSearch = () => { input.value = ''; applyFilter(''); };
    // Patch openMenu by wrapping the existing click handlers.
    const menuBtnEl = $('menuBtn');
    if (menuBtnEl) {
      const prev = menuBtnEl.onclick;
      menuBtnEl.onclick = (e) => { window.__resetMenuSearch?.(); return prev?.call(menuBtnEl, e); };
    }
  })();

  $('urlBtn').onclick = () => openModal('urlModal'); $('loadUrlBtn').onclick = () => loadUrl($('videoUrlInput').value);
  $('videoFileInput').onchange = e => { const f = e.target.files[0]; if (!f) return; setLessonTitle(deriveLessonTitle(f.name)); loadUrl(URL.createObjectURL(f)); };
  $('subtitleFileInput').onchange = e => { const f = e.target.files[0]; if (!f) return; setLessonTitle(deriveLessonTitle(f.name)); const r = new FileReader(); r.onload = () => handleSubtitleContent(r.result); r.readAsText(f); };
  $('menuUploadSrt').onclick = () => { openMenu(false); $('subtitleFileInput').click(); };
  $('menuAzure').onclick = translateAllAzure;
  // menuLaraAll (Translate all with OpenRouter AI) was removed — subtitle
  // translation now runs through Puter AI per-line on demand. translateAllPuter()
  // is still defined so the Azure path / saved-cloud flows keep working.
  if ($('menuPuterAll')) $('menuPuterAll').onclick = translateAllPuter;
  $('menuLaraSettings').onclick = () => openLaraSettings();
  if ($('menuAiTemplateSettings')) $('menuAiTemplateSettings').onclick = () => openChatLlmSettings();
  $('menuSavedWords').onclick = () => { openMenu(false); showSaved('words'); };
  if ($('menuSavedPhrases')) $('menuSavedPhrases').onclick = () => { openMenu(false); showSaved('phrases'); };
  if ($('menuSavedTemplates')) $('menuSavedTemplates').onclick = () => { openMenu(false); showSaved('templates'); };
  if ($('menuExtractTemplates')) $('menuExtractTemplates').onclick = saveTemplatesFromAllSubtitles;
  $('menuSavedLines').onclick = () => { openMenu(false); showSaved('lines'); };
  $('menuReviewCards').onclick = showReviewCards;
  if ($('menuConnectedSpeech')) $('menuConnectedSpeech').onclick = showConnectedSpeech;
  if ($('menuAddCustomWord')) $('menuAddCustomWord').onclick = () => { openMenu(false); openAddWordModal(); };
  if ($('addWordBtn')) $('addWordBtn').onclick = () => openAddWordModal();
  if ($('addWordSubmit')) $('addWordSubmit').onclick = submitAddWord;
  if ($('addWordInput')) $('addWordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAddWord(); }
  });
  if ($('menuDialoguePractice')) $('menuDialoguePractice').onclick = openDialoguePractice;
  if ($('menuSpeakingCoach')) $('menuSpeakingCoach').onclick = () => { openMenu(false); openSpeakingCoach(currentSubtitleIndex() >= 0 ? currentSubtitleIndex() : 0); };
  $('menuSaveCloud').onclick = saveLessonToCloud;
  if ($('menuSyncSavedCloud')) $('menuSyncSavedCloud').onclick = () => { openMenu(false); syncSavedItemsToCloud({ silent: false, reason: 'manual' }); };
  if ($('menuLoadSavedCloud')) $('menuLoadSavedCloud').onclick = () => { openMenu(false); loadSavedItemsFromCloud({ silent: false, merge: true }).then(() => showSaved('lines')); };
  $('menuCloudLibrary').onclick = showCloudLibrary;
  if ($('menuRecoverVideo')) $('menuRecoverVideo').onclick = () => { openMenu(false); recoverVideoPlayback(); };
  if ($('menuCacheVideo')) $('menuCacheVideo').onclick = () => { openMenu(false); cacheCurrentVideo(); };
  if ($('menuUseCache')) $('menuUseCache').onclick = () => { openMenu(false); useCachedVideo(); };
  if ($('menuClearCache')) $('menuClearCache').onclick = () => { openMenu(false); clearCurrentVideoCache(); };
  $('menuClear').onclick = () => { if(confirm('Start a new lesson?')) { localStorage.removeItem('jm_subtitles'); localStorage.removeItem('jm_video_url'); localStorage.removeItem('jm_last_lesson_saved_at'); state.videoUrl=''; state.subtitles=[]; state.activeIndex=-1; state.lastIndex=-1; state.repeatStart=-1; state.repeatEnd=-1; try { el.movie.pause(); el.movie.removeAttribute('src'); el.movie.load(); } catch {} if (state.videoBlobUrl) { try { URL.revokeObjectURL(state.videoBlobUrl); } catch {} state.videoBlobUrl=''; } state.usingCachedVideo=false; el.movie.classList.add('hidden'); el.ytHost.classList.add('hidden'); el.emptyVideo.classList.remove('hidden'); state.playerType='none'; renderList(0); updateDock(null); setStatus('New lesson'); openMenu(false); } };
  $('speedBtn').onclick = () => { const opts=[.5,.75,1,1.25,1.5,2]; state.speed = opts[(opts.indexOf(state.speed)+1)%opts.length] || 1; if (state.playerType === 'html5') el.movie.playbackRate = state.speed; if (state.yt?.setPlaybackRate) state.yt.setPlaybackRate(state.speed); updateControls(); debounceSave(); };
  $('syncMinus').onclick = () => { state.offset -= .25; updateControls(); debounceSave(); };
  $('syncPlus').onclick = () => { state.offset += .25; updateControls(); debounceSave(); };
  if ($('repeatDelayMinus')) $('repeatDelayMinus').onclick = () => { state.repeatDelaySeconds = Math.max(1, Number(state.repeatDelaySeconds || 1) - 1); updateControls(); debounceSave(); toast(`Repeat pause: ${state.repeatDelaySeconds}s`); };
  if ($('repeatDelayPlus')) $('repeatDelayPlus').onclick = () => { state.repeatDelaySeconds = Math.min(5, Number(state.repeatDelaySeconds || 1) + 1); updateControls(); debounceSave(); toast(`Repeat pause: ${state.repeatDelaySeconds}s`); };
  $('autoPauseBtn').onclick = () => { state.autoPause = !state.autoPause; updateControls(); };
  if ($('highlightHfBtn')) $('highlightHfBtn').onclick = () => {
    state.highlightHF = !state.highlightHF;
    localStorage.setItem('jm_highlight_hf', state.highlightHF ? '1' : '0');
    updateControls();
    if (state.highlightHF) ensureHfThenRefresh();
    else { state.hfCount = 0; state.advCount = 0; renderList(state.listCenter); updateDock(null); }
    toast(state.highlightHF ? 'Key-word highlighting on' : 'Highlighting off');
  };
  if ($('ttsEngineBtn')) $('ttsEngineBtn').onclick = () => {
    const cur = getTtsSettings();
    const next = TTS_PROVIDERS[(TTS_PROVIDERS.indexOf(cur.provider) + 1) % TTS_PROVIDERS.length];
    // Snap voice to the first one that belongs to the new engine.
    const firstVoice = TTS_VOICE_OPTIONS.find(v => v.engine === next);
    setTtsSettings({ provider: next, voice: firstVoice ? firstVoice.id : cur.voice });
    TTS_CACHE.clear();
    updateControls();
    const label = ({ inworld: 'Inworld (premium)', eleven: 'ElevenLabs (premium)', groq: 'Groq (fast)', puter: 'Puter (free cloud)', browser: 'Browser (offline)' })[next] || next;
    toast(`Voice engine: ${label}`);
    if (next !== 'browser' && firstVoice) speakNatural(`Hi, I'm ${firstVoice.id}.`);
  };
  if ($('ttsVoiceBtn')) $('ttsVoiceBtn').onclick = () => {
    const cur = getTtsSettings();
    if (cur.provider === 'browser') { toast('Browser voice uses the OS default'); return; }
    const pool = TTS_VOICE_OPTIONS.filter(v => v.engine === cur.provider);
    if (!pool.length) return;
    const idx = pool.findIndex(v => v.id === cur.voice);
    const next = pool[(idx + 1) % pool.length];
    setTtsSettings({ voice: next.id });
    TTS_CACHE.clear();
    updateControls();
    speakNatural(`Hi, I'm ${next.id}. Let's practice English together.`);
  };
  if ($('ttsVoiceTestBtn')) $('ttsVoiceTestBtn').onclick = () => {
    const cfg = getTtsSettings();
    const tag = cfg.provider === 'browser' ? 'your browser voice' : cfg.voice;
    speakNatural(`Hello, this is ${tag}. Pick a subtitle and start practicing.`);
  };
  $('goActiveBtn').onclick = () => jumpToCard(currentSubtitleIndex() >= 0 ? currentSubtitleIndex() : 0);
  el.subtitleDock.onclick = () => jumpToCard(currentSubtitleIndex());
  $('jumpCurrentBtn').onclick = () => jumpToCard(currentSubtitleIndex());
  $('loopCurrentBtn').onclick = repeatCurrentSubtitle;
  $('loopStartBtn').onclick = setLoopStartFromCurrent;
  $('loopEndBtn').onclick = setLoopEndFromCurrent;
  $('loopOffBtn').onclick = stopRepeat;
  $('saveLineBtn').onclick = () => saveLine(currentSubtitleIndex());
  $('copyLineBtn').onclick = () => copyLine(currentSubtitleIndex());
  $('translateLineBtn').onclick = () => translateLine(currentSubtitleIndex());
  if ($('speakLineBtn')) $('speakLineBtn').onclick = () => openSpeakingCoach(currentSubtitleIndex());
  $('playPhraseLineBtn').onclick = () => { const item = state.subtitles[currentSubtitleIndex()]; if (item) openPlayPhrase(cleanLine(item.en)); };
  if ($('saveLaraSettingsBtn')) $('saveLaraSettingsBtn').onclick = async () => {
    const cfg = saveLaraConfigToLocal();
    if (!cfg.accessKeyId || !cfg.accessKeySecret) { $('laraSettingsStatus').textContent = 'Please enter both Lara Access Key ID and Secret.'; return toast('Missing Lara keys'); }
    $('laraSettingsStatus').textContent = 'Saving Lara settings locally and to Supabase...';
    const ok = await saveLaraSettingsToCloud({ silent: true });
    $('laraSettingsStatus').textContent = ok ? 'Lara settings saved locally and in Supabase.' : 'Lara settings saved locally, but cloud sync failed. Try Menu → Cloud library → Sync saved now.';
    toast(ok ? 'Lara saved to cloud' : 'Lara saved locally');
  };
  if ($('testLaraSettingsBtn')) $('testLaraSettingsBtn').onclick = async () => {
    const cfg = saveLaraConfigToLocal();
    if (!cfg.accessKeyId || !cfg.accessKeySecret) { $('laraSettingsStatus').textContent = 'Please enter both Lara Access Key ID and Secret first.'; return toast('Missing Lara keys'); }
    clearLaraPause();
    $('laraSettingsStatus').textContent = 'Testing Lara directly, without MyMemory fallback...';
    try {
      const sample = await translateLaraPure('I have got some time.');
      await saveLaraSettingsToCloud({ silent: true });
      $('laraSettingsStatus').textContent = `Lara works directly. Source: ${sample.credentialSource || 'app credentials'}. Sample: ${sample.text}`;
      toast('Lara test passed');
    } catch (e) {
      const msg = e.message || String(e);
      if (isLaraQuotaLikeMessage(msg)) pauseLaraAfterQuota(30, msg);
      $('laraSettingsStatus').textContent = `${msg} Normal subtitle translation will use MyMemory fallback instead of stopping.`;
      toast('Lara direct test failed');
    }
  };
  if ($('clearLaraSettingsBtn')) $('clearLaraSettingsBtn').onclick = async () => {
    localStorage.removeItem('jm_lara_access_key_id'); localStorage.removeItem('jm_lara_access_key_secret');
    clearLaraPause();
    $('laraKeyIdInput').value = ''; $('laraSecretInput').value = '';
    $('laraSettingsStatus').textContent = 'Lara settings cleared locally. Syncing removal to Supabase...';
    const ok = await syncSavedItemsToCloud({ silent: true, reason: 'lara-clear' });
    $('laraSettingsStatus').textContent = ok ? 'Lara settings cleared locally and from Supabase.' : 'Local Lara settings cleared, but cloud sync failed.';
    toast('Lara cleared');
  };

  if ($('clearLaraQuotaPauseBtn')) $('clearLaraQuotaPauseBtn').onclick = () => {
    clearLaraPause();
    $('laraSettingsStatus').textContent = 'Lara temporary pause cleared. Click Test Lara to check the real API response again.';
    toast('Lara pause cleared');
  };

  if ($('saveChatLlmSettingsBtn')) $('saveChatLlmSettingsBtn').onclick = async () => {
    const cfg = saveOpenRouterConfigToLocal();
    if (!cfg.apiKey) { if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = 'Please enter your OpenRouter API key first.'; return toast('Missing OpenRouter key'); }
    if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = 'Saving OpenRouter settings locally and to Supabase...';
    const ok = await syncSavedItemsToCloud({ silent: true, reason: 'openrouter-settings' });
    if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = ok ? `OpenRouter saved. Free model: ${cfg.model || 'openrouter/free'}.` : 'OpenRouter saved locally, but cloud sync failed.';
    toast(ok ? 'OpenRouter saved to cloud' : 'OpenRouter saved locally');
  };
  if ($('testChatLlmSettingsBtn')) $('testChatLlmSettingsBtn').onclick = async () => {
    const cfg = saveOpenRouterConfigToLocal();
    if (!cfg.apiKey) { if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = 'Please enter your OpenRouter API key first.'; return toast('Missing OpenRouter key'); }
    if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = 'Testing OpenRouter free model...';
    try {
      const ar = await translateOpenRouterSubtitle('I have got some time.');
      const sampleTemplate = {
        pattern: 'How many times have I told you not to [do something]?',
        source: 'How many times have I told you not to wake me up like that?',
        slot: 'wake me up like that',
        usageEn: 'Use it when someone keeps doing something you warned them not to do.'
      };
      const examples = await fetchTemplateExamplesFromOpenRouter(sampleTemplate, sampleTemplate.source);
      await syncSavedItemsToCloud({ silent: true, reason: 'openrouter-settings-test' });
      if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = examples.length ? `OpenRouter works. Translation: ${ar}. Example: ${examples[0].en} — ${examples[0].ar || ''}` : `OpenRouter translation works: ${ar}. Examples fallback will use Puter/MyMemory.`;
      toast('OpenRouter test passed');
    } catch (e) {
      if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = e.message || String(e);
      toast('OpenRouter test failed');
    }
  };
  if ($('clearChatLlmSettingsBtn')) $('clearChatLlmSettingsBtn').onclick = async () => {
    localStorage.removeItem('jm_openrouter_api_key'); localStorage.removeItem('jm_openrouter_model');
    localStorage.removeItem('jm_chats_llm_api_key'); localStorage.removeItem('jm_chats_llm_model');
    if ($('chatLlmKeyInput')) $('chatLlmKeyInput').value = '';
    if ($('chatLlmModelInput')) $('chatLlmModelInput').value = 'openrouter/free';
    await syncSavedItemsToCloud({ silent: true, reason: 'openrouter-clear' });
    if ($('chatLlmSettingsStatus')) $('chatLlmSettingsStatus').textContent = 'OpenRouter settings cleared locally and synced. Puter/MyMemory fallbacks still work.';
    toast('OpenRouter cleared');
  };


  el.movie.addEventListener('loadedmetadata', () => { el.movie.playbackRate = state.speed; });
  el.movie.addEventListener('waiting', () => { if (state.playerType === 'html5') setStatus('Buffering video...'); });
  el.movie.addEventListener('stalled', () => { if (state.playerType === 'html5') setStatus('Video stalled. Use Menu → Recover video if it does not resume.'); });
  el.movie.addEventListener('playing', () => { if (state.playerType === 'html5' && !state.isSeeking) setStatus('Playing'); });
  // Pro cache hooks: time-based threshold trigger + error-based failover.
  el.movie.addEventListener('timeupdate', checkAutoCacheThreshold);
  el.movie.addEventListener('error', handleVideoFailover);

  state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word && !isHiddenCloudSettingsItem(x));
  state.savedLines = state.savedLines.map(normalizeSavedLine);
  rebuildSavedWordSet();
  loadSavedItemsFromCloud({ silent: true, merge: true }).then(ok => {
    rebuildSavedWordSet();
    if (state.subtitles?.length) { recomputeHfCount(); renderList(state.listCenter); updateDock(null); }
    if (ok) setStatus(`Saved items ready from cloud • ${state.savedWords.length + state.savedLines.length} cards`);
  });
  const savedSubs = readJSON('jm_subtitles', []);
  const savedUrl = localStorage.getItem('jm_video_url') || '';
  if (savedSubs.length) {
    state.subtitles = savedSubs.filter(x => !shouldIgnoreSubtitle(x.en)).map(x => ({...x, time: x.time || formatTime(x.startTime)}));
    renderList(0);
    setStatus(`${state.subtitles.length} subtitles restored`);
    ensureHfThenRefresh();
  } else {
    // Warm the caches so the first uploaded file highlights instantly.
    loadHighFreqWords().catch(() => {});
    loadCefrAdvanced().catch(() => {});
  }
  if (savedUrl && !savedUrl.startsWith('blob:')) {
    state.videoUrl = savedUrl;
    const input = $('videoUrlInput'); if (input) input.value = savedUrl;
    setTimeout(() => loadUrl(savedUrl), 250);
  }
  updateControls(); syncLoop();
})();
