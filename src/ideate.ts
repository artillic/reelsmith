import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { requireEnv } from './config.ts';
import { UserError } from './log.ts';
import type { HookAngle, ReelSpec } from './types.ts';

const MODEL = 'claude-opus-5';

const ANGLES: HookAngle[] = [
  'number-led',
  'contrarian',
  'curiosity-gap',
  'second-person',
  'loss-framing',
  'status',
  'concrete-detail',
  'comparison',
];

/**
 * No length/count constraints in the schema: structured outputs reject most
 * JSON-Schema constraints, and the SDK would otherwise strip them and enforce
 * them client-side, turning a soft miss into a hard parse failure. Counts are
 * asked for in the prompt and checked after.
 */
const IdeationSchema = z.object({
  reasons: z
    .array(z.string())
    .describe('The numbered list for the caption. Each item is one concrete, specific claim.'),
  hooks: z
    .array(
      z.object({
        id: z.string().describe('Short kebab-case identifier, unique within the response.'),
        text: z.string().describe('The on-screen hook. Must read in about one second.'),
        angle: z.enum(ANGLES as [HookAngle, ...HookAngle[]]),
      }),
    )
    .describe('Hook variants that differ in angle, not in wording.'),
  hashtags: z.array(z.string()).describe('Hashtags without the leading # character.'),
  cta: z.string().describe('One short closing line for the caption. May be empty.'),
});

export interface IdeateOptions {
  topic: string;
  reasonCount: number;
  variantCount: number;
  /** Extra steer from the user, passed through verbatim. */
  notes?: string;
}

function systemPrompt(): string {
  return [
    'You write short-form vertical video content for Instagram trial reels.',
    '',
    'A trial reel is shown only to non-followers, so its single job is to test whether a hook',
    'stops a cold viewer. The caption is a numbered list that pays off the hook.',
    '',
    'Requirements:',
    '- Every reason is concrete and specific. Prices, numbers, named things. No vague benefits.',
    '- Every reason stands alone. The reader is skimming, not reading a paragraph.',
    '- Hook variants must differ in ANGLE, not in phrasing. Two hooks that say the same thing',
    '  with different words are one hook and waste a test slot.',
    '- Hooks are short enough to read in about one second at a glance.',
    '- No emoji in hooks. No hashtags in hooks. No clickbait that the list does not deliver on.',
    '- Write in plain language. Do not pad with filler adjectives.',
  ].join('\n');
}

function userPrompt(opts: IdeateOptions): string {
  const parts = [
    `Topic: ${opts.topic}`,
    '',
    `Produce exactly ${opts.reasonCount} reasons and exactly ${opts.variantCount} hook variants.`,
    `Use a different angle for each hook variant where the angle list allows it.`,
    'Also produce up to 30 relevant hashtags (no leading #) and one short closing line.',
  ];
  if (opts.notes !== undefined && opts.notes.trim() !== '') {
    parts.push('', 'Additional direction from the author:', opts.notes.trim());
  }
  return parts.join('\n');
}

export async function ideate(opts: IdeateOptions): Promise<Omit<ReelSpec, 'slug' | 'createdAt'>> {
  requireEnv(
    'ANTHROPIC_API_KEY',
    'Ideation calls the Claude API. Create a key at https://console.anthropic.com/.',
  );
  const client = new Anthropic();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // Thinking is on by default on Claude Opus 5; stated explicitly so the
    // max_tokens headroom above is obviously deliberate.
    thinking: { type: 'adaptive' },
    system: systemPrompt(),
    messages: [{ role: 'user', content: userPrompt(opts) }],
    output_config: { format: zodOutputFormat(IdeationSchema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new UserError(
      `The model declined this topic (${response.stop_details?.category ?? 'no category given'}). ` +
        'Rephrase the topic and try again.',
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new UserError(
      'The model hit the token limit before finishing. Ask for fewer reasons or fewer variants.',
    );
  }

  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new UserError('The model returned no structured output. Re-run the command.');
  }

  const reasons = parsed.reasons.map((r) => r.trim()).filter((r) => r !== '');
  const hooks = dedupeHookIds(
    parsed.hooks
      .map((h) => ({ id: h.id.trim(), text: h.text.trim(), angle: h.angle }))
      .filter((h) => h.text !== ''),
  );

  if (reasons.length === 0) throw new UserError('The model returned no reasons.');
  if (hooks.length === 0) throw new UserError('The model returned no hooks.');

  return {
    topic: opts.topic,
    reasons,
    hooks,
    hashtags: parsed.hashtags.map((t) => t.trim()).filter((t) => t !== ''),
    cta: parsed.cta.trim() === '' ? null : parsed.cta.trim(),
  };
}

/** Hook ids become filenames, so collisions have to be resolved rather than tolerated. */
function dedupeHookIds<T extends { id: string }>(hooks: T[]): T[] {
  const seen = new Map<string, number>();
  return hooks.map((hook, index) => {
    const base = hook.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || `hook-${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? { ...hook, id: base } : { ...hook, id: `${base}-${count + 1}` };
  });
}
