import {summarizeStandards,compareStandards} from './standard-analytics.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const seconds=n=>n==null?'—':`${Number(n.toFixed(2))}秒`;
const COLORS=['#3d65b0','#327e71','#97672e','#8065a6','#4e7690','#a55465','#617a3c','#56647a'];

export function renderStandardCharts(container,set,{actual=null,onSelect=()=>{}}={}) {
  const data=summarizeStandards(set,actual);
  if(!data.sources.length){container.replaceChildren();return;}
  const standards=data.sources.filter(s=>s.kind==='standard');
  const maxSample=Math.max(1,...data.processes.map(p=>p.max_s??0));
  const color=i=>COLORS[i%COLORS.length];
  container.innerHTML=`<section class="analytics-section"><h3>お手本の時間を見比べる</h3>
    <p class="hint">${set.provenance?.synthetic?'合成サンプルの数値です。実際の作業時間・精度を示しません。 ':''}${set.status==='ready'||set.status==='retired'?'公開時に確認した':'公開前の確認用'}作業区間を集計。比較結果は人が映像を確認して判断してください。</p>
    <div class="analytics-metrics"><div><strong>${standards.length}<small> 本</small></strong>お手本動画</div><div><strong>${data.processes.length}<small> 工程</small></strong>表示する工程</div><div><strong>${standards.reduce((n,s)=>n+s.display_segments.length,0)}<small> 区間</small></strong>時間分布のサンプル</div></div>
    <h4>山積み表 <small>動画内の工程合計時間（秒）</small></h4>
    <p class="hint">各棒は動画1本の全区間。同じ工程の繰り返しは合計します。サイクル数が違う動画は、合計時間だけで優劣を判断できません。縦軸の上限 ${seconds(data.max_total_s)}。</p>
    <div class="stack-scroll"><div class="stack-chart" aria-label="動画ごとの工程合計時間">${data.sources.map(source=>{
      const total=source.display_segments.reduce((n,s)=>n+s.end_s-s.start_s,0);
      return `<div class="stack-column"><strong>${seconds(total)}</strong><div class="stack-bar" data-height="${220*total/data.max_total_s}">${data.processes.map((p,i)=>{const t=p.totals.find(t=>t.source_id===source.source_id);return t.count?`<button class="stack-piece" type="button" data-source="${esc(source.source_id)}" data-job="${esc(p.job_no)}" data-height="${220*t.total_s/data.max_total_s}" data-color="${i}" title="${esc(source.name)}・${esc(p.job_title)} ${seconds(t.total_s)}・${t.count}区間" aria-label="${esc(source.name)}・${esc(p.job_title)} ${seconds(t.total_s)}・${t.count}区間を映像で確認">${220*t.total_s/data.max_total_s>25?esc(p.job_no):''}</button>`:'';}).join('')}</div></div>`;
    }).join('')}</div><div class="stack-names">${data.sources.map(s=>`<div class="stack-name">${esc(s.name)}</div>`).join('')}</div></div>
    <div class="chart-legend">${data.processes.map((p,i)=>`<span><i data-color="${i}"></i>${esc(p.job_no)} ${esc(p.job_title)}</span>`).join('')}</div>
    <h4>工程別の時間分布 <small>お手本の1区間ごと</small></h4><p class="hint">点を選ぶと出典の映像へ移動します。繰り返しも1件ずつ数え、工程のない動画は集計に含めません。今回の自動判定はこの分布に混ぜません。</p>
    <div class="table-scroll"><table class="analytics-table"><caption class="hint">単位：秒 ／ 分布の横軸 0〜${Number(maxSample.toFixed(2))}</caption><thead><tr><th scope="col">工程</th><th scope="col">分布</th><th scope="col">件数 / 動画数</th><th scope="col">最短</th><th scope="col">中央値</th><th scope="col">平均</th><th scope="col">最長</th></tr></thead><tbody>${data.processes.map(p=>`<tr><th scope="row">${esc(p.job_no)} ${esc(p.job_title)}</th><td class="range-cell"><span class="range-track">${p.count?`<span class="range-line" data-left="${2+p.min_s/maxSample*96}" data-width="${(p.max_s-p.min_s)/maxSample*96}"></span>${p.samples.map((sample,i)=>`<button type="button" class="range-dot" data-left="${2+sample.duration_s/maxSample*96}" data-top="${i%2?10:3}" data-source="${esc(sample.source_id)}" data-segment="${esc(sample.segment_id)}" data-job="${esc(p.job_no)}" aria-label="${esc(data.sources.find(s=>s.source_id===sample.source_id).name)}・${esc(p.job_title)} ${seconds(sample.duration_s)}を確認" title="${esc(data.sources.find(s=>s.source_id===sample.source_id).name)} ${seconds(sample.duration_s)}"></button>`).join('')}`:''}</span></td><td>${p.count} / ${p.video_count}</td><td>${seconds(p.min_s)}</td><td>${seconds(p.median_s)}</td><td>${seconds(p.mean_s)}</td><td>${seconds(p.max_s)}</td></tr>`).join('')}</tbody></table></div>
    <div class="compare-block"><h4>動画間の比較</h4><p class="hint">同じ工程の合計時間を比較します。差は「右 − 左」。工程がない側は「該当なし」、差は「—」です。</p>
    <div class="comparison-players">${['left','right'].map(side=>`<div><label>${side==='left'?'左：比較の基準':'右：比べる動画'}<select data-side="${side}">${data.sources.map(source=>`<option value="${esc(source.source_id)}">${esc(source.name)}</option>`).join('')}</select></label><video data-player="${side}" controls preload="metadata" playsinline></video><p data-media-status="${side}"></p></div>`).join('')}</div>
    <p class="analytics-detail" role="status">グラフの工程、または下の「映像で確認」を選んでください。</p>
    <div class="table-scroll"><table class="analytics-table"><thead><tr><th scope="col">工程</th><th scope="col">左の合計 / 区間数</th><th scope="col">右の合計 / 区間数</th><th scope="col">差（右 − 左）</th><th scope="col">映像</th></tr></thead><tbody data-comparison-rows></tbody></table></div></div>
  </section>`;
  // CSP rejects HTML style attributes. Apply calculated geometry through CSSOM.
  for(const node of container.querySelectorAll('[data-height],[data-left],[data-width],[data-top],[data-color]')) {
    for(const [key,unit] of [['height','px'],['left','%'],['width','%'],['top','px']])if(node.dataset[key]!==undefined)node.style[key]=`${Number(node.dataset[key])}${unit}`;
    if(node.dataset.color!==undefined)node.style.backgroundColor=color(Number(node.dataset.color));
  }
  const find=selector=>container.querySelector(selector);
  const left=find('[data-side=left]'),right=find('[data-side=right]');
  right.value=data.sources.at(-1).source_id;
  if(data.sources.length<2)find('.compare-block').hidden=true;
  function refreshComparison() {
    for(const [side,selector] of [['left',left],['right',right]]) {
      const source=data.sources.find(s=>s.source_id===selector.value),player=find(`[data-player=${side}]`),status=find(`[data-media-status=${side}]`);
      player.pause();status.textContent=source.video_available===false?'ローカル動画が見つかりません。集計と出典は保持しています。':`${source.name} · ${seconds(source.source_video.duration_s)}`;
      player.hidden=source.video_available===false;
      if(source.video_available!==false)player.src=`/api/media/${encodeURIComponent(source.source_video.video_id)}/content`;else player.removeAttribute('src');
      player.onerror=()=>{status.textContent='動画を再生できません。元動画の保存状態・形式を確認してください。';player.hidden=true;};
    }
    find('[data-comparison-rows]').innerHTML=left.value===right.value?'<tr><td colspan="5">同じ動画は比較できません。異なる動画を選んでください。</td></tr>':compareStandards(data,left.value,right.value).map(p=>`<tr><th scope="row">${esc(p.job_no)} ${esc(p.job_title)}</th><td>${p.left.count?`${seconds(p.left.total_s)} / ${p.left.count}区間`:'該当なし'}</td><td>${p.right.count?`${seconds(p.right.total_s)} / ${p.right.count}区間`:'該当なし'}</td><td>${p.delta_s==null?'—':`${p.delta_s>0?'+':''}${seconds(p.delta_s)}`}</td><td><button type="button" class="table-jump" data-compare-job="${esc(p.job_no)}">映像で確認</button></td></tr>`).join('');
  }
  function seekPlayer(side,source,segment) {
    const player=find(`[data-player=${side}]`);if(!segment||source.video_available===false)return;
    const apply=()=>{player.currentTime=segment.start_s;};
    if(player.readyState>=1)apply();else player.addEventListener('loadedmetadata',apply,{once:true});
  }
  container.onclick=event=>{
    const sample=event.target.closest('[data-source]'),compare=event.target.closest('[data-compare-job]');
    if(sample) {
      const source=data.sources.find(s=>s.source_id===sample.dataset.source),segment=source.display_segments.find(s=>sample.dataset.segment?s.segment_id===sample.dataset.segment:s.job_no===sample.dataset.job);
      left.value=source.source_id;refreshComparison();seekPlayer('left',source,segment);
      find('.analytics-detail').textContent=`${source.name} ／ ${segment.job_title} ／ ${seconds(segment.start_s)}〜${seconds(segment.end_s)}（${seconds(segment.end_s-segment.start_s)}）`;
      onSelect(source,segment);find('.comparison-players').scrollIntoView({block:'nearest'});
    } else if(compare) {
      const parts=[];
      for(const [side,select] of [['left',left],['right',right]]) {const source=data.sources.find(s=>s.source_id===select.value),segment=source.display_segments.find(s=>s.job_no===compare.dataset.compareJob);seekPlayer(side,source,segment);parts.push(`${source.name}：${segment?`${seconds(segment.start_s)}から`:'対応区間なし'}`);}
      find('.analytics-detail').textContent=parts.join(' ／ ')+'。繰り返しがある工程は最初の区間へ移動します。再生は左右で個別に操作できます。';
    }
  };
  left.onchange=right.onchange=refreshComparison;refreshComparison();
}
