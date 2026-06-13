// Vercel Serverless Function: /api/inworld-tts
//
// Proxies the Inworld Text-to-Speech API so the API key stays on the server
// and never reaches the browser. The frontend POSTs { text, voice, ... } and
// receives { audioContent: "<base64-mp3>" }.
//
// Configuration:
//   - INWORLD_API_KEY (Vercel env var)  ← preferred
//   - INWORLD_API_KEY_FALLBACK below     ← used if env is missing
//
// This is a personal-use app: the fallback key is acceptable because the
// proxy is the only public surface and we can rate-limit per-IP if abuse
// becomes a problem. Move the key out of source whenever possible.

const INWORLD_NON_STREAMING_URL = 'https://api.inworld.ai/tts/v1/voice';
const DEFAULT_MODEL = 'inworld-tts-2';
const DEFAULT_VOICE = 'Clive';
const DEFAULT_LANGUAGE = 'AUTO';
const DEFAULT_DELIVERY = 'BALANCED';
const MAX_TEXT_LENGTH = 2500;
const INWORLD_API_KEY_FALLBACK = 'dlRpaVppclN5Sll3ckZsM1M5b3FTNUIxSmpwSHI2bHU6VVNCQWNKYnBsSlNLWDg2TjYzUWJ3dg==';

// Minimal per-IP throttle so a runaway loop doesn't burn the quota.
const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_REQ_PER_MIN = 60;

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

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
  // Garbage-collect stale entries occasionally so the map doesn't grow forever.
  if (HITS.size > 500) {
    for (const [k, v] of HITS) if (now > v.resetAt) HITS.delete(k);
  }
  return entry.count <= MAX_REQ_PER_MIN;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = (process.env.INWORLD_API_KEY || INWORLD_API_KEY_FALLBACK || '').trim();
  if (!apiKey) return res.status(500).json({ error: 'Inworld API key not configured on the server.' });

  if (!rateLimit(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many requests — slow down for a minute.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const text = clean(body.text).slice(0, MAX_TEXT_LENGTH);
    if (!text) return res.status(400).json({ error: 'text is required.' });

    const payload = {
      text,
      voiceId: clean(body.voice || body.voiceId) || DEFAULT_VOICE,
      modelId: clean(body.model || body.modelId) || DEFAULT_MODEL,
      audioConfig: {
        speakingRate: Number.isFinite(Number(body.speakingRate)) ? Number(body.speakingRate) : 1
      },
      deliveryMode: clean(body.deliveryMode) || DEFAULT_DELIVERY,
      language: clean(body.language) || DEFAULT_LANGUAGE
    };

    const response = await fetch(INWORLD_NON_STREAMING_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || data?.error || data?.message || raw,
        details: data
      });
    }

    return res.status(200).json({
      provider: 'inworld',
      voice: payload.voiceId,
      model: payload.modelId,
      audioContent: data?.audioContent || '',
      timestampInfo: data?.timestampInfo || null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
}
