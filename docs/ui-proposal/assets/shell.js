/* ===== 提案モック — 共通UIヘルパー ===== */
window.UI = (function () {
  const pad = (n) => String(n).padStart(2, "0");

  /** 秒 → "HH:MM:SS" */
  function hms(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
  }
  /** 秒 → 目盛り用の短い表記 "M:SS" / "H:MM:SS" */
  function tick(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  /** "HH:MM:SS" → 秒（不正なら null） */
  function parseHms(v) {
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(String(v).trim())) return null;
    const [h, m, s] = String(v).trim().split(":").map(Number);
    if (m > 59 || s > 59) return null;
    return h * 3600 + m * 60 + s;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (v) => String(v).replace(/[&<>'"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));

  /** 動画長に応じた目盛り刻み（主・副）を選ぶ */
  function tickStep(duration, pxPerSec) {
    const CAND = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const minPx = 74;                       // ラベルが重ならない最小間隔
    for (const c of CAND) if (c * pxPerSec >= minPx) return { major: c, minor: c / (c % 2 === 0 ? 2 : 1) };
    const last = CAND[CAND.length - 1];
    return { major: last, minor: last / 2 };
  }

  function toast(msg, type, action) {
    let wrap = document.querySelector(".toast-wrap");
    if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
    const t = document.createElement("div");
    t.className = "toast" + (type ? " " + type : "");
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = action.label;
      b.addEventListener("click", () => { action.run(); t.remove(); });
      t.appendChild(b);
    }
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.transition = "opacity .3s"; t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    }, action ? 6000 : 3000);
    return t;
  }

  function modal(html) {
    const back = document.createElement("div");
    back.className = "backdrop";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
    const first = back.querySelector("input, button");
    if (first && first.focus) first.focus();
    return { el: back, close };
  }

  /** 確認ダイアログ（Promise）。ネイティブ confirm を使わない */
  function confirmBox(title, body, okLabel) {
    return new Promise((resolve) => {
      const m = modal(`<h3>${esc(title)}</h3><p class="muted" style="font-size:13px">${esc(body)}</p>
        <div class="actions">
          <button class="btn secondary" data-close type="button">キャンセル</button>
          <button class="btn primary" id="mkOk" type="button">${esc(okLabel || "実行")}</button>
        </div>`);
      m.el.querySelector("#mkOk").addEventListener("click", () => { m.close(); resolve(true); });
      m.el.addEventListener("click", (e) => { if (e.target === m.el) resolve(false); });
      m.el.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => resolve(false)));
    });
  }

  return { hms, tick, parseHms, clamp, esc, tickStep, toast, modal, confirmBox };
})();
