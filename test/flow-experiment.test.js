import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixture,waitRun} from '../test-support/fixture.js';
import {id,sha256,fault} from '../src/core.js';
import {planUnits,originalTime,mergeUnits,validateJoint,validateFlow,buildJoint,jointPrompt} from '../src/flow-experiment.js';
import {auditRequest} from '../src/inputs.js';

const request=(demo,strategy,partition,extra={})=>({client_request_id:id(),input_video_id:demo.actual_video_id,standard_set_id:demo.standard_set_id,analysis_mode:'zero_shot',analysis_strategy:strategy,video_partition:partition,consent_confirmed:true,...extra});
test('eight independent combinations, persistence, retry and shared Stage1',async t=>{
  const {service,demo}=await fixture(t);let firstStage1;
  for(const partition of ['whole','chunked'])for(const strategy of ['text_only','vocabulary_guided','visual_evidence','joint']){
    const run=await service.createAnalysis(request(demo,strategy,partition));const status=await waitRun(service,run.run_id);assert.equal(status.status,'succeeded',JSON.stringify(status.error));
    const result=await service.result(run.run_id);assert.equal(result.video_partition,partition);assert.equal(result.analysis_strategy,strategy);
    const experimental=partition==='chunked'||strategy==='joint';assert.equal(result.schema_version,experimental?'flow-experiment.result.v1':'tas-result.v1');
    if(experimental){assert.equal(run.stage1,null);assert.equal(result.accuracy_claim,null);const child=await service.store.read(`experiments/${run.run_id}/unit-0/result.json`);if(strategy==='text_only')firstStage1=child.stage1;if(strategy==='visual_evidence')assert.equal(child.stage1.sha256,firstStage1.sha256);if(strategy==='joint'){assert.equal(child.stage1,null);assert.equal((await service.store.read(`runs/${run.run_id}/run.json`)).attempts.length,1);}}
    const retried=await service.retry(run.run_id,id());assert.equal(retried.snapshot.video_partition,partition);assert.equal(retried.snapshot.analysis_strategy,strategy);assert.equal(retried.parent_run_id,run.run_id);assert.equal((await waitRun(service,retried.run_id)).status,'succeeded');
  }
});
test('PTS mapping uses actual start, VFR timestamps, rejects double offset and discontinuity',()=>{
  const map={version:'pts-map.v1',clock:'derived_seconds',origin_s:100,time_base_s:.001,samples:[{local_s:0,pts:382000},{local_s:.04,pts:382040},{local_s:.11,pts:382110},{local_s:330,pts:712000}]};
  assert.equal(originalTime(17.2,map),299.2);assert.equal(originalTime(.11,map),282.11);assert.throws(()=>originalTime(400,map));assert.throws(()=>originalTime(1,{...map,clock:'original_seconds'}));assert.throws(()=>originalTime(1,{...map,samples:[{local_s:0,pts:0},{local_s:10,pts:20000}]}));
});
test('conservative ownership preserves repetitions, short work, missing core and seam',()=>{
  const units=planUnits(601,'chunked');assert.equal(units.length,3);assert.equal(units[1].window_start_s,285);
  const timeline={version:'pts-map.v1',clock:'derived_seconds',origin_s:0,time_base_s:1,samples:[{local_s:0,pts:0},{local_s:315,pts:315}]};
  const children=[{unit:units[0],timeline,segments:[{segment_id:'a',start_s:0,end_s:299.9,job_title:'反復'},{segment_id:'b',start_s:299.9,end_s:300,job_title:'反復'},{segment_id:'c',start_s:300,end_s:315,job_title:'短作業'}],unresolved:[]}];
  const result=mergeUnits(units,children);assert.equal(result.segments.length,2);assert.equal(result.segments[1].end_s-result.segments[1].start_s,.10000000000002274);assert.equal(result.complete,false);assert.ok(result.unresolved.some(u=>u.reason==='failed_or_unfinished_core'));assert.equal(sha256(result),sha256(mergeUnits(units,children)));
});
test('joint contract rejects structural invalidity, holes, vocabulary and GT',async()=>{
  const vocabulary={labels:[{job_no:'a',job_title:'A',kind:'work'}]},output={schema_version:'joint.response.v1',segments:[{segment_id:'s',start_s:0,end_s:1,job_no:'a',job_title:'A',evidence:[{start_s:0,end_s:.5,description:'見えた'}]}],unresolved:[]};
  assert.equal(validateJoint(output,1,vocabulary),output);assert.throws(()=>validateJoint({...output,segments:[{...output.segments[0],end_s:.9}]},1,vocabulary));assert.throws(()=>validateJoint({...output,segments:[{...output.segments[0],job_no:'x'}]},1,vocabulary));assert.throws(()=>auditRequest({contents:[{parts:[{text:JSON.stringify({gt_ref:'forbidden'})}]}]}));
  const built=buildJoint({video:{uri:'mock://video',mime_type:'video/mp4',duration_s:1},settings:{audio_enabled:false,processing_mode:'STATIC',fps:1,media_resolution:'api_default',stage1_generation_config:{}},vocabulary,discriminators:{conditions:[]},analysis_mode:'zero_shot',set:null,prompt:await jointPrompt()});assert.equal(JSON.parse(built.body.contents[0].parts[0].text).schema_version,'joint.input.v1');
  assert.throws(()=>validateFlow({video_partition:'chunked',analysis_strategy:'text_only',video:{synthetic:false},mockMode:true}),/合成/);
});
test('partial failure stores provisional result and retry reuses successful child',async t=>{
  const {service,demo}=await fixture(t);const asset=await service.getMedia(demo.actual_video_id);const video={...asset,video_id:id(),asset_id:id(),duration_s:601,synthetic:true};
  // Explicit synthetic metadata fixture and prepare substitution, no user media.
  video.asset_id=video.video_id;await service.store.immutable(`media/${video.video_id}/asset.json`,video);
  const prepare=service.media.prepare.bind(service.media);service.media.prepare=async(...args)=>args[0].video_id===video.video_id?{...video,source_sha256:video.sha256}:prepare(...args);
  const window=service.media.experimentalWindow.bind(service.media);service.media.experimentalWindow=async(asset,unit,...rest)=>asset.video_id===video.video_id?{video:{...video,duration_s:unit.window_end_s-unit.window_start_s},timeline:{version:'pts-map.v1',clock:'derived_seconds',time_base_s:1,origin_s:0,samples:[{local_s:0,pts:unit.window_start_s},{local_s:unit.window_end_s-unit.window_start_s,pts:unit.window_end_s}],validation:'synthetic_injected'}}:window(asset,unit,...rest);
  const run=await service.createAnalysis({...request(demo,'joint','chunked'),input_video_id:video.video_id,faults:{fail_unit:'unit-1'}});const status=await waitRun(service,run.run_id);assert.equal(status.status,'failed');assert.equal(status.result_available,true);
  const result=await service.result(run.run_id);assert.equal(result.children.length,2);assert.equal(result.failures.length,1);assert.equal(result.complete,false);
  const child=await service.store.read(`experiments/${run.run_id}/unit-0/result.json`);const retry=await service.retry(run.run_id,id());await waitRun(service,retry.run_id);const reused=await service.store.read(`experiments/${retry.run_id}/unit-0/result.json`);assert.equal(sha256(child),sha256(reused));assert.equal((await service.result(retry.run_id)).children.length,3);
  await assert.rejects(service.saveReview(run.run_id,{segments:[]}),/専用review/);
});
test('physical synthetic splitting validates actual frames and cleanup without remote API',async t=>{
  const {service,demo}=await fixture(t),videoId=id(),ref=`media/${videoId}/source.mp4`;
  await fs.mkdir(service.store.resolve(`media/${videoId}`),{recursive:true});
  await service.media.command(service.config.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=2:duration=601','-c:v','libx264','-an','-y',service.store.resolve(ref)]);
  const {hashFile}=await import('../src/media.js'),info=await service.media.inspect(service.store.resolve(ref),'video/mp4'),video={...info,video_id:videoId,asset_id:videoId,asset_ref:ref,sha256:await hashFile(service.store.resolve(ref)),size_bytes:(await fs.stat(service.store.resolve(ref))).size,synthetic:true,display_name:'synthetic 601s'};
  await service.store.immutable(`media/${videoId}/asset.json`,video);
  const run=await service.createAnalysis({...request(demo,'joint','chunked'),input_video_id:videoId});const status=await waitRun(service,run.run_id);assert.equal(status.result_available,true,JSON.stringify(status.error));
  const result=await service.result(run.run_id);assert.equal(result.children.length,3);assert.equal(result.failures.length,0);assert.equal(result.complete,false);assert.equal(status.status,'failed');
  const child=await service.store.read(`experiments/${run.run_id}/unit-1/result.json`);assert.equal(child.timeline.validation,'all-frame-timestamp-deltas.v1');assert.equal(originalTime(17.2,child.timeline),302.2);assert.equal(child.timeline.actual_start_s,285);assert.ok(child.timeline.samples.length>600);await service.worker;assert.ok(['deleted','not_needed'].includes((await service.cleanup.summary(run.run_id)).cleanup_status));
  const fixed=new Map();
  for(const strategy of ['text_only','visual_evidence','vocabulary_guided'])for(const mode of ['zero_shot','few_shot']){
    const next=await service.createAnalysis({...request(demo,strategy,'chunked',{analysis_mode:mode}),input_video_id:videoId});
    assert.equal((await waitRun(service,next.run_id)).status,'failed');const result=await service.result(next.run_id);
    assert.equal(result.failures.length,0);assert.equal(result.children.length,3);assert.equal(result.complete,false);
    const children=await Promise.all(result.children.map(c=>service.store.read(`experiments/${next.run_id}/${c.unit_id}/result.json`)));
    const mapping=children.map(c=>({stage1:c.stage1,unit:c.unit,segments:c.segments.map(({segment_id,start_s,end_s})=>({segment_id,start_s,end_s}))}));
    if(mode==='zero_shot')fixed.set(strategy,mapping);else assert.deepEqual(mapping,fixed.get(strategy));
    if(strategy==='visual_evidence')assert.deepEqual(mapping.map(c=>c.stage1),fixed.get('text_only').map(c=>c.stage1));
    for(const attempt of (await service.store.read(`runs/${next.run_id}/run.json`)).attempts){
      const body=await service.store.read(attempt.request_ref),parts=body.contents.flatMap(c=>c.parts);
      const text=JSON.stringify(body.contents);assert.equal(text.includes('gt_process_id'),false);assert.equal(text.includes('display_segments'),false);
      if(attempt.stage==='stage2')assert.equal(parts.some(p=>p.fileData),strategy==='visual_evidence');
      if(attempt.stage==='stage1'&&strategy!=='vocabulary_guided')assert.equal(text.includes('job_no'),false);
    }
  }
});
test('cancellation retains response artifacts, stops remaining units, and restart restores independent result',async t=>{
  const {service,demo,config}=await fixture(t);let target;
  service.hooks.phase=async(r,status)=>{if(r.run_id===target&&status==='validating')await service.cancel(r.run_id);};
  const run=await service.createAnalysis(request(demo,'joint','whole'));target=run.run_id;assert.equal((await waitRun(service,run.run_id)).status,'cancelled');
  const saved=await service.store.read(`runs/${run.run_id}/run.json`);assert.equal(saved.attempts.length,1);assert.equal(await service.store.exists(saved.attempts[0].response_ref),true);assert.equal(saved.result_sha256??null,null);
  service.hooks.phase=null;const retry=await service.retry(run.run_id,id());assert.equal((await waitRun(service,retry.run_id)).status,'succeeded');const hash=sha256(await service.result(retry.run_id));
  await service.close();const {TasService}=await import('../src/pipeline.js');const restarted=new TasService(config);await restarted.ready;t.after(()=>restarted.close());assert.equal((await restarted.status(retry.run_id)).status,'succeeded');assert.equal(sha256(await restarted.result(retry.run_id)),hash);
});
test('chunked Zero/Few use identical fixed Stage1 ownership and reject Stage2 time changes',async t=>{
  const {service,demo}=await fixture(t);let previous;const byStrategy=new Map();
  for(const mode of ['zero_shot','few_shot'])for(const strategy of ['text_only','visual_evidence','vocabulary_guided']){
    const run=await service.createAnalysis(request(demo,strategy,'chunked',{analysis_mode:mode}));assert.equal((await waitRun(service,run.run_id)).status,'succeeded');const child=await service.store.read(`experiments/${run.run_id}/unit-0/result.json`);
    if(strategy==='text_only'&&mode==='zero_shot')previous=child;if(strategy!=='vocabulary_guided') {assert.equal(child.stage1.sha256,previous.stage1.sha256);assert.deepEqual(child.segments.map(({segment_id,start_s,end_s})=>({segment_id,start_s,end_s})),previous.segments.map(({segment_id,start_s,end_s})=>({segment_id,start_s,end_s})));}
    if(mode==='zero_shot')byStrategy.set(strategy,child.stage1);else assert.deepEqual(child.stage1,byStrategy.get(strategy));
  }
  const run=await service.createAnalysis(request(demo,'text_only','chunked',{faults:{invalid_stage2:true}}));assert.equal((await waitRun(service,run.run_id)).status,'failed');const result=await service.result(run.run_id);assert.equal(result.failures[0].code,'INVALID_STAGE2');assert.equal(result.segments.length,0);
});

test('cancellation at final persistence never publishes an experimental result',async t=>{
  const {service,demo}=await fixture(t);
  service.hooks.phase=async(r,phase)=>{if(r.job_kind==='analysis'&&phase==='persisting')await service.cancel(r.run_id);};
  const run=await service.createAnalysis(request(demo,'joint','whole'));
  const status=await waitRun(service,run.run_id);
  assert.equal(status.status,'cancelled');assert.equal(status.result_available,false);
  assert.equal(await service.store.exists(`experiments/${run.run_id}/result.json`),false);
  assert.equal(await service.store.exists(`experiments/${run.run_id}/unit-0/result.json`),true);
});

test('retry refuses a successful child whose raw response changed',async t=>{
  const {service,demo}=await fixture(t);
  const run=await service.createAnalysis(request(demo,'joint','whole'));await waitRun(service,run.run_id);await service.worker;
  const saved=await service.store.read(`runs/${run.run_id}/run.json`);
  await service.store.write(saved.attempts[0].response_ref,{raw:'changed',payload:null});
  const retried=await service.retry(run.run_id,id());const status=await waitRun(service,retried.run_id);
  assert.equal(status.status,'failed');
  const result=await service.result(retried.run_id);assert.equal(result.complete,false);
  assert.equal(result.failures[0].code,'INVALID_ARTIFACT');
  assert.equal((await service.store.read(`runs/${retried.run_id}/run.json`)).attempts.length,0);
});

test('an empty successful core remains unexplained rather than complete',()=>{
  const units=planUnits(1,'whole'),timeline={version:'pts-map.v1',clock:'derived_seconds',origin_s:0,time_base_s:1,samples:[{local_s:0,pts:0},{local_s:1,pts:1}]};
  const merged=mergeUnits(units,[{unit:units[0],timeline,segments:[],unresolved:[]}]);
  assert.equal(merged.complete,false);assert.deepEqual(merged.unresolved.map(({start_s,end_s,reason})=>({start_s,end_s,reason})),[{start_s:0,end_s:1,reason:'unexplained_time'}]);
});

test('unsupported experimental safety rederivation is rejected before a run is created',async t=>{
  const {service,demo}=await fixture(t),run=await service.createAnalysis(request(demo,'joint','whole'));await waitRun(service,run.run_id);
  const before=await service.store.list('runs');
  await assert.rejects(service.rederiveSafety(run.run_id,{client_request_id:id(),safety_policy:run.snapshot.settings.safety_policy}),{code:'EXPERIMENT_REVIEW_UNSUPPORTED'});
  assert.deepEqual(await service.store.list('runs'),before);
});

test('forward discontinuity anywhere in original media is rejected before cutting a window',async()=>{
  const {MediaTools}=await import('../src/media.js');
  const media=new MediaTools({mockMode:true,ffprobe:'probe'},{resolve:ref=>ref});
  media.command=async()=>({stdout:JSON.stringify({streams:[{time_base:'1/1000'}],frames:[{best_effort_timestamp:0,pkt_duration:100},{best_effort_timestamp:100,pkt_duration:100},{best_effort_timestamp:1000,pkt_duration:100}]})});
  await assert.rejects(media.experimentalWindow({asset_ref:'source.mp4',synthetic:true,duration_s:1.1},planUnits(.2,'whole')[0],'run',{}),{code:'EXPERIMENT_PTS_UNSUPPORTED'});
});

test('persisted partial result cannot be changed into a success',async t=>{
  const {service,demo}=await fixture(t),run=await service.createAnalysis(request(demo,'joint','whole',{faults:{fail_unit:'unit-0'}}));await waitRun(service,run.run_id);await service.worker;
  const result=await service.result(run.run_id);result.complete=true;
  await service.store.write(`experiments/${run.run_id}/result.json`,result);
  await assert.rejects(service.result(run.run_id),{code:'INVALID_ARTIFACT'});
});

test('save failure keeps child and raw response without reporting result availability',async t=>{
  const {service,demo}=await fixture(t),save=service.store.immutable.bind(service.store);
  service.store.immutable=async(ref,value)=>{if(/^experiments\/[^/]+\/result.json$/.test(ref))throw fault('DISK_FULL','合成保存故障',507);return save(ref,value);};
  const run=await service.createAnalysis(request(demo,'joint','whole')),status=await waitRun(service,run.run_id);await service.worker;
  assert.equal(status.status,'failed');assert.equal(status.result_available,false);assert.equal(status.error.code,'DISK_FULL');
  assert.equal(await service.store.exists(`experiments/${run.run_id}/unit-0/result.json`),true);
  service.store.immutable=save;const retry=await service.retry(run.run_id,id());assert.equal((await waitRun(service,retry.run_id)).status,'succeeded');
  assert.equal((await service.store.read(`runs/${retry.run_id}/run.json`)).attempts.length,0);
});

test('unknown outcome stops remaining units and restart waits for an explicit retry',async t=>{
  const {service,demo,config}=await fixture(t);const call=service.model.call.bind(service.model);let calls=0;
  const original=await service.getMedia(demo.actual_video_id),video={...original,video_id:id(),duration_s:601};video.asset_id=video.video_id;await service.store.immutable(`media/${video.video_id}/asset.json`,video);
  service.media.prepare=async()=>({...video,source_sha256:video.sha256});
  service.media.experimentalWindow=async(asset,unit)=>({video:{...video,duration_s:unit.window_end_s-unit.window_start_s},timeline:{version:'pts-map.v1',clock:'derived_seconds',time_base_s:1,origin_s:0,samples:[{local_s:0,pts:unit.window_start_s},{local_s:unit.window_end_s-unit.window_start_s,pts:unit.window_end_s}],validation:'synthetic_injected'}});
  service.model.call=async args=>{if(args.stage!=='joint')return call(args);calls++;await args.onRequest({body:args.body});await args.onAttempt({body:args.body,raw_response:null,payload:null,http_status:null,elapsed_ms:0,usage:null,remote_outcome_unknown:true,error_code:'REMOTE_OUTCOME_UNKNOWN',model_id:'mock',model_version:null});throw fault('REMOTE_OUTCOME_UNKNOWN','合成結果不明',502);};
  const run=await service.createAnalysis({...request(demo,'joint','chunked'),input_video_id:video.video_id}),status=await waitRun(service,run.run_id);await service.worker;
  assert.equal(status.status,'failed');assert.equal(status.remote_outcome_unknown,true);assert.equal(calls,1);
  assert.equal(await service.store.exists(`experiments/${run.run_id}/unit-1/result.json`),false);
  await service.close();const {TasService}=await import('../src/pipeline.js'),restarted=new TasService(config);await restarted.ready;t.after(()=>restarted.close());await restarted.pump();
  const restored=await restarted.status(run.run_id);assert.equal(restored.status,'failed');assert.equal(restored.remote_outcome_unknown,true);
  assert.equal((await restarted.store.read(`runs/${run.run_id}/run.json`)).attempts.length,1);
});

test('cleanup failure is independent of successful result persistence',async t=>{
  const {service,demo}=await fixture(t);service.cleanup.failRemove=async()=>{throw fault('SYNTHETIC_CLEANUP_FAILURE','合成回収故障');};
  const run=await service.createAnalysis(request(demo,'joint','whole'));await waitRun(service,run.run_id);await service.worker;
  const status=await service.status(run.run_id);assert.equal(status.status,'succeeded');assert.equal(status.result_available,true);assert.equal(status.cleanup.cleanup_status,'retry_wait');
  service.cleanup.failRemove=null;await service.cleanup.sweep(true);assert.equal((await service.status(run.run_id)).cleanup.cleanup_status,'deleted');
});

test('restart marks an in-flight experimental call interrupted without resending',async t=>{
  const {service,demo,config}=await fixture(t);await service.worker;service.stopping=true;
  const run=await service.createAnalysis(request(demo,'joint','whole'));await service.close();
  const saved=await service.store.read(`runs/${run.run_id}/run.json`);saved.status='stage1_running';saved.active_attempt_id=id();await service.store.write(`runs/${run.run_id}/run.json`,saved);
  const {TasService}=await import('../src/pipeline.js'),restarted=new TasService(config);await restarted.ready;t.after(()=>restarted.close());await restarted.pump();
  const restored=await restarted.status(run.run_id);assert.equal(restored.status,'interrupted');assert.equal(restored.remote_outcome_unknown,true);assert.equal(restored.result_available,false);
  assert.equal((await restarted.store.read(`runs/${run.run_id}/run.json`)).attempts.length,0);
});

test('a run arriving during the last worker scan is processed once and the pump stops',async t=>{
  const {service,demo}=await fixture(t);await service.worker;
  const list=service.store.list.bind(service.store);let queued=null,scans=0;
  service.store.list=async ref=>{const prior=await list(ref);if(ref==='runs'){scans++;if(!queued)queued=await service.createAnalysis(request(demo,'joint','whole'));}return prior;};
  await service.pump();assert.ok(queued);assert.equal((await waitRun(service,queued.run_id)).status,'succeeded');await service.worker;
  assert.equal((await service.store.read(`runs/${queued.run_id}/run.json`)).attempts.length,1);assert.ok(scans<10);assert.equal(service.worker,null);
});
