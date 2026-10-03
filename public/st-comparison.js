// 表示専用。渡された区間だけを集計し、原本・修正後・作業名一覧を変更しない。
// 「回数」は同じ作業名の区間数。サイクルの認識やタクトの推定には使わない。
export function stComparison(segments, labels = null, mode = 'average') {
  const hasList = Boolean(labels?.length);
  const byLabel = new Map((labels ?? []).map((label, order) => [label.job_no, {...label, order}]));
  const byJob = new Map();
  for (const segment of segments) {
    const label = byLabel.get(segment.job_no);
    const st = Number.isFinite(label?.standard_duration_s) && label.standard_duration_s > 0 ? label.standard_duration_s : null;
    const status = !hasList ? 'no-list' : !label ? 'unlisted' : label.kind === 'non_work' ? 'non-work' : st === null ? 'no-st' : 'ok';
    if (!byJob.has(segment.job_no)) byJob.set(segment.job_no, {
      job_no: segment.job_no, job_title: label?.job_title ?? segment.job_title, status,
      st_s: status === 'ok' ? st : null, order: label?.order ?? byLabel.size + byJob.size, occurrences: [],
    });
    byJob.get(segment.job_no).occurrences.push({segment_id:segment.segment_id,start_s:segment.start_s,end_s:segment.end_s,duration_s:segment.end_s-segment.start_s});
  }
  const groups = [...byJob.values()].map(group => {
    group.occurrences.sort((a,b)=>a.start_s-b.start_s);
    const total_s = group.occurrences.reduce((sum, occurrence)=>sum+occurrence.duration_s,0);
    return {...group, count:group.occurrences.length, total_s, mean_s:total_s/group.occurrences.length};
  });
  const rows = groups.flatMap(group => {
    const {job_no,job_title,status,count,order} = group;
    const common = {job_no,job_title,status,count,order};
    if (mode === 'occurrence') return group.occurrences.map((occurrence,index)=>({
      ...common, key:occurrence.segment_id, segment_id:occurrence.segment_id, start_s:occurrence.start_s,
      occurrence:index+1, target_s:occurrence.duration_s, st_s:group.st_s,
      diff_s:group.st_s === null ? null : occurrence.duration_s-group.st_s,
    }));
    const target_s = mode === 'total' ? group.total_s : group.mean_s;
    const st_s = group.st_s === null ? null : group.st_s * (mode === 'total' ? count : 1);
    return [{...common,key:job_no,segment_id:null,start_s:group.occurrences[0].start_s,target_s,st_s,diff_s:st_s===null?null:target_s-st_s}];
  }).sort((a,b)=>(a.diff_s===null)-(b.diff_s===null) || Math.abs(b.diff_s??0)-Math.abs(a.diff_s??0) || a.order-b.order || a.start_s-b.start_s);
  const comparable = groups.filter(group=>group.status==='ok');
  const sum = (list, fn)=>list.reduce((value,item)=>value+fn(item),0);
  const target_s = comparable.length ? sum(comparable, group=>group.total_s) : null;
  const st_s = comparable.length ? sum(comparable, group=>group.st_s*group.count) : null;
  const total = {target_s,st_s,diff_s:st_s===null?null:target_s-st_s,job_count:comparable.length,
    excluded_s:sum(groups.filter(group=>group.status!=='ok'), group=>group.total_s), all_s:sum(groups,group=>group.total_s)};
  const absent = (labels??[]).filter(label=>label.kind==='work' && Number.isFinite(label.standard_duration_s) && label.standard_duration_s>0 && !byJob.has(label.job_no));
  return {hasList,groups,rows,total,absent};
}

// 行に使った元データから移動先を選ぶ。修正で名前やIDが変わっても別の表示元へ置き換えない。
export function comparisonTarget(segments, row, currentTime = 0) {
  if (row.segment_id) return segments.find(segment=>segment.segment_id===row.segment_id) ?? null;
  const occurrences = segments.filter(segment=>segment.job_no===row.job_no).sort((a,b)=>a.start_s-b.start_s);
  return occurrences.find(segment=>segment.start_s>=currentTime) ?? occurrences[0] ?? null;
}
