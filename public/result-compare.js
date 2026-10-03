// Display-only comparison of the target segments with one お手本: time bar bands, alignment and the
// time-difference table. Works on {segment_id, start_s, end_s, job_no, job_title}. Never imported by
// inference builders, and never changes its inputs.

const round = (value) => Math.round(value * 100) / 100;
const byStart = (a, b) => a.start_s - b.start_s;

// The k-th occurrence of a process in the target is paired with the k-th occurrence in the お手本.
export function pairedStandard(targetSegments, index, standardSegments) {
  const target = targetSegments[index];
  if (!target) return null;
  const k = targetSegments.filter((s) => s.job_no === target.job_no && s.start_s < target.start_s).length;
  return standardSegments.filter((s) => s.job_no === target.job_no).sort(byStart)[k] ?? null;
}

export function bandPairs(targetSegments, standardSegments) {
  return targetSegments
    .map((target, index) => ({ target, standard: pairedStandard(targetSegments, index, standardSegments) }))
    .filter((pair) => pair.standard);
}

// Seconds to add to お手本 times so that the chosen process starts at the same place as in the target.
// The seconds-to-pixels scale is not part of the alignment.
export function alignmentOffset(targetSegments, index, standardSegments) {
  const target = targetSegments[index];
  const standard = target
    ? pairedStandard(targetSegments, index, standardSegments) ?? standardSegments.filter((s) => s.job_no === target.job_no).sort(byStart)[0] ?? null
    : null;
  return standard ? { offset: round(target.start_s - standard.start_s), standard, missing: false } : { offset: 0, standard: null, missing: true };
}

// Left end (tMin), right end (tMax) of the time bar in target seconds and how far the お手本 row is slid (offset).
// `frozen` is the axis taken when a handle drag began. The alignment follows the start of the selected segment,
// so recomputing it under the pointer would move the axis while the handle is still being dragged.
export function timebarAxis({ alignment, withStandard, maxEnd, standardDuration, frozen = null }) {
  if (frozen) return frozen;
  const { offset } = alignment;
  return { alignment, offset, tMin: Math.min(0, withStandard ? offset : 0), tMax: Math.max(maxEnd, withStandard ? standardDuration + offset : 0) };
}

// Pixels per second and track width. `pad` is a gutter kept free at both ends so the focus ring of the first and last segment is not cut off.
export function timebarScale({ view, zoom, axisEnd, tMin, tMax, pad = 0 }) {
  const pps = (view - 2 * pad) * zoom / axisEnd;
  return { pps, width: Math.max(view, (tMax - tMin) * pps + 2 * pad) };
}

// Distance in pixels from the left end of the track to a target second.
export function xAtSeconds({ t, tMin, pps, pad = 0 }) {
  return pad + (t - tMin) * pps;
}

// Target second under the pointer; x is the distance in pixels from the left end of the track.
export function secondsAtPointer({ x, tMin, pps, maxEnd, pad = 0 }) {
  return Math.max(0, Math.min(maxEnd, tMin + (x - pad) / pps));
}

function totals(segments) {
  const map = new Map();
  for (const s of segments) map.set(s.job_no, (map.get(s.job_no) ?? 0) + (s.end_s - s.start_s));
  return map;
}

// Totals per process for one お手本 and the target, and 対象 − お手本. A process missing on one side is
// not a zero-second sample: its total and difference stay null (shown as 該当なし and —).
export function timeDifferences(standardSegments, targetSegments, labels = []) {
  const standard = totals(standardSegments);
  const target = totals(targetSegments);
  const byNo = new Map(labels.map((label) => [label.job_no, label]));
  const titles = new Map([...standardSegments, ...targetSegments].map((s) => [s.job_no, s.job_title]));
  const order = [...new Set([...labels.map((l) => l.job_no), ...standard.keys(), ...target.keys()])];
  const rows = order.filter((no) => standard.has(no) || target.has(no)).map((no) => {
    const label = byNo.get(no);
    const standard_s = standard.has(no) ? round(standard.get(no)) : null;
    const target_s = target.has(no) ? round(target.get(no)) : null;
    return {
      job_no: no, job_title: label?.job_title ?? titles.get(no) ?? no, kind: label?.kind ?? null, st_s: label?.standard_duration_s ?? null,
      standard_s, target_s, diff_s: standard_s === null || target_s === null ? null : round(target_s - standard_s),
    };
  });
  rows.sort((a, b) => (a.diff_s === null) - (b.diff_s === null) || Math.abs(b.diff_s ?? 0) - Math.abs(a.diff_s ?? 0) || order.indexOf(a.job_no) - order.indexOf(b.job_no));
  const sum = (map) => round([...map.values()].reduce((n, v) => n + v, 0));
  return { rows, total: { standard_s: sum(standard), target_s: sum(target), diff_s: round(sum(target) - sum(standard)) } };
}
