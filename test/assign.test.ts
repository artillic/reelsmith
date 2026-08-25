import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignClips } from '../src/pipeline.ts';
import { projectPaths } from '../src/project.ts';
import type { ReelSpec, HookVariant } from '../src/types.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reelsmith-assign-'));
  delete process.env['BROLL_DIR'];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function clip(name: string): string {
  mkdirSync(join(dir, 'clips'), { recursive: true });
  const path = join(dir, 'clips', name);
  writeFileSync(path, 'x');
  return path;
}

const hook = (id: string, brollPath: string | null = null): HookVariant => ({
  id,
  text: `hook ${id}`,
  variation: id,
  brollPath,
});

const spec = (over: Partial<ReelSpec> = {}): ReelSpec => ({
  slug: 'p',
  topic: 'thailand',
  createdAt: '2026-08-16T00:00:00.000Z',
  caption: 'c',
  seedHook: 'h',
  hooks: [],
  ...over,
});

const paths = () => projectPaths(join(dir, 'project'));

test('the pool is handed out in order, one clip per variant', () => {
  const [a, b, c] = [clip('a.mp4'), clip('b.mp4'), clip('c.mp4')];
  const hooks = [hook('1'), hook('2'), hook('3')];
  const got = assignClips(paths(), spec({ hooks, brollPool: [a, b, c] }), hooks);
  assert.deepEqual([got.get('1'), got.get('2'), got.get('3')], [a, b, c]);
});

test('a short pool loops rather than leaving variants unassigned', () => {
  const [a, b] = [clip('a.mp4'), clip('b.mp4')];
  const hooks = [hook('1'), hook('2'), hook('3'), hook('4')];
  const got = assignClips(paths(), spec({ hooks, brollPool: [a, b] }), hooks);
  assert.deepEqual([got.get('1'), got.get('2'), got.get('3'), got.get('4')], [a, b, a, b]);
});

test('a clip pinned to a hook beats the pool', () => {
  const [a, b, pinned] = [clip('a.mp4'), clip('b.mp4'), clip('pinned.mp4')];
  const hooks = [hook('1'), hook('2', pinned), hook('3')];
  const got = assignClips(paths(), spec({ hooks, brollPool: [a, b] }), hooks);
  assert.equal(got.get('2'), pinned, 'the pinned clip is kept');
  // Pinned hooks do not consume a pool slot, so the rest still walk the pool in order.
  assert.deepEqual([got.get('1'), got.get('3')], [a, b]);
});

test('pool entries that no longer exist are skipped', () => {
  const real = clip('real.mp4');
  const hooks = [hook('1'), hook('2')];
  const got = assignClips(paths(), spec({ hooks, brollPool: [join(dir, 'gone.mp4'), real] }), hooks);
  assert.deepEqual([got.get('1'), got.get('2')], [real, real]);
});

test('a pinned clip that has vanished falls back to the pool', () => {
  const a = clip('a.mp4');
  const hooks = [hook('1', join(dir, 'vanished.mp4'))];
  const got = assignClips(paths(), spec({ hooks, brollPool: [a] }), hooks);
  assert.equal(got.get('1'), a);
});

test('no pool and no library leaves the map empty rather than throwing', () => {
  const hooks = [hook('1')];
  const got = assignClips(paths(), spec({ hooks, brollPool: [] }), hooks);
  assert.equal(got.size, 0);
});

test('with no pool it falls back to the tagged library', () => {
  process.env['BROLL_DIR'] = join(dir, 'clips');
  const a = clip('a.mp4');
  const hooks = [hook('1')];
  const got = assignClips(paths(), spec({ hooks, brollPool: [] }), hooks);
  assert.equal(got.get('1'), a);
});

test('the schedule order is stable for a project but not always seed-first', async () => {
  const { shuffleBySlug } = await import('../src/pipeline.ts');
  const items = ['seed', 'a', 'b', 'c', 'd', 'e'];

  // Stable: a dry-run preview must match what actually gets scheduled.
  assert.deepEqual(shuffleBySlug(items, 'my-project'), shuffleBySlug(items, 'my-project'));
  assert.deepEqual([...shuffleBySlug(items, 'x')].sort(), [...items].sort(), 'nothing lost or duplicated');

  // Across projects the seed hook must not monopolise the first slot, or
  // time-of-day is perfectly correlated with hook identity in every test.
  const slugs = Array.from({ length: 40 }, (_, i) => `project-${i}`);
  const seedFirst = slugs.filter((slug) => shuffleBySlug(items, slug)[0] === 'seed').length;
  assert.ok(seedFirst < slugs.length, 'the seed hook cannot always be first');
  assert.ok(seedFirst > 0, 'nor should it never be first');
});
