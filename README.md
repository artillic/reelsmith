# reelsmith

You write the caption and one hook. The tool writes close variations of that
hook, renders each over b-roll, staggers them onto the Metricool calendar, and
ranks them by how cold audiences actually responded.

The point is not "make a reel faster". Trial reels only show to non-followers,
which makes them an A/B test rig. The hook is the variable; everything else is
held constant. This tool exists to run that test at volume and read the result.

Two consequences of that, both deliberate:

**The caption is yours and is posted verbatim.** It is the same on every
variant, because a caption that changes alongside the hook makes the test
meaningless. Nothing is rewritten, reordered or trimmed — an over-long caption
is reported, not repaired.

**The hook's look is a project-level choice, not a test variable.** Four styles
(panel, outline, banner, lower third) and three positions, previewed live in the
dashboard over a frame of the actual clip — so wrapping and collisions are
visible before any encoding happens.

**Variants change the qualifier and nothing else.** From
`22 reasons you should move to Thailand` you get:

```
22 reasons why Thailand is the best place to start an online business
22 reasons young people should move to Thailand
22 reasons every entrepreneur should move to Thailand
22 reasons you should move to Thailand while you're young
```

Same number, same noun, same subject — only who or what it's for moves. You do
not get contrarian rewrites, questions, comparisons or specific-detail hooks:
those change the format rather than the framing, so the results stop being
comparable. Your own hook is always kept as variant one, so it is in the test.

## Status

| Stage | State |
|---|---|
| 1. Hook variations from your seed hook | Working |
| 2. B-roll selection (local library + Pexels) | Working |
| 3. Render (vertical video, burned-in hook, cover frame) | Working |
| 4. Caption assembly (Instagram limits enforced) | Working |
| 5. Upload to public storage (Supabase) | Working |
| 6. Metricool scheduling | Working as **drafts**; auto-publish and the trial-reel flag need `reel probe` first |
| 7. Performance ranking | Best-effort — depends on what the API returns (see below) |

**The one unknown.** Metricool supports Instagram Trial Reels in its Planner UI,
but its public API docs do not name the field that marks a post as a trial reel.
Nothing here guesses at it. `reel probe` reads back a trial reel you scheduled by
hand and tells you what the field is called; you put that in `.env` and the
scheduler starts sending it. Until then, posts are scheduled as ordinary reels —
or, with the default `--dry-run`-friendly draft mode, as drafts you flip to trial
in the Planner in about five seconds each.

## Media hosting

Metricool fetches your video **at publish time**, not when you schedule it. That
makes the storage choice load-bearing: a link that returns an HTML wrapper, or
that rate-limits automated fetchers, produces a post that fails at 9am and tells
you nothing until afterwards.

What works is a plain public bucket with path-addressable URLs — `<base>/<file>.mp4`
resolving to raw bytes. Supabase Storage, Cloudflare R2 and S3 all qualify.
Google Drive does not: share links serve an HTML preview page, and every file
gets an opaque id rather than a path, so `<base>/<filename>` cannot be
constructed at all.

`reel upload` targets Supabase and then makes a HEAD request against the result
to confirm it is genuinely public before you schedule anything against it.

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

Metricool credentials:

| Value | Where |
|---|---|
| `METRICOOL_TOKEN` | Metricool → Account Settings → API |
| `METRICOOL_USER_ID` | Any dashboard URL: `app.metricool.com/evolution/web?blogId=XXXX&userId=YYYY` |
| `METRICOOL_BLOG_ID` | The brand you post from — same URL, or `npm run reel -- brands` |

`reel brands` needs only the token and user id, so fill those two first and let
it tell you the blog id.

## The dashboard

```sh
npm install
npm run dashboard
```

Open `http://localhost:4000`. Everything happens there — keys, b-roll folder,
topic, hook review, video previews, caption editing, scheduling. Five screens,
left to right, in the order you use them.

The server binds to loopback only. It writes `.env` and can publish posts, so it
must never be reachable from the network.

Point the **B-roll** screen at any folder of vertical clips, including a Google
Drive for Desktop folder — those are ordinary files on disk, so nothing is
copied or re-uploaded. Sub-folder names become tags and are matched against the
topic.

Everything below is the same pipeline from a terminal, for when you want to
script it.

## The loop

```sh
# 0. Confirm the credentials work and find your brand id.
npm run reel -- brands

# 1. Write your caption to a file, then generate hook variations.
npm run reel -- ideate --hook "22 reasons to move to Thailand" --caption caption.txt --variants 4

# 2. Read spec.json. Cut the variants you wouldn't post. Set a hook's
#    "brollPath" to choose its clip by hand; leave it null to pick automatically.

# 3. Render one vertical mp4 + cover + caption per surviving hook.
npm run reel -- render --project content/move-to-thailand

# 4. Push them to the public bucket (verifies they're actually readable).
npm run reel -- upload --project content/move-to-thailand

# 5. Plan the stagger without sending anything.
npm run reel -- schedule --project content/move-to-thailand \
  --timezone Asia/Bangkok --gap 300 --daily-cap 4 --dry-run

# 6. Drop --dry-run to actually schedule. Without --auto-publish they land as
#    drafts in the Planner.

# 7. Once they have run, rank the hooks by cold-audience response.
npm run reel -- rank --project content/move-to-thailand
```

`npm run reel -- <args>` in development; `npm run build` then `reel <args>` if
you'd rather install the bin.

## Knowing what happened

Work runs on the server, not in the browser tab, so navigating away or reloading
loses nothing — an activity bar reattaches to whatever is running or last ran,
with its full log.

Each stage records the inputs it used in `state.json`, so a variant reports a
real status rather than a file count: *not made*, *video made*, *uploaded*,
*scheduled*, or **needs re-making** when the hook, clip, style, size or position
has changed since it was rendered — and it names which. Re-rendering clears the
recorded upload, so a stale URL is never reported as current, and Publish counts
only variants that are genuinely up to date.

## Project layout

One directory per topic, one file per stage. Every stage is re-runnable and every
intermediate is a file you can open, diff, or hand-edit.

```
content/move-to-thailand/
  spec.json        caption, seed hook, variants, chosen b-roll, text style
  state.json       what was made, uploaded and scheduled, and from which inputs
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
