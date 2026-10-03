import {stComparison} from './st-comparison.js';
const esc = value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const seconds = value=>value===null?'—':`${Number(value.toFixed(1))}秒`;
const signed = value=>{if(value===null)return '—';const rounded=Number(value.toFixed(1));return `${rounded>0?'+':rounded<0?'−':'±'}${seconds(Math.abs(rounded))}`;};
const statuses = {'no-st':'ST未登録',unlisted:'一覧にない', 'non-work':'作業以外', 'no-list':'一覧なし'};
const headings = {average:['1回あたり','ST'],total:['合計','ST×区間数'],occurrence:['長さ','ST']};

export function renderStViews({table,summary,missing,analytics,segments,labels,mode,selectedId}) {
  const focusedAnalytics = analytics.contains(document.activeElement) ? document.activeElement.closest('[data-st-job]') : null;
  const analyticsFocus = focusedAnalytics ? {job:focusedAnalytics.dataset.stJob,segment:focusedAnalytics.dataset.stSegment} : null;
  const data = stComparison(segments,labels,mode);
  const focusedKey = table.contains(document.activeElement) ? document.activeElement.closest('[data-st-key]')?.dataset.stKey : null;
  const [targetHeading,stHeading] = headings[mode];
  const emptyReason = !segments.length ? '表示する区間はありません。' : !data.hasList ? 'この結果には作業名一覧が付いていないため、STとの比較はできません。対象の時間だけを表示します。' : !data.total.job_count ? (labels.some(label=>label.kind==='work'&&Number.isFinite(label.standard_duration_s)&&label.standard_duration_s>0)?'この表示元にはSTと比較できる作業の区間がありません。対象の時間だけを表示します。':'STが登録された作業がないため、差を比較できません。対象の時間だけを表示します。') : '';
  table.innerHTML = `${emptyReason?`<p class="empty-state">${emptyReason}</p>`:''}<div class="st-head" aria-hidden="true"><span>作業</span><span>${targetHeading}</span><span>${stHeading}</span><span>差</span></div>` + data.rows.map(row=>
    `<button type="button" class="st-row" data-st-key="${esc(row.key)}" data-st-job="${esc(row.job_no)}" ${row.segment_id?`data-st-segment="${esc(row.segment_id)}"`:''} aria-current="${mode==='occurrence'?row.segment_id===selectedId:segments.find(segment=>segment.segment_id===selectedId)?.job_no===row.job_no}"><span class="st-name"><b>${esc(row.job_title)}</b><small>No.${esc(row.job_no)} · ${mode==='occurrence'?`${row.occurrence}/${row.count}回目`:row.count>1?`${row.count}区間の${mode==='total'?'合計':'平均'}`:'1区間'}${statuses[row.status]?` · ${statuses[row.status]}`:''}</small></span><span>${seconds(row.target_s)}</span><span>${seconds(row.st_s)}</span><span class="st-delta">${signed(row.diff_s)}</span></button>`).join('');
  if (focusedKey) [...table.querySelectorAll('[data-st-key]')].find(row=>row.dataset.stKey===focusedKey)?.focus({preventScroll:true});
  summary.textContent = `合計（STのある作業 ${data.total.job_count}件）：対象の時間 ${seconds(data.total.target_s)} ／ ST×区間数 ${seconds(data.total.st_s)} ／ 差 ${signed(data.total.diff_s)}。ST未登録・一覧外・作業以外の ${seconds(data.total.excluded_s)}は比較の合計に含みません。`;
  missing.hidden = !data.absent.length;
  missing.querySelector('summary').textContent = `この動画に出てこない作業（${data.absent.length}）`;
  missing.querySelector('ul').innerHTML = data.absent.map(label=>`<li>${esc(label.job_title)} · ST ${seconds(label.standard_duration_s)} · 該当する区間はありません（0秒ではありません）</li>`).join('');
  const groups = [...data.groups].sort((a,b)=>b.total_s-a.total_s || a.order-b.order);
  analytics.innerHTML = `<h3>対象動画の時間の内訳</h3><p class="hint">表示する区間の合計 ${seconds(data.total.all_s)}。作業以外も含みます。人の修正は自動判定の集計に混ぜません。</p><ul class="zero-time-list">` + groups.map(group=>
    `<li><button type="button" class="zero-time-pick" data-st-job="${esc(group.job_no)}"><span>${esc(group.job_title)}<small>${group.count}区間${statuses[group.status]?` · ${statuses[group.status]}`:''}</small></span><span>${seconds(group.total_s)}（${data.total.all_s?Math.round(group.total_s/data.total.all_s*100):0}%）</span></button><div class="zero-time-track" aria-hidden="true"><i data-share="${data.total.all_s?group.total_s/data.total.all_s*100:0}"></i></div></li>`).join('') + `</ul><h3>同じ作業の1回ごとの長さ</h3><p class="hint">1回は同じ作業名の1区間です。作業サイクルやタクトは推定しません。</p>` + (groups.some(group=>group.count>1)?`<ul class="zero-occurrences">${groups.filter(group=>group.count>1).map(group=>`<li><b>${esc(group.job_title)}</b><div>${group.occurrences.map((occurrence,index)=>`<button type="button" class="button secondary" data-st-job="${esc(group.job_no)}" data-st-segment="${esc(occurrence.segment_id)}">${index+1}回目 ${seconds(occurrence.duration_s)}</button>`).join('')}</div></li>`).join('')}</ul>`:'<p class="empty-state">同じ作業が2区間以上ある結果はありません。</p>');
  for(const bar of analytics.querySelectorAll('[data-share]'))bar.style.width=`${bar.dataset.share}%`;
  if(analyticsFocus) [...analytics.querySelectorAll('[data-st-job]')].find(row=>row.dataset.stJob===analyticsFocus.job&&row.dataset.stSegment===analyticsFocus.segment)?.focus({preventScroll:true});
  return data;
}
