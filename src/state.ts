import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectPaths } from './project.ts';
import type { ReelSpec, HookVariant } from './types.ts';

/**
 * What actually happened, per variant, recorded as it happens.
 *
 * The file listing alone cannot answer "is this the video I just made?" — an
 * mp4 on disk says nothing about which hook text or clip produced it. Each
 * stage therefore records the inputs it used, and the dashboard compares those
 * against the current spec to decide whether a variant is up to date or stale.
 */

export interface RenderRecord {
  at: string;
  hookText: string;
  clip: string;
  style: string;
  size: string;
  position: string;
  bytes: number;
}

export interface UploadRecord {
  at: string;
  url: string;
  /** Which render this upload was of, so a re-render invalidates it. */
  renderedAt: string;
}

export interface ScheduleRecord {
  at: string;
  publishAt: string;
  timezone: string;
  postId: string | null;
  autoPublish: boolean;
  trialReel: boolean;
  renderedAt: string;
}

export interface VariantState {
  render?: RenderRecord;
  upload?: UploadRecord;
  schedule?: ScheduleRecord;
  /** Set when the last attempt at a stage failed, cleared when it succeeds. */
  lastError?: { at: string; stage: string; message: string };
}

export interface ProjectState {
  variants: Record<string, VariantState>;
}

const EMPTY: ProjectState = { variants: {} };

function statePath(paths: ProjectPaths): string {
  return join(paths.root, 'state.json');
}

export function readState(paths: ProjectPaths): ProjectState {
  const path = statePath(paths);
  if (!existsSync(path)) return { variants: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProjectState;
    return parsed.variants === undefined ? EMPTY : parsed;
  } catch {
    // A corrupt state file must not block work; it is a record, not a source.
    return { variants: {} };
  }
}

export function writeState(paths: ProjectPaths, state: ProjectState): void {
  writeFileSync(statePath(paths), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function updateVariant(
  paths: ProjectPaths,
  hookId: string,
  change: (current: VariantState) => VariantState,
): void {
  const state = readState(paths);
  state.variants[hookId] = change(state.variants[hookId] ?? {});
  writeState(paths, state);
}

export function recordRender(
  paths: ProjectPaths,
  hookId: string,
  record: Omit<RenderRecord, 'at' | 'bytes'> & { videoPath: string },
): void {
  let bytes = 0;
  try {
    bytes = statSync(record.videoPath).size;
  } catch {
    /* the size is a nicety, not worth failing over */
  }
  updateVariant(paths, hookId, (current) => ({
    ...current,
    render: {
      at: new Date().toISOString(),
      hookText: record.hookText,
      clip: record.clip,
      style: record.style,
      size: record.size,
      position: record.position,
      bytes,
    },
    // A new render invalidates whatever was uploaded or scheduled from the old one.
    upload: undefined,
    lastError: undefined,
  }));
}

export function recordError(
  paths: ProjectPaths,
  hookId: string,
  stage: string,
  message: string,
): void {
  updateVariant(paths, hookId, (current) => ({
    ...current,
    lastError: { at: new Date().toISOString(), stage, message },
  }));
}

/** Why a variant is out of date, in the author's terms. Empty means current. */
export function stalenessReasons(spec: ReelSpec, hook: HookVariant, state: VariantState, assignedClip: string | null): string[] {
  const render = state.render;
  if (render === undefined) return [];

  const reasons: string[] = [];
  if (render.hookText !== hook.text) reasons.push('the hook was edited');
  if (assignedClip !== null && render.clip !== assignedClip) reasons.push('the clip changed');
  if (render.style !== (spec.style ?? 'outline')) reasons.push('the style changed');
  if (render.size !== (spec.size ?? 'medium')) reasons.push('the size changed');
  if (render.position !== (spec.position ?? 'top')) reasons.push('the position changed');
  return reasons;
}

export type VariantStage = 'not-made' | 'failed' | 'stale' | 'made' | 'uploaded' | 'scheduled';

/** The single label shown against a variant. Later stages win. */
export function variantStage(
  hasVideo: boolean,
  state: VariantState,
  stale: boolean,
): VariantStage {
  if (state.lastError !== undefined && !hasVideo) return 'failed';
  if (!hasVideo) return 'not-made';
  if (stale) return 'stale';
  if (state.schedule !== undefined && state.schedule.renderedAt === state.render?.at) return 'scheduled';
  if (state.upload !== undefined && state.upload.renderedAt === state.render?.at) return 'uploaded';
  return 'made';
}
