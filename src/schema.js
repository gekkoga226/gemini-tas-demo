export const SEGMENT_KEYS = Object.freeze([
  "start_time",
  "end_time",
  "duration_seconds",
  "job_no",
  "page_number",
  "job_title",
  "work_content",
  "hand_movement",
  "tools_and_parts",
]);

const STRING_KEYS = SEGMENT_KEYS.filter((key) => key !== "duration_seconds");
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}$/;

export const GEMINI_RESPONSE_SCHEMA = Object.freeze({
  type: "array",
  items: {
    type: "object",
    properties: Object.fromEntries(
      SEGMENT_KEYS.map((key) => [
        key,
        { type: key === "duration_seconds" ? "integer" : "string" },
      ]),
    ),
    required: [...SEGMENT_KEYS],
  },
});

export function timeToSeconds(value) {
  if (!TIME_PATTERN.test(value)) return null;
  const [hours, minutes, seconds] = value.split(":").map(Number);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function secondsToTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

export function validateStructure(value) {
  const errors = [];
  if (!Array.isArray(value)) return { valid: false, errors: ["JSON全体が配列ではありません。"] };

  value.forEach((segment, index) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      errors.push(`区間${index + 1}がオブジェクトではありません。`);
      return;
    }
    for (const key of SEGMENT_KEYS) {
      if (!(key in segment)) errors.push(`区間${index + 1}に ${key} がありません。`);
    }
    for (const key of STRING_KEYS) {
      if (key in segment && typeof segment[key] !== "string") {
        errors.push(`区間${index + 1}の ${key} が文字列ではありません。`);
      }
    }
    if ("duration_seconds" in segment && !Number.isInteger(segment.duration_seconds)) {
      errors.push(`区間${index + 1}の duration_seconds が整数ではありません。`);
    }
    for (const key of ["start_time", "end_time"]) {
      if (typeof segment[key] === "string" && timeToSeconds(segment[key]) === null) {
        errors.push(`区間${index + 1}の ${key} が厳密なHH:MM:SS形式ではありません。`);
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

export function cleanSegment(segment) {
  return Object.fromEntries(SEGMENT_KEYS.map((key) => [key, segment[key]]));
}

export function qualityWarnings(segments, maximumEnd) {
  const warnings = segments.map(() => []);
  const times = segments.map((segment) => ({
    start: timeToSeconds(segment.start_time),
    end: timeToSeconds(segment.end_time),
  }));

  segments.forEach((segment, index) => {
    const { start, end } = times[index];
    if (start >= end) warnings[index].push("開始時刻は終了時刻より前にしてください。");
    if (end - start < 1) warnings[index].push("区間は1秒以上にしてください。");
    if (segment.duration_seconds !== end - start) warnings[index].push("作業時間が開始・終了時刻と一致しません。");
    if (start < 0 || end > maximumEnd) warnings[index].push("区間が動画の範囲外です。");
  });

  for (let index = 1; index < segments.length; index += 1) {
    if (times[index].start < times[index - 1].end) {
      warnings[index - 1].push(`区間${index + 1}と重複しています。`);
      warnings[index].push(`区間${index}と重複しています。`);
    }
  }
  return warnings;
}

export function preparePrediction(value, maximumEnd) {
  const structure = validateStructure(value);
  if (!structure.valid) {
    const error = new Error("Gemini結果が正式なJSON構造を満たしていません。");
    error.code = "INVALID_STRUCTURE";
    error.details = structure.errors;
    throw error;
  }
  const prediction = value.map(cleanSegment).sort((a, b) => timeToSeconds(a.start_time) - timeToSeconds(b.start_time));
  return { prediction, warnings: qualityWarnings(prediction, maximumEnd) };
}

export function toReviewed(segments) {
  return segments.map((segment) => {
    const clean = cleanSegment(segment);
    clean.duration_seconds = timeToSeconds(clean.end_time) - timeToSeconds(clean.start_time);
    return clean;
  });
}

export function createMockPrediction(durationSeconds = 30) {
  const maximumEnd = Math.max(1, Math.ceil(Number(durationSeconds) || 30));
  const labels = [
    ["100", "p.1", "部品を準備する", "作業台から対象部品を取り出し、向きを確認する。", "左手で部品を支え、右手で表裏を確認する。", "対象部品"],
    ["110", "p.2", "部品を位置決めする", "部品を治具の基準位置へ合わせる。", "両手で部品を保持し、基準面へゆっくり押し当てる。", "位置決め治具, 対象部品"],
    ["120", "p.3", "ねじを仮締めする", "固定ねじを挿入して仮締めする。", "左手で部品を保持し、右手で工具を回す。", "ねじ, ドライバー"],
    ["130", "p.4", "仕上がりを確認する", "固定状態と部品のずれがないことを確認する。", "両手を離し、目視しながら指先でがたつきを確認する。", "組立品"],
  ];
  const count = Math.min(labels.length, maximumEnd);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((maximumEnd * index) / count);
    const end = index === count - 1 ? maximumEnd : Math.max(start + 1, Math.floor((maximumEnd * (index + 1)) / count));
    const [jobNo, page, title, content, movement, tools] = labels[index];
    result.push({
      start_time: secondsToTime(start),
      end_time: secondsToTime(end),
      duration_seconds: end - start,
      job_no: jobNo,
      page_number: page,
      job_title: title,
      work_content: content,
      hand_movement: movement,
      tools_and_parts: tools,
    });
  }
  return result;
}
