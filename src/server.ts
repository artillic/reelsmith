import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, basename, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateEnvFile, optionalEnv } from './config.ts';
import { UserError } from './log.ts';
import { assertFfmpeg } from './render.ts';
import { indexLibrary } from './broll.ts';
import { listBrands, loadAccountCredentials } from './metricool.ts';
import { runProbe, findKeys } from './probe.ts';
import { MetricoolClient, loadCredentials } from './metricool.ts';
import { startJob, getJob, listJobs } from './jobs.ts';
import {
  runIdeate,
  runRender,
  runUpload,
  runSchedule,
  captionFor,
  libraryRoots,
  resolveLibrary,
} from './pipeline.ts';
import {
  projectPaths,
  readSpec,
  writeSpec,
  slugify,
  ensureProjectDirs,
  type ProjectPaths,
} from './project.ts';
import type { ReelSpec } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = 'content';

/** Settings the dashboard can read and write. Secrets are masked on the way out. */
const SETTING_KEYS = [
  'ANTHROPIC_API_KEY',
  'METRICOOL_TOKEN',
  'METRICOOL_USER_ID',
  'METRICOOL_BLOG_ID',
  'METRICOOL_TRIAL_FIELD',
  'METRICOOL_TRIAL_VALUE',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_BUCKET',
  'MEDIA_PUBLIC_BASE_URL',
  'BROLL_DIR',
  'PEXELS_API_KEY',
  'REEL_TIMEZONE',
] as const;

const SECRET_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'METRICOOL_TOKEN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'PEXELS_API_KEY',
]);

/** Secrets never leave the process in full — the browser only needs to know they exist. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

export function readSettings(): Record<string, { value: string; set: boolean; secret: boolean }> {
  const out: Record<string, { value: string; set: boolean; secret: boolean }> = {};
  for (const key of SETTING_KEYS) {
    const raw = optionalEnv(key) ?? '';
    const secret = SECRET_KEYS.has(key);
    out[key] = {
      value: raw === '' ? '' : secret ? maskSecret(raw) : raw,
      set: raw !== '',
      secret,
    };
  }
  return out;
}

/** A masked value coming back unchanged means "leave it alone", not "set it to dots". */
export function applySettings(incoming: Record<string, unknown>): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const value = incoming[key];
    if (typeof value !== 'string') continue;
    if (SECRET_KEYS.has(key) && value.startsWith('••••')) continue;
    updates[key] = value.trim();
  }
  return updates;
}

/* --------------------------------------------------------------- state --- */

interface ProjectSummary {
  slug: string;
  topic: string;
  createdAt: string;
  hookCount: number;
  renderedCount: number;
  scheduled: boolean;
}

function listProjects(): ProjectSummary[] {
  if (!existsSync(CONTENT_ROOT)) return [];
  const summaries: ProjectSummary[] = [];

  for (const entry of readdirSync(CONTENT_ROOT)) {
    const paths = projectPaths(join(CONTENT_ROOT, entry));
    if (!existsSync(paths.spec)) continue;
    try {
      const spec = readSpec(paths);
      summaries.push({
        slug: entry,
        topic: spec.topic,
        createdAt: spec.createdAt,
        hookCount: spec.hooks.length,
        renderedCount: spec.hooks.filter((h) => existsSync(join(paths.out, `${h.id}.mp4`))).length,
        scheduled: existsSync(paths.schedule),
      });
    } catch {
      // A malformed spec.json shouldn't take the whole dashboard down.
    }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Names what is missing rather than what is present — a red row must say why. */
export function metricoolCheck(has: (key: string) => boolean): { ok: boolean; detail: string } {
  const labels: Record<string, string> = {
    METRICOOL_TOKEN: 'API token',
    METRICOOL_USER_ID: 'user id',
    METRICOOL_BLOG_ID: 'brand',
  };
  const missing = Object.keys(labels).filter((key) => !has(key));
  return missing.length === 0
    ? { ok: true, detail: 'token, user and brand set' }
    : { ok: false, detail: `missing ${missing.map((k) => labels[k]).join(', ')}` };
}

export function storageCheck(has: (key: string) => boolean): { ok: boolean; detail: string } {
  if (has('MEDIA_PUBLIC_BASE_URL')) return { ok: true, detail: 'custom public URL set' };
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((key) => !has(key));
  if (missing.length === 0) return { ok: true, detail: 'Supabase bucket configured' };
  return {
    ok: false,
    detail:
      missing.length === 2
        ? 'needed so Metricool can fetch videos'
        : `missing ${missing.includes('SUPABASE_URL') ? 'project URL' : 'service_role key'}`,
  };
}

async function buildChecks(): Promise<Record<string, { ok: boolean; detail: string }>> {
  const has = (key: string) => (optionalEnv(key) ?? '') !== '';

  let ffmpeg = { ok: false, detail: 'not found — install with `brew install ffmpeg`' };
  try {
    await assertFfmpeg();
    ffmpeg = { ok: true, detail: 'installed' };
  } catch {
    /* keep the default */
  }

  const roots = libraryRoots();
  const clipCount = roots.reduce((sum, root) => sum + indexLibrary(root).length, 0);

  return {
    anthropic: {
      ok: has('ANTHROPIC_API_KEY'),
      detail: has('ANTHROPIC_API_KEY') ? 'key set' : 'needed to generate hooks',
    },
    metricool: metricoolCheck(has),
    storage: storageCheck(has),
    ffmpeg,
    broll: {
      ok: clipCount > 0,
      detail:
        clipCount > 0
          ? `${clipCount} clip(s) across ${roots.length} folder(s)`
          : 'no clips found — point B-roll folder at your footage',
    },
    trialReel: {
      ok: has('METRICOOL_TRIAL_FIELD'),
      detail: has('METRICOOL_TRIAL_FIELD')
        ? `posts as trial reels (${optionalEnv('METRICOOL_TRIAL_FIELD')})`
        : 'not discovered yet — posts go out as ordinary reels',
    },
  };
}

/* ------------------------------------------------------------ handlers --- */

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function projectFor(slug: string): { paths: ProjectPaths; spec: ReelSpec } {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new UserError(`Invalid project name "${slug}".`);
  const paths = projectPaths(join(CONTENT_ROOT, slug));
  return { paths, spec: readSpec(paths) };
}

async function handleApi(ctx: Ctx): Promise<unknown> {
  const { url, req, body } = ctx;
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/api/state' && method === 'GET') {
    return { settings: readSettings(), checks: await buildChecks(), projects: listProjects() };
  }

  if (path === '/api/settings' && method === 'POST') {
    const updates = applySettings(body);
    updateEnvFile(updates);
    return { settings: readSettings(), checks: await buildChecks() };
  }

  if (path === '/api/broll' && method === 'GET') {
    const roots = libraryRoots();
    const clips = roots.flatMap((root) =>
      indexLibrary(root).map((clip) => {
        let sizeMb = 0;
        try {
          sizeMb = statSync(clip.path).size / 1024 / 1024;
        } catch {
          /* a cloud placeholder may not stat */
        }
        return {
          name: basename(clip.path),
          tags: clip.tags,
          sizeMb: Number(sizeMb.toFixed(1)),
          // Drive for Desktop leaves not-yet-downloaded files at zero bytes.
          placeholder: sizeMb === 0,
        };
      }),
    );
    return { roots, clips };
  }

  if (path === '/api/brands' && method === 'GET') {
    const { token, userId } = loadAccountCredentials();
    const res = await listBrands(token, userId);
    if (!res.ok) throw new UserError(`Metricool rejected the request (${res.status}). ${res.text.slice(0, 200)}`);
    const brands = Array.isArray(res.data) ? res.data : [];
    return {
      brands: brands.map((brand) => {
        const record = (typeof brand === 'object' && brand !== null ? brand : {}) as Record<string, unknown>;
        return {
          id: String(record['id'] ?? record['blogId'] ?? ''),
          label: String(record['label'] ?? record['title'] ?? record['name'] ?? record['url'] ?? 'Unnamed'),
        };
      }),
    };
  }

  if (path === '/api/probe' && method === 'POST') {
    const client = new MetricoolClient(loadCredentials());
    const days = 30;
    const civil = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const posts = await client.listScheduledPosts(`${civil(-days)}T00:00:00`, `${civil(days)}T23:59:59`);
    if (!posts.ok) throw new UserError(`Could not read posts (${posts.status}). ${posts.text.slice(0, 200)}`);
    const hits = findKeys(posts.data, /trial/i).map((hit) => ({
      path: hit.path.replace(/^\$\./, '').replace(/\[\d+\]/g, ''),
      value: JSON.stringify(hit.value)?.slice(0, 120) ?? '',
    }));
    return { hits, postCount: Array.isArray(posts.data) ? posts.data.length : null };
  }

  if (path === '/api/ideate' && method === 'POST') {
    const topic = String(body['topic'] ?? '').trim();
    if (topic === '') throw new UserError('Enter a topic first.');
    const slug = slugify(topic);
    const paths = projectPaths(join(CONTENT_ROOT, slug));
    const job = startJob(`Generating ideas for "${topic}"`, async (log) => {
      await runIdeate(
        paths,
        slug,
        {
          topic,
          reasonCount: Number(body['reasonCount'] ?? 24),
          variantCount: Number(body['variantCount'] ?? 4),
          notes: typeof body['notes'] === 'string' ? body['notes'] : undefined,
        },
        log,
      );
      return { slug };
    });
    return { jobId: job.id, slug };
  }

  const projectMatch = /^\/api\/projects\/([a-z0-9-]+)$/.exec(path);
  if (projectMatch !== null) {
    const slug = projectMatch[1] as string;
    const { paths, spec } = projectFor(slug);

    if (method === 'GET') {
      return {
        spec,
        variants: spec.hooks.map((hook) => {
          const caption = captionFor(spec, hook.text);
          return {
            ...hook,
            rendered: existsSync(join(paths.out, `${hook.id}.mp4`)),
            videoUrl: `/media/${slug}/${hook.id}.mp4`,
            coverUrl: `/media/${slug}/${hook.id}.jpg`,
            caption: caption.text,
            captionLength: caption.characterCount,
            droppedReasons: caption.droppedReasons,
          };
        }),
      };
    }

    if (method === 'PUT') {
      const incoming = body['spec'];
      if (typeof incoming !== 'object' || incoming === null) throw new UserError('No spec supplied.');
      const next = incoming as ReelSpec;
      ensureProjectDirs(paths);
      writeSpec(paths, { ...spec, ...next, slug: spec.slug, createdAt: spec.createdAt });
      return { saved: true };
    }
  }

  if (path === '/api/render' && method === 'POST') {
    const { paths, spec } = projectFor(String(body['slug'] ?? ''));
    const job = startJob(`Rendering ${spec.slug}`, async (log) => {
      await runRender(
        paths,
        spec,
        {
          durationSeconds: body['durationSeconds'] === undefined ? undefined : Number(body['durationSeconds']),
          onlyHookId: typeof body['onlyHookId'] === 'string' ? body['onlyHookId'] : undefined,
          useStock: body['useStock'] === true,
        },
        log,
      );
      return { slug: spec.slug };
    });
    return { jobId: job.id };
  }

  if (path === '/api/upload' && method === 'POST') {
    const { paths, spec } = projectFor(String(body['slug'] ?? ''));
    const job = startJob(`Uploading ${spec.slug}`, async (log) => {
      await runUpload(paths, spec, body['covers'] === true, log);
      return { slug: spec.slug };
    });
    return { jobId: job.id };
  }

  if (path === '/api/schedule' && method === 'POST') {
    const { paths, spec } = projectFor(String(body['slug'] ?? ''));
    const dryRun = body['dryRun'] === true;
    const job = startJob(`${dryRun ? 'Previewing' : 'Scheduling'} ${spec.slug}`, async (log) => {
      return runSchedule(
        paths,
        spec,
        {
          timezone: String(body['timezone'] ?? optionalEnv('REEL_TIMEZONE') ?? 'UTC'),
          start: String(body['start'] ?? defaultStart()),
          gapMinutes: Number(body['gapMinutes'] ?? 240),
          dailyCap: Number(body['dailyCap'] ?? 4),
          windowStartHour: Number(body['windowStartHour'] ?? 9),
          windowEndHour: Number(body['windowEndHour'] ?? 21),
          autoPublish: body['autoPublish'] === true,
          dryRun,
        },
        log,
      );
    });
    return { jobId: job.id };
  }

  const jobMatch = /^\/api\/jobs\/([\w-]+)$/.exec(path);
  if (jobMatch !== null && method === 'GET') {
    const job = getJob(jobMatch[1] as string);
    if (job === undefined) throw new UserError('Unknown job.');
    return job;
  }

  if (path === '/api/jobs' && method === 'GET') return { jobs: listJobs() };

  throw new UserError(`No route for ${method} ${path}`);
}

function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.toISOString().slice(0, 10)}T09:00`;
}

/* ---------------------------------------------------------- media/static -- */

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

function serveMedia(url: URL, res: ServerResponse): boolean {
  const match = /^\/media\/([a-z0-9-]+)\/([\w.-]+)$/.exec(url.pathname);
  if (match === null) return false;

  const [, slug, file] = match;
  const paths = projectPaths(join(CONTENT_ROOT, slug as string));
  const target = resolve(paths.out, file as string);

  // Confine to the project's out/ directory regardless of what the name contains.
  if (!target.startsWith(resolve(paths.out))) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  if (!existsSync(target)) {
    res.writeHead(404).end('Not found');
    return true;
  }

  const type = MEDIA_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const size = statSync(target).size;
  const range = undefined; // Files are small; whole-file responses keep this simple.
  void range;

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'no-store' });
  createReadStream(target).pipe(res);
  return true;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new UserError('Malformed request body.');
  }
}

/* --------------------------------------------------------------- start --- */

export function startServer(port: number): Promise<string> {
  const html = readFileSync(join(HERE, 'web', 'index.html'), 'utf8');

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (serveMedia(url, res)) return;

    if (url.pathname.startsWith('/api/')) {
      void (async () => {
        try {
          const body = req.method === 'GET' ? {} : await readBody(req);
          sendJson(res, 200, await handleApi({ req, res, url, body }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, err instanceof UserError ? 400 : 500, { error: message });
        }
      })();
      return;
    }

    res.writeHead(404).end('Not found');
  });

  return new Promise((resolvePromise) => {
    // Loopback only. This server writes .env and can publish posts; it must
    // never be reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      resolvePromise(`http://localhost:${port}`);
    });
  });
}

export { runProbe, resolveLibrary };
