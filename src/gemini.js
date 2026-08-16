import { GEMINI_RESPONSE_SCHEMA } from "./schema.js";

export const FLASH_MODELS = new Set(["gemini-3.5-flash", "gemini-3.6-flash"]);

const TEXT_VALIDATION_PROMPT = `ローカルTAS画面の同期API疎通確認です。実動画や実PDFは入力されていません。
架空の10秒間の組立作業について、0秒から5秒の「部品を準備する」と、5秒から10秒の「部品を確認する」の2区間を生成してください。
指定されたJSON Schemaの9項目をすべて埋め、時刻は厳密なHH:MM:SS、duration_secondsは整数にしてください。`;

function collectModelText(value, output = []) {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectModelText(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "model_output" && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (item?.type === "text" && typeof item.text === "string") output.push(item.text);
    }
  }
  for (const child of Object.values(value)) collectModelText(child, output);
}

function parseJsonText(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    const error = new Error("解析に失敗しました。時間をおいて再試行してください。");
    error.code = "GEMINI_INVALID_JSON";
    throw error;
  }
}

export async function callGeminiText({ apiKey, model, signal, fetchImpl = fetch }) {
  if (!FLASH_MODELS.has(model)) {
    const error = new Error("実APIモードでは無料枠のFlashモデルだけを使用できます。");
    error.code = "MODEL_NOT_ALLOWED";
    throw error;
  }
  if (!apiKey) {
    const error = new Error("Gemini APIキーは管理者による設定が必要です。");
    error.code = "API_KEY_MISSING";
    throw error;
  }

  const response = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "Api-Revision": "2026-05-20",
    },
    body: JSON.stringify({
      model,
      input: TEXT_VALIDATION_PROMPT,
      store: false,
      generation_config: { max_output_tokens: 65536 },
      response_format: [{ type: "text", mime_type: "application/json", schema: GEMINI_RESPONSE_SCHEMA }],
    }),
    signal,
  });

  if (!response.ok) {
    const error = new Error("Geminiとの同期通信に失敗しました。時間を置いて再実行してください。");
    error.code = response.status === 401 || response.status === 403 ? "GEMINI_AUTH" : `GEMINI_HTTP_${response.status}`;
    throw error;
  }
  const payload = await response.json();
  if (payload.status && payload.status !== "completed") {
    const error = new Error("Geminiの同期処理が正常完了しませんでした。");
    error.code = "GEMINI_NOT_COMPLETED";
    throw error;
  }
  const texts = [];
  collectModelText(payload, texts);
  if (!texts.length) {
    const error = new Error("Geminiの応答からJSON結果を読み取れませんでした。");
    error.code = "GEMINI_EMPTY_OUTPUT";
    throw error;
  }
  return parseJsonText(texts.at(-1));
}
