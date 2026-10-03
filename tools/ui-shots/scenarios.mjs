// Screens to capture. Scenarios only open, wait and scroll: they never press start, save, register or delete.
// `scope` limits the element-level checks to the part of the page that belongs to the screen.
export const APP_SCENARIOS = ['b-new', 'b-history', 'b-library', 'b-library-set', 'b-result-zero', 'b-result-few', 'b-result-few-pending', 'b-result-few-memo', 'a-workspace'];

const resultShown = "!document.querySelector('#workspace')?.hidden && document.querySelectorAll('#segmentList .segment-row').length > 0";

async function openResult(page, runId) {
  await page.goto('/analysis.html?new=1');
  await page.eval(`localStorage.setItem('tas-active-run', ${JSON.stringify(runId)})`);
  await page.goto('/analysis.html');
  if (!await page.waitFor(resultShown, 20000)) throw new Error(`結果画面が表示されませんでした（${runId}）`);
  await page.eval("document.querySelector('#workspace').scrollIntoView({ block: 'start' })");
  await page.settle(800);
}

export const SCENARIOS = {
  'b-new': {
    title: 'B 新しい分析', scope: ['.work-return', '.app-header', '.analysis-launch', '.status-card'],
    async run(page) {
      await page.goto('/analysis.html?new=1');
      await page.waitFor("document.querySelector('#modeBadge')?.textContent.trim() !== '接続を確認中'", 5000);
      await page.settle();
    },
  },
  'b-history': {
    title: 'B 実行履歴', scope: ['.history-card'],
    async run(page) {
      await page.goto('/analysis.html?new=1');
      await page.waitFor("document.querySelector('#historyList')?.children.length > 0", 5000);
      await page.eval("document.querySelector('#historyTitle').scrollIntoView({ block: 'start' })");
      await page.settle();
    },
  },
  'b-library': {
    title: 'B お手本ライブラリ', scope: ['#setManager'],
    async run(page) {
      await page.goto('/analysis.html?new=1#library');
      if (!await page.waitFor("document.querySelector('#setManager') && !document.querySelector('#setManager').hidden", 8000)) {
        throw new Error('お手本ライブラリが開きませんでした');
      }
      await page.settle(800);
    },
  },
  'b-library-set': {
    title: 'B お手本ライブラリ（保存済みセットを表示）', scope: ['#setManager'],
    async run(page) {
      await SCENARIOS['b-library'].run(page);
      // Choosing a saved set only reads its inspection (GET); nothing is approved or retired.
      const chosen = await page.eval(`(() => {
        const select = document.querySelector('#librarySet');
        const option = [...(select?.options ?? [])].find((o) => o.value);
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!chosen) throw new Error('保存済みのお手本セットがありません');
      if (!await page.waitFor("document.querySelector('#setInspection')?.children.length > 0", 8000)) throw new Error('セットの内容が表示されませんでした');
      await page.eval("document.querySelector('#setManager').scrollIntoView({ block: 'start' })");
      await page.settle(800);
    },
  },
  'b-result-zero': {
    title: 'B 結果（お手本なし）', scope: ['#workspace'], needs: 'zero',
    run: (page) => openResult(page, page.runs.zero),
  },
  'b-result-few': {
    title: 'B 結果（お手本あり）', scope: ['#workspace'], needs: 'few',
    run: (page) => openResult(page, page.runs.few),
  },
  'b-result-few-pending': {
    title: 'B 結果（お手本あり・最初の要確認を選択）', scope: ['#workspace'], needs: 'few', full: false,
    async run(page) {
      await openResult(page, page.runs.few);
      await page.eval("document.querySelector('#firstPending')?.click()");
      await page.settle(900);
    },
  },
  'b-result-few-memo': {
    title: 'B 結果（お手本あり・メモタブ）', scope: ['#workspace'], needs: 'few', full: false,
    async run(page) {
      await openResult(page, page.runs.few);
      await page.eval("document.querySelector('#tab-memo').click()");
      await page.settle(600);
    },
  },
  'a-workspace': {
    title: 'A 動画と作業区間（廃止予定・記録用）', scope: ['body'],
    async run(page) {
      await page.goto('/review.html');
      if (!await page.waitFor("document.querySelector('.nav-item[data-view=\"workspace\"]')", 8000)) throw new Error('A の画面が表示されませんでした');
      await page.eval("document.querySelector('.nav-item[data-view=\"workspace\"]').click()");
      await page.eval('window.scrollTo(0, 0)');
      await page.settle(600);
    },
  },
};

// Any page of a static mock, e.g. --paths /index.html,/index.html?tab=memo
export function pageScenario(target) {
  return {
    id: 'page', file: 'page-' + (target.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root'),
    title: target, scope: ['body'],
    async run(page) { await page.goto(target); await page.settle(600); },
  };
}
