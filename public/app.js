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
  timestamp: "",
};

function timeToSeconds(value) {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const [h, m, s] = value.split(":").map(Number);
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}
function secondsToTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}
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
function maximumEnd() { return Math.max(1, Math.ceil(state.videoDuration || 30)); }

function validateSegments(segments) {
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
    if (start < 0 || end > maximumEnd()) errors[index].push(`動画範囲（00:00:00〜${secondsToTime(maximumEnd())}）内にしてください。`);
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

function updateInputState() {
  const ready = state.demoInput || (state.videoFile && state.pdfFile && state.videoDuration > 0 && state.pdfPages > 0);
  const realReady = state.session?.mockMode || (state.session?.apiKeyConfigured && state.session?.realModelAllowed);
  $("#startButton").disabled = !ready || state.running || !realReady;
  if (state.demoInput) $("#inputSummary").textContent = "30秒・4区間の決定的サンプルを使用します。";
  else if (ready) $("#inputSummary").textContent = `動画 ${secondsToTime(state.videoDuration)} ／ PDF ${state.pdfPages}ページ`;
  else $("#inputSummary").textContent = "動画とPDFを選択するか、サンプル入力を使ってください。";
  if (!state.session?.mockMode && !state.session?.apiKeyConfigured) $("#inputSummary").textContent = "APIキーは管理者による設定が必要です。";
  else if (!state.session?.mockMode && !state.session?.realModelAllowed) $("#inputSummary").textContent = "実API検証にはGEMINI_MODELでFlashを指定してください。Proは実行しません。";
}

async function inspectPdf(file) {
  if (!file || !file.name.toLowerCase().endsWith(".pdf") || file.size === 0 || file.size > 50 * 1024 * 1024) throw new Error("0バイトではない50MB以下のPDFを選んでください。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.startsWith("%PDF-")) throw new Error("PDFとして開けるファイルを選んでください。");
  if (/\/Encrypt\b/.test(text)) throw new Error("暗号化されていないPDFを選んでください。");
  const pages = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
  const pageCount = pages || Math.max(0, ...counts);
  if (!pageCount || pageCount > 1000) throw new Error("1,000ページ以下でページ数を確認できるPDFを選んでください。");
  return pageCount;
}

function selectVideo(file) {
  state.demoInput = false;
  if (!file || !file.name.toLowerCase().endsWith(".mp4") || file.size === 0 || file.size > 2 * 1024 ** 3) { toast("0バイトではない2GB以下のMP4を選んでください。"); return; }
  state.videoFile = file; state.videoDuration = 0;
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  const player = $("#videoPlayer"); player.src = state.videoUrl;
  $("#videoPlaceholder").hidden = true;
  $("#videoMeta").textContent = `${file.name} ・ ${formatBytes(file.size)} ・ 読込中`;
  player.onloadedmetadata = () => {
    if (!Number.isFinite(player.duration) || player.duration <= 0) { toast("ブラウザで再生できるMP4を選んでください。"); return; }
    state.videoDuration = player.duration;
    $("#videoMeta").textContent = `${file.name} ・ ${formatBytes(file.size)} ・ ${secondsToTime(Math.ceil(player.duration))}`;
    updateInputState();
  };
  player.onerror = () => toast("動画を再生できません。別のMP4を選んでください。");
  updateInputState();
}
async function selectPdf(file) {
  state.demoInput = false; state.pdfFile = null; state.pdfPages = 0;
  $("#pdfMeta").textContent = "確認中"; updateInputState();
  try {
    const pages = await inspectPdf(file);
    state.pdfFile = file; state.pdfPages = pages;
    $("#pdfMeta").textContent = `${file.name} ・ ${formatBytes(file.size)} ・ ${pages}ページ`;
  } catch (error) { $("#pdfMeta").textContent = "未選択"; toast(error.message); }
  updateInputState();
}
function useDemoInput() {
  state.demoInput = true; state.videoFile = null; state.pdfFile = null; state.videoDuration = 30; state.pdfPages = 4;
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  $("#videoPlayer").removeAttribute("src"); $("#videoPlayer").load(); $("#videoPlaceholder").hidden = false;
  $("#videoMeta").textContent = "mock_video.mp4 ・ 内容なし ・ 00:00:30";
  $("#pdfMeta").textContent = "mock_standard.pdf ・ 内容なし ・ 4ページ";
  updateInputState(); toast("ファイル内容を使わないサンプル入力を設定しました。");
}

async function startAnalysis() {
  if (state.running) return;
  const notice = state.session.mockMode
    ? "ローカル模擬処理を開始します。Geminiへの通信は行いません。"
    : "Flashへ固定テキストだけを同期送信します。選択した動画・PDFの内容は送信しません。";
  const replaceMessage = state.prediction.length
    ? state.dirty
      ? " 現在の結果と未保存の修正は、新しい解析結果に置き換わります。"
      : " 現在の結果は、新しい解析結果に置き換わります。"
    : "";
  const confirmed = await confirmAction({
    title: "解析を開始しますか",
    message: `${notice}${replaceMessage}`,
    acceptLabel: "解析を開始",
    danger: state.dirty,
  });
  if (!confirmed) return;
  state.running = true; state.cancelRequested = false; state.controller = new AbortController();
  $("#startButton").disabled = true; $("#cancelButton").hidden = false; beginProgress();
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-local-token": state.session.token },
      body: JSON.stringify({ videoDurationSeconds: state.videoDuration, pdfPageCount: state.pdfPages }),
      signal: state.controller.signal,
    });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || "解析に失敗しました。再実行してください。"); }
    const body = await response.json();
    if (state.cancelRequested) return;
    state.prediction = clone(body.prediction); state.reviewed = clone(body.prediction);
    state.predictionWarnings = clone(body.warnings || []); state.warnings = validateSegments(state.reviewed); state.selected = 0; state.view = "reviewed";
    state.undoStack = []; state.redoStack = []; state.dirty = false; state.timestamp = timestamp(); state.currentTime = 0; state.timelineZoom = 1;
    $("#timelineScroll").scrollLeft = 0; $("#workspace").hidden = false; setStatus("done", "完了", state.session.mockMode ? "ローカルの模擬結果を表示しています。" : "Flashのテキスト同期結果を表示しています。実ファイルは送信していません。");
    render();
  } catch (error) {
    if (!state.cancelRequested && error.name !== "AbortError") setStatus("error", "エラー", error.message);
  } finally {
    clearProgressTimers(); state.running = false; state.controller = null; $("#cancelButton").hidden = true; updateInputState();
  }
}
function cancelAnalysis() {
  if (!state.running) return;
  state.cancelRequested = true; state.controller?.abort(); clearProgressTimers(); state.running = false;
  $("#cancelButton").hidden = true;
  const message = state.session.mockMode ? "ローカルの模擬処理を停止しました。" : "画面での待機を中止しました。Gemini側の処理停止は保証できません。";
  setStatus("cancelled", "中止", message); updateInputState();
}

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
  const ruler = $("#timelineRuler"); const duration = maximumEnd(); const step = timelineStep(duration); const minorStep = timelineMinorStep(step); const majorPoints = []; const minorPoints = [];
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
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * maximumEnd();
}
function setTimelineScrollLeft(left) {
  const scroll = $("#timelineScroll"); const maximum = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
  scroll.scrollLeft = Math.max(0, Math.min(maximum, left));
}
function ensureTimelineTimeVisible(seconds, center = false) {
  const scroll = $("#timelineScroll"); const track = $("#timelineTrack");
  if (!scroll.clientWidth || !track.clientWidth) return;
  const x = (Math.max(0, Math.min(maximumEnd(), seconds)) / maximumEnd()) * track.clientWidth;
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
  if (!currentSegments()[index]) return;
  state.selected = index; if (seekVideo) seek(timeToSeconds(currentSegments()[index].start_time)); render(); ensureTimelineSegmentVisible(index);
}

function renderPlayback(followPlayhead = false) {
  $("#playbackTime").textContent = `${secondsToTime(state.currentTime)} / ${secondsToTime(maximumEnd())}`;
  const index = activeIndex(); const segment = currentSegments()[index];
  $("#activeSegmentLabel").textContent = segment ? `区間${String(index + 1).padStart(2, "0")} / ${segment.job_title}` : "該当する作業区間なし";
  const playhead = $("#playhead"); const duration = maximumEnd();
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
  const segments = currentSegments(); const duration = maximumEnd(); const container = $("#timelineSegments"); container.replaceChildren(); const trackWidth = sizeTimelineTrack();
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
function boundaryLimits(index, side) {
  const segments = state.reviewed; const segment = segments[index];
  const start = timeToSeconds(segment.start_time) ?? 0; const end = timeToSeconds(segment.end_time) ?? start + 1;
  if (side === "left") return { min: index > 0 ? timeToSeconds(segments[index - 1].end_time) ?? 0 : 0, max: end - 1 };
  return { min: start + 1, max: index < segments.length - 1 ? timeToSeconds(segments[index + 1].start_time) ?? maximumEnd() : maximumEnd() };
}
function applyBoundary(index, side, seconds) {
  const limits = boundaryLimits(index, side); const value = Math.max(limits.min, Math.min(limits.max, Math.round(seconds)));
  const key = side === "left" ? "start_time" : "end_time"; state.reviewed[index][key] = secondsToTime(value);
  state.reviewed[index].duration_seconds = timeToSeconds(state.reviewed[index].end_time) - timeToSeconds(state.reviewed[index].start_time);
  return value;
}
function nudgeHandle(event, index, side) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation(); const before = clone(state.reviewed); const key = side === "left" ? "start_time" : "end_time";
  const direction = event.key === "ArrowLeft" ? -1 : 1; const step = event.shiftKey ? 5 : 1;
  const previous = timeToSeconds(state.reviewed[index][key]); const next = applyBoundary(index, side, previous + direction * step);
  if (next === previous) { toast("隣の区間または動画端を越えて移動できません。"); return; }
  pushHistory(before); state.dirty = true; state.warnings = validateSegments(state.reviewed); render();
  requestAnimationFrame(() => document.querySelector(`.segment-block[data-segment-index="${index}"] .drag-handle.${side}`)?.focus());
}
function beginHandleDrag(event, index, side) {
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
    if (errors.some((items) => items.length)) { state.reviewed = original; toast(errors.flat()[0]); }
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
  if (errors.some((items) => items.length)) { state.reviewed = before; toast(errors.flat()[0]); render(); return; }
  pushHistory(before); state.dirty = true; state.warnings = errors; state.reviewed.sort((a, b) => timeToSeconds(a.start_time) - timeToSeconds(b.start_time)); state.selected = state.reviewed.indexOf(segment); render(); toast("変更を確定しました。");
}
async function deleteSegment() {
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
  const start = Math.min(Math.floor(state.currentTime), maximumEnd() - 1); const form = $("#addForm");
  form.elements.start_time.value = secondsToTime(start); form.elements.end_time.value = secondsToTime(Math.min(maximumEnd(), start + 5)); form.elements.job_no.value = ""; form.elements.page_number.value = ""; form.elements.job_title.value = ""; $("#addError").textContent = ""; $("#addDialog").showModal();
}
function addSegment(event) {
  event.preventDefault(); const form = new FormData($("#addForm"));
  const segment = { start_time: String(form.get("start_time")), end_time: String(form.get("end_time")), duration_seconds: 0, job_no: String(form.get("job_no") || "-"), page_number: String(form.get("page_number") || "-"), job_title: String(form.get("job_title") || "-"), work_content: "-", hand_movement: "-", tools_and_parts: "-" };
  segment.duration_seconds = (timeToSeconds(segment.end_time) ?? 0) - (timeToSeconds(segment.start_time) ?? 0);
  const next = [...clone(state.reviewed), segment].sort((a, b) => (timeToSeconds(a.start_time) ?? 0) - (timeToSeconds(b.start_time) ?? 0)); const errors = validateSegments(next);
  if (errors.some((items) => items.length)) { $("#addError").textContent = errors.flat()[0]; return; }
  pushHistory(state.reviewed); state.reviewed = next; state.selected = state.reviewed.indexOf(segment); if (state.selected < 0) state.selected = next.findIndex((item) => item.start_time === segment.start_time && item.end_time === segment.end_time); state.dirty = true; state.warnings = errors; $("#addDialog").close(); render();
}
function undo() { if (!state.undoStack.length) return; state.redoStack.push(clone(state.reviewed)); state.reviewed = state.undoStack.pop(); state.selected = Math.min(state.selected, state.reviewed.length - 1); state.dirty = true; state.warnings = validateSegments(state.reviewed); render(); }
function redo() { if (!state.redoStack.length) return; state.undoStack.push(clone(state.reviewed)); state.reviewed = state.redoStack.pop(); state.selected = Math.min(state.selected, state.reviewed.length - 1); state.dirty = true; state.warnings = validateSegments(state.reviewed); render(); }

function download(type) {
  const isReviewed = type === "reviewed"; const source = isReviewed ? state.reviewed : state.prediction;
  if (isReviewed) { const errors = validateSegments(source); if (errors.some((items) => items.length)) { toast(`修正が必要です: ${errors.flat()[0]}`); return; } }
  const data = cleanSegments(source, isReviewed); const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `${safeBaseName()}_${type}_${state.timestamp}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  if (isReviewed) { state.dirty = false; renderDirty(); }
}
function renderDirty() { const badge = $("#dirtyBadge"); badge.className = `dirty-badge ${state.dirty ? "dirty" : "clean"}`; badge.textContent = state.dirty ? "未出力の変更あり" : "変更なし"; }
function render() {
  const reviewedActive = state.view === "reviewed";
  $("#reviewedTab").classList.toggle("active", reviewedActive); $("#predictionTab").classList.toggle("active", !reviewedActive);
  $("#reviewedTab").setAttribute("aria-selected", String(reviewedActive)); $("#predictionTab").setAttribute("aria-selected", String(!reviewedActive));
  $("#reviewedTab").tabIndex = reviewedActive ? 0 : -1; $("#predictionTab").tabIndex = reviewedActive ? -1 : 0;
  $("#addButton").disabled = state.view !== "reviewed";
  const undoCount = state.undoStack.length, redoCount = state.redoStack.length;
  $("#undoButton").disabled = !undoCount || state.view !== "reviewed"; $("#redoButton").disabled = !redoCount || state.view !== "reviewed";
  $("#undoButton").textContent = undoCount ? `↶ Undo (${undoCount})` : "↶ Undo"; $("#redoButton").textContent = redoCount ? `↷ Redo (${redoCount})` : "↷ Redo";
  renderTimeline(); renderList(); renderDetail(); renderDirty();
}
function switchView(view, focusTab = false) {
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
async function initialize() {
  try {
    const response = await fetch("/api/session"); if (!response.ok) throw new Error(); state.session = await response.json();
    $("#modeBadge").textContent = state.session.mockMode ? "LOCAL MOCK｜Gemini通信なし" : "REAL API｜Flash・テキスト同期のみ";
    $("#inputNotice").textContent = state.session.mockMode ? "モックモードではファイル内容をGeminiへ送信せず、ローカルの模擬進捗と決定的な結果を返します。" : "実APIモードはFlashへ固定テキストだけを同期送信します。動画・PDFはGeminiへ送信しません。中止してもクラウド側の停止は保証できません。";
    $("#inputNotice").className = `notice ${state.session.mockMode ? "neutral" : "warning"}`; updateInputState();
  } catch { setStatus("error", "起動エラー", "ローカルサーバーへ接続できません。再起動してください。"); }
}

bindDrop("#videoDrop", "#videoInput", selectVideo); bindDrop("#pdfDrop", "#pdfInput", selectPdf);
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
window.addEventListener("beforeunload", (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
initialize();
