/** The angle a hook takes. Trial reels test hooks, so variants must differ in kind, not wording. */
export type HookAngle =
  | 'number-led'
  | 'contrarian'
  | 'curiosity-gap'
  | 'second-person'
  | 'loss-framing'
  | 'status'
  | 'concrete-detail'
  | 'comparison';

export interface HookVariant {
  /** Stable within a project. Used for filenames and performance ranking. */
  id: string;
  /** Burned into the video. Short — it has to read in under a second. */
  text: string;
  angle: HookAngle;
}

export interface ReelSpec {
  slug: string;
  topic: string;
  createdAt: string;
  /** The numbered list that becomes the caption body. */
  reasons: string[];
  hooks: HookVariant[];
  hashtags: string[];
  /** Optional closing line before the hashtags. */
  cta: string | null;
}

export interface BrollClip {
  path: string;
  tags: string[];
}

export interface RenderedVariant {
  hookId: string;
  videoPath: string;
  coverPath: string;
  brollPath: string;
}

export interface ScheduledVariant {
  hookId: string;
  /** Metricool post id, when the API returned one. */
  postId: string | null;
  publishAt: string;
  timezone: string;
  autoPublish: boolean;
  /** Raw API response, kept so `rank` and debugging never need a re-run. */
  raw: unknown;
}

export interface ScheduleManifest {
  slug: string;
  scheduledAt: string;
  trialReel: boolean;
  variants: ScheduledVariant[];
}
