# SAT Bank

A mastery question bank for the hardest SAT questions: 246 Math and 235 Reading and Writing, every one exactly as the College Board question bank exports it (same wording, math, tables, and figures), organized into 127 patterns. Each question has to be answered correctly 5 times to count as mastered.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` and `npm run build` first run `scripts/build-data.mjs`, which turns `data/` into `public/data/` and `src/generated/`.

## Deploy

It is a static site (`output: "export"`, written to `out/`). On Vercel, import this repository as a new project; `vercel.json` sets the build command and the output directory, so the framework preset doesn't matter. Any static host works too: `npm run build`, then serve `out/`.

Progress is stored in the browser (localStorage) first, so the app works offline. Settings has Export and Import for backups.

### Sync across devices

Settings, Sync across devices: turn it on to get a sync code and a link; open the link (or type the code) on another device and both share the same progress. `api/progress.ts` is a Vercel Function that stores each code's progress as one private file in Vercel Blob, named by a hash of the code. Devices never overwrite each other: answer logs are combined and every question's progress is rebuilt from the combined log (`mergeStates` in `src/lib/sync.ts`); writes are conditional on the version a device last saw, and a device that loses the race merges and tries again. Erasing or importing progress starts a new generation that the other devices adopt. Changes go up at most every 4 minutes while practicing and right away when the tab is hidden, which keeps a month of heavy use inside the free Blob tier.

One-time setup: in the Vercel project, open Storage, create a Blob store with private access, connect it to the project, and redeploy. Without it the app still works; Settings says sync isn't set up.

## How studying works

- **Mastery.** A question is mastered after 5 correct answers. Wrong answers never count toward the 5.
- **Spacing** (`src/lib/engine.ts`, `readiness` in `src/lib/progress.ts`). After a miss, a question needs 2 other questions in between before it can be tried again; after correct answers 1 to 4 it needs 3, 5, 8, then 12 (or an hour either way). This comes from the saved answer log, so it holds across sessions, reloads, and clicking a tile again: opening a question before it is ready shows your last try (your answer, the right answer, the explanation) and records nothing. A session keeps a small working set and grows it only when nothing is due, so repeats still come back near; when everything left in a set is waiting, it mixes in a question from the same topic instead of repeating one early. Questions due at the same time come in a shuffled order.
- **Look.** White on black: every gray is the exact inverse of the original black-on-white palette, figures and math draw in the text color, raster images are inverted, and Desmos uses its inverted colors.
- **Feedback.** A right answer turns green at once. A wrong one turns red and the question stays open: try again as many times as you like; the answer and explanation appear only if you press Reveal solution. Only the first try of each showing counts, so a miss stays a miss even if a later try is right (it comes back after 2 other questions). Nothing moves on by itself: the Next question button (pinned to the bottom of the screen) or Enter goes to the next one. Keys A to D or 1 to 4 answer.
- **The bank is the home page.** Click a tile to practice that pattern starting from that question (a green check or red X in its corner shows how the last try went), or use Practice this topic, Practice all, Bookmarked, or Missed. Once questions are mastered, Final check runs one more pass over them; a miss drops a question back to 3 of 5.
- **Analytics** (`src/lib/stats.ts`). First-try accuracy (the best signal for test day), accuracy by topic and pattern, time per answer, the last 14 days, the weakest patterns, and the most-missed questions.

## Where the content comes from

`data/` holds everything the app is built from:

| File | What it is |
|---|---|
| `taxonomy.txt` | Sections, categories, the 127 patterns, and each question's code, College Board ID, and description |
| `extracted/` | The questions extracted from the two PDF exports, the glyph sprite their math draws from, and raster figures |
| `mathtype.tsv` | LaTeX for the raster equations in older items (keyed by image hash) |
| `overrides.json` | One multi-answer grid-in, and 15 spots where the PDF printed "Math output error" instead of the math (restored from the surrounding text) |
| `teach-math.json`, `teach-rw.json` | The teaching note for each pattern |

### Re-extracting from the PDFs

The PDFs are College Board question bank exports (Chrome prints run through Ghostscript). Body text is Type 3 fonts, math is MathJax output turned into vector paths, and figures are vector drawings, so `scripts/extract/` interprets each page's content stream directly instead of using text extraction. Math is kept as the exact glyph outlines (deduplicated into one sprite) and laid out inline at the right baseline, so it looks the same as in the College Board's rendering.

```bash
pip install pypdf fonttools pillow
python scripts/extract/interpret_all.py SAT_Math.pdf SAT_RW.pdf /tmp/sat-cache
python scripts/extract/layout.py /tmp/sat-cache data/taxonomy.txt /tmp/sat-out
cp /tmp/sat-out/questions.json /tmp/sat-out/glyphs.svg data/extracted/
rm -rf data/extracted/img && cp -r /tmp/sat-out/img data/extracted/img
```

`layout.py` writes `report.txt` with a line per question and any warnings (missing sections, untranscribed images, stray pieces). `preview.py` renders extracted questions to a plain HTML page for checking against the PDF.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
