import { optionalEnv } from './config.ts';

/**
 * The hook is rendered to a transparent PNG and composited by ffmpeg, rather
 * than drawn with ffmpeg's `drawtext`. drawtext has no line wrapping, no stroke
 * control worth the name, and fights any glyph outside Latin-1.
 *
 * SVG has no auto-wrap either, so wrapping is done here against an estimated
 * advance width. The estimate is deliberately conservative — a hook that wraps
 * one line early is fine, one that overflows the frame is not.
 */

const DEFAULT_FONT_STACK =
  '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif';

/** The look of the burned-in hook. */
export type HookStyle = 'panel' | 'outline' | 'banner' | 'lower-third';

/**
 * Where the block sits. Instagram overlays its own UI along the bottom and
 * puts the caption there, so nothing useful lives below roughly 0.75.
 */
export type HookPosition = 'top' | 'middle' | 'lower';

export const HOOK_STYLES: HookStyle[] = ['panel', 'outline', 'banner', 'lower-third'];
export const HOOK_POSITIONS: HookPosition[] = ['top', 'middle', 'lower'];

const POSITION_ANCHORS: Record<HookPosition, number> = {
  top: 0.24,
  middle: 0.44,
  lower: 0.66,
};

export interface HookCardOptions {
  text: string;
  width: number;
  height: number;
  style?: HookStyle;
  position?: HookPosition;
  /** Overrides the position anchor when set. Fraction of frame height. */
  anchor?: number;
  /** Starting font size, shrunk automatically until the text fits. */
  fontSize?: number;
  maxLines?: number;
}

/** Average glyph advance as a fraction of font size, for a bold sans face. */
const ADVANCE_RATIO = 0.58;
const LINE_HEIGHT = 1.15;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * ADVANCE_RATIO;
}

/** Greedy wrap. A single word longer than the line is left to overflow its own line. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** Shrinks the font until the wrapped text fits within `maxLines`. */
export function fitText(
  text: string,
  startSize: number,
  maxWidth: number,
  maxLines: number,
): { fontSize: number; lines: string[] } {
  let fontSize = startSize;
  let lines = wrapText(text, fontSize, maxWidth);
  while (lines.length > maxLines && fontSize > 24) {
    fontSize -= 4;
    lines = wrapText(text, fontSize, maxWidth);
  }
  return { fontSize, lines };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildHookSvg(opts: HookCardOptions): string {
  const {
    text,
    width,
    height,
    style = 'panel',
    position = 'top',
    maxLines = 4,
  } = opts;

  const fontFamily = optionalEnv('REEL_FONT_FAMILY') ?? DEFAULT_FONT_STACK;
  // A lower third is a caption, not a headline, so it starts smaller.
  const baseSize = style === 'lower-third' ? width * 0.062 : width * 0.093;
  const startSize = opts.fontSize ?? Math.round(baseSize);

  const margin = Math.round(width * 0.08);
  const maxWidth = width - margin * 2;
  const { fontSize, lines } = fitText(text, startSize, maxWidth, maxLines);

  const lineStep = fontSize * LINE_HEIGHT;
  const blockHeight = lineStep * lines.length;
  const anchor = opts.anchor ?? POSITION_ANCHORS[position];
  const centre = height * anchor;
  // First baseline: top of the block, plus roughly the cap height of one line.
  const firstBaseline = centre - blockHeight / 2 + fontSize * 0.82;

  const widest = lines.reduce((max, line) => Math.max(max, estimateTextWidth(line, fontSize)), 0);

  const background = buildBackground({
    style,
    width,
    centre,
    blockHeight,
    widest,
    fontSize,
    lines,
    lineStep,
    firstBaseline,
  });

  // Each line is drawn twice: a thick stroke pass, then the fill on top. This is
  // more portable than `paint-order`, which not every SVG renderer honours.
  const strokeWidth = Math.max(4, Math.round(fontSize * (style === 'outline' ? 0.13 : 0.09)));
  const fill = style === 'banner' ? '#101216' : '#FFFFFF';
  const stroke = style === 'banner' ? null : '#000000';

  const renderLines = (lineFill: string, lineStroke: string | null): string =>
    lines
      .map((line, i) => {
        const y = round(firstBaseline + i * lineStep);
        const strokeAttrs =
          lineStroke === null
            ? ''
            : ` stroke="${lineStroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"`;
        return `<text x="${round(width / 2)}" y="${y}" fill="${lineFill}"${strokeAttrs}>${escapeXml(line)}</text>`;
      })
      .join('');

  const strokePass = stroke === null ? '' : renderLines('none', stroke);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g font-family='${fontFamily}' font-size="${round(fontSize)}" font-weight="800" text-anchor="middle" letter-spacing="-0.5">
    ${background}
    ${strokePass}
    ${renderLines(fill, null)}
  </g>
</svg>`;
}

interface BackgroundArgs {
  style: HookStyle;
  width: number;
  centre: number;
  blockHeight: number;
  widest: number;
  fontSize: number;
  lines: string[];
  lineStep: number;
  firstBaseline: number;
}

function buildBackground(args: BackgroundArgs): string {
  const { style, width, centre, blockHeight, widest, fontSize } = args;

  if (style === 'outline' || style === 'lower-third') return '';

  const padX = fontSize * 0.5;
  const padY = fontSize * 0.4;

  if (style === 'panel') {
    return (
      `<rect x="${round(width / 2 - widest / 2 - padX)}" y="${round(centre - blockHeight / 2 - padY)}" ` +
      `width="${round(widest + padX * 2)}" height="${round(blockHeight + padY * 2)}" ` +
      `rx="${round(fontSize * 0.28)}" fill="#000" opacity="0.42"/>`
    );
  }

  // banner: one solid block, sized to the widest line. Per-line bars were tried
  // and read as ragged rather than deliberate when line widths are close.
  return (
    `<rect x="${round(width / 2 - widest / 2 - padX)}" y="${round(centre - blockHeight / 2 - padY)}" ` +
    `width="${round(widest + padX * 2)}" height="${round(blockHeight + padY * 2)}" ` +
    `rx="${round(fontSize * 0.16)}" fill="#FFFFFF"/>`
  );
}

/**
 * sharp is imported lazily so the pure layout functions above stay testable
 * without the native binary present.
 */
export async function renderHookCard(opts: HookCardOptions, outPath: string): Promise<void> {
  const { default: sharp } = await import('sharp');
  await sharp(Buffer.from(buildHookSvg(opts))).png().toFile(outPath);
}

/** Same card as a PNG buffer, for the dashboard preview. */
export async function renderHookCardBuffer(opts: HookCardOptions): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(buildHookSvg(opts))).png().toBuffer();
}
