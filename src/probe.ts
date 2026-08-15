import { writeFileSync } from 'node:fs';
import { MetricoolClient, loadCredentials } from './metricool.ts';
import { log } from './log.ts';

/**
 * Answers the one question the public docs do not: does the Metricool API
 * expose the Instagram trial-reel flag, and if so under what key?
 *
 * It does not guess. It reads back a trial reel you scheduled by hand in the
 * Planner and looks for what distinguishes it from an ordinary reel.
 */

export interface KeyHit {
  path: string;
  value: unknown;
}

/** Walks arbitrary JSON collecting paths whose key or string value matches `needle`. */
export function findKeys(value: unknown, needle: RegExp, path = '$'): KeyHit[] {
  const hits: KeyHit[] = [];

  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findKeys(item, needle, `${path}[${i}]`)));
    return hits;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (needle.test(key)) hits.push({ path: childPath, value: child });
      else if (typeof child === 'string' && needle.test(child)) hits.push({ path: childPath, value: child });
      hits.push(...findKeys(child, needle, childPath));
    }
    return hits;
  }
  return hits;
}

/** Collects every leaf path in a JSON value, for diffing two posts. */
export function leafPaths(value: unknown, path = '$', out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) {
    value.forEach((item, i) => leafPaths(item, `${path}[${i}]`, out));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) leafPaths(child, `${path}.${key}`, out);
  } else {
    out.set(path, value);
  }
  return out;
}

function civilDate(offsetDays: number): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return now.toISOString().slice(0, 10);
}

export async function runProbe(dumpPath: string, windowDays = 30): Promise<void> {
  const client = new MetricoolClient(loadCredentials());

  log.step('Checking credentials and listing scheduled posts');
  const start = `${civilDate(-windowDays)}T00:00:00`;
  const end = `${civilDate(windowDays)}T23:59:59`;
  const posts = await client.listScheduledPosts(start, end);

  log.info(`GET /v2/scheduler/posts -> ${posts.status}`);
  if (!posts.ok) {
    log.error('The scheduler endpoint rejected the request.');
    log.info(posts.text.slice(0, 500));
    log.info(
      'A 401/403 usually means the token is wrong or the account is not on the Advanced plan; ' +
        'a 400 usually means userId/blogId is wrong.',
    );
    return;
  }

  writeFileSync(dumpPath, `${JSON.stringify(posts.data, null, 2)}\n`, 'utf8');
  log.ok(`Raw scheduler response written to ${dumpPath}`);

  log.step('Searching the response for a trial-reel marker');
  const hits = findKeys(posts.data, /trial/i);

  if (hits.length > 0) {
    log.ok(`Found ${hits.length} candidate field(s):`);
    for (const hit of hits.slice(0, 20)) {
      log.info(`${stripIndex(hit.path)}  =  ${JSON.stringify(hit.value)?.slice(0, 120)}`);
    }
    log.info('');
    log.info('Set the winning path in reelsmith/.env, without the leading "$." and array indexes:');
    log.info('  METRICOOL_TRIAL_FIELD=<path>');
    log.info('  METRICOOL_TRIAL_VALUE=true');
    return;
  }

  log.warn('No field containing "trial" appeared in the response.');
  log.info('');
  log.info('Two possibilities, in order of likelihood:');
  log.info(
    '  1. No trial reel exists in the probed window. Schedule ONE trial reel by hand in the ' +
      'Metricool Planner, then re-run `reel probe`.',
  );
  log.info(
    '  2. The API genuinely does not expose the flag. In that case run `reel schedule` without ' +
      '--auto-publish: everything is pre-filled as a draft and you flip the trial toggle in the Planner.',
  );
  log.info('');
  log.info(
    `To diff manually: schedule one trial reel and one ordinary reel, re-run the probe, and ` +
      `compare their objects in ${dumpPath}.`,
  );
}

function stripIndex(path: string): string {
  return path.replace(/^\$\./, '').replace(/\[\d+\]/g, '');
}
