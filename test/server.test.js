import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../server.js";
import { callGeminiText } from "../src/gemini.js";

const PORT = 43917;

test("local mock server protects mutations and returns no IDs or secrets", async (t) => {
  const warnings = [];
  const server = createAppServer({ mockMode: true, port: PORT, model: "gemini-3.1-pro-preview", apiKey: "", mockDelayMs: 5 }, { logger: { warn: (message) => warnings.push(message) } });
  server.listen(PORT, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${PORT}`;
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.mockMode, true);
  assert.equal("apiKey" in session, false);

  const forbidden = await fetch(`${base}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(forbidden.status, 403);

  const response = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": session.token },
    body: JSON.stringify({ videoDurationSeconds: 30, pdfPageCount: 4 }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "mock");
  assert.equal(body.prediction.length, 4);
  assert.equal(JSON.stringify(body).includes("interaction"), false);
  assert.deepEqual(warnings, []);
});

test("host and origin checks reject non-local callers", async (t) => {
  const server = createAppServer({ mockMode: true, port: PORT + 1, model: "gemini-3.1-pro-preview", apiKey: "", mockDelayMs: 0 }, { logger: { warn() {} } });
  server.listen(PORT + 1, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${PORT + 1}/api/health`, { headers: { Origin: "https://example.com" } });
  assert.equal(response.status, 403);
});

test("malformed Gemini output and unknown error details stay out of responses and logs", async (t) => {
  const responseFragment = "synthetic-gemini-response-fragment-DO-NOT-EXPOSE";
  const warnings = [];
  let throwUnknown = false;
  const geminiCaller = ({ signal }) => {
    if (throwUnknown) throw new Error(responseFragment);
    return callGeminiText({
      apiKey: "not-a-real-key",
      model: "gemini-3.6-flash",
      signal,
      fetchImpl: async () => new Response(JSON.stringify({
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: responseFragment }] }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
  };
  const server = createAppServer(
    { mockMode: false, port: PORT + 2, model: "gemini-3.6-flash", apiKey: "configured", mockDelayMs: 0 },
    { geminiCaller, logger: { warn: (message) => warnings.push(message) } },
  );
  server.listen(PORT + 2, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const base = `http://127.0.0.1:${PORT + 2}`;
  const session = await (await fetch(`${base}/api/session`)).json();
  const response = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": session.token },
    body: JSON.stringify({ videoDurationSeconds: 10, pdfPageCount: 1 }),
  });
  const responseText = await response.text();

  assert.equal(response.status, 502);
  assert.equal(responseText.includes(responseFragment), false);
  assert.deepEqual(JSON.parse(responseText), {
    code: "ANALYSIS_FAILED",
    message: "解析に失敗しました。時間をおいて再試行してください。",
  });
  assert.equal(warnings.join("\n").includes(responseFragment), false);
  assert.deepEqual(warnings, ["[analysis] ANALYSIS_FAILED"]);

  throwUnknown = true;
  const unknownResponse = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": session.token },
    body: JSON.stringify({ videoDurationSeconds: 10, pdfPageCount: 1 }),
  });
  const unknownResponseText = await unknownResponse.text();
  assert.equal(unknownResponse.status, 502);
  assert.equal(unknownResponseText.includes(responseFragment), false);
  assert.deepEqual(JSON.parse(unknownResponseText), JSON.parse(responseText));
  assert.equal(warnings.join("\n").includes(responseFragment), false);
  assert.deepEqual(warnings, ["[analysis] ANALYSIS_FAILED", "[analysis] ANALYSIS_FAILED"]);
});
