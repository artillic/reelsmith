import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnvFile, loadEnv } from '../src/config.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reelsmith-env-'));
  delete process.env['BROLL_DIR'];
  delete process.env['SOME_KEY'];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => readFileSync(join(dir, '.env'), 'utf8');

test('a path ending in a space survives a write/read round-trip', () => {
  // The real case: a Google Drive folder named "USEABLE BROLL CLIPS ".
  const path = '/Users/x/My Drive/USEABLE BROLL CLIPS ';
  updateEnvFile({ BROLL_DIR: path }, dir);

  delete process.env['BROLL_DIR'];
  loadEnv(dir);
  assert.equal(process.env['BROLL_DIR'], path, 'the trailing space must survive');
});

test('values needing no quoting are written plainly', () => {
  updateEnvFile({ SOME_KEY: 'plain-value' }, dir);
  assert.match(read(), /^SOME_KEY=plain-value$/m);
});

test('a value with a trailing space is quoted on disk', () => {
  updateEnvFile({ BROLL_DIR: '/a/b ' }, dir);
  assert.match(read(), /^BROLL_DIR="\/a\/b "$/m);
});

test('a value containing a hash is quoted so it is not read as a comment', () => {
  updateEnvFile({ SOME_KEY: 'abc#def' }, dir);
  delete process.env['SOME_KEY'];
  loadEnv(dir);
  assert.equal(process.env['SOME_KEY'], 'abc#def');
});

test('existing keys are updated in place and comments are preserved', () => {
  writeFileSync(join(dir, '.env'), '# a comment\nSOME_KEY=old\n# trailing note\n', 'utf8');
  updateEnvFile({ SOME_KEY: 'new' }, dir);

  const text = read();
  assert.match(text, /^SOME_KEY=new$/m);
  assert.match(text, /# a comment/);
  assert.match(text, /# trailing note/);
});

test('new keys are appended rather than replacing the file', () => {
  writeFileSync(join(dir, '.env'), 'FIRST=1\n', 'utf8');
  updateEnvFile({ SECOND: '2' }, dir);
  assert.match(read(), /^FIRST=1$/m);
  assert.match(read(), /^SECOND=2$/m);
});
