import fs from 'node:fs/promises';
import {demand,sha256,profileFor,now,fault,clone} from './core.js';
import {buildStage1,buildStage2,auditRequest,videoPart,vocabularyView,discriminatorView,exampleView,inputSignature} from './inputs.js';
import {validateStage1,saveStage2} from './contracts.js';
import {hashFile} from './media.js';
import {DISCOVER_SCHEMA,STAGE2_SCHEMA,STAGE2_SCHEMA_VERSION,STAGE2_EMPTY_EVIDENCE_SCHEMA,STAGE2_EMPTY_EVIDENCE_SCHEMA_VERSION} from './response-schemas.js';

export const experimental = s => s.video_partition==='chunked'||s.analysis_strategy==='joint';
export function validateFlow({video_partition='whole',analysis_strategy,video,mockMode,settings,stage1_artifact_id,comparison_session_id}) {
  demand(['whole','chunked'].includes(video_partition),'INVALID_PARTITION','動画の分割方式が不正です。');
  demand(['text_only','vocabulary_guided','visual_evidence','joint'].includes(analysis_strategy),'INVALID_MODE','作業の分析方式が不正です。');
  if(!experimental({video_partition,analysis_strategy}))return;
  demand(mockMode&&video.synthetic===true,'EXPERIMENT_SYNTHETIC_ONLY','実験経路は合成サンプル・モック専用です。実媒体切出しと実API条件は未検証です。');
  demand(!settings?.audio_enabled,'EXPERIMENT_AUDIO_UNSUPPORTED','実験用PTS検証は音声なしに限定します。音声付き分割は未対応です。');
  demand(!stage1_artifact_id&&!comparison_session_id,'EXPERIMENT_REFERENCE_UNSUPPORTED','実験経路は通常Stage1・比較セッションを参照できません。専用チャンク共有を使用します。');
  demand(Number.isFinite(video.duration_s)&&video.duration_s>0&&video.duration_s<=7200,'EXPERIMENT_DURATION_UNSUPPORTED','合成実験は0秒超〜7200秒に限定します。長尺実測保証ではありません。');
}
export function planUnits(duration,partition,core=300,padding=15) {
  demand(Number.isFinite(duration)&&duration>0&&core>0&&padding>=0,'INVALID_PLAN','分割条件が不正です。');
  const size=partition==='whole'?duration:core;
  return Array.from({length:Math.ceil(duration/size)},(_,i)=>({unit_id:`unit-${i}`,core_start_s:i*size,core_end_s:Math.min(duration,(i+1)*size),window_start_s:Math.max(0,i*size-padding),window_end_s:Math.min(duration,(i+1)*size+padding)}));
}
export function validateTimeline(map) {
  demand(map?.version==='pts-map.v1'&&map.clock==='derived_seconds'&&Number.isFinite(map.origin_s)&&Number.isFinite(map.time_base_s)&&map.time_base_s>0&&map.samples?.length>=2,'INVALID_PTS_MAP','検証済みPTS対応が必要です。');
  for(let i=0;i<map.samples.length;i++) {const s=map.samples[i];demand(Number.isFinite(s.local_s)&&Number.isFinite(s.pts),'INVALID_PTS_MAP','PTSが不正です。');if(i)demand(s.local_s>map.samples[i-1].local_s&&s.pts>map.samples[i-1].pts,'INVALID_PTS_MAP','PTS巻戻り・跳躍は未対応です。');}
  // Only validated timestamp-preserving transforms are supported in v1.
  const first=map.samples[0];for(const s of map.samples)demand(Math.abs((s.pts-first.pts)*map.time_base_s-(s.local_s-first.local_s))<1e-6,'INVALID_PTS_MAP','時刻の跳躍・速度変更は未対応です。');return map;
}
export function originalTime(value,map) {
  validateTimeline(map);const samples=map.samples;
  demand(Number.isFinite(value)&&value>=samples[0].local_s&&value<=samples.at(-1).local_s,'INVALID_TIME','派生時刻が対応表の範囲外です。');
  const right=samples.findIndex(s=>s.local_s>=value);if(right===0)return samples[0].pts*map.time_base_s-map.origin_s;
  const a=samples[right-1],b=samples[right],pts=a.pts+(b.pts-a.pts)*(value-a.local_s)/(b.local_s-a.local_s);return pts*map.time_base_s-map.origin_s;
}
export const JOINT_SCHEMA={type:'OBJECT',properties:{schema_version:{type:'STRING',enum:['joint.response.v1']},segments:{type:'ARRAY',items:{type:'OBJECT',properties:{segment_id:{type:'STRING'},start_s:{type:'NUMBER'},end_s:{type:'NUMBER'},job_no:{type:'STRING'},job_title:{type:'STRING'},evidence:{type:'ARRAY',items:{type:'OBJECT',properties:{start_s:{type:'NUMBER'},end_s:{type:'NUMBER'},description:{type:'STRING'}},required:['start_s','end_s','description']}}},required:['segment_id','start_s','end_s','job_no','job_title','evidence']}},unresolved:{type:'ARRAY',items:{type:'OBJECT',properties:{start_s:{type:'NUMBER'},end_s:{type:'NUMBER'},reason:{type:'STRING'}},required:['start_s','end_s','reason']}}},required:['schema_version','segments','unresolved']};
export async function jointPrompt() {
  const text=await fs.readFile(new URL('../prompts/joint_experiment_v1.md',import.meta.url),'utf8'),manifest=JSON.parse(await fs.readFile(new URL('../prompts/joint_experiment.v1.json',import.meta.url),'utf8'));
  demand(sha256(text)===manifest.sha256,'VERSION_HASH_CONFLICT','実験promptの凍結SHAが一致しません。');return {...manifest,text};
}
export function buildJoint({video,settings,vocabulary,discriminators,set,analysis_mode,prompt}) {
  const context={schema_version:'joint.input.v1',duration_s:video.duration_s,vocabulary:vocabularyView(vocabulary),discriminators:discriminatorView(discriminators),examples:analysis_mode==='few_shot'?exampleView(set,'unguided'):[]};
  const body={systemInstruction:{parts:[{text:prompt.text}]},contents:[{role:'user',parts:[{text:JSON.stringify(context)},videoPart(video,settings)]}],generationConfig:{...settings.stage1_generation_config,responseMimeType:'application/json',responseSchema:JOINT_SCHEMA}};auditRequest(body);return {body,prompt,input:context};
}
export function validateJoint(output,duration,vocabulary) {
  demand(output&&Object.keys(output).every(k=>['schema_version','segments','unresolved'].includes(k))&&output.schema_version==='joint.response.v1'&&Array.isArray(output.segments)&&Array.isArray(output.unresolved),'INVALID_JOINT','同時判定の応答構造が不正です。');
  const ids=new Set();
  for(const s of output.segments) {
    demand(Object.keys(s).every(k=>['segment_id','start_s','end_s','job_no','job_title','evidence'].includes(k))&&!ids.has(s.segment_id)&&typeof s.segment_id==='string','INVALID_JOINT','区間ID・項目が不正です。');ids.add(s.segment_id);
    demand(vocabulary.labels.some(l=>l.job_no===s.job_no&&l.job_title===s.job_title),'INVALID_JOINT','語彙外ラベルです。');
    demand(Array.isArray(s.evidence)&&s.evidence.length>0,'INVALID_JOINT','映像根拠が必要です。');
    for(const e of s.evidence)demand(Object.keys(e).every(k=>['start_s','end_s','description'].includes(k))&&Number.isFinite(e.start_s)&&Number.isFinite(e.end_s)&&e.start_s>=s.start_s&&e.end_s<=s.end_s&&e.end_s>=e.start_s&&typeof e.description==='string'&&e.description.trim(),'INVALID_JOINT','根拠が区間外・不正です。');
  }
  for(const u of output.unresolved)demand(Object.keys(u).every(k=>['start_s','end_s','reason'].includes(k))&&typeof u.reason==='string'&&u.reason.trim(),'INVALID_JOINT','未解決理由が必要です。');
  const all=[...output.segments,...output.unresolved].sort((a,b)=>a.start_s-b.start_s);let end=0;
  for(const s of all){demand(Number.isFinite(s.start_s)&&Number.isFinite(s.end_s)&&s.start_s===end&&s.end_s>s.start_s&&s.end_s<=duration,'INVALID_JOINT','未説明時間・重複・時刻不正です。');end=s.end_s;}
  demand(end===duration,'INVALID_JOINT','全時間を区間または未解決で説明してください。');return output;
}
export function mergeUnits(units,children) {
  const segments=[],unresolved=[],sources=[];
  for(const unit of units) {
    const child=children.find(c=>c.unit.unit_id===unit.unit_id);
    if(!child){unresolved.push({start_s:unit.core_start_s,end_s:unit.core_end_s,reason:'failed_or_unfinished_core',unit_id:unit.unit_id});continue;}
    sources.push({unit_id:unit.unit_id,sha256:sha256(child)});
    for(const [kind,list] of [['segment',child.segments],['unresolved',child.unresolved]])for(const s of list) {
      const a=originalTime(s.start_s,child.timeline),b=originalTime(s.end_s,child.timeline),start=Math.max(a,unit.core_start_s),end=Math.min(b,unit.core_end_s);
      if(end<=start)continue;
      const evidence=s.evidence??s.observation?.evidence??[];
      const original_evidence=evidence.map(e=>({...e,start_s:originalTime(e.start_s,child.timeline),end_s:originalTime(e.end_s,child.timeline)}));
      const record={...clone(s),start_s:start,end_s:end,original_evidence,source:{unit_id:unit.unit_id,child_sha256:sha256(child),original_interval:{start_s:a,end_s:b},core_clipped:start!==a||end!==b}};
      if(kind==='segment')segments.push({...record,segment_id:`${unit.unit_id}:${s.segment_id}`});else unresolved.push(record);
    }
  }
  for(const unit of units){if(!children.some(c=>c.unit.unit_id===unit.unit_id))continue;const coverage=segments.filter(s=>s.source.unit_id===unit.unit_id).concat(unresolved.filter(u=>u.source?.unit_id===unit.unit_id)).sort((a,b)=>a.start_s-b.start_s);let end=unit.core_start_s;for(const interval of coverage){if(interval.start_s>end)unresolved.push({start_s:end,end_s:interval.start_s,reason:'unexplained_time',unit_id:unit.unit_id});if(interval.start_s<end)unresolved.push({start_s:interval.start_s,end_s:Math.min(end,interval.end_s),reason:'overlapping_time',unit_id:unit.unit_id});end=Math.max(end,interval.end_s);}if(end<unit.core_end_s)unresolved.push({start_s:end,end_s:unit.core_end_s,reason:'unexplained_time',unit_id:unit.unit_id});}
  for(let i=1;i<units.length;i++)unresolved.push({start_s:units[i].core_start_s,end_s:units[i].core_start_s,reason:'seam_continuity_unverified',unit_ids:[units[i-1].unit_id,units[i].unit_id]});
  return {rule_version:'core-owner.conservative.v1',segments,unresolved,sources,complete:children.length===units.length&&unresolved.length===0};
}
async function verifyAttempt(store,attempt) {
  for(const kind of ['request','response']) {
    demand(typeof attempt[`${kind}_ref`]==='string'&&typeof attempt[`${kind}_sha256`]==='string','INVALID_ARTIFACT','実験の生応答・送信元参照が不足しています。');
    const saved=await store.read(attempt[`${kind}_ref`],null);
    demand(saved&&sha256(saved)===attempt[`${kind}_sha256`],'INVALID_ARTIFACT','実験の生応答・送信本文が欠落または変更されています。');
  }
}
async function verifyStage1(store,cached) {
  await verifyAttempt(store,cached);
  demand(sha256(cached.output)===cached.sha256,'INVALID_ARTIFACT','共有Stage1のSHA不一致です。');
}
export async function readFlowResult(store,run) {
  const base=`experiments/${run.run_id}`,result=await store.read(`${base}/result.json`),manifest=await store.read(`${base}/manifest.json`);
  demand(result.schema_version==='flow-experiment.result.v1'&&result.run_id===run.run_id&&typeof result.complete==='boolean'&&result.video_partition===run.snapshot.video_partition&&result.analysis_strategy===run.snapshot.analysis_strategy&&result.analysis_mode===run.snapshot.analysis_mode&&result.input.source_sha256===run.snapshot.video.sha256&&result.contract_sha256===sha256(manifest.contract),'INVALID_ARTIFACT','実験結果の識別・条件不一致です。');
  demand(!run.result_sha256||sha256(result)===run.result_sha256,'INVALID_ARTIFACT','実験結果のSHA不一致です。');
  const children=[];
  for(const source of result.children){const child=await store.read(`${base}/${source.unit_id}/result.json`),checksum=await store.read(`${base}/${source.unit_id}/checksum.json`);demand(sha256(child)===source.sha256&&source.sha256===checksum.sha256,'INVALID_ARTIFACT','実験子結果のSHA不一致です。');children.push(child);}
  const merged=mergeUnits(manifest.units,children);
  demand(result.complete===merged.complete&&(!result.complete||result.failures.length===0)&&sha256(result.segments)===sha256(merged.segments)&&sha256(result.unresolved)===sha256(merged.unresolved),'INVALID_ARTIFACT','未解決・統合結果の不一致です。');
  return result;
}
export async function processFlow(service,r,prompts) {
  const s=r.snapshot,set=s.standard_set_id?await service.getSet(s.standard_set_id):null,prompt=await jointPrompt();
  demand(prompt.sha256===s.joint_prompt_sha256,'VERSION_HASH_CONFLICT','受付後に実験promptが変わりました。');
  if(set)demand(set.content_sha256===s.standard_set_sha256,'SET_CHANGED','公開資産が変更されています。');
  const prepared=await service.media.prepare(s.video,s.settings,r.run_id,service.cleanup,service.controller.signal);
  const units=planUnits(prepared.duration_s,s.video_partition),base=`experiments/${r.run_id}`,children=[],failures=[];
  const contract={version:'flow-experiment.v1',video_sha256:s.video.sha256,settings:s.settings,partition:s.video_partition,strategy:s.analysis_strategy,mode:s.analysis_mode,set_sha256:s.standard_set_sha256,vocabulary_sha256:sha256(s.vocabulary),discriminators_sha256:sha256(s.discriminators),prompt_manifest_sha256:prompts.sha256,prompt_sha256:s.joint_prompt_sha256,joint_schema_sha256:sha256(JOINT_SCHEMA),response_schemas:{stage1:sha256(DISCOVER_SCHEMA),stage2:{version:STAGE2_SCHEMA_VERSION,sha256:sha256(STAGE2_SCHEMA)},stage2_no_evidence:{version:STAGE2_EMPTY_EVIDENCE_SCHEMA_VERSION,sha256:sha256(STAGE2_EMPTY_EVIDENCE_SCHEMA)}},merge_rule_version:'core-owner.conservative.v1'};
  await service.store.immutable(`${base}/manifest.json`,{run_id:r.run_id,parent_run_id:r.parent_run_id,contract,units});
  for(const unit of units) {
    await service.phase(r,'preparing',{unit_id:unit.unit_id,completed:children.length,total:units.length});
    let length=unit.window_end_s-unit.window_start_s;
    const window=await service.media.experimentalWindow(prepared,unit,r.run_id,service.cleanup,service.controller.signal);
    const timeline=window.timeline;length=window.video.duration_s;validateTimeline(timeline);
    const inputSHA=sha256({contract,unit,timeline});
    const childRef=`${base}/${unit.unit_id}/result.json`,attemptStart=r.attempts.length;
    try {
      if(r.parent_run_id){const old=await service.store.read(`experiments/${r.parent_run_id}/${unit.unit_id}/result.json`,null),checksum=await service.store.read(`experiments/${r.parent_run_id}/${unit.unit_id}/checksum.json`,null);if(old){demand(sha256(old)===checksum?.sha256,'INVALID_ARTIFACT','成功子のSHA不一致です。');if(old.input_sha256===inputSHA){demand(old.schema_version==='flow-experiment.child.v1'&&sha256(old.unit)===sha256(unit)&&sha256(old.timeline)===sha256(timeline),'INVALID_ARTIFACT','成功子の入力単位が一致しません。');for(const attempt of old.attempts)await verifyAttempt(service.store,attempt);if(old.stage1){const cached=await service.store.read(old.stage1.ref,null),check=await service.store.read(old.stage1.ref.replace(/artifact.json$/,'checksum.json'),null);demand(cached&&sha256(cached)===check?.sha256&&cached.sha256===old.stage1.sha256&&cached.producer_run_id===old.stage1.producer_run_id,'INVALID_ARTIFACT','成功子の共有Stage1出典が一致しません。');await verifyStage1(service.store,cached);}service.controller.signal.throwIfAborted();children.push(old);await service.store.immutable(childRef,old);await service.store.immutable(`${base}/${unit.unit_id}/checksum.json`,checksum);continue;}}}
      if(s.faults?.fail_unit===unit.unit_id)throw fault('MOCK_UNIT_FAILURE','合成チャンク故障です。');
      const windowSHA=sha256({source_sha256:s.video.sha256,unit,timeline});
      const remote=await service.cleanup.upload(window.video,r.run_id,null,service.controller.signal);
      const video={...remote,video_id:`${s.video.video_id}-${unit.unit_id}`,duration_s:length,sha256:window.video.sha256};
      let segments,unresolved=[],stage1=null;
      if(s.analysis_strategy==='joint') {
        const built=buildJoint({video,settings:s.settings,vocabulary:s.vocabulary,discriminators:s.discriminators,set,analysis_mode:s.analysis_mode,prompt});
        await service.phase(r,'stage1_running',{unit_id:unit.unit_id,operation:'joint'});
        const response=await service.attemptStage(r,'joint',built,{video,input:built.input});
        const output=validateJoint(response.output,length,s.vocabulary);segments=output.segments;unresolved=output.unresolved;
      } else {
        const key=sha256({video:windowSHA,profile:profileFor(s.analysis_strategy),settings:s.settings,prompts:prompts.sha256,vocabulary:sha256(s.vocabulary),discriminators:sha256(s.discriminators),set_sha256:s.standard_set_sha256}),ref=`experiments/stage1-cache/${key}/artifact.json`;
        const built=buildStage1({video,settings:s.settings,prompts,profile:profileFor(s.analysis_strategy),vocabulary:s.vocabulary,discriminators:s.discriminators});
        let cached=await service.store.read(ref,null);
        if(cached){const checksum=await service.store.read(`experiments/stage1-cache/${key}/checksum.json`,null);demand(sha256(cached)===checksum?.sha256&&cached.input_signature_sha256===inputSignature(built.body,[video]),'INVALID_ARTIFACT','共有Stage1の本文・SHA不一致です。');await verifyStage1(service.store,cached);}
        else {await service.phase(r,'stage1_running',{unit_id:unit.unit_id});const response=await service.attemptStage(r,'stage1',built,{video});validateStage1(response.output,{duration_s:length,audio_enabled:s.settings.audio_enabled});const attempt=r.attempts.at(-1);cached={output:response.output,sha256:sha256(response.output),producer_run_id:r.run_id,input_signature_sha256:inputSignature(built.body,[video]),request_ref:attempt.request_ref,request_sha256:attempt.request_sha256,response_ref:attempt.response_ref,response_sha256:attempt.response_sha256};await service.store.immutable(ref,cached);await service.store.immutable(`experiments/stage1-cache/${key}/checksum.json`,{sha256:sha256(cached)});}
        validateStage1(cached.output,{duration_s:length,audio_enabled:s.settings.audio_enabled});stage1={ref,sha256:cached.sha256,producer_run_id:cached.producer_run_id,response_ref:cached.response_ref??null,response_sha256:cached.response_sha256??null};
        // Freeze ownership mapping before any label response.
        await service.store.immutable(`${base}/${unit.unit_id}/stage1.json`,{stage1,unit,timeline,output:cached.output});
        const images=[];if(s.analysis_strategy==='visual_evidence'&&s.analysis_mode==='few_shot')for(const image of set.representative_images){demand(await hashFile(service.store.resolve(image.asset_ref))===image.sha256,'INPUT_UNAVAILABLE','代表画像が欠落・変更されています。');images.push(await service.cleanup.upload(image,r.run_id,null,service.controller.signal));}
        const b=buildStage2({segments:cached.output.segments,video,settings:s.settings,prompts,analysis_strategy:s.analysis_strategy,analysis_mode:s.analysis_mode,set,vocabulary:s.vocabulary,discriminators:s.discriminators,images});
        await service.phase(r,'stage2_running',{unit_id:unit.unit_id});const response=await service.attemptStage(r,'stage2',b,{video,input:b.input});const saved=saveStage2(response.output,b.input,s.settings.safety_policy);
        segments=cached.output.segments.map(seg=>({...seg,...saved.output.labels.find(l=>l.segment_id===seg.segment_id),...saved.output.labels.find(l=>l.segment_id===seg.segment_id).final_label}));
      }
      await service.phase(r,'validating',{unit_id:unit.unit_id});
      service.controller.signal.throwIfAborted();
      const child={schema_version:'flow-experiment.child.v1',producer_run_id:r.run_id,input_sha256:inputSHA,unit,timeline,stage1,segments,unresolved,attempts:r.attempts.slice(attemptStart).filter(a=>a.stage==='joint'||a.stage==='stage1'||a.stage==='stage2').map(a=>({attempt_id:a.attempt_id,request_ref:a.request_ref,request_sha256:a.request_sha256,response_ref:a.response_ref,response_sha256:a.response_sha256}))};
      await service.store.immutable(childRef,child);await service.store.immutable(`${base}/${unit.unit_id}/checksum.json`,{sha256:sha256(child)});children.push(child);
    } catch(e) {if(service.controller.signal.aborted||e.code==='CANCELLED'||e.code==='REMOTE_OUTCOME_UNKNOWN')throw e;failures.push({unit_id:unit.unit_id,code:e.code??'PROCESSING_FAILED',message:e.message});await service.store.immutable(`${base}/${unit.unit_id}/failure.json`,failures.at(-1));}
  }
  const merged=mergeUnits(units,children);
  await service.phase(r,'persisting');
  const result={schema_version:'flow-experiment.result.v1',run_id:r.run_id,parent_run_id:r.parent_run_id,video_partition:s.video_partition,analysis_strategy:s.analysis_strategy,analysis_mode:s.analysis_mode,experimental:true,mock:true,accuracy_claim:null,input:{video_id:s.video.video_id,source_sha256:s.video.sha256,duration_s:s.video.duration_s},standard_set_id:s.standard_set_id,created_at:r.created_at,finished_at:now(),execution:s.settings,contract_sha256:sha256(contract),joint_prompt_sha256:prompt.sha256,joint_schema:{version:'joint.response.v1',sha256:sha256(JOINT_SCHEMA)},children:merged.sources,segments:merged.segments,unresolved:merged.unresolved,failures,complete:merged.complete,metrics_runtime:{cost:{total:null,status:'synthetic_unmeasured'}},review_contract:'unsupported.v1'};
  await service.exclusive(async()=>{
    service.controller.signal.throwIfAborted();
    const current=await service.store.read(`runs/${r.run_id}/run.json`);demand(!current.cancel_requested,'CANCELLED','利用者が中断しました。');
    await service.store.immutable(`${base}/result.json`,result);r.result_sha256=sha256(result);r.finished_at=result.finished_at;r.status=result.complete?'succeeded':'failed';r.experiment_complete=result.complete;r.error=!result.complete?{code:'PARTIAL_FAILURE',message:'実験結果は部分失敗または継ぎ目未解決です。成功子と仮結果を保全しました。',stage:r.phase}:null;await service.saveRun(r);
  });
}
