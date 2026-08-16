import test from "node:test";
import assert from "node:assert/strict";
import { callGeminiText } from "../src/gemini.js";
import { createMockPrediction } from "../src/schema.js";

test("real API request is synchronous, stateless, text-only, and Flash-only", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(createMockPrediction(10)) }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await callGeminiText({ apiKey: "not-a-real-key", model: "gemini-3.6-flash", fetchImpl });
  assert.equal(result.length, 4);
  assert.deepEqual(result, createMockPrediction(10));
  assert.equal(captured.url.endsWith("/v1beta/interactions"), true);
  assert.equal(captured.body.store, false);
  assert.equal("background" in captured.body, false);
  assert.equal(typeof captured.body.input, "string");
  assert.equal(JSON.stringify(captured.body).includes("mp4"), false);
  assert.equal(JSON.stringify(captured.body).includes("pdf"), false);
});

test("Pro is rejected before any network request", async () => {
  let called = false;
  await assert.rejects(
    callGeminiText({ apiKey: "not-a-real-key", model: "gemini-3.1-pro-preview", fetchImpl: async () => { called = true; } }),
    /Flashモデル/,
  );
  assert.equal(called, false);
});
