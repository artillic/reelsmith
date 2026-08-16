import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCaption, IG_CAPTION_LIMIT } from '../src/caption.ts';
import { captionFor } from '../src/pipeline.ts';
import type { ReelSpec } from '../src/types.ts';

const spec = (over: Partial<ReelSpec> = {}): ReelSpec => ({
  slug: 'x',
  topic: 'move to Thailand',
  createdAt: '2026-08-16T00:00:00.000Z',
  caption: '1. $5 massages\n2. Unlimited sun',
  seedHook: '22 reasons to move to Thailand',
  hooks: [],
  ...over,
});

test('an authored caption is posted exactly as written', () => {
  const text = '1. $5 massages\n\n   odd   spacing kept\n#thailand';
  const result = captionFor(spec({ caption: text }), 'any hook');
  assert.equal(result.text, text);
});

test('the same caption is used for every hook — the hook is the only variable', () => {
  const s = spec();
  assert.equal(captionFor(s, 'hook one').text, captionFor(s, 'hook two').text);
});

test('an over-long caption is reported, never silently trimmed', () => {
  const long = 'x'.repeat(IG_CAPTION_LIMIT + 50);
  const result = checkCaption(long);
  assert.equal(result.text.length, IG_CAPTION_LIMIT + 50, 'the text must come back untouched');
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? '', /Remove about 50/);
});

test('a caption within the limits reports no problems', () => {
  assert.deepEqual(checkCaption('1. Cheap rent\n2. Great food #thailand').problems, []);
});

test('counts hashtags and flags going over thirty', () => {
  const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
  const result = checkCaption(tags);
  assert.equal(result.hashtagCount, 31);
  assert.match(result.problems[0] ?? '', /31 hashtags/);
});

test('does not count a bare hash or mid-word hash as a hashtag', () => {
  assert.equal(checkCaption('costs #1 in my book, email a#b').hashtagCount, 1);
});

test('an empty caption is flagged', () => {
  assert.match(checkCaption('   ').problems[0] ?? '', /empty/);
});

test('projects created before authored captions still build one from reasons', () => {
  const legacy = spec({
    caption: '',
    reasons: ['Cheap rent', 'Great food'],
    hashtags: ['thailand'],
    cta: 'Save this',
  });
  const result = captionFor(legacy, 'A hook');
  assert.match(result.text, /A hook/);
  assert.match(result.text, /1\. Cheap rent/);
  assert.match(result.text, /#thailand/);
});
