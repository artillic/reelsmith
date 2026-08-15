import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  publicBaseUrl,
  contentTypeFor,
  resolveMediaBaseUrl,
  tryLoadStorageConfig,
} from '../src/storage.ts';
import { publicMediaUrl } from '../src/metricool.ts';
import { UserError } from '../src/log.ts';

const STORAGE_VARS = [
  'MEDIA_PUBLIC_BASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_BUCKET',
];

beforeEach(() => {
  for (const key of STORAGE_VARS) delete process.env[key];
});

test('builds the Supabase public object base url', () => {
  const base = publicBaseUrl({ url: 'https://abc.supabase.co', bucket: 'reels' });
  assert.equal(base, 'https://abc.supabase.co/storage/v1/object/public/reels');
});

test('maps rendered file types to the content types Metricool expects', () => {
  assert.equal(contentTypeFor('out/a.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('out/a.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('out/a.weird'), 'application/octet-stream');
});

test('derives the media base url from Supabase config when no explicit base is set', () => {
  process.env['SUPABASE_URL'] = 'https://abc.supabase.co';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-key';
  assert.equal(resolveMediaBaseUrl(), 'https://abc.supabase.co/storage/v1/object/public/reels');
});

test('honours a custom bucket name', () => {
  process.env['SUPABASE_URL'] = 'https://abc.supabase.co';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-key';
  process.env['SUPABASE_BUCKET'] = 'trial-reels';
  assert.match(resolveMediaBaseUrl(), /\/public\/trial-reels$/);
});

test('an explicit base url wins over Supabase config', () => {
  process.env['SUPABASE_URL'] = 'https://abc.supabase.co';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-key';
  process.env['MEDIA_PUBLIC_BASE_URL'] = 'https://cdn.example.com/reels';
  assert.equal(resolveMediaBaseUrl(), 'https://cdn.example.com/reels');
});

test('strips trailing slashes so the joined url never doubles up', () => {
  process.env['MEDIA_PUBLIC_BASE_URL'] = 'https://cdn.example.com/reels///';
  assert.equal(publicMediaUrl('/tmp/out/number-led.mp4'), 'https://cdn.example.com/reels/number-led.mp4');
});

test('throws actionable guidance when no media location is configured', () => {
  assert.throws(() => resolveMediaBaseUrl(), UserError);
});

test('treats storage as unconfigured unless both url and key are present', () => {
  process.env['SUPABASE_URL'] = 'https://abc.supabase.co';
  assert.equal(tryLoadStorageConfig(), null);
});

test('builds the media url from the rendered filename', () => {
  process.env['MEDIA_PUBLIC_BASE_URL'] = 'https://cdn.example.com/reels';
  assert.equal(
    publicMediaUrl('/anywhere/content/x/out/loss-framing.mp4'),
    'https://cdn.example.com/reels/loss-framing.mp4',
  );
});
