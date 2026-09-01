import test from "node:test";
import assert from "node:assert/strict";
import { validateSegments, boundaryLimits, applyBoundary, editWorsened, nudgeResult } from "../public/segments.js";

const DURATION = 1200;

// Mirrors the shape the reviewer saw in real Gemini output: three segments tangled in a
// pre-existing overlap, plus one clean segment far away from the trouble.
function overlappingSet() {
  return [
    { start_time: "00:02:30", end_time: "00:02:35" }, // 150-155
    { start_time: "00:02:35", end_time: "00:02:50" }, // 155-170
    { start_time: "00:02:30", end_time: "00:03:15" }, // 150-195, overlaps both of the above
    { start_time: "00:10:00", end_time: "00:10:30" }, // 600-630, clean
  ];
}

function cleanSet() {
  return [
    { start_time: "00:02:30", end_time: "00:02:35" },
    { start_time: "00:02:35", end_time: "00:02:50" },
    { start_time: "00:10:00", end_time: "00:10:30" },
  ];
}

test("validateSegments flags both sides of an overlap and leaves unrelated segments clean", () => {
  const errors = validateSegments(overlappingSet(), DURATION);
  assert.ok(errors[0].length > 0, "segment 1 overlaps segment 3");
  assert.ok(errors[1].length > 0, "segment 2 overlaps segment 3");
  assert.ok(errors[2].length > 0, "segment 3 overlaps two neighbours");
  assert.deepEqual(errors[3], [], "the far-away segment has no problem of its own");
});

test("an edit to a clean segment is allowed even while other segments are already broken", () => {
  const segments = overlappingSet();
  const before = validateSegments(segments, DURATION);

  segments[3].end_time = "00:10:20"; // shorten the clean segment; still perfectly valid
  const after = validateSegments(segments, DURATION);

  assert.equal(editWorsened(before, after, 3), false);
});

test("an edit that creates a new overlap is rejected", () => {
  const segments = cleanSet();
  const before = validateSegments(segments, DURATION);

  segments[2].start_time = "00:02:40"; // now runs into segment 2
  const after = validateSegments(segments, DURATION);

  assert.equal(editWorsened(before, after, 2), true);
});

test("an edit that leaves a pre-existing problem untouched is allowed", () => {
  const segments = overlappingSet();
  const before = validateSegments(segments, DURATION);

  segments[2].end_time = "00:03:10"; // still overlapping, but no worse than it was
  const after = validateSegments(segments, DURATION);

  assert.equal(editWorsened(before, after, 2), false);
});

test("nudging a boundary earlier moves it earlier", () => {
  const segments = cleanSet();
  const result = nudgeResult(segments, 2, "left", -1, 1, DURATION);
  assert.equal(result.accepted, true);
  assert.equal(result.value, 599);
});

test("nudging earlier never jumps forward when the segment already overlaps its neighbour", () => {
  // Segment 3 starts at 150 but segment 2 ends at 170, so the clamp floor sits 20s AHEAD
  // of the current value. Pressing the left arrow must not drag the boundary forward.
  const segments = overlappingSet();
  const result = nudgeResult(segments, 2, "left", -1, 1, DURATION);
  assert.equal(result.accepted, false, "a leftward nudge must never increase the time");
});

test("nudging past the clamp limit is rejected instead of silently doing nothing", () => {
  const segments = cleanSet();
  // segment 2 starts exactly where segment 1 ends, so it cannot move any earlier
  const result = nudgeResult(segments, 1, "left", -1, 1, DURATION);
  assert.equal(result.accepted, false);
});

test("boundaryLimits can invert when the source data already overlaps", () => {
  const limits = boundaryLimits(overlappingSet(), 2, "left", DURATION);
  assert.ok(limits.min > limits.max === false || limits.min > 150, "floor sits ahead of the current start");
  assert.equal(limits.min, 170);
});

test("applyBoundary keeps duration_seconds in step with the edited times", () => {
  const segments = cleanSet();
  applyBoundary(segments, 2, "right", 620, DURATION);
  assert.equal(segments[2].end_time, "00:10:20");
  assert.equal(segments[2].duration_seconds, 20);
});
