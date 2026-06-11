// Vercel Serverless Function: /api/lara-translate
// Uses Lara Translate SDK for natural/context-aware subtitle line translation.
// Recommended Vercel env vars:
//   LARA_ACCESS_KEY_ID
//   LARA_ACCESS_KEY_SECRET

let cachedTranslator = null;
let cachedKeyId = '';
let cachedSecret = '';

function getTranslator(accessKeyId, accessKeySecret) {
  const { Credentials, Translator } = require('@translated/lara');
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('Lara credentials missing. Add LARA_ACCESS_KEY_ID and LARA_ACCESS_KEY_SECRET in Vercel, or save them in the app Lara settings.');
  }
  if (!cachedTranslator || cachedKeyId !== accessKeyId || cachedSecret !== accessKeySecret) {
    const credentials = new Credentials(accessKeyId, accessKeySecret);
    cachedTranslator = new Translator(credentials);
    cachedKeyId = accessKeyId;
    cachedSecret = accessKeySecret;
  }
  return cachedTranslator;
}

function cleanItem(item, index) {
  return {
    index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index,
    text: String(item?.text || '').trim()
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const credentials = body.credentials || {};
    const hasBodyCredentials = Boolean(String(credentials.accessKeyId || '').trim() && String(credentials.accessKeySecret || '').trim());
    const accessKeyId = String(credentials.accessKeyId || process.env.LARA_ACCESS_KEY_ID || '').trim();
    const accessKeySecret = String(credentials.accessKeySecret || process.env.LARA_ACCESS_KEY_SECRET || '').trim();
    const credentialSource = hasBodyCredentials ? 'app_saved_credentials' : 'vercel_environment_variables';
    const lara = getTranslator(accessKeyId, accessKeySecret);

    const source = body.source || process.env.LARA_SOURCE_LANG || 'en';
    const target = body.target || process.env.LARA_TARGET_LANG || 'ar';
    const instructions = Array.isArray(body.instructions) && body.instructions.length
      ? body.instructions
      : [
          'Translate movie and series subtitle dialogue into natural Arabic.',
          'Keep the translation concise and suitable for subtitles.',
          'Preserve names, jokes, emotion, slang, tone, and implied meaning.',
          'Do not add explanations, notes, or quotation marks.'
        ];

    const options = {
      style: body.style || 'fluid',
      contentType: 'text/plain',
      timeoutInMillis: Number(body.timeoutInMillis || 30000),
      priority: body.priority || 'normal',
      instructions
    };

    if (Array.isArray(body.items)) {
      const cleanItems = body.items.map(cleanItem).filter(x => x.text).slice(0, 128);
      if (!cleanItems.length) return res.status(400).json({ error: 'No items provided.' });
      const texts = cleanItems.map(x => x.text);
      const result = await lara.translate(texts, source, target, options);
      const translations = Array.isArray(result.translation) ? result.translation : [result.translation];
      return res.status(200).json({
        provider: 'lara',
        credentialSource,
        translated: cleanItems.map((item, i) => ({ index: item.index, ar: translations[i] || '' }))
      });
    }

    const text = String(body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'No text provided.' });
    const result = await lara.translate(text, source, target, options);
    return res.status(200).json({
      provider: 'lara',
      credentialSource,
      translatedText: Array.isArray(result.translation) ? (result.translation[0] || '') : (result.translation || '')
    });
  } catch (error) {
    console.error('Lara translate error:', error);
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json({
      error: error.message || String(error),
      details: error.details || error.response?.data || null,
      code: error.code || error.errorCode || null,
      type: error.type || error.constructor?.name || 'LaraError',
      source: 'lara-sdk',
      hint: 'If this says api_translation_chars quota exceeded while your dashboard still shows available characters, check whether the API credentials are from the same Lara API plan and whether Vercel environment variables contain old credentials.'
    });
  }
};
