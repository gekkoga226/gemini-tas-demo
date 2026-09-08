/* ===== UI改善提案モック — 受け入れシナリオ検証 =====
   ページが「読み込めるか」ではなく、実際のドラッグ・クリック・キー操作を駆動して
   Store の状態と DOM を検証する。SPEC.md の S1〜S10 に対応。

   実行（jsdom を解決できるディレクトリを cwd にすること）:
     npm i --no-save jsdom
     node <このファイル>
*/
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ハーネスの場所は環境変数で上書きできる（既定は ~/.claude/skills/...）
const HARNESS = process.env.MOCK_HARNESS ||
  path.join(os.homedir(), ".claude", "skills", "building-operable-html-mocks", "scripts", "scenario-harness.mjs");
const { makeHarness } = await import(pathToFileURL(HARNESS).href);

const MOCK = path.dirname(fileURLToPath(import.meta.url));
const h = await makeHarness(MOCK);

let ok = 0, bad = 0;
const A = (cond, msg) => cond ? (ok++, console.log("  ✓ " + msg))
                              : (bad++, console.log("  ✗ FAIL: " + msg));
const hd = (s) => console.log("\n" + s);

/** 毎回まっさらな状態でページを開く */
async function fresh() {
  let p = await h.load("workspace.html");
  p.window.Store.reset();
  p = await h.load("workspace.html");
  return p;
}
/** pointer 系イベントでハンドルをドラッグする */
function pdrag(w, el, fromX, toX) {
  const mk = (type, x) => new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 60, button: 0 });
  el.dispatchEvent(mk("pointerdown", fromX));
  w.dispatchEvent(mk("pointermove", toX));
  w.dispatchEvent(mk("pointerup", toX));
}
const xOf = (sec) => (sec / 600) * 900;          // harness の rect は width 900
/** 隙間・重複・総時間の不変条件 */
function invariants(segs, duration) {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  let gaps = 0, overlaps = 0, tooShort = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].end < sorted[i + 1].start) gaps++;
    if (sorted[i].end > sorted[i + 1].start) overlaps++;
  }
  for (const s of sorted) if (s.end - s.start < 1) tooShort++;
  const covers = sorted[0].start === 0 && sorted[sorted.length - 1].end === duration;
  return { gaps, overlaps, tooShort, covers };
}

/* ---------- S1 境界リップル ---------- */
hd("S1 境界リップル：区間②③の境界をドラッグ");
{
  const { window: w, $$, errors } = await fresh();
  const before = w.Store.reviewed();
  const handles = $$(".tl-handle");
  A(handles.length === before.length + 1, `境界ハンドルが ${before.length + 1} 個（区間数+1）ある: ${handles.length}`);

  // handles[0]=外側開始, handles[1+i]=segs[i] と segs[i+1] の境界
  pdrag(w, handles[1], xOf(42), xOf(60));        // 区間①②の境界 42s → 60s
  const after = w.Store.reviewed();
  A(after[0].end === after[1].start, `①end と ②start が一致: ${after[0].end} / ${after[1].start}`);
  A(after[0].end === 60, `狙った 60 秒へ移動: ${after[0].end}`);
  A(after[1].end === before[1].end && after[2].start === before[2].start, "隣接2区間以外は動いていない");
  const inv = invariants(after, 600);
  A(inv.gaps === 0 && inv.overlaps === 0, `隙間0・重複0（gaps=${inv.gaps} overlaps=${inv.overlaps}）`);
  A(inv.covers, "動画全長を隙間なく覆っている");
  A(errors.length === 0, "JSエラーなし");
}

/* ---------- S2 クランプ ---------- */
hd("S2 クランプ：隣の区間を潰す方向へ引いても最低1秒を保つ");
{
  const { window: w, $$ } = await fresh();
  const handles = $$(".tl-handle");
  // 区間③(95-98s, 3秒) と 区間④ の境界を、左端を大きく越えて引く
  pdrag(w, handles[3], xOf(98), xOf(0));
  const s = w.Store.reviewed();
  A(s[2].end - s[2].start >= 1, `区間③が最低1秒を保持: ${s[2].end - s[2].start}秒`);
  A(s[2].end === s[3].start, "境界の連動は維持されている");
  const inv = invariants(s, 600);
  A(inv.tooShort === 0, "1秒未満の区間が発生していない");
  A(inv.gaps === 0 && inv.overlaps === 0, "隙間0・重複0");
}

/* ---------- S3 永続化 ---------- */
hd("S3 永続化：編集がリロードをまたいで残る");
{
  const { window: w, $$ } = await fresh();
  pdrag(w, $$(".tl-handle")[1], xOf(42), xOf(70));
  const moved = w.Store.reviewed()[0].end;
  A(moved === 70, `編集直後の値: ${moved}`);
  const p2 = await h.load("workspace.html");
  A(p2.window.Store.reviewed()[0].end === 70, `リロード後も保持: ${p2.window.Store.reviewed()[0].end}`);
}

/* ---------- S4 Undo 多段 ---------- */
hd("S4 Undo：3回編集して3回戻すと初期状態に一致する");
{
  const { window: w, $$ } = await fresh();
  const origin = JSON.stringify(w.Store.ai());
  pdrag(w, $$(".tl-handle")[2], xOf(95), xOf(120));
  pdrag(w, $$(".tl-handle")[3], xOf(98), xOf(150));
  pdrag(w, $$(".tl-handle")[4], xOf(150), xOf(170));
  A(w.Store.undoDepth() === 3, `undo が3段積まれている: ${w.Store.undoDepth()}`);
  A(w.Store.editedCount() > 0, "修正件数が計上されている");
  w.Store.undo(); w.Store.undo(); w.Store.undo();
  A(JSON.stringify(w.Store.reviewed()) === origin, "3回のUndoでAI予測の初期状態に完全一致");
  A(w.Store.redoDepth() === 3, `redo が3段積まれている: ${w.Store.redoDepth()}`);
  w.Store.redo();
  A(w.Store.editedCount() > 0, "Redo で修正が戻る");
}

/* ---------- S5 未DL件数 ---------- */
hd("S5 未ダウンロード件数：修正した区間数と一致する");
{
  const { window: w, $$ } = await fresh();
  A(w.Store.editedCount() === 0, "初期状態の修正件数は0");
  pdrag(w, $$(".tl-handle")[2], xOf(95), xOf(130));   // 区間②③の2本が変わる
  A(w.Store.editedCount() === 2, `境界移動で2区間が修正扱い: ${w.Store.editedCount()}`);
  A(w.document.querySelector("#editedCount").textContent.includes("2"), "画面の「修正 N件」に反映される");
  A(w.document.querySelector("#dlBadge").textContent.includes("2"), "「未ダウンロードの修正 N件」に反映される");
  w.Store.set("downloaded", true);
  w.__app.renderAll();
  A(w.document.querySelector("#dlBadge").textContent.includes("すべて出力済み"), "出力後は「すべて出力済み」になる");
}

/* ---------- S6 分割 ---------- */
hd("S6 分割：再生位置で区間を2つに割る");
{
  const { window: w, $ } = await fresh();
  const n0 = w.Store.reviewed().length;
  w.__app.seek(20);                       // 区間①(0-42s) の途中
  $("#btnSplit").click();
  const s = w.Store.reviewed();
  A(s.length === n0 + 1, `区間数が1つ増えた: ${n0} → ${s.length}`);
  A(s[0].end === 20 && s[1].start === 20, `20秒で分割: ${s[0].end} / ${s[1].start}`);
  const inv = invariants(s, 600);
  A(inv.gaps === 0 && inv.overlaps === 0 && inv.covers, "分割後も隙間0・重複0・全長を維持");
  // 配列長が変わっても差分件数が破綻しないこと（分割で生まれた2区間だけが修正扱い）
  A(w.Store.editedCount() === 2, `分割で修正扱いになるのは2区間だけ: ${w.Store.editedCount()}`);
  A(w.document.querySelector("#editedCount").textContent.includes("2"), "画面表示も「修正 2件」");
}

/* ---------- S7 削除吸収 ---------- */
hd("S7 削除：隣接区間が時間を引き継ぎ、隙間ができない");
{
  const { window: w } = await fresh();
  const before = w.Store.reviewed();
  const n0 = before.length;
  const target = before[3];
  w.__app.select(3);
  const pending = w.__app.deleteSeg();    // 確認モーダルが開く（ネイティブ confirm は使わない）
  A(!!w.document.querySelector(".backdrop"), "削除前に確認モーダルが表示される");
  A(w.document.querySelector(".backdrop").textContent.includes("引き継ぎ"), "「隣が時間を引き継ぐ」と明示している");
  w.document.querySelector("#mkOk").click();
  await pending;
  const s = w.Store.reviewed();
  A(s.length === n0 - 1, `区間数が1つ減った: ${n0} → ${s.length}`);
  A(s[2].end === target.end, `前の区間が終了時刻を引き継いだ: ${s[2].end} = ${target.end}`);
  const inv = invariants(s, 600);
  A(inv.gaps === 0 && inv.overlaps === 0 && inv.covers, "削除後も隙間0・重複0・全長を維持");
  A(w.Store.editedCount() === 1, `削除で修正扱いになるのは吸収した1区間だけ: ${w.Store.editedCount()}`);
}

/* ---------- S8 リセット ---------- */
hd("S8 リセット：SEED と完全一致に戻る");
{
  const { window: w, $$ } = await fresh();
  pdrag(w, $$(".tl-handle")[2], xOf(95), xOf(130));
  A(w.Store.editedCount() > 0, "修正がある状態を作った");
  w.Store.reset();
  const p2 = await h.load("workspace.html");
  A(JSON.stringify(p2.window.Store.reviewed()) === JSON.stringify(p2.window.Store.ai()), "reset で AI予測と完全一致");
  A(p2.window.Store.editedCount() === 0, "修正件数が0に戻る");
  A(p2.window.Store.undoDepth() === 0, "Undo履歴も消える");
}

/* ---------- S9 ズーム ---------- */
hd("S9 ズーム：内部幅が倍率どおりに変わる");
{
  const { window: w, $ } = await fresh();
  const inner = $("[data-tl-inner]");
  A(inner.style.width === "100%", `1x の内部幅: ${inner.style.width}`);
  w.document.querySelector('[data-zoom="8"]').click();
  A(inner.style.width === "800%", `8x の内部幅: ${inner.style.width}`);
  A(w.document.querySelector('[data-zoom="8"]').getAttribute("aria-pressed") === "true", "aria-pressed が切り替わる");
  A(w.document.querySelector('[data-zoom="1"]').getAttribute("aria-pressed") === "false", "他の倍率は false になる");
}

/* ---------- S10 キーボード ---------- */
hd("S10 キーボード：境界ハンドルを ← → で動かせる");
{
  const { window: w, $$ } = await fresh();
  const handles = $$(".tl-handle");
  const b = handles[2];
  A(b.getAttribute("role") === "slider", "role=slider が付いている");
  A(b.getAttribute("tabindex") === "0", "tabindex=0 でフォーカスできる");
  A(!!b.getAttribute("aria-label"), `aria-label: ${b.getAttribute("aria-label")}`);
  A(b.getAttribute("aria-valuenow") === "95", `aria-valuenow: ${b.getAttribute("aria-valuenow")}`);
  A(!!b.getAttribute("aria-valuemin") && !!b.getAttribute("aria-valuemax"), "aria-valuemin / valuemax がある");

  // ハンドルは毎回再描画されるので、押すたびに引き直す
  const press = (idx, k, shift) => $$(".tl-handle")[idx]
    .dispatchEvent(new w.KeyboardEvent("keydown", { key: k, shiftKey: !!shift, bubbles: true, cancelable: true }));

  press(2, "ArrowLeft");
  A(w.Store.reviewed()[1].end === 94, `← で1秒戻る: ${w.Store.reviewed()[1].end}`);

  // 区間③は 3秒しかないため、→ を続けても最低1秒の手前（97秒）で止まる
  press(2, "ArrowRight", true);
  A(w.Store.reviewed()[1].end === 97, `Shift+→ も可動端 97秒でクランプ: ${w.Store.reviewed()[1].end}`);
  A(w.Store.reviewed()[2].end - w.Store.reviewed()[2].start === 1, "隣の短区間は1秒を保つ");
  A(w.Store.reviewed()[1].end === w.Store.reviewed()[2].start, "キー操作でも境界は連動する");

  // 余裕のある境界では 5秒ぶんきちんと動く
  press(1, "ArrowRight", true);
  A(w.Store.reviewed()[0].end === 47, `余裕があれば Shift+→ で5秒進む: ${w.Store.reviewed()[0].end}`);
  press(1, "Home");
  const lo = Number($$(".tl-handle")[1].getAttribute("aria-valuemin"));
  A(w.Store.reviewed()[0].end === 1, `Home で可動下限へ: ${w.Store.reviewed()[0].end}（valuemin=${lo}）`);
}

/* ---------- 追加：アクセシビリティの静的確認 ---------- */
hd("A11y：フォーカス順・ラベル・最小サイズ");
{
  const { window: w, $$, $ } = await fresh();
  const order = $$("button, input, [tabindex='0']").map((e) => e.id || e.className.split(" ")[0]);
  const i02 = order.findIndex((x) => x === "playBtn");
  const i03 = order.findIndex((x) => x === "btnSplit");
  const i04 = order.findIndex((x) => x === "dlAi");
  A(i02 < i03 && i03 < i04, `Tab順が 02→03→04 の並び（${i02} < ${i03} < ${i04}）`);
  A($$(".tl-bar").every((b) => b.getAttribute("aria-label")), "全区間バーに aria-label がある");
  A($$(".tl-handle").every((b) => b.getAttribute("aria-valuetext")), "全境界ハンドルに aria-valuetext がある");
  A($("#scene").getAttribute("aria-label") !== null, "canvas に aria-label がある");
}

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
