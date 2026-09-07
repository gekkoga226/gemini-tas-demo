/* ===== 提案モック — 疑似映像（canvas） =====
   実MP4を使わずに「動画らしさ」と再生位置の対応を示す。
   描画は time から決定的に導出するので、スクラブしても表示がぶれない。 */
window.Scene = (function () {
  const COLORS = ["#0F6E64", "#1F5FA0", "#8A4A12", "#6A4C93", "#2F6B3A", "#8C3B4A", "#3D5A80", "#7A5C00"];

  function create(canvas) {
    const ctx = canvas.getContext("2d");
    let W = 960, H = 540;
    canvas.width = W; canvas.height = H;

    function draw(time, segIndex, segTitle, duration) {
      if (!ctx || typeof ctx.fillRect !== "function") return;   // jsdom スタブ対策
      const t = time || 0;
      const accent = COLORS[(segIndex >= 0 ? segIndex : 0) % COLORS.length];

      // 背景（作業場の奥行き）
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#1d3330"); g.addColorStop(1, "#0b1817");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

      // 作業台
      ctx.fillStyle = "#26403c"; ctx.fillRect(0, H * 0.62, W, H * 0.38);
      ctx.fillStyle = "#31514c"; ctx.fillRect(0, H * 0.62, W, 6);

      // 奥のラック（時間で流れない静的背景）
      ctx.fillStyle = "rgba(255,255,255,.045)";
      for (let i = 0; i < 6; i++) ctx.fillRect(40 + i * 155, 70, 120, 210);

      // 治具（固定）
      ctx.fillStyle = "#3d5f59";
      ctx.fillRect(W * 0.30, H * 0.50, W * 0.40, 30);
      ctx.fillStyle = "#4d726b";
      ctx.fillRect(W * 0.33, H * 0.46, 16, 40);
      ctx.fillRect(W * 0.65, H * 0.46, 16, 40);

      // 対象部品：区間内の進捗で少しだけ位置と角度が変わる
      const phase = (t % 30) / 30;
      const cx = W * 0.5 + Math.sin(phase * Math.PI * 2) * 26;
      const cy = H * 0.44 + Math.cos(phase * Math.PI * 2) * 10;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.sin(phase * Math.PI * 2) * 0.06);
      ctx.fillStyle = accent;
      ctx.fillRect(-95, -46, 190, 92);
      ctx.fillStyle = "rgba(255,255,255,.20)";
      ctx.fillRect(-95, -46, 190, 14);
      ctx.fillStyle = "rgba(0,0,0,.28)";
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(-64 + i * 43, 24, 7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // 手（区間ごとに位置を変える簡易表現）
      const hx = W * 0.5 + Math.cos(phase * Math.PI * 2 + segIndex) * 120;
      const hy = H * 0.56 + Math.sin(phase * Math.PI * 4) * 12;
      ctx.fillStyle = "rgba(226,205,178,.92)";
      ctx.beginPath(); ctx.ellipse(hx, hy, 40, 24, -0.25, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(W - hx, hy + 8, 36, 22, 0.25, 0, Math.PI * 2); ctx.fill();

      // 下部の情報帯
      ctx.fillStyle = "rgba(6,16,15,.78)";
      ctx.fillRect(0, H - 76, W, 76);
      ctx.fillStyle = accent;
      ctx.fillRect(0, H - 76, 8, 76);

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 30px 'Yu Gothic UI', Meiryo, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const label = segIndex >= 0 ? `${circled(segIndex + 1)} ${segTitle}` : "該当する作業区間なし";
      ctx.fillText(label, 26, H - 46);

      ctx.fillStyle = "#b9cec8";
      ctx.font = "600 22px 'Yu Gothic UI', Meiryo, system-ui, sans-serif";
      ctx.fillText(`${clock(t)} / ${clock(duration)}`, 26, H - 16);

      // グリッド（映像らしさ）
      ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 76); ctx.stroke(); }
    }

    function circled(n) {
      return n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : "(" + n + ")";
    }
    function clock(s) {
      s = Math.max(0, Math.round(s || 0));
      const p = (v) => String(v).padStart(2, "0");
      return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    }

    return { draw };
  }

  return { create, circled: (n) => (n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : "(" + n + ")") };
})();
