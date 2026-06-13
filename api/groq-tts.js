// Vercel Serverless Function: /api/groq-tts
//
// Proxies Groq's PlayAI TTS endpoint (OpenAI-compatible). Frontend POSTs
// { text, voice }, receives { audioContent: base64, mimeType }.
//
// Config:
//   - GROQ_API_KEY env var (preferred)
//   - GROQ_API_KEY_FALLBACK below for personal-use convenience

const GROQ_TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
const DEFAULT_MODEL = 'playai-tts';
const DEFAULT_VOICE = 'Fritz-PlayAI';        // natural en-US male
const DEFAULT_FORMAT = 'wav';                 // Groq returns wav by default
const MAX_TEXT_LENGTH = 2500;
const GROQ_API_KEY_FALLBACK = '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';

// Per-IP minute throttle.
const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_REQ_PER_MIN = 60;

function clean(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimit(ip) {
  const now = Date.now();
  const entry = HITS.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; }
  entry.count++;
  HITS.set(ip, entry);
  if (HITS.size > 500) for (const [k, v] of HITS) if (now > v.resetAt) HITS.delete(k);
  return entry.count <= MAX_REQ_PER_MIN;
}

async function readBinary(response) {
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = (process.env.GROQ_API_KEY || GROQ_API_KEY_FALLBACK || '').trim();
  if (!apiKey) return res.status(500).json({ error: 'Groq API key not configured on the server.' });

  if (!rateLimit(getClientIp(req))) return res.status(429).json({ error: 'Too many requests — slow down for a minute.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const text = clean(body.text).slice(0, MAX_TEXT_LENGTH);
    if (!text) return res.status(400).json({ error: 'text is required.' });

    const payload = {
      model: clean(body.model) || DEFAULT_MODEL,
      voice: clean(body.voice) || DEFAULT_VOICE,
      input: text,
      response_format: clean(body.responseFormat) || DEFAULT_FORMAT
    };

    const response = await fetch(GROQ_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const raw = await response.text();
      let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
      return res.status(response.status).json({
        error: data?.error?.message || data?.error || raw || response.statusText,
        details: data
      });
    }

    const buf = await readBinary(response);
    // Groq returns audio/wav by default; map other formats sensibly.
    const ctype = response.headers.get('content-type') || '';
    const mimeType = ctype || (payload.response_format === 'mp3' ? 'audio/mpeg' : `audio/${payload.response_format}`);
    return res.status(200).json({
      provider: 'groq',
      voice: payload.voice,
      model: payload.model,
      mimeType,
      audioContent: buf.toString('base64')
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
}
