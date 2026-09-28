import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {fixture,waitRun} from '../test-support/fixture.js';
import {id,sha256,fault,delay} from '../src/core.js';
import {defaultSettings} from '../src/settings.js';
import {hashFile} from '../src/media.js';
import {exampleView,auditRequest} from '../src/inputs.js';
import {summarizeStandards,compareStandards} from '../public/standard-analytics.js';
import {analysisReadiness,runPresentation} from '../public/analysis-state.js';

async function waitForRecovery(service,runId){
  // Terminal status is persisted before asynchronous recovery finishes.
  for(let i=0;i<500;i++){await service.cleanup.sweep();const status=await service.status(runId);if(status.cleanup.cleanup_status==='deleted')return;await delay(20);}
  assert.fail(`cleanup did not finish: ${JSON.stringify((await service.status(runId)).cleanup)}`);
}

async function buildInput(service,config,demo) {
  const legacy=await service.getSet(demo.standard_set_id);
  const first=await service.registerGT(await service.store.read(legacy.build_only_gt.asset_ref));
  const labels=legacy.vocabulary.labels;
  const second=await service.registerGT({gt_version:'multi-test.v1',video_id:demo.actual_video_id,duration_s:30,segments:[[0,10,0],[10,14,0],[14,24,1],[24,30,3]].map(([start_s,end_s,index],i)=>({gt_segment_id:`g-${i}`,gt_process_id:`p-${i}`,start_s,end_s,job_no:labels[index].job_no,job_title:labels[index].job_title}))});
  return {client_request_id:id(),name:'複数お手本・合成',sources:[{source_video_id:demo.standard_video_id,build_gt_asset_id:first.build_gt_asset_id,name:'お手本A'},{source_video_id:demo.actual_video_id,build_gt_asset_id:second.build_gt_asset_id,name:'お手本B'}],vocabulary_ref:demo.vocabulary_ref,profiles:['unguided','guided'],generate_images:true,settings:defaultSettings(config),consent_confirmed:true};
}

test('multiple standards preserve every source and frame, isolate GT/times, share Stage1, and retain legacy publications',async t=>{
  const {service,config,demo}=await fixture(t),legacy=await service.getSet(demo.standard_set_id),legacyHash=sha256(legacy),body=await buildInput(service,config,demo);
  const run=await service.createStandard(body);assert.equal((await service.createStandard(body)).run_id,run.run_id);
  const complete=await waitRun(service,run.run_id);assert.equal(complete.status,'awaiting_approval',JSON.stringify(complete.error));
  await waitForRecovery(service,run.run_id);
  const set=await service.getSet(run.standard_set_id);assert.equal(set.schema_version,'standard-set.v2');assert.equal(set.sources.length,2);assert.equal(set.examples.unguided.length,8);assert.equal(set.examples.guided.length,8);assert.equal(set.representative_images.length,24);
  assert.equal(new Set(set.representative_images.map(i=>i.asset_ref)).size,24,'source frames must not overwrite the same filenames');
  for(const img of set.representative_images){assert.equal(await hashFile(service.store.resolve(img.asset_ref)),img.sha256);const source=set.sources.find(s=>s.source_id===img.source_id);assert.equal(img.source_video_sha256,source.source_video.sha256);assert.ok(set.examples.unguided.some(e=>e.example_id===img.example_id&&e.source_id===img.source_id));}
  for(const source of set.sources)for(const profile of body.profiles){const descriptor=source.description_profiles[profile];assert.equal(sha256(await service.store.read(`stage1-artifacts/${descriptor.artifact_id}/artifact.json`)),descriptor.artifact_sha256);}
  const build=await service.store.read(`runs/${run.run_id}/run.json`);assert.equal(build.attempts.length,4);
  for(const attempt of build.attempts){const request=await service.store.read(attempt.request_ref),parts=request.contents.flatMap(c=>c.parts);assert.equal(parts.filter(p=>p.fileData?.mimeType==='video/mp4').length,1);const intervals=parts.filter(p=>p.text?.startsWith('{')).map(p=>JSON.parse(p.text)).find(p=>p.fixed_intervals).fixed_intervals;assert.deepEqual(Object.keys(intervals[0]).sort(),['end_s','segment_id','start_s']);}
  await service.approve(set.standard_set_id,'synthetic-test');const published=await service.getSet(set.standard_set_id);const view=await service.setView(published);assert.equal(view.sources.length,2);assert.equal(view.approval_available,false);assert.equal(JSON.stringify(view).includes('build_only_gt'),false);assert.equal(JSON.stringify(view).includes('build-inputs/'),false);
  const actual=await service.media.syntheticVideo(18,'合成の分析対象'),results=[];
  for(const strategy of ['text_only','visual_evidence','vocabulary_guided'])for(const mode of ['few_shot','zero_shot']){
    const r=await service.createAnalysis({client_request_id:id(),input_video_id:actual.video_id,standard_set_id:set.standard_set_id,analysis_strategy:strategy,analysis_mode:mode,settings:body.settings,consent_confirmed:true});
    const status=await waitRun(service,r.run_id);assert.equal(status.status,'succeeded',JSON.stringify(status.error));const result=await service.result(r.run_id);assert.equal(status.result_sha256,sha256(result),'job hash must match the immutable result, independently of later persistence/cleanup timings');results.push(result);
    assert.deepEqual(result.segments.map(s=>[s.segment_id,s.start_s,s.end_s]),result.stage1.output.segments.map(s=>[s.segment_id,s.start_s,s.end_s]));
    assert.equal(result.versions.example_view.version,'example-view.v2');
    for(const attempt of result.attempts){const req=await service.store.read(attempt.request_ref);auditRequest(req);if(attempt.stage==='stage2'){const context=JSON.parse(req.contents[0].parts[0].text);assert.equal(context.examples.length,mode==='few_shot'?8:0);assert.equal(JSON.stringify(context.examples).includes('start_s'),false);assert.equal(JSON.stringify(context.examples).includes('source_video_id'),false);}}
  }
  assert.equal(new Set(results.slice(0,4).map(r=>r.stage1.artifact_id)).size,1);assert.notEqual(results[4].stage1.artifact_id,results[0].stage1.artifact_id);
  const before=sha256(published),resultBefore=sha256(results[0]);await service.retire(set.standard_set_id);await service.deleteSetMedia(set.standard_set_id);
  const retired=await service.getSet(set.standard_set_id),deletedView=await service.setView(retired);assert.equal(sha256({...retired,status:'ready'}),before);assert.equal(deletedView.media_state.images_missing,24);assert.ok(deletedView.sources.every(s=>s.video_available));assert.equal(sha256(await service.result(results[0].run_id)),resultBefore);assert.equal(sha256(await service.getSet(demo.standard_set_id)),legacyHash);
  for(const img of legacy.representative_images)assert.equal(await hashFile(service.store.resolve(img.asset_ref)),img.sha256);
});

test('build rejects incomplete, duplicate and mismatched video/GT pairs before creating a run',async t=>{
  const {service,config,demo}=await fixture(t),body=await buildInput(service,config,demo);
  for(const [change,code] of [[{sources:[]},'INVALID_STANDARD_SOURCES'],[{sources:[body.sources[0],body.sources[0]]},'INVALID_STANDARD_SOURCES'],[{sources:[{...body.sources[0],build_gt_asset_id:body.sources[1].build_gt_asset_id}]},'INVALID_GT'],[{source_video_id:demo.standard_video_id},'INVALID_STANDARD_SOURCES'],[{consent_confirmed:false},'CONSENT_REQUIRED']])await assert.rejects(service.createStandard({...body,...change}),{code});
  const original=await service.getMedia(demo.standard_video_id),copy=await service.media.register(createReadStream(service.store.resolve(original.asset_ref)),'video/mp4','同じ内容のコピー');
  const gt=await service.store.read((await service.getSet(demo.standard_set_id)).build_only_gt.asset_ref),copyGT=await service.registerGT({...gt,video_id:copy.video_id});
  await assert.rejects(service.createStandard({...body,sources:[body.sources[0],{source_video_id:copy.video_id,build_gt_asset_id:copyGT.build_gt_asset_id}]}),{code:'DUPLICATE_STANDARD_VIDEO'});
  await assert.rejects(service.createAnalysis({client_request_id:id(),input_video_id:demo.actual_video_id,analysis_strategy:'text_only',analysis_mode:'few_shot',standard_set_id:demo.standard_set_id,settings:body.settings,consent_confirmed:true,sources:body.sources}),{code:'INVALID_INPUT'});
});

test('cancelling during the second source keeps first-source assets and prevents approval',async t=>{
  const {service,config,demo}=await fixture(t),body=await buildInput(service,config,demo);
  let cancelAtSecond;const reached=new Promise(resolve=>cancelAtSecond=resolve);let continueSecond;const released=new Promise(resolve=>continueSecond=resolve);
  service.hooks.phase=async(r,status)=>{if(r.job_kind==='standard_build'&&status==='preparing'&&r.phase_history.at(-1).detail?.source_index===2){cancelAtSecond();await released;}};
  const run=await service.createStandard(body);await reached;await service.cancel(run.run_id);continueSecond();
  const cancelled=await waitRun(service,run.run_id);assert.equal(cancelled.status,'cancelled');await waitForRecovery(service,run.run_id);
  const saved=await service.getSet(run.standard_set_id),view=await service.setView(saved);assert.equal(saved.examples.unguided.length,4);assert.equal(saved.representative_images.length,12);assert.equal(view.build_status,'cancelled');assert.equal(view.approval_available,false);
  await assert.rejects(service.approve(run.standard_set_id,'synthetic-test'),{code:'NOT_AWAITING_APPROVAL'});
});

test('failure on a later standard preserves completed sources and cleanup; retry creates a new set',async t=>{
  const {service,config,demo}=await fixture(t),body=await buildInput(service,config,demo);
  service.hooks.phase=async(r,status)=>{if(r.job_kind==='standard_build'&&status==='preparing'&&r.phase_history.at(-1).detail?.source_index===2)throw fault('SYNTHETIC_SOURCE_FAILURE','合成の2本目失敗',500);};
  const run=await service.createStandard(body),failed=await waitRun(service,run.run_id);assert.equal(failed.status,'failed');await waitForRecovery(service,run.run_id);
  const saved=await service.getSet(run.standard_set_id),savedHash=sha256(saved);assert.equal(saved.examples.unguided.length,4);assert.equal(saved.representative_images.length,12);assert.equal((await service.setView(saved)).approval_available,false);
  const oldResponses=(await service.store.read(`runs/${run.run_id}/run.json`)).attempts.map(a=>a.response_sha256);assert.equal(oldResponses.length,2);
  service.hooks.phase=null;const retry=await service.retry(run.run_id,id());assert.notEqual(retry.standard_set_id,run.standard_set_id);assert.equal((await waitRun(service,retry.run_id)).status,'awaiting_approval');assert.equal((await service.getSet(retry.standard_set_id)).parent_set_id,run.standard_set_id);assert.equal(sha256(await service.getSet(run.standard_set_id)),savedHash);assert.deepEqual((await service.store.read(`runs/${run.run_id}/run.json`)).attempts.map(a=>a.response_sha256),oldResponses);
});

test('display aggregates occurrences and missing processes without averaging profiles or inventing zero durations',()=>{
  const seg=(segment_id,start_s,end_s,job_no)=>({segment_id,start_s,end_s,job_no,job_title:job_no});
  const set={sources:[{source_id:'a',name:'A',source_video:{duration_s:10},display_segments:[seg('1',0,2,'x'),seg('2',2,6,'x'),seg('3',6,10,'y')]},{source_id:'b',name:'B',source_video:{duration_s:6},display_segments:[seg('1',0,6,'x')]}],examples:{unguided:[1,2,3],guided:[1,2,3]}};
  const before=JSON.stringify(set),stats=summarizeStandards(set),x=stats.processes.find(p=>p.job_no==='x');assert.equal(x.count,3);assert.equal(x.video_count,2);assert.equal(x.mean_s,4);assert.equal(x.median_s,4);assert.deepEqual(x.totals.map(t=>t.total_s),[6,6]);assert.equal(stats.max_total_s,10);
  const comparison=compareStandards(stats,'a','b');assert.equal(comparison[0].delta_s,0);assert.equal(comparison[1].right.total_s,null);assert.equal(comparison[1].delta_s,null);assert.equal(JSON.stringify(set),before);
});

test('terminal job text and media recovery stay separate; readiness explains input/consent/profile blockers',()=>{
  for(const status of ['succeeded','failed','cancelled','interrupted','awaiting_approval']){const p=runPresentation({status,result_available:status==='succeeded',cleanup:{cleanup_status:'retry_wait'}});assert.equal(p.ended,true);assert.equal(p.observe_cleanup,true);assert.equal(p.message.includes('サーバーで処理しています'),false);}
  assert.match(runPresentation({status:'cancelled',error:{message:'媒体の検証に失敗'},cleanup:{cleanup_status:'deleted'}}).message,/中止/);
  assert.equal(runPresentation({status:'stage2_running',cleanup:{cleanup_status:'deleted'}}).ended,false);
  const settings={audio_enabled:false,fps:1,processing_mode:'AGENTIC',model_revision_scope:'test'},set={status:'ready',name:'S',description_profiles:{unguided:{conditions:settings}},representative_images:[{}],sources:[{}]};
  const base={config:{ready:true},video:{display_name:'V',duration_s:30},set,mode:'few_shot',strategy:'text_only',settings,busy:false,consent:false};assert.equal(analysisReadiness(base).ready,false);assert.match(analysisReadiness(base).message,/同意/);assert.equal(analysisReadiness({...base,consent:true}).ready,true);assert.equal(analysisReadiness({...base,consent:true,settings:{...settings,audio_enabled:true}}).ready,false);assert.equal(analysisReadiness({...base,consent:true,strategy:'visual_evidence',set:{...set,media_state:{images_missing:1}}}).ready,false);
});
