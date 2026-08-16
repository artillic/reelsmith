import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { requireEnv } from './config.ts';
import { UserError } from './log.ts';
import type { HookVariant } from './types.ts';

const MODEL = 'claude-opus-5';

/**
 * No length or count constraints in the schema: structured outputs reject most
 * JSON-Schema constraints, and the SDK would otherwise strip them and enforce
 * them client-side, turning a soft miss into a hard parse failure. Counts are
 * asked for in the prompt and checked after.
 */
const VariantSchema = z.object({
  variants: z
    .array(
      z.object({
        text: z.string().describe('The rewritten hook, in the same shape as the seed.'),
        variation: z
          .string()
          .describe('Two or three words naming what changed, e.g. "audience: entrepreneurs".'),
      }),
    )
    .describe('Rewrites of the seed hook.'),
});

export interface HookVariantOptions {
  /** The hook the author wrote. Every variant is a rewrite of this one. */
  seedHook: string;
  /** The author's caption, for context on what the list actually delivers. */
  caption: string;
  count: number;
  notes?: string | undefined;
}

function systemPrompt(): string {
  return [
    'You rewrite a single Instagram hook into close variations for A/B testing.',
    '',
    'These go on trial reels, which are shown only to non-followers. The caption and the',
    'footage are held constant, so the hook is the only variable under test. That only works',
    'if the variants are genuinely comparable.',
    '',
    'Rules:',
    '- Keep the seed hook\'s SHAPE. If it opens with a number, every variant opens with the',
    '  same number. If it is a "N reasons ..." hook, every variant is a "N reasons ..." hook.',
    '- Change ONE thing per variant: who it is for, what it is for, the life stage, the',
    '  timeframe, or the specific claim. Never change the format.',
    '- Do NOT invent different creative angles. Do not write a contrarian version, a',
    '  question version, or a shock version. Small, plausible, same-family rewrites only.',
    '- Every variant must still be honestly delivered by the caption you are given.',
    '- No emoji. No hashtags. No quotation marks around the hook.',
    '- Short enough to read at a glance.',
    '',
    'Good example. Seed: "22 reasons to move to Thailand"',
    '  22 reasons why Thailand is the best place to start a business',
    '  22 reasons why you should move to Thailand while you are young',
    '  22 reasons to move to Thailand before you turn 30',
    'Bad example (these change the format and are useless as a test):',
    '  Why is everyone moving to Thailand?',
    '  Nobody tells you this about Thailand',
  ].join('\n');
}

function userPrompt(opts: HookVariantOptions): string {
  const parts = [
    `Seed hook: ${opts.seedHook}`,
    '',
    'The caption these hooks must pay off:',
    opts.caption.slice(0, 4000),
    '',
    `Write exactly ${opts.count} variants of the seed hook.`,
    'Do not include the seed hook itself in the list.',
  ];
  if (opts.notes !== undefined && opts.notes.trim() !== '') {
    parts.push('', 'Additional direction from the author:', opts.notes.trim());
  }
  return parts.join('\n');
}

export async function generateHookVariants(opts: HookVariantOptions): Promise<HookVariant[]> {
  requireEnv(
    'ANTHROPIC_API_KEY',
    'Generating hook variants calls the Claude API. Create a key at https://console.anthropic.com/.',
  );
  if (opts.seedHook.trim() === '') throw new UserError('Write a hook to base the variants on.');
  if (opts.caption.trim() === '') throw new UserError('Paste your caption first.');

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    // Thinking is on by default on Claude Opus 5; stated explicitly so the
    // max_tokens headroom above is obviously deliberate.
    thinking: { type: 'adaptive' },
    system: systemPrompt(),
    messages: [{ role: 'user', content: userPrompt(opts) }],
    output_config: { format: zodOutputFormat(VariantSchema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new UserError(
      `The model declined this hook (${response.stop_details?.category ?? 'no category given'}). ` +
        'Rephrase and try again.',
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new UserError('The model ran out of room. Ask for fewer variants.');
  }

  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new UserError('The model returned no structured output. Try again.');
  }

  // The seed is always variant one, so the author's own wording is in the test.
  const seed: HookVariant = {
    id: 'seed',
    text: opts.seedHook.trim(),
    variation: 'your original',
    brollPath: null,
  };

  const variants = parsed.variants
    .map((variant) => ({
      text: variant.text.trim(),
      variation: variant.variation.trim(),
    }))
    .filter((variant) => variant.text !== '' && variant.text !== seed.text);

  if (variants.length === 0) throw new UserError('The model returned no usable variants.');

  return [seed, ...withIds(variants)];
}

/** Ids become filenames, so collisions have to be resolved rather than tolerated. */
function withIds(variants: { text: string; variation: string }[]): HookVariant[] {
  const seen = new Map<string, number>();
  return variants.map((variant, index) => {
    const base =
      variant.variation
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30) || `variant-${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      id: count === 0 ? base : `${base}-${count + 1}`,
      text: variant.text,
      variation: variant.variation,
      brollPath: null,
    };
  });
}
