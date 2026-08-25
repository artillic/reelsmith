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
          .describe('The qualifier, in two or three plain words, e.g. "young people".'),
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
    'You rewrite one listicle hook into simple variations for A/B testing.',
    '',
    'The format is always the same: a number, then a noun like reasons / rules / lessons /',
    'signs, then who or what it is for. Only the last part changes between variants.',
    '',
    'Change exactly one thing per variant, and only ever the QUALIFIER — who it is for, or',
    'what it is for:',
    '  - the audience         (young people, entrepreneurs, remote workers, couples)',
    '  - the use case         (starting an online business, raising a family, retiring early)',
    '  - the life stage       (while you are young, before you turn 30, in your twenties)',
    '',
    'Keep everything else identical: the same number, the same noun, the same subject.',
    '',
    'Seed: "22 reasons you should move to Thailand"',
    'Correct variants:',
    '  22 reasons why Thailand is the best place to start an online business',
    '  22 reasons young people should move to Thailand',
    '  22 reasons every entrepreneur should move to Thailand',
    '  22 reasons you should move to Thailand while you are young',
    '',
    'Wrong, every one of these — do not produce anything like them:',
    '  Nobody tells you this about Thailand        (dropped the format)',
    '  Why is everyone moving to Thailand?         (turned it into a question)',
    '  I pay 8,000 baht for a penthouse            (a specific detail instead of a listicle)',
    '  Thailand vs Dubai: 22 reasons               (a comparison)',
    '  22 reasons NOT to move to Thailand          (reversed the meaning)',
    '',
    'Other rules:',
    '- The caption must honestly deliver on every variant you write.',
    '- No emoji, no hashtags, no quotation marks, no ALL CAPS.',
    '- Short enough to read at a glance.',
    '- Label each variant with the qualifier in two or three plain words, e.g.',
    '  "young people", "entrepreneurs", "online business". Not a category name.',
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

  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      // Thinking is on by default on Claude Opus 5; stated explicitly so the
      // max_tokens headroom above is obviously deliberate.
      thinking: { type: 'adaptive' },
      system: systemPrompt(),
      messages: [{ role: 'user', content: userPrompt(opts) }],
      output_config: { format: zodOutputFormat(VariantSchema) },
    });
  } catch (err) {
    throw explainApiError(err);
  }

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

/**
 * Turns SDK errors into something a person can act on. The raw shape is a JSON
 * blob that reads as noise in the dashboard, and the fix is almost always a
 * specific one-line instruction.
 */
function explainApiError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new UserError(
      'Anthropic rejected your API key. Check it on the Setup screen — keys start with "sk-ant-".',
    );
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new UserError(
      'Your Anthropic API key does not have access to this model. Check the key\'s permissions.',
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new UserError('Anthropic rate-limited the request. Wait a minute and try again.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    const message = err.message.toLowerCase();
    if (message.includes('credit') || message.includes('billing')) {
      return new UserError(
        'Your Anthropic account is out of credit. Top it up at console.anthropic.com, then try again.',
      );
    }
    return new UserError(`Anthropic rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new UserError('Could not reach Anthropic. Check your internet connection and try again.');
  }
  // APIConnectionError is checked above: in the TypeScript SDK it subclasses
  // APIError, so the order matters.
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return new UserError(
      status >= 500
        ? 'Anthropic is having trouble right now. Try again in a moment.'
        : `Anthropic returned ${status}: ${err.message}`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
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
