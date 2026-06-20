# Desktop & Mobile App Builds

Jungle Movie Lite ships two ways to run outside the browser tab.

---

## 1. Mobile — Install as a PWA (recommended, zero build)

The app is now a full Progressive Web App (manifest + service worker + icons),
so you can install it straight from the browser — no store, no APK.

### Android (Chrome / Edge)
1. Open the deployed URL (your Vercel link) in Chrome.
2. Tap the menu **⋮ → Install app** (or open the in-app **Menu → Settings → 📲 Install app**).
3. The icon lands on your home screen and opens **full-screen, offline-capable** — no address bar, no reopening a link each time.

### iPhone / iPad (Safari)
1. Open the URL in **Safari** (not Chrome — iOS only allows install from Safari).
2. Tap **Share ⬆️ → Add to Home Screen → Add**.
3. Launches full-screen like a native app.

> The in-app **📲 Install app** button (Menu → Settings) triggers the native
> prompt on Android/desktop and shows step-by-step instructions on iOS.

---

## 2. Desktop — Wrap with Pake (Windows / macOS / Linux)

[Pake](https://github.com/tw93/Pake) turns the web app into a tiny (~5 MB)
Tauri-based native desktop app.

### Prerequisites
- [Rust](https://www.rust-lang.org/tools/install) toolchain
- Node.js 18+

### Build (one command)
```bash
npm install -g pake-cli

# Replace the URL with YOUR deployed app (Vercel). Pake needs a live URL,
# not local files, because the app calls /api/* serverless endpoints.
pake https://YOUR-APP.vercel.app \
  --name "JungleMovie" \
  --icon ./icon-512.png \
  --width 430 --height 880
```
This produces an installer (`.msi` / `.dmg` / `.deb`) for your OS.

### Recommended flags
| Flag | Why |
|------|-----|
| `--name "JungleMovie"` | App + window title |
| `--icon ./icon-512.png` | Reuses the PWA icon |
| `--width 430 --height 880` | Phone-like portrait window (matches the mobile-first layout) |
| `--hide-title-bar` | Cleaner look on macOS (optional) |

### ⚠️ Important caveats
- **Use the deployed URL, not the local files.** The app depends on the
  `/api/inworld-tts`, `/api/eleven-tts`, `/api/groq-tts`, `/api/openrouter-chat`
  serverless functions — those only exist on the Vercel deployment.
- **Puter AI** (`js.puter.com`) opens auth pop-ups. These work in normal
  browsers and usually in Tauri, but if a pop-up is blocked inside the wrapped
  app, switch the TTS engine to **ElevenLabs / Groq / Inworld** (server proxies,
  no pop-up) and translation falls back to MyMemory. Test before relying on it.
- **Microphone** (Speaking Coach) needs mic permission inside the Tauri window;
  grant it when prompted.

### Android via Pake (experimental)
Pake added experimental Android output, but it's not stable yet. For phones,
prefer the **PWA install** above — it's the smoother path today.
