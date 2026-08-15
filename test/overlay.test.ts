import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, fitText, escapeXml, buildHookSvg, estimateTextWidth } from '../src/overlay.ts';

test('escapes XML so a hook with an ampersand cannot break the SVG', () => {
  assert.equal(escapeXml('Food & rent <$500'), 'Food &amp; rent &lt;$500');
});

test('wraps to lines that fit the given width', () => {
  const lines = wrapText('one two three four five six seven', 100, 300);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(estimateTextWidth(line, 100) <= 300 || line.split(' ').length === 1);
  }
});

test('keeps short text on a single line', () => {
  assert.deepEqual(wrapText('Move to Thailand', 60, 2000), ['Move to Thailand']);
});

test('gives an unbreakably long word its own line rather than dropping it', () => {
  const lines = wrapText('short supercalifragilisticexpialidocious', 100, 200);
  assert.ok(lines.some((l) => l.includes('supercalifragilistic')));
});

test('shrinks the font until the text fits the line budget', () => {
  const long = 'twenty reasons you should pack up your entire life and move to bangkok this year';
  const { fontSize, lines } = fitText(long, 100, 900, 4);
  assert.ok(fontSize < 100, 'font should shrink for over-long hooks');
  assert.ok(lines.length <= 4);
});

test('does not shrink text that already fits', () => {
  const { fontSize } = fitText('Short hook', 100, 900, 4);
  assert.equal(fontSize, 100);
});

test('emits a well-formed full-frame SVG containing the hook text', () => {
  const svg = buildHookSvg({ text: 'Move to Thailand', width: 1080, height: 1920 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /width="1080"/);
  assert.match(svg, /height="1920"/);
  // The hook is wrapped across <text> lines, so assert on the words, not the phrase.
  for (const word of ['Move', 'to', 'Thailand']) assert.match(svg, new RegExp(word));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
});

test('draws each line twice — a stroke pass then a fill pass', () => {
  const svg = buildHookSvg({ text: 'One line', width: 1080, height: 1920 });
  assert.equal((svg.match(/One line/g) ?? []).length, 2);
  assert.match(svg, /stroke="#000000"/);
  assert.match(svg, /fill="#FFFFFF"/);
});
