import * as Segments from "./segments.js";
import {createWorkflow} from "./fewshot.js";
import {pairedStandard, alignmentOffset, bandPairs, timebarAxis, timebarScale, xAtSeconds, secondsAtPointer} from "./result-compare.js";
import {bindRadioGroups} from "./radio-group.js";
import {unsavedState} from "./unsaved-state.js";
import {followVisualOrder} from "./narrow-layout.js";
import {listRows} from "./segment-list-rows.js";

const SEGMENT_KEYS = ["start_time", "end_time", "duration_seconds", "job_no", "page_number", "job_title", "work_content", "hand_movement", "tools_and_parts"];
// 区間の色は作業名ごと（作業名一覧の順）。お手本と対象で同じ作業名は同じ色にし、帯でつなぐ。選択中・再生位置・要確認は、色ではなく枠・赤い線・上端の線で示す。
const JOB_COLORS = [["#e3edf9", "#2f6fb0"], ["#dff1ee", "#1f7a6d"], ["#fbecd7", "#a3621a"], ["#e6f0dc", "#4a7a2f"], ["#f5e3e7", "#a33f55"], ["#ece6f5", "#6b4fa0"], ["#e8ebf0", "#56657a"], ["#f7efd9", "#8a6d1f"]];
const NON_WORK_COLORS = ["#f0efeb", "#77716a"];
const MIN_HANDLE_WIDTH = 14;
// 時間バーの左右に空ける余白(px)。端の区間やつまみのフォーカス枠(はみ出し最大12px)が切れないようにする。
const TB_PAD = 12;
const TIMELINE_ZOOMS = [1, 2, 4, 8];
const LOCAL_MOCK_STAGES = ["準備中（ローカル模擬処理）", "解析中（ローカル模擬処理）", "結果を整形中（ローカル模擬処理）"];
const REAL_STAGES = ["準備中（テキストのみ）", "Geminiの同期応答を待機中", "結果を整形中"];

const $ = (selector) => document.querySelector(selector);
const state = {
  session: null,
  demoInput: false,
  videoFile: null,
  pdfFile: null,
  videoDuration: 0,
  pdfPages: 0,
  videoUrl: null,
  running: false,
  cancelRequested: false,
  controller: null,
  stageTimers: [],
  elapsedTimer: null,
  startedAt: 0,
  prediction: [],
  reviewed: [],
  predictionWarnings: [],
  warnings: [],
  selected: 0,
  view: "reviewed",
  currentTime: 0,
  timelineZoom: 1,
  undoStack: [],
  redoStack: [],
  dirty: false,
  formDirty: false,
  timestamp: "",
  align: "zero",
  filter: "review",
  listPins: null,
  panel: "diff",
  labels: [],
  standardSegments: [],
  detailMoreOpen: false,
};

const { timeToSeconds, secondsToTime, editWorsened } = Segments;
function clone(value) { return JSON.parse(JSON.stringify(value)); }
const UNDO_DEPTH = 20;
function pushHistory(before) {
  state.undoStack.push(clone(before));
  if (state.undoStack.length > UNDO_DEPTH) state.undoStack.shift();
  state.redoStack = [];
}
function cleanSegments(segments, reviewed = false) {
  return segments.map((segment) => Object.fromEntries(SEGMENT_KEYS.map((key) => [key, reviewed && key === "duration_seconds" ? timeToSeconds(segment.end_time) - timeToSeconds(segment.start_time) : segment[key]])));
}
function maximumEnd() { return Math.max(1, state.videoDuration || 30); }
function axisEnd(){return Math.max(maximumEnd(),state.standardDuration||0); }

function validateSegments(segments) { return Segments.validateSegments(segments, maximumEnd()); }

function asSeconds(list) { return list.map((segment) => ({ segment_id: segment.segment_id, start_s: timeToSeconds(segment.start_time) ?? 0, end_s: timeToSeconds(segment.end_time) ?? 0, job_no: segment.job_no, job_title: segment.job_title })); }
function hasStandard() { return state.standardSegments.length > 0 && !$("#workspace").classList.contains("is-zero"); }
function stableHash(value) { let hash = 0; for (const character of String(value)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return hash; }
function isNonWork(jobNo) { return state.labels.find((label) => label.job_no === jobNo)?.kind === "non_work"; }
function jobColors(jobNo) {
  if (isNonWork(jobNo)) return NON_WORK_COLORS;
  const workLabels = state.labels.filter((label) => label.kind !== "non_work");
  const known = workLabels.findIndex((label) => label.job_no === jobNo);
  return JOB_COLORS[(known >= 0 ? known : stableHash(jobNo)) % 8];
}
function isEdited(segment) {
  const original = state.prediction.find((item) => item.segment_id === segment.segment_id);
  return !original || original.start_time !== segment.start_time || original.end_time !== segment.end_time || original.job_no !== segment.job_no;
}
function isFlagged(index) { return Boolean(state.warnings[index]?.length); }

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
}
function safeBaseName() {
  const name = state.videoFile?.name || "mock_video.mp4";
  return (name.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "video");
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message; element.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { element.hidden = true; }, 3500);
}
function confirmAction({ title, message, acceptLabel = "続行", danger = false }) {
  const dialog = $("#confirmDialog");
  if (dialog.open) dialog.close("cancel");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmAccept").textContent = acceptLabel;
  dialog.classList.toggle("danger", danger);
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
    $("#confirmCancel").focus();
  });
}
function setStatus(kind, text, message) {
  $("#statusDot").className = `status-dot ${kind}`;
  $("#statusText").textContent = text;
  $("#statusMessage").textContent = message;
}
function updateElapsed() {
  const elapsed = state.running ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  $("#elapsedText").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
}
function clearProgressTimers() {
  state.stageTimers.forEach(clearTimeout); state.stageTimers = [];
  clearInterval(state.elapsedTimer); state.elapsedTimer = null;
}
function beginProgress() {
  const stages = state.session.mockMode ? LOCAL_MOCK_STAGES : REAL_STAGES;
  state.startedAt = Date.now(); updateElapsed();
  state.elapsedTimer = setInterval(updateElapsed, 250);
  setStatus("running", stages[0], state.session.mockMode ? "Gemini通信を行わない決定的なローカル処理です。" : "実動画・実PDFは送信せず、Flashへテキストだけを同期送信しています。");
  stages.slice(1).forEach((stage, index) => {
    state.stageTimers.push(setTimeout(() => { if (state.running) $("#statusText").textContent = stage; }, 750 * (index + 1)));
  });
}

function updateInputState(){workflow.inputState();}
function selectVideo(file){return workflow.selectVideo(file);}
function useDemoInput(){return workflow.demo();}
function startAnalysis(){return workflow.start(false);}
function cancelAnalysis(){return workflow.cancel();}

function currentSegments() { return state.view === "reviewed" ? state.reviewed : state.prediction; }
function activeIndex() { return currentSegments().findIndex((segment) => timeToSeconds(segment.start_time) <= state.currentTime && state.currentTime < timeToSeconds(segment.end_time)); }
function timelineTickLabel(seconds) {
  if (maximumEnd() >= 3600) return secondsToTime(seconds);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
const tb = { pps: 1, tMin: 0, tMax: 0, width: 0, offset: 0, alignment: { offset: 0, standard: null, missing: false } };
let dragAxis = null;
function layoutTimebar() {
  const view = Math.max(200, $("#timelineScroll").clientWidth);
  const segments = asSeconds(currentSegments());
  const alignment = state.align === "job" && hasStandard() ? alignmentOffset(segments, state.selected, state.standardSegments) : { offset: 0, standard: null, missing: false };
  const axis = timebarAxis({ alignment, withStandard: hasStandard(), maxEnd: maximumEnd(), standardDuration: state.standardDuration || 0, frozen: dragAxis });
  tb.alignment = axis.alignment; tb.offset = axis.offset; tb.tMin = axis.tMin; tb.tMax = axis.tMax;
  const scale = timebarScale({ view, zoom: state.timelineZoom, axisEnd: axisEnd(), tMin: tb.tMin, tMax: tb.tMax, pad: TB_PAD });
  tb.pps = scale.pps; tb.width = scale.width;
  $("#timelineTrack").style.width = `${tb.width}px`;
  return segments;
}
function xOf(t) { return xAtSeconds({ t, tMin: tb.tMin, pps: tb.pps, pad: TB_PAD }); }
function timelineSecondsAtClientX(clientX) {
  const rect = $("#timelineTrack").getBoundingClientRect();
  if (!rect.width) return 0;
  return secondsAtPointer({ x: clientX - rect.left, tMin: tb.tMin, pps: tb.pps, maxEnd: maximumEnd(), pad: TB_PAD });
}
function setTimelineScrollLeft(left) {
  const scroll = $("#timelineScroll"); const maximum = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
  scroll.scrollLeft = Math.max(0, Math.min(maximum, left));
}
function ensureTimelineTimeVisible(seconds, center = false) {
  const scroll = $("#timelineScroll"); const track = $("#timelineTrack");
  if (!scroll.clientWidth || !track.clientWidth) return;
  const x = xOf(Math.max(0, Math.min(maximumEnd(), seconds)));
  const margin = Math.min(48, scroll.clientWidth * .12); const left = scroll.scrollLeft; const right = left + scroll.clientWidth;
  if (center || x < left + margin || x > right - margin) setTimelineScrollLeft(x - scroll.clientWidth / 2);
}
function ensureTimelineSegmentVisible(index) {
  const segment = currentSegments()[index]; const scroll = $("#timelineScroll"); const track = $("#timelineTrack");
  if (!segment || !scroll.clientWidth || !track.clientWidth) return;
  const start = xOf(timeToSeconds(segment.start_time) ?? 0);
  const end = xOf(timeToSeconds(segment.end_time) ?? 0);
  const margin = Math.min(48, scroll.clientWidth * .12); const left = scroll.scrollLeft; const right = left + scroll.clientWidth;
  if (start < left + margin || end > right - margin) {
    setTimelineScrollLeft(end - start > scroll.clientWidth - margin * 2 ? start - margin : (start + end) / 2 - scroll.clientWidth / 2);
  }
}
function renderTimelineZoom() {
  const zoomIndex = TIMELINE_ZOOMS.indexOf(state.timelineZoom);
  $("#timelineZoomValue").textContent = `${state.timelineZoom * 100}%`;
  $("#timelineZoomOut").disabled = zoomIndex <= 0;
  $("#timelineZoomIn").disabled = zoomIndex >= TIMELINE_ZOOMS.length - 1;
}
function setTimelineZoom(zoom) {
  if (!TIMELINE_ZOOMS.includes(zoom) || zoom === state.timelineZoom) return;
  state.timelineZoom = zoom; renderTimeline(); ensureTimelineTimeVisible(state.currentTime, true);
}
function seek(seconds) {
  state.currentTime = Math.min(maximumEnd(), Math.max(0, seconds));
  if (!state.demoInput && Number.isFinite($("#videoPlayer").duration)) $("#videoPlayer").currentTime = state.currentTime;
  renderPlayback(true);
}
function selectSegment(index, seekVideo = true) {
  if (!applyPendingDetail()) return;
  if (!currentSegments()[index]) return;
  state.selected = index; if (seekVideo) seek(timeToSeconds(currentSegments()[index].start_time)); render(); ensureTimelineSegmentVisible(index);
}
function renderRuler() {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((value) => value * tb.pps >= 64) ?? steps.at(-1);
  const ticks = [];
  for (let t = Math.ceil(tb.tMin / step) * step; t <= tb.tMax + 1e-6; t += step) {
    const tick = document.createElement("span"); tick.className = `ruler-tick${xOf(t) > tb.width - 40 ? " end" : ""}`; tick.style.left = `${xOf(t)}px`;
    const label = document.createElement("span"); label.textContent = `${t < 0 ? "−" : ""}${timelineTickLabel(Math.abs(t))}`;
    tick.append(label); ticks.push(tick);
  }
  $("#timelineRuler").replaceChildren(...ticks);
}
function signedSeconds(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Number(Math.abs(rounded).toFixed(1))}`;
}
function renderStandardRow(targetSeconds) {
  const container = $("#standardTimelineSegments");
  if (!hasStandard()) { container.replaceChildren(); return; }
  const pairedStd = state.align === "job" ? tb.alignment.standard : pairedStandard(targetSeconds, state.selected, state.standardSegments);
  const blocks = state.standardSegments.map((segment) => {
    const start = segment.start_s; const end = segment.end_s; const seconds = Math.round(end - start);
    const button = document.createElement("button"); button.type = "button";
    button.className = `standard-segment${isNonWork(segment.job_no) ? " non-work" : ""}${segment === pairedStd ? " paired" : ""}`;
    button.style.left = `${xOf(start + tb.offset) + 1}px`; button.style.width = `${Math.max((end - start) * tb.pps - 2, 2)}px`;
    const [tint, accent] = jobColors(segment.job_no);
    button.style.setProperty("--job-tint", tint); button.style.setProperty("--job-accent", accent);
    const label = `お手本 ${segment.job_no} ${segment.job_title}、${secondsToTime(start)}から${secondsToTime(end)}（${seconds}秒）`;
    button.setAttribute("aria-label", label); button.title = label;
    const title = document.createElement("span"); title.className = "block-title"; title.dataset.full = segment.job_title; title.dataset.short = segment.job_no;
    const detail = document.createElement("span"); detail.className = "block-detail"; detail.dataset.full = `No.${segment.job_no} · ${seconds}秒`; detail.dataset.short = `${seconds}秒`;
    button.append(title, detail);
    button.addEventListener("click", (event) => { event.stopPropagation(); workflow.seekStandard(segment); });
    return button;
  });
  container.replaceChildren(...blocks);
}
function renderTargetRow(targetSeconds) {
  const container = $("#timelineSegments"); const reviewedView = state.view === "reviewed";
  const blocks = targetSeconds.map((segment, index) => {
    const start = segment.start_s; const end = segment.end_s; const seconds = Math.round(end - start);
    const flagged = isFlagged(index); const selected = index === state.selected; const width = Math.max((end - start) * tb.pps - 2, 2);
    const block = document.createElement("div");
    block.className = `segment-block${selected ? " selected" : ""}${flagged ? " has-warning" : ""}${isNonWork(segment.job_no) ? " non-work" : ""}${reviewedView && isEdited(segment) ? " edited" : ""}`;
    block.dataset.segmentIndex = index;
    block.style.left = `${xOf(start) + 1}px`; block.style.width = `${width}px`;
    const [tint, accent] = jobColors(segment.job_no);
    block.style.setProperty("--job-tint", tint); block.style.setProperty("--job-accent", accent);
    const bar = document.createElement("button"); bar.type = "button"; bar.className = "segment-bar";
    bar.setAttribute("aria-pressed", String(selected));
    bar.setAttribute("aria-label", `区間${String(index + 1).padStart(2, "0")}、${flagged ? "要確認、" : ""}${segment.job_title}、${secondsToTime(start)}から${secondsToTime(end)}、${seconds}秒。選択すると区間先頭へ移動します。`);
    bar.title = `区間${String(index + 1).padStart(2, "0")}｜${segment.job_title}\n${secondsToTime(start)}–${secondsToTime(end)}（${seconds}秒）`;
    const title = document.createElement("span"); title.className = "block-title"; title.dataset.full = segment.job_title; title.dataset.short = String(index + 1).padStart(2, "0");
    const detail = document.createElement("span"); detail.className = "block-detail"; detail.dataset.full = `${String(index + 1).padStart(2, "0")} · ${seconds}秒${flagged ? " · 要確認" : ""}`; detail.dataset.short = `${seconds}秒`;
    bar.append(title, detail);
    bar.addEventListener("click", (event) => { event.stopPropagation(); selectSegment(index); });
    block.append(bar);
    if (reviewedView && selected && width >= MIN_HANDLE_WIDTH) {
      for (const side of ["left", "right"]) {
        const value = side === "left" ? start : end; const handle = document.createElement("span");
        handle.className = `drag-handle ${side}`; handle.tabIndex = 0; handle.setAttribute("role", "slider");
        handle.setAttribute("aria-label", `区間${String(index + 1).padStart(2, "0")}の${side === "left" ? "開始" : "終了"}時刻`);
        handle.setAttribute("aria-valuemin", "0"); handle.setAttribute("aria-valuemax", String(maximumEnd())); handle.setAttribute("aria-valuenow", String(value)); handle.setAttribute("aria-valuetext", secondsToTime(value));
        handle.addEventListener("pointerdown", (event) => beginHandleDrag(event, index, side));
        handle.addEventListener("click", (event) => event.stopPropagation());
        handle.addEventListener("keydown", (event) => nudgeHandle(event, index, side));
        block.append(handle);
      }
    }
    return block;
  });
  if (reviewedView) {
    const shown = new Set(targetSeconds.flatMap((segment) => [Math.round(segment.start_s), Math.round(segment.end_s)]));
    for (const segment of state.prediction) {
      for (const t of [timeToSeconds(segment.start_time), timeToSeconds(segment.end_time)]) {
        if (t == null || t <= 0 || t >= maximumEnd() || shown.has(t)) continue;
        shown.add(t);
        const mark = document.createElement("i"); mark.className = "orig-mark"; mark.style.left = `${xOf(t)}px`; mark.title = `自動判定の境目 ${secondsToTime(t)}`;
        blocks.push(mark);
      }
    }
  }
  container.replaceChildren(...blocks);
}
function renderBands(targetSeconds) {
  const svg = $("#timelineBands");
  if (!hasStandard()) { svg.replaceChildren(); return; }
  const height = svg.getBoundingClientRect().height || 34;
  svg.setAttribute("width", String(tb.width)); svg.setAttribute("height", String(height)); svg.setAttribute("viewBox", `0 0 ${tb.width} ${height}`);
  const selectedJob = targetSeconds[state.selected]?.job_no;
  const paths = bandPairs(targetSeconds, state.standardSegments).map(({ target, standard }) => {
    const x1 = xOf(standard.start_s + tb.offset) + 1; const x2 = xOf(standard.end_s + tb.offset) - 1;
    const x3 = xOf(target.end_s) - 1; const x4 = xOf(target.start_s) + 1;
    const [, accent] = jobColors(target.job_no); const on = target.job_no === selectedJob;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M${x1} 0L${x2} 0L${x3} ${height}L${x4} ${height}Z`);
    path.setAttribute("fill", accent); path.setAttribute("stroke", accent);
    path.setAttribute("fill-opacity", on ? ".4" : ".14"); path.setAttribute("stroke-opacity", on ? ".85" : ".3");
    return path;
  });
  svg.replaceChildren(...paths);
}
function fitBlockLabels() {
  $("#timelineTrack").querySelectorAll(".block-title, .block-detail").forEach((span) => {
    span.hidden = false; span.textContent = span.dataset.full;
    if (span.scrollWidth > span.clientWidth + 1) span.textContent = span.dataset.short;
    if (span.scrollWidth > span.clientWidth + 1) span.hidden = true;
  });
}
function positionPlayheads() {
  $("#playhead").style.left = `${xOf(state.currentTime)}px`;
  const standardPlayhead = $("#standardPlayhead");
  standardPlayhead.hidden = !hasStandard();
  standardPlayhead.style.left = `${xOf(($("#standardPlayer").currentTime || 0) + tb.offset)}px`;
}
function renderTimebarChrome() {
  document.querySelectorAll("[data-align]").forEach((button) => button.setAttribute("aria-checked", String(button.dataset.align === state.align)));
  const note = $("#alignNote");
  if (!hasStandard()) note.textContent = "";
  else if (state.align !== "job") note.textContent = "両方の動画の0秒を左端にそろえています（実時間）。";
  else if (tb.alignment.missing) note.textContent = "選んだ区間の作業はお手本にないため、0秒でそろえています。";
  else note.textContent = `「${currentSegments()[state.selected]?.job_title}」の頭をそろえています（お手本を${signedSeconds(tb.offset)}秒ずらして表示。1秒あたりの幅は同じ）。`;
  $("#targetRowLabel").textContent = state.view === "reviewed" ? "修正後" : "自動判定";
  $("#rulerLabel").textContent = state.align === "job" && hasStandard() ? "対象の時間" : "時間";
}
function renderPlayback(followPlayhead = false) {
  $("#playbackTime").textContent = `${secondsToTime(state.currentTime)} / ${secondsToTime(maximumEnd())}`;
  const index = activeIndex(); const segment = currentSegments()[index];
  $("#activeSegmentLabel").textContent = segment ? `区間${String(index + 1).padStart(2, "0")} / ${segment.job_title}` : "該当する作業区間なし";
  positionPlayheads();
  $("#timelineRuler").setAttribute("aria-valuemax", String(maximumEnd()));
  $("#timelineRuler").setAttribute("aria-valuenow", String(Math.round(state.currentTime)));
  $("#timelineRuler").setAttribute("aria-valuetext", `${secondsToTime(state.currentTime)} / ${secondsToTime(maximumEnd())}`);
  document.querySelectorAll(".segment-block[data-segment-index]").forEach((block) => {
    block.classList.toggle("current", Number(block.dataset.segmentIndex) === index);
  });
  let currentRow = null;
  document.querySelectorAll(".segment-row[data-segment-index]").forEach((row) => {
    const isCurrent = Number(row.dataset.segmentIndex) === index;
    row.classList.toggle("current", isCurrent);
    if (isCurrent) { row.setAttribute("aria-current", "true"); currentRow = row; } else row.removeAttribute("aria-current");
  });
  // 現在位置の区間が変わった時だけ一覧をスクロールし、利用者の手動スクロールと競合させない。
  if (index !== state.followedRowIndex) { state.followedRowIndex = index; if (currentRow) keepRowVisible($("#segmentList"), currentRow); }
  if (followPlayhead) ensureTimelineTimeVisible(state.currentTime);
}
function keepRowVisible(list, row) {
  if (!list) return;
  const rect = row.getBoundingClientRect(); const top = list.getBoundingClientRect().top + list.clientTop; const bottom = top + list.clientHeight;
  const margin = 6;
  if (rect.top < top) list.scrollTop += rect.top - top - margin;
  else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom + margin;
}
function renderTimeline() {
  const container = $("#timelineSegments");
  const focused = container.contains(document.activeElement) ? document.activeElement : null; const focusedIndex = focused?.closest(".segment-block")?.dataset.segmentIndex;
  const focusedPart = focused?.classList.contains("drag-handle") ? `.drag-handle.${focused.classList.contains("left") ? "left" : "right"}` : ".segment-bar";
  const segments = layoutTimebar();
  renderRuler();
  renderStandardRow(segments);
  renderTargetRow(segments);
  renderBands(segments);
  fitBlockLabels();
  positionPlayheads();
  renderTimebarChrome();
  renderTimelineZoom();
  if (focusedIndex != null) container.querySelector(`.segment-block[data-segment-index="${focusedIndex}"] ${focusedPart}`)?.focus({ preventScroll: true });
  renderPlayback();
}
function applyBoundary(index, side, seconds) { return Segments.applyBoundary(state.reviewed, index, side, seconds, maximumEnd()); }
function nudgeHandle(event, index, side) {
  if (!applyPendingDetail()) return;
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation(); const before = clone(state.reviewed);
  const direction = event.key === "ArrowLeft" ? -1 : 1; const step = event.shiftKey ? 5 : 1;
  const { accepted } = Segments.nudgeResult(state.reviewed, index, side, direction, step, maximumEnd());
  if (!accepted) { toast("隣の区間または動画端を越えて移動できません。"); return; }
  pushHistory(before); state.dirty = true; state.warnings = validateSegments(state.reviewed); render();
  requestAnimationFrame(() => document.querySelector(`.segment-block[data-segment-index="${index}"] .drag-handle.${side}`)?.focus());
}
function beginHandleDrag(event, index, side) {
  if (!applyPendingDetail()) return;
  event.stopPropagation(); event.preventDefault(); const original = clone(state.reviewed); let wasClamped = false;
  dragAxis = { alignment: tb.alignment, offset: tb.offset, tMin: tb.tMin, tMax: tb.tMax };
  const move = (pointerEvent) => {
    const seconds = Math.round(timelineSecondsAtClientX(pointerEvent.clientX));
    const key = side === "left" ? "start_time" : "end_time"; const previous = timeToSeconds(state.reviewed[index][key]); const next = applyBoundary(index, side, seconds); const isClamped = next !== seconds;
    if (isClamped && !wasClamped) toast("隣の区間または動画端を越えて移動できません。");
    wasClamped = isClamped;
    if (next !== previous) renderTimeline();
  };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    dragAxis = null;
    const errors = validateSegments(state.reviewed);
    if (editWorsened(validateSegments(original), errors, index)) { state.reviewed = original; toast(errors[index][0]); }
    else if (JSON.stringify(original) !== JSON.stringify(state.reviewed)) { pushHistory(original); state.dirty = true; }
    state.warnings = validateSegments(state.reviewed); render();
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true }); window.addEventListener("pointercancel", up, { once: true });
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

function renderList() {
  const list = $("#segmentList"); const active = activeIndex();
  const focusedIndex = list.contains(document.activeElement) ? document.activeElement.closest('.segment-row')?.dataset.segmentIndex : null;
  const segments = currentSegments();
  const flaggedCount = segments.filter((_, index) => isFlagged(index)).length;
  if (state.filter === "review" && !flaggedCount) state.filter = "all";
  document.querySelectorAll("[data-filter]").forEach((button) => button.setAttribute("aria-checked", String(button.dataset.filter === state.filter)));
  $('[data-filter="review"]').textContent = `要確認だけ（${flaggedCount}）`;
  $('[data-filter="all"]').textContent = `すべて（${segments.length}）`;
  const { indexes, pins } = listRows({ segments, filter: state.filter, isFlagged, selected: state.selected, pins: state.listPins });
  state.listPins = pins;
  const rows = indexes.map((index) => ({ segment: segments[index], index }));
  list.replaceChildren();
  rows.forEach(({ segment, index }) => {
    const flagged = isFlagged(index); const edited = state.view === "reviewed" && isEdited(segment);
    const row = document.createElement("button"); row.type = "button"; row.className = `segment-row${index === state.selected ? " selected" : ""}${index === active ? " current" : ""}${flagged ? " warning" : ""}`;
    row.dataset.segmentIndex = index; row.setAttribute("aria-pressed", String(index === state.selected));
    if (index === active) row.setAttribute("aria-current", "true");
    const duration = (timeToSeconds(segment.end_time) ?? 0) - (timeToSeconds(segment.start_time) ?? 0);
    // 再生中の区間は行に付く「再生中」タグ（CSSの.segment-row.current .row-state::before）で示す。
    const tags = `${flagged ? '<span class="tag review">要確認</span>' : ""}${edited ? '<span class="tag edited">修正あり</span>' : ""}`;
    row.innerHTML = `<span class="segment-number">${String(index + 1).padStart(2, "0")}</span><span class="row-copy"><strong>${escapeHtml(segment.job_title)}</strong><small>${escapeHtml(segment.start_time)}–${escapeHtml(segment.end_time)} ・ ${duration}秒 ・ No.${escapeHtml(segment.job_no)}</small></span><span class="row-state">${tags}</span>`;
    row.addEventListener("click", () => selectSegment(index)); list.append(row);
  });
  if (!rows.length) {
    list.innerHTML = segments.length ? '<div class="empty-state"><h3>表示する区間はありません</h3><p>絞り込みを戻すと、ほかの区間を確認できます。</p><button type="button" class="button secondary" id="showAllSegments">すべて表示</button></div>' : '<div class="empty-state"><h3>区間はありません</h3><p>この表示元には区間がありません。自動判定・修正後を切り替えるか、実行履歴で結果の状態を確認してください。</p></div>';
    $('#showAllSegments')?.addEventListener('click',()=>{state.filter='all';state.listPins=null;renderList();$('[data-filter="all"]').focus({preventScroll:true});});
  }
  const selectedRow = list.querySelector(".segment-row.selected");
  if (selectedRow) keepRowVisible(list, selectedRow);
  if (focusedIndex != null) list.querySelector(`[data-segment-index="${focusedIndex}"]`)?.focus({preventScroll:true});
}
function renderDetail() {
  if (state.formDirty) return;
  const panel = $("#detailPanel"); const notes = $("#detailNotes"); const segment = currentSegments()[state.selected];
  if (!segment) { panel.innerHTML = '<p class="empty-state">区間を選択してください。</p>'; notes.replaceChildren(); return; }
  const readOnly = state.view !== "reviewed";
  const duration = (timeToSeconds(segment.end_time) ?? 0) - (timeToSeconds(segment.start_time) ?? 0);
  const referenceLines = [];
  if (!readOnly) {
    const original = state.prediction.find((item) => item.segment_id === segment.segment_id);
    referenceLines.push(original
      ? `自動判定：${escapeHtml(original.start_time)}–${escapeHtml(original.end_time)} ／ ${escapeHtml(original.job_no)} ${escapeHtml(original.job_title)}`
      : "人が追加した区間です（自動判定にはありません）。");
  }
  if (hasStandard()) {
    const targetSeconds = asSeconds(currentSegments());
    const paired = pairedStandard(targetSeconds, state.selected, state.standardSegments) ?? state.standardSegments.find((item) => item.job_no === segment.job_no) ?? null;
    referenceLines.push(paired
      ? `お手本：${escapeHtml(secondsToTime(paired.start_s))}–${escapeHtml(secondsToTime(paired.end_s))} ／ ${escapeHtml(paired.job_no)} ${escapeHtml(paired.job_title)}`
      : "お手本に対応する工程はありません。");
  }
  const warnings = state.warnings[state.selected] ?? [];
  const heading = `区間${String(state.selected + 1).padStart(2, "0")}｜${escapeHtml(segment.job_title)}`;
  // 一覧の上に出す編集欄は高さが変わらない部分だけにし、参照行・注意・詳細は一覧の下（#detailNotes）に置く。
  // 詳細の入力欄はフォームの外にあるため form 属性で #detailForm に結び付ける。
  panel.innerHTML = `<form id="detailForm"><div class="detail-heading"><div><small>${readOnly ? "自動判定（読み取り専用）" : "選択中の区間（修正後・編集できます）"}</small><strong title="${heading}">${heading}</strong></div><span>${duration}秒</span></div><div class="form-grid detail-grid">
    <label>開始時刻<input name="start_time" value="${escapeHtml(segment.start_time)}" pattern="\\d{2}:\\d{2}:\\d{2}" ${readOnly ? "disabled" : ""}></label>
    <label>終了時刻<input name="end_time" value="${escapeHtml(segment.end_time)}" pattern="\\d{2}:\\d{2}:\\d{2}" ${readOnly ? "disabled" : ""}></label>
    <label class="wide">作業名<input name="job_no" value="${readOnly ? `${escapeHtml(segment.job_no)} ${escapeHtml(segment.job_title)}` : escapeHtml(segment.job_no)}" ${readOnly ? "disabled" : ""}></label>
  </div>${readOnly ? "" : '<div class="detail-actions"><button id="deleteButton" class="button secondary" type="button">区間を削除</button><button class="button primary" type="submit">この区間に反映</button></div>'}</form>`;
  notes.innerHTML = `${referenceLines.map((line) => `<p class="detail-reference">${line}</p>`).join("")}${warnings.length ? `<ul class="warning-list">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
  <details class="detail-more"${state.detailMoreOpen ? " open" : ""}><summary>詳細（作業標準書のページ・作業タイトル・作業内容など）</summary><div class="form-grid detail-grid">
    <label>作業標準書のページ<input form="detailForm" name="page_number" value="${escapeHtml(segment.page_number)}" ${readOnly ? "disabled" : ""}></label>
    <label class="wide">作業タイトル<input form="detailForm" name="job_title" value="${escapeHtml(segment.job_title)}" ${readOnly ? "disabled" : ""}></label>
  </div><div class="readonly-grid">
    <div class="readonly-field">作業時間<span>${duration}秒${state.view === "prediction" && segment.duration_seconds !== duration ? `（自動判定 ${segment.duration_seconds}秒）` : ""}</span></div>
    <div class="readonly-field">作業内容<span>${escapeHtml(segment.work_content)}</span></div>
    <div class="readonly-field">手の動き<span>${escapeHtml(segment.hand_movement)}</span></div>
    <div class="readonly-field">治工具・部品<span>${escapeHtml(segment.tools_and_parts)}</span></div>
  </div></details>`;
  $(".detail-more").addEventListener("toggle", (event) => { state.detailMoreOpen = event.target.open; });
  if (!readOnly) { $("#detailForm").addEventListener("submit", saveDetail); $("#deleteButton").addEventListener("click", deleteSegment); }
}
function saveDetail(event) {
  event.preventDefault(); const before = clone(state.reviewed); const form = new FormData(event.currentTarget); const segment = state.reviewed[state.selected];
  ["start_time", "end_time", "job_no", "page_number", "job_title"].forEach((key) => { segment[key] = String(form.get(key) || "-"); });
  segment.duration_seconds = (timeToSeconds(segment.end_time) ?? 0) - (timeToSeconds(segment.start_time) ?? 0);
  const errors = validateSegments(state.reviewed);
  if (editWorsened(validateSegments(before), errors, state.selected)) { state.reviewed = before; toast(errors[state.selected][0]); return false; }
  state.formDirty = false; pushHistory(before); state.dirty = true; state.warnings = errors; state.reviewed.sort((a, b) => timeToSeconds(a.start_time) - timeToSeconds(b.start_time)); state.selected = state.reviewed.indexOf(segment); render(); toast("区間に反映しました。履歴への保存はまだです。"); return true;
}
function applyPendingDetail() {
  if (!state.formDirty) return true;
  const form = $("#detailForm");
  if (!form.reportValidity()) return false;
  return saveDetail({preventDefault(){},currentTarget:form});
}
const DETAIL_TIME_LABELS = { start_time: "開始時刻", end_time: "終了時刻" };
// 保存の前に呼ぶ。入力中の区間を反映できなければ、区間タブを開いて直す時刻欄に焦点を入れ、理由の短い文を返す（反映できれば空文字）。
function pendingDetailStop() {
  if (!state.formDirty) return "";
  const form = $("#detailForm");
  // 隠れた欄には吹き出しも焦点も出せず、コンソールにエラーが出る。形式の誤りは、反映を試す前に区間タブへ移る。
  if (form.checkValidity() && applyPendingDetail()) return "";
  selectPanel("segments");
  const index = state.selected;
  const typed = { start_time: form.elements.start_time.value, end_time: form.elements.end_time.value };
  const field = Segments.pendingTimeField(typed, state.reviewed[index]);
  const before = validateSegments(state.reviewed)[index];
  const draft = clone(state.reviewed); Object.assign(draft[index], typed);
  const reason = validateSegments(draft)[index].find((message) => !before.includes(message)) ?? "";
  form.elements[field].focus(); form.elements[field].select();
  return `${DETAIL_TIME_LABELS[field]}を直してください。${reason}`;
}
async function deleteSegment() {
  if (!applyPendingDetail()) return;
  const segment = state.reviewed[state.selected]; if (!segment) return;
  const confirmed = await confirmAction({
    title: `区間${String(state.selected + 1).padStart(2, "0")}を削除しますか`,
    message: `${segment.job_title}（${segment.start_time}–${segment.end_time}）を一覧と時間バーから削除します。「元に戻す」で戻せます。`,
    acceptLabel: "削除する",
    danger: true,
  });
  if (!confirmed) return;
  pushHistory(state.reviewed); state.reviewed.splice(state.selected, 1); state.selected = Math.min(state.selected, state.reviewed.length - 1); state.dirty = true; state.warnings = validateSegments(state.reviewed); render();
}
function openAddDialog() {
  if (!applyPendingDetail()) return;
  const start = Math.min(Math.floor(state.currentTime), maximumEnd() - 1); const form = $("#addForm");
  form.elements.start_time.value = secondsToTime(start); form.elements.end_time.value = secondsToTime(Math.min(maximumEnd(), start + 5)); form.elements.job_no.value = ""; form.elements.page_number.value = ""; form.elements.job_title.value = ""; workflow.prepareAdd();$("#addError").textContent = ""; $("#addDialog").showModal();
}
function addSegment(event) {
  event.preventDefault(); const form = new FormData($("#addForm"));
  const segment = { segment_id: `human-${crypto.randomUUID()}`, start_time: String(form.get("start_time")), end_time: String(form.get("end_time")), duration_seconds: 0, job_no: String(form.get("job_no") || "-"), page_number: String(form.get("page_number") || "-"), job_title: String(form.get("job_title") || "-"), work_content: "-", hand_movement: "-", tools_and_parts: "-" };
  segment.duration_seconds = (timeToSeconds(segment.end_time) ?? 0) - (timeToSeconds(segment.start_time) ?? 0);
  const next = [...clone(state.reviewed), segment].sort((a, b) => (timeToSeconds(a.start_time) ?? 0) - (timeToSeconds(b.start_time) ?? 0)); const errors = validateSegments(next);
  const addedIndex = next.indexOf(segment);
  if (errors[addedIndex]?.length) { $("#addError").textContent = errors[addedIndex][0]; return; }
  pushHistory(state.reviewed); state.reviewed = next; state.selected = state.reviewed.indexOf(segment); if (state.selected < 0) state.selected = next.findIndex((item) => item.start_time === segment.start_time && item.end_time === segment.end_time); state.dirty = true; state.warnings = errors; $("#addDialog").close(); render();
}
function undo() {
  if (!applyPendingDetail()) return; if (!state.undoStack.length) return; state.redoStack.push(clone(state.reviewed)); state.reviewed = state.undoStack.pop(); state.selected = Math.min(state.selected, state.reviewed.length - 1); state.dirty = true; state.warnings = validateSegments(state.reviewed); render(); }
function redo() {
  if (!applyPendingDetail()) return; if (!state.redoStack.length) return; state.undoStack.push(clone(state.reviewed)); state.reviewed = state.redoStack.pop(); state.selected = Math.min(state.selected, state.reviewed.length - 1); state.dirty = true; state.warnings = validateSegments(state.reviewed); render(); }

function download(type){return workflow.download(type);}
function unsaved() { return unsavedState({ dirty: state.dirty, formDirty: state.formDirty, memoText: $("#reviewComment").value, hasResult: Boolean(state.result) }); }
function renderDirty() { const u = unsaved(), badge = $("#dirtyBadge"); badge.className = `dirty-badge ${u.badgeClass}`; if (badge.textContent !== u.badgeText) badge.textContent = u.badgeText; }
function render() {
  workflow.warnings();
  const reviewedActive = state.view === "reviewed";
  $("#reviewedTab").setAttribute("aria-checked", String(reviewedActive)); $("#predictionTab").setAttribute("aria-checked", String(!reviewedActive));
  $("#addButton").disabled = state.view !== "reviewed";
  const undoCount = state.undoStack.length, redoCount = state.redoStack.length;
  $("#undoButton").disabled = !undoCount || state.view !== "reviewed"; $("#redoButton").disabled = !redoCount || state.view !== "reviewed";
  $("#undoButton").textContent = undoCount ? `元に戻す（${undoCount}）` : "元に戻す"; $("#redoButton").textContent = redoCount ? `やり直す（${redoCount}）` : "やり直す";
  const anyFlagged = currentSegments().some((_, index) => isFlagged(index));
  $("#prevReview").disabled = !anyFlagged; $("#nextReview").disabled = !anyFlagged;
  renderTimeline(); renderList(); renderDetail(); renderDirty(); workflow.extras();
}
function switchView(view) {
  if (!applyPendingDetail()) return false;
  state.view = view; state.selected = Math.min(state.selected, currentSegments().length - 1);
  state.listPins = null;
  state.warnings = view === "reviewed" ? validateSegments(state.reviewed) : clone(state.predictionWarnings);
  render();
  return true;
}
function visiblePanelTabs() { return [...document.querySelectorAll(".panel-tab")].filter((tab) => !tab.hidden); }
function selectPanel(name, focus = false) {
  state.panel = name;
  for (const tab of document.querySelectorAll(".panel-tab")) {
    const selected = !tab.hidden && tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  for (const body of document.querySelectorAll(".panel-body")) body.hidden = body.id !== `panel-${name}`;
  if (focus) $(`#tab-${name}`)?.focus();
}
function handlePanelTabKey(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = visiblePanelTabs(); const names = tabs.map((tab) => tab.id.replace("tab-", ""));
  const current = names.indexOf(state.panel);
  const next = event.key === "Home" ? 0 : event.key === "End" ? names.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + names.length) % names.length;
  selectPanel(names[next], true);
}

function bindDrop(zoneSelector, inputSelector, handler) {
  const zone = $(zoneSelector); const input = $(inputSelector); input.addEventListener("change", () => handler(input.files[0]));
  for (const eventName of ["dragenter", "dragover"]) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.add("dragover"); });
  for (const eventName of ["dragleave", "drop"]) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.remove("dragover"); });
  zone.addEventListener("drop", (event) => handler(event.dataTransfer.files[0]));
}
const workflow=createWorkflow({state,$,render,setStatus,toast,renderDirty,hasUnsaved:()=>unsaved().any,seek,selectSegment,pendingDetailStop,selectPanel,switchView});
function initialize(){return workflow.initialize();}

bindDrop("#videoDrop", "#videoInput", selectVideo);
$("#demoInputButton").addEventListener("click", useDemoInput); $("#startButton").addEventListener("click", startAnalysis); $("#cancelButton").addEventListener("click", cancelAnalysis);
$("#timelineTrack").addEventListener("click", (event) => seek(timelineSecondsAtClientX(event.clientX)));
$("#timeline").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault(); const step = event.shiftKey ? 5 : 1;
  if (event.key === "Home") seek(0);
  else if (event.key === "End") seek(maximumEnd());
  else seek(state.currentTime + (event.key === "ArrowLeft" ? -step : step));
});
$("#timelineZoomOut").addEventListener("click", () => setTimelineZoom(TIMELINE_ZOOMS[TIMELINE_ZOOMS.indexOf(state.timelineZoom) - 1]));
$("#timelineZoomIn").addEventListener("click", () => setTimelineZoom(TIMELINE_ZOOMS[TIMELINE_ZOOMS.indexOf(state.timelineZoom) + 1]));
$("#videoPlayer").addEventListener("timeupdate", (event) => { state.currentTime = event.currentTarget.currentTime; renderPlayback(true); });
$("#reviewedTab").addEventListener("click", () => switchView("reviewed"));
$("#predictionTab").addEventListener("click", () => switchView("prediction"));
$('#openUsage').addEventListener('click',()=>$('#usageDialog').showModal());
$('#closeUsage').addEventListener('click',()=>$('#usageDialog').close());
bindRadioGroups();
followVisualOrder({panel: $("#workspace > .result-panel"), timebar: $("#workspace > .timebar")});
$("#addButton").addEventListener("click", openAddDialog); $("#confirmAdd").addEventListener("click", addSegment); $("#undoButton").addEventListener("click", undo); $("#redoButton").addEventListener("click", redo);
$("#downloadPrediction").addEventListener("click", () => download("prediction")); $("#downloadReviewed").addEventListener("click", () => download("reviewed"));
document.querySelectorAll(".panel-tab").forEach((tab) => { tab.addEventListener("click", () => selectPanel(tab.id.replace("tab-", ""))); tab.addEventListener("keydown", handlePanelTabKey); });
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.filter; state.listPins = null; renderList(); }));
function stepReview(direction) {
  const flaggedIndexes = currentSegments().map((_, index) => index).filter((index) => isFlagged(index));
  if (!flaggedIndexes.length) return;
  const current = flaggedIndexes.indexOf(state.selected);
  const next = current === -1 ? flaggedIndexes[0] : flaggedIndexes[(current + direction + flaggedIndexes.length) % flaggedIndexes.length];
  selectSegment(next);
}
$("#prevReview").addEventListener("click", () => stepReview(-1)); $("#nextReview").addEventListener("click", () => stepReview(1));
document.querySelectorAll("[data-align]").forEach((button) => button.addEventListener("click", () => { state.align = button.dataset.align; render(); ensureTimelineSegmentVisible(state.selected); }));
$("#standardPlayer").addEventListener("timeupdate", positionPlayheads); $("#standardPlayer").addEventListener("seeked", positionPlayheads);
let timelineResizeFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(timelineResizeFrame);
  timelineResizeFrame = requestAnimationFrame(() => { if (!$("#workspace").hidden && currentSegments().length) { renderTimeline(); ensureTimelineTimeVisible(state.currentTime); } });
});
window.addEventListener("beforeunload", (event) => { if (unsaved().any) { event.preventDefault(); event.returnValue = ""; } });
$("#reviewComment").addEventListener("input", renderDirty);
for (const target of [$("#detailPanel"), $("#detailNotes")]) for (const eventName of ["input", "change"]) target.addEventListener(eventName, () => { if(state.view === "reviewed") { state.formDirty = true; renderDirty(); } });
initialize();
