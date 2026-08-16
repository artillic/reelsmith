export interface HookVariant {
  /** Stable within a project. Used for filenames and performance ranking. */
  id: string;
  /** Burned into the video. Short — it has to read in under a second. */
  text: string;
  /**
   * What this variant changes relative to the seed hook, e.g.
   * "audience: entrepreneurs". A label for reading the results later, not a
   * category the generator picks from.
   */
  variation: string;
  /**
   * Which clip to render this hook over. null means pick automatically.
   * Chosen in the dashboard, so the same hook can be retried on new footage.
   */
  brollPath?: string | null;
}

export interface ReelSpec {
  slug: string;
  topic: string;
  createdAt: string;
  /**
   * The caption, written by the author and posted verbatim. This is the
   * deliberate design: the list is the author's voice and the tool must not
   * rewrite it. `reasons` remains only for specs created before captions were
   * authored directly.
   */
  caption: string;
  /** The hook every variant is a rewrite of. */
  seedHook: string;
  hooks: HookVariant[];

  /** @deprecated Superseded by `caption`; kept so older projects still load. */
  reasons?: string[];
  /** @deprecated Part of the old assembled-caption path. */
  hashtags?: string[];
  /** @deprecated Part of the old assembled-caption path. */
  cta?: string | null;
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
