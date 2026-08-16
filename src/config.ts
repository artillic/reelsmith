import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { UserError } from './log.ts';

/**
 * Minimal .env loader. Node 22 has --env-file, but the CLI is also imported by
 * tests and by `npm run reel`, so load it here rather than depend on the flag.
 * Values already present in process.env win, so CI and shell exports override.
 */
export function loadEnv(cwd = process.cwd()): void {
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Rewrites .env in place, preserving comments and key order. Existing keys are
 * updated where they sit; new ones are appended. Values are applied to
 * process.env too, so a running dashboard picks them up without a restart.
 */
/**
 * Values are quoted when they carry leading or trailing whitespace, which
 * `loadEnv` strips before it looks for quotes. Without this a folder whose name
 * genuinely ends in a space — common in cloud-synced drives — silently loses
 * that space the moment it round-trips through .env.
 */
function encodeEnvValue(value: string): string {
  const needsQuotes = value !== value.trim() || value.includes('#');
  return needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function updateEnvFile(updates: Record<string, string>, cwd = process.cwd()): void {
  const path = resolve(cwd, '.env');
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const remaining = new Map(Object.entries(updates));

  const lines = existing.map((rawLine) => {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return rawLine;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return rawLine;
    const key = trimmed.slice(0, eq).trim();
    if (!remaining.has(key)) return rawLine;
    const value = remaining.get(key) as string;
    remaining.delete(key);
    return `${key}=${encodeEnvValue(value)}`;
  });

  for (const [key, value] of remaining) lines.push(`${key}=${encodeEnvValue(value)}`);

  const text = lines.join('\n');
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');

  for (const [key, value] of Object.entries(updates)) {
    if (value === '') delete process.env[key];
    else process.env[key] = value;
  }
}

export function requireEnv(name: string, why: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new UserError(`${name} is not set. ${why}\nAdd it to reelsmith/.env (see .env.example).`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

export interface RenderConfig {
  width: number;
  height: number;
  fps: number;
  /** Seconds. Trial reels testing a hook do not need to be long. */
  durationSeconds: number;
  /** Where the cover frame is grabbed from. */
  coverAtSeconds: number;
  crf: number;
}

export const renderDefaults: RenderConfig = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 7,
  coverAtSeconds: 0.5,
  crf: 20,
};
