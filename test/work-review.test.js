import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import '../public/work-core.js';
import { createAppServer } from '../server.js';
import { fixture, waitRun } from '../test-support/fixture.js';
import { defaultSettings } from '../src/settings.js';
import { id, sha256 } from '../src/core.js';

const C = globalThis.WorkAnalysis;

test('review totals conserve all time, share observations, and retain unassigned activities', () => {
  for (const seconds of [0.01, 3.21, 4800, 7200, 7350]) {
    const result = C.validate(C.createDemo(seconds));
    const observation = s => [s.start_sec, s.end_sec, s.action, s.before, s.after, s.object];
    assert.deepEqual(result.modes.zero.segments.map(observation), result.modes.few.segments.map(observation));
    for (const mode of ['zero', 'few']) {
      const summary = C.stats(result, mode);
      assert.ok(Math.abs(Object.values(summary.totals).reduce((a, b) => a + b, 0) - seconds) < 1e-8);
      const assigned = summary.groups.reduce((n, g) => n + g.actual, 0);
      assert.ok(Math.abs(assigned + summary.totals.unmatched + summary.totals.uncertain - seconds) < 1e-8);
      assert.ok(result.modes[mode].segments.some(s => s.activity === 'wait'));
    }
  }
});

test('boundary editing records both neighbors and preserves the original and other mode', () => {
  const result = C.createDemo(), original = structuredClone(result), segment = result.modes.zero.segments[1];
  const changed = C.update(result, 'zero', segment.id, { ...segment, start_sec: segment.start_sec + 5, end_sec: segment.end_sec + 10, review_status: 'verified' });
  assert.deepEqual(result, original);
  assert.deepEqual(changed.modes.few, original.modes.few);
  assert.deepEqual(changed.original_modes, original.modes);
  assert.equal(changed.history[0].neighbors.length, 2);
  assert.deepEqual(changed.history[0].neighbors[0].before, original.modes.zero.segments[0]);
  assert.equal(changed.modes.zero.segments[0].end_sec, changed.modes.zero.segments[1].start_sec);
  assert.equal(changed.modes.zero.segments[2].start_sec, changed.modes.zero.segments[1].end_sec);
  assert.ok(changed.modes.zero.segments.slice(0, 3).every(s => s.review_status === 'draft'));
  assert.deepEqual(C.validate(JSON.parse(JSON.stringify(changed))), changed);
});

test('rejects even millisecond gaps, overlaps, duplicate IDs, unknown enums and invalid references atomically', () => {
  const original = C.createDemo();
  for (const mutate of [
    r => r.modes.zero.segments[1].start_sec += .001,
    r => r.modes.zero.segments[1].start_sec -= .001,
    r => r.modes.zero.segments.at(-1).end_sec -= .001,
    r => r.modes.zero.segments[1].id = r.modes.zero.segments[0].id,
    r => r.modes.zero.segments[0].standard_id = 'UNKNOWN',
    r => r.modes.zero.segments[0].match_status = 'unmatched',
    r => r.modes.zero.segments[0].activity = 'constructor',
    r => r.modes.zero.segments[0].review_status = 'toString',
    r => r.modes.zero.segments[0].start_sec = '0',
    r => r.history = 'not-history',
    r => delete r.video.size_bytes,
    r => delete r.standard_cards[0].duration_sec,
    r => r.modes.zero.segments.push(...Array(5001).fill(r.modes.zero.segments[0])),
  ]) {
    const malformed = structuredClone(original); mutate(malformed);
    const before = structuredClone(malformed);
    assert.throws(() => C.validate(malformed));
    assert.deepEqual(malformed, before);
  }
  assert.throws(() => C.update(original, 'zero', 'seg_002', { ...original.modes.zero.segments[1], start_sec: 0 }));
});

test('video binding checks identity, records a small final-boundary adjustment, and cannot collapse a segment', () => {
  const result = C.createDemo(30, 'actual.mp4', 1000), video = { name: 'actual.mp4', size_bytes: 1000, duration_sec: 30.2 };
  const bound = C.bindVideo(result, video);
  assert.equal(bound.modes.zero.segments.at(-1).end_sec, 30.2);
  assert.equal(bound.original_modes.zero.segments.at(-1).end_sec, 30);
  assert.equal(bound.original_video.duration_sec, 30);
  assert.equal(bound.history.length, 2);
  assert.deepEqual(C.validate(JSON.parse(JSON.stringify(bound))), bound);
  assert.throws(() => C.bindVideo(result, { ...video, name: 'other.mp4' }));
  assert.throws(() => C.bindVideo(result, { ...video, size_bytes: 2000 }));
  assert.throws(() => C.bindVideo(result, { ...video, duration_sec: 33 }));
  assert.throws(() => C.bindVideo(result, { ...video, duration_sec: 28.1 }));
  assert.equal(result.video.duration_sec, 30);
});

test('one-mode input leaves the missing mode empty and does not invent takt time', async () => {
  const result = JSON.parse(await fs.readFile(new URL('../public/examples/work-result.json', import.meta.url), 'utf8'));
  delete result.modes.few; delete result.tt_sec;
  const validated = C.validate(result);
  assert.equal(validated.tt_sec, null);
  assert.equal(C.stats(validated, 'few').count, 0);
  delete result.modes.zero;
  assert.throws(() => C.validate(result));
});

test('CSV preserves mode, source and spreadsheet-safe quoting', () => {
  const result = C.createDemo();
  for (const prefix of ['=', '+', '-', '@', '\t=', '\r+']) {
    result.modes.zero.segments[0].note = prefix + 'HYPERLINK("a", "b")';
    const csv = C.csv(result, 'zero');
    assert.ok(csv.includes('"demo","zero"'));
    assert.ok(csv.includes('"\'' + prefix + 'HYPERLINK(""a"", ""b"")"'));
    assert.equal(csv.charCodeAt(0), 0xfeff);
  }
});

test('stored pipeline result opens in the new contract without mutating inference or exposing GT', async t => {
  const { service, config, demo } = await fixture(t);
  const run = await service.createAnalysis({ client_request_id: id(), input_video_id: demo.actual_video_id,
    standard_set_id: demo.standard_set_id, analysis_mode: 'few_shot', analysis_strategy: 'text_only',
    settings: defaultSettings(config), consent_confirmed: true });
  assert.equal((await waitRun(service, run.run_id)).status, 'succeeded');
  const original = await service.result(run.run_id), originalHash = sha256(original);
  const server = createAppServer({ ...config, port: 0 }, { tasService: service });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/analysis-runs/${run.run_id}/work-review`);
  assert.equal(response.status, 200);
  const review = C.validate(await response.json());
  assert.equal(review.source.result_sha256, originalHash);
  assert.equal(review.data_source, 'demo');
  assert.equal(review.tt_sec, null);
  assert.equal(review.modes.zero, undefined);
  assert.deepEqual(review.modes.few.segments.map(s => [s.start_sec, s.end_sec]), original.segments.map(s => [s.start_s, s.end_s]));
  assert.ok(review.modes.few.segments.every(s => s.review_status === 'draft'));
  assert.ok(review.modes.few.segments.filter(s => !s.standard_id).every(s => s.match_status === 'uncertain'));
  assert.ok(!JSON.stringify(review).includes('build_only_gt'));
  assert.equal(sha256(await service.result(run.run_id)), originalHash);
  for (const url of ['/', '/analysis.html', '/work-styles.css', '/work-core.js', '/work-app.js']) {
    const page = await fetch(base + url); assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok(!page.headers.get('content-security-policy').includes('unsafe-inline'));
  }
});
