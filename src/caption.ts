/**
 * Caption assembly. Pure — no I/O, no network — so the Instagram limits are
 * unit-testable without touching the API.
 */

/** Instagram caption limit, in characters. */
export const IG_CAPTION_LIMIT = 2200;
/** Instagram counts at most 30 hashtags; beyond that the post can be rejected. */
export const IG_HASHTAG_LIMIT = 30;

export interface CaptionInput {
  hook: string;
  reasons: string[];
  cta?: string | null;
  hashtags?: string[];
}

export interface CaptionResult {
  text: string;
  /** Reasons that did not fit under the character limit. Never dropped silently. */
  droppedReasons: string[];
  /** Hashtags removed to stay under the 30-tag limit. */
  droppedHashtags: string[];
  characterCount: number;
}

export interface CaptionCheck {
  text: string;
  characterCount: number;
  hashtagCount: number;
  /** Problems the author should see before publishing. Never auto-corrected. */
  problems: string[];
}

/**
 * Checks an author-written caption without touching it. The caption is the
 * author's voice, so this reports rather than repairs — silently trimming
 * someone's copy to fit a limit is worse than telling them it will be rejected.
 */
export function checkCaption(text: string): CaptionCheck {
  const hashtagCount = (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
  const problems: string[] = [];

  if (text.trim() === '') problems.push('The caption is empty.');
  if (text.length > IG_CAPTION_LIMIT) {
    problems.push(
      `${text.length} characters — Instagram allows ${IG_CAPTION_LIMIT}. ` +
        `Remove about ${text.length - IG_CAPTION_LIMIT}.`,
    );
  }
  if (hashtagCount > IG_HASHTAG_LIMIT) {
    problems.push(`${hashtagCount} hashtags — Instagram allows ${IG_HASHTAG_LIMIT}.`);
  }

  return { text, characterCount: text.length, hashtagCount, problems };
}

export function normalizeHashtag(raw: string): string {
  const cleaned = raw.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return cleaned === '' ? '' : `#${cleaned}`;
}

function assemble(hook: string, reasons: string[], cta: string | null, hashtags: string[]): string {
  const numbered = reasons.map((reason, i) => `${i + 1}. ${reason}`).join('\n');
  const blocks = [hook.trim(), numbered];
  if (cta !== null && cta.trim() !== '') blocks.push(cta.trim());
  if (hashtags.length > 0) blocks.push(hashtags.join(' '));
  return blocks.filter((b) => b !== '').join('\n\n');
}

/**
 * Builds the caption and fits it under Instagram's limits by dropping trailing
 * reasons. Hook, CTA and hashtags are treated as fixed; the list is the only
 * elastic part, and dropping from the end keeps the numbering contiguous.
 */
export function buildCaption(input: CaptionInput): CaptionResult {
  const allTags = (input.hashtags ?? []).map(normalizeHashtag).filter((t) => t !== '');
  const uniqueTags = [...new Set(allTags)];
  const hashtags = uniqueTags.slice(0, IG_HASHTAG_LIMIT);
  const droppedHashtags = uniqueTags.slice(IG_HASHTAG_LIMIT);

  const cta = input.cta ?? null;
  const kept = [...input.reasons];
  const droppedReasons: string[] = [];

  let text = assemble(input.hook, kept, cta, hashtags);
  while (text.length > IG_CAPTION_LIMIT && kept.length > 0) {
    const removed = kept.pop();
    if (removed !== undefined) droppedReasons.unshift(removed);
    text = assemble(input.hook, kept, cta, hashtags);
  }

  return {
    text,
    droppedReasons,
    droppedHashtags,
    characterCount: text.length,
  };
}
