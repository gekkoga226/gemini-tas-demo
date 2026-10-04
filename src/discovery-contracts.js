import {clone,demand,sha256} from './core.js';
import {FIELDS,validateObservation} from './contracts.js';

const str={type:'string'},strings={type:'array',items:str};
const obj=properties=>({type:'object',properties,required:Object.keys(properties)});
const arr=items=>({type:'array',items});
const ref=obj({segment_id:str,field:{type:'string',enum:FIELDS},evidence_id:str});
export const NAMING_SCHEMA=obj({schema_version:{type:'string',enum:['observation-naming.v1']},tasks:arr(obj({segment_id:str,proposed_title:str,action_description:str,knowledge_status:{type:'string',enum:['observed','uncertain','unknown']},reason:str,missing_information:strings,evidence_refs:arr(ref)}))});
const exampleRef=obj({example_id:str,field:{type:'string',enum:FIELDS},evidence_id:str});
export const ALIGNMENT_SCHEMA=obj({schema_version:{type:'string',enum:['task-alignment.v1']},relations:arr(obj({segment_ids:strings,example_ids:strings,status:{type:'string',enum:['candidate','reference_unmatched','uncertain']},reason:str,missing_information:strings,evidence_refs:arr(ref),example_evidence_refs:arr(exampleRef)})),unmatched_example_ids:strings});
export const OPEN_POLICY='observation_open.v1';
export const REVIEW_SCHEMA_VERSION='discovery-reviewed-result.v1';
export const STANDARD_SCHEMA_VERSION='review-derived-standard.v1';
export const CONFIRM_FIELDS=['boundaries','title','action_description','observation','evidence'];
export function exact(value,keys) {return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
export function nonempty(v) {return typeof v==='string'&&v.trim().length>0&&v.length<=8000;}
const check=(ok,message)=>demand(ok,'INVALID_DISCOVERY',message,422);
function refs(list,segments,key='segment_id') {
  check(Array.isArray(list),'根拠参照の配列が必要です。');
  for(const r of list){check(exact(r,[key,'field','evidence_id'])&&FIELDS.includes(r.field),'根拠の項目が不正です。');const s=segments.find(s=>s[key]===r[key]);check(s&&s.observation[r.field].evidence_ids.includes(r.evidence_id)&&s.observation.evidence.some(e=>e.evidence_id===r.evidence_id),'根拠参照が入力の観察に存在しません。');}
}
export function validateNaming(output,segments) {
  check(exact(output,['schema_version','tasks'])&&output.schema_version==='observation-naming.v1'&&Array.isArray(output.tasks),'新命名応答の契約が必要です。');
  check(output.tasks.length===segments.length&&new Set(output.tasks.map(t=>t.segment_id)).size===segments.length,'固定区間のID集合が一致しません。');
  for(const t of output.tasks){check(exact(t,['segment_id','proposed_title','action_description','knowledge_status','reason','missing_information','evidence_refs'])&&segments.some(s=>s.segment_id===t.segment_id),'命名で時刻・未知項目を追加できません。');check([t.proposed_title,t.action_description,t.reason].every(nonempty)&&['observed','uncertain','unknown'].includes(t.knowledge_status)&&Array.isArray(t.missing_information)&&t.missing_information.every(nonempty),'説明・不明状態・不足を確認してください。');const s=segments.find(s=>s.segment_id===t.segment_id);refs(t.evidence_refs,[s]);check(t.knowledge_status!=='observed'||t.evidence_refs.length>0,'断定する記述には観察根拠が必要です。');check(!s.observation.insufficient_discriminative_features||t.knowledge_status!=='observed','特徴不足を確定名称で補完できません。');check(t.knowledge_status==='observed'||t.missing_information.length>0,'不明・不足の理由を残してください。');}
  return output;
}
export function validateAlignment(output,segments,examples) {
  check(exact(output,['schema_version','relations','unmatched_example_ids'])&&output.schema_version==='task-alignment.v1'&&Array.isArray(output.relations)&&Array.isArray(output.unmatched_example_ids),'対応付けの応答が不正です。');
  const used=new Set(),matchedExamples=new Set();
  for(const r of output.relations){check(exact(r,['segment_ids','example_ids','status','reason','missing_information','evidence_refs','example_evidence_refs']),'対応から時刻・分配時間を追加できません。');check(Array.isArray(r.segment_ids)&&r.segment_ids.length>0&&new Set(r.segment_ids).size===r.segment_ids.length&&r.segment_ids.every(id=>segments.some(s=>s.segment_id===id)&&!used.has(id)),'対象区間の重複計上・不明IDを許可しません。');r.segment_ids.forEach(id=>used.add(id));check(Array.isArray(r.example_ids)&&new Set(r.example_ids).size===r.example_ids.length&&r.example_ids.every(id=>examples.some(e=>e.example_id===id)),'見本のIDが存在しません。');check(['candidate','reference_unmatched','uncertain'].includes(r.status)&&nonempty(r.reason)&&Array.isArray(r.missing_information)&&r.missing_information.every(nonempty),'対応理由・不明状態を残してください。');check(r.status!=='candidate'||r.example_ids.length>0,'対応候補には見本が必要です。');check(r.status!=='reference_unmatched'||r.example_ids.length===0,'見本にない作業の対応先は空です。');check(r.status!=='uncertain'||r.missing_information.length>0,'対応不明の不足理由が必要です。');refs(r.evidence_refs,segments.filter(s=>r.segment_ids.includes(s.segment_id)));refs(r.example_evidence_refs,examples.filter(e=>r.example_ids.includes(e.example_id)),'example_id');check(r.status!=='candidate'||(r.evidence_refs.length>0&&r.example_evidence_refs.length>0),'名前の一致だけでは対応候補にできません。');r.example_ids.forEach(id=>matchedExamples.add(id));}
  check(used.size===segments.length,'全対象区間の対応・不明・未対応を記録してください。');
  const missing=examples.filter(e=>!matchedExamples.has(e.example_id)).map(e=>e.example_id).sort();check(new Set(output.unmatched_example_ids).size===missing.length&&JSON.stringify([...output.unmatched_example_ids].sort())===JSON.stringify(missing),'未対応の見本例を欠落候補として残してください。');return output;
}
export function exampleView(standard) {
  return standard.examples.map(e=>{const observation=clone(e.observation);observation.evidence=observation.evidence.map(({evidence_id,source,description})=>({evidence_id,source,description}));return {example_id:e.example_id,reference_task_id:e.reference_task_id,reviewed_title:e.reviewed_title,action_description:e.action_description,observation};}).sort((a,b)=>a.example_id.localeCompare(b.example_id));
}
export function reviewSegments(source,body,audio) {
  demand(Array.isArray(body.segments)&&body.segments.length>0,'INVALID_REVIEW','区間を入力してください。');let end=0;const ids=new Set();
  return body.segments.map(s=>{
    demand(exact(s,['segment_id','task_type_id','start_s','end_s','reviewed_title','action_description','observation','human_evidence_note','confirmed_fields']),'INVALID_REVIEW','reviewの入力項目を確認してください。');
    demand(nonempty(s.segment_id)&&nonempty(s.task_type_id)&&!ids.has(s.segment_id)&&Number.isFinite(s.start_s)&&Number.isFinite(s.end_s)&&s.start_s===end&&s.end_s>s.start_s&&s.end_s<=source.input.duration_s,'INVALID_REVIEW','区間は動画全体を重複・隙間なく覆ってください。');ids.add(s.segment_id);end=s.end_s;
    demand(nonempty(s.reviewed_title)&&nonempty(s.action_description)&&typeof s.human_evidence_note==='string'&&s.human_evidence_note.length<=8000&&Array.isArray(s.confirmed_fields)&&new Set(s.confirmed_fields).size===s.confirmed_fields.length&&s.confirmed_fields.every(f=>CONFIRM_FIELDS.includes(f)),'INVALID_REVIEW','名称・作業内容・確認範囲を入力してください。');
    const original=source.segments.find(o=>o.segment_id===s.segment_id),boundaryChanged=!original||original.start_s!==s.start_s||original.end_s!==s.end_s;
    if(s.observation)try{validateObservation(s.observation,s,audio);}catch(e){demand(false,'INVALID_REVIEW',`観察記録が不正です。${e.message}`);}
    const observationChanged=!original||sha256(original.observation)!==sha256(s.observation);
    demand(!s.confirmed_fields.includes('observation')||s.observation,'INVALID_REVIEW','観察なしを確認済みにできません。');
    demand(!(boundaryChanged||observationChanged)||(!s.confirmed_fields.includes('evidence')||nonempty(s.human_evidence_note)),'INVALID_REVIEW','変更した観察・区間の根拠確認には人の説明を入力してください。');
    return {...clone(s),boundary_changed:boundaryChanged,observation_changed:observationChanged,observation_origin:boundaryChanged||observationChanged?'human_review':'stage1_discover',observation_fit:boundaryChanged?(s.observation&&nonempty(s.human_evidence_note)&&['boundaries','observation','evidence'].every(f=>s.confirmed_fields.includes(f))?'human_confirmed':'unconfirmed'):'original_interval',ai_original_evidence:clone(original?.observation.evidence??[])};
  }).map((s,i,all)=>{demand(i!==all.length-1||end===source.input.duration_s,'INVALID_REVIEW','動画末尾まで記録してください。');return s;});
}
