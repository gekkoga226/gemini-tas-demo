import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callGeminiText, FLASH_MODELS } from "./src/gemini.js";
import { createMockPrediction, preparePrediction } from "./src/schema.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export function loadConfig(environment = process.env) {
  const mockMode = String(environment.MOCK_MODE ?? "true").toLowerCase() !== "false";
  const port = Number.parseInt(environment.PORT || "4173", 10);
  return {
    mockMode,
    port: Number.isInteger(port) && port > 0 ? port : 4173,
    model: environment.GEMINI_MODEL || "gemini-3.1-pro-preview",
    apiKey: environment.GEMINI_API_KEY || "",
    mockDelayMs: Math.max(0, Number.parseInt(environment.MOCK_DELAY_MS || "2800", 10) || 0),
  };
}

function writeJson(response, status, body) {
  if (response.destroyed) return;
  const data = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  response.end(data);
}

function safeError(error) {
  if (error?.name === "AbortError") return { status: 499, code: "WAIT_CANCELLED", message: "画面での待機を中止しました。" };
  const known = new Map([
    ["MODEL_NOT_ALLOWED", { status: 400, message: "実APIモードでは無料枠のFlashモデルだけを使用できます。" }],
    ["API_KEY_MISSING", { status: 400, message: "Gemini APIキーは管理者による設定が必要です。" }],
    ["GEMINI_AUTH", { status: 502, message: "Geminiとの同期通信に失敗しました。時間を置いて再実行してください。" }],
    ["GEMINI_NOT_COMPLETED", { status: 502, message: "Geminiの同期処理が正常完了しませんでした。" }],
    ["GEMINI_EMPTY_OUTPUT", { status: 502, message: "Geminiの応答からJSON結果を読み取れませんでした。" }],
    ["INVALID_STRUCTURE", { status: 502, message: "Gemini結果が正式なJSON構造を満たしていません。" }],
    ["GEMINI_INVALID_JSON", { status: 502, code: "ANALYSIS_FAILED", message: "解析に失敗しました。時間をおいて再試行してください。" }],
  ]);
  const knownError = known.get(error?.code);
  if (knownError) return { code: error.code, ...knownError };
  if (/^GEMINI_HTTP_\d{3}$/.test(String(error?.code || ""))) {
    return { status: 502, code: error.code, message: "Geminiとの同期通信に失敗しました。時間を置いて再実行してください。" };
  }
  return { status: 502, code: "ANALYSIS_FAILED", message: "解析に失敗しました。時間をおいて再試行してください。" };
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("要求が大きすぎます。"), { code: "REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    }, { once: true });
  });
}

function applySecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'");
}

export function createAppServer(config = loadConfig(), options = {}) {
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const logger = options.logger || console;
  const geminiCaller = options.geminiCaller || callGeminiText;
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    const host = request.headers.host || "";
    if (!allowedHosts.has(host)) return writeJson(response, 403, { code: "LOCAL_ACCESS_ONLY", message: "このローカルサーバーにはlocalhostからだけ接続できます。" });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) return writeJson(response, 403, { code: "ORIGIN_REJECTED", message: "許可されていない接続元です。" });

    const url = new URL(request.url, `http://${host}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return writeJson(response, 200, { ok: true, mode: config.mockMode ? "mock" : "real-text-only" });
    }
    if (request.method === "GET" && url.pathname === "/api/session") {
      return writeJson(response, 200, {
        token: sessionToken,
        mockMode: config.mockMode,
        apiKeyConfigured: Boolean(config.apiKey),
        realModelAllowed: FLASH_MODELS.has(config.model),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/analyze") {
      if (request.headers["x-local-token"] !== sessionToken) {
        return writeJson(response, 403, { code: "TOKEN_REQUIRED", message: "ローカル操作トークンが無効です。画面を再読み込みしてください。" });
      }
      const controller = new AbortController();
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        const body = await readJson(request);
        let prediction;
        if (config.mockMode) {
          await abortableDelay(config.mockDelayMs, controller.signal);
          prediction = createMockPrediction(body.videoDurationSeconds);
        } else {
          prediction = await geminiCaller({ apiKey: config.apiKey, model: config.model, signal: controller.signal });
        }
        const maximumEnd = config.mockMode ? Math.max(1, Math.ceil(Number(body.videoDurationSeconds) || 30)) : 10;
        const prepared = preparePrediction(prediction, maximumEnd);
        return writeJson(response, 200, { mode: config.mockMode ? "mock" : "real-text-only", prediction: prepared.prediction, warnings: prepared.warnings });
      } catch (error) {
        const safe = safeError(error);
        if (safe.status !== 499) logger.warn?.(`[analysis] ${safe.code}`);
        return writeJson(response, safe.status, { code: safe.code, message: safe.message });
      }
    }

    if (request.method !== "GET") return writeJson(response, 404, { code: "NOT_FOUND", message: "見つかりません。" });
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const absolute = path.resolve(PUBLIC_ROOT, relative);
    if (!absolute.startsWith(`${PUBLIC_ROOT}${path.sep}`) && absolute !== path.join(PUBLIC_ROOT, "index.html")) {
      return writeJson(response, 404, { code: "NOT_FOUND", message: "見つかりません。" });
    }
    try {
      const data = await fs.readFile(absolute);
      response.writeHead(200, { "content-type": CONTENT_TYPES.get(path.extname(absolute)) || "application/octet-stream", "content-length": data.length });
      response.end(data);
    } catch {
      writeJson(response, 404, { code: "NOT_FOUND", message: "見つかりません。" });
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = loadConfig();
  const server = createAppServer(config);
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`Gemini TAS local app: http://127.0.0.1:${config.port}`);
    console.log(`Mode: ${config.mockMode ? "local mock (no Gemini communication)" : "real text-only synchronous Flash"}`);
  });
}
