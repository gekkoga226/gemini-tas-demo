import test from "node:test";
import assert from "node:assert/strict";
import { pairedStandard, alignmentOffset, bandPairs, timeDifferences, timebarAxis, secondsAtPointer, timebarScale, xAtSeconds } from "../public/result-compare.js";

const seg = (segment_id, start_s, end_s, job_no, job_title = `作業${job_no}`) => ({ segment_id, start_s, end_s, job_no, job_title });

// お手本: 100, 120, 130 (one pass). 対象: 100, 120, waiting, 120 again, 130, 150 (not in the お手本).
const standard = [seg("s1", 0, 10, "100"), seg("s2", 10, 22, "120"), seg("s3", 22, 34, "130")];
const target = [seg("t1", 0, 12, "100"), seg("t2", 12, 25, "120"), seg("t3", 25, 31, "NW07"), seg("t4", 31, 36, "120"), seg("t5", 36, 50, "130"), seg("t6", 50, 55.5, "150")];
const labels = [
  { job_no: "100", job_title: "部品を準備する", kind: "work", standard_duration_s: 11 },
  { job_no: "120", job_title: "ねじを仮締めする", kind: "work", standard_duration_s: 13 },
  { job_no: "130", job_title: "ねじを本締めする", kind: "work", standard_duration_s: 12 },
  { job_no: "150", job_title: "完成品を置く", kind: "work", standard_duration_s: null },
  { job_no: "NW07", job_title: "その他（部品待ち）", kind: "non_work" },
];

test("pairedStandard pairs the k-th occurrence of a process with the k-th in the お手本", () => {
  assert.equal(pairedStandard(target, 0, standard).segment_id, "s1");
  assert.equal(pairedStandard(target, 1, standard).segment_id, "s2", "first 120 pairs with the first 120");
  assert.equal(pairedStandard(target, 3, standard), null, "second 120 has no second occurrence in the お手本");
  assert.equal(pairedStandard(target, 2, standard), null, "a process missing from the お手本 is not paired");
  assert.equal(pairedStandard(target, 9, standard), null, "out of range");
});

test("pairedStandard counts occurrences by start time, not by array order", () => {
  const shuffled = [target[3], target[0], target[1]];
  assert.equal(pairedStandard(shuffled, 2, standard).segment_id, "s2", "the earlier 120 is still the first occurrence");
  assert.equal(pairedStandard(shuffled, 0, standard), null);
});

test("bandPairs lists only the pairs that exist on both rows", () => {
  assert.deepEqual(bandPairs(target, standard).map((p) => [p.target.segment_id, p.standard.segment_id]), [["t1", "s1"], ["t2", "s2"], ["t5", "s3"]]);
});

test("alignmentOffset shifts the お手本 so that the chosen process starts together", () => {
  assert.deepEqual(alignmentOffset(target, 4, standard), { offset: 14, standard: standard[2], missing: false });
  assert.deepEqual(alignmentOffset(target, 3, standard), { offset: 21, standard: standard[1], missing: false }, "falls back to the first occurrence when there is no k-th one");
  assert.deepEqual(alignmentOffset(target, 2, standard), { offset: 0, standard: null, missing: true });
  assert.deepEqual(alignmentOffset([], 0, standard), { offset: 0, standard: null, missing: true });
});

test("timeDifferences totals each process, subtracts お手本 from 対象 and keeps missing sides empty", () => {
  const { rows, total } = timeDifferences(standard, target, labels);
  const byJob = Object.fromEntries(rows.map((r) => [r.job_no, r]));
  assert.deepEqual(byJob["120"], { job_no: "120", job_title: "ねじを仮締めする", kind: "work", st_s: 13, standard_s: 12, target_s: 18, diff_s: 6 });
  assert.equal(byJob["130"].diff_s, 2);
  assert.equal(byJob["100"].diff_s, 2);
  assert.deepEqual([byJob["150"].standard_s, byJob["150"].target_s, byJob["150"].diff_s], [null, 5.5, null], "no お手本 → no zero sample, no difference");
  assert.equal(byJob["NW07"].st_s, null);
  assert.deepEqual(total, { standard_s: 34, target_s: 55.5, diff_s: 21.5 });
});

test("timeDifferences orders by the size of the difference, then by the 作業名一覧, with empty differences last", () => {
  const { rows } = timeDifferences(standard, target, labels);
  assert.deepEqual(rows.map((r) => r.job_no), ["120", "100", "130", "150", "NW07"]);
});

test("timeDifferences rounds away floating point noise and does not change its inputs", () => {
  const before = JSON.stringify([standard, target]);
  const { rows } = timeDifferences([seg("a", 0, 0.1, "100"), seg("b", 0.1, 0.3, "100")], [seg("c", 0, 0.6, "100")], labels);
  assert.equal(rows[0].standard_s, 0.3);
  assert.equal(rows[0].diff_s, 0.3);
  timeDifferences(standard, target, labels);
  assert.equal(JSON.stringify([standard, target]), before);
});

test("timeDifferences falls back to the segment title when the 作業名一覧 does not have the process", () => {
  const { rows } = timeDifferences([], [seg("x", 0, 4, "999", "予定外の作業")], []);
  assert.deepEqual(rows, [{ job_no: "999", job_title: "予定外の作業", kind: null, st_s: null, standard_s: null, target_s: 4, diff_s: null }]);
});

// お手本 100, 110, 120, 130 (6 s each). The target's 130 starts 5 s earlier than the お手本's, so aligning by that process
// puts the left end of the time bar at −5 s, and the alignment follows the start that is being dragged.
const dragStandard = [seg("s1", 0, 6, "100"), seg("s2", 6, 12, "110"), seg("s3", 12, 18, "120"), seg("s4", 18, 24, "130")];
const dragTarget = () => [seg("t1", 0, 6, "100"), seg("t2", 6, 12, "110"), seg("t3", 8, 13, "NW07"), seg("t4", 13, 24, "130")];

function dragLeftHandle({ keepAxis, pointerMovesBy }) {
  const maxEnd = 30;
  const pps = 50;
  let target = dragTarget();
  const axisFor = (frozen) => timebarAxis({ alignment: alignmentOffset(target, 3, dragStandard), withStandard: true, maxEnd, standardDuration: 24, frozen });
  const axisAtStart = axisFor(null);
  const handleX = (target[3].start_s - axisAtStart.tMin) * pps; // pixels from the left end of the track at the start of the drag
  const starts = [];
  for (const seconds of pointerMovesBy) {
    const axis = axisFor(keepAxis ? axisAtStart : null);
    const start = Math.round(secondsAtPointer({ x: handleX + seconds * pps, tMin: axis.tMin, pps, maxEnd }));
    target = target.map((s, i) => (i === 3 ? { ...s, start_s: start } : s));
    starts.push(start);
  }
  return { starts, axisAtStart, axisAfter: axisFor(null) };
}

test("timebarAxis keeps the axis of the drag start, so a dragged start follows the pointer second by second", () => {
  const { starts, axisAtStart } = dragLeftHandle({ keepAxis: true, pointerMovesBy: [1, 2, 3, 3, 3] });
  assert.equal(axisAtStart.tMin, -5);
  assert.deepEqual(starts, [14, 15, 16, 16, 16], "no runaway, and the same pointer position gives the same second");
});

test("timebarAxis follows the new alignment once the drag is over", () => {
  const { axisAfter } = dragLeftHandle({ keepAxis: true, pointerMovesBy: [3] });
  assert.deepEqual([axisAfter.offset, axisAfter.tMin, axisAfter.tMax], [-2, -2, 30]);
});

test("timebarAxis reaches as far as the shifted お手本, and does not shift anything without one", () => {
  const alignment = { offset: 14, standard: dragStandard[3], missing: false };
  assert.deepEqual(timebarAxis({ alignment, withStandard: true, maxEnd: 30, standardDuration: 24 }), { alignment, offset: 14, tMin: 0, tMax: 38 });
  const none = { offset: 0, standard: null, missing: false };
  assert.deepEqual(timebarAxis({ alignment: none, withStandard: false, maxEnd: 30, standardDuration: 0 }), { alignment: none, offset: 0, tMin: 0, tMax: 30 });
});

test("secondsAtPointer turns a distance from the left end of the track into target time inside the video", () => {
  assert.equal(secondsAtPointer({ x: 100, tMin: -5, pps: 20, maxEnd: 30 }), 0);
  assert.equal(secondsAtPointer({ x: 300, tMin: -5, pps: 20, maxEnd: 30 }), 10);
  assert.equal(secondsAtPointer({ x: 10, tMin: -5, pps: 20, maxEnd: 30 }), 0, "never before 0 s");
  assert.equal(secondsAtPointer({ x: 2000, tMin: 0, pps: 20, maxEnd: 30 }), 30, "never past the end of the video");
});

test("timebarScale keeps a gutter at both ends so the rings of the first and last segment are not cut off", () => {
  const fit = timebarScale({ view: 1000, zoom: 1, axisEnd: 100, tMin: 0, tMax: 100, pad: 8 });
  assert.equal(fit.width, 1000, "at 100% the bar fits the view");
  assert.equal(xAtSeconds({ t: 0, tMin: 0, pps: fit.pps, pad: 8 }), 8, "0 s sits one gutter in from the left end");
  assert.ok(Math.abs(xAtSeconds({ t: 100, tMin: 0, pps: fit.pps, pad: 8 }) - (fit.width - 8)) < 1e-9, "the end sits one gutter in from the right end");
  const zoomed = timebarScale({ view: 1000, zoom: 2, axisEnd: 100, tMin: 0, tMax: 100, pad: 8 });
  assert.equal(zoomed.width, 2 * (1000 - 16) + 16, "zoom widens only the part between the gutters");
});

test("timebarScale leaves room for the お手本 slid to the left of 0 s, and is unchanged without a gutter", () => {
  const slid = timebarScale({ view: 1000, zoom: 1, axisEnd: 100, tMin: -10, tMax: 100, pad: 8 });
  assert.ok(Math.abs(slid.width - (110 * slid.pps + 16)) < 1e-9);
  assert.ok(slid.width > 1000);
  assert.deepEqual(timebarScale({ view: 1000, zoom: 1, axisEnd: 100, tMin: 0, tMax: 100 }), { pps: 10, width: 1000 });
});

test("secondsAtPointer subtracts the gutter, so the pointer and the drawn position agree", () => {
  assert.equal(secondsAtPointer({ x: 8 + 200, tMin: 0, pps: 20, maxEnd: 30, pad: 8 }), 10);
  assert.equal(secondsAtPointer({ x: 3, tMin: 0, pps: 20, maxEnd: 30, pad: 8 }), 0, "the gutter itself is 0 s");
  const pps = 12.5;
  for (const t of [0, 7, 19, 30]) assert.equal(secondsAtPointer({ x: xAtSeconds({ t, tMin: -5, pps, pad: 8 }), tMin: -5, pps, maxEnd: 30, pad: 8 }), t);
});

test("timebarScale never makes the track narrower than the visible area", () => {
  const short = timebarScale({ view: 1000, zoom: 1, axisEnd: 200, tMin: 0, tMax: 100, pad: 8 });
  assert.equal(short.width, 1000);
  assert.ok(Math.abs(short.pps - 984 / 200) < 1e-9);
});
