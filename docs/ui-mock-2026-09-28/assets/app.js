// お手本と照合の結果画面モック。サーバーに接続せず、架空データ（data.js）だけで動く。
// 自動判定（AUTO）は変更しない。人が直した内容は「修正後」（working）として別に持ち、保存するとこのブラウザ内に残る。
(() => {
  'use strict';
  const DATA = window.MOCK_DATA;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  const STORE_KEY = 'sagyo-mieru-ui-mock-2026-09-28';
  const SNAP = 0.5;
  const MIN_LEN = 1;
  const ZOOMS = [1, 1.5, 2, 3, 4];
  const REASONS = {
    stage1_insufficient: '対象動画の観察が不足', standard_insufficient: 'お手本の観察が不足', forced_low: '候補が同点のため確信度を下げた',
    ordinary_low: '確信度が基準より低い', fallback: '判別できない（その他）', quality_warning: '品質の注意あり',
  };
  const COLORS = {
    100: ['#e3edf9', '#2f6fb0'], 110: ['#dff1ee', '#1f7a6d'], 120: ['#fbecd7', '#a3621a'], 130: ['#e6f0dc', '#4a7a2f'],
    140: ['#f5e3e7', '#a33f55'], 150: ['#e8ebf0', '#56657a'], NW07: ['#f0efeb', '#77716a'],
  };
  const ICONS = {
    prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h2v12H3zM14 2v12L6 8z"/></svg>',
    next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2h2v12h-2zM2 2l8 6-8 6z"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
  };

  const result = DATA.result;
  const vocab = new Map(DATA.vocabulary.labels.map((l) => [l.job_no, l]));
  const AUTO = result.segments;
  const autoById = new Map(AUTO.map((s) => [s.segment_id, s]));
  const plain = ({ segment_id, start_s, end_s, job_no, job_title }) => ({ segment_id, start_s, end_s, job_no, job_title });

  const storage = {
    load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } },
    save(value) { try { localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch { /* 保存できない環境では画面の中だけで保持する */ } },
    clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* 同上 */ } },
  };
  let reviews = storage.load()?.reviews ?? clone(DATA.reviews);
  const latest = () => reviews[reviews.length - 1] ?? null;
  const baseline = () => latest()?.segments ?? AUTO.map(plain);
  let working = clone(baseline());
  const undoStack = [];

  const params = new URLSearchParams(location.search);
  const choose = (name, allowed, fallback) => (allowed.includes(params.get(name)) ? params.get(name) : fallback);
  const firstReview = AUTO.find((s) => s.review_required) ?? AUTO[0];
  const state = {
    tab: choose('tab', ['diff', 'segments', 'memo'], 'diff'),
    source: choose('source', ['auto', 'reviewed'], 'auto'),
    align: choose('align', ['zero', 'job'], 'zero'),
    filter: choose('filter', ['review', 'all'], 'review'),
    std: Math.min(Math.max((Number(params.get('std')) || 1) - 1, 0), result.standard_set.sources.length - 1),
    zoom: ZOOMS.includes(Number(params.get('zoom')) / 100) ? Number(params.get('zoom')) / 100 : 1,
    selected: AUTO.some((s) => s.segment_id === params.get('select')) ? params.get('select') : firstReview.segment_id,
    sync: params.get('sync') !== 'off',
    evidenceOpen: false,
  };
  const players = { std: { t: 0, playing: false, last: null, icon: null }, tgt: { t: 0, playing: false, last: null, icon: null } };

  // ---------- time and segment helpers ----------
  const len = (s) => s.end_s - s.start_s;
  const round1 = (v) => Math.round(v * 10) / 10;
  const fmt = (value) => {
    const v = round1(Math.max(0, value));
    const m = Math.floor(v / 60);
    const s = round1(v - m * 60);
    return `${pad(m)}:${Number.isInteger(s) ? pad(s) : s.toFixed(1).padStart(4, '0')}`;
  };
  const secText = (v) => `${Number.isInteger(round1(v)) ? round1(v) : round1(v).toFixed(1)}秒`;
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + secText(Math.abs(v));
  const parseTime = (text) => {
    const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(String(text).replace('：', ':'));
    return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
  };
  const snap = (t) => Math.round(t / SNAP) * SNAP;
  const stdSource = () => result.standard_set.sources[state.std];
  const segsOf = (side) => (side === 'std' ? stdSource().display_segments : working);
  const duration = (side) => (side === 'std' ? stdSource().duration_s : result.input_video.duration_s);
  const sideName = (side) => (side === 'std' ? 'お手本' : '対象');
  const segAt = (segs, t) => segs.find((s) => s.start_s <= t && t < s.end_s) ?? (t >= segs[segs.length - 1].end_s ? segs[segs.length - 1] : segs[0]);
  const selectedSeg = () => working.find((s) => s.segment_id === state.selected);
  const totals = (segs) => segs.reduce((m, s) => m.set(s.job_no, (m.get(s.job_no) ?? 0) + len(s)), new Map());
  const sum = (map) => [...map.values()].reduce((a, b) => a + b, 0);
  const isEdited = (s) => { const a = autoById.get(s.segment_id); return a.start_s !== s.start_s || a.end_s !== s.end_s || a.job_no !== s.job_no; };

  // The k-th occurrence of a job in 対象 is paired with the k-th occurrence in お手本 (bands, alignment).
  const pairInStd = (tgtSeg) => {
    const k = working.filter((s) => s.job_no === tgtSeg.job_no && s.start_s < tgtSeg.start_s).length;
    return segsOf('std').filter((s) => s.job_no === tgtSeg.job_no)[k] ?? null;
  };
  // Spec 7.2: on the other row, the first matching segment at or after the current position, otherwise the first one.
  const matchOn = (side, jobNo) => {
    const segs = segsOf(side);
    const same = segs.filter((s) => s.job_no === jobNo);
    if (!same.length) return { segment: null };
    const current = segAt(segs, players[side].t);
    if (current.job_no === jobNo) return { segment: current, stay: true };
    return { segment: same.find((s) => s.start_s >= players[side].t) ?? same[0] };
  };
  const changesBetween = (before, after) => {
    const out = [];
    after.forEach((s, i) => {
      const b = before.find((x) => x.segment_id === s.segment_id);
      if (!b) return;
      if (b.start_s !== s.start_s) out.push(`区間${pad(i + 1)} 開始 ${fmt(b.start_s)}→${fmt(s.start_s)}`);
      if (b.end_s !== s.end_s) out.push(`区間${pad(i + 1)} 終了 ${fmt(b.end_s)}→${fmt(s.end_s)}`);
      if (b.job_no !== s.job_no) out.push(`区間${pad(i + 1)} 作業名 ${b.job_title}→${s.job_title}`);
    });
    return out;
  };
  const pending = () => changesBetween(baseline(), working);

  // ---------- small UI helpers ----------
  let toastTimer = null;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }
  function setSyncStatus(message, warn = false) {
    const el = $('#syncStatus');
    el.textContent = message;
    el.classList.toggle('warn', warn);
  }
  function pushUndo() {
    undoStack.push(clone(working));
    if (undoStack.length > 50) undoStack.shift();
  }

  // ---------- schematic video (deterministic from time) ----------
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
  function drawScene(canvas, side, t, seg, segs) {
    const c = canvas.getContext('2d');
    if (!c) return;
    const W = canvas.width;
    const H = canvas.height;
    const order = ['100', '110', '120', '130', '140', '150'];
    const stage = order.indexOf(seg.job_no);
    const p = Math.min(Math.max((t - seg.start_s) / Math.max(len(seg), 0.001), 0), 1);
    // During non-work (e.g. waiting for parts) the unit keeps the state reached by the last work segment.
    const lastWork = [...segs].reverse().find((s) => s.start_s <= t && order.includes(s.job_no));
    const reached = lastWork ? order.indexOf(lastWork.job_no) : -1;
    const done = (job) => (stage >= 0 ? stage > order.indexOf(job) : reached >= order.indexOf(job));
    c.fillStyle = '#26343c'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#34464f'; roundRect(c, 20, 26, W - 40, H - 46, 10); c.fill();
    c.fillStyle = side === 'std' ? '#58786a' : '#5b7482'; roundRect(c, 36, 40, W - 72, H - 74, 6); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 1;
    for (let x = 36; x < W - 36; x += 28) { c.beginPath(); c.moveTo(x, 40); c.lineTo(x, H - 34); c.stroke(); }
    // Parts tray on the left
    c.fillStyle = '#2f4148'; roundRect(c, 62, 84, 112, 176, 8); c.fill();
    const left = stage === 0 ? 6 - Math.floor(p * 3) : done('100') ? 3 : 6;
    for (let i = 0; i < 6; i++) { c.fillStyle = i < left ? '#b9c7cb' : '#3d525a'; roundRect(c, 74 + (i % 2) * 50, 96 + Math.floor(i / 2) * 54, 38, 40, 4); c.fill(); }
    // Unit on the bench: moves right while it is put away (150)
    const shift = stage === 5 ? p * 150 : done('150') ? 150 : 0;
    const tilt = stage === 4 ? Math.sin(p * Math.PI * 2) * 0.08 : 0;
    c.save(); c.translate(330 + shift, 190); c.rotate(tilt);
    c.fillStyle = '#b8c4c9'; roundRect(c, -90, -64, 180, 128, 8); c.fill();
    if (stage >= 1 || done('110')) { c.fillStyle = '#7d8e95'; roundRect(c, -60 - (stage === 1 ? (1 - p) * 70 : 0), -34, 120, 40, 5); c.fill(); }
    const screwSpots = [[-44, -14], [44, -14], [-44, 34], [44, 34]];
    const placed = stage === 2 ? Math.ceil(p * 4) : done('120') ? 4 : 0;
    const tight = stage === 3 ? Math.ceil(p * 4) : done('130') ? 4 : 0;
    screwSpots.slice(0, placed).forEach(([x, y], i) => { c.fillStyle = i < tight ? '#e0b64a' : '#e9eef0'; c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill(); });
    c.restore();
    // Hands
    const hand = (x, y) => { c.fillStyle = '#e2c4a8'; c.strokeStyle = '#a98a6d'; c.lineWidth = 2; c.beginPath(); c.ellipse(x, y, 22, 16, 0, 0, Math.PI * 2); c.fill(); c.stroke(); };
    const wave = Math.sin(t * 2.4);
    if (seg.job_no === 'NW07') { hand(250, 312); hand(430, 312); c.strokeStyle = '#f2f5f6'; c.lineWidth = 3; c.beginPath(); c.arc(W - 90, 78, 18, 0, Math.PI * 2); c.moveTo(W - 90, 78); c.lineTo(W - 90, 66); c.moveTo(W - 90, 78); c.lineTo(W - 80, 84); c.stroke(); }
    else if (stage === 0) { hand(150 + wave * 90, 170 + wave * 20); hand(420, 280); }
    else if (stage === 1) { hand(270, 200); hand(390, 200); }
    else if (stage === 2 || stage === 3) {
      const [sx, sy] = screwSpots[Math.min(3, Math.floor(p * 4))];
      hand(260, 250); hand(330 + sx + 14, 190 + sy + 14);
      c.fillStyle = stage === 3 ? '#2d6fb0' : '#52606d'; roundRect(c, 330 + sx + 28, 190 + sy - 30, 14, 52, 4); c.fill();
    } else if (stage === 4) { hand(250, 190 - Math.abs(wave) * 24); hand(410, 190 - Math.abs(wave) * 24); }
    else { hand(250 + shift, 200); hand(410 + shift, 200); }
  }

  // ---------- players ----------
  const playerEl = (side) => $(`.player[data-side="${side}"]`);
  function renderPlayerMeta() {
    const src = stdSource();
    $('#stdCounter').textContent = `${state.std + 1} / ${result.standard_set.sources.length}`;
    $('#stdName').textContent = `${src.display_name}（${fmt(src.duration_s)}）`;
    $('#tgtName').textContent = `${result.input_video.display_name}（${fmt(result.input_video.duration_s)}）`;
    for (const side of ['std', 'tgt']) {
      const el = playerEl(side);
      el.querySelector('[data-seek]').max = duration(side);
      el.querySelector('[data-act="prev"]').innerHTML = ICONS.prev;
      el.querySelector('[data-act="next"]').innerHTML = ICONS.next;
    }
  }
  function updatePlayer(side) {
    const p = players[side];
    const el = playerEl(side);
    const seg = segAt(segsOf(side), p.t);
    el.querySelector('[data-clock]').textContent = `${fmt(p.t)} / ${fmt(duration(side))}`;
    el.querySelector('[data-seek]').value = p.t;
    el.querySelector('[data-caption]').textContent = `${seg.job_no} ${seg.job_title}`;
    const icon = p.playing ? 'pause' : 'play';
    if (p.icon !== icon) {
      const play = el.querySelector('[data-act="play"]');
      play.innerHTML = ICONS[icon];
      play.setAttribute('aria-label', `${sideName(side)}を${p.playing ? '一時停止' : '再生'}`);
      p.icon = icon;
    }
    drawScene(el.querySelector('canvas'), side, p.t, seg, segsOf(side));
    positionPlayhead(side);
  }
  function seekTo(side, t, { sync = true } = {}) {
    players[side].t = Math.min(Math.max(t, 0), duration(side));
    updatePlayer(side);
    segmentChanged(side, sync);
  }
  function segmentChanged(side, sync) {
    const seg = segAt(segsOf(side), players[side].t);
    if (players[side].last === seg.segment_id) return;
    players[side].last = seg.segment_id;
    if (sync && state.sync && !(players.std.playing && players.tgt.playing)) syncOther(side, seg);
  }
  function syncOther(side, seg) {
    const other = side === 'std' ? 'tgt' : 'std';
    const m = matchOn(other, seg.job_no);
    if (!m.segment) { setSyncStatus(`対応区間なし：${sideName(other)}に「${seg.job_title}」の区間はありません（移動しません）`, true); return; }
    if (m.stay) { setSyncStatus(`区間同期：${sideName(other)}は「${seg.job_title}」の区間にあります`); return; }
    players[other].t = m.segment.start_s;
    players[other].last = m.segment.segment_id;
    updatePlayer(other);
    setSyncStatus(`区間同期：${sideName(other)}を「${seg.job_title}」の区間（${fmt(m.segment.start_s)}）へ移動しました`);
  }
  let rafId = null;
  let lastTs = null;
  function tick(ts) {
    const dt = lastTs === null ? 0 : Math.min((ts - lastTs) / 1000, 0.25);
    lastTs = ts;
    let running = false;
    for (const side of ['std', 'tgt']) {
      const p = players[side];
      if (!p.playing) continue;
      p.t = Math.min(p.t + dt, duration(side));
      if (p.t >= duration(side)) p.playing = false;
      running ||= p.playing;
      updatePlayer(side);
      segmentChanged(side, true);
    }
    followPlayhead();
    rafId = running ? requestAnimationFrame(tick) : null;
    if (!running) lastTs = null;
  }
  function setPlaying(side, on) {
    const p = players[side];
    if (on && p.t >= duration(side)) p.t = 0;
    p.playing = on;
    updatePlayer(side);
    if (on && rafId === null) { lastTs = null; rafId = requestAnimationFrame(tick); }
  }
  function stepSegment(side, dir) {
    const segs = segsOf(side);
    const i = segs.indexOf(segAt(segs, players[side].t));
    const target = dir < 0 ? (players[side].t - segs[i].start_s > 1 ? segs[i] : segs[Math.max(i - 1, 0)]) : segs[Math.min(i + 1, segs.length - 1)];
    seekTo(side, target.start_s);
  }

  // ---------- time bar ----------
  const tb = { pps: 1, tMin: 0, tMax: 0, offset: 0, width: 0 };
  const xOf = (t) => (t - tb.tMin) * tb.pps;
  function alignment() {
    if (state.align !== 'job') return { offset: 0 };
    const sel = selectedSeg();
    const same = segsOf('std').filter((s) => s.job_no === sel.job_no);
    const k = working.filter((s) => s.job_no === sel.job_no && s.start_s < sel.start_s).length;
    const ref = same[k] ?? same[0];
    return ref ? { offset: sel.start_s - ref.start_s, ref, sel } : { offset: 0, missing: sel };
  }
  function layoutTimebar() {
    const view = $('#tbScroll').clientWidth - 2;
    const d0 = Math.max(result.input_video.duration_s, ...result.standard_set.sources.map((s) => s.duration_s));
    const a = alignment();
    tb.offset = a.offset;
    tb.pps = Math.max(view, 200) * state.zoom / d0; // seconds-to-pixels does not depend on the alignment
    tb.tMin = Math.min(0, a.offset);
    tb.tMax = Math.max(d0, stdSource().duration_s + a.offset);
    tb.width = Math.max(view, (tb.tMax - tb.tMin) * tb.pps);
    return a;
  }
  function blockHtml(s, side) {
    const [tint, accent] = COLORS[s.job_no] ?? ['#eef1f4', '#5b6b7c'];
    const review = side === 'tgt' && autoById.get(s.segment_id).review_required;
    const selected = side === 'tgt' && s.segment_id === state.selected;
    const sel = selectedSeg();
    const paired = side === 'std' && pairInStd(sel) === s;
    const x = xOf(side === 'std' ? s.start_s + tb.offset : s.start_s);
    const w = len(s) * tb.pps;
    const classes = ['block', vocab.get(s.job_no)?.kind === 'non_work' ? 'nonwork' : '', review ? 'review' : '', selected ? 'selected' : '', paired ? 'paired' : ''].filter(Boolean).join(' ');
    const detail = `No.${s.job_no} · ${secText(len(s))}${review ? ' · 要確認' : ''}`;
    const label = `${sideName(side)} ${s.job_no} ${s.job_title}、${fmt(s.start_s)}から${fmt(s.end_s)}（${secText(len(s))}）${review ? '、要確認' : ''}`;
    return `<button type="button" class="${classes}" data-side="${side}" data-id="${s.segment_id}" style="left:${x + 1}px;width:${Math.max(w - 2, 2)}px;background:${tint};border-color:${accent}" aria-label="${esc(label)}"${side === 'tgt' ? ` aria-pressed="${selected}"` : ''}>`
      + `<span class="t" data-full="${esc(s.job_title)}" data-short="${esc(s.job_no)}"></span><span class="d" data-full="${esc(detail)}" data-short="${esc(secText(len(s)))}"></span></button>`;
  }
  function fitLabels(root = $('#tbTrack')) {
    for (const span of $$('.block .t, .block .d', root)) {
      span.hidden = false;
      span.textContent = span.dataset.full;
      if (span.scrollWidth > span.clientWidth + 1) span.textContent = span.dataset.short;
      if (span.scrollWidth > span.clientWidth + 1) span.hidden = true;
    }
  }
  function renderBands() {
    const svg = $('#bands');
    const h = svg.getBoundingClientRect().height || 36;
    svg.setAttribute('width', tb.width);
    svg.setAttribute('viewBox', `0 0 ${tb.width} ${h}`);
    const job = selectedSeg().job_no;
    svg.innerHTML = working.map((s) => {
      const p = pairInStd(s);
      if (!p) return '';
      const accent = (COLORS[s.job_no] ?? [])[1] ?? '#5b6b7c';
      const on = s.job_no === job;
      const [x1, x2, x3, x4] = [xOf(p.start_s + tb.offset) + 1, xOf(p.end_s + tb.offset) - 1, xOf(s.end_s) - 1, xOf(s.start_s) + 1];
      return `<path d="M${x1} 0L${x2} 0L${x3} ${h}L${x4} ${h}Z" fill="${accent}" fill-opacity="${on ? 0.4 : 0.15}" stroke="${accent}" stroke-opacity="${on ? 0.85 : 0.3}"/>`;
    }).join('');
  }
  function positionPlayhead(side) {
    const t = players[side].t;
    $(side === 'std' ? '#phStd' : '#phTgt').style.left = `${xOf(side === 'std' ? t + tb.offset : t)}px`;
  }
  function renderTimebar() {
    const a = layoutTimebar();
    $('#tbTrack').style.width = `${tb.width}px`;
    const step = [1, 2, 5, 10, 15, 30, 60].find((s) => s * tb.pps >= 58) ?? 60;
    let ticks = '';
    for (let t = Math.ceil(tb.tMin / step) * step; t <= tb.tMax + 1e-6; t += step) {
      ticks += `<div class="tick" style="left:${xOf(t)}px"><span>${t < 0 ? '−' : ''}${fmt(Math.abs(t))}</span></div>`;
    }
    $('#ruler').innerHTML = ticks;
    $('#rowStd').innerHTML = segsOf('std').map((s) => blockHtml(s, 'std')).join('');
    const marks = working.slice(0, -1).map((s, i) => (AUTO[i].end_s !== s.end_s
      ? `<i class="orig-mark" style="left:${xOf(AUTO[i].end_s)}px" title="自動判定の境目 ${fmt(AUTO[i].end_s)}"></i>` : '')).join('');
    const handles = working.slice(0, -1).map((s, i) => `<button type="button" class="handle" role="slider" data-index="${i}" style="left:${xOf(s.end_s)}px"`
      + ` aria-label="区間${pad(i + 1)}と区間${pad(i + 2)}の境目（修正後）" aria-valuemin="${working[i].start_s + MIN_LEN}" aria-valuemax="${working[i + 1].end_s - MIN_LEN}"`
      + ` aria-valuenow="${s.end_s}" aria-valuetext="${fmt(s.end_s)}"></button>`).join('');
    $('#rowTgt').innerHTML = working.map((s) => blockHtml(s, 'tgt')).join('') + marks + handles;
    renderBands();
    fitLabels();
    positionPlayhead('std');
    positionPlayhead('tgt');
    for (const b of $$('[data-align]')) b.setAttribute('aria-checked', String(b.dataset.align === state.align));
    $('#zoomValue').textContent = `${Math.round(state.zoom * 100)}%`;
    $('#zoomOut').disabled = state.zoom === ZOOMS[0];
    $('#zoomIn').disabled = state.zoom === ZOOMS[ZOOMS.length - 1];
    $('#stdRowLabel').textContent = `${state.std + 1}/${result.standard_set.sources.length} ${stdSource().display_name}`;
    $('#tgtRowLabel').textContent = '修正後';
    $('#rulerLabel').textContent = state.align === 'job' ? '対象の時間' : '時間';
    const note = $('#alignNote');
    if (state.align === 'zero') note.textContent = '両方の動画の0秒を左端にそろえています（実時間）。';
    else if (a.missing) note.textContent = `選んだ区間「${a.missing.job_title}」はお手本にないため、0秒でそろえています。`;
    else note.textContent = `「${a.sel.job_title}」の頭をそろえています（お手本を${signed(a.offset)}ずらして表示。1秒あたりの幅は同じ）。`;
  }
  function followPlayhead() {
    const scroll = $('#tbScroll');
    const x = xOf(players.tgt.t);
    if (x < scroll.scrollLeft + 40 || x > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.3);
  }
  function revealSelected() {
    const scroll = $('#tbScroll');
    const s = selectedSeg();
    const x1 = xOf(s.start_s);
    const x2 = xOf(s.end_s);
    if (x1 < scroll.scrollLeft || x2 > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = Math.max(0, x1 - scroll.clientWidth * 0.25);
  }
  function moveBoundary(i, t) {
    if (!Number.isFinite(t)) return false;
    const a = working[i];
    const b = working[i + 1];
    const value = Math.min(Math.max(snap(t), a.start_s + MIN_LEN), b.end_s - MIN_LEN);
    if (value === a.end_s) return false;
    a.end_s = value;
    b.start_s = value;
    return true;
  }
  function dragVisual(i) {
    const blocks = $$('#rowTgt .block');
    for (const j of [i, i + 1]) {
      const s = working[j];
      blocks[j].style.left = `${xOf(s.start_s) + 1}px`;
      blocks[j].style.width = `${Math.max(len(s) * tb.pps - 2, 2)}px`;
      const review = autoById.get(s.segment_id).review_required;
      blocks[j].querySelector('.d').dataset.full = `No.${s.job_no} · ${secText(len(s))}${review ? ' · 要確認' : ''}`;
      blocks[j].querySelector('.d').dataset.short = secText(len(s));
      fitLabels(blocks[j]);
    }
    const handle = $(`#rowTgt .handle[data-index="${i}"]`);
    handle.style.left = `${xOf(working[i].end_s)}px`;
    handle.setAttribute('aria-valuenow', working[i].end_s);
    handle.setAttribute('aria-valuetext', fmt(working[i].end_s));
    renderBands();
  }
  function wireTimebar() {
    const track = $('#tbTrack');
    track.addEventListener('click', (event) => {
      const block = event.target.closest('.block');
      if (!block) return;
      if (block.dataset.side === 'tgt') selectSegment(block.dataset.id);
      else {
        const s = segsOf('std').find((x) => x.segment_id === block.dataset.id);
        seekTo('std', s.start_s);
      }
    });
    let drag = null;
    track.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('.handle');
      if (!handle) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      drag = { handle, index: Number(handle.dataset.index), before: clone(working), moved: false };
    });
    track.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const rect = track.getBoundingClientRect();
      if (moveBoundary(drag.index, tb.tMin + (event.clientX - rect.left) / tb.pps)) { drag.moved = true; dragVisual(drag.index); }
    });
    const finish = () => {
      if (!drag) return;
      drag.handle.classList.remove('dragging');
      if (drag.moved) { undoStack.push(drag.before); afterEdit('境目を動かしました（修正後・未保存）'); }
      drag = null;
    };
    track.addEventListener('pointerup', finish);
    track.addEventListener('pointercancel', finish);
    track.addEventListener('keydown', (event) => {
      const handle = event.target.closest('.handle');
      if (!handle || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const i = Number(handle.dataset.index);
      const before = clone(working);
      const delta = (event.key === 'ArrowLeft' ? -1 : 1) * SNAP * (event.shiftKey ? 10 : 1);
      if (moveBoundary(i, working[i].end_s + delta)) {
        undoStack.push(before);
        afterEdit('境目を動かしました（修正後・未保存）');
        $(`#rowTgt .handle[data-index="${i}"]`)?.focus();
      }
    });
  }

  // ---------- selection and edits ----------
  function selectSegment(id, { seek = true } = {}) {
    state.selected = id;
    if (seek) seekTo('tgt', selectedSeg().start_s);
    renderTimebar();
    renderPanel();
    revealSelected();
  }
  function focusJob(jobNo) {
    const t = matchOn('tgt', jobNo);
    const s = matchOn('std', jobNo);
    const title = vocab.get(jobNo).job_title;
    if (t.segment) { state.selected = t.segment.segment_id; players.tgt.t = t.segment.start_s; players.tgt.last = t.segment.segment_id; updatePlayer('tgt'); }
    if (s.segment) { players.std.t = s.segment.start_s; players.std.last = s.segment.segment_id; updatePlayer('std'); }
    if (!t.segment) setSyncStatus(`対象に「${title}」の区間はありません。お手本だけ移動しました。`, true);
    else if (!s.segment) setSyncStatus(`対応区間なし：お手本に「${title}」の区間はありません。対象だけ移動しました。`, true);
    else setSyncStatus(`「${title}」の区間へ両方の動画を移動しました（対象 ${fmt(t.segment.start_s)}／お手本 ${fmt(s.segment.start_s)}）`);
    renderTimebar();
    renderPanel();
    revealSelected();
  }
  function afterEdit(message) {
    renderAll();
    if (message) toast(message);
  }
  function applyEditor() {
    const i = working.findIndex((s) => s.segment_id === state.selected);
    const s = working[i];
    const prev = working[i - 1];
    const next = working[i + 1];
    const start = i === 0 ? 0 : snap(parseTime($('#edStart').value));
    const end = i === working.length - 1 ? duration('tgt') : snap(parseTime($('#edEnd').value));
    const job = $('#edJob').value;
    const error = Number.isNaN(start) || Number.isNaN(end) ? '時刻は「00:24」や「24.5」の形で入力してください。'
      : end - start < MIN_LEN ? '区間は1秒以上にしてください。'
        : prev && start < prev.start_s + MIN_LEN ? '前の区間が1秒未満になるため、この開始時刻にはできません。'
          : next && end > next.end_s - MIN_LEN ? '次の区間が1秒未満になるため、この終了時刻にはできません。' : '';
    if (error) { $('#edError').textContent = error; return; }
    if (start === s.start_s && end === s.end_s && job === s.job_no) { $('#edError').textContent = '変更はありません。'; return; }
    pushUndo();
    s.start_s = start; s.end_s = end; s.job_no = job; s.job_title = vocab.get(job).job_title;
    if (prev) prev.end_s = start;
    if (next) next.start_s = end;
    afterEdit('修正後に反映しました（まだ保存していません）');
  }
  function revertSegment() {
    const i = working.findIndex((s) => s.segment_id === state.selected);
    const s = working[i];
    const a = autoById.get(s.segment_id);
    const prev = working[i - 1];
    const next = working[i + 1];
    if (!isEdited(s) && (!prev || prev.end_s === a.start_s) && (!next || next.start_s === a.end_s)) { $('#edError').textContent = 'この区間は自動判定と同じです。'; return; }
    if ((prev && a.start_s < prev.start_s + MIN_LEN) || (next && a.end_s > next.end_s - MIN_LEN)) { $('#edError').textContent = '隣の区間が1秒未満になるため、戻せません。'; return; }
    pushUndo();
    Object.assign(s, plain(a));
    if (prev) prev.end_s = a.start_s;
    if (next) next.start_s = a.end_s;
    afterEdit('この区間を自動判定の値に戻しました（修正後・未保存）');
  }
  function undo() {
    if (!undoStack.length) return;
    working = undoStack.pop();
    if (!working.some((s) => s.segment_id === state.selected)) state.selected = working[0].segment_id;
    afterEdit('ひとつ前の状態に戻しました');
  }
  function save() {
    const changes = pending();
    const memo = $('#memoText').value.trim();
    if (!changes.length && !memo) { toast('保存する修正やメモがありません'); return; }
    const version = (latest()?.version ?? 0) + 1;
    reviews.push({ version, saved_at: new Date().toISOString(), reviewer: $('#memoReviewer').value.trim(), comment: memo, segments: clone(working) });
    storage.save({ reviews });
    $('#memoText').value = '';
    undoStack.length = 0;
    afterEdit(`修正後 v${version} を保存しました（このブラウザの中だけ・モック）`);
  }
  function resetMock() {
    storage.clear();
    reviews = clone(DATA.reviews);
    working = clone(baseline());
    undoStack.length = 0;
    state.selected = firstReview.segment_id;
    $('#memoText').value = '';
    $('#memoReviewer').value = latest()?.reviewer ?? '';
    afterEdit('モックを初期状態に戻しました');
  }

  // ---------- right panel ----------
  const dateText = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  function renderDiff() {
    for (const b of $$('[data-source]')) b.setAttribute('aria-checked', String(b.dataset.source === state.source));
    const count = pending().length;
    const label = $('#sourceLabel');
    label.dataset.source = state.source;
    label.textContent = state.source === 'auto'
      ? '表示中：自動判定（今回の分析の結果。人の修正は含みません）'
      : `表示中：修正後（保存済み v${latest()?.version ?? 0}${count ? `＋未保存の修正 ${count}件` : ''}。自動判定は変わりません）`;
    const tgt = totals(state.source === 'auto' ? AUTO : working);
    const std = totals(segsOf('std'));
    const order = DATA.vocabulary.labels.map((l) => l.job_no);
    const rows = order.filter((no) => tgt.has(no) || std.has(no)).map((no) => {
      const r = { no, title: vocab.get(no).job_title, st: vocab.get(no).st_s, std: std.get(no) ?? null, tgt: tgt.get(no) ?? null };
      return { ...r, diff: r.std !== null && r.tgt !== null ? round1(r.tgt - r.std) : null };
    });
    rows.sort((a, b) => (a.diff === null) - (b.diff === null) || Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0) || order.indexOf(a.no) - order.indexOf(b.no));
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.diff ?? 0)));
    $('#diffContext').textContent = `比べるお手本：${state.std + 1}/${result.standard_set.sources.length}「${stdSource().display_name}」`;
    const job = selectedSeg().job_no;
    const total = round1(sum(tgt) - sum(std));
    $('#diffTable').innerHTML = '<div class="diff-head"><span>工程（差の大きい順）</span><span class="num">お手本</span><span class="num">対象</span><span class="num">差（対象−お手本）</span></div>'
      + rows.map((r) => `<button type="button" class="diff-row" data-job="${esc(r.no)}" aria-current="${r.no === job}">`
        + `<span class="job"><b>${esc(r.title)}</b><small>No.${esc(r.no)} · ${r.st === null ? '作業外' : `ST ${secText(r.st)}`}</small></span>`
        + `<span class="num">${r.std === null ? '該当なし' : secText(r.std)}</span><span class="num">${r.tgt === null ? '該当なし' : secText(r.tgt)}</span>`
        + `<span class="delta${r.diff > 0 ? ' plus' : r.diff < 0 ? ' minus' : ''}">${r.diff === null ? '<span>—</span>'
          : `<i class="bar" style="width:${Math.max(2, Math.round(Math.abs(r.diff) / max * 56))}px"></i><span>${signed(r.diff)}</span>`}</span></button>`).join('')
      + `<div class="diff-total"><span>合計（全区間）</span><span class="num">${fmt(sum(std))}</span><span class="num">${fmt(sum(tgt))}</span>`
      + `<span class="delta${total > 0 ? ' plus' : total < 0 ? ' minus' : ''}"><span>${signed(total)}</span></span></div>`;
  }
  function renderSegments() {
    for (const b of $$('[data-filter]')) b.setAttribute('aria-checked', String(b.dataset.filter === state.filter));
    const reviewTotal = AUTO.filter((s) => s.review_required).length;
    $('[data-filter="review"]').textContent = `要確認だけ（${reviewTotal}）`;
    $('[data-filter="all"]').textContent = `すべて（${working.length}）`;
    const rows = working.map((s, i) => ({ s, i, auto: autoById.get(s.segment_id) })).filter(({ auto }) => state.filter === 'all' || auto.review_required);
    $('#segmentList').innerHTML = rows.map(({ s, i, auto }) => `<button type="button" class="seg-row" data-id="${s.segment_id}" aria-current="${s.segment_id === state.selected}">`
      + `<span class="seg-no">${pad(i + 1)}</span><span class="seg-main"><b>${esc(s.job_title)}</b><small>${fmt(s.start_s)}–${fmt(s.end_s)}・${secText(len(s))}・No.${esc(s.job_no)}</small></span>`
      + `<span class="tags">${auto.review_required ? '<span class="tag review">要確認</span>' : ''}${isEdited(s) ? '<span class="tag edited">修正あり</span>' : ''}</span></button>`).join('')
      || '<p class="empty">表示する区間はありません。</p>';
    renderEditor();
  }
  function renderEditor() {
    const i = working.findIndex((s) => s.segment_id === state.selected);
    const s = working[i];
    const a = autoById.get(s.segment_id);
    const first = i === 0;
    const last = i === working.length - 1;
    const options = DATA.vocabulary.labels.map((l) => `<option value="${esc(l.job_no)}"${l.job_no === s.job_no ? ' selected' : ''}>${esc(l.job_no)} ${esc(l.job_title)}</option>`).join('');
    $('#editor').innerHTML = `<h3 id="editorTitle">区間${pad(i + 1)}を直す <span class="tag edited">修正後</span></h3>`
      + '<div class="field-grid">'
      + `<label>開始<input type="text" id="edStart" value="${fmt(s.start_s)}" inputmode="decimal"${first ? ' readonly' : ''}></label>`
      + `<label>終了<input type="text" id="edEnd" value="${fmt(s.end_s)}" inputmode="decimal"${last ? ' readonly' : ''}></label>`
      + `<label>作業名（作業名一覧から選ぶ）<select id="edJob">${options}</select></label></div>`
      + (first || last ? `<p class="hint">${first ? '開始' : '終了'}は動画の端なので動かせません。</p>` : '')
      + `<p class="reference">自動判定：${fmt(a.start_s)}–${fmt(a.end_s)}　${esc(a.job_no)} ${esc(a.job_title)}</p>`
      + (a.review_required ? `<p class="review-reasons"><span class="tag review">要確認</span> ${a.review_reasons.map((r) => esc(REASONS[r] ?? r)).join('・')}</p>` : '')
      + '<p class="form-error" id="edError" role="alert"></p>'
      + '<div class="editor-actions"><button class="button small primary" type="button" id="edApply">修正後に反映</button><button class="button small" type="button" id="edRevert">自動判定に戻す</button></div>'
      + `<details class="evidence" id="evidence"${state.evidenceOpen ? ' open' : ''}><summary>根拠を見る（確信度・候補・境目の理由）</summary><dl>`
      + `<dt>確信度</dt><dd>表示用 ${a.confidence.toFixed(2)}／生の値 ${a.confidence_raw.toFixed(2)}</dd>`
      + `<dt>候補</dt><dd><ol>${a.candidates.map((c) => `<li>${esc(c.job_no)} ${esc(c.job_title)}（${c.score.toFixed(2)}）</li>`).join('')}</ol></dd>`
      + `<dt>境目の理由</dt><dd>開始：${esc(a.boundary_evidence.start_reason)}／終了：${esc(a.boundary_evidence.end_reason)}</dd>`
      + `<dt>観察</dt><dd>${esc(a.observation.operation)}。道具：${esc(a.observation.tools)}。部品：${esc(a.observation.parts)}</dd></dl></details>`;
  }
  function renderMemo() {
    const changes = pending();
    $('#pendingChanges').textContent = changes.length ? `未保存の修正 ${changes.length}件：${changes.join('、')}` : '未保存の修正はありません。';
    $('#memoList').innerHTML = reviews.slice().reverse().map((r) => {
      const prev = reviews.find((x) => x.version === r.version - 1);
      const diff = changesBetween(prev?.segments ?? AUTO.map(plain), r.segments);
      return `<li class="memo-item"><div class="memo-meta"><span>${esc(dateText(r.saved_at))}</span><span class="tag edited">修正後 v${r.version}</span><span>確認者：${esc(r.reviewer || '（未入力）')}</span></div>`
        + `<p class="memo-text">${r.comment ? esc(r.comment) : '（メモなし）'}</p><p class="memo-changes">${diff.length ? `変更：${esc(diff.join('、'))}` : '区間の変更なし'}</p></li>`;
    }).join('') || '<li class="empty">まだ保存はありません。</li>';
  }
  function renderPanel() {
    for (const tab of $$('[role="tab"]')) {
      const on = tab.dataset.tab === state.tab;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of $$('[role="tabpanel"]')) panel.hidden = panel.id !== `panel-${state.tab}`;
    $('#reviewCount').textContent = AUTO.filter((s) => s.review_required).length;
    $('#memoCount').textContent = reviews.length;
    renderDiff();
    renderSegments();
    renderMemo();
  }
  function renderTop() {
    $('#resultTitle').textContent = result.title;
    $('#setChip').textContent = `お手本セット：${result.standard_set.name}（${result.standard_set.sources.length}本）`;
    const count = pending().length;
    const dirty = $('#dirtyState');
    dirty.textContent = count ? `未保存の修正 ${count}件` : '未保存の修正はありません';
    dirty.classList.toggle('has-changes', count > 0);
    $('#saveButton').disabled = !count && !$('#memoText').value.trim();
    $('#undoButton').disabled = !undoStack.length;
  }
  function renderAll() {
    renderTop();
    renderPlayerMeta();
    for (const side of ['std', 'tgt']) updatePlayer(side);
    renderTimebar();
    renderPanel();
  }

  // ---------- wiring ----------
  function wire() {
    for (const side of ['std', 'tgt']) {
      const el = playerEl(side);
      el.querySelector('[data-act="play"]').addEventListener('click', () => setPlaying(side, !players[side].playing));
      el.querySelector('[data-act="prev"]').addEventListener('click', () => stepSegment(side, -1));
      el.querySelector('[data-act="next"]').addEventListener('click', () => stepSegment(side, 1));
      el.querySelector('[data-seek]').addEventListener('input', (event) => seekTo(side, Number(event.target.value)));
    }
    const switchStd = (dir) => {
      const n = result.standard_set.sources.length;
      state.std = (state.std + dir + n) % n;
      players.std.t = Math.min(players.std.t, duration('std'));
      players.std.last = null;
      const m = matchOn('std', selectedSeg().job_no);
      if (m.segment) { players.std.t = m.segment.start_s; players.std.last = m.segment.segment_id; }
      renderPlayerMeta();
      updatePlayer('std');
      renderTimebar();
      renderDiff();
      setSyncStatus(`お手本を ${state.std + 1}/${n}「${stdSource().display_name}」に切り替えました`);
    };
    $('#stdPrev').addEventListener('click', () => switchStd(-1));
    $('#stdNext').addEventListener('click', () => switchStd(1));
    $('#syncToggle').addEventListener('change', (event) => {
      state.sync = event.target.checked;
      $('#syncHint').textContent = state.sync ? '片方の工程が変わると、もう片方も同じ作業名の区間へ移動します。' : '区間同期はオフです。2つの動画は別々に動きます。';
    });
    $('#playBoth').addEventListener('click', () => {
      const on = !(players.std.playing && players.tgt.playing);
      setPlaying('std', on);
      setPlaying('tgt', on);
      $('#playBoth').textContent = on ? '両方を止める' : '両方を再生';
      if (on) setSyncStatus('両方を再生中です。再生中は区間同期で動画を動かしません。');
    });
    for (const b of $$('[data-align]')) b.addEventListener('click', () => { state.align = b.dataset.align; renderTimebar(); revealSelected(); });
    const zoomTo = (z) => { state.zoom = z; renderTimebar(); revealSelected(); };
    $('#zoomIn').addEventListener('click', () => zoomTo(ZOOMS[Math.min(ZOOMS.indexOf(state.zoom) + 1, ZOOMS.length - 1)]));
    $('#zoomOut').addEventListener('click', () => zoomTo(ZOOMS[Math.max(ZOOMS.indexOf(state.zoom) - 1, 0)]));
    $('#zoomFit').addEventListener('click', () => zoomTo(1));
    $('#undoButton').addEventListener('click', undo);
    wireTimebar();

    const tabs = $$('[role="tab"]');
    for (const tab of tabs) {
      tab.addEventListener('click', () => { state.tab = tab.dataset.tab; renderPanel(); });
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        state.tab = next.dataset.tab;
        renderPanel();
        next.focus();
      });
    }
    for (const b of $$('[data-source]')) b.addEventListener('click', () => { state.source = b.dataset.source; renderDiff(); });
    for (const b of $$('[data-filter]')) b.addEventListener('click', () => { state.filter = b.dataset.filter; renderSegments(); });
    $('#diffTable').addEventListener('click', (event) => { const row = event.target.closest('.diff-row'); if (row) focusJob(row.dataset.job); });
    $('#segmentList').addEventListener('click', (event) => { const row = event.target.closest('.seg-row'); if (row) selectSegment(row.dataset.id); });
    const stepReview = (dir) => {
      const flagged = working.filter((s) => autoById.get(s.segment_id).review_required);
      const i = flagged.findIndex((s) => s.segment_id === state.selected);
      const target = i < 0 ? flagged[0] : flagged[(i + dir + flagged.length) % flagged.length];
      if (target) selectSegment(target.segment_id);
    };
    $('#prevReview').addEventListener('click', () => stepReview(-1));
    $('#nextReview').addEventListener('click', () => stepReview(1));
    $('#editor').addEventListener('click', (event) => {
      if (event.target.id === 'edApply') applyEditor();
      if (event.target.id === 'edRevert') revertSegment();
    });
    $('#editor').addEventListener('toggle', (event) => { if (event.target.id === 'evidence') state.evidenceOpen = event.target.open; }, true);
    $('#memoText').addEventListener('input', renderTop);
    $('#saveButton').addEventListener('click', save);
    $('#aboutButton').addEventListener('click', () => $('#aboutDialog').showModal());
    $('#closeAbout').addEventListener('click', () => $('#aboutDialog').close());
    $('#resetButton').addEventListener('click', () => { resetMock(); $('#aboutDialog').close(); });
    for (const link of $$('[data-mock-link]')) link.addEventListener('click', (event) => { event.preventDefault(); toast('モックのため移動しません（実際の画面では実行履歴に戻ります）'); });
    let resizeFrame = null;
    new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(renderTimebar); }).observe($('#tbScroll'));
  }

  // ---------- start ----------
  $('#memoReviewer').value = latest()?.reviewer ?? '';
  $('#syncToggle').checked = state.sync;
  const startSeg = selectedSeg();
  players.tgt.t = startSeg.start_s;
  players.tgt.last = startSeg.segment_id;
  const stdStart = pairInStd(startSeg) ?? segsOf('std').find((s) => s.job_no === startSeg.job_no);
  if (stdStart) { players.std.t = stdStart.start_s; players.std.last = stdStart.segment_id; }
  setSyncStatus(stdStart ? `区間同期：お手本と対象は、どちらも「${startSeg.job_title}」の区間の頭を表示しています。` : `対応区間なし：お手本に「${startSeg.job_title}」の区間はありません。`, !stdStart);
  wire();
  renderAll();
  revealSelected();
  window.__mock = { state, players, AUTO, get working() { return working; }, get reviews() { return reviews; }, get pps() { return tb.pps; } };
})();
