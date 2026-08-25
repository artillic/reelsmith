import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHookSvg, HOOK_STYLES, HOOK_POSITIONS } from '../src/overlay.ts';

const base = { text: '22 reasons to move to Thailand', width: 1080, height: 1920 };

test('every style produces a well-formed full-frame SVG', () => {
  for (const style of HOOK_STYLES) {
    const svg = buildHookSvg({ ...base, style });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, style);
    assert.ok(svg.trimEnd().endsWith('</svg>'), style);
    assert.match(svg, /width="1080"/, style);
  }
});

test('panel draws a dark box, banner a white one, outline neither', () => {
  assert.match(buildHookSvg({ ...base, style: 'panel' }), /<rect[^>]*fill="#000"/);
  assert.match(buildHookSvg({ ...base, style: 'banner' }), /<rect[^>]*fill="#FFFFFF"/);
  assert.equal(/<rect/.test(buildHookSvg({ ...base, style: 'outline' })), false);
});

test('banner uses dark text and no stroke, so it stays legible on white', () => {
  const svg = buildHookSvg({ ...base, style: 'banner' });
  assert.match(svg, /fill="#101216"/);
  assert.equal(/stroke="#000000"/.test(svg), false);
});

test('other styles keep the stroke pass for legibility over any footage', () => {
  for (const style of ['panel', 'outline', 'lower-third'] as const) {
    assert.match(buildHookSvg({ ...base, style }), /stroke="#000000"/, style);
  }
});

test('position moves the block down the frame', () => {
  const y = (position: (typeof HOOK_POSITIONS)[number]) =>
    Number(/<text x="\d+(?:\.\d+)?" y="(\d+(?:\.\d+)?)"/.exec(buildHookSvg({ ...base, position }))?.[1]);
  assert.ok(y('top') < y('middle'), 'top sits above middle');
  assert.ok(y('middle') < y('lower'), 'middle sits above lower');
});

test('a lower third starts smaller than a headline style', () => {
  const size = (style: 'panel' | 'lower-third') =>
    Number(/font-size="(\d+(?:\.\d+)?)"/.exec(buildHookSvg({ ...base, style }))?.[1]);
  assert.ok(size('lower-third') < size('panel'));
});

test('the hook text is escaped in every style', () => {
  for (const style of HOOK_STYLES) {
    const svg = buildHookSvg({ ...base, text: 'Rent & food <$500', style });
    assert.match(svg, /Rent &amp; food/, style);
    assert.equal(/<\$500/.test(svg), false, style);
  }
});

test('size steps down from large through medium to small', () => {
  const size = (s: 'small' | 'medium' | 'large') =>
    Number(/font-size="(\d+(?:\.\d+)?)"/.exec(buildHookSvg({ ...base, size: s }))?.[1]);
  assert.ok(size('small') < size('medium'), 'small is below medium');
  assert.ok(size('medium') < size('large'), 'medium is below large');
});

test('the default look is outline at medium — no box, white text, black edge', () => {
  const svg = buildHookSvg(base);
  assert.equal(/<rect/.test(svg), false, 'no panel by default');
  assert.match(svg, /stroke="#000000"/);
  assert.match(svg, /fill="#FFFFFF"/);
  const defaultSize = Number(/font-size="(\d+(?:\.\d+)?)"/.exec(svg)?.[1]);
  const large = Number(/font-size="(\d+(?:\.\d+)?)"/.exec(buildHookSvg({ ...base, size: 'large' }))?.[1]);
  assert.ok(defaultSize < large, 'the default is smaller than the original setting');
});
