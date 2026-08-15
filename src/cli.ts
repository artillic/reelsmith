#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadEnv, optionalEnv } from './config.ts';
import { log, UserError } from './log.ts';
import {
  MetricoolClient,
  loadCredentials,
  loadAccountCredentials,
  listBrands,
} from './metricool.ts';
import { runProbe, leafPaths } from './probe.ts';
import { runIdeate, runRender, runUpload, runSchedule } from './pipeline.ts';
import {
  projectPaths,
  slugify,
  readSpec,
  readScheduleManifest,
  writeRankReport,
} from './project.ts';
import { startServer } from './server.ts';

const USAGE = `
reelsmith — trial reel pipeline

  reel dashboard [--port 4000]        everything, in a browser

Or one stage at a time:

  reel ideate   --topic "<topic>" [--reasons 24] [--variants 4] [--notes "..."] [--project <dir>]
  reel render   --project <dir> [--duration 7] [--audio <file>] [--only <hookId>] [--stock]
  reel upload   --project <dir> [--covers]
  reel schedule --project <dir> --timezone <IANA> [--start YYYY-MM-DDTHH:mm] [--gap 240]
                [--daily-cap 4] [--window 9-21] [--auto-publish] [--dry-run]
  reel brands
  reel probe    [--out probe-dump.json] [--days 30]
  reel rank     --project <dir>

Projects live in content/<slug>/. Every stage writes files and can be re-run.
`.trim();

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'dashboard':
      return cmdDashboard(rest);
    case 'ideate':
      return cmdIdeate(rest);
    case 'render':
      return cmdRender(rest);
    case 'upload':
      return cmdUpload(rest);
    case 'schedule':
      return cmdSchedule(rest);
    case 'brands':
      return cmdBrands();
    case 'probe':
      return cmdProbe(rest);
    case 'rank':
      return cmdRank(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      throw new UserError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

/* ----------------------------------------------------------- dashboard --- */

async function cmdDashboard(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string', default: '4000' } } });
  const url = await startServer(intOption(values.port, 'port'));
  log.step(`reelsmith is running at ${url}`);
  log.info('Open that in your browser. Press Ctrl+C here when you are done.');
}

/* -------------------------------------------------------------- ideate --- */

async function cmdIdeate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      topic: { type: 'string' },
      reasons: { type: 'string', default: '24' },
      variants: { type: 'string', default: '4' },
      notes: { type: 'string' },
      project: { type: 'string' },
    },
  });

  if (values.topic === undefined) throw new UserError('--topic is required.');
  const slug = slugify(values.topic);
  const paths = projectPaths(values.project ?? join('content', slug));

  await runIdeate(
    paths,
    slug,
    {
      topic: values.topic,
      reasonCount: intOption(values.reasons, 'reasons'),
      variantCount: intOption(values.variants, 'variants'),
      notes: values.notes,
    },
    log,
  );

  log.info('');
  log.info(`Edit ${paths.spec} to taste, then: reel render --project ${paths.root}`);
}

/* -------------------------------------------------------------- render --- */

async function cmdRender(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      duration: { type: 'string' },
      audio: { type: 'string' },
      only: { type: 'string' },
      stock: { type: 'boolean', default: false },
    },
  });

  const paths = projectPaths(requireOption(values.project, 'project'));
  const spec = readSpec(paths);

  await runRender(
    paths,
    spec,
    {
      durationSeconds: values.duration === undefined ? undefined : Number(values.duration),
      audioPath: values.audio,
      onlyHookId: values.only,
      useStock: values.stock === true,
    },
    log,
  );

  log.info('');
  log.info(`Videos in ${paths.out}, captions in ${paths.captions}`);
}

/* -------------------------------------------------------------- upload --- */

async function cmdUpload(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { project: { type: 'string' }, covers: { type: 'boolean', default: false } },
  });

  const paths = projectPaths(requireOption(values.project, 'project'));
  const spec = readSpec(paths);
  await runUpload(paths, spec, values.covers === true, log);

  log.info('');
  log.info(`Next: reel schedule --project ${paths.root} --timezone <your timezone>`);
}

/* ------------------------------------------------------------ schedule --- */

async function cmdSchedule(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      timezone: { type: 'string' },
      start: { type: 'string' },
      gap: { type: 'string', default: '240' },
      'daily-cap': { type: 'string', default: '4' },
      window: { type: 'string', default: '9-21' },
      'auto-publish': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const paths = projectPaths(requireOption(values.project, 'project'));
  const spec = readSpec(paths);
  const [windowStartHour, windowEndHour] = parseWindow(values.window ?? '9-21');
  const dryRun = values['dry-run'] === true;

  await runSchedule(
    paths,
    spec,
    {
      timezone: values.timezone ?? optionalEnv('REEL_TIMEZONE') ?? requireOption(undefined, 'timezone'),
      start: values.start ?? defaultStart(),
      gapMinutes: intOption(values.gap, 'gap'),
      dailyCap: intOption(values['daily-cap'], 'daily-cap'),
      windowStartHour,
      windowEndHour,
      autoPublish: values['auto-publish'] === true,
      dryRun,
    },
    log,
  );

  log.info('');
  if (dryRun) {
    log.info('Dry run — nothing was sent to Metricool. Drop --dry-run to schedule.');
  } else {
    log.info(`Manifest written to ${paths.schedule}.`);
    if (values['auto-publish'] !== true) {
      log.info('Posts were created as drafts. Approve them in the Metricool Planner.');
    }
  }
}

/* -------------------------------------------------------------- brands --- */

async function cmdBrands(): Promise<void> {
  const { token, userId } = loadAccountCredentials();
  log.step('Listing brands on this Metricool account');

  const res = await listBrands(token, userId);
  if (!res.ok) {
    throw new UserError(
      `Metricool rejected the request (${res.status}).\n${res.text.slice(0, 400)}\n\n` +
        '401/403 usually means a bad token or an account without API access (Advanced plan). ' +
        '400 usually means METRICOOL_USER_ID is wrong.',
    );
  }

  const brands = Array.isArray(res.data) ? res.data : [];
  if (brands.length === 0) {
    log.warn('No brands were returned. Raw response:');
    log.info(res.text.slice(0, 800));
    return;
  }

  log.ok(`${brands.length} brand(s):`);
  for (const brand of brands) {
    const record = (typeof brand === 'object' && brand !== null ? brand : {}) as Record<string, unknown>;
    const id = record['id'] ?? record['blogId'];
    const label = record['label'] ?? record['title'] ?? record['name'] ?? record['url'] ?? '(unnamed)';
    log.info(`METRICOOL_BLOG_ID=${String(id)}   ${String(label)}`);
  }
  log.info('');
  log.info('Copy the blogId for the brand you post from into reelsmith/.env');
}

/* --------------------------------------------------------------- probe --- */

async function cmdProbe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string', default: 'probe-dump.json' }, days: { type: 'string', default: '30' } },
  });
  await runProbe(values.out ?? 'probe-dump.json', intOption(values.days, 'days'));
}

/* ---------------------------------------------------------------- rank --- */

const METRIC_KEYS = /(view|play|reach|impression|like|comment|share|save|engagement)/i;

async function cmdRank(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { project: { type: 'string' } } });

  const paths = projectPaths(requireOption(values.project, 'project'));
  const spec = readSpec(paths);
  const manifest = readScheduleManifest(paths);
  const client = new MetricoolClient(loadCredentials());

  const dates = manifest.variants.map((v) => v.publishAt).sort();
  const start = `${(dates[0] ?? defaultStart()).slice(0, 10)}T00:00:00`;
  const end = `${(dates[dates.length - 1] ?? defaultStart()).slice(0, 10)}T23:59:59`;

  log.step('Fetching post performance from Metricool');
  const posts = await client.listScheduledPosts(start, end);
  if (!posts.ok) {
    throw new UserError(`Could not read posts (${posts.status}).\n${posts.text.slice(0, 300)}`);
  }

  const byId = indexPostsById(posts.data);
  const rows = manifest.variants.map((variant) => {
    const hook = spec.hooks.find((h) => h.id === variant.hookId);
    const post = variant.postId === null ? undefined : byId.get(variant.postId);
    const metrics = post === undefined ? {} : extractMetrics(post);
    return {
      hookId: variant.hookId,
      angle: hook?.angle ?? null,
      text: hook?.text ?? null,
      publishAt: variant.publishAt,
      metrics,
      score: Object.values(metrics).reduce((sum, n) => sum + n, 0),
    };
  });

  rows.sort((a, b) => b.score - a.score);
  writeRankReport(paths, { slug: spec.slug, rankedAt: new Date().toISOString(), rows, raw: posts.data });

  const measured = rows.filter((r) => Object.keys(r.metrics).length > 0);
  if (measured.length === 0) {
    log.warn('No engagement metrics were present in the response.');
    log.info(`The raw payload is in ${paths.rank}.`);
    return;
  }

  log.ok(`Ranked ${measured.length} of ${rows.length} variant(s):`);
  for (const [i, row] of rows.entries()) {
    const detail = Object.entries(row.metrics).map(([k, v]) => `${k}=${v}`).join(' ');
    log.info(`${i + 1}. [${row.angle ?? '?'}] ${row.text ?? row.hookId}  ${detail}`);
  }
  if (measured.length < rows.length) {
    log.warn(`${rows.length - measured.length} variant(s) had no metrics and rank last by default.`);
  }
}

/* ------------------------------------------------------------- helpers --- */

function extractMetrics(post: unknown): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [path, value] of leafPaths(post)) {
    const key = path.split('.').pop() ?? '';
    if (typeof value === 'number' && METRIC_KEYS.test(key)) metrics[key] = value;
  }
  return metrics;
}

function indexPostsById(data: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const list = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : [];
  for (const item of list) {
    const id = extractPostIdLocal(item);
    if (id !== null) map.set(id, item);
  }
  return map;
}

function extractPostIdLocal(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ['id', 'postId', 'uuid']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  const nested = record['data'];
  return nested === undefined ? null : extractPostIdLocal(nested);
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new UserError(`--${name} is required.`);
  return value;
}

function intOption(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new UserError(`--${name} must be an integer, got "${value}".`);
  return parsed;
}

export function parseWindow(value: string): [number, number] {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (match === null) throw new UserError(`--window must look like 9-21, got "${value}".`);
  return [Number(match[1]), Number(match[2])];
}

/** Tomorrow at 09:00 local wall-clock. */
function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.toISOString().slice(0, 10)}T09:00`;
}

main().catch((err: unknown) => {
  if (err instanceof UserError) log.error(err.message);
  else log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
