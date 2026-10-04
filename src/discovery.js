import {clone,demand,id,now,sha256} from './core.js';
import {safeId} from './store.js';
import {loadPrompts,auditRequest} from './inputs.js';
import {NAMING_SCHEMA,ALIGNMENT_SCHEMA,OPEN_POLICY,REVIEW_SCHEMA_VERSION,STANDARD_SCHEMA_VERSION,CONFIRM_FIELDS,nonempty,exact,validateNaming,validateAlignment,exampleView,reviewSegments} from './discovery-contracts.js';
import {estimateCost} from './cost.js';
import {STARTUP_FINGERPRINT} from './implementation.js';

export const isOpen=s=>s?.label_policy===OPEN_POLICY;
export async function openPrompts(){return loadPrompts('observation-cycle.v1');}
export function buildOpen({segments,settings,prompts,standard=null,alignment=false}) {
  const examples=alignment?exampleView(standard):[],schema=alignment?ALIGNMENT_SCHEMA:NAMING_SCHEMA,prompt=prompts.loaded[alignment?'alignment':'naming'];
  const context={task:alignment?'observation_alignment':'observation_naming',label_policy:OPEN_POLICY,intervals:segments.map(({segment_id,observation,proposed_title,action_description})=>({segment_id,observation,...(alignment?{proposed_title,action_description}:{})})),...(alignment?{example_view_version:'review-example-view.v1',examples}:{})};
  const body={systemInstruction:{parts:[{text:prompt.text}]},contents:[{role:'user',parts:[{text:JSON.stringify(context)}]}],generationConfig:{...settings.stage2_generation_config,responseMimeType:'application/json',responseSchema:schema}};auditRequest(body);
  return {body,prompt,schema,input:{segments,examples}};
}
export async function createOpen(service,body,video,settings,prompts) {
  demand((body.video_partition??'whole')==='whole'&&body.analysis_strategy==='text_only','OPEN_FLOW_UNSUPPORTED','一覧なしの新フローは動画全体＋案1に対応しています。案2・案3・分割・同時判定は新契約未対応です。');
  demand(!body.standard_set_id&&!body.vocabulary_ref&&!body.discriminator_ref&&!body.comparison_session_id,'OPEN_INPUT_CONFLICT','一覧なし分析へ旧セット・語彙・識別条件・旧比較セッションは指定できません。');
  demand(service.environment.ready,'ENVIRONMENT_NOT_READY','動画ツール・保存先・接続条件を確認してください。');
  demand(!body.faults||service.config.allowFaults,'FAULT_INJECTION_DISABLED','故障注入はモック専用です。');
  const standard=body.reviewed_standard_id?await getReviewedStandard(service,body.reviewed_standard_id):null;
  demand(body.analysis_mode==='few_shot'?Boolean(standard):!standard,'REVIEW_STANDARD_REQUIRED','お手本ありではレビュー由来見本を選択してください。お手本なしでは見本を使用しません。');
  if(standard)demand(video.sha256!==standard.source_video_sha256,'REFERENCE_EQUALS_TARGET','見本Aとは別の動画Bを選択してください。同じ動画を独立評価対象にできません。');
  if(!service.config.mockMode)service.model.assertReady(settings);
  const extra=await openPrompts();
  await service.store.version('observation-cycle-prompts','observation-cycle.v1',extra.sha256);
  await service.store.version('observation-naming-schema','observation-naming.v1',sha256(NAMING_SCHEMA));
  await service.store.version('alignment-schema','task-alignment.v1',sha256(ALIGNMENT_SCHEMA));
  const snapshot={label_policy:OPEN_POLICY,input_contract:'observation-analysis-input.v1',implementation_fingerprint:STARTUP_FINGERPRINT,input_video_id:video.video_id,video,vocabulary:null,discriminators:null,vocabulary_ref:null,standard_set_id:null,unused_business_information_reason:'観察から作業内容を分析するため、業務語彙・識別条件は未使用',reviewed_standard_id:standard?.standard_id??null,reviewed_standard_sha256:standard?.content_sha256??null,review_example_view:standard?exampleView(standard):null,review_example_view_sha256:standard?sha256(exampleView(standard)):null,alignment_version:standard?'task-alignment.v1':null,analysis_strategy:body.analysis_strategy,analysis_mode:body.analysis_mode,video_partition:'whole',settings,stage1_artifact_id:body.stage1_artifact_id??null,consent_confirmed:true,faults:body.faults??null,prompt_manifest_sha256:prompts.sha256,open_prompt_manifest_sha256:extra.sha256};
  if(snapshot.stage1_artifact_id)await service.resolveArtifact(snapshot,prompts);
  return service.newRun(body,'analysis',snapshot);
}
export async function processOpen(service,r,artifact) {
  const s=r.snapshot,prompts=await openPrompts();demand(prompts.sha256===s.open_prompt_manifest_sha256,'VERSION_HASH_CONFLICT','受付後に新プロンプト版が変わっています。');
  const built=buildOpen({segments:artifact.output.segments,settings:s.settings,prompts});
  await service.phase(r,'stage2_running',{purpose:'observation_naming'});
  const res=await service.attemptStage(r,'naming',built,{input:built.input});validateNaming(res.output,artifact.output.segments);
  const segments=artifact.output.segments.map(seg=>({...clone(seg),...clone(res.output.tasks.find(t=>t.segment_id===seg.segment_id)),task_type_id:`task-${sha256({run_id:r.run_id,segment_id:seg.segment_id}).slice(0,32)}`,title_status:'ai_proposed',standard_duration_s:null,standard_order:null,page_number:null}));
  await service.store.immutable(`runs/${r.run_id}/discovery.json`,{schema_version:'task-discovery-artifact.v1',source_stage1_sha256:sha256(artifact),output:res.output,segments});
  let alignment=null;
  if(s.reviewed_standard_id){const standard=await getReviewedStandard(service,s.reviewed_standard_id);demand(standard.content_sha256===s.reviewed_standard_sha256&&sha256(exampleView(standard))===s.review_example_view_sha256,'STANDARD_HASH_MISMATCH','受付時の見本版・例示ビューが一致しません。');
    const request=buildOpen({segments,settings:s.settings,prompts,standard,alignment:true});await service.phase(r,'stage2_running',{purpose:'reference_alignment'});
    const response=await service.attemptStage(r,'alignment',request,{input:request.input});validateAlignment(response.output,segments,request.input.examples);
    alignment={...clone(response.output),standard_id:standard.standard_id,standard_sha256:standard.content_sha256,example_view_sha256:s.review_example_view_sha256,human_confirmed:false,unmatched_examples_status:'missing_candidate',time_allocation:null};
    await service.store.immutable(`runs/${r.run_id}/alignment.json`,alignment);
  }
  await service.phase(r,'validating');
  const result={schema_version:'task-discovery-result.v1',run_id:r.run_id,parent_run_id:r.parent_run_id,label_policy:OPEN_POLICY,analysis_strategy:s.analysis_strategy,analysis_mode:s.analysis_mode,video_partition:'whole',mock:service.config.mockMode,data_origin:service.config.mockMode?'synthetic_mock':'geap_inference',accuracy_claim:null,eligibility:'unverified',implementation_fingerprint:s.implementation_fingerprint,input:{video_id:s.video.video_id,source_sha256:s.video.sha256,submitted_sha256:artifact.video.sha256,duration_s:s.video.duration_s},vocabulary:null,discriminators:null,unused_business_information_reason:s.unused_business_information_reason,reviewed_standard_id:s.reviewed_standard_id,reviewed_standard_sha256:s.reviewed_standard_sha256,stage1:clone(r.stage1),naming:{output:res.output,prompt:{version:built.prompt.version,sha256:built.prompt.sha256},response_schema_sha256:sha256(built.schema)},alignment,alignment_sha256:alignment?sha256(alignment):null,segments,versions:{stage1_prompt:{version:artifact.key_fields.stage1_prompt_version,sha256:artifact.key_fields.stage1_prompt_sha256},stage1_schema:{version:'stage1.discover.v1',sha256:artifact.key_fields.response_schema_sha256},observation:{version:'observation.v1',sha256:(await loadPrompts(s.settings.prompt_release)).observation_sha256},naming_prompt:{version:built.prompt.version,sha256:built.prompt.sha256},naming_schema:{version:'observation-naming.v1',sha256:sha256(NAMING_SCHEMA)},alignment_schema:{version:alignment?'task-alignment.v1':null,sha256:alignment?sha256(ALIGNMENT_SCHEMA):null,reason:alignment?null:'reference_not_used'},open_prompts:{version:'observation-cycle.v1',sha256:prompts.sha256},vocabulary:null,discriminators:null},execution:{...clone(s.settings),stage1:{modelVersion:artifact.execution.modelVersion,agentic_traces:artifact.execution.agentic_traces},naming:{modelVersion:res.model_version,agentic_traces:res.agentic_traces,generationConfig:built.body.generationConfig},app_version:service.config.appVersion},attempts:clone(r.attempts),metrics_runtime:{cost:estimateCost(r.attempts,s.price_table,{mock:service.config.mockMode}),elapsed_ms:clone(r.metrics)},cleanup:await service.cleanup.summary(r.run_id),created_at:r.created_at,started_at:r.started_at,finished_at:now(),status:'succeeded'};
  await service.phase(r,'persisting');await service.hooks.beforeResultSave?.(r,result);
  await service.exclusive(async()=>{const current=await service.store.read(`runs/${r.run_id}/run.json`);demand(!current.cancel_requested&&!service.controller.signal.aborted,'CANCELLED','中断後の結果は確定しません。');await service.store.immutable(`runs/${r.run_id}/result.json`,result);r.result_sha256=sha256(result);r.status='succeeded';r.finished_at=result.finished_at;await service.saveRun(r);});
}
export async function saveOpenReview(service,runId,body) {
  const source=await service.result(runId),run=await service.store.read(`runs/${runId}/run.json`);demand(source.schema_version==='task-discovery-result.v1','INVALID_REVIEW','新結果のreview契約を使用してください。');
  demand(exact(body,['editor','comment','original_result_sha256','segments'])&&nonempty(body.editor)&&typeof body.comment==='string'&&body.comment.length<=1000,'INVALID_REVIEW','確認者・メモ・review入力を確認してください。');
  demand(body.original_result_sha256===sha256(source)&&run.result_sha256===sha256(source),'RESULT_HASH_MISMATCH','元result SHAが一致しません。',409);
  const segments=reviewSegments(source,body,run.snapshot.settings.audio_enabled);
  const review={schema_version:REVIEW_SCHEMA_VERSION,review_id:id(),original_run_id:runId,original_result_sha256:sha256(source),source_stage1_artifact_id:source.stage1.artifact_id,source_stage1_artifact_sha256:source.stage1.artifact_sha256,editor:body.editor.trim(),comment:body.comment,created_at:now(),mock:source.mock,segments,changes:source.segments.map(before=>({segment_id:before.segment_id,before,after:segments.find(s=>s.segment_id===before.segment_id)??null})).concat(segments.filter(s=>!source.segments.some(o=>o.segment_id===s.segment_id)).map(after=>({segment_id:after.segment_id,before:null,after}))),confirmation_scope:segments.map(s=>({segment_id:s.segment_id,fields:s.confirmed_fields})),content_sha256:null};
  review.content_sha256=sha256({...review,content_sha256:null});await service.store.immutable(`runs/${runId}/reviews/${review.review_id}/review.json`,review);return review;
}
export async function createReviewedStandard(service,body) {
  demand(exact(body,['source_run_id','review_id','review_sha256','segment_ids','name','confirmed_by'])&&[body.name,body.confirmed_by].every(nonempty)&&Array.isArray(body.segment_ids)&&body.segment_ids.length>0&&new Set(body.segment_ids).size===body.segment_ids.length,'INVALID_STANDARD','保存済みreview・含める区間・確認者を指定してください。');
  const runId=safeId(body.source_run_id),reviewId=safeId(body.review_id),ref=`runs/${runId}/reviews/${reviewId}/review.json`;
  demand(await service.store.exists(ref),'SAVED_REVIEW_REQUIRED','保存済みreviewから見本を作成してください。',409);
  const review=await service.store.read(ref),source=await service.result(runId);
  demand(review.schema_version===REVIEW_SCHEMA_VERSION&&review.original_run_id===runId&&review.review_id===reviewId&&review.content_sha256===sha256({...review,content_sha256:null})&&review.content_sha256===body.review_sha256,'REVIEW_HASH_MISMATCH','review ID・不変SHAが一致しません。',409);
  demand(review.original_result_sha256===sha256(source),'RESULT_HASH_MISMATCH','元結果が改変されています。',409);
  const artifact=await service.store.read(`stage1-artifacts/${safeId(source.stage1.artifact_id)}/artifact.json`);demand(sha256(artifact)===source.stage1.artifact_sha256,'INVALID_ARTIFACT','見本の元観察artifactが一致しません。');
  const selected=body.segment_ids.map(id=>review.segments.find(s=>s.segment_id===id));
  demand(selected.every(s=>s&&CONFIRM_FIELDS.every(f=>s.confirmed_fields.includes(f))&&s.observation&&s.observation_fit!=='unconfirmed'),'EXAMPLE_UNCONFIRMED','含める区間の境界・名称・作業内容・観察・根拠を確認してください。変更境界に合わない観察は採用できません。',409);
  const standardId=id(),examples=selected.map((s,i)=>({example_id:`example-${sha256({review_sha256:review.content_sha256,segment_id:s.segment_id}).slice(0,32)}`,reference_task_id:s.task_type_id,reviewed_title:s.reviewed_title,action_description:s.action_description,observation:clone(s.observation),human_evidence_note:s.human_evidence_note,source_segment_id:s.segment_id,start_s:s.start_s,end_s:s.end_s,observed_duration_s:s.end_s-s.start_s,standard_duration_s:null,standard_order:null,page_number:null,observation_origin:s.observation_origin,confirmation_scope:s.confirmed_fields}));
  const standard={schema_version:STANDARD_SCHEMA_VERSION,standard_id:standardId,name:body.name.trim(),source_run_id:runId,source_result_sha256:sha256(source),source_review_id:reviewId,source_review_sha256:review.content_sha256,source_video_id:source.input.video_id,source_video_sha256:source.input.source_sha256,source_stage1_artifact_id:source.stage1.artifact_id,source_stage1_artifact_sha256:source.stage1.artifact_sha256,source_artifact_kind:'stage1.discover.v1',build_rule_version:'review-example-build.v1',confirmed_by:body.confirmed_by.trim(),confirmed_at:now(),confirmation_scope:examples.map(e=>({example_id:e.example_id,fields:e.confirmation_scope})),examples,task_index:[...new Set(examples.map(e=>e.reference_task_id))].map(taskId=>({reference_task_id:taskId,example_ids:examples.filter(e=>e.reference_task_id===taskId).map(e=>e.example_id)})),available_strategies:['text_only'],status:'ready',synthetic:source.mock,content_sha256:null};
  standard.content_sha256=sha256({...standard,content_sha256:null});await service.store.immutable(`reviewed-standards/${standardId}/standard.json`,standard);return standard;
}
export async function getReviewedStandard(service,standardId) {const ref=`reviewed-standards/${safeId(standardId)}/standard.json`;demand(await service.store.exists(ref),'REVIEW_STANDARD_UNAVAILABLE','見本が見つかりません。保存先と見本IDを確認してください。',404);const s=await service.store.read(ref);demand(s.schema_version===STANDARD_SCHEMA_VERSION&&s.standard_id===standardId&&s.content_sha256===sha256({...s,content_sha256:null}),'STANDARD_HASH_MISMATCH','見本の不変版が一致しません。',409);return s;}
export async function reviewedStandards(service) {const list=[];for(const id of await service.store.list('reviewed-standards')){const s=await getReviewedStandard(service,id);const asset=await service.store.read(`media/${safeId(s.source_video_id)}/asset.json`,null);list.push({...s,source_video_available:Boolean(asset&&await service.store.exists(asset.asset_ref))});}return list;}
