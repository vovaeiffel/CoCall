# Building and development

[← Back to the contents](../../README.en.md)

You need [Node.js](https://nodejs.org/) (LTS) and Git, or just the downloaded sources. All commands run in the project folder.

## Running for development

```
npm install
npm start
```

`npm start` builds the app and opens it. When run this way:

- the app opens the developer console;
- it has its own settings (data folder `CoCall-dev`), so it can run next to an installed copy;
- the cross closes the window instead of minimizing to the tray;
- only one copy on a computer can create a room (there's one port 8080). To test: one copy creates a room, the other connects to `127.0.0.1:8080`.

## Project layout

| Path | What's there |
| --- | --- |
| `src/main.ts` | main process: window, tray, updates, discovery, hotkey |
| `src/preload.ts`, `src/global.d.ts` | the bridge between the window and the main process |
| `src/renderer.ts`, `src/ui.ts` | the app window: logic and interface |
| `src/signaling.ts`, `src/protocol.ts` | the room server (on the host's computer) and messages |
| `src/webrtc.ts` | connections between participants |
| `src/audio.ts`, `src/rnnoise.ts` | audio, noise suppression |
| `src/discovery.ts`, `src/lobby.ts` | room discovery and network chat |
| `src/theme.ts` | color schemes |
| `src/lang/` | translations |
| `index.html` | the page and styles |
| `sounds/` | built-in sound packs |

## Building the installer

```
npm run dist
```

The `release` folder gets three files: `CoCall-Setup-x.y.z.exe`, `CoCall-Setup-x.y.z.exe.blockmap` and `latest.yml`. The first build takes 5–10 minutes. If it ends with an error about a "symbolic link", turn on "Developer Mode" in Windows (Settings → For developers) or run the terminal as administrator.

## Making a release

1. Raise `"version"` in `package.json` (for example, from `1.0.5` to `1.0.6`).
2. `npm run dist`.
3. On GitHub: Releases → Draft a new release. Tag `v1.0.6` (the same number as in `package.json`), a title and a description.
4. Attach **all three files** from `release`. Without `latest.yml` auto-update won't work.
5. "Publish release" (not a draft).

Installed copies of version 1.0.5 or newer will offer to update themselves. The version number of every release must be higher than the previous one.

## Adding a language

1. Copy `src/lang/en.ts` to a new file, for example `src/lang/de.ts`.
2. At the top change `export const en` to `export const de`, and also `code` (the short code for the button, `de`), `name` (the language's name in itself) and `locale` (`de-DE`, used for the time in chat).
3. Translate everything to the right of the colon. The left part (the Russian phrase) must not be changed. Parts like `{name}`, `{count}`, `{size}` stay: they're replaced with names and numbers.
4. In `src/lang/index.ts` add `import { de } from './de';` and put `de` into the `LANGUAGES` list.
5. Run `npm start`: the language appears in the globe menu and the tray menu picks it up too.

Phrases without a translation are shown in Russian, so nothing breaks. To find untranslated ones, run `npm start`, walk through the screens and run `__i18nMissing` in the developer console. New texts in the code are written in Russian and wrapped in `t('…')`. More: `src/lang/ЯЗЫКИ-ЧИТАЙ-МЕНЯ.txt` (in Russian).

## Custom sounds

- **Default set**: files `join`, `leave`, `message`, `stream-start`, `stream-stop`, `mic-on`, `mic-off` (mp3, wav or ogg) directly in the `sounds` folder.
- **Your own pack**: a separate folder inside `sounds` with files of the same names. You don't have to include all: anything missing plays from the default set. For a nice pack name put a `pack.txt` in the pack folder with the name on the first line. Packs in `sounds` are included in the app at build time.
- **A user pack without rebuilding**: Settings → "Sounds" → "Open packs folder", put such a folder there and click "Refresh list".
- **A sound for one event**: Settings → "Sounds" → "Custom sound…" next to the event (up to 3 MB).

More: `sounds/ЧИТАЙ-МЕНЯ.txt` (in Russian).

## The `src/config.ts` file

It holds the app name and the repository address used for update checks (`GITHUB_REPO`). If you make your own copy of the project, change the address to yours.

## Reporting a bug or suggesting an improvement

Open an [issue](https://github.com/vovaeiffel/CoCall/issues) and attach the report from "Diagnostics" (Settings → General). Please blur IP addresses and names if you don't want to show them.
