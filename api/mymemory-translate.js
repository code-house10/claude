// Vercel Serverless Function: /api/mymemory-translate
// Used for saved words, saved phrases, dictionary examples, and template examples.
// Lara is intentionally reserved for subtitle-line translation only.

const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
const DEFAULT_SOURCE = 'en';
const DEFAULT_TARGET = 'ar';
const MAX_BYTES = 450;

function byteLengthUtf8(text) {
  return new TextEncoder().encode(String(text || '')).length;
}

function splitText(text, maxBytes = MAX_BYTES) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (byteLengthUtf8(clean) <= maxBytes) return [clean];

  const sentenceParts = clean.match(/[^.!?؟。]+[.!?؟。]*/g) || [clean];
  const chunks = [];
  let buffer = '';

  const pushBuffer = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = '';
  };

  for (const part of sentenceParts) {
    const candidate = `${buffer} ${part}`.trim();
    if (byteLengthUtf8(candidate) <= maxBytes) {
      buffer = candidate;
      continue;
    }
    pushBuffer();

    if (byteLengthUtf8(part) <= maxBytes) {
      buffer = part.trim();
    } else {
      let wordBuffer = '';
      for (const word of part.split(/\s+/)) {
        const wordCandidate = `${wordBuffer} ${word}`.trim();
        if (byteLengthUtf8(wordCandidate) <= maxBytes) {
          wordBuffer = wordCandidate;
        } else {
          if (wordBuffer) chunks.push(wordBuffer);
          wordBuffer = word;
        }
      }
      if (wordBuffer) chunks.push(wordBuffer);
    }
  }
  pushBuffer();
  return chunks;
}

async function fetchMyMemory(text, source, target) {
  const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`${source}|${target}`)}`;
  const response = await fetch(url);
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`MyMemory error ${response.status}: ${raw}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('MyMemory returned invalid JSON.');
  }
}

async function translateSegment(text, source, target) {
  const data = await fetchMyMemory(text, source, target);
  return data?.responseData?.translatedText || '';
}

function cleanLine(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function hasLatin(text) {
  return /[A-Za-z]/.test(String(text || ''));
}

function hasArabic(text) {
  return /[\u0600-\u06FF]/.test(String(text || ''));
}

function looksBadEnglishExample(text) {
  const t = cleanLine(text);
  if (!t || !hasLatin(t)) return true;
  if (/\[.*?\]/.test(t)) return true;
  if (/\b(examples? of template|using the same template|same template|in my own situation)\b/i.test(t)) return true;
  if (/\bleft\s+on\s+in\b/i.test(t)) return true;
  if (/\b(on|in|at|for|with|to|of|from|by|about)\s+(on|in|at|for|with|to|of|from|by|about)\b/i.test(t)) return true;
  if (/\b(?:on|in|at|for|with|to|of|from|by|about|the|a|an)\s*[.!?]?$/i.test(t)) return true;
  const words = (t.match(/[A-Za-z']+/g) || []).length;
  return words < 3;
}

function extractMatches(data, limit = 5) {
  const out = [];
  const seen = new Set();
  for (const item of data?.matches || []) {
    const en = cleanLine(item.segment || item.sourceSegment || item.source || '');
    const ar = cleanLine(item.translation || item.targetSegment || item.target || '');
    if (!en || looksBadEnglishExample(en)) continue;
    // If translation is not Arabic, it is still useful as an English candidate, but the app will translate it later.
    const key = en.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      en,
      ar: hasArabic(ar) ? ar : '',
      quality: item.quality || '',
      match: item.match || '',
      source: 'mymemory'
    });
    if (out.length >= limit) break;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const source = String(req.body?.source || DEFAULT_SOURCE).trim();
    const target = String(req.body?.target || DEFAULT_TARGET).trim();

    if (Array.isArray(req.body?.items)) {
      const translated = [];
      for (const raw of req.body.items) {
        const text = String(raw?.text || '').trim();
        if (!text) continue;
        const chunks = splitText(text);
        const translatedParts = [];
        for (const chunk of chunks) {
          translatedParts.push(await translateSegment(chunk, source, target));
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        translated.push({
          index: raw?.index,
          text,
          ar: translatedParts.join(' ').replace(/\s+/g, ' ').trim()
        });
      }
      return res.status(200).json({ translated });
    }

    if (String(req.body?.mode || '').toLowerCase() === 'examples') {
      const query = String(req.body?.query || req.body?.text || '').trim();
      const limit = Math.max(1, Math.min(10, Number(req.body?.limit || 5)));
      if (!query) return res.status(400).json({ error: 'No query was provided.' });
      const data = await fetchMyMemory(query, source, target);
      const matches = extractMatches(data, limit);
      const translatedText = data?.responseData?.translatedText || '';
      return res.status(200).json({ translatedText, matches });
    }

    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'No text was provided.' });
    }

    const chunks = splitText(text);
    const translatedParts = [];

    for (const chunk of chunks) {
      translatedParts.push(await translateSegment(chunk, source, target));
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return res.status(200).json({ translatedText: translatedParts.join(' ').replace(/\s+/g, ' ').trim() });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
}
