import { readdirSync, statSync, existsSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, extname, basename } from 'node:path';
import { optionalEnv } from './config.ts';
import { UserError, log } from './log.ts';
import type { BrollClip } from './types.ts';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

/**
 * The library is a plain directory tree: `library/<tag>/clip.mp4`. A clip in
 * `library/bangkok/rooftop-01.mp4` carries the tag `bangkok`. Clips dropped
 * straight into `library/` carry no tags and are used as fallback filler.
 *
 * No database, no sidecar metadata to keep in sync — the folder name is the tag.
 */
export function indexLibrary(root: string): BrollClip[] {
  if (!existsSync(root)) return [];
  const clips: BrollClip[] = [];

  const walk = (dir: string, tags: string[]): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, [...tags, entry.toLowerCase()]);
      } else if (VIDEO_EXTENSIONS.has(extname(entry).toLowerCase())) {
        clips.push({ path: full, tags });
      }
    }
  };

  walk(root, []);
  return clips.sort((a, b) => a.path.localeCompare(b.path));
}

function scoreClip(clip: BrollClip, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const haystack = [...clip.tags, basename(clip.path).toLowerCase()].join(' ');
  return keywords.filter((kw) => haystack.includes(kw)).length;
}

/**
 * Picks one clip per variant. Prefers tag matches, then spreads across the
 * library so a batch of variants does not all ride the same footage — the whole
 * point of the test is that the hook is the variable, but identical b-roll on
 * every variant makes the feed look like spam.
 */
export function selectClips(library: BrollClip[], keywords: string[], count: number): BrollClip[] {
  if (library.length === 0) {
    throw new UserError(
      'The b-roll library is empty. Drop vertical clips into library/<tag>/ ' +
        'or set PEXELS_API_KEY to fetch stock footage.',
    );
  }

  const normalized = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 2);
  const ranked = [...library].sort((a, b) => {
    const diff = scoreClip(b, normalized) - scoreClip(a, normalized);
    return diff !== 0 ? diff : a.path.localeCompare(b.path);
  });

  const matching = ranked.filter((c) => scoreClip(c, normalized) > 0);
  const pool = matching.length > 0 ? matching : ranked;

  if (pool.length < count) {
    log.warn(
      `Only ${pool.length} clip(s) available for ${count} variant(s); footage will repeat. ` +
        'Add more clips to widen the pool.',
    );
  }

  return Array.from({ length: count }, (_, i) => pool[i % pool.length] as BrollClip);
}

interface PexelsVideoFile {
  link?: unknown;
  width?: unknown;
  height?: unknown;
  file_type?: unknown;
}
interface PexelsVideo {
  id?: unknown;
  video_files?: unknown;
}

/**
 * Optional stock-footage fill. Downloads the highest-resolution vertical MP4 for
 * each result into `destDir`. Pexels requires attribution — see README.
 */
export async function fetchPexelsClips(
  query: string,
  count: number,
  destDir: string,
): Promise<string[]> {
  const key = optionalEnv('PEXELS_API_KEY');
  if (key === undefined) {
    throw new UserError('PEXELS_API_KEY is not set, so stock footage cannot be fetched.');
  }

  const url = new URL('https://api.pexels.com/videos/search');
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('per_page', String(Math.min(count * 2, 40)));

  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) {
    throw new UserError(`Pexels search failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { videos?: unknown };
  const videos = Array.isArray(body.videos) ? (body.videos as PexelsVideo[]) : [];

  const saved: string[] = [];
  for (const video of videos) {
    if (saved.length >= count) break;
    const files = Array.isArray(video.video_files) ? (video.video_files as PexelsVideoFile[]) : [];
    const vertical = files
      .filter(
        (f): f is PexelsVideoFile & { link: string; width: number; height: number } =>
          typeof f.link === 'string' &&
          typeof f.width === 'number' &&
          typeof f.height === 'number' &&
          f.height > f.width,
      )
      .sort((a, b) => b.height - a.height)[0];
    if (vertical === undefined) continue;

    const dest = join(destDir, `pexels-${String(video.id ?? saved.length)}.mp4`);
    await downloadTo(vertical.link, dest);
    saved.push(dest);
  }

  if (saved.length < count) {
    log.warn(`Pexels returned ${saved.length} usable vertical clip(s) for ${count} requested.`);
  }
  return saved;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || res.body === null) {
    throw new UserError(`Download failed for ${url}: ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}
