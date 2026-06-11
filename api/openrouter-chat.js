// Vercel Serverless Function: /api/openrouter-chat
// OpenRouter proxy for subtitle translation and template examples.
// Uses free models only. Put OPENROUTER_API_KEY in Vercel env, or send a key from the app settings.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function freeModel(model) {
  const id = clean(model).toLowerCase();
  if (!id || id === 'auto' || id === 'free' || id === 'openrouter') return 'openrouter/free';
  if (id === 'openrouter/free' || id.endsWith(':free')) return clean(model);
  return '';
}

function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(m => ({ role: ['system', 'user', 'assistant'].includes(m?.role) ? m.role : 'user', content: String(m?.content || '') }))
    .filter(m => m.content.trim())
    .slice(0, 12);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const apiKey = clean(body.apiKey || process.env.OPENROUTER_API_KEY || '');
    const model = freeModel(body.model || process.env.OPENROUTER_MODEL || 'openrouter/free');
    const messages = sanitizeMessages(body.messages);

    if (!apiKey) return res.status(400).json({ error: 'OpenRouter API key is missing.' });
    if (!model) return res.status(400).json({ error: 'Only OpenRouter free models are allowed. Use openrouter/free or a model ending with :free.' });
    if (!messages.length) return res.status(400).json({ error: 'No messages provided.' });

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://jungle-movie-learner.local',
        'X-OpenRouter-Title': process.env.OPENROUTER_SITE_NAME || 'Jungle Movie Learner'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.25,
        max_tokens: Math.min(3000, Math.max(32, Number(body.max_tokens || body.maxTokens || 900))),
        stream: false
      })
    });

    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || data?.message || data?.error || raw,
        details: data,
        model
      });
    }

    return res.status(200).json({
      provider: 'openrouter',
      model: data?.model || model,
      content: data?.choices?.[0]?.message?.content || '',
      raw: data
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
}
