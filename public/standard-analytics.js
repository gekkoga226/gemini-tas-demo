// Display-only aggregation. This module is never imported by inference builders.
export function standardSources(set) {
  return set?.sources??(set?.source_video?[{source_id:set.source_video.video_id,name:'お手本動画',source_video:set.source_video,display_segments:set.display_segments??[],video_available:true}]:[]);
}

export function summarizeStandards(set, actual=null) {
  const sources=standardSources(set).map(s=>({...s,kind:'standard'}));
  if(actual)sources.push({source_id:`run-${actual.run_id}`,name:'今回の分析（自動判定）',kind:'actual',source_video:{video_id:actual.input.video_id,duration_s:actual.input.duration_s},display_segments:actual.segments});
  const labels=new Map((set?.vocabulary?.labels??[]).map(l=>[l.job_no,l.job_title]));
  for(const source of sources)for(const s of source.display_segments)labels.set(s.job_no,s.job_title);
  const processes=[...labels].map(([job_no,job_title])=>{
    const samples=sources.filter(s=>s.kind==='standard').flatMap(source=>source.display_segments.filter(s=>s.job_no===job_no).map(s=>({source_id:source.source_id,segment_id:s.segment_id,start_s:s.start_s,end_s:s.end_s,duration_s:s.end_s-s.start_s})));
    const values=samples.map(s=>s.duration_s).sort((a,b)=>a-b),n=values.length;
    const totals=sources.map(source=>{const parts=source.display_segments.filter(s=>s.job_no===job_no);return {source_id:source.source_id,count:parts.length,total_s:parts.length?parts.reduce((n,s)=>n+s.end_s-s.start_s,0):null};});
    return {job_no,job_title,samples,count:n,video_count:new Set(samples.map(s=>s.source_id)).size,min_s:n?values[0]:null,max_s:n?values.at(-1):null,median_s:n?(values[Math.floor((n-1)/2)]+values[Math.ceil((n-1)/2)])/2:null,mean_s:n?values.reduce((a,b)=>a+b,0)/n:null,totals};
  }).filter(p=>p.count||p.totals.some(t=>t.count));
  return {sources,processes,max_total_s:Math.max(1,...sources.map(s=>s.display_segments.reduce((n,x)=>n+x.end_s-x.start_s,0)))};
}

export function compareStandards(summary,leftId,rightId) {
  return summary.processes.map(p=>{const left=p.totals.find(t=>t.source_id===leftId),right=p.totals.find(t=>t.source_id===rightId);return {...p,left,right,delta_s:left?.total_s==null||right?.total_s==null?null:right.total_s-left.total_s};});
}
