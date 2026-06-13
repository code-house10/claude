// Vercel Serverless Function: /api/eleven-tts
//
// Proxies ElevenLabs Text-to-Speech so the xi-api-key stays server-side.
// Frontend POSTs { text, voice }, gets { audioContent: base64, mimeType }.
//
// Config:
//   - ELEVENLABS_API_KEY env var (preferred)
//   - ELEVENLABS_API_KEY_FALLBACK below for personal-use convenience

const ELEVEN_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel — natural en-US female
const MAX_TEXT_LENGTH = 2500;
const ELEVENLABS_API_KEY_FALLBACK = 'sk_f8f4e801ddba645021cace031bcbebeb6c5ea60e82be9e49';

// Per-IP minute throttle so a runaway loop doesn't burn the quota.
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
  // Universal binary reader: Node 18+ has Response.arrayBuffer().
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = (process.env.ELEVENLABS_API_KEY || ELEVENLABS_API_KEY_FALLBACK || '').trim();
  if (!apiKey) return res.status(500).json({ error: 'ElevenLabs API key not configured on the server.' });

  if (!rateLimit(getClientIp(req))) return res.status(429).json({ error: 'Too many requests — slow down for a minute.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const text = clean(body.text).slice(0, MAX_TEXT_LENGTH);
    if (!text) return res.status(400).json({ error: 'text is required.' });

    const voiceId = clean(body.voice || body.voiceId) || DEFAULT_VOICE_ID;
    const modelId = clean(body.model || body.modelId) || DEFAULT_MODEL;
    const stability       = Number.isFinite(Number(body.stability))       ? Number(body.stability)       : 0.5;
    const similarityBoost = Number.isFinite(Number(body.similarityBoost)) ? Number(body.similarityBoost) : 0.75;
    const style           = Number.isFinite(Number(body.style))           ? Number(body.style)           : 0.0;

    // Ask for mp3 explicitly via query param so we can data-URI it cleanly.
    const url = `${ELEVEN_BASE_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability, similarity_boost: similarityBoost, style, use_speaker_boost: true }
      })
    });

    if (!response.ok) {
      const raw = await response.text();
      let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
      return res.status(response.status).json({
        error: data?.detail?.message || data?.detail?.status || data?.error || raw || response.statusText,
        details: data
      });
    }

    const buf = await readBinary(response);
    const mimeType = response.headers.get('content-type') || 'audio/mpeg';
    return res.status(200).json({
      provider: 'elevenlabs',
      voice: voiceId,
      model: modelId,
      mimeType,
      audioContent: buf.toString('base64')
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
}
