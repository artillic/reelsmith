import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { requireEnv, optionalEnv } from './config.ts';
import { resolveMediaBaseUrl } from './storage.ts';
import { UserError } from './log.ts';

/**
 * Metricool REST client.
 *
 * Two things about this API are load-bearing and easy to get wrong:
 *  - the token goes in `X-Mc-Auth`, not `Authorization: Bearer`;
 *  - `userId` and `blogId` are query parameters on every call, not body fields.
 *
 * The trial-reel flag is NOT hard-coded. Metricool's Planner supports trial
 * reels, but the public API docs do not name the field. `reel probe` discovers
 * it from a trial reel you scheduled by hand; you then set METRICOOL_TRIAL_FIELD
 * (and optionally METRICOOL_TRIAL_VALUE) and this client sends it.
 */

const BASE_URL = 'https://app.metricool.com/api';

export interface MetricoolCredentials {
  token: string;
  userId: string;
  blogId: string;
}

const TOKEN_HELP = 'Metricool API access requires an Advanced plan. Account Settings > API.';
const USER_ID_HELP = 'Find it in any dashboard URL: app.metricool.com/evolution/web?blogId=..&userId=..';

export function loadCredentials(): MetricoolCredentials {
  return {
    ...loadAccountCredentials(),
    blogId: requireEnv('METRICOOL_BLOG_ID', 'This is the brand id. Run `reel brands` to list them.'),
  };
}

/** Token + userId only — enough to list brands, which is how you find blogId. */
export function loadAccountCredentials(): { token: string; userId: string } {
  return {
    token: requireEnv('METRICOOL_TOKEN', TOKEN_HELP),
    userId: requireEnv('METRICOOL_USER_ID', USER_ID_HELP),
  };
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  /** Parsed JSON when the response was JSON, otherwise null. */
  data: T | null;
  /** Always present, so probes can inspect non-JSON error bodies. */
  text: string;
}

export class MetricoolClient {
  // Written out longhand rather than as a constructor parameter property:
  // Node's type-stripping loader rejects parameter properties.
  private readonly creds: MetricoolCredentials;

  constructor(creds: MetricoolCredentials) {
    this.creds = creds;
  }

  private url(path: string, params: Record<string, string> = {}): URL {
    const url = new URL(path.startsWith('/') ? `${BASE_URL}${path}` : path);
    url.searchParams.set('userId', this.creds.userId);
    url.searchParams.set('blogId', this.creds.blogId);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  async request<T = unknown>(
    path: string,
    init: { method?: string; params?: Record<string, string>; body?: unknown } = {},
  ): Promise<ApiResponse<T>> {
    const url = this.url(path, init.params ?? {});
    const headers: Record<string, string> = {
      'X-Mc-Auth': this.creds.token,
      Accept: 'application/json',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    return parseResponse<T>(res);
  }

  /**
   * Metricool fetches media from a public URL and returns a normalized handle.
   * The rendered mp4 therefore has to be reachable from the internet first —
   * see `uploadTarget` in the README.
   */
  normalizeMedia(mediaUrl: string): Promise<ApiResponse> {
    return this.request('/actions/normalize/image/url', { params: { url: mediaUrl } });
  }

  listScheduledPosts(start: string, end: string): Promise<ApiResponse> {
    return this.request('/v2/scheduler/posts', { params: { start, end } });
  }

  createPost(payload: unknown): Promise<ApiResponse> {
    return this.request('/v2/scheduler/posts', { method: 'POST', body: payload });
  }
}

async function parseResponse<T>(res: Response): Promise<ApiResponse<T>> {
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text === '' ? null : (JSON.parse(text) as T);
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, text };
}

/**
 * Lists the brands on the account. Takes only userId — this is how you find the
 * blogId that every other call needs, so it must not require one itself.
 */
export async function listBrands(token: string, userId: string): Promise<ApiResponse> {
  const url = new URL(`${BASE_URL}/admin/simpleProfiles`);
  url.searchParams.set('userId', userId);
  const res = await fetch(url, {
    headers: { 'X-Mc-Auth': token, Accept: 'application/json' },
  });
  return parseResponse(res);
}

export interface PostPayloadInput {
  text: string;
  /** Civil time, `YYYY-MM-DDTHH:mm:ss`. */
  publishAt: string;
  timezone: string;
  /** Normalized media handle or a public URL, depending on what normalize returned. */
  media: string[];
  /** false schedules a draft you approve in the Planner. */
  autoPublish: boolean;
  /** Discovered by `reel probe`; omitted entirely when unknown. */
  trialField?: string | undefined;
  trialValue?: unknown;
}

/**
 * Pure payload builder, so the request shape is unit-testable without a token.
 */
export function buildPostPayload(input: PostPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    autoPublish: input.autoPublish,
    text: input.text,
    publicationDate: {
      dateTime: input.publishAt,
      timezone: input.timezone,
    },
    providers: [{ network: 'instagram' }],
    media: input.media,
  };

  if (input.trialField !== undefined && input.trialField !== '') {
    setDeep(payload, input.trialField, input.trialValue ?? true);
  }
  return payload;
}

/** Supports dotted paths like `instagramData.trialReel` discovered by the probe. */
function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i] as string;
    const existing = cursor[key];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

export function trialFieldFromEnv(): { field: string | undefined; value: unknown } {
  const field = optionalEnv('METRICOOL_TRIAL_FIELD');
  const rawValue = optionalEnv('METRICOOL_TRIAL_VALUE');
  if (rawValue === undefined) return { field, value: true };
  try {
    return { field, value: JSON.parse(rawValue) };
  } catch {
    return { field, value: rawValue };
  }
}

/**
 * Where rendered files are published so Metricool can fetch them. The base is
 * resolved from an explicit MEDIA_PUBLIC_BASE_URL or derived from a configured
 * Supabase bucket; `reel schedule` refuses to run without one rather than
 * silently scheduling a post with no video.
 */
export function publicMediaUrl(localPath: string): string {
  return `${resolveMediaBaseUrl()}/${encodeURIComponent(basename(localPath))}`;
}

export function fileSizeMb(path: string): number {
  return readFileSync(path).byteLength / (1024 * 1024);
}
