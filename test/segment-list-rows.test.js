import test from "node:test";
import assert from "node:assert/strict";
import { listRows, rowKey } from "../public/segment-list-rows.js";

const seg = (n) => ({ segment_id: `s${n}` });
const six = [1, 2, 3, 4, 5, 6].map(seg);
const flaggedAt = (...indexes) => (index) => indexes.includes(index);
const review = (overrides) => listRows({ segments: six, filter: "review", isFlagged: flaggedAt(2, 4), selected: 0, pins: null, ...overrides });

test("すべて lists every segment in order", () => {
  assert.deepEqual(listRows({ segments: six, filter: "all", isFlagged: flaggedAt(2), selected: 0, pins: null }).indexes, [0, 1, 2, 3, 4, 5]);
});

test("要確認だけ right after opening lists the flagged segments plus the selected one, in order", () => {
  assert.deepEqual(review().indexes, [0, 2, 4]);
});

test("choosing another row does not add or remove any row, so the pressed row stays under the pointer (R3)", () => {
  const opened = review();
  const afterPress = review({ selected: 2, pins: opened.pins });
  assert.deepEqual(afterPress.indexes, [0, 2, 4]);
  assert.deepEqual(review({ selected: 4, pins: afterPress.pins }).indexes, [0, 2, 4]);
});

test("a segment chosen on the time bar that was not listed is added alone and stays after choosing another row", () => {
  const opened = review();
  const added = review({ selected: 1, pins: opened.pins });
  assert.deepEqual(added.indexes, [0, 1, 2, 4]);
  assert.deepEqual(review({ selected: 4, pins: added.pins }).indexes, [0, 1, 2, 4]);
});

test("choosing the filter again drops the extra rows and decides the list anew", () => {
  const added = review({ selected: 1, pins: review().pins });
  assert.deepEqual(review({ selected: 4, pins: null }).indexes, [2, 4]);
  assert.deepEqual(review({ selected: 1, pins: added.pins }).indexes, [0, 1, 2, 4]);
});

test("a row that stops being flagged after an edit stays listed until the list is decided again", () => {
  const opened = review({ selected: 2 });
  assert.deepEqual(review({ isFlagged: flaggedAt(4), selected: 2, pins: opened.pins }).indexes, [2, 4]);
});

test("a segment that becomes flagged shows up even though it was not listed before", () => {
  const opened = review({ selected: 2 });
  assert.deepEqual(review({ isFlagged: flaggedAt(1, 2, 4), selected: 2, pins: opened.pins }).indexes, [1, 2, 4]);
});

test("listed rows follow the segment id when editing re-sorts the segments", () => {
  const before = [1, 2, 3].map(seg);
  const opened = listRows({ segments: before, filter: "review", isFlagged: flaggedAt(2), selected: 0, pins: null });
  assert.deepEqual(opened.indexes, [0, 2]);
  const resorted = [seg(2), seg(1), seg(3)];
  assert.deepEqual(listRows({ segments: resorted, filter: "review", isFlagged: flaggedAt(2), selected: 1, pins: opened.pins }).indexes, [1, 2]);
});

test("the input pins are never changed in place", () => {
  const opened = review();
  const snapshot = [...opened.pins];
  review({ selected: 1, pins: opened.pins });
  assert.deepEqual([...opened.pins], snapshot);
});

test("no segments, or a selection outside the list, lists nothing extra", () => {
  assert.deepEqual(listRows({ segments: [], filter: "review", isFlagged: flaggedAt(), selected: 0, pins: null }).indexes, []);
  assert.deepEqual(review({ isFlagged: flaggedAt(2), selected: -1 }).indexes, [2]);
});

test("a segment without an id is keyed by its position instead", () => {
  assert.equal(rowKey({ segment_id: "human-1" }, 3), "human-1");
  assert.equal(rowKey({}, 3), "#3");
  const noIds = [{}, {}, {}];
  const opened = listRows({ segments: noIds, filter: "review", isFlagged: flaggedAt(2), selected: 0, pins: null });
  assert.deepEqual(listRows({ segments: noIds, filter: "review", isFlagged: flaggedAt(2), selected: 2, pins: opened.pins }).indexes, [0, 2]);
});
