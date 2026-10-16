# Story Studio: the kit as a phone app

Story Studio is an installable web app (PWA) in [`app/`](../app). It applies this
kit's editing rules to a talking-head clip on your phone, tablet, or laptop, then
exports a 1080x1920 MP4 ready for Instagram, Facebook, or TikTok stories and reels.

It is the quick, on-the-go path. For B-roll, motion graphics, music, and the full
review loop, use the agent skills (`/short-form-edit`, `/edit-video`) on a computer.

## What it does

| Step | What happens | Where the rule comes from |
| --- | --- | --- |
| Pause trimming | Removes dead air between phrases, keeps 0.2–0.4 s beats after commas and sentence ends, starts speech within ~0.1 s, ends right after the last word. "Natural" pace uses the `cut-silences` defaults. | `cut-silences`, [playbook](EDITING-PLAYBOOK.md#house-reel-style-the-numbers) |
| Mistake review | Proposes stutters, retakes, false starts, and fillers. Each one has **Hear original** and a Cut/Keep toggle. A filler is cut by default only with silence on both sides. | `cut-mistakes`, playbook step 3 |
| Word edits | Tap a word to fix spelling, cut it, colour it, or give it the serif accent. | Playbook captions section |
| Captions | 1–3 word chunks split on phrases, Montserrat ExtraBold caps in a dark box with a light edge, shown two frames early and held until the next chunk. Teal/red/green/yellow accents. | Playbook captions section |
| Framing | 9:16, 4:5, or 1:1. Fill (crop) or fit with a blurred background. Pan and zoom. | — |
| Punch-ins | Alternating zoom on every jump cut, or at phrase boundaries so no shot holds past ~2.8 s. Zoom anchors on the face line. | Playbook layouts and pacing |
| Coach | Scores the edit: first word, hook in 3 s, dead air, words per second, ending, call to action, story length, caption safe zone, static shots. Each warning has a one-tap fix. | Playbook story and pacing |
| Export | Frame-accurate, single pass: each output frame maps to an exact source time and audio is sliced sample-accurately from the same ranges, with 5 ms fades at joins. | Playbook "lessons that cost us time" |
| Kit hand-off | Download captions (`.srt`) and a JSON bundle with the EDL and source/edited word timings in this kit's transcript format. | [Tools guide](TOOLS-AND-API-KEYS.md) |

Whisper often stretches a word across the pause after it. Story Studio tightens
each word to its voiced audio, and cuts any silence of 0.8 s or more found in the
audio itself, so those pauses are still removed.

## Privacy and keys

- The video never leaves the device. Projects and source clips are stored in the
  browser (IndexedDB). Exports render locally with WebCodecs.
- Transcription is optional. Without it, pauses are trimmed from the audio alone.
- With it, only 16 kHz mono speech audio is uploaded, to the provider you choose,
  with your own key: **Groq Whisper** (default; fast, free tier), **OpenAI Whisper**,
  or **ElevenLabs Scribe** (the kit's default). Keys are stored in the browser's
  local storage on that device only.
- You can also import an existing word-level transcript (kit, Whisper
  `verbose_json`, or ElevenLabs JSON).

## Run it locally

```sh
npm run app          # http://localhost:5180
```

No install step: the app is static files with vendored libraries. Service workers
and installation need HTTPS or `localhost`, so a phone on your Wi-Fi can preview
over plain HTTP (`node scripts/serve-app.mjs --host 0.0.0.0`) but cannot install
or work offline that way.

## Put it on your phone

1. **Host it on HTTPS.** The included workflow `.github/workflows/pages.yml`
   publishes `app/` to GitHub Pages on every push to `main` that touches `app/`.
   Enable it once in the repository's **Settings → Pages → Source: GitHub
   Actions**. Pages on a private repository needs a paid GitHub plan; any static
   host (Netlify, Cloudflare Pages, Vercel) works too: publish the `app/` folder
   as is.
2. **Install it.**
   - iPhone/iPad: open the URL in Safari → Share → **Add to Home Screen**.
   - Android/Chrome/Edge: tap **Install app** on the home screen or use the browser menu.
3. **Edit a story.** New story → pick a clip → (optional) Settings → paste a Groq
   key → review the cut list → Captions/Look → check Coach → Export → **Share**
   straight into Instagram or TikTok, or **Save video** to the camera roll.

On Android, an installed Story Studio also appears in the share sheet for videos.

## Browser support

| Platform | Status |
| --- | --- |
| iOS / iPadOS 17+ Safari | MP4 (H.264). If the device has no native AAC encoder, a bundled WASM AAC encoder is loaded automatically. |
| Android Chrome, desktop Chrome/Edge | MP4 (H.264 + AAC). |
| Desktop Safari 17+ | MP4. |
| Firefox, open-source Chromium | WebM (VP9 + Opus) when H.264 encoding is unavailable. Social apps prefer MP4. |

iPhone footage recorded in HEVC decodes on Apple devices. On Windows/Android it
needs hardware HEVC support; otherwise set the camera to "Most Compatible" (H.264).

## Limits

- Stories are one continuous take of one speaker. No B-roll, music, or sound effects.
- Retake detection is mechanical. Listen before you accept a cut; intentional
  repetition is not a mistake.
- Long clips are bounded by device memory and the provider's upload limit
  (about 12 minutes of speech).
- The coach checks structure. It cannot judge whether the hook is compelling or a
  claim is true. Watch the export with sound before posting.

## Development

- `app/js/edit-core.js` holds the pure editing logic and is covered by
  `tests/story-studio.test.mjs` (`npm test`).
- `app/js/render.js` draws every frame for both the preview and the export.
- `app/js/media.js` decodes, analyses, and exports with [Mediabunny](https://mediabunny.dev).
- When you change any file listed in `app/sw.js`, bump `VERSION` there so
  installed copies update.
