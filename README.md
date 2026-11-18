# Entiendo

**Live Polish → Spanish speech translation for your phone.** Point it at a priest, a tour guide or a shop assistant and read, in real time, what they say in Polish and its Spanish translation. In conversation mode it also turns what *you* say in Spanish into Polish text you can show the other person.

App UI is in Spanish. It is a Progressive Web App: open it in Chrome on Android and install it to the home screen.

## Modes

| Mode | What it does |
| --- | --- |
| **Misa** | Polish → Spanish, tuned for Catholic Mass: liturgical vocabulary, Spanish liturgical terms (e.g. *Msza Święta → Santa Misa*), longer pauses before closing a sentence. |
| **Escuchar** | Polish → Spanish for everyday listening (guides, announcements, radio, street). |
| **Conversar** | Two-way Polish ⇄ Spanish. The language is detected automatically; your Spanish phrases appear in Polish with a button to show them full-screen (and rotate 180° for the person in front of you). |

## Engines

* **Soniox (recommended)** — `stt-rt-v6` real-time model over WebSocket: transcription and translation stream word by word, no gaps, automatic language detection. Paid (≈ US$0.12–0.25 per hour of listening). You paste your own API key; it is stored only on the device and sent only to Soniox (in the WebSocket protocols list, as Soniox recommends for browsers).
* **Free** — the browser's speech recognition (Chrome uses Google) restarted automatically at pauses, plus free Google translation (with fallbacks). No account, lower quality.

## Robustness

* Audio is Opus at 32 kbit/s (~15 MB/hour of mobile data); raw PCM fallback for browsers without Opus recording.
* Automatic reconnection with backoff; audio recorded while offline is buffered and sent on reconnect; every new server session gets a fresh container header.
* Paragraphs cut off by a dropped connection are re-translated in full with the fallback translator; text in other languages gets a fallback translation too.
* Screen stays on while listening; transcripts are saved continuously (history, copy, share, download as text).
* Works offline as an app shell (service worker); Android back button closes panels.

## Development

```bash
npm install          # dev tools only (ws for the mock server)
npm test             # unit tests (segmenter)
npm run e2e          # end-to-end tests in Chromium with a fake microphone + mock Soniox server
npm run serve        # http://localhost:8080
```

`npm run e2e -- --shots` saves screenshots to `shots/`. Deploy with `scripts/deploy.sh` (pushes `app/` to the `gh-pages` branch).

Icons: [Lucide](https://lucide.dev) (ISC).
