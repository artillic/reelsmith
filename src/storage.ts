import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { optionalEnv, requireEnv } from './config.ts';
import { UserError } from './log.ts';

/**
 * Supabase Storage upload, over the REST API — no SDK dependency, since all we
 * need is a PUT of some bytes and a predictable public URL.
 *
 * A bucket is the right shape for this because Metricool addresses media by
 * URL: `<base>/<filename>.mp4` has to resolve to raw bytes, every time, at
 * publish time. Anything that returns an HTML wrapper or an opaque per-file id
 * cannot be addressed this way.
 */

export interface StorageConfig {
  /** Project URL, e.g. https://abcdefgh.supabase.co */
  url: string;
  /** Service-role key. Bypasses RLS — keep it out of git and out of any app bundle. */
  key: string;
  bucket: string;
}

export function loadStorageConfig(): StorageConfig {
  return {
    url: requireEnv('SUPABASE_URL', 'Supabase project URL, e.g. https://abcdefgh.supabase.co')
      .replace(/\/+$/, ''),
    key: requireEnv(
      'SUPABASE_SERVICE_ROLE_KEY',
      'Supabase dashboard > Project Settings > API > service_role key.',
    ),
    bucket: optionalEnv('SUPABASE_BUCKET') ?? 'reels',
  };
}

/** Non-throwing variant, for callers that treat storage as optional. */
export function tryLoadStorageConfig(): StorageConfig | null {
  const url = optionalEnv('SUPABASE_URL');
  const key = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (url === undefined || key === undefined) return null;
  return {
    url: url.replace(/\/+$/, ''),
    key,
    bucket: optionalEnv('SUPABASE_BUCKET') ?? 'reels',
  };
}

export function publicBaseUrl(config: Pick<StorageConfig, 'url' | 'bucket'>): string {
  return `${config.url}/storage/v1/object/public/${config.bucket}`;
}

/**
 * Where `schedule` looks for media. An explicit MEDIA_PUBLIC_BASE_URL wins, so
 * any bucket works; a configured Supabase project is derived automatically so
 * the common case needs no second setting.
 */
export function resolveMediaBaseUrl(): string {
  const explicit = optionalEnv('MEDIA_PUBLIC_BASE_URL');
  if (explicit !== undefined) return explicit.replace(/\/+$/, '');

  const storage = tryLoadStorageConfig();
  if (storage !== null) return publicBaseUrl(storage);

  throw new UserError(
    'No public media location configured. Metricool fetches videos over HTTP, so rendered ' +
      'files must be reachable at a public URL.\n' +
      'Either set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (and run `reel upload`), ' +
      'or set MEDIA_PUBLIC_BASE_URL to a bucket you upload to yourself.',
  );
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface UploadResult {
  objectName: string;
  publicUrl: string;
  bytes: number;
}

/**
 * Uploads one file to the bucket root, keyed by its filename — which is exactly
 * what `publicMediaUrl` reconstructs when scheduling. `x-upsert` makes re-runs
 * after a re-render overwrite rather than fail.
 */
export async function uploadObject(
  config: StorageConfig,
  localPath: string,
): Promise<UploadResult> {
  const objectName = basename(localPath);
  const body = readFileSync(localPath);

  const res = await fetch(
    `${config.url}/storage/v1/object/${config.bucket}/${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': contentTypeFor(localPath),
        'x-upsert': 'true',
      },
      body: new Uint8Array(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new UserError(
      `Upload of ${objectName} failed (${res.status}).\n${text.slice(0, 400)}\n\n` +
        (res.status === 404
          ? `The bucket "${config.bucket}" does not exist. Create it in the Supabase dashboard ` +
            'under Storage, and set it to Public.'
          : res.status === 400 || res.status === 401 || res.status === 403
            ? 'Check SUPABASE_SERVICE_ROLE_KEY — this needs the service_role key, not the anon key.'
            : ''),
    );
  }

  return {
    objectName,
    publicUrl: `${publicBaseUrl(config)}/${encodeURIComponent(objectName)}`,
    bytes: body.byteLength,
  };
}

/** Confirms the object is actually served publicly, rather than trusting the upload. */
export async function verifyPubliclyReadable(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const type = res.headers.get('content-type') ?? 'unknown';
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    if (type.startsWith('text/html')) {
      return { ok: false, detail: `served HTML, not media (content-type: ${type})` };
    }
    return { ok: true, detail: type };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
