# reelsmith

Automates the trial-reel loop: one list of reasons becomes N hook variants, each
rendered over different b-roll, staggered onto the Metricool calendar, and then
ranked by how cold audiences actually responded.

The point is not "make a reel faster". Trial reels only show to non-followers,
which makes them an A/B test rig. The hook is the variable; everything else is
held constant. This tool exists to run that test at volume and read the result.

## Status

| Stage | State |
|---|---|
| 1. Ideation (hook variants + reasons) | Working |
| 2. B-roll selection (local library + Pexels) | Working |
| 3. Render (vertical video, burned-in hook, cover frame) | Working |
| 4. Caption assembly (Instagram limits enforced) | Working |
| 5. Metricool scheduling | Working as **drafts**; auto-publish and the trial-reel flag need `reel probe` first |
| 6. Performance ranking | Best-effort — depends on what the API returns (see below) |

**The one unknown.** Metricool supports Instagram Trial Reels in its Planner UI,
but its public API docs do not name the field that marks a post as a trial reel.
Nothing here guesses at it. `reel probe` reads back a trial reel you scheduled by
hand and tells you what the field is called; you put that in `.env` and the
scheduler starts sending it. Until then, posts are scheduled as ordinary reels —
or, with the default `--dry-run`-friendly draft mode, as drafts you flip to trial
in the Planner in about five seconds each.

## Requirements

- Node 22+
- `ffmpeg` and `ffprobe` on your PATH (`brew install ffmpeg`)
- An Anthropic API key (ideation)
- A Metricool **Advanced** plan (API access) and an Instagram Business/Creator
  account linked to a Facebook Page
- Somewhere public to host rendered mp4s — Metricool fetches media over HTTP

Instagram gates trial reels to public accounts with 1,000+ followers, and the
feature has to be enabled on the account by Instagram.

## Setup

```sh
cd reelsmith
npm install
cp .env.example .env   # then fill it in
```

## The loop

```sh
# 1. Draft the list and the hook variants. Writes content/<slug>/spec.json.
npm run reel -- ideate --topic "move to Thailand" --reasons 24 --variants 8

# 2. Read spec.json. Cut the weak hooks, fix the reasons. This is the one step
#    that stays human — the model drafts, you decide what ships.

# 3. Render one vertical mp4 + cover + caption per surviving hook.
npm run reel -- render --project content/move-to-thailand

# 4. Upload out/*.mp4 somewhere public, set MEDIA_PUBLIC_BASE_URL, then:
npm run reel -- schedule --project content/move-to-thailand \
  --timezone Asia/Bangkok --gap 300 --daily-cap 4 --dry-run

# 5. Drop --dry-run to actually schedule. Without --auto-publish they land as
#    drafts in the Planner.

# 6. Once they have run, rank the hooks by cold-audience response.
npm run reel -- rank --project content/move-to-thailand
```

`npm run reel -- <args>` in development; `npm run build` then `reel <args>` if
you'd rather install the bin.

## Project layout

One directory per topic, one file per stage. Every stage is re-runnable and every
intermediate is a file you can open, diff, or hand-edit.

```
content/move-to-thailand/
  spec.json        hooks, reasons, hashtags, CTA
  broll/           project-local footage (overrides the shared library)
  out/             <hookId>.mp4, <hookId>.jpg (cover), <hookId>.overlay.png
  captions/        <hookId>.txt
  schedule.json    what was scheduled, when, and the raw API responses
  rank.json        hook performance, ranked
```

## B-roll

The library is a folder tree; the folder name is the tag.

```
library/
  bangkok/rooftop-01.mp4
  bangkok/street-food-02.mp4
  beach/koh-samui-01.mp4
```

Clips are matched against words in the topic, then spread across variants so a
batch does not ride identical footage. `--stock` fills from Pexels instead
(needs `PEXELS_API_KEY`); Pexels footage requires attribution — check their
license before publishing.

## Discovering the trial-reel field

```sh
# 1. Schedule ONE trial reel by hand in the Metricool Planner.
# 2. Then:
npm run reel -- probe
```

The probe fetches your scheduled posts, dumps the raw JSON to `probe-dump.json`,
and reports any field whose key or value mentions "trial". Put the winner in
`.env`:

```sh
METRICOOL_TRIAL_FIELD=instagramData.trialReel   # whatever the probe found
METRICOOL_TRIAL_VALUE=true
```

Dotted paths work. If the probe finds nothing, the raw dump is still there —
schedule one trial reel and one ordinary reel and diff their objects.

## Constraints worth knowing

- Instagram captions cap at **2,200 characters** and **30 hashtags**. Over-long
  lists have trailing reasons dropped, and the CLI tells you exactly which ones.
  Nothing is truncated silently.
- Instagram's API allows **50 posts per 24 hours**. `--daily-cap` cannot exceed it.
- Reels using audio outside Metricool's library **cannot auto-publish** — they
  publish by notification instead. `--audio` bakes a track into the file, which
  forces that path. Prefer Metricool's audio library if you want hands-off.
- Instagram will not let you change publishing mode after a trial reel is
  created, and collaborators cannot be added to trial reels.

## Design notes

- **The hook is a PNG, not `drawtext`.** ffmpeg's `drawtext` has no line
  wrapping and fights non-Latin glyphs. The hook is laid out as SVG, rasterised
  by sharp, and composited as a full-frame overlay.
- **Times are civil, not UTC.** Metricool takes a wall-clock `dateTime` plus a
  separate `timezone`, so converting to UTC would be both wrong and harder.
- **The trial flag is configuration, not code.** An unverified field name would
  have meant guessing in the hot path; instead it is discovered once and stored.
- **Every stage writes files.** Re-running `render` after editing `spec.json`
  costs nothing, and `schedule.json` keeps the raw API responses so `rank` and
  any debugging never need a second round-trip.

## Tests

```sh
npm run check    # typecheck + tests
```

Covers the pure logic: caption limits, schedule planning, text wrapping and SVG
generation, the Metricool payload builder, the probe's key search, and the
ffmpeg argument construction. Rendering and network calls are not mocked —
they are exercised by running the CLI.
