import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostPayload } from '../src/metricool.ts';
import { findKeys, leafPaths } from '../src/probe.ts';
import { buildFfmpegArgs } from '../src/render.ts';
import { renderDefaults } from '../src/config.ts';

const basePayload = {
  text: 'caption',
  publishAt: '2026-08-16T09:00:00',
  timezone: 'Asia/Bangkok',
  media: ['https://cdn.example.com/a.mp4'],
  autoPublish: false,
};

test('builds the documented Metricool post shape', () => {
  const payload = buildPostPayload(basePayload);
  assert.deepEqual(payload['publicationDate'], {
    dateTime: '2026-08-16T09:00:00',
    timezone: 'Asia/Bangkok',
  });
  assert.deepEqual(payload['providers'], [{ network: 'instagram' }]);
  assert.equal(payload['autoPublish'], false);
});

test('omits the trial field entirely when it has not been discovered', () => {
  const payload = buildPostPayload(basePayload);
  assert.equal(JSON.stringify(payload).includes('trial'), false);
});

test('sets a flat trial field discovered by the probe', () => {
  const payload = buildPostPayload({ ...basePayload, trialField: 'trialReel', trialValue: true });
  assert.equal(payload['trialReel'], true);
});

test('sets a nested trial field from a dotted path', () => {
  const payload = buildPostPayload({
    ...basePayload,
    trialField: 'instagramData.trialReel',
    trialValue: true,
  });
  assert.deepEqual(payload['instagramData'], { trialReel: true });
});

test('finds candidate trial keys anywhere in a nested response', () => {
  const hits = findKeys({ data: [{ id: 1, instagramData: { isTrialReel: true } }] }, /trial/i);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, '$.data[0].instagramData.isTrialReel');
});

test('finds a trial marker held as a string value', () => {
  const hits = findKeys({ postType: 'TRIAL_REEL' }, /trial/i);
  assert.equal(hits[0]?.path, '$.postType');
});

test('flattens leaves so two posts can be diffed', () => {
  const paths = leafPaths({ a: { b: 1 }, c: [true] });
  assert.equal(paths.get('$.a.b'), 1);
  assert.equal(paths.get('$.c[0]'), true);
});

test('builds an ffmpeg command that fills the frame and overlays the hook', () => {
  const args = buildFfmpegArgs({
    brollPath: 'clip.mp4',
    overlayPath: 'hook.png',
    outPath: 'out.mp4',
    config: renderDefaults,
  });
  const filter = args[args.indexOf('-filter_complex') + 1] ?? '';
  assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.match(filter, /crop=1080:1920/);
  assert.match(filter, /overlay=0:0/);
  // Source audio is optional so silent b-roll still renders.
  assert.ok(args.includes('0:a?'));
  assert.equal(args.at(-1), 'out.mp4');
});

test('maps the replacement track when an audio file is supplied', () => {
  const args = buildFfmpegArgs({
    brollPath: 'clip.mp4',
    overlayPath: 'hook.png',
    outPath: 'out.mp4',
    config: renderDefaults,
    audioPath: 'track.m4a',
  });
  assert.ok(args.includes('2:a'));
  assert.equal(args.includes('0:a?'), false);
});

test('audio is omitted entirely when the field has not been discovered', () => {
  const payload = buildPostPayload({ ...basePayload, audioValue: 'audio-123' });
  assert.equal(JSON.stringify(payload).includes('audio'), false);
});

test('audio is omitted when the field is known but no track is chosen', () => {
  const payload = buildPostPayload({ ...basePayload, audioField: 'instagramData.audioId', audioValue: '' });
  assert.equal(JSON.stringify(payload).includes('audio'), false);
});

test('a discovered audio field and a chosen track are sent together', () => {
  const payload = buildPostPayload({
    ...basePayload,
    audioField: 'instagramData.audioId',
    audioValue: 'audio-123',
  });
  assert.deepEqual(payload['instagramData'], { audioId: 'audio-123' });
});

test('trial and audio fields coexist under the same nested object', () => {
  const payload = buildPostPayload({
    ...basePayload,
    trialField: 'instagramData.trialReel',
    trialValue: true,
    audioField: 'instagramData.audioId',
    audioValue: 'audio-123',
  });
  assert.deepEqual(payload['instagramData'], { trialReel: true, audioId: 'audio-123' });
});

test('the probe looks for audio under several plausible names', async () => {
  const { PROBE_PATTERNS } = await import('../src/probe.ts');
  const audio = PROBE_PATTERNS.find((p) => p.id === 'audio');
  assert.ok(audio, 'an audio family must be probed');
  for (const key of ['audioId', 'soundName', 'musicTrack', 'trackId']) {
    assert.ok(audio.pattern.test(key), `${key} should be recognised`);
  }
  assert.equal(audio.pattern.test('publicationDate'), false, 'unrelated keys must not match');
});

test('requests accept any content type, not just JSON', async () => {
  const { MetricoolClient } = await import('../src/metricool.ts');
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch;

  try {
    const client = new MetricoolClient({ token: 't', userId: '1', blogId: '2' });
    await client.normalizeMedia('https://cdn.example.com/a.mp4');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Forcing application/json made the normalize endpoint answer 500
  // "No acceptable representation" — it does not produce JSON.
  assert.equal(seen[0]?.headers['Accept'], '*/*');
  assert.equal(seen[0]?.headers['X-Mc-Auth'], 't');
  assert.match(seen[0]?.url ?? '', /userId=1&blogId=2/);
});

test('a non-JSON response still comes back readable rather than throwing', async () => {
  const { MetricoolClient } = await import('../src/metricool.ts');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('plain text body', { status: 200 })) as typeof fetch;

  try {
    const client = new MetricoolClient({ token: 't', userId: '1', blogId: '2' });
    const res = await client.normalizeMedia('https://cdn.example.com/a.mp4');
    assert.equal(res.ok, true);
    assert.equal(res.data, null, 'unparseable bodies yield null data');
    assert.equal(res.text, 'plain text body', 'but the raw text is always available');
  } finally {
    globalThis.fetch = realFetch;
  }
});
