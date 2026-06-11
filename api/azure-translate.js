// Vercel Serverless Function: /api/azure-translate
// This proxy makes Azure Translator more stable on mobile browsers
// and keeps the browser from calling Azure directly.

const AZURE_TRANSLATOR_KEY = process.env.AZURE_TRANSLATOR_KEY || 'BRe45ig0rsmYrbw6dsDBhXE4JwdVDKBcAyRRsqnd0sOlyAem26UeJQQJ99CFACYeBjFXJ3w3AAAbACOG6a4x';
const AZURE_TRANSLATOR_REGION = process.env.AZURE_TRANSLATOR_REGION || 'eastus';
const AZURE_TRANSLATOR_ENDPOINT = (process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com').replace(/\/+$/, '');
const FROM_LANG = process.env.AZURE_TRANSLATOR_FROM || 'en';
const TO_LANG = process.env.AZURE_TRANSLATOR_TO || 'ar';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!AZURE_TRANSLATOR_KEY) {
      return res.status(500).json({ error: 'Azure Translator key is missing.' });
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'No subtitle items were provided.' });
    }

    const cleanItems = items
      .map(item => ({
        index: Number(item.index),
        text: String(item.text || '').trim()
      }))
      .filter(item => Number.isFinite(item.index) && item.text);

    if (cleanItems.length === 0) {
      return res.status(400).json({ error: 'No valid subtitle text was provided.' });
    }

    const endpoint = AZURE_TRANSLATOR_ENDPOINT;
    const path = endpoint.includes('cognitiveservices.azure.com')
      ? '/translator/text/v3.0/translate'
      : '/translate';

    const azureUrl = `${endpoint}${path}?api-version=3.0&from=${encodeURIComponent(FROM_LANG)}&to=${encodeURIComponent(TO_LANG)}`;

    const headers = {
      'Ocp-Apim-Subscription-Key': AZURE_TRANSLATOR_KEY,
      'Content-Type': 'application/json; charset=UTF-8'
    };

    if (AZURE_TRANSLATOR_REGION && AZURE_TRANSLATOR_REGION.toLowerCase() !== 'global') {
      headers['Ocp-Apim-Subscription-Region'] = AZURE_TRANSLATOR_REGION;
    }

    const azureResponse = await fetch(azureUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(cleanItems.map(item => ({ text: item.text })))
    });

    const raw = await azureResponse.text();

    if (!azureResponse.ok) {
      const retryAfter = azureResponse.headers.get('retry-after') || '';
      return res.status(azureResponse.status).json({
        error: `Azure Translator error ${azureResponse.status}: ${raw}`,
        retryAfter: retryAfter ? Number(retryAfter) : null
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      return res.status(502).json({ error: 'Azure returned invalid JSON.' });
    }

    const translated = cleanItems.map((item, index) => ({
      index: item.index,
      ar: data[index]?.translations?.[0]?.text || ''
    }));

    return res.status(200).json({ translated });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
}
