import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 結果画面（画面B）の文字に、用語表（docs/2026-09-27_UI_DECISIONS.md 2章）にない古い言い方を戻さない。コードの名前と、行全体がコメントの行は対象外。
const SCREEN_B_FILES = [
  "analysis.html", "app.js", "fewshot.js", "segments.js", "result-compare.js", "result-labels.js",
  "standard-analytics.js", "standard-charts.js", "standard-editor.js", "analysis-state.js", "run-observer.js",
  "radio-group.js", "unsaved-state.js", "narrow-layout.js", "segment-list-rows.js", "styles.css", "ui-base.css",
];

// 「語彙」は、JSON で登録する開発者向けの欄（用語表）、分析方式の名前（案2）、推論原本に保存される品質警告の文（決定記録 4章「段階3で残した英語・旧用語」）だけに残す。
// except に当たる部分を除いた残りで調べる。
const OLD_WORDS = [
  { pattern: /確認対象/, use: "要確認" },
  { pattern: /標準記述/, use: "お手本の記述（お手本の説明）か、作業標準書" },
  { pattern: /タイムライン/, use: "時間バー" },
  { pattern: /\bJob\b/, use: "作業（作業名）" },
  { pattern: /AI予測|AI原本/, use: "自動判定" },
  { pattern: /(?<!作業)標準書PDF/, use: "作業標準書PDF" },
  { pattern: /語彙/, use: "作業名一覧", except: /案2：語彙補助の文章照合|語彙JSON|語彙（vocabulary\.v1）|語彙にないラベルです。再分析してください。/g },
];

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|<!--)/.test(line);
const findOldWords = (line) => (isCommentLine(line) ? [] : OLD_WORDS.filter(({ pattern, except }) => pattern.test(except ? line.replace(except, "") : line)).map(({ pattern }) => pattern.source));

test("old wording the glossary replaced is found, code names and comment lines are not", () => {
  assert.deepEqual(findOldWords("区間同期：Job ${segment.job_no}"), ["\\bJob\\b"]);
  assert.deepEqual(findOldWords("確認対象 ${r.review_count}"), ["確認対象"]);
  assert.deepEqual(findOldWords("一覧とタイムラインから削除します"), ["タイムライン"]);
  assert.deepEqual(findOldWords("ローカルの再生用動画、標準記述、代表画像"), ["標準記述"]);
  assert.deepEqual(findOldWords("const selectedJob = JOB_COLORS[segment.job_no];"), []);
  assert.deepEqual(findOldWords("  // 標準記述はお手本の記述のこと"), []);
  assert.deepEqual(findOldWords("<!-- Job No. の欄 -->"), []);
  assert.deepEqual(findOldWords("AI予測と比べます"), ["AI予測|AI原本"]);
  assert.deepEqual(findOldWords("AI原本を保存します"), ["AI予測|AI原本"]);
  assert.deepEqual(findOldWords("標準書PDFを選択してください。"), ["(?<!作業)標準書PDF"]);
  assert.deepEqual(findOldWords("作業標準書PDFを選択してください。"), []);
  assert.deepEqual(findOldWords("語彙を選んでください。"), ["語彙"]);
});

test("語彙 stays only where the glossary and decision record allow it, and an allowed use never hides another one on the same line", () => {
  assert.deepEqual(findOldWords('<label>語彙JSON<input id="vocabularyFile" type="file"></label>'), []);
  assert.deepEqual(findOldWords('<label>語彙（vocabulary.v1）<textarea id="draftVocabulary"></textarea></label>'), []);
  assert.deepEqual(findOldWords("<option>案2：語彙補助の文章照合</option>"), []);
  assert.deepEqual(findOldWords("add('OUT_OF_VOCABULARY', '語彙にないラベルです。再分析してください。', [s.segment_id], true);"), []);
  assert.deepEqual(findOldWords("語彙JSONと語彙の違い"), ["語彙"]);
});

test("no screen B file still shows 確認対象, 標準記述, タイムライン, Job, AI予測, AI原本, 標準書PDF or 語彙", () => {
  const offenders = [];
  for (const file of SCREEN_B_FILES) {
    fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8").split(/\r?\n/).forEach((line, index) => {
      for (const word of findOldWords(line)) {
        const { use } = OLD_WORDS.find(({ pattern }) => pattern.source === word);
        offenders.push(`public/${file}:${index + 1} ${word} -> ${use}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
