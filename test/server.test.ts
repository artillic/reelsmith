import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret, applySettings, metricoolCheck, storageCheck } from '../src/server.ts';
import { startJob, getJob, resetJobs } from '../src/jobs.ts';
import { libraryRoots } from '../src/pipeline.ts';

beforeEach(() => {
  resetJobs();
  delete process.env['BROLL_DIR'];
});

test('masks a secret to its last four characters', () => {
  assert.equal(maskSecret('sk-ant-abcd1234'), '••••1234');
  assert.equal(maskSecret('abc'), '••••');
});

test('a masked secret sent back unchanged is left alone, not saved as dots', () => {
  const updates = applySettings({ ANTHROPIC_API_KEY: '••••1234', METRICOOL_BLOG_ID: '999' });
  assert.equal('ANTHROPIC_API_KEY' in updates, false);
  assert.equal(updates['METRICOOL_BLOG_ID'], '999');
});

test('a genuinely new secret is saved', () => {
  const updates = applySettings({ ANTHROPIC_API_KEY: 'sk-ant-new' });
  assert.equal(updates['ANTHROPIC_API_KEY'], 'sk-ant-new');
});

test('ignores keys that are not settings', () => {
  const updates = applySettings({ PATH: '/evil', ANTHROPIC_API_KEY: 'k' });
  assert.equal('PATH' in updates, false);
});

test('a failing check names what is missing rather than what is present', () => {
  const check = metricoolCheck((key) => key !== 'METRICOOL_TOKEN');
  assert.equal(check.ok, false);
  assert.match(check.detail, /missing API token/);
});

test('the metricool check passes only when all three values are set', () => {
  assert.equal(metricoolCheck(() => true).ok, true);
  assert.equal(metricoolCheck(() => false).ok, false);
});

test('storage passes on a custom base url without any Supabase config', () => {
  const check = storageCheck((key) => key === 'MEDIA_PUBLIC_BASE_URL');
  assert.equal(check.ok, true);
});

test('storage names the single missing Supabase value', () => {
  const check = storageCheck((key) => key === 'SUPABASE_URL');
  assert.equal(check.ok, false);
  assert.match(check.detail, /service_role key/);
});

test('library roots drop configured folders that do not exist', () => {
  process.env['BROLL_DIR'] = '/definitely/not/here:/also/not/here';
  // The project's own library/ dir survives; the bogus paths are filtered out.
  assert.equal(libraryRoots().includes('/definitely/not/here'), false);
  assert.deepEqual(libraryRoots(), ['library']);
});

test('library roots accept several colon-separated folders', () => {
  process.env['BROLL_DIR'] = 'library:/nope';
  assert.deepEqual(libraryRoots(), ['library', 'library']);
});

test('a job captures logger output and completes', async () => {
  const job = startJob('test', async (log) => {
    log.step('starting');
    log.ok('done');
    return { value: 42 };
  });
  await new Promise((r) => setTimeout(r, 20));

  const finished = getJob(job.id);
  assert.equal(finished?.status, 'done');
  assert.deepEqual(finished?.result, { value: 42 });
  assert.deepEqual(
    finished?.lines.map((l) => l.kind),
    ['step', 'ok'],
  );
});

test('a failing job records the error instead of rejecting', async () => {
  const job = startJob('boom', async () => {
    throw new Error('it broke');
  });
  await new Promise((r) => setTimeout(r, 20));

  const finished = getJob(job.id);
  assert.equal(finished?.status, 'error');
  assert.equal(finished?.error, 'it broke');
  assert.equal(finished?.lines.at(-1)?.kind, 'error');
});
