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

export interface HookCardOptions {
  text: string;
  width: number;
  height: number;
  /** Fraction of the frame height the text block is centred on. */
  anchor?: number;
  /** Starting font size, shrunk automatically until the text fits. */
  fontSize?: number;
  maxLines?: number;
  /** Dark panel behind the text. Off looks cleaner; on is readable on any clip. */
  scrim?: boolean;
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

export function buildHookSvg(opts: HookCardOptions): string {
  const {
    text,
    width,
    height,
    anchor = 0.3,
    fontSize: startSize = Math.round(width * 0.093),
    maxLines = 4,
    scrim = true,
  } = opts;

  const fontFamily = optionalEnv('REEL_FONT_FAMILY') ?? DEFAULT_FONT_STACK;
  const margin = Math.round(width * 0.08);
  const maxWidth = width - margin * 2;
  const { fontSize, lines } = fitText(text, startSize, maxWidth, maxLines);

  const lineStep = fontSize * LINE_HEIGHT;
  const blockHeight = lineStep * lines.length;
  const centre = height * anchor;
  // First baseline: top of the block, plus roughly the cap height of one line.
  const firstBaseline = centre - blockHeight / 2 + fontSize * 0.82;

  const widest = lines.reduce((max, line) => Math.max(max, estimateTextWidth(line, fontSize)), 0);
  const padX = fontSize * 0.5;
  const padY = fontSize * 0.4;
  const scrimRect = scrim
    ? `<rect x="${round(width / 2 - widest / 2 - padX)}" y="${round(centre - blockHeight / 2 - padY)}" ` +
      `width="${round(widest + padX * 2)}" height="${round(blockHeight + padY * 2)}" ` +
      `rx="${round(fontSize * 0.28)}" fill="#000" opacity="0.42"/>`
    : '';

  // Each line is drawn twice: a thick stroke pass, then the fill on top. This is
  // more portable than `paint-order`, which not every SVG renderer honours.
  const strokeWidth = Math.max(4, Math.round(fontSize * 0.11));
  const renderLines = (fill: string, stroke: string | null): string =>
    lines
      .map((line, i) => {
        const y = round(firstBaseline + i * lineStep);
        const strokeAttrs =
          stroke === null
            ? ''
            : ` stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"`;
        return `<text x="${round(width / 2)}" y="${y}" fill="${fill}"${strokeAttrs}>${escapeXml(line)}</text>`;
      })
      .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g font-family='${fontFamily}' font-size="${round(fontSize)}" font-weight="800" text-anchor="middle" letter-spacing="-0.5">
    ${scrimRect}
    ${renderLines('none', '#000000')}
    ${renderLines('#FFFFFF', null)}
  </g>
</svg>`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * sharp is imported lazily so the pure layout functions above stay testable
 * without the native binary present.
 */
export async function renderHookCard(opts: HookCardOptions, outPath: string): Promise<void> {
  const { default: sharp } = await import('sharp');
  const svg = buildHookSvg(opts);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}
