// Segment time arithmetic and edit rules, shared by the browser UI and the test suite.
// Kept free of DOM and app state so it can run under `node --test`.

export function timeToSeconds(value) {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const [h, m, s] = value.split(":").map(Number);
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

export function secondsToTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function validateSegments(segments, maximumEnd) {
  const errors = segments.map(() => []);
  const times = segments.map((segment, index) => {
    const start = timeToSeconds(segment.start_time);
    const end = timeToSeconds(segment.end_time);
    if (start === null || end === null) errors[index].push("時刻は厳密なHH:MM:SS形式で入力してください。");
    return { start, end };
  });
  segments.forEach((segment, index) => {
    const { start, end } = times[index];
    if (start === null || end === null) return;
    if (start >= end || end - start < 1) errors[index].push("開始より後の終了時刻を指定し、1秒以上にしてください。");
    if (start < 0 || end > maximumEnd) errors[index].push(`動画範囲（00:00:00〜${secondsToTime(maximumEnd)}）内にしてください。`);
  });
  const order = segments.map((_, index) => index).sort((a, b) => (times[a].start ?? 0) - (times[b].start ?? 0));
  for (let index = 1; index < order.length; index += 1) {
    const previous = order[index - 1];
    const current = order[index];
    if (times[current].start < times[previous].end) {
      errors[previous].push(`区間${current + 1}と重複しています。`);
      errors[current].push(`区間${previous + 1}と重複しています。`);
    }
  }
  return errors;
}

export function boundaryLimits(segments, index, side, maximumEnd) {
  const segment = segments[index];
  const start = timeToSeconds(segment.start_time) ?? 0;
  const end = timeToSeconds(segment.end_time) ?? start + 1;
  if (side === "left") {
    return { min: index > 0 ? timeToSeconds(segments[index - 1].end_time) ?? 0 : 0, max: end - 1 };
  }
  return { min: start + 1, max: index < segments.length - 1 ? timeToSeconds(segments[index + 1].start_time) ?? maximumEnd : maximumEnd };
}

export function applyBoundary(segments, index, side, seconds, maximumEnd) {
  const limits = boundaryLimits(segments, index, side, maximumEnd);
  const value = Math.max(limits.min, Math.min(limits.max, Math.round(seconds)));
  segments[index][side === "left" ? "start_time" : "end_time"] = secondsToTime(value);
  segments[index].duration_seconds = timeToSeconds(segments[index].end_time) - timeToSeconds(segments[index].start_time);
  return value;
}

// An edit is judged on its own merits: it is rejected only when it leaves the edited segment
// worse than it was. Problems the AI shipped in other segments must not block the repair work,
// because repairing them is the whole point of this screen.
export function editWorsened(errorsBefore, errorsAfter, index) {
  return errorsAfter[index].length > errorsBefore[index].length;
}

export function nudgeResult(segments, index, side, direction, step, maximumEnd) {
  const key = side === "left" ? "start_time" : "end_time";
  const previous = timeToSeconds(segments[index][key]);
  const original = segments[index][key];
  const originalDuration = segments[index].duration_seconds;
  const value = applyBoundary(segments, index, side, previous + direction * step, maximumEnd);
  // When the source data already overlaps, the clamp floor can sit ahead of the current value,
  // which would turn a "move earlier" keypress into a jump forward. Only a move in the
  // requested direction counts.
  const accepted = Math.sign(value - previous) === Math.sign(direction);
  if (!accepted) {
    segments[index][key] = original;
    segments[index].duration_seconds = originalDuration;
  }
  return { value, accepted };
}

// Round 18 warnings: one DOM-independent source for server, browser and probe.
export function qualityWarningsV1(segments, vocabulary, duration) {
  const warnings = [];
  const add = (code, message, ids, fatal = false) => warnings.push({ code, message, segment_ids: [...new Set(ids)], fatal, policy_version: 'quality-policy.v1' });
  let previousWork = null;
  segments.forEach((s, i) => {
    const label = vocabulary.find(l => l.job_no === s.job_no && l.job_title === s.job_title);
    if (!label) add('OUT_OF_VOCABULARY', '語彙にないラベルです。再分析してください。', [s.segment_id], true);
    if (!Number.isFinite(s.start_s) || !Number.isFinite(s.end_s) || s.start_s < 0 || s.end_s <= s.start_s || s.end_s > duration) add('INVALID_TIME', '区間時刻が不正です。再分析してください。', [s.segment_id], true);
    if (i && s.start_s !== segments[i-1].end_s) add('TIME_DISCONTINUITY', '区間に重複・逆順・隙間があります。再分析してください。', [segments[i-1].segment_id,s.segment_id], true);
    if (label?.standard_duration_s != null && ((s.end_s-s.start_s) < .5*label.standard_duration_s || (s.end_s-s.start_s) > 2*label.standard_duration_s)) add('DURATION_DEVIATION', '標準時間から大きく離れています。映像を確認してください。', [s.segment_id]);
    if (label?.kind === 'work' && label.standard_order != null) {
      if (previousWork && label.standard_order < previousWork.order) add('ORDER_REVERSAL', '標準書の順序と逆になっている候補です。実際の作業順を確認してください。', [previousWork.id,s.segment_id]);
      previousWork = {order:label.standard_order,id:s.segment_id};
    }
  });
  if (segments.length && (segments[0].start_s !== 0 || segments.at(-1).end_s !== duration)) add('INCOMPLETE_COVERAGE', '動画の全長を覆っていません。再分析してください。', segments.map(s=>s.segment_id), true);
  const missing = vocabulary.filter(l=>l.kind==='work' && l.standard_order!=null && !segments.some(s=>s.job_no===l.job_no));
  if (missing.length) add('MISSING_PROCESS', `工程抜けの候補: ${missing.map(l=>l.job_title).join('、')}。動画全体を確認してください。`, segments.map(s=>s.segment_id));
  return warnings;
}

export const REVIEW_REASON_LABELS = Object.freeze({stage1_insufficient:'実作業の観察不足',standard_insufficient:'お手本の観察不足',forced_low:'同着による強制低下',ordinary_low:'生の確信度が閾値未満',fallback:'その他（判別不能）',quality_warning:'品質警告'});
export function matchingSegment(segments, jobNo, currentTime) { return segments.find(s=>s.job_no===jobNo && s.start_s>=currentTime) ?? segments.find(s=>s.job_no===jobNo) ?? null; }
