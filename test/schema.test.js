import test from "node:test";
import assert from "node:assert/strict";
import { createMockPrediction, preparePrediction, qualityWarnings, secondsToTime, timeToSeconds, toReviewed, validateStructure } from "../src/schema.js";

test("time conversion is strict and reversible", () => {
  assert.equal(timeToSeconds("01:02:03"), 3723);
  assert.equal(secondsToTime(3723), "01:02:03");
  assert.equal(timeToSeconds("1:02:03"), null);
  assert.equal(timeToSeconds("00:60:00"), null);
});

test("deterministic mock follows the official nine-field structure", () => {
  const first = createMockPrediction(30);
  const second = createMockPrediction(30);
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  assert.equal(validateStructure(first).valid, true);
  assert.deepEqual(qualityWarnings(first, 30), [[], [], [], []]);
});

test("prediction keeps AI duration while reviewed output recalculates it", () => {
  const result = createMockPrediction(10);
  result[0].duration_seconds = 99;
  const prepared = preparePrediction(result, 10);
  assert.equal(prepared.prediction[0].duration_seconds, 99);
  assert.equal(prepared.warnings[0].length, 1);
  assert.notEqual(toReviewed(prepared.prediction)[0].duration_seconds, 99);
});

test("A validation rejects missing fields and numeric strings", () => {
  const result = createMockPrediction(10);
  delete result[0].job_no;
  result[1].duration_seconds = "5";
  const validation = validateStructure(result);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("job_no")));
  assert.ok(validation.errors.some((error) => error.includes("整数")));
});
