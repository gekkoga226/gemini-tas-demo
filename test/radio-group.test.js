import test from "node:test";
import assert from "node:assert/strict";
import { nextRadioIndex } from "../public/radio-group.js";

test("ArrowRight and ArrowDown select the next radio and wrap from the last to the first", () => {
  for (const key of ["ArrowRight", "ArrowDown"]) {
    assert.equal(nextRadioIndex(key, 0, 3), 1, `${key} from the first`);
    assert.equal(nextRadioIndex(key, 1, 3), 2, `${key} from the middle`);
    assert.equal(nextRadioIndex(key, 2, 3), 0, `${key} wraps from the last`);
  }
});

test("ArrowLeft and ArrowUp select the previous radio and wrap from the first to the last", () => {
  for (const key of ["ArrowLeft", "ArrowUp"]) {
    assert.equal(nextRadioIndex(key, 2, 3), 1, `${key} from the last`);
    assert.equal(nextRadioIndex(key, 1, 3), 0, `${key} from the middle`);
    assert.equal(nextRadioIndex(key, 0, 3), 2, `${key} wraps from the first`);
  }
});

test("Home selects the first radio and End the last, wherever the focus is", () => {
  for (const current of [0, 1, 2]) {
    assert.equal(nextRadioIndex("Home", current, 3), 0, `Home from ${current}`);
    assert.equal(nextRadioIndex("End", current, 3), 2, `End from ${current}`);
  }
});

test("a two-button group answers the keys the 修正後／自動判定 group has always answered", () => {
  assert.equal(nextRadioIndex("ArrowRight", 0, 2), 1);
  assert.equal(nextRadioIndex("ArrowLeft", 1, 2), 0);
  assert.equal(nextRadioIndex("Home", 1, 2), 0);
  assert.equal(nextRadioIndex("End", 0, 2), 1);
});

test("keys that mean something else are not handled, so Tab can leave the group and Enter and Space still press the button", () => {
  for (const key of ["Tab", "Enter", " ", "Escape", "a", "PageDown", "Shift"]) {
    assert.equal(nextRadioIndex(key, 0, 2), null, `${JSON.stringify(key)} must not move the selection`);
  }
});

test("when no radio is current, the arrows start from the edge of the group", () => {
  assert.equal(nextRadioIndex("ArrowRight", -1, 3), 0);
  assert.equal(nextRadioIndex("ArrowDown", -1, 3), 0);
  assert.equal(nextRadioIndex("ArrowLeft", -1, 3), 2);
  assert.equal(nextRadioIndex("ArrowUp", -1, 3), 2);
});

test("a group with no radios handles nothing, and a lone radio stays where it is", () => {
  assert.equal(nextRadioIndex("ArrowRight", 0, 0), null);
  assert.equal(nextRadioIndex("Home", 0, 0), null);
  assert.equal(nextRadioIndex("ArrowRight", 0, 1), 0);
  assert.equal(nextRadioIndex("ArrowLeft", 0, 1), 0);
});
