Jungle Movie Lite - OpenRouter Free Models Test

What changed:
- OpenRouter AI is now available for subtitle translation and Saved Template examples.
- The app uses free models only: openrouter/free or models ending with :free.
- Puter AI remains as fallback if OpenRouter fails or no key is saved.
- MyMemory remains as final fallback for translation/examples.
- Lara remains as an optional backup/test setting only.
- OpenRouter settings can be saved locally and synced to Supabase.
- Saved words, phrases, lines, templates, examples, and review progress still sync with Supabase.

How to test:
1. Upload the full project folder to Vercel, not the HTML file only.
2. Open Menu -> OpenRouter AI settings.
3. Paste your OpenRouter API key.
4. Leave model as openrouter/free or write free.
5. Click Save OpenRouter to cloud.
6. Click Test OpenRouter.
7. Use Translate line / Translate all, or Saved templates -> Generate with OpenRouter AI.

Optional Vercel env variables:
- OPENROUTER_API_KEY
- OPENROUTER_MODEL=openrouter/free
- OPENROUTER_SITE_URL
- OPENROUTER_SITE_NAME

After deployment, use a fresh URL like ?v=openrouter-free-v1 or clear site data to avoid old service-worker cache.
