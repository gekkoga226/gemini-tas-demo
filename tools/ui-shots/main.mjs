// ui-shots: capture screens of a local mock (or static mock pages) and run automatic layout / readability checks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './cdp.mjs';
import { inspectPage } from './checks.mjs';
import { APP_SCENARIOS, SCENARIOS, pageScenario } from './scenarios.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_BASE = 'http://127.0.0.1:4180';
const DEFAULT_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEFAULT_VIEWPORTS = '1920x950,1600,1280,1000,720,400';
const REFUSED_PORT = '4173';
const LIMITS = { minFontPx: 12, minContrast: 4.5 };
const CHECKS = ['hscroll', 'overflow', 'clipped', 'small_text', 'contrast'];

const USAGE = `使い方: node tools/ui-shots/shoot.mjs [オプション]
  --base <URL>        接続先（既定 ${DEFAULT_BASE}。4173番とローカル以外は拒否）
  --label <名前>      出力フォルダ名（既定 日時）
  --out <フォルダ>    出力先（既定 .local/ui-shots/<名前>/）
  --viewports <一覧>  画面幅（既定 ${DEFAULT_VIEWPORTS}。高さを省くと1000）
  --scenarios <一覧>  撮る画面（既定 app = ${APP_SCENARIOS.join(', ')}。静的なモックは page）
  --paths <一覧>      page で開くパス（例 /index.html,/index.html?tab=memo）
  --few-run <ID>      お手本ありの結果に使う実行（既定 実行履歴で最新の完了分）
  --zero-run <ID>     お手本なしの結果に使う実行（既定 同上）
  --chrome <パス>     Chrome の場所（既定 環境変数 UI_SHOTS_CHROME、なければ ${DEFAULT_CHROME}）
  --no-full           ページ全体の画像を撮らない
  --overwrite         出力先に既にファイルがあっても書き込む
  --strict            違反が1件以上あれば終了コード1
終了コード: 0 正常 / 1 違反あり（--strict） / 2 指定・環境の誤り / 3 撮影できない画面あり`;

class UsageError extends Error {}

export async function main(argv) {
  let opts;
  try {
    opts = await prepare(argv);
  } catch (error) {
    if (error instanceof UsageError) { console.error(error.message); return 2; }
    throw error;
  }
  if (!opts) { console.log(USAGE); return 0; }
  try {
    return await run(opts);
  } catch (error) {
    console.error(`撮影を中止しました: ${error.message}`);
    return 3;
  }
}

async function prepare(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: {
      base: { type: 'string', default: DEFAULT_BASE }, label: { type: 'string' }, out: { type: 'string' },
      viewports: { type: 'string', default: DEFAULT_VIEWPORTS }, scenarios: { type: 'string', default: 'app' }, paths: { type: 'string' },
      'few-run': { type: 'string' }, 'zero-run': { type: 'string' }, chrome: { type: 'string' },
      'no-full': { type: 'boolean', default: false }, overwrite: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    } }));
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${USAGE}`);
  }
  if (values.help) return null;

  let base;
  try { base = new URL(values.base); } catch { throw new UsageError(`接続先の URL が正しくありません: ${values.base}`); }
  if (!/^https?:$/.test(base.protocol)) throw new UsageError('接続先は http:// か https:// で指定してください。');
  if ((base.port || (base.protocol === 'https:' ? '443' : '80')) === REFUSED_PORT) {
    throw new UsageError('4173番には接続しません（実接続のサーバーが動いていることがあるため）。別のポートで起動したモックを指定してください。');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new UsageError(`ローカル（127.0.0.1 / localhost）以外には接続しません: ${base.hostname}`);

  const viewports = values.viewports.split(',').map((spec) => {
    const m = /^(\d{3,4})(?:x(\d{3,4}))?$/.exec(spec.trim());
    if (!m) throw new UsageError(`画面幅の指定が正しくありません: ${spec}（例 1920x950,1600）`);
    return { width: Number(m[1]), height: Number(m[2] ?? 1000) };
  });

  const scenarios = [];
  for (const name of values.scenarios.split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => (s === 'app' ? APP_SCENARIOS : [s]))) {
    if (name === 'page') {
      const paths = (values.paths ?? '').split(',').map((p) => p.trim()).filter(Boolean);
      if (!paths.length) throw new UsageError('page には --paths でパスを指定してください（例 --paths /index.html）。');
      const wrong = paths.find((p) => !p.startsWith('/') || p.startsWith('//'));
      if (wrong) throw new UsageError(`--paths は接続先の中の「/」で始まるパスで指定してください: ${wrong}\n（Git Bash では「/」が書き換えられるため、MSYS_NO_PATHCONV=1 を付けて実行してください）`);
      scenarios.push(...paths.map(pageScenario));
    } else if (SCENARIOS[name]) scenarios.push({ id: name, file: name, ...SCENARIOS[name] });
    else throw new UsageError(`不明なシナリオです: ${name}（使えるもの: app, page, ${Object.keys(SCENARIOS).join(', ')}）`);
  }

  const chrome = values.chrome ?? process.env.UI_SHOTS_CHROME ?? DEFAULT_CHROME;
  try { await fs.access(chrome); } catch { throw new UsageError(`Chrome が見つかりません: ${chrome}\n--chrome か環境変数 UI_SHOTS_CHROME で場所を指定してください。`); }

  const label = values.label ?? timestamp();
  if (!/^[\w.-]+$/.test(label)) throw new UsageError(`ラベルには英数字と「-」「_」「.」だけを使ってください: ${label}`);
  const out = path.resolve(values.out ?? path.join(REPO, '.local', 'ui-shots', label));
  const existing = await fs.readdir(out).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  if (existing.length && !values.overwrite) {
    throw new UsageError(`出力先に既にファイルがあります: ${out}\n別の --label を指定するか、上書きしてよい場合だけ --overwrite を付けてください。`);
  }

  const server = await probe(base);
  if (server === 'bad-port') throw new UsageError(`ポート${base.port}はブラウザが接続を拒否する番号です（例：4190）。別のポートでサーバーを起動してください。`);
  if (server === 'unreachable') throw new UsageError(`接続先に接続できません: ${base.origin}（先にモックのサーバーを起動してください）`);
  if (server !== 'mock' && server !== 'static') throw new UsageError(`接続先はモックではありません（mode: ${server}）。実接続のサーバーには接続しません。`);

  const runs = { few: values['few-run'] ?? null, zero: values['zero-run'] ?? null };
  for (const id of Object.values(runs)) if (id && !/^[\w-]{1,100}$/.test(id)) throw new UsageError(`実行IDが正しくありません: ${id}`);
  if (server === 'mock' && scenarios.some((s) => s.needs && !runs[s.needs])) Object.assign(runs, await latestRuns(base, runs));

  return { base, viewports, scenarios, chrome, server, runs, label, out, full: !values['no-full'], strict: values.strict };
}

async function probe(base) {
  let response;
  try { response = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(5000) }); } catch (error) { return error.cause?.message === 'bad port' ? 'bad-port' : 'unreachable'; }
  if (!response.ok || !/json/.test(response.headers.get('content-type') ?? '')) return 'static';
  const body = await response.json().catch(() => ({}));
  return body.mode === 'mock' ? 'mock' : String(body.mode ?? 'unknown');
}

// Read-only: the run history is sorted newest first.
async function latestRuns(base, runs) {
  try {
    const { runs: list } = await (await fetch(new URL('/api/analysis-runs', base), { signal: AbortSignal.timeout(10000) })).json();
    const pick = (mode) => list.find((r) => r.result_available && r.analysis_mode === mode)?.run_id ?? null;
    return { few: runs.few ?? pick('few_shot'), zero: runs.zero ?? pick('zero_shot') };
  } catch {
    return runs;
  }
}

async function run(opts) {
  await fs.mkdir(opts.out, { recursive: true });
  const started = new Date();
  const browser = await launchChrome(opts.chrome);
  const stop = () => { browser.close().finally(() => process.exit(130)); };
  process.once('SIGINT', stop);
  const screens = [];
  let chrome = null;
  try {
    chrome = (await browser.session.send('Browser.getVersion').catch(() => null))?.product ?? null;
    const page = await createPage(browser.session, opts);
    for (const viewport of opts.viewports) {
      await page.viewport(viewport);
      for (const scenario of opts.scenarios) screens.push(await capture(page, scenario, viewport, opts));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    await browser.close();
  }
  const report = {
    tool: 'ui-shots', schema_version: 1, label: opts.label, base: opts.base.origin, server: opts.server,
    started_at: started.toISOString(), finished_at: new Date().toISOString(), node: process.version, chrome,
    limits: { min_font_px: LIMITS.minFontPx, min_contrast: LIMITS.minContrast }, runs: opts.runs, totals: totals(screens), screens,
  };
  await fs.writeFile(path.join(opts.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const summary = summarize(report, opts.out);
  await fs.writeFile(path.join(opts.out, 'summary.txt'), summary + '\n');
  console.log('\n' + summary);
  if (screens.some((s) => s.status === 'error')) return 3;
  return opts.strict && report.totals.violations > 0 ? 1 : 0;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

async function createPage(session, opts) {
  const log = [];
  const blocked = [];
  let current = opts.viewports[0];
  session.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => log.push(`exception: ${d.exception?.description ?? d.text}`.slice(0, 300)));
  session.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'error' || type === 'assert') log.push(`console.${type}: ${args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
  });
  session.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') log.push(`${entry.source}: ${entry.text} ${entry.url ?? ''}`.trim().slice(0, 300)); });
  // View-only guard: only GET/HEAD/OPTIONS to the target origin reach the network; everything else is blocked and recorded.
  session.on('Fetch.requestPaused', ({ requestId, request }) => {
    const sameOrigin = (() => { try { return new URL(request.url).origin === opts.base.origin; } catch { return false; } })();
    if (sameOrigin && ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) { session.send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    blocked.push(`${request.method} ${request.url}`);
    session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
  });
  for (const domain of ['Page', 'Runtime', 'Log']) await session.send(`${domain}.enable`);
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  const evaluate = async (expression) => {
    const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 60000);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const navigate = async (url) => {
    let off;
    const loaded = new Promise((resolve) => { off = session.on('Page.loadEventFired', resolve); });
    try {
      const r = await session.send('Page.navigate', { url });
      if (r.errorText) throw new Error(`${url} を開けません: ${r.errorText}`);
      if (r.loaderId) await withTimeout(loaded, 20000, `${url} の読み込みが終わりません`);
    } finally {
      off();
    }
  };
  return {
    runs: opts.runs,
    async viewport(v) {
      current = v;
      await session.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.width < 768 });
    },
    async reset() { log.length = 0; blocked.length = 0; await navigate('about:blank'); },
    goto(target) {
      const url = new URL(target, opts.base);
      if (url.origin !== opts.base.origin) throw new Error(`接続先以外には移動しません: ${url.href}`);
      return navigate(url.href);
    },
    eval: evaluate,
    async press(key) {
      const codes = {ArrowLeft:37,ArrowRight:39,Home:36,End:35};
      if (!codes[key]) throw new Error(`未対応の確認用キー: ${key}`);
      const params = {key,code:key,windowsVirtualKeyCode:codes[key],nativeVirtualKeyCode:codes[key]};
      await session.send('Input.dispatchKeyEvent', {type:'keyDown',...params});
      await session.send('Input.dispatchKeyEvent', {type:'keyUp',...params});
    },
    async waitFor(expression, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await evaluate(`Boolean(${expression})`).catch(() => false)) return true;
        await sleep(150);
      }
      return false;
    },
    async settle(ms = 500) { await evaluate('document.fonts.ready.then(() => true)'); await sleep(ms); },
    async shot(file, { full = false } = {}) {
      let params = { format: 'png' };
      if (full) {
        await evaluate('window.scrollTo(0, 0)');
        await sleep(200);
        const { cssContentSize: size } = await session.send('Page.getLayoutMetrics');
        const width = Math.min(Math.ceil(Math.max(current.width, size.width)), current.width * 2);
        params = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(Math.ceil(size.height), 16000), scale: 1 } };
      }
      const { data } = await session.send('Page.captureScreenshot', params, 60000);
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      return path.basename(file);
    },
    check: (scope) => evaluate(`(${inspectPage})(${JSON.stringify({ scope, ...LIMITS })})`),
    log: () => [...log],
    blocked: () => [...blocked],
  };
}

async function capture(page, scenario, viewport, opts) {
  const size = `${viewport.width}x${viewport.height}`;
  const screen = { scenario: scenario.id, title: scenario.title, viewport: size, status: 'ok', screenshots: [] };
  if (scenario.id === 'page') screen.path = scenario.title;
  if (scenario.needs && !opts.runs[scenario.needs]) {
    Object.assign(screen, { status: 'skipped', reason: `${scenario.needs === 'few' ? 'お手本あり' : 'お手本なし'}の完了した結果がありません` });
  } else {
    try {
      await page.reset();
      await scenario.run(page);
      screen.url = await page.eval('location.href');
      const name = `${scenario.file}_${size}`;
      screen.screenshots.push(await page.shot(path.join(opts.out, `${name}.png`)));
      screen.checks = await page.check(scenario.scope);
      screen.violations = { ...screen.checks.counts, total: CHECKS.reduce((sum, k) => sum + screen.checks.counts[k], 0) };
      if (opts.full && scenario.full !== false) screen.screenshots.push(await page.shot(path.join(opts.out, `${name}_full.png`), { full: true }));
    } catch (error) {
      Object.assign(screen, { status: 'error', reason: error.message });
    }
    screen.console_errors = page.log();
    screen.blocked_requests = page.blocked();
  }
  console.log(`  ${size} ${scenario.id}${screen.path ? ' ' + screen.path : ''}: ${screen.status === 'ok' ? `違反 ${screen.violations.total}` : screen.status}`);
  return screen;
}

function totals(screens) {
  const t = { screens: screens.length, ok: 0, skipped: 0, error: 0, violations: 0, hscroll: 0, overflow: 0, clipped: 0, small_text: 0, contrast: 0,
    contrast_excluded: { image: 0, media: 0, disabled: 0 } };
  for (const s of screens) {
    t[s.status]++;
    if (s.status !== 'ok') continue;
    for (const k of CHECKS) t[k] += s.violations[k];
    t.violations += s.violations.total;
    for (const k of Object.keys(t.contrast_excluded)) t.contrast_excluded[k] += s.checks.contrast_excluded[k];
  }
  return t;
}

function hotspots(screens) {
  const groups = new Map();
  const add = (check, item, screen, detail) => {
    const key = `${check}|${item.selector}`;
    const group = groups.get(key) ?? { check, item, detail, count: 0, screens: new Set() };
    group.count++;
    group.screens.add(`${screen.scenario}@${screen.viewport}`);
    groups.set(key, group);
  };
  for (const s of screens.filter((x) => x.status === 'ok')) {
    for (const o of s.checks.page.offenders) add('横スクロール', o, s, `右端 ${o.right}px`);
    for (const o of s.checks.overflow) add('はみ出し', o, s, `${o.scroll_width}px > 枠 ${o.client_width}px${o.ellipsis ? '（…で省略）' : o.cut ? '（切れる）' : ''}`);
    for (const o of s.checks.clipped) add('中身が切れる', o, s, `${o.scroll_height}px > 枠 ${o.client_height}px（${o.hidden_px}px 見えない）`);
    for (const o of s.checks.small_text) add('12px未満', o, s, `${o.font_px}px`);
    for (const o of s.checks.contrast) add('コントラスト', o, s, `${o.ratio}:1（文字 ${o.color} / 背景 ${o.background}）`);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
    .map((g) => `- [${g.check}] ${g.item.selector}「${g.item.text}」 ${g.detail} … ${g.count}件・${g.screens.size}画面`);
}

function summarize(report, out) {
  const t = report.totals;
  const lines = [
    `ui-shots ${report.label}`,
    `接続先: ${report.base}（${report.server === 'mock' ? 'モック' : '静的ページ'}）  出力: ${out}`,
    `画面×幅: ${t.screens}件（撮影 ${t.ok}・省略 ${t.skipped}・エラー ${t.error}）`,
    `違反の合計: ${t.violations}件（横スクロール ${t.hscroll}画面、はみ出し ${t.overflow}、中身が切れる ${t.clipped}、12px未満 ${t.small_text}、コントラスト4.5:1未満 ${t.contrast}）`,
    `コントラストの対象外: 画像・グラデーションの上 ${t.contrast_excluded.image}、動画・画像の上 ${t.contrast_excluded.media}、無効化された操作 ${t.contrast_excluded.disabled}`,
    '',
    '画面ごと（横スクロール / はみ出し / 中身が切れる / 12px未満 / コントラスト、縦の長さ）:',
  ];
  for (const s of report.screens) {
    const head = `- ${s.scenario}${s.path ? ' ' + s.path : ''} ${s.viewport}`;
    if (s.status !== 'ok') { lines.push(`${head}: ${s.status === 'skipped' ? '省略' : 'エラー'}（${s.reason}）`); continue; }
    const v = s.violations;
    const p = s.checks.page;
    lines.push(`${head}: ${v.hscroll ? 'あり' : 'なし'} / ${v.overflow} / ${v.clipped} / ${v.small_text} / ${v.contrast}、縦 ${p.vscroll ? `${p.scroll_height}px（スクロールあり）` : '画面内に収まる'}`
      + (s.blocked_requests.length ? `  ※遮断した通信 ${s.blocked_requests.length}件` : ''));
  }
  const top = hotspots(report.screens);
  if (top.length) lines.push('', '主な場所（件数の多い順、上位15）:', ...top.slice(0, 15));
  return lines.join('\n');
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
