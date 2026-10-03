// Screens to capture. Scenarios read results and change display controls; they never start, save, register or delete.
// `scope` limits the element-level checks to the part of the page that belongs to the screen.
export const APP_SCENARIOS = ['b-new', 'b-history', 'b-library', 'b-library-set', 'b-result-zero', 'b-result-few', 'b-result-few-pending', 'b-result-few-memo', 'b-library-tables', 'b-result-zero-total', 'b-result-zero-occurrence', 'b-result-zero-reviewed', 'b-result-zero-analytics', 'b-result-zero-segments', 'b-result-zero-memo', 'b-help'];

const resultShown = "!document.querySelector('#workspace')?.hidden && document.querySelectorAll('#segmentList .segment-row').length > 0";

async function openResult(page, runId, allowEmpty = false) {
  await page.goto('/analysis.html?new=1');
  await page.eval(`localStorage.setItem('tas-active-run', ${JSON.stringify(runId)})`);
  await page.goto('/analysis.html');
  if (!await page.waitFor(allowEmpty ? "!document.querySelector('#workspace')?.hidden && document.querySelector('#tab-st')?.getAttribute('aria-selected') === 'true'" : resultShown, 20000)) throw new Error(`結果画面が表示されませんでした（${runId}）`);
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
  'b-result-zero-empty': {
    title:'B お手本なし・区間なし（合成の表示確認用）',scope:['#workspace'],needs:'zero',full:false,
    async run(page){await openResult(page,page.runs.zero,true);await page.eval("document.querySelector('#tab-segments').click()");await page.settle();},
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
  'b-library-tables': {
    title:'B お手本ライブラリ（表と出典を展開）', scope:['#setManager'], full:false,
    async run(page) {
      await SCENARIOS['b-library-set'].run(page);
      await page.eval("document.querySelectorAll('#setInspection > details').forEach(d=>d.open=true)");
      await page.eval("document.querySelector('#standardAnalytics .table-scroll').scrollIntoView({block:'center'})");
      await page.settle(600);
    },
  },
  'b-result-zero-total': {
    title:'B お手本なし・合計',scope:['#workspace'],needs:'zero',full:false,
    async run(page){await openResult(page,page.runs.zero);await page.eval("document.querySelector('[data-st-mode=total]').click()");await page.settle();},
  },
  'b-result-zero-occurrence': {
    title:'B お手本なし・1回ごと',scope:['#workspace'],needs:'zero',full:false,
    async run(page){await openResult(page,page.runs.zero);await page.eval("document.querySelector('[data-st-mode=occurrence]').click()");await page.settle();},
  },
  'b-result-zero-reviewed': {
    title:'B お手本なし・修正後',scope:['#workspace'],needs:'zero',full:false,
    async run(page){await openResult(page,page.runs.zero);await page.eval("document.querySelector('[data-st-source=reviewed]').click()");await page.settle();},
  },
  'b-result-zero-analytics': {
    title:'B お手本なし・時間の分析を開く',scope:['#workspace'],needs:'zero',full:false,
    async run(page){await openResult(page,page.runs.zero);await page.eval("document.querySelector('#zeroAnalyticsDisclosure').open=true");await page.eval("document.querySelector('#zeroAnalyticsDisclosure').scrollIntoView({block:'start'})");await page.settle();},
  },
  'b-result-zero-segments': {
    title:'B お手本なし・区間',scope:['#workspace'],needs:'zero',full:false,
    async run(page){await openResult(page,page.runs.zero);await page.eval("document.querySelector('#tab-segments').click()");await page.settle();},
  },
  'b-result-zero-memo': {
    title:'B お手本なし・メモ',scope:['#workspace'],needs:'zero',full:false,
    async run(page){await openResult(page,page.runs.zero);await page.eval("document.querySelector('#tab-memo').click()");await page.settle();},
  },
  'b-keyboard': {
    title:'B STのタブと表の矢印キー',scope:['#setManager'],needs:'zero',full:false,
    async run(page) {
      await openResult(page,page.runs.zero);
      await page.eval("document.querySelector('#tab-st').focus()");
      for(const [key,id] of [['ArrowRight','tab-segments'],['End','tab-memo'],['Home','tab-st'],['ArrowLeft','tab-memo']]) {
        await page.press(key);
        if(!await page.eval(`document.activeElement.id === ${JSON.stringify(id)} && document.activeElement.getAttribute('aria-selected') === 'true'`))throw new Error(`タブのキー移動失敗: ${key}`);
      }
      await SCENARIOS['b-library-tables'].run(page);
      const scrollable=await page.eval("(() => {const region=document.querySelector('#standardAnalytics .table-scroll');region.focus();return region.scrollWidth>region.clientWidth;})()");
      if(scrollable){await page.press('ArrowRight');await page.settle(500);if(!await page.eval("document.querySelector('#standardAnalytics .table-scroll').scrollLeft>0"))throw new Error('表の横スクロールがキーで動きません');}
    },
  },
  'b-help': {
    title:'B 使い方',scope:['#usageDialog'],full:false,
    async run(page){await SCENARIOS['b-new'].run(page);await page.eval("document.querySelector('#openUsage').click()");await page.settle();},
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
