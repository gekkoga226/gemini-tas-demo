import test from "node:test";
import assert from "node:assert/strict";
import { memoAfterSave, memoIsUnsaved, unsavedState } from "../public/unsaved-state.js";

const edit = { dirty: false, formDirty: false, hasResult: true };

test("nothing edited and an empty memo is clean", () => {
  assert.deepEqual(unsavedState({ ...edit, memoText: "" }), { edits: false, memo: false, any: false, badgeClass: "clean", badgeText: "変更なし" });
});

test("a memo alone counts as unsaved and the badge says メモ未保存", () => {
  assert.deepEqual(unsavedState({ ...edit, memoText: "部品待ちを確認。" }), { edits: false, memo: true, any: true, badgeClass: "dirty", badgeText: "メモ未保存" });
});

test("blanks around a memo, or blanks only, are ignored (compared without leading and trailing whitespace)", () => {
  assert.equal(memoIsUnsaved("  部品待ち  "), true);
  assert.equal(memoIsUnsaved(" \n\t　 "), false);
  assert.equal(unsavedState({ ...edit, memoText: " \n　" }).any, false);
});

test("a missing memo is treated as empty", () => {
  assert.equal(memoIsUnsaved(undefined), false);
  assert.equal(memoIsUnsaved(null), false);
  assert.equal(unsavedState({ ...edit }).badgeText, "変更なし");
});

test("segment edits alone keep their existing badge wording", () => {
  assert.equal(unsavedState({ dirty: true, formDirty: false, memoText: "" }).badgeText, "履歴に未保存");
  assert.equal(unsavedState({ dirty: false, formDirty: true, memoText: "" }).badgeText, "区間に未反映（保存時に検証・反映）");
  assert.equal(unsavedState({ dirty: true, formDirty: true, memoText: "" }).badgeText, "区間に未反映（保存時に検証・反映）");
  assert.deepEqual(unsavedState({ dirty: true, formDirty: false, memoText: "" }), { edits: true, memo: false, any: true, badgeClass: "dirty", badgeText: "履歴に未保存" });
  assert.deepEqual(unsavedState({ dirty: false, formDirty: true, memoText: "" }), { edits: true, memo: false, any: true, badgeClass: "dirty", badgeText: "区間に未反映（保存時に検証・反映）" });
});

test("edits and a memo together show both on the badge", () => {
  assert.equal(unsavedState({ dirty: true, formDirty: false, memoText: "メモ", hasResult: true }).badgeText, "履歴に未保存・メモ未保存");
  assert.equal(unsavedState({ dirty: false, formDirty: true, memoText: "メモ", hasResult: true }).badgeText, "区間に未反映（保存時に検証・反映）・メモ未保存");
  assert.deepEqual(unsavedState({ dirty: true, formDirty: false, memoText: "メモ", hasResult: true }), { edits: true, memo: true, any: true, badgeClass: "dirty", badgeText: "履歴に未保存・メモ未保存" });
});

test("text left in the memo field while no result is open is not unsaved, because nothing can receive it", () => {
  assert.deepEqual(unsavedState({ ...edit, memoText: "残ってしまったメモ", hasResult: false }), { edits: false, memo: false, any: false, badgeClass: "clean", badgeText: "変更なし" });
  assert.equal(unsavedState({ ...edit, memoText: "残ってしまったメモ", hasResult: undefined }).any, false);
});

test("after a save the saved part leaves the field and only text typed during the save remains", () => {
  assert.equal(memoAfterSave("部品待ち", "部品待ち"), "");
  assert.equal(memoAfterSave("部品待ち", "部品待ち（追記）"), "（追記）");
  assert.equal(memoAfterSave("", "保存中に書いた"), "保存中に書いた");
  assert.equal(memoAfterSave("  ", "  "), "");
});

test("a memo changed in any other way during the save is kept whole so nothing is lost", () => {
  assert.equal(memoAfterSave("部品待ち", "先頭に足した部品待ち"), "先頭に足した部品待ち");
  assert.equal(memoAfterSave("部品待ち", "部品"), "部品");
  assert.equal(memoAfterSave("部品待ち", ""), "");
});

test("memoAfterSave treats missing text as empty", () => {
  assert.equal(memoAfterSave(undefined, undefined), "");
  assert.equal(memoAfterSave(null, "abc"), "abc");
  assert.equal(memoAfterSave("abc", null), "");
  assert.equal(memoAfterSave(undefined, "undefined と書いた"), "undefined と書いた");
  assert.equal(memoAfterSave(null, "null と書いた"), "null と書いた");
});
