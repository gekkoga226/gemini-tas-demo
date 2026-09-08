import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TasService} from '../src/pipeline.js';
import {tasConfig,defaultSettings} from '../src/settings.js';
import {id,delay,sha256} from '../src/core.js';
import {validateStage1,validateStage2,saveStage2} from '../src/contracts.js';

async function waitRun(service,runId) {for(let n=0;n<1000;n++){const r=await service.status(runId);if(['succeeded','failed','cancelled','interrupted','awaiting_approval'].includes(r.status))return r;await delay(20);}throw new Error('local job timeout');}
export async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tas-round18-'));const config={...tasConfig({MOCK_MODE:'true'}),dataRoot:root,mockDelayMs:10,allowFaults:true};const service=new TasService(config);await service.ready;t.after(()=>service.close());const demo=await service.demo();const built=await waitRun(service,demo.run_id);assert.equal(built.status,'awaiting_approval',JSON.stringify(built.error));await service.approve(demo.standard_set_id,'local-test');return {service,config,demo};
}
test('Round 18: published assets, six conditions, immutable times, evidence, shared artifacts and reviews',async t=>{
  const {service,config,demo}=await fixture(t);const settings=defaultSettings(config);const results=[];
  for(const strategy of ['text_only','visual_evidence','vocabulary_guided'])for(const mode of ['few_shot','zero_shot']){
    const r=await service.createAnalysis({client_request_id:id(),input_video_id:demo.actual_video_id,standard_set_id:demo.standard_set_id,analysis_strategy:strategy,analysis_mode:mode,settings,consent_confirmed:true});const status=await waitRun(service,r.run_id);assert.equal(status.status,'succeeded',JSON.stringify(status.error));const result=await service.result(r.run_id);results.push(result);assert.equal(result.mock,true);assert.equal(result.metrics_runtime.cost.total,null);assert.deepEqual(result.segments.map(s=>[s.segment_id,s.start_s,s.end_s]),result.stage1.output.segments.map(s=>[s.segment_id,s.start_s,s.end_s]));assert.equal(result.segments[2].confidence_raw,.92);assert.equal(result.segments[2].confidence,.49);
  }
  assert.equal(new Set(results.slice(0,4).map(r=>r.stage1.artifact_id)).size,1);assert.notEqual(results[0].stage1.cache_key,results[2].stage1.cache_key);assert.notEqual(results[0].stage1.artifact_id,results[4].stage1.artifact_id);assert.equal(results[4].stage1.artifact_id,results[5].stage1.artifact_id);
  const result=results[0],segments=result.segments.map(({segment_id,start_s,end_s,job_no,job_title,page_number})=>({segment_id,start_s,end_s,job_no,job_title,page_number}));const review=await service.saveReview(result.run_id,{editor:'確認者',original_result_sha256:sha256(result),segments});assert.equal(review.original_run_id,result.run_id);assert.deepEqual(review.original_result,result);assert.equal(sha256(review.original_result),review.original_result_sha256);assert.deepEqual(await service.result(result.run_id),result);
  const changed=structuredClone(segments);changed.at(-1).end_s=27;
  changed.push({...segments.at(-1),segment_id:'human-added-test',start_s:27,end_s:30});
  const humanReview=await service.saveReview(result.run_id,{editor:'追加の確認者',original_result_sha256:sha256(result),segments:changed});
  assert.equal(humanReview.segments.at(-1).human_added,true);assert.equal(humanReview.segments.at(-1).observation,null);
  assert.deepEqual(humanReview.original_result,result);assert.deepEqual(await service.result(result.run_id),result);
  await assert.rejects(service.saveReview(result.run_id,{editor:'追加の確認者',original_result_sha256:sha256(result),segments:changed.map(s=>s.segment_id==='human-added-test'?{...s,job_no:'free-text'}:s)}),{code:'INVALID_REVIEW'});
  const set=await service.getSet(demo.standard_set_id);assert.equal(set.representative_images.length,12);assert.ok(set.representative_images.every(i=>i.extracted_time_s>=0&&i.width<=768&&i.height<=768&&i.gt_process_id));
  for(const k of await service.store.list('runs')){const run=await service.store.read(`runs/${k}/run.json`);if(run.job_kind!=='analysis')continue;for(const attempt of run.attempts){const body=await service.store.read(attempt.request_ref);const text=JSON.stringify(body.contents);assert.equal(text.includes('build_only_gt'),false);assert.equal(text.includes('gt_process_id'),false);assert.equal(text.includes('display_segments'),false);if(attempt.stage==='stage1'&&run.snapshot.analysis_strategy!=='vocabulary_guided')assert.equal(text.includes('job_no'),false);if(attempt.stage==='stage2'&&run.snapshot.analysis_mode==='zero_shot')assert.equal(text.includes('example_id'),false);}}
});
