import test from "node:test";
import assert from "node:assert/strict";
import { NO_EXAMPLES_NOTE, resultSetLabels, standardNotice } from "../public/result-labels.js";

const set = { name: "標準セットA" };

test("a result that used the お手本 keeps the お手本セット chip and adds no note", () => {
  assert.deepEqual(resultSetLabels({ examplesUsed: true, set, sourceCount: 3 }), { chip: "お手本セット：標準セットA（3本）", note: "" });
});

test("a result that did not use the お手本 but names a set shows 作業名一覧 only, without the お手本セット wording or a video count", () => {
  const labels = resultSetLabels({ examplesUsed: false, set, sourceCount: 3 });
  assert.equal(labels.chip, "作業名一覧：標準セットA");
  assert.ok(!labels.chip.includes("お手本セット"), "must not claim the お手本セット was used");
  assert.ok(!labels.chip.includes("本）"), "must not show how many お手本 videos the set holds");
  assert.equal(labels.note, "お手本（動画・記述・画像）は分析に送っていません。作業名一覧だけを使っています。");
  assert.equal(labels.note, NO_EXAMPLES_NOTE);
});

test("a result without any set shows neither chip nor note", () => {
  assert.deepEqual(resultSetLabels({ examplesUsed: false, set: null, sourceCount: 0 }), { chip: "", note: "" });
  assert.deepEqual(resultSetLabels({ examplesUsed: undefined, set: undefined, sourceCount: 0 }), { chip: "", note: "" });
});

test("a missing examples_used flag is treated as not used", () => {
  assert.equal(resultSetLabels({ examplesUsed: undefined, set, sourceCount: 2 }).chip, "作業名一覧：標準セットA");
});

test("the hidden notice under the お手本 player says the same thing as the visible note", () => {
  assert.equal(standardNotice(false), NO_EXAMPLES_NOTE);
  assert.equal(standardNotice(true), "お手本は公開済みのお手本セットから選んだものです。対象動画のGTは表示しません。");
});
