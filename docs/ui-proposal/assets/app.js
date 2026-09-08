/* ===== 提案モック — 画面ロジック ===== */
(function () {
  const $ = (s) => document.querySelector(s);
  const circ = (n) => Scene.circled(n);

  const view = {
    time: Store.get("time", 0),
    selected: Store.get("selected", 0),
    zoom: Store.get("zoom", 1),
    playing: false,
    formDirty: false,
  };

  let tl = null, scene = null, raf = 0, last = 0;

  const segs = () => Store.reviewed();
  const dur  = () => Store.duration();
  const activeIndex = () => segs().findIndex((s) => s.start <= view.time && view.time < s.end);
  const undownloaded = () => (Store.get("downloaded", false) ? 0 : Store.editedCount());

  /* ---------- タイムライン ---------- */
  function tlState() {
    return {
      ai: Store.ai(), reviewed: segs(), duration: dur(),
      time: view.time, selected: view.selected, zoom: view.zoom,
      isEdited: (i) => Store.isEdited(i),
    };
  }
  function initTimeline() {
    tl = Timeline.create({
      root: $("#tl"),
      getState: tlState,
      onSeek: (t) => { seek(t); },
      onSelect: (i) => { select(i); },
      onPreview: (next) => { Store.preview(next); tl.render(); drawScene(); },
      onCommit: (next, before) => {
        Store.commit(next, { base: before });
        renderAll();
        UI.toast("区間の境界を更新しました。", null, { label: "元に戻す", run: () => { Store.undo(); renderAll(); } });
      },
    });
  }

  /* ---------- 再生 ---------- */
  function seek(t) {
    view.time = UI.clamp(Math.round(t), 0, dur());
    Store.set("time", view.time);
    renderTransport(); tl.render(); drawScene();
  }
  function select(i) {
    const n = segs().length;
    view.selected = UI.clamp(i, 0, n - 1);
    view.formDirty = false;
    Store.set("selected", view.selected);
    renderAll();
  }
  function togglePlay() {
    view.playing = !view.playing;
    if (view.playing) { last = performance.now(); raf = requestAnimationFrame(step); }
    else cancelAnimationFrame(raf);
    renderTransport();
  }
  function step(now) {
    const dt = (now - last) / 1000; last = now;
    view.time += dt * 4;                       // 4倍速で通し確認
    if (view.time >= dur()) { view.time = dur(); view.playing = false; }
    Store.set("time", Math.round(view.time));
    renderTransport(); tl.render(); drawScene();
    if (view.playing) raf = requestAnimationFrame(step);
  }
  function drawScene() {
    if (!scene) return;
    const i = activeIndex(); const list = segs();
    scene.draw(view.time, i, i >= 0 ? list[i].title : "", dur());
  }
  function renderTransport() {
    $("#playBtn").textContent = view.playing ? "⏸" : "▶";
    $("#playBtn").setAttribute("aria-label", view.playing ? "一時停止" : "再生");
    $("#clock").textContent = `${UI.hms(view.time)} / ${UI.hms(dur())}`;
    const i = activeIndex(); const list = segs();
    $("#nowSeg").textContent = i >= 0 ? `${circ(i + 1)} ${list[i].title}` : "該当する作業区間なし";
  }

  /* ---------- 区間一覧 ---------- */
  function renderList() {
    const list = segs();
    $("#segCount").textContent = `全${list.length}区間`;
    const n = Store.editedCount();
    const eb = $("#editedCount");
    eb.textContent = n ? `修正 ${n}件` : "修正なし";
    eb.className = "badge" + (n ? " warn" : "");

    const box = $("#list"); box.innerHTML = "";
    list.forEach((sg, i) => {
      const d = sg.end - sg.start;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row" + (i === view.selected ? " sel" : "");
      row.style.setProperty("--bar", `var(--c${i % 8})`);
      row.innerHTML =
        `<span class="num">${i + 1}</span>
         <span><strong>${UI.esc(sg.title)}</strong>
           <small>${UI.hms(sg.start)} – ${UI.hms(sg.end)}　${Math.round(d)}秒　Job ${UI.esc(sg.job_no)}　${UI.esc(sg.page)}</small></span>
         <span class="marks">
           ${d < 8 ? '<span class="pill tiny">短区間</span>' : ""}
           ${Store.isEdited(i) ? '<span class="pill edited">修正済み</span>' : ""}
         </span>`;
      row.addEventListener("click", () => { select(i); seek(sg.start); });
      box.appendChild(row);
    });
  }

  /* ---------- 編集フォーム ---------- */
  function renderForm() {
    const list = segs(); const sg = list[view.selected];
    const panel = $("#form");
    if (!sg) { panel.innerHTML = '<p class="muted">区間を選択してください。</p>'; return; }
    const orig = Store.ai()[view.selected];
    const d = sg.end - sg.start;

    const cmp = (key, now, fmt) => {
      if (!orig) return `<span class="orig">AI予測なし（追加された区間）</span>`;
      const was = fmt ? fmt(orig[key]) : orig[key];
      const isSame = String(was) === String(now);
      return `<span class="orig${isSame ? " same" : ""}">AI予測: ${UI.esc(was)}${isSame ? "" : " から変更"}</span>`;
    };

    panel.innerHTML = `
      <div class="fgrid">
        <div class="field">
          <span class="lbl" id="lbStart">開始時刻</span>
          <div class="spin">
            <button type="button" class="js-step" data-f="start" data-d="-1" aria-label="開始時刻を1秒戻す">−</button>
            <input type="text" class="mono" id="fStart" value="${UI.hms(sg.start)}" aria-labelledby="lbStart" inputmode="numeric">
            <button type="button" class="js-step" data-f="start" data-d="1" aria-label="開始時刻を1秒進める">＋</button>
          </div>
          ${cmp("start", UI.hms(sg.start), UI.hms)}
        </div>
        <div class="field">
          <span class="lbl" id="lbEnd">終了時刻</span>
          <div class="spin">
            <button type="button" class="js-step" data-f="end" data-d="-1" aria-label="終了時刻を1秒戻す">−</button>
            <input type="text" class="mono" id="fEnd" value="${UI.hms(sg.end)}" aria-labelledby="lbEnd" inputmode="numeric">
            <button type="button" class="js-step" data-f="end" data-d="1" aria-label="終了時刻を1秒進める">＋</button>
          </div>
          ${cmp("end", UI.hms(sg.end), UI.hms)}
        </div>
        <div class="field">
          <span class="lbl" id="lbJob">Job No.</span>
          <input type="text" id="fJob" value="${UI.esc(sg.job_no)}" aria-labelledby="lbJob">
          ${cmp("job_no", sg.job_no)}
        </div>
        <div class="field">
          <span class="lbl" id="lbPage">標準書ページ</span>
          <input type="text" id="fPage" value="${UI.esc(sg.page)}" aria-labelledby="lbPage">
          ${cmp("page", sg.page)}
        </div>
        <div class="field wide">
          <span class="lbl" id="lbTitle">作業タイトル</span>
          <input type="text" id="fTitle" value="${UI.esc(sg.title)}" aria-labelledby="lbTitle">
          ${cmp("title", sg.title)}
        </div>
      </div>
      <span class="err" id="fErr" role="alert"></span>
      <div class="ro-grid">
        <div class="ro">作業時間<span class="mono">${Math.round(d)}秒${orig && Math.round(d) !== Math.round(orig.end - orig.start) ? `（AI予測: ${Math.round(orig.end - orig.start)}秒）` : ""}</span></div>
        <div class="ro">作業内容<span>${UI.esc(sg.work_content)}</span></div>
        <div class="ro">手の動き<span>${UI.esc(sg.hand_movement)}</span></div>
        <div class="ro">治工具・部品<span>${UI.esc(sg.tools_and_parts)}</span></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn secondary" id="btnDelete">区間を削除</button>
        <button type="button" class="btn primary" id="btnApply" disabled>変更を確定</button>
      </div>`;

    panel.querySelectorAll("input").forEach((el) =>
      el.addEventListener("input", () => { view.formDirty = true; syncApply(); }));
    panel.querySelectorAll(".js-step").forEach((b) =>
      b.addEventListener("click", () => stepField(b.dataset.f, Number(b.dataset.d))));
    $("#btnApply").addEventListener("click", applyForm);
    $("#btnDelete").addEventListener("click", deleteSeg);
    syncApply();
  }

  function stepField(f, d) {
    const el = f === "start" ? $("#fStart") : $("#fEnd");
    const cur = UI.parseHms(el.value);
    if (cur === null) return;
    el.value = UI.hms(UI.clamp(cur + d, 0, dur()));
    view.formDirty = true; syncApply();
  }
  function syncApply() {
    const btn = $("#btnApply"); if (!btn) return;
    btn.disabled = !view.formDirty;
    renderOutputCard();
    $("#draftBadge").hidden = !view.formDirty;
  }

  function applyForm() {
    const list = segs(); const i = view.selected;
    const s = UI.parseHms($("#fStart").value);
    const e = UI.parseHms($("#fEnd").value);
    const err = $("#fErr");
    if (s === null || e === null) { err.textContent = "時刻は HH:MM:SS の形式で入力してください。"; $("#fStart").focus(); return; }
    if (e - s < Timeline.MIN_DUR) { err.textContent = `終了は開始より ${Timeline.MIN_DUR} 秒以上あとにしてください。`; $("#fEnd").focus(); return; }
    if (s < 0 || e > dur()) { err.textContent = `動画の範囲（00:00:00〜${UI.hms(dur())}）内にしてください。`; return; }
    const prev = list[i - 1], next = list[i + 1];
    if (prev && s < prev.end) { err.textContent = `開始は前の区間${i}（〜${UI.hms(prev.end)}）より後にしてください。`; $("#fStart").focus(); return; }
    if (next && e > next.start) { err.textContent = `終了は次の区間${i + 2}（${UI.hms(next.start)}〜）より前にしてください。`; $("#fEnd").focus(); return; }
    err.textContent = "";

    const before = Store.clone(list);
    const w = Store.clone(list);
    w[i].start = s; w[i].end = e;
    w[i].job_no = $("#fJob").value.trim() || "-";
    w[i].page = $("#fPage").value.trim() || "-";
    w[i].title = $("#fTitle").value.trim() || "（無題）";
    Store.commit(w, { base: before });
    view.formDirty = false;
    renderAll();
    UI.toast("変更を確定しました。", null, { label: "元に戻す", run: () => { Store.undo(); renderAll(); } });
  }

  /* ---------- 分割・削除 ---------- */
  async function splitAtPlayhead() {
    const list = segs(); const i = activeIndex();
    if (i < 0) { UI.toast("再生位置が区間の中にありません。", "warn"); return; }
    const sg = list[i]; const t = Math.round(view.time);
    if (t - sg.start < Timeline.MIN_DUR || sg.end - t < Timeline.MIN_DUR) {
      UI.toast(`区間の端から ${Timeline.MIN_DUR} 秒以上離れた位置で分割してください。`, "warn"); return;
    }
    const before = Store.clone(list);
    const w = Store.clone(list);
    const second = Object.assign({}, w[i], { id: "n" + Date.now().toString(36), start: t });
    w[i].end = t;
    w.splice(i + 1, 0, second);
    Store.commit(w, { base: before });
    select(i + 1);
    UI.toast(`${UI.hms(t)} で分割しました。区間${i + 2}のタイトルを修正してください。`, null,
      { label: "元に戻す", run: () => { Store.undo(); renderAll(); } });
  }

  async function deleteSeg() {
    const list = segs(); const i = view.selected; const sg = list[i];
    if (list.length <= 1) { UI.toast("最後の1区間は削除できません。", "warn"); return; }
    const absorb = i > 0 ? `前の区間${i}` : `次の区間${2}`;
    const ok = await UI.confirmBox(
      `区間${i + 1}「${sg.title}」を削除しますか？`,
      `${UI.hms(sg.start)}–${UI.hms(sg.end)}（${Math.round(sg.end - sg.start)}秒）の時間は${absorb}が引き継ぎ、タイムラインに隙間はできません。`,
      "削除する");
    if (!ok) return;
    const before = Store.clone(list);
    const w = Store.clone(list);
    if (i > 0) w[i - 1].end = w[i].end; else w[i + 1].start = w[i].start;
    w.splice(i, 1);
    Store.commit(w, { base: before });
    view.selected = UI.clamp(i, 0, w.length - 1);
    Store.set("selected", view.selected);
    renderAll();
    UI.toast("区間を削除しました。", null, { label: "元に戻す", run: () => { Store.undo(); renderAll(); } });
  }

  /* ---------- JSON 出力 ---------- */
  function renderOutputCard() {
    const n = undownloaded();
    const badge = $("#dlBadge");
    badge.textContent = n ? `未ダウンロードの修正 ${n}件` : "すべて出力済み";
    badge.className = "badge" + (n ? " warn" : "");
    // primary は常に1つ：未確定入力があるなら「変更を確定」、なければ「JSON出力」
    const btn = $("#dlReviewed");
    btn.className = "btn " + (view.formDirty ? "secondary" : "primary");
    $("#dlHint").textContent = view.formDirty
      ? "先に「変更を確定」を押してください。未確定の入力は出力に含まれません。"
      : "内部ID、モード名、API情報はJSONへ含めません。";
  }
  function toJson(kind) {
    const src = kind === "ai" ? Store.ai() : segs();
    return src.map((s) => ({
      start_time: UI.hms(s.start), end_time: UI.hms(s.end),
      duration_seconds: Math.round(s.end - s.start),
      job_no: s.job_no, page_number: s.page, job_title: s.title,
      work_content: s.work_content, hand_movement: s.hand_movement, tools_and_parts: s.tools_and_parts,
    }));
  }
  function download(kind) {
    const data = JSON.stringify(toJson(kind), null, 2) + "\n";
    const blob = new Blob([data], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `line3_assembly_${kind === "ai" ? "prediction" : "reviewed"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    if (kind !== "ai") { Store.set("downloaded", true); renderAll(); }
    UI.toast(`${kind === "ai" ? "AI予測" : "確認・修正済み"}JSONを出力しました。`);
  }

  /* ---------- ヘッダー / ツール ---------- */
  function renderTools() {
    const u = Store.undoDepth(), r = Store.redoDepth();
    const ub = $("#btnUndo"), rb = $("#btnRedo");
    ub.disabled = !u; rb.disabled = !r;
    ub.textContent = u ? `↶ 元に戻す (${u})` : "↶ 元に戻す";
    rb.textContent = r ? `↷ やり直す (${r})` : "↷ やり直す";
    document.querySelectorAll("[data-zoom]").forEach((b) =>
      b.setAttribute("aria-pressed", String(Number(b.dataset.zoom) === view.zoom)));
  }

  function renderAll() {
    renderTransport(); renderList(); renderForm(); renderTools(); renderOutputCard();
    tl.render(); drawScene();
  }

  /* ---------- 起動 ---------- */
  function boot() {
    scene = Scene.create($("#scene"));
    initTimeline();

    $("#playBtn").addEventListener("click", togglePlay);
    $("#backBtn").addEventListener("click", () => seek(view.time - 1));
    $("#fwdBtn").addEventListener("click", () => seek(view.time + 1));
    $("#btnSplit").addEventListener("click", splitAtPlayhead);
    $("#btnUndo").addEventListener("click", () => { if (Store.undo()) { view.formDirty = false; renderAll(); } });
    $("#btnRedo").addEventListener("click", () => { if (Store.redo()) { view.formDirty = false; renderAll(); } });
    $("#dlAi").addEventListener("click", () => download("ai"));
    $("#dlReviewed").addEventListener("click", () => download("reviewed"));
    $("#btnReset").addEventListener("click", async () => {
      if (await UI.confirmBox("モックを初期状態に戻しますか？", "すべての修正が破棄され、AI予測の状態へ戻ります。", "初期化する")) {
        Store.reset(); view.time = 0; view.selected = 0; view.zoom = 1; view.formDirty = false; renderAll();
        UI.toast("初期状態に戻しました。");
      }
    });
    document.querySelectorAll("[data-zoom]").forEach((b) =>
      b.addEventListener("click", () => {
        view.zoom = Number(b.dataset.zoom); Store.set("zoom", view.zoom);
        renderTools(); tl.render(); tl.scrollToPlayhead();
      }));

    // グローバルのキーボードショートカット
    document.addEventListener("keydown", (e) => {
      if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowLeft" && !e.target.closest(".tl-handle")) { e.preventDefault(); seek(view.time - (e.shiftKey ? 5 : 1)); }
      else if (e.key === "ArrowRight" && !e.target.closest(".tl-handle")) { e.preventDefault(); seek(view.time + (e.shiftKey ? 5 : 1)); }
      else if (e.key === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (Store.undo()) { view.formDirty = false; renderAll(); } }
      else if (e.key === "y" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (Store.redo()) { view.formDirty = false; renderAll(); } }
    });

    window.addEventListener("resize", () => tl.render());
    renderAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.__app = { view, seek, select, splitAtPlayhead, deleteSeg, applyForm, download, renderAll };
})();
