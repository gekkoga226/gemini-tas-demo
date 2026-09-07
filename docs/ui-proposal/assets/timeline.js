/* ===== 提案モック — タイムライン本体 =====
   改善の中核。実装している挙動：
   ・時間目盛り（動画長に応じて刻みを自動選択）
   ・AI予測／確認・修正結果の 2レーン同時表示
   ・区間番号を第一識別子に（色は補助）
   ・ラベル 3段階適応（全文 / 番号のみ / ◆マーカー）
   ・境界リップル編集：隣接する2区間が連動し、クランプで不正状態が発生しない
   ・境界ハンドルはキーボード操作可（←→1秒 / Shift+←→5秒 / Home・End）
   ・選択=▼＋番号反転 / 再生=時刻バブル / フォーカス=破線（3状態を形状で分離） */
window.Timeline = (function () {
  const MIN_DUR = 1;          // 区間の最小長（秒）
  const TINY_PX = 12;         // これ未満は ◆ マーカー
  const NARROW_PX = 62;       // これ未満は番号のみ

  function create(opts) {
    const root = opts.root;
    root.innerHTML = `
      <div class="tl-wrap">
        <div class="tl-gutter">
          <div class="g-ruler"></div>
          <div class="g-lane ai">AI予測<small>原本</small></div>
          <div class="g-lane">確認・修正<small>編集可</small></div>
        </div>
        <div class="tl-scroll" data-tl-scroll>
          <div class="tl-inner" data-tl-inner>
            <div class="tl-ruler" data-tl-ruler></div>
            <div class="tl-lane ai" data-lane-ai></div>
            <div class="tl-lane rv" data-lane-rv></div>
            <div class="tl-play" data-tl-play><span class="bub" data-tl-bub>00:00:00</span></div>
          </div>
        </div>
      </div>`;

    const scroll = root.querySelector("[data-tl-scroll]");
    const inner  = root.querySelector("[data-tl-inner]");
    const ruler  = root.querySelector("[data-tl-ruler]");
    const laneAi = root.querySelector("[data-lane-ai]");
    const laneRv = root.querySelector("[data-lane-rv]");
    const play   = root.querySelector("[data-tl-play]");
    const bub    = root.querySelector("[data-tl-bub]");

    let st = opts.getState();
    let dragging = null;

    const pct = (sec) => (sec / st.duration) * 100;
    const innerPx = () => {
      const w = inner.getBoundingClientRect().width;
      return w > 0 ? w : 900;                       // jsdom（レイアウトなし）対策
    };
    const secAtClientX = (clientX) => {
      const r = inner.getBoundingClientRect();
      const w = r.width > 0 ? r.width : 900;
      return UI.clamp(((clientX - r.left) / w) * st.duration, 0, st.duration);
    };

    /* ---------- 境界の記述子 ---------- */
    function boundaries(segs) {
      const out = [];
      if (!segs.length) return out;
      out.push({ kind: "outerStart", i: 0, at: segs[0].start });
      for (let i = 0; i < segs.length - 1; i++) {
        if (Math.abs(segs[i].end - segs[i + 1].start) < 0.0001) {
          out.push({ kind: "boundary", i, at: segs[i].end });
        } else {
          out.push({ kind: "edgeEnd", i, at: segs[i].end });
          out.push({ kind: "edgeStart", i: i + 1, at: segs[i + 1].start });
        }
      }
      out.push({ kind: "outerEnd", i: segs.length - 1, at: segs[segs.length - 1].end });
      return out;
    }
    /** その境界が動ける範囲。クランプするので不正状態にならない＝エラーが出ない */
    function range(b, segs) {
      switch (b.kind) {
        case "outerStart": return [0, segs[0].end - MIN_DUR];
        case "outerEnd":   return [segs[segs.length - 1].start + MIN_DUR, st.duration];
        case "boundary":   return [segs[b.i].start + MIN_DUR, segs[b.i + 1].end - MIN_DUR];
        case "edgeEnd":    return [segs[b.i].start + MIN_DUR, segs[b.i + 1] ? segs[b.i + 1].start : st.duration];
        case "edgeStart":  return [segs[b.i - 1] ? segs[b.i - 1].end : 0, segs[b.i].end - MIN_DUR];
      }
      return [0, st.duration];
    }
    /** 境界を v 秒へ動かす。boundary は前後の区間を同時に更新（リップル） */
    function applyBoundary(b, segs, v) {
      const [lo, hi] = range(b, segs);
      const t = Math.round(UI.clamp(v, lo, hi));
      switch (b.kind) {
        case "outerStart": segs[0].start = t; break;
        case "outerEnd":   segs[segs.length - 1].end = t; break;
        case "boundary":   segs[b.i].end = t; segs[b.i + 1].start = t; break;   // ← 連動
        case "edgeEnd":    segs[b.i].end = t; break;
        case "edgeStart":  segs[b.i].start = t; break;
      }
      return t;
    }
    function labelOf(b, segs) {
      const n = (i) => `区間${i + 1} ${segs[i] ? segs[i].title : ""}`;
      if (b.kind === "boundary") return `${n(b.i)} と ${n(b.i + 1)} の境界`;
      if (b.kind === "outerStart" || b.kind === "edgeStart") return `${n(b.i)} の開始時刻`;
      return `${n(b.i)} の終了時刻`;
    }

    /* ---------- 描画 ---------- */
    function renderRuler() {
      ruler.innerHTML = "";
      const px = innerPx();
      const { major, minor } = UI.tickStep(st.duration, px / st.duration);
      const frag = document.createDocumentFragment();
      for (let s = 0; s <= st.duration + 0.001; s += minor) {
        const isMajor = Math.abs(s % major) < 0.0001;
        const d = document.createElement("div");
        d.className = "tl-tick" + (isMajor ? "" : " minor");
        d.style.left = pct(s) + "%";
        if (isMajor) d.innerHTML = `<span>${UI.tick(s)}</span>`;
        frag.appendChild(d);
      }
      ruler.appendChild(frag);
    }

    function renderBars(lane, segs, editable) {
      lane.innerHTML = "";
      const px = innerPx();
      const frag = document.createDocumentFragment();
      segs.forEach((sg, i) => {
        const dur = sg.end - sg.start;
        const w = (dur / st.duration) * px;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tl-bar" + (w < TINY_PX ? " is-tiny" : w < NARROW_PX ? " is-narrow" : "");
        if (editable && i === st.selected) b.className += " sel";
        if (!editable && i === st.selected) b.className += " sel";
        if (editable && st.isEdited(i)) b.className += " edited";
        b.style.left = pct(sg.start) + "%";
        b.style.width = (dur / st.duration) * 100 + "%";
        b.style.setProperty("--bar", `var(--c${i % 8})`);
        b.style.setProperty("--bar-pale", `var(--p${i % 8})`);
        b.innerHTML = `<span class="num">${i + 1}</span><span class="txt">${UI.esc(sg.title)}</span>`;
        b.setAttribute("aria-label",
          `区間${i + 1} ${sg.title} ${UI.hms(sg.start)}から${UI.hms(sg.end)} ${Math.round(dur)}秒` +
          (editable ? (st.isEdited(i) ? "（修正済み）" : "") : "（AI予測・編集不可）"));
        b.title = `${i + 1}. ${sg.title}\n${UI.hms(sg.start)} – ${UI.hms(sg.end)}（${Math.round(dur)}秒）`;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onSelect(i);
          opts.onSeek(secAtClientX(e.clientX));      // 空白クリックと挙動を統一
        });
        frag.appendChild(b);
      });
      lane.appendChild(frag);
    }

    function renderHandles(segs) {
      const px = innerPx();
      boundaries(segs).forEach((b) => {
        const [lo, hi] = range(b, segs);
        const h = document.createElement("button");
        h.type = "button";
        h.className = "tl-handle" + (b.kind === "outerStart" || b.kind === "outerEnd" ? " outer" : "");
        h.style.left = pct(b.at) + "%";
        h.setAttribute("role", "slider");
        h.setAttribute("tabindex", "0");
        h.setAttribute("aria-label", labelOf(b, segs));
        h.setAttribute("aria-valuemin", String(Math.round(lo)));
        h.setAttribute("aria-valuemax", String(Math.round(hi)));
        h.setAttribute("aria-valuenow", String(Math.round(b.at)));
        h.setAttribute("aria-valuetext", UI.hms(b.at));
        h.title = `${labelOf(b, segs)}\nドラッグ、または ← → で1秒、Shift+← → で5秒`;
        h.addEventListener("pointerdown", (e) => startDrag(e, b));
        h.addEventListener("keydown", (e) => onHandleKey(e, b));
        laneRv.appendChild(h);
      });
    }

    function renderPlayhead() {
      play.style.left = pct(st.time) + "%";
      bub.textContent = UI.hms(st.time);
    }

    function render() {
      st = opts.getState();
      inner.style.width = (st.zoom * 100) + "%";
      renderRuler();
      renderBars(laneAi, st.ai, false);
      renderBars(laneRv, st.reviewed, true);
      renderHandles(st.reviewed);
      renderPlayhead();
    }

    /* ---------- ドラッグ ---------- */
    function startDrag(e, b) {
      e.preventDefault(); e.stopPropagation();
      const before = Store.clone(st.reviewed);
      const work = Store.clone(st.reviewed);
      dragging = { b, before, work };
      e.currentTarget.classList.add("on");
      e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);

      // ツールチップはタイムラインの外（body直下・fixed）へ出す。
      // スクロール領域の中に置くと、編集対象のバーやAIレーンを覆ってしまうため。
      const tip = document.createElement("div");
      tip.className = "tl-tip";
      document.body.appendChild(tip);

      const move = (ev) => {
        const v = applyBoundary(b, work, secAtClientX(ev.clientX));
        tip.textContent = tipText(b, work, v);
        const r = inner.getBoundingClientRect();
        tip.style.position = "fixed";
        tip.style.left = ev.clientX + "px";
        tip.style.top = (r.top - 8) + "px";
        opts.onPreview(work);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        tip.remove();
        dragging = null;
        opts.onCommit(work, before);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    }
    function tipText(b, segs, v) {
      if (b.kind === "boundary")
        return `${UI.hms(v)}　│　区間${b.i + 1}: ${Math.round(segs[b.i].end - segs[b.i].start)}秒 ／ 区間${b.i + 2}: ${Math.round(segs[b.i + 1].end - segs[b.i + 1].start)}秒`;
      return `${UI.hms(v)}　│　${Math.round(segs[b.i].end - segs[b.i].start)}秒`;
    }

    function onHandleKey(e, b) {
      const step = e.shiftKey ? 5 : 1;
      let delta = 0, absolute = null;
      const before = Store.clone(st.reviewed);
      const work = Store.clone(st.reviewed);
      const [lo, hi] = range(b, work);
      if (e.key === "ArrowLeft")  delta = -step;
      else if (e.key === "ArrowRight") delta = step;
      else if (e.key === "Home") absolute = lo;
      else if (e.key === "End")  absolute = hi;
      else return;
      e.preventDefault();
      applyBoundary(b, work, absolute !== null ? absolute : b.at + delta);
      opts.onCommit(work, before);
    }

    /* ---------- 空白クリックでシーク ---------- */
    [laneAi, laneRv, ruler].forEach((el) => {
      el.addEventListener("click", (e) => {
        if (dragging) return;
        if (e.target.closest(".tl-bar") || e.target.closest(".tl-handle")) return;
        opts.onSeek(secAtClientX(e.clientX));
      });
    });

    /** ズーム変更時などに、再生位置を画面内に保つ */
    function scrollToPlayhead() {
      const w = scroll.clientWidth || 0;
      const total = (inner.getBoundingClientRect().width) || 0;
      if (!w || !total) return;
      scroll.scrollLeft = UI.clamp((st.time / st.duration) * total - w / 2, 0, Math.max(0, total - w));
    }

    return { render, scrollToPlayhead, boundaries, range, applyBoundary, MIN_DUR };
  }

  return { create, MIN_DUR };
})();
