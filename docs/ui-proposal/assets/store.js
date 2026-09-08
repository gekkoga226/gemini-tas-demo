/* ===== 提案モック — 共有ストア =====
   SEED（AI予測の原本、不変）＋ localStorage の差分。
   読み書きはすべてここを通す。リロードしても編集が残る。 */
window.Store = (function () {
  const KEY = "tas_proposal_v1";
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  let d = load();
  d.reviewed = d.reviewed || null;   // null = 未編集（SEED.ai と同一）
  d.misc     = d.misc     || {};
  d.undo     = d.undo     || [];
  d.redo     = d.redo     || [];
  function persist() { localStorage.setItem(KEY, JSON.stringify(d)); }

  const UNDO_DEPTH = 20;

  // ---- 読み取り ----
  function ai() { return SEED.ai.map(clone); }
  function reviewed() { return d.reviewed ? d.reviewed.map(clone) : ai(); }
  function duration() { return SEED.duration; }

  /* AI予測との差分判定。
     区間の分割・削除で配列長が変わっても正しく数えられるよう、
     位置ではなく「内容がAI予測のどれかと完全一致するか」で判定する。
     id は分割時に新規採番されるため比較から除く。 */
  function keyOf(s) {
    return JSON.stringify([s.start, s.end, s.job_no, s.page, s.title,
                           s.work_content, s.hand_movement, s.tools_and_parts]);
  }
  function aiKeys() { return new Set(SEED.ai.map(keyOf)); }

  /** AI予測に一致しない（＝人が手を入れた）区間の数 */
  function editedCount() {
    const keys = aiKeys();
    return reviewed().filter((s) => !keys.has(keyOf(s))).length;
  }
  function isEdited(i) {
    const r = reviewed()[i];
    return r ? !aiKeys().has(keyOf(r)) : true;
  }

  // ---- 書き込み（すべて undo スタックを積む） ----
  /** opts.base を渡すと、その状態を undo 履歴に積む。
      ドラッグ中に preview() で暫定表示した場合に、開始前の状態へ正しく戻すため。 */
  function commit(next, opts) {
    const base = opts && opts.base ? opts.base : (d.reviewed || ai());
    d.undo.push(clone(base));
    if (d.undo.length > UNDO_DEPTH) d.undo.shift();
    d.redo = [];
    d.reviewed = clone(next);
    if (!opts || !opts.keepDownloaded) d.misc.downloaded = false;
    persist();
  }
  /** ドラッグ中など、履歴を積まずに現在値だけ差し替える */
  function preview(next) { d.reviewed = clone(next); persist(); }

  function canUndo() { return d.undo.length > 0; }
  function canRedo() { return d.redo.length > 0; }
  function undoDepth() { return d.undo.length; }
  function redoDepth() { return d.redo.length; }
  function undo() {
    if (!d.undo.length) return false;
    d.redo.push(clone(d.reviewed || ai()));
    d.reviewed = d.undo.pop();
    d.misc.downloaded = false; persist(); return true;
  }
  function redo() {
    if (!d.redo.length) return false;
    d.undo.push(clone(d.reviewed || ai()));
    d.reviewed = d.redo.pop();
    d.misc.downloaded = false; persist(); return true;
  }

  // ---- 汎用キー ----
  function get(k, fb) { return k in d.misc ? clone(d.misc[k]) : fb; }
  function set(k, v) { d.misc[k] = clone(v); persist(); }

  function reset() {
    localStorage.removeItem(KEY);
    d = { reviewed: null, misc: {}, undo: [], redo: [] };
    persist();
  }

  return { ai, reviewed, duration, editedCount, isEdited, commit, preview,
           undo, redo, canUndo, canRedo, undoDepth, redoDepth, get, set, reset, clone };
})();
