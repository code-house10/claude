// Vercel Serverless Function: /api/openrouter-models
// Returns OpenRouter free models only.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function isFreeModel(model) {
  const id = String(model?.id || '').toLowerCase();
  const p = model?.pricing || {};
  const promptFree = String(p.prompt ?? p.input ?? '').replace(/[^0-9.]/g, '') === '0' || p.prompt === 0 || p.input === 0;
  const completionFree = String(p.completion ?? p.output ?? '').replace(/[^0-9.]/g, '') === '0' || p.completion === 0 || p.output === 0;
  return id === 'openrouter/free' || id.endsWith(':free') || (promptFree && completionFree);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const apiKey = String(body.apiKey || process.env.OPENROUTER_API_KEY || '').trim();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, { headers });
    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || raw, details: data });

    const models = (Array.isArray(data?.data) ? data.data : [])
      .filter(isFreeModel)
      .map(m => ({ id: m.id, name: m.name || m.id, context_length: m.context_length || m.contextLength || null }))
      .sort((a, b) => {
        if (a.id === 'openrouter/free') return -1;
        if (b.id === 'openrouter/free') return 1;
        return a.id.localeCompare(b.id);
      });

    if (!models.some(m => m.id === 'openrouter/free')) models.unshift({ id: 'openrouter/free', name: 'Free Models Router', context_length: null });
    return res.status(200).json({ models });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error), models: [{ id: 'openrouter/free', name: 'Free Models Router' }] });
  }
}
