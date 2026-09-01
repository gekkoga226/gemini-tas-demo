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
