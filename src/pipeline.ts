import { writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { renderDefaults, type RenderConfig } from './config.ts';
import { UserError } from './log.ts';
import { generateHookVariants } from './ideate.ts';
import { buildCaption, checkCaption } from './caption.ts';
import { planSchedule } from './schedule.ts';
import { indexLibrary, selectClips, fetchPexelsClips } from './broll.ts';
import { renderHookCard } from './overlay.ts';
import { assertFfmpeg, renderVariant, extractCover } from './render.ts';
import { loadStorageConfig, uploadObject, verifyPubliclyReadable } from './storage.ts';
import {
  MetricoolClient,
  loadCredentials,
  buildPostPayload,
  trialFieldFromEnv,
  publicMediaUrl,
} from './metricool.ts';
import { ensureProjectDirs, writeSpec, writeScheduleManifest, type ProjectPaths } from './project.ts';
import type { ReelSpec, ScheduleManifest, ScheduledVariant } from './types.ts';

/**
 * The pipeline stages, independent of how they are driven. The CLI passes its
 * console logger; the dashboard passes one that appends to a job's log buffer.
 * Both therefore run the exact same code — the browser is a second front end,
 * not a second implementation.
 */
export interface PipelineLogger {
  step(message: string): void;
  info(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
}

/* ------------------------------------------------------------- ideate --- */

export interface IdeateStageOptions {
  /** Used only for naming the project and matching b-roll tags. */
  topic: string;
  /** The author's hook. Kept as variant one. */
  seedHook: string;
  /** The author's caption, posted verbatim on every variant. */
  caption: string;
  variantCount: number;
  notes?: string | undefined;
  brollPool?: string[] | undefined;
}

export async function runIdeate(
  paths: ProjectPaths,
  slug: string,
  opts: IdeateStageOptions,
  log: PipelineLogger,
): Promise<ReelSpec> {
  ensureProjectDirs(paths);
  log.step(`Writing ${opts.variantCount} variations of "${opts.seedHook}"`);

  const hooks = await generateHookVariants({
    seedHook: opts.seedHook,
    caption: opts.caption,
    count: opts.variantCount,
    notes: opts.notes,
  });

  const spec: ReelSpec = {
    slug,
    topic: opts.topic,
    createdAt: new Date().toISOString(),
    caption: opts.caption,
    seedHook: opts.seedHook,
    hooks,
    brollPool: opts.brollPool ?? [],
  };
  writeSpec(paths, spec);

  log.ok(`${hooks.length} hook(s), including your original`);
  for (const hook of hooks) log.info(`${hook.text}   — ${hook.variation}`);
  for (const problem of checkCaption(opts.caption).problems) log.warn(problem);
  return spec;
}

/* ------------------------------------------------------------- render --- */

export interface RenderStageOptions {
  durationSeconds?: number | undefined;
  audioPath?: string | undefined;
  onlyHookId?: string | undefined;
  useStock?: boolean;
}

/**
 * The caption is authored, not assembled — the same text goes on every variant,
 * because the hook is the only thing under test. `buildCaption` is still used
 * for projects created before captions were written directly.
 */
export function captionFor(spec: ReelSpec, hookText: string): { text: string; characterCount: number } {
  if (typeof spec.caption === 'string' && spec.caption.trim() !== '') {
    return { text: spec.caption, characterCount: spec.caption.length };
  }
  const built = buildCaption({
    hook: hookText,
    reasons: spec.reasons ?? [],
    cta: spec.cta ?? null,
    hashtags: spec.hashtags ?? [],
  });
  return { text: built.text, characterCount: built.characterCount };
}

export async function runRender(
  paths: ProjectPaths,
  spec: ReelSpec,
  opts: RenderStageOptions,
  log: PipelineLogger,
): Promise<void> {
  ensureProjectDirs(paths);
  await assertFfmpeg();

  const config: RenderConfig = {
    ...renderDefaults,
    ...(opts.durationSeconds === undefined ? {} : { durationSeconds: opts.durationSeconds }),
  };

  const hooks =
    opts.onlyHookId === undefined ? spec.hooks : spec.hooks.filter((h) => h.id === opts.onlyHookId);
  if (hooks.length === 0) throw new UserError(`No hook matches "${opts.onlyHookId}".`);

  if (opts.useStock === true) {
    log.step('Fetching stock b-roll from Pexels');
    const saved = await fetchPexelsClips(spec.topic, hooks.length, paths.broll);
    log.ok(`${saved.length} clip(s) downloaded`);
    log.warn('Pexels footage requires attribution.');
  }

  // Three sources, most specific first: a clip pinned to this hook, then the
  // project's chosen pool, then tag matching across the whole library.
  const pool = (spec.brollPool ?? []).filter((path) => existsSync(path));
  const needAuto = hooks.filter((hook) => !hasChosenClip(hook));
  const auto =
    pool.length > 0
      ? needAuto.map((_, i) => ({ path: pool[i % pool.length] as string, tags: [] }))
      : needAuto.length > 0
        ? selectClips(resolveLibrary(paths, log), spec.topic.split(/\s+/), needAuto.length)
        : [];
  let autoIndex = 0;

  log.step(`Rendering ${hooks.length} variant(s) at ${config.width}x${config.height}`);
  for (const hook of hooks) {
    const clip = hasChosenClip(hook)
      ? { path: hook.brollPath as string, tags: [] }
      : (auto[autoIndex++] as { path: string; tags: string[] });
    const overlayPath = join(paths.out, `${hook.id}.overlay.png`);
    const videoPath = join(paths.out, `${hook.id}.mp4`);
    const coverPath = join(paths.out, `${hook.id}.jpg`);

    await renderHookCard(
      {
        text: hook.text,
        width: config.width,
        height: config.height,
        style: spec.style ?? 'outline',
        position: spec.position ?? 'top',
        size: spec.size ?? 'medium',
      },
      overlayPath,
    );
    await renderVariant({
      brollPath: clip.path,
      overlayPath,
      outPath: videoPath,
      config,
      audioPath: opts.audioPath,
    });
    await extractCover(videoPath, coverPath, config.coverAtSeconds);

    const caption = captionFor(spec, hook.text);
    writeFileSync(join(paths.captions, `${hook.id}.txt`), caption.text, 'utf8');

    log.ok(`${hook.id} — ${basename(clip.path)}`);
    for (const problem of checkCaption(caption.text).problems) log.warn(problem);
  }
}

function hasChosenClip(hook: { brollPath?: string | null }): boolean {
  return typeof hook.brollPath === 'string' && hook.brollPath !== '' && existsSync(hook.brollPath);
}

/** Project-local b-roll wins; then any configured library roots. */
export function resolveLibrary(paths: ProjectPaths, log?: PipelineLogger) {
  const local = indexLibrary(paths.broll);
  if (local.length > 0) return local;

  const roots = libraryRoots();
  const clips = roots.flatMap((root) => indexLibrary(root));
  if (clips.length === 0 && log !== undefined) {
    log.warn(`No clips found in: ${roots.join(', ') || '(no library configured)'}`);
  }
  return clips;
}

export interface LibraryRoot {
  /** The path as it will actually be read. */
  path: string;
  exists: boolean;
  /** What the user typed, when it differs from `path`. */
  configured: string;
}

/**
 * Where to look for footage. BROLL_DIR may list several absolute paths
 * separated by `:` — a Google Drive for Desktop folder is just a path, so
 * nothing needs copying into the project.
 *
 * Folder names may legitimately begin or end with a space (Finder allows it,
 * and cloud-synced folders often carry one), so each entry is tried verbatim
 * first and only then with surrounding whitespace removed. Trimming first
 * would silently break a real path that ends in a space.
 */
export function libraryRootsDetailed(): LibraryRoot[] {
  const configured = process.env['BROLL_DIR'] ?? '';
  const roots: LibraryRoot[] = [];

  for (const segment of configured.split(':')) {
    if (segment.trim() === '') continue;
    if (existsSync(segment)) {
      roots.push({ path: segment, exists: true, configured: segment });
    } else if (existsSync(segment.trim())) {
      roots.push({ path: segment.trim(), exists: true, configured: segment });
    } else {
      roots.push({ path: segment, exists: false, configured: segment });
    }
  }

  if (existsSync('library')) {
    roots.push({ path: 'library', exists: true, configured: 'library' });
  }
  return roots;
}

/** Readable roots only — what the render stage actually scans. */
export function libraryRoots(): string[] {
  return libraryRootsDetailed().filter((root) => root.exists).map((root) => root.path);
}

/* ------------------------------------------------------------- upload --- */

export async function runUpload(
  paths: ProjectPaths,
  spec: ReelSpec,
  includeCovers: boolean,
  log: PipelineLogger,
): Promise<void> {
  const config = loadStorageConfig();
  const files = spec.hooks
    .flatMap((hook) => {
      const video = join(paths.out, `${hook.id}.mp4`);
      const cover = join(paths.out, `${hook.id}.jpg`);
      return includeCovers ? [video, cover] : [video];
    })
    .filter((file) => existsSync(file));

  if (files.length === 0) throw new UserError('No rendered files to upload. Render first.');

  log.step(`Uploading ${files.length} file(s) to the "${config.bucket}" bucket`);
  let firstVideoUrl: string | null = null;
  for (const file of files) {
    const result = await uploadObject(config, file);
    if (firstVideoUrl === null && file.endsWith('.mp4')) firstVideoUrl = result.publicUrl;
    log.ok(`${result.objectName}  (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);
  }

  if (firstVideoUrl !== null) {
    log.step('Verifying public access');
    const check = await verifyPubliclyReadable(firstVideoUrl);
    if (!check.ok) {
      throw new UserError(
        `${firstVideoUrl} is not publicly readable: ${check.detail}\n` +
          `Set the "${config.bucket}" bucket to Public in Supabase > Storage. Metricool fetches ` +
          'the video at publish time, so a private bucket means the post fails then.',
      );
    }
    log.ok(`Publicly readable (${check.detail})`);
  }
}

/* ----------------------------------------------------------- schedule --- */

export interface ScheduleStageOptions {
  timezone: string;
  start: string;
  gapMinutes: number;
  dailyCap: number;
  windowStartHour: number;
  windowEndHour: number;
  autoPublish: boolean;
  dryRun: boolean;
}

export async function runSchedule(
  paths: ProjectPaths,
  spec: ReelSpec,
  opts: ScheduleStageOptions,
  log: PipelineLogger,
): Promise<ScheduleManifest> {
  const rendered = spec.hooks.filter((h) => existsSync(join(paths.out, `${h.id}.mp4`)));
  if (rendered.length === 0) throw new UserError('No rendered videos. Render first.');
  if (rendered.length < spec.hooks.length) {
    log.warn(`${spec.hooks.length - rendered.length} hook(s) have no video and are skipped.`);
  }

  const times = planSchedule({
    count: rendered.length,
    start: opts.start,
    gapMinutes: opts.gapMinutes,
    dailyCap: opts.dailyCap,
    windowStartHour: opts.windowStartHour,
    windowEndHour: opts.windowEndHour,
  });

  const { field: trialField, value: trialValue } = trialFieldFromEnv();
  if (trialField === undefined) {
    log.warn('No trial-reel field configured — these schedule as ordinary reels.');
  }

  log.step(`${opts.dryRun ? 'Planning' : 'Scheduling'} ${rendered.length} post(s) in ${opts.timezone}`);

  const client = opts.dryRun ? null : new MetricoolClient(loadCredentials());
  const variants: ScheduledVariant[] = [];

  for (const [index, hook] of rendered.entries()) {
    const publishAt = times[index] as string;
    const caption = captionFor(spec, hook.text);

    if (opts.dryRun) {
      log.ok(`${publishAt}  ${hook.text}   — ${hook.variation}`);
      variants.push({
        hookId: hook.id,
        postId: null,
        publishAt,
        timezone: opts.timezone,
        autoPublish: opts.autoPublish,
        raw: null,
      });
      continue;
    }

    const mediaUrl = publicMediaUrl(join(paths.out, `${hook.id}.mp4`));
    const normalized = await client!.normalizeMedia(mediaUrl);
    if (!normalized.ok) {
      throw new UserError(
        `Metricool could not fetch ${mediaUrl} (${normalized.status}). ` +
          `Confirm the file is publicly reachable.\n${normalized.text.slice(0, 300)}`,
      );
    }
    const mediaHandle = extractMediaHandle(normalized.data) ?? mediaUrl;

    const created = await client!.createPost(
      buildPostPayload({
        text: caption.text,
        publishAt,
        timezone: opts.timezone,
        media: [mediaHandle],
        autoPublish: opts.autoPublish,
        trialField,
        trialValue,
      }),
    );
    if (!created.ok) {
      throw new UserError(
        `Scheduling "${hook.text}" failed (${created.status}).\n${created.text.slice(0, 500)}`,
      );
    }

    const postId = extractPostId(created.data);
    variants.push({
      hookId: hook.id,
      postId,
      publishAt,
      timezone: opts.timezone,
      autoPublish: opts.autoPublish,
      raw: created.data,
    });
    log.ok(`${publishAt}  ${hook.id} -> post ${postId ?? '(no id returned)'}`);
  }

  const manifest: ScheduleManifest = {
    slug: spec.slug,
    scheduledAt: new Date().toISOString(),
    trialReel: trialField !== undefined,
    variants,
  };
  if (!opts.dryRun) writeScheduleManifest(paths, manifest);
  return manifest;
}

/* ------------------------------------------------------------ helpers --- */

export function extractPostId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ['id', 'postId', 'uuid']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  const nested = record['data'];
  return nested === undefined ? null : extractPostId(nested);
}

export function extractMediaHandle(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ['url', 'mediaId', 'id', 'normalizedUrl']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  const nested = record['data'];
  return nested === undefined ? null : extractMediaHandle(nested);
}
