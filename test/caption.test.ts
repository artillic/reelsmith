import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaption,
  normalizeHashtag,
  IG_CAPTION_LIMIT,
  IG_HASHTAG_LIMIT,
} from '../src/caption.ts';

test('numbers the reasons contiguously from 1', () => {
  const result = buildCaption({ hook: 'Why Bangkok', reasons: ['Cheap rent', 'Great food'] });
  assert.match(result.text, /1\. Cheap rent/);
  assert.match(result.text, /2\. Great food/);
  assert.equal(result.droppedReasons.length, 0);
});

test('normalizes hashtags and strips punctuation', () => {
  assert.equal(normalizeHashtag('##bangkok!'), '#bangkok');
  assert.equal(normalizeHashtag('  expat life '), '#expatlife');
  assert.equal(normalizeHashtag('!!!'), '');
});

test('dedupes hashtags before applying the 30-tag limit', () => {
  const result = buildCaption({
    hook: 'Hook',
    reasons: ['One'],
    hashtags: ['#a', 'a', '#A'],
  });
  assert.equal((result.text.match(/#a\b/g) ?? []).length, 1);
});

test('drops hashtags beyond the Instagram limit and reports them', () => {
  const hashtags = Array.from({ length: IG_HASHTAG_LIMIT + 5 }, (_, i) => `tag${i}`);
  const result = buildCaption({ hook: 'Hook', reasons: ['One'], hashtags });
  assert.equal(result.droppedHashtags.length, 5);
  assert.equal(result.droppedHashtags[0], '#tag30');
});

test('trims trailing reasons to fit the caption limit and reports the drop', () => {
  const reasons = Array.from({ length: 60 }, (_, i) => `Reason ${i + 1} ${'x'.repeat(60)}`);
  const result = buildCaption({ hook: 'A very long list', reasons });

  assert.ok(result.characterCount <= IG_CAPTION_LIMIT, 'caption must fit the limit');
  assert.ok(result.droppedReasons.length > 0, 'over-long input must report dropped reasons');
  // Drops come from the end, so the surviving numbering stays contiguous.
  assert.equal(result.droppedReasons.at(-1), reasons.at(-1));
  assert.match(result.text, /1\. Reason 1/);
});

test('keeps the hook, cta and hashtags even when reasons are dropped', () => {
  const reasons = Array.from({ length: 80 }, () => 'y'.repeat(80));
  const result = buildCaption({
    hook: 'THE HOOK',
    reasons,
    cta: 'Follow for more',
    hashtags: ['thailand'],
  });
  assert.match(result.text, /THE HOOK/);
  assert.match(result.text, /Follow for more/);
  assert.match(result.text, /#thailand/);
});

test('handles an empty reason list without throwing', () => {
  const result = buildCaption({ hook: 'Hook only', reasons: [] });
  assert.equal(result.text, 'Hook only');
});
