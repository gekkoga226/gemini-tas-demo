import * as Segments from "./segments.js";
import {createWorkflow} from "./fewshot.js";

const SEGMENT_KEYS = ["start_time", "end_time", "duration_seconds", "job_no", "page_number", "job_title", "work_content", "hand_movement", "tools_and_parts"];
// 区間色は分類を意味しないため統一し、番号で区別する。
// 選択、現在位置、警告はそれぞれ別の視覚表現を使う。
const COLORS = ["#245f7d"];
const MIN_SEGMENT_LABEL_WIDTH = 24;
const MIN_SEGMENT_HANDLE_WIDTH = 14;
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
function timelineStep(duration) {
  const rough = duration / 6;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
  return steps.find((value) => value >= rough) || Math.ceil(rough / 3600) * 3600;
}
function timelineMinorStep(majorStep) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.filter((value) => value < majorStep && majorStep % value === 0 && value <= majorStep / 3).at(-1) || null;
}
function renderRuler() {
  const ruler = $("#timelineRuler"); const duration = axisEnd(); const step = timelineStep(duration); const minorStep = timelineMinorStep(step); const majorPoints = []; const minorPoints = [];
  for (let second = 0; second < duration; second += step) majorPoints.push(second);
  majorPoints.push(duration);
  if (minorStep) {
    for (let second = minorStep; second < duration; second += minorStep) {
      if (second % step !== 0) minorPoints.push(second);
    }
  }
  const minorTicks = minorPoints.map((second) => {
    const tick = document.createElement("span");
    tick.className = "ruler-tick minor";
    tick.style.left = `${(second / duration) * 100}%`;
    return tick;
  });
  const majorTicks = majorPoints.map((second, index) => {
    const tick = document.createElement("span");
    tick.className = `ruler-tick major${index === 0 ? " first" : ""}${index === majorPoints.length - 1 ? " last" : ""}`;
    tick.style.left = `${(second / duration) * 100}%`;
    tick.innerHTML = `<span class="ruler-label">${timelineTickLabel(second)}</span>`;
    return tick;
  });
  ruler.replaceChildren(...minorTicks, ...majorTicks);
}
function sizeTimelineTrack() {
  const scroll = $("#timelineScroll"); const width = Math.max(1, scroll.clientWidth) * state.timelineZoom;
  $("#timelineTrack").style.width = `${width}px`;
  return width;
}
function timelineSecondsAtClientX(clientX) {
  const rect = $("#timelineTrack").getBoundingClientRect();
  if (!rect.width) return 0;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * axisEnd();
}
function setTimelineScrollLeft(left) {
  const scroll = $("#timelineScroll"); const maximum = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
  scroll.scrollLeft = Math.max(0, Math.min(maximum, left));
}
function ensureTimelineTimeVisible(seconds, center = false) {
  const scroll = $("#timelineScroll"); const track = $("#timelineTrack");
  if (!scroll.clientWidth || !track.clientWidth) return;
  const x = (Math.max(0, Math.min(axisEnd(), seconds)) / axisEnd()) * track.clientWidth;
  const margin = Math.min(48, scroll.clientWidth * .12); const left = scroll.scrollLeft; const right = left + scroll.clientWidth;
  if (center || x < left + margin || x > right - margin) setTimelineScrollLeft(x - scroll.clientWidth / 2);
}
function ensureTimelineSegmentVisible(index) {
  const segment = currentSegments()[index]; const scroll = $("#timelineScroll"); const track = $("#timelineTrack");
  if (!segment || !scroll.clientWidth || !track.clientWidth) return;
  const start = ((timeToSeconds(segment.start_time) ?? 0) / maximumEnd()) * track.clientWidth;
  const end = ((timeToSeconds(segment.end_time) ?? 0) / maximumEnd()) * track.clientWidth;
  const margin = Math.min(48, scroll.clientWidth * .12); const left = scroll.scrollLeft; const right = left + scroll.clientWidth;
  if (start < left + margin || end > right - margin) {
    setTimelineScrollLeft(end - start > scroll.clientWidth - margin * 2 ? start - margin : (start + end) / 2 - scroll.clientWidth / 2);
  }
}
function renderTimelineZoom() {
  const zoomIndex = TIMELINE_ZOOMS.indexOf(state.timelineZoom);
  $("#timelineZoomValue").textContent = `${state.timelineZoom}x`;
  $("#timelineZoomOut").disabled = zoomIndex <= 0;
  $("#timelineZoomIn").disabled = zoomIndex >= TIMELINE_ZOOMS.length - 1;
  $("#timeline").dataset.zoom = String(state.timelineZoom);
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

function renderPlayback(followPlayhead = false) {
  $("#playbackTime").textContent = `${secondsToTime(state.currentTime)} / ${secondsToTime(maximumEnd())}`;
  const index = activeIndex(); const segment = currentSegments()[index];
  $("#activeSegmentLabel").textContent = segment ? `区間${String(index + 1).padStart(2, "0")} / ${segment.job_title}` : "該当する作業区間なし";
  const playhead = $("#playhead"); const duration = axisEnd();
  playhead.style.left = `${(state.currentTime / duration) * 100}%`;
  playhead.dataset.time = secondsToTime(state.currentTime);
  playhead.classList.toggle("at-start", state.currentTime <= .5);
  playhead.classList.toggle("at-end", state.currentTime >= duration - .5);
  $("#timeline").setAttribute("aria-valuemax", String(duration));
  $("#timeline").setAttribute("aria-valuenow", String(Math.round(state.currentTime)));
  $("#timeline").setAttribute("aria-valuetext", `${secondsToTime(state.currentTime)} / ${secondsToTime(duration)}`);
  document.querySelectorAll(".segment-block[data-segment-index]").forEach((block) => {
    block.classList.toggle("current", Number(block.dataset.segmentIndex) === index);
  });
  document.querySelectorAll(".segment-row[data-segment-index]").forEach((row) => {
    const isCurrent = Number(row.dataset.segmentIndex) === index;
    row.classList.toggle("current", isCurrent);
    const tag = row.querySelector(".current-tag");
    if (tag) tag.hidden = !isCurrent;
  });
  if (followPlayhead) ensureTimelineTimeVisible(state.currentTime);
}
function renderTimeline() {
  const segments = currentSegments(); const duration = axisEnd(); const container = $("#timelineSegments"); container.replaceChildren(); const trackWidth = sizeTimelineTrack();
  renderRuler();
  segments.forEach((segment, index) => {
    const start = timeToSeconds(segment.start_time) ?? 0; const end = timeToSeconds(segment.end_time) ?? start; const width = ((end - start) / duration) * 100; const pixelWidth = (width / 100) * trackWidth;
    const isShort = pixelWidth < MIN_SEGMENT_LABEL_WIDTH; const canDrag = pixelWidth >= MIN_SEGMENT_HANDLE_WIDTH; const hasWarning = Boolean(state.warnings[index]?.length);
    const block = document.createElement("div");
    block.className = `segment-block${index === state.selected ? " selected" : ""}${isShort ? " short" : ""}${hasWarning ? " has-warning" : ""}${start <= 0 ? " edge-start" : ""}${end >= duration ? " edge-end" : ""}${end / duration > .97 ? " callout-left" : ""}`;
    block.dataset.segmentIndex = index; block.dataset.shortLabel = String(index + 1).padStart(2, "0");
    block.dataset.pixelWidth = pixelWidth.toFixed(2);
    block.style.left = `${(start / duration) * 100}%`; block.style.width = `${width}%`; block.style.setProperty("--segment-color", COLORS[index % COLORS.length]);
    const bar = document.createElement("button"); bar.type = "button"; bar.className = "segment-bar";
    bar.setAttribute("aria-pressed", String(index === state.selected));
    bar.setAttribute("aria-label", `区間${String(index + 1).padStart(2, "0")}、${hasWarning ? "要確認、" : ""}${segment.job_title}、${segment.start_time}から${segment.end_time}、${end - start}秒。選択すると区間先頭へ移動します。`);
    bar.title = `区間${String(index + 1).padStart(2, "0")}｜${segment.job_title}\n${segment.start_time}–${segment.end_time}（${end - start}秒）`;
    bar.innerHTML = `<span class="segment-label">${String(index + 1).padStart(2, "0")}</span>`;
    bar.addEventListener("click", (event) => { event.stopPropagation(); selectSegment(index); });
    block.append(bar);
    if (state.view === "reviewed" && index === state.selected && canDrag) {
      for (const side of ["left", "right"]) {
        const value = side === "left" ? start : end; const handle = document.createElement("span");
        handle.className = `drag-handle ${side}`; handle.tabIndex = 0; handle.setAttribute("role", "slider");
        handle.setAttribute("aria-label", `区間${String(index + 1).padStart(2, "0")}の${side === "left" ? "開始" : "終了"}時刻`);
        handle.setAttribute("aria-valuemin", "0"); handle.setAttribute("aria-valuemax", String(duration)); handle.setAttribute("aria-valuenow", String(value)); handle.setAttribute("aria-valuetext", secondsToTime(value));
        handle.addEventListener("pointerdown", (event) => beginHandleDrag(event, index, side));
        handle.addEventListener("click", (event) => event.stopPropagation());
        handle.addEventListener("keydown", (event) => nudgeHandle(event, index, side));
        block.append(handle);
      }
    }
    container.append(block);
  });
  renderTimelineZoom(); renderPlayback();
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
  const move = (pointerEvent) => {
    const seconds = Math.round(timelineSecondsAtClientX(pointerEvent.clientX));
    const key = side === "left" ? "start_time" : "end_time"; const previous = timeToSeconds(state.reviewed[index][key]); const next = applyBoundary(index, side, seconds); const isClamped = next !== seconds;
    if (isClamped && !wasClamped) toast("隣の区間または動画端を越えて移動できません。");
    wasClamped = isClamped;
    if (next !== previous) renderTimeline();
  };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    const errors = validateSegments(state.reviewed);
    if (editWorsened(validateSegments(original), errors, index)) { state.reviewed = original; toast(errors[index][0]); }
    else if (JSON.stringify(original) !== JSON.stringify(state.reviewed)) { pushHistory(original); state.dirty = true; }
    state.warnings = validateSegments(state.reviewed); render();
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true }); window.addEventListener("pointercancel", up, { once: true });
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

function renderList() {
  const list = $("#segmentList"); const active = activeIndex(); list.replaceChildren();
  currentSegments().forEach((segment, index) => {
    const row = document.createElement("button"); row.type = "button"; row.className = `segment-row${index === state.selected ? " selected" : ""}${state.warnings[index]?.length ? " warning" : ""}`;
    row.dataset.segmentIndex = index; row.setAttribute("aria-pressed", String(index === state.selected));
    const duration = (timeToSeconds(segment.end_time) ?? 0) - (timeToSeconds(segment.start_time) ?? 0);
    const stateTags = [
      index === state.selected ? '<span class="selection-tag">選択中</span>' : "",
      `<span class="current-tag"${index === active ? "" : " hidden"}>現在位置</span>`,
      state.warnings[index]?.length ? '<span class="warning-mark">要確認</span>' : "",
    ].join("");
    row.innerHTML = `<span class="segment-number">${String(index + 1).padStart(2, "0")}</span><span class="row-copy"><strong>${escapeHtml(segment.job_title)}</strong><small>${escapeHtml(segment.start_time)}–${escapeHtml(segment.end_time)} ・ ${duration}秒 ・ Job ${escapeHtml(segment.job_no)}</small></span><span class="row-state">${stateTags}</span>`;
    row.addEventListener("click", () => selectSegment(index)); list.append(row);
  });
  const selectedRow = list.querySelector(".segment-row.selected");
  if (selectedRow) selectedRow.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function renderDetail() {
  if (state.formDirty) return;
  const panel = $("#detailPanel"); const segment = currentSegments()[state.selected];
  if (!segment) { panel.innerHTML = '<p class="empty-state">区間を選択してください。</p>'; return; }
  const readOnly = state.view !== "reviewed";
  panel.innerHTML = `<form id="detailForm"><div class="detail-heading"><div><small>${readOnly ? "AI予測（読み取り専用）" : "選択中の区間（編集できます）"}</small><strong>区間${String(state.selected + 1).padStart(2, "0")}｜${escapeHtml(segment.job_title)}</strong></div><span>${timeToSeconds(segment.end_time) - timeToSeconds(segment.start_time)}秒</span></div><div class="form-grid">
    <label>開始時刻<input name="start_time" value="${escapeHtml(segment.start_time)}" pattern="\\d{2}:\\d{2}:\\d{2}" ${readOnly ? "disabled" : ""}></label>
    <label>終了時刻<input name="end_time" value="${escapeHtml(segment.end_time)}" pattern="\\d{2}:\\d{2}:\\d{2}" ${readOnly ? "disabled" : ""}></label>
    <label>Job No.<input name="job_no" value="${escapeHtml(segment.job_no)}" ${readOnly ? "disabled" : ""}></label>
    <label>標準書ページ<input name="page_number" value="${escapeHtml(segment.page_number)}" ${readOnly ? "disabled" : ""}></label>
    <label class="wide">作業タイトル<input name="job_title" value="${escapeHtml(segment.job_title)}" ${readOnly ? "disabled" : ""}></label>
  </div><div class="readonly-grid">
    <div class="readonly-field">作業時間<span>${timeToSeconds(segment.end_time) - timeToSeconds(segment.start_time)}秒${state.view === "prediction" && segment.duration_seconds !== timeToSeconds(segment.end_time) - timeToSeconds(segment.start_time) ? `（AI値 ${segment.duration_seconds}秒）` : ""}</span></div>
    <div class="readonly-field">作業内容<span>${escapeHtml(segment.work_content)}</span></div>
    <div class="readonly-field">手の動き<span>${escapeHtml(segment.hand_movement)}</span></div>
    <div class="readonly-field">治工具・部品<span>${escapeHtml(segment.tools_and_parts)}</span></div>
  </div>${state.warnings[state.selected]?.length ? `<ul class="warning-list">${state.warnings[state.selected].map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
  ${readOnly ? "" : '<div class="detail-actions"><button id="deleteButton" class="button secondary" type="button">区間を削除</button><button class="button primary" type="submit">この区間に反映</button></div>'}</form>`;
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
async function deleteSegment() {
  if (!applyPendingDetail()) return;
  const segment = state.reviewed[state.selected]; if (!segment) return;
  const confirmed = await confirmAction({
    title: `区間${String(state.selected + 1).padStart(2, "0")}を削除しますか`,
    message: `${segment.job_title}（${segment.start_time}–${segment.end_time}）を一覧とタイムラインから削除します。Undoで元に戻せます。`,
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
function renderDirty() { const badge = $("#dirtyBadge"); badge.className = `dirty-badge ${state.dirty || state.formDirty ? "dirty" : "clean"}`; badge.textContent = state.formDirty ? "区間に未反映（保存時に検証・反映）" : state.dirty ? "履歴に未保存" : "変更なし"; }
function render() {
  workflow.warnings();
  const reviewedActive = state.view === "reviewed";
  $("#reviewedTab").classList.toggle("active", reviewedActive); $("#predictionTab").classList.toggle("active", !reviewedActive);
  $("#reviewedTab").setAttribute("aria-selected", String(reviewedActive)); $("#predictionTab").setAttribute("aria-selected", String(!reviewedActive));
  $("#reviewedTab").tabIndex = reviewedActive ? 0 : -1; $("#predictionTab").tabIndex = reviewedActive ? -1 : 0;
  $("#addButton").disabled = state.view !== "reviewed";
  const undoCount = state.undoStack.length, redoCount = state.redoStack.length;
  $("#undoButton").disabled = !undoCount || state.view !== "reviewed"; $("#redoButton").disabled = !redoCount || state.view !== "reviewed";
  $("#undoButton").textContent = undoCount ? `↶ Undo (${undoCount})` : "↶ Undo"; $("#redoButton").textContent = redoCount ? `↷ Redo (${redoCount})` : "↷ Redo";
  renderTimeline(); renderList(); renderDetail(); renderDirty(); workflow.extras();
}
function switchView(view, focusTab = false) {
  if (!applyPendingDetail()) return;
  state.view = view; state.selected = Math.min(state.selected, currentSegments().length - 1);
  state.warnings = view === "reviewed" ? validateSegments(state.reviewed) : clone(state.predictionWarnings);
  render();
  if (focusTab) $(view === "reviewed" ? "#reviewedTab" : "#predictionTab").focus();
}
function handleTabKey(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  switchView(event.key === "ArrowLeft" || event.key === "Home" ? "reviewed" : "prediction", true);
}

function bindDrop(zoneSelector, inputSelector, handler) {
  const zone = $(zoneSelector); const input = $(inputSelector); input.addEventListener("change", () => handler(input.files[0]));
  for (const eventName of ["dragenter", "dragover"]) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.add("dragover"); });
  for (const eventName of ["dragleave", "drop"]) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.remove("dragover"); });
  zone.addEventListener("drop", (event) => handler(event.dataTransfer.files[0]));
}
const workflow=createWorkflow({state,$,render,setStatus,toast,renderDirty,seek,applyPendingDetail});
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
$("#reviewedTab").addEventListener("keydown", handleTabKey); $("#predictionTab").addEventListener("keydown", handleTabKey);
$("#addButton").addEventListener("click", openAddDialog); $("#confirmAdd").addEventListener("click", addSegment); $("#undoButton").addEventListener("click", undo); $("#redoButton").addEventListener("click", redo);
$("#downloadPrediction").addEventListener("click", () => download("prediction")); $("#downloadReviewed").addEventListener("click", () => download("reviewed"));
let timelineResizeFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(timelineResizeFrame);
  timelineResizeFrame = requestAnimationFrame(() => { if (!$("#workspace").hidden && currentSegments().length) { renderTimeline(); ensureTimelineTimeVisible(state.currentTime); } });
});
window.addEventListener("beforeunload", (event) => { if (state.dirty || state.formDirty) { event.preventDefault(); event.returnValue = ""; } });
for (const eventName of ["input", "change"]) $("#detailPanel").addEventListener(eventName, () => { if(state.view === "reviewed") { state.formDirty = true; renderDirty(); } });
initialize();
