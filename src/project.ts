import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UserError } from './log.ts';
import type { ReelSpec, ScheduleManifest } from './types.ts';

/**
 * One directory per project, one file per stage. Every stage is resumable and
 * inspectable — you can hand-edit `spec.json` between `ideate` and `render`,
 * which is the point: the model drafts, you approve.
 */
export interface ProjectPaths {
  root: string;
  spec: string;
  broll: string;
  out: string;
  captions: string;
  schedule: string;
  rank: string;
}

export function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function projectPaths(root: string): ProjectPaths {
  const abs = resolve(root);
  return {
    root: abs,
    spec: join(abs, 'spec.json'),
    broll: join(abs, 'broll'),
    out: join(abs, 'out'),
    captions: join(abs, 'captions'),
    schedule: join(abs, 'schedule.json'),
    rank: join(abs, 'rank.json'),
  };
}

export function ensureProjectDirs(paths: ProjectPaths): void {
  for (const dir of [paths.root, paths.broll, paths.out, paths.captions]) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) {
    throw new UserError(`No ${what} at ${path}. Run the earlier stage first.`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new UserError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export const readSpec = (paths: ProjectPaths): ReelSpec => readJson<ReelSpec>(paths.spec, 'spec.json');
export const writeSpec = (paths: ProjectPaths, spec: ReelSpec): void => writeJson(paths.spec, spec);

export const readScheduleManifest = (paths: ProjectPaths): ScheduleManifest =>
  readJson<ScheduleManifest>(paths.schedule, 'schedule.json');
export const writeScheduleManifest = (paths: ProjectPaths, manifest: ScheduleManifest): void =>
  writeJson(paths.schedule, manifest);

export const writeRankReport = (paths: ProjectPaths, report: unknown): void =>
  writeJson(paths.rank, report);
