import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, recordRender, updateVariant, stalenessReasons, variantStage } from '../src/state.ts';
import { projectPaths, ensureProjectDirs } from '../src/project.ts';
import type { ReelSpec, HookVariant } from '../src/types.ts';

let dir: string;
let paths: ReturnType<typeof projectPaths>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reelsmith-state-'));
  paths = projectPaths(join(dir, 'p'));
  ensureProjectDirs(paths);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hook = (text: string): HookVariant => ({ id: 'h', text, variation: 'v', brollPath: null });
const spec = (over: Partial<ReelSpec> = {}): ReelSpec => ({
  slug: 'p', topic: 't', createdAt: 'x', caption: 'c', seedHook: 's', hooks: [], ...over,
});

function render(text = 'hook one', clip = '/clips/a.mp4') {
  const videoPath = join(paths.out, 'h.mp4');
  writeFileSync(videoPath, 'video-bytes');
  recordRender(paths, 'h', {
    hookText: text, clip, style: 'outline', size: 'medium', position: 'top', videoPath,
  });
}

test('a render records what produced it, including size on disk', () => {
  render();
  const record = readState(paths).variants['h']?.render;
  assert.equal(record?.hookText, 'hook one');
  assert.equal(record?.clip, '/clips/a.mp4');
  assert.ok((record?.bytes ?? 0) > 0, 'file size is recorded');
});

test('an unchanged variant is not stale', () => {
  render();
  const state = readState(paths).variants['h'] ?? {};
  assert.deepEqual(stalenessReasons(spec(), hook('hook one'), state, '/clips/a.mp4'), []);
});

test('editing the hook makes it stale, and says so', () => {
  render();
  const state = readState(paths).variants['h'] ?? {};
  const reasons = stalenessReasons(spec(), hook('a different hook'), state, '/clips/a.mp4');
  assert.deepEqual(reasons, ['the hook was edited']);
});

test('changing the clip or the look makes it stale', () => {
  render();
  const state = readState(paths).variants['h'] ?? {};
  assert.deepEqual(stalenessReasons(spec(), hook('hook one'), state, '/clips/b.mp4'), ['the clip changed']);
  assert.deepEqual(stalenessReasons(spec({ size: 'large' }), hook('hook one'), state, '/clips/a.mp4'), ['the size changed']);
  assert.deepEqual(stalenessReasons(spec({ style: 'panel' }), hook('hook one'), state, '/clips/a.mp4'), ['the style changed']);
});

test('a never-rendered variant is not reported as stale', () => {
  assert.deepEqual(stalenessReasons(spec(), hook('x'), {}, '/clips/a.mp4'), []);
});

test('stages progress made -> uploaded -> scheduled', () => {
  render();
  const at = readState(paths).variants['h']?.render?.at as string;
  assert.equal(variantStage(true, readState(paths).variants['h'] ?? {}, false), 'made');

  updateVariant(paths, 'h', (c) => ({ ...c, upload: { at: 'now', url: 'u', renderedAt: at } }));
  assert.equal(variantStage(true, readState(paths).variants['h'] ?? {}, false), 'uploaded');

  updateVariant(paths, 'h', (c) => ({
    ...c,
    schedule: { at: 'now', publishAt: 'p', timezone: 'UTC', postId: '1', autoPublish: false, trialReel: false, renderedAt: at },
  }));
  assert.equal(variantStage(true, readState(paths).variants['h'] ?? {}, false), 'scheduled');
});

test('re-rendering clears the old upload, so a stale URL is never reported as current', () => {
  render();
  const at = readState(paths).variants['h']?.render?.at as string;
  updateVariant(paths, 'h', (c) => ({ ...c, upload: { at: 'now', url: 'u', renderedAt: at } }));

  render('a different hook');
  assert.equal(readState(paths).variants['h']?.upload, undefined);
  assert.equal(variantStage(true, readState(paths).variants['h'] ?? {}, false), 'made');
});

test('a schedule from a previous render does not count as scheduled', () => {
  render();
  updateVariant(paths, 'h', (c) => ({
    ...c,
    schedule: { at: 'x', publishAt: 'p', timezone: 'UTC', postId: '1', autoPublish: false, trialReel: false, renderedAt: 'an-older-render' },
  }));
  assert.equal(variantStage(true, readState(paths).variants['h'] ?? {}, false), 'made');
});

test('stale outranks made, and a missing video outranks everything', () => {
  render();
  const state = readState(paths).variants['h'] ?? {};
  assert.equal(variantStage(true, state, true), 'stale');
  assert.equal(variantStage(false, state, false), 'not-made');
});

test('a corrupt state file is treated as empty rather than fatal', () => {
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(join(paths.root, 'state.json'), '{not json');
  assert.deepEqual(readState(paths), { variants: {} });
});

test('a stale variant is excluded from publishing, not merely warned about', async () => {
  const { partitionVariants } = await import('../src/pipeline.ts');
  render('the original hook');

  const spec2: ReelSpec = {
    slug: 'p', topic: 't', createdAt: 'x', caption: 'c', seedHook: 's',
    // The hook text was edited after the video was made.
    hooks: [{ id: 'h', text: 'an edited hook', variation: 'v', brollPath: null }],
  };
  const parts = partitionVariants(paths, spec2);
  assert.equal(parts.current.length, 0, 'a stale variant must not be publishable');
  assert.equal(parts.stale.length, 1);
  assert.equal(parts.stale[0]?.id, 'h');
});

test('an unedited variant remains publishable', async () => {
  const { partitionVariants } = await import('../src/pipeline.ts');
  render('the original hook', '/clips/a.mp4');

  const spec2: ReelSpec = {
    slug: 'p', topic: 't', createdAt: 'x', caption: 'c', seedHook: 's',
    brollPool: ['/clips/a.mp4'],
    hooks: [{ id: 'h', text: 'the original hook', variation: 'v', brollPath: null }],
  };
  const parts = partitionVariants(paths, spec2);
  assert.equal(parts.stale.length, 0);
  assert.equal(parts.current.length, 1);
});

test('a hook with no video is counted as missing, not stale', async () => {
  const { partitionVariants } = await import('../src/pipeline.ts');
  const spec2: ReelSpec = {
    slug: 'p', topic: 't', createdAt: 'x', caption: 'c', seedHook: 's',
    hooks: [{ id: 'never-made', text: 'x', variation: 'v', brollPath: null }],
  };
  const parts = partitionVariants(paths, spec2);
  assert.equal(parts.missing.length, 1);
  assert.equal(parts.stale.length, 0);
  assert.equal(parts.current.length, 0);
});
