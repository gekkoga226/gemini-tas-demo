#!/usr/bin/env node
// Gemini Enterprise Agent Platform (旧 Vertex AI) の agentic video processing を実測するプローブ。
// Check 0〜6の従来診断を保持し、Round 18のCheck 7〜11へ振り分ける。
// 追加Checkはアプリと同じ入力ビルダー・契約・アダプターを使う。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { SEGMENT_KEYS } from "../../src/schema.js";

const cfg = {
  project: process.env.GEAP_PROJECT,
  location: process.env.GEAP_LOCATION ?? "us-central1",
  host: process.env.GEAP_HOST,
  flashModel: process.env.GEAP_FLASH_MODEL,
  proModel: process.env.GEAP_PRO_MODEL,
  shortVideoA: process.env.GEAP_SHORT_VIDEO_A,
  shortVideoB: process.env.GEAP_SHORT_VIDEO_B,
  longVideo: process.env.GEAP_LONG_VIDEO,
  expectedSegments: process.env.GEAP_EXPECTED_SEGMENTS,
  accessToken: process.env.GEAP_ACCESS_TOKEN,
  // mediaProcessing フィールドは v1 の Part には存在せず、v1beta1 にのみ定義されている。
  apiVersion: process.env.GEAP_API_VERSION ?? "v1beta1",
  outFile: process.env.GEAP_OUT ?? "tools/geap-probe/report.json",
};

const baseUrl = cfg.host ?? `https://${cfg.location}-aiplatform.googleapis.com`;

// 先頭が Discovery ドキュメントで確認できた正式な指定位置。以降は保険の候補。
const PLACEMENTS = [
  { id: "part.mediaProcessing", apply: (part, mode) => ({ ...part, mediaProcessing: mode }) },
  { id: "part.media_processing", apply: (part, mode) => ({ ...part, media_processing: mode }) },
  { id: "videoMetadata.mediaProcessing", apply: (part, mode) => ({ ...part, videoMetadata: { ...(part.videoMetadata ?? {}), mediaProcessing: mode } }) },
  { id: "videoMetadata.processing", apply: (part, mode) => ({ ...part, videoMetadata: { ...(part.videoMetadata ?? {}), processing: mode.toLowerCase() } }) },
];

function getAccessToken() {
  if (cfg.accessToken) return cfg.accessToken;
  if(process.platform==='win32')try{return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','& gcloud.cmd auth print-access-token'],{windowsHide:true,timeout:30000,encoding:'utf8'}).trim();}catch{}
  for (const bin of ["gcloud", "gcloud.cmd"]) {
    try {
      return execFileSync(bin, ["auth", "print-access-token"], { encoding: "utf8" }).trim();
    } catch {
      // 次の候補へ
    }
  }
  throw new Error("アクセストークンを取得できません。GEAP_ACCESS_TOKEN を設定するか、gcloud auth login を実行してください。");
}

function videoPart(uri) {
  return { fileData: { fileUri: uri, mimeType: "video/mp4" } };
}

async function callModel({ token, model, parts, schema, method = "generateContent" }) {
  const url = `${baseUrl}/${cfg.apiVersion}/projects/${cfg.project}/locations/${cfg.location}/publishers/google/models/${model}:${method}`;
  const body = { contents: [{ role: "user", parts }] };
  if (method === "generateContent") {
    body.generationConfig = {
      ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
    };
  }
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // JSONでない応答はそのまま raw で保持する
  }
  return { ok: response.ok, status: response.status, payload, raw: text, elapsedMs: Date.now() - started, url };
}

// 応答のどこかに agentic の実行痕跡があるかを再帰的に探す。
function findAgenticTraces(value, hits = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => findAgenticTraces(item, hits));
    return hits;
  }
  if (!value || typeof value !== "object") return hits;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/_/g, "");
    if (normalized.includes("processingcall") || normalized.includes("processingresult")) hits.add(key);
    if (key === "type" && typeof child === "string") {
      const t = child.toLowerCase().replace(/_/g, "");
      if (t.includes("processingcall") || t.includes("processingresult") || t.includes("mediaprocessing")) hits.add(`type=${child}`);
    }
    findAgenticTraces(child, hits);
  }
  return hits;
}

function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("");
}

function parseJsonLoose(text) {
  const trimmed = (text ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    return null;
  }
}

function usageOf(payload) {
  const u = payload?.usageMetadata ?? {};
  return {
    promptTokenCount: u.promptTokenCount ?? null,
    candidatesTokenCount: u.candidatesTokenCount ?? null,
    totalTokenCount: u.totalTokenCount ?? null,
    thoughtsTokenCount: u.thoughtsTokenCount ?? null,
    toolUsePromptTokenCount: u.toolUsePromptTokenCount ?? null,
  };
}

function requireConfig(names) {
  const missing = names.filter((n) => !cfg[n]);
  if (missing.length) throw new Error(`未設定の環境変数: ${missing.map((n) => `GEAP_${n.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`).join(", ")}`);
}

// ---------------------------------------------------------------- チェック本体

// Check 0: media_processing をどこに書けば通るのかを特定する。
async function checkFieldPlacement(ctx) {
  requireConfig(["shortVideoA"]);
  const attempts = [];
  for (const placement of PLACEMENTS) {
    const part = placement.apply(videoPart(cfg.shortVideoA), "AGENTIC");
    const res = await callModel({
      token: ctx.token,
      model: cfg.flashModel,
      parts: [part, { text: "この動画に何が映っているか1文で答えてください。" }],
    });
    const traces = [...findAgenticTraces(res.payload ?? {})];
    attempts.push({
      placement: placement.id,
      status: res.status,
      accepted: res.ok,
      agenticTraces: traces,
      error: res.ok ? null : (res.payload?.error?.message ?? res.raw).slice(0, 400),
    });
    if (res.ok && traces.length) {
      ctx.placement = placement;
      return { verdict: "PASS", detail: `${placement.id} が受理され、agentic の実行痕跡も確認できました。`, attempts };
    }
    if (res.ok && !ctx.placement) ctx.placement = placement;
  }
  if (ctx.placement) {
    return { verdict: "PARTIAL", detail: `${ctx.placement.id} はエラーになりませんでしたが、agentic の実行痕跡は確認できませんでした。静かに STATIC で処理された可能性があります。`, attempts };
  }
  return { verdict: "FAIL", detail: "どの置き場所でもリクエストが通りませんでした。エンドポイント・モデル名・権限を確認してください。", attempts };
}

// Check 1: agentic モードで responseSchema による構造化出力ができるか。
async function checkStructuredOutput(ctx) {
  requireConfig(["shortVideoA"]);
  if (!ctx.placement) return { verdict: "SKIP", detail: "Check 0 が通らなかったため実行できません。" };
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: Object.fromEntries(SEGMENT_KEYS.map((k) => [k, { type: k === "duration_seconds" ? "integer" : "string" }])),
      required: [...SEGMENT_KEYS],
    },
  };
  const part = ctx.placement.apply(videoPart(cfg.shortVideoA), "AGENTIC");
  const res = await callModel({
    token: ctx.token,
    model: cfg.flashModel,
    parts: [part, { text: "この動画の作業を区間に分割し、指定のJSON Schemaの9項目をすべて埋めてください。時刻はHH:MM:SS形式。" }],
    schema,
  });
  if (!res.ok) {
    return { verdict: "FAIL", detail: "responseSchema を付けるとリクエストが失敗しました。agentic と構造化出力は併用できない可能性があります。", status: res.status, error: (res.payload?.error?.message ?? res.raw).slice(0, 600) };
  }
  const parsed = parseJsonLoose(extractText(res.payload));
  if (!Array.isArray(parsed)) {
    return { verdict: "FAIL", detail: "応答がJSON配列として読み取れませんでした。", sample: extractText(res.payload).slice(0, 600), usage: usageOf(res.payload) };
  }
  const missing = new Set();
  for (const seg of parsed) for (const k of SEGMENT_KEYS) if (!(k in (seg ?? {}))) missing.add(k);
  return {
    verdict: missing.size ? "PARTIAL" : "PASS",
    detail: missing.size ? `9項目のうち不足: ${[...missing].join(", ")}` : `9項目すべて揃った区間を ${parsed.length} 件取得しました。`,
    segmentCount: parsed.length,
    agenticTraces: [...findAgenticTraces(res.payload)],
    usage: usageOf(res.payload),
  };
}

// Check 2: 動画2本を入れたとき、時刻がどちらの動画のものか区別できるか。
async function checkMultiVideoTimestamps(ctx) {
  requireConfig(["shortVideoA", "shortVideoB"]);
  if (!ctx.placement) return { verdict: "SKIP", detail: "Check 0 が通らなかったため実行できません。" };
  const prompt = [
    "2本の動画を渡します。1本目をVIDEO_A、2本目をVIDEO_Bと呼びます。",
    "それぞれについて、最初の場面と最後の場面の時刻(MM:SS)と、そこに何が映っているかを答えてください。",
    'ただしJSON形式 {"VIDEO_A":{"first":{"time":"","what":""},"last":{"time":"","what":""}},"VIDEO_B":{...}} で出力してください。',
  ].join("\n");
  const res = await callModel({
    token: ctx.token,
    model: cfg.flashModel,
    parts: [
      { text: "以下はVIDEO_Aです。" },
      ctx.placement.apply(videoPart(cfg.shortVideoA), "AGENTIC"),
      { text: "以下はVIDEO_Bです。" },
      ctx.placement.apply(videoPart(cfg.shortVideoB), "AGENTIC"),
      { text: prompt },
    ],
  });
  if (!res.ok) {
    return { verdict: "FAIL", detail: "動画2本のリクエストが失敗しました。", status: res.status, error: (res.payload?.error?.message ?? res.raw).slice(0, 600) };
  }
  const text = extractText(res.payload);
  const parsed = parseJsonLoose(text);
  const hasBoth = parsed && parsed.VIDEO_A && parsed.VIDEO_B;
  const identical = hasBoth && JSON.stringify(parsed.VIDEO_A) === JSON.stringify(parsed.VIDEO_B);
  return {
    // 帰属が正しいかは映像を知る人にしか判定できないため、自動判定はしない。
    verdict: "NEEDS_HUMAN_REVIEW",
    detail: !hasBoth
      ? "VIDEO_A / VIDEO_B の両方を含むJSONが得られませんでした。区別できていない可能性が高いです。"
      : identical
        ? "両動画の回答が完全に同一です。区別できていない疑いが濃厚です。"
        : "両動画それぞれの回答が得られました。内容が実際の映像と一致しているか、人が確認してください。",
    modelOutput: text.slice(0, 1500),
    usage: usageOf(res.payload),
  };
}

// Check 3: 20分動画で agentic が実際に発動しているか。
async function checkAgenticActuallyRuns(ctx) {
  requireConfig(["longVideo"]);
  if (!ctx.placement) return { verdict: "SKIP", detail: "Check 0 が通らなかったため実行できません。" };
  const prompt = "この動画の作業工程を時系列に列挙し、それぞれの開始時刻(MM:SS)を答えてください。";
  const agentic = await callModel({
    token: ctx.token,
    model: cfg.flashModel,
    parts: [ctx.placement.apply(videoPart(cfg.longVideo), "AGENTIC"), { text: prompt }],
  });
  const staticRun = await callModel({
    token: ctx.token,
    model: cfg.flashModel,
    parts: [ctx.placement.apply(videoPart(cfg.longVideo), "STATIC"), { text: prompt }],
  });
  const traces = agentic.ok ? [...findAgenticTraces(agentic.payload)] : [];
  return {
    verdict: !agentic.ok ? "FAIL" : traces.length ? "PASS" : "FAIL",
    detail: !agentic.ok
      ? "AGENTIC 指定のリクエストが失敗しました。"
      : traces.length
        ? `agentic の実行痕跡を検出しました: ${traces.join(", ")}`
        : "痕跡が無く、AGENTIC を指定しても STATIC として処理された可能性が高いです。",
    agenticTraces: traces,
    agentic: { ok: agentic.ok, status: agentic.status, elapsedMs: agentic.elapsedMs, usage: usageOf(agentic.payload) },
    static: { ok: staticRun.ok, status: staticRun.status, elapsedMs: staticRun.elapsedMs, usage: usageOf(staticRun.payload) },
  };
}

// Check 4: トークン実測。countTokens と実応答の usageMetadata を突き合わせる。
async function checkTokenUsage(ctx) {
  requireConfig(["longVideo"]);
  if (!ctx.placement) return { verdict: "SKIP", detail: "Check 0 が通らなかったため実行できません。" };
  const parts = [ctx.placement.apply(videoPart(cfg.longVideo), "AGENTIC"), { text: "この動画を1文で要約してください。" }];
  const counted = await callModel({ token: ctx.token, model: cfg.flashModel, parts, method: "countTokens" });
  return {
    // 実測値の収集が目的であり、合否を判定するものではない。
    verdict: counted.ok ? "MEASURED" : "PARTIAL",
    detail: counted.ok
      ? "countTokens の結果を記録しました。Check 1〜3 の usage と併せて単価計算に使ってください。"
      : "countTokens が失敗しました。Check 1〜3 の usageMetadata のみで見積もってください。",
    countTokens: counted.payload ?? null,
    note: "agentic はモデルの探索方針によって消費量が変わるため、countTokens の値は下限の目安にしかなりません。",
  };
}

// Check 5: 時刻精度。正解データが与えられた場合のみ自動採点する。
async function checkTimestampAccuracy(ctx) {
  requireConfig(["shortVideoA"]);
  if (!ctx.placement) return { verdict: "SKIP", detail: "Check 0 が通らなかったため実行できません。" };
  if (!cfg.expectedSegments) {
    return { verdict: "SKIP", detail: "GEAP_EXPECTED_SEGMENTS に正解データ(JSON)のパスを指定すると、境界の秒差を自動計算します。" };
  }
  const expected = JSON.parse(readFileSync(cfg.expectedSegments, "utf8"));
  const res = await callModel({
    token: ctx.token,
    model: cfg.flashModel,
    parts: [ctx.placement.apply(videoPart(cfg.shortVideoA), "AGENTIC"), { text: 'この動画の作業区間を [{"start_s":0,"end_s":12,"what":"..."}] の形式で、秒単位の整数で出力してください。' }],
  });
  if (!res.ok) return { verdict: "FAIL", detail: "リクエストが失敗しました。", status: res.status };
  const predicted = parseJsonLoose(extractText(res.payload));
  if (!Array.isArray(predicted)) return { verdict: "FAIL", detail: "予測結果をJSON配列として読み取れませんでした。", sample: extractText(res.payload).slice(0, 600) };

  // 正解の各境界に対し、予測側の最も近い境界との差を取る。
  const expectedBoundaries = expected.flatMap((s) => [s.start_s, s.end_s]);
  const predictedBoundaries = predicted.flatMap((s) => [s.start_s, s.end_s]).filter((n) => Number.isFinite(n));
  const diffs = expectedBoundaries.map((e) => Math.min(...predictedBoundaries.map((p) => Math.abs(p - e))));
  const within = (tol) => diffs.filter((d) => d <= tol).length / (diffs.length || 1);
  return {
    verdict: "MEASURED",
    detail: `正解境界 ${expectedBoundaries.length} 点に対する秒差を計算しました。`,
    expectedSegmentCount: expected.length,
    predictedSegmentCount: predicted.length,
    meanAbsErrorSec: Number((diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1)).toFixed(2)),
    withinTolerance: { "1s": within(1), "3s": within(3), "5s": within(5) },
  };
}

// Check 6: Pro 系モデルで agentic が本当に動くか（公式資料の矛盾を実機で決着させる）。
async function checkProAgentic(ctx) {
  requireConfig(["shortVideoA"]);
  if (!ctx.placement) return { verdict: "SKIP", detail: "Check 0 が通らなかったため実行できません。" };
  const res = await callModel({
    token: ctx.token,
    model: cfg.proModel,
    parts: [ctx.placement.apply(videoPart(cfg.shortVideoA), "AGENTIC"), { text: "この動画に何が映っているか1文で答えてください。" }],
  });
  if (!res.ok) {
    return { verdict: "FAIL", detail: `${cfg.proModel} へのリクエストが失敗しました。モデル名またはリージョンを確認してください。`, status: res.status, error: (res.payload?.error?.message ?? res.raw).slice(0, 400) };
  }
  const traces = [...findAgenticTraces(res.payload)];
  return {
    verdict: traces.length ? "PASS" : "FAIL",
    detail: traces.length
      ? `${cfg.proModel} でも agentic が動作しました。GEAP のリリースノートの記述(3.5 Pro 以降が対応)が正しいことになります。`
      : `${cfg.proModel} の応答にagenticの痕跡を確認できません。agentic_unconfirmed。STATICへの移行や非対応は断定できません。`,
    model: cfg.proModel,
    agenticTraces: traces,
    usage: usageOf(res.payload),
  };
}

const CHECKS = [
  ["0. media_processing の指定位置の特定", checkFieldPlacement],
  ["1. agentic + 構造化出力(9項目JSON)", checkStructuredOutput],
  ["2. 動画2本のタイムスタンプ帰属", checkMultiVideoTimestamps],
  ["3. 20分動画で agentic が発動しているか", checkAgenticActuallyRuns],
  ["4. トークン実測", checkTokenUsage],
  ["5. 時刻精度", checkTimestampAccuracy],
  ["6. Pro モデルで agentic が使えるか", checkProAgentic],
];

async function legacyMain(selected) {
  requireConfig(["project", "flashModel", "proModel"]);
  if(cfg.apiVersion!=='v1beta1')throw new Error('APIはv1beta1に固定してください。');
  if(process.env.GEAP_EVAL_CONSENT_CONFIRMED!=='true'||process.env.GEAP_ENVIRONMENT_CONFIRMED!=='true'||!process.env.GEAP_BUCKET)throw new Error('動画の送信同意、認証・プロジェクト・バケットの確認が必要です。');
  const ctx = { token: getAccessToken(), placement: null };
  const results = [];

  console.log(`エンドポイント: ${baseUrl}/${cfg.apiVersion}`);
  console.log(`プロジェクト: ${cfg.project} / リージョン: ${cfg.location}`);
  console.log(`Flash: ${cfg.flashModel} / Pro: ${cfg.proModel}\n`);

  for (const [index, [name, fn]] of CHECKS.entries()) {
    if(!selected.includes(index))continue;
    process.stdout.write(`▶ ${name} ... `);
    let result;
    try {
      result = await fn(ctx);
    } catch (error) {
      result = { verdict: "ERROR", detail: error.message };
    }
    console.log(result.verdict);
    if (result.detail) console.log(`   ${result.detail}`);
    results.push({ check: name, ...result });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: { baseUrl, apiVersion: cfg.apiVersion, project: cfg.project, location: cfg.location, flashModel: cfg.flashModel, proModel: cfg.proModel },
    resolvedPlacement: ctx.placement?.id ?? null,
    results,
  };
  writeFileSync(cfg.outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nレポートを書き出しました: ${cfg.outFile}`);
  console.log("このファイルをそのまま返送してください。");
}

async function main(){
  const selected=(process.env.GEAP_CHECKS||'0,1,2,3,4,5,6').split(',').map(Number);
  if(selected.some(n=>!Number.isInteger(n)||n<0||n>11))throw new Error('GEAP_CHECKSは0〜11のカンマ区切りです。');
  if(selected.some(n=>n<=6))await legacyMain(selected);
  if(selected.some(n=>n>=7)){
    const {runAdditionalChecks}=await import('./extra-checks.mjs');
    const result=await runAdditionalChecks({checks:selected.filter(n=>n>=7)});
    console.log(`評価成果物: ${result.root}`);
    for(const c of result.summary.checks)console.log(`Check ${c.check_id}: ${c.status} / quality ${c.quality_verdict}`);
  }
}
main().catch((error) => {
  console.error(`\n実行できませんでした: ${error.message}`);
  process.exitCode = 1;
});
