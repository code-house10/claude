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
    cacheDbPromise: null
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
        ? { en: cleanLine(ex), ar: '' }
        : { en: cleanLine(ex?.en || ''), ar: cleanLine(ex?.ar || '') };
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
    return `You are an expert English tutor for an Arabic-speaking learner.

TASK:
Use the sentence template below to generate 3 natural, complete, everyday English examples.
Translate each example into natural Arabic.

TEMPLATE:
${pattern}

ORIGINAL MOVIE LINE / CONTEXT:
${source}

ORIGINAL REPLACED PART:
${slot}

USAGE EN:
${usageEn}

USAGE AR:
${usageAr}

STRICT RULES:
- Return JSON only. No markdown. No explanations.
- The JSON must be an array of exactly 3 objects.
- Each object must be: {"en":"...", "ar":"..."}
- Replace every bracket placeholder like [do something], [something], [someone], [somewhere], [time] with realistic daily-life content.
- Do not keep brackets [] in the examples.
- Do not write incomplete sentences.
- Do not write meta sentences like "examples of template" or "using the same template".
- Do not create strange examples. Make them useful for daily conversation.
- Keep the same grammar structure and tone of the template.
- If the template sounds casual, keep the examples casual.
- If the template is a question, every example must be a complete question.
- If the template expresses annoyance, the examples should sound naturally annoyed, not rude.

Good output example:
[
  {"en":"Shouldn't you be at work by now?", "ar":"ألا يفترض أن تكون في العمل الآن؟"},
  {"en":"Shouldn't you be getting ready for class?", "ar":"ألا يفترض أن تستعد للحصة؟"},
  {"en":"Shouldn't you be on your way to school?", "ar":"ألا يفترض أن تكون في طريقك إلى المدرسة؟"}
]`;
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
      system: 'You are an expert English tutor. Return JSON only: an array of exactly 3 objects, each with en and ar. Use natural daily-life English and natural Arabic.'
    });
    const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.examples) ? parsed.examples : []);
    return sanitizeTemplateExamples(rawList.map(x => ({
      en: cleanLine(x?.en || x?.english || ''),
      ar: cleanLine(x?.ar || x?.arabic || ''),
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

  async function translateSubtitlePreferred(text) {
    const cfg = getOpenRouterConfig();
    if (cfg.apiKey) {
      try {
        return await translateOpenRouterSubtitle(text);
      } catch (e) {
        console.warn('OpenRouter subtitle translation unavailable. Falling back to Puter AI:', e);
        setStatus('OpenRouter unavailable. Puter AI fallback is active.');
      }
    }
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
    const cfg = getOpenRouterConfig();
    if (cfg.apiKey) {
      try {
        const rows = await translateOpenRouterSubtitleItems(items);
        if (rows.length) return rows;
      } catch (e) {
        console.warn('OpenRouter subtitle batch unavailable. Falling back to Puter AI:', e);
        setStatus('OpenRouter batch unavailable. Puter AI fallback is active.');
      }
    }
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

  async function translateTemplateExamplesWithMyMemory(examples) {
    const list = sanitizeTemplateExamples(examples || []);
    if (!list.length) return [];
    const need = list.map((ex, index) => ({ ex, index })).filter(x => !x.ex.ar || looksLikeTemplatePlaceholderArabic(x.ex.ar));
    if (!need.length) return list.slice(0, 3);
    try {
      const translated = await translateMyMemoryItems(need.map(x => ({ index: x.index, text: x.ex.en })));
      for (const row of translated || []) {
        const idx = Number(row.index);
        if (list[idx] && row.ar) list[idx].ar = cleanLine(row.ar);
      }
    } catch (e) {
      console.warn('MyMemory template example translation failed:', e);
      for (const row of need) {
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
      savedAt: line.savedAt || now,
      dueAt: line.dueAt || now,
      intervalDays: Number(line.intervalDays || 0),
      ease: Number(line.ease || 2.5),
      reviewCount: Number(line.reviewCount || 0),
      lastReviewedAt: line.lastReviewedAt || ''
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
      startTime: Number(word.startTime || 0),
      savedAt: word.savedAt || now,
      dueAt: word.dueAt || now,
      intervalDays: Number(word.intervalDays || 0),
      ease: Number(word.ease || 2.5),
      reviewCount: Number(word.reviewCount || 0),
      lastReviewedAt: word.lastReviewedAt || ''
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
        return `<span class="word${active}" data-word="${escapeHtml(part)}">${escapeHtml(part)}</span>`;
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
    el.listInfo.textContent = state.subtitles.length ? `Showing ${start+1}-${end} of ${state.subtitles.length}` : 'Upload SRT to start';
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

  function speak(text) { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang='en-US'; u.rate=.85; speechSynthesis.speak(u); } catch {} }
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
    saveWord(phrase, ar, { kind: 'phrase', contextEn, contextAr, sourceLineKey: lineKey(item), startTime: item.startTime || 0 });
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
    else state.savedLines.unshift(normalizeSavedLine({...item, ar, key, savedAt:new Date().toISOString()}));
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

  async function openDict(word, idx = state.lastIndex) {
    word = String(word || '').replace(/[^A-Za-zÀ-ÿ0-9'-]/g, '').trim();
    if (!word) return;
    const item = state.subtitles[idx];
    const contextEn = item ? cleanLine(item.en) : '';
    state.currentDictWord = word;
    state.currentDictExamples = [];
    $('dictWord').textContent = word;
    $('dictTranslation').textContent = 'Searching...';
    $('dictContext').innerHTML = idx >= 0 && item ? wordHtml(item.en, -1) : '';
    if ($('dictPhrases')) {
      const phrases = item ? detectPhrasesInLine(item.en, word) : [];
      $('dictPhrases').innerHTML = phrases.length ? `<div class="phrase-suggestions"><b>🧩 Phrases in this line</b><p>Save the full chunk with its movie-context meaning.</p>${phrases.map(p => `<button class="phrase-save-btn" data-save-phrase="${escapeHtml(p.phrase)}" data-index="${idx}">★ ${escapeHtml(p.phrase)}</button>`).join('')}</div>` : '';
    }
    $('dictExamples').innerHTML = '';
    openModal('dictModal');
    speak(word);
    $('dictPlayPhraseBtn').onclick = () => openPlayPhrase(word);
    $('dictSaveBtn').onclick = () => saveWord(word, $('dictTranslation').textContent || '', { kind: 'word', contextEn, contextAr: item?.ar || '', sourceLineKey: item ? lineKey(item) : '', startTime: item?.startTime || 0, examples: state.currentDictExamples || [] });
    $('dictSpeakBtn').onclick = () => speak(word);
    try { $('dictTranslation').textContent = await translateMyMemory(word); } catch { $('dictTranslation').textContent = 'Translation failed'; }
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const data = await res.json(); const examples = [];
      for (const m of data?.[0]?.meanings || []) for (const d of m.definitions || []) if (d.example) examples.push(d.example);
      const topExamples = [...new Set(examples)].slice(0,3);
      if (!topExamples.length) throw new Error('No examples');
      $('dictExamples').innerHTML = '<div class="example">Translating examples...</div>';
      const rows = [];
      state.currentDictExamples = [];
      for (const ex of topExamples) {
        let ar = '';
        try { ar = await translateMyMemory(ex); } catch {}
        state.currentDictExamples.push({ en: ex, ar: ar || '' });
        rows.push(`<div class="example"><p class="ex-en" dir="ltr">${escapeHtml(ex)}</p><p class="ex-ar" dir="rtl">${escapeHtml(ar || 'تعذر ترجمة المثال')}</p></div>`);
      }
      $('dictExamples').innerHTML = rows.join('');
    } catch { $('dictExamples').innerHTML = '<div class="example">No examples found.</div>'; }
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
        const displayExamples = x.kind === 'template' ? sanitizeTemplateExamples(x.examples || [], x.word, x.contextEn || '') : (Array.isArray(x.examples) ? x.examples.slice(0,3) : []);
        const examples = displayExamples.length ? `<div class="saved-section"><b>Examples <small class="example-source">Subtitle / OpenRouter / Puter / MyMemory</small></b>${displayExamples.slice(0,3).map(ex => `<div class="saved-example"><p dir="ltr">${escapeHtml(ex.en || ex)}</p>${ex.ar ? `<p dir="rtl">${escapeHtml(ex.ar)}</p>` : ''}</div>`).join('')}</div>` : '';
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

  function getDueReviewCards() {
    state.savedLines = state.savedLines.map(normalizeSavedLine);
    state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word);
    const now = Date.now();
    const lineCards = state.savedLines
      .filter(x => new Date(x.dueAt || 0).getTime() <= now)
      .map(x => ({ type: 'line', key: x.key, item: x }));
    const wordCards = state.savedWords
      .filter(x => new Date(x.dueAt || 0).getTime() <= now)
      .map(x => ({ type: 'word', key: x.key || wordKey(x.word), item: x }));
    return [...wordCards, ...lineCards].sort((a, b) => new Date(a.item.dueAt || 0) - new Date(b.item.dueAt || 0));
  }

  function allReviewItems() {
    return [
      ...state.savedWords.map(normalizeSavedWord).filter(x => x.word).map(x => ({ type:'word', key:x.key || wordKey(x.word), item:x })),
      ...state.savedLines.map(normalizeSavedLine).map(x => ({ type:'line', key:x.key, item:x }))
    ];
  }

  function showReviewCards() {
    openMenu(false);
    state.reviewQueue = getDueReviewCards();
    state.reviewIndex = 0;
    state.reviewRevealed = false;
    $('savedTitle').textContent = 'Smart review cards';
    renderReviewCard();
    openModal('savedModal');
  }

  function showSingleReviewCard(type, index) {
    const item = type === 'word' ? state.savedWords[Number(index)] : state.savedLines[Number(index)];
    if (!item) return;
    state.reviewQueue = [{ type, key: type === 'word' ? (item.key || wordKey(item.word)) : item.key, item: type === 'word' ? normalizeSavedWord(item) : normalizeSavedLine(item) }];
    state.reviewIndex = 0;
    state.reviewRevealed = false;
    $('savedTitle').textContent = type === 'word' ? 'Review word' : 'Review line';
    renderReviewCard();
    openModal('savedModal');
  }

  function renderReviewCard() {
    const body = $('savedBody');
    const due = state.reviewQueue;
    if (!state.savedLines.length && !state.savedWords.length) { body.innerHTML = '<p>No saved words or lines yet.</p>'; return; }
    if (!due.length) {
      const all = allReviewItems().sort((a,b)=>new Date(a.item.dueAt)-new Date(b.item.dueAt));
      const next = all[0]?.item;
      body.innerHTML = `<div class="review-empty"><b>All cards reviewed ✅</b><p>Next review: ${formatDue(next?.dueAt)}</p><button class="small-btn" data-show-saved-lines>Open saved lines</button></div>`;
      return;
    }
    const card = due[state.reviewIndex] || due[0];
    const item = card.item;
    const isWord = card.type === 'word';
    const front = isWord ? item.word : cleanLine(item.en);
    const back = item.ar || (isWord ? 'لا توجد ترجمة محفوظة لهذه الكلمة أو العبارة' : 'لا توجد ترجمة محفوظة');
    const badge = isWord ? (item.kind === 'template' ? 'Template card' : (item.kind === 'phrase' ? 'Phrase card' : 'Word card')) : 'Line card';
    const reviewContext = isWord ? `${item.templateUsageEn ? `<div class="review-context" dir="ltr">${escapeHtml(item.templateUsageEn)}</div>` : ''}${item.templateUsageAr ? `<div class="review-context ar" dir="rtl">${escapeHtml(item.templateUsageAr)}</div>` : ''}${item.contextEn ? `<div class="review-context" dir="ltr">${escapeHtml(item.contextEn)}</div>` : ''}${item.contextAr ? `<div class="review-context ar" dir="rtl">${escapeHtml(item.contextAr)}</div>` : ''}` : '';
    body.innerHTML = `<div class="review-card" data-review-key="${escapeHtml(card.key)}" data-review-type="${card.type}">
      <div class="review-count">${state.reviewIndex + 1} / ${due.length} due • ${badge}</div>
      <div class="review-front" dir="ltr">${escapeHtml(front)}</div>
      <div class="review-back ${state.reviewRevealed ? '' : 'hidden'}" dir="rtl">${escapeHtml(back)}${reviewContext}</div>
      <div class="review-actions">
        <button class="small-btn" data-review-reveal>Show meaning</button>
        <button class="small-btn again" data-review-grade="again">Again</button>
        <button class="small-btn hard" data-review-grade="hard">Hard</button>
        <button class="small-btn good" data-review-grade="good">Good</button>
        <button class="small-btn easy" data-review-grade="easy">Easy</button>
      </div>
    </div>`;
  }

  function applyReviewGrade(item, grade) {
    const now = new Date();
    item.reviewCount = Number(item.reviewCount || 0) + 1;
    item.lastReviewedAt = now.toISOString();
    let interval = Number(item.intervalDays || 0);
    let ease = Number(item.ease || 2.5);
    if (grade === 'again') { interval = 0; ease = Math.max(1.3, ease - .25); item.dueAt = new Date(now.getTime() + 10*60000).toISOString(); }
    else {
      if (grade === 'hard') { interval = interval ? Math.max(1, Math.round(interval * 1.2)) : 1; ease = Math.max(1.3, ease - .15); }
      if (grade === 'good') { interval = interval ? Math.round(interval * ease) : 1; }
      if (grade === 'easy') { interval = interval ? Math.round(interval * (ease + .8)) : 3; ease += .15; }
      item.intervalDays = interval; item.ease = ease; item.dueAt = new Date(now.getTime() + interval*86400000).toISOString();
    }
  }

  function gradeReview(key, grade, type = '') {
    let item = null;
    if (type === 'word' || String(key).startsWith('word:')) item = state.savedWords.find(x => (x.key || wordKey(x.word)) === key);
    else item = state.savedLines.find(x => x.key === key);
    if (!item) return;
    applyReviewGrade(item, grade);
    state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word);
    state.savedLines = state.savedLines.map(normalizeSavedLine);
    writeJSON('jm_saved_words', state.savedWords); writeJSON('jm_saved_lines', state.savedLines); scheduleCloudLibrarySync();
    state.reviewQueue = getDueReviewCards(); state.reviewIndex = 0; state.reviewRevealed = false; renderReviewCard();
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

  function openMenu(show=true) { el.menuSheet.classList.toggle('hidden', !show); }
  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }
  function updateControls() { el.syncValue.textContent = `${state.offset.toFixed(2)}s`; el.speedBtn.textContent = `${state.speed.toFixed(1)}x`; el.autoPauseBtn.textContent = state.autoPause ? 'On' : 'Off'; if (el.repeatDelayValue) el.repeatDelayValue.textContent = `${state.repeatDelaySeconds}s`; }

  async function loadUrl(url, opts = {}) {
    url = String(url || '').trim(); if (!url) return;
    const originalUrl = url;
    state.videoUrl = originalUrl;
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
    const wordEl = e.target.closest('.word'); if (wordEl) { e.stopPropagation(); pauseMedia(); openDict(wordEl.dataset.word, Number(e.target.closest('[data-index]')?.dataset.index ?? state.lastIndex)); return; }
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
    if (e.target.closest('[data-show-saved-lines]')) { showSaved('lines'); return; }
    if (!e.target.closest('.line-action-menu')) hideLineActionMenus();
    if (e.target.matches('[data-close-modal]')) closeModal(e.target.dataset.closeModal);
  });

  $('menuBtn').onclick = () => openMenu(true); $('closeMenuBtn').onclick = () => openMenu(false); document.querySelector('.sheet-backdrop').onclick = () => openMenu(false);
  $('urlBtn').onclick = () => openModal('urlModal'); $('loadUrlBtn').onclick = () => loadUrl($('videoUrlInput').value);
  $('videoFileInput').onchange = e => { const f = e.target.files[0]; if (f) loadUrl(URL.createObjectURL(f)); };
  $('subtitleFileInput').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => handleSubtitleContent(r.result); r.readAsText(f); };
  $('menuUploadSrt').onclick = () => { openMenu(false); $('subtitleFileInput').click(); };
  $('menuAzure').onclick = translateAllAzure;
  $('menuLaraAll').onclick = translateAllLara;
  $('menuLaraSettings').onclick = () => openLaraSettings();
  if ($('menuAiTemplateSettings')) $('menuAiTemplateSettings').onclick = () => openChatLlmSettings();
  $('menuSavedWords').onclick = () => { openMenu(false); showSaved('words'); };
  if ($('menuSavedPhrases')) $('menuSavedPhrases').onclick = () => { openMenu(false); showSaved('phrases'); };
  if ($('menuSavedTemplates')) $('menuSavedTemplates').onclick = () => { openMenu(false); showSaved('templates'); };
  if ($('menuExtractTemplates')) $('menuExtractTemplates').onclick = saveTemplatesFromAllSubtitles;
  $('menuSavedLines').onclick = () => { openMenu(false); showSaved('lines'); };
  $('menuReviewCards').onclick = showReviewCards;
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

  state.savedWords = state.savedWords.map(normalizeSavedWord).filter(x => x.word && !isHiddenCloudSettingsItem(x));
  state.savedLines = state.savedLines.map(normalizeSavedLine);
  loadSavedItemsFromCloud({ silent: true, merge: true }).then(ok => { if (ok) setStatus(`Saved items ready from cloud • ${state.savedWords.length + state.savedLines.length} cards`); });
  const savedSubs = readJSON('jm_subtitles', []);
  const savedUrl = localStorage.getItem('jm_video_url') || '';
  if (savedSubs.length) {
    state.subtitles = savedSubs.filter(x => !shouldIgnoreSubtitle(x.en)).map(x => ({...x, time: x.time || formatTime(x.startTime)}));
    renderList(0);
    setStatus(`${state.subtitles.length} subtitles restored`);
  }
  if (savedUrl && !savedUrl.startsWith('blob:')) {
    state.videoUrl = savedUrl;
    const input = $('videoUrlInput'); if (input) input.value = savedUrl;
    setTimeout(() => loadUrl(savedUrl), 250);
  }
  updateControls(); syncLoop();
})();
