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

Progress is stored in the browser (localStorage). Settings has Export and Import so it can be backed up or moved to another device.

## How studying works

- **Mastery.** A question is mastered after 5 correct answers. Wrong answers never count toward the 5.
- **Spacing** (`src/lib/engine.ts`, `readiness` in `src/lib/progress.ts`). After a miss, a question needs 2 other questions in between before it can be tried again; after correct answers 1 to 4 it needs 3, 5, 8, then 12 (or an hour either way). This comes from the saved answer log, so it holds across sessions, reloads, and clicking a tile again: opening a question before it is ready shows your last try (your answer, the right answer, the explanation) and records nothing. A session keeps a small working set and grows it only when nothing is due, so repeats still come back near; when everything left in a set is waiting, it mixes in a question from the same topic instead of repeating one early. Questions due at the same time come in a shuffled order.
- **Feedback.** Picking a choice shows green or red at once, then the College Board explanation and the pattern's teaching note. Nothing moves on by itself: the Next question button (pinned to the bottom of the screen) or Enter goes to the next one. Keys A to D or 1 to 4 answer.
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
