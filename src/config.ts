import { readFileSync, existsSync } from 'node:fs';
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
