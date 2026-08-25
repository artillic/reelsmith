import type { PipelineLogger } from './pipeline.ts';

/**
 * Long stages (render, upload, schedule) outlive a single HTTP request, so the
 * browser starts a job and polls it. Everything is in memory: a dashboard run
 * is one person on one laptop, and job history has no value once the process
 * exits.
 */
export type JobStatus = 'running' | 'done' | 'error';

export interface JobLine {
  kind: 'step' | 'info' | 'ok' | 'warn' | 'error';
  text: string;
}

export interface Job {
  id: string;
  label: string;
  /** Which project this job belongs to, so the UI can reattach after a reload. */
  slug: string | null;
  status: JobStatus;
  lines: JobLine[];
  result: unknown;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const jobs = new Map<string, Job>();
let counter = 0;

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Most recent first, so the dashboard can show what just happened. */
export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
}

export function startJob(
  label: string,
  run: (log: PipelineLogger) => Promise<unknown>,
  slug: string | null = null,
  now: () => number = Date.now,
): Job {
  counter += 1;
  const job: Job = {
    id: `job-${counter}`,
    label,
    slug,
    status: 'running',
    lines: [],
    result: null,
    error: null,
    startedAt: now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  const push = (kind: JobLine['kind']) => (text: string) => {
    job.lines.push({ kind, text });
  };
  const logger: PipelineLogger = {
    step: push('step'),
    info: push('info'),
    ok: push('ok'),
    warn: push('warn'),
  };

  // Deliberately not awaited: the HTTP handler returns the id immediately and
  // the browser polls. Rejections are captured onto the job, never unhandled.
  void run(logger).then(
    (result) => {
      job.result = result ?? null;
      job.status = 'done';
      job.finishedAt = now();
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      job.lines.push({ kind: 'error', text: message });
      job.error = message;
      job.status = 'error';
      job.finishedAt = now();
    },
  );

  return job;
}

/** Test seam — the dashboard never needs this. */
export function resetJobs(): void {
  jobs.clear();
  counter = 0;
}
