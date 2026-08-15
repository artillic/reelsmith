import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { RenderConfig } from './config.ts';
import { UserError } from './log.ts';

/**
 * ffmpeg is invoked with an argv array and no shell, so filenames containing
 * spaces, quotes or shell metacharacters are inert.
 */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(
        new UserError(
          `Could not run ${bin}: ${err.message}\n` +
            'Install ffmpeg (macOS: `brew install ffmpeg`) and make sure it is on your PATH.',
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new UserError(`${bin} exited with code ${code}.\n${tail(stderr)}`));
    });
  });
}

function tail(text: string, lines = 15): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

export async function assertFfmpeg(): Promise<void> {
  await run('ffmpeg', ['-version']);
  await run('ffprobe', ['-version']);
}

export async function probeDuration(path: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const seconds = Number.parseFloat(out);
  return Number.isFinite(seconds) ? seconds : 0;
}

export interface RenderVariantOptions {
  brollPath: string;
  /** Full-frame transparent PNG produced by overlay.ts. */
  overlayPath: string;
  outPath: string;
  config: RenderConfig;
  /**
   * Replaces the b-roll's own audio. Leave undefined to keep the source audio.
   * Note: reels whose audio is not in Metricool's library cannot auto-publish,
   * so a baked-in track forces notification-based publishing.
   */
  audioPath?: string;
}

export function buildFfmpegArgs(opts: RenderVariantOptions): string[] {
  const { width, height, fps, durationSeconds, crf } = opts.config;

  const filter =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},setsar=1,fps=${fps}[bg];` +
    `[bg][1:v]overlay=0:0:format=auto[v]`;

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    // Loop the source so a clip shorter than the target duration still fills it;
    // -t below is what actually ends the output.
    '-stream_loop',
    '-1',
    '-i',
    opts.brollPath,
    '-i',
    opts.overlayPath,
  ];

  if (opts.audioPath !== undefined) {
    args.push('-stream_loop', '-1', '-i', opts.audioPath);
  }

  args.push('-filter_complex', filter, '-map', '[v]');

  if (opts.audioPath !== undefined) {
    args.push('-map', '2:a');
  } else {
    // '?' makes the audio stream optional — silent b-roll renders fine.
    args.push('-map', '0:a?');
  }

  args.push(
    '-t',
    String(durationSeconds),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-movflags',
    '+faststart',
    opts.outPath,
  );

  return args;
}

export async function renderVariant(opts: RenderVariantOptions): Promise<void> {
  if (!existsSync(opts.brollPath)) {
    throw new UserError(`B-roll clip not found: ${opts.brollPath}`);
  }
  await run('ffmpeg', buildFfmpegArgs(opts));
}

/** Grabs the cover frame. Metricool takes a separate cover image for reels. */
export async function extractCover(
  videoPath: string,
  outPath: string,
  atSeconds: number,
): Promise<void> {
  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(atSeconds),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outPath,
  ]);
}
