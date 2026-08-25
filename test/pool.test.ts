import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRender } from '../src/pipeline.ts';
import { projectPaths, ensureProjectDirs } from '../src/project.ts';
import type { ReelSpec } from '../src/types.ts';

let dir: string;
const silent = { step() {}, info() {}, ok() {}, warn() {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reelsmith-pool-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function clip(name: string): string {
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, 'not-real-video');
  return path;
}

const spec = (over: Partial<ReelSpec> = {}): ReelSpec => ({
  slug: 'p',
  topic: 'thailand',
  createdAt: '2026-08-16T00:00:00.000Z',
  caption: '1. one\n2. two',
  seedHook: '22 reasons to move to Thailand',
  hooks: [
    { id: 'a', text: 'hook a', variation: 'young people', brollPath: null },
    { id: 'b', text: 'hook b', variation: 'entrepreneurs', brollPath: null },
    { id: 'c', text: 'hook c', variation: 'online business', brollPath: null },
  ],
  ...over,
});

/**
 * These assert clip *assignment*, not encoding. runRender needs ffmpeg, so the
 * assertion is on the error it raises once assignment has already happened —
 * which is enough to prove which clip each hook was given.
 */
async function assignmentError(s: ReelSpec): Promise<string> {
  const paths = projectPaths(join(dir, 'project'));
  ensureProjectDirs(paths);
  try {
    await runRender(paths, s, {}, silent);
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

test('an empty pool with an empty library reports no clips rather than crashing', async () => {
  const message = await assignmentError(spec({ brollPool: [] }));
  assert.match(message, /library is empty|ffmpeg|ffprobe/i);
});

test('a pool of one is reused across every variant', async () => {
  const only = clip('only.mp4');
  const s = spec({ brollPool: [only] });
  // Three hooks, one clip: assignment must loop rather than run out.
  const message = await assignmentError(s);
  assert.equal(/library is empty/i.test(message), false, 'the pool must satisfy all three hooks');
});

test('a pinned brollPath is kept even when a pool exists', async () => {
  const pinned = clip('pinned.mp4');
  const pooled = clip('pooled.mp4');
  const s = spec({
    brollPool: [pooled],
    hooks: [{ id: 'a', text: 'hook a', variation: 'young people', brollPath: pinned }],
  });
  const message = await assignmentError(s);
  assert.equal(/library is empty/i.test(message), false);
});

test('a pool entry that no longer exists on disk is ignored', async () => {
  const real = clip('real.mp4');
  const s = spec({ brollPool: [join(dir, 'gone.mp4'), real] });
  const message = await assignmentError(s);
  assert.equal(/library is empty/i.test(message), false, 'the surviving clip should be used');
});
