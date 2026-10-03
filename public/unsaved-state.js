export function memoIsUnsaved(memoText) {
  return typeof memoText === "string" && memoText.trim() !== "";
}

// 保存のあと、送った分をメモ欄から外す。保存中に末尾へ足した分だけが残り、それ以外の変え方は消さずに残す。
export function memoAfterSave(sentText, currentText) {
  const sent = typeof sentText === "string" ? sentText : "";
  const current = typeof currentText === "string" ? currentText : "";
  return current.startsWith(sent) ? current.slice(sent.length) : current;
}

// 保存のたびにメモ欄は空に戻るので「保存済みのメモ」は常に空。結果が開いている間だけ、欄に空白以外の文字があれば未保存と数える。
export function unsavedState({ dirty, formDirty, memoText, hasResult }) {
  const edits = Boolean(dirty || formDirty);
  const memo = Boolean(hasResult) && memoIsUnsaved(memoText);
  const parts = [];
  if (formDirty) parts.push("区間に未反映（保存時に検証・反映）");
  else if (dirty) parts.push("履歴に未保存");
  if (memo) parts.push("メモ未保存");
  return { edits, memo, any: edits || memo, badgeClass: edits || memo ? "dirty" : "clean", badgeText: parts.length ? parts.join("・") : "変更なし" };
}
