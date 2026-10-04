import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TasService} from '../src/pipeline.js';
import {tasConfig} from '../src/settings.js';
import {id,sha256,delay} from '../src/core.js';
import {MockModelAdapter,mockObservation} from '../src/mock-model.js';
import {GeapAdapter} from '../src/geap.js';
import {LocalStore} from '../src/store.js';
import {NAMING_SCHEMA,ALIGNMENT_SCHEMA,validateNaming,validateAlignment,exampleView} from '../src/discovery-contracts.js';
import {buildOpen,openPrompts} from '../src/discovery.js';
import {analysisReadiness} from '../public/analysis-state.js';
import {createAppServer} from '../server.js';
import {STARTUP_FINGERPRINT,FEATURES} from '../src/implementation.js';
import net from 'node:net';
import {pathToFileURL} from 'node:url';

async function wait(service,runId){for(let n=0;n<500;n++){const s=await service.status(runId);if(['succeeded','failed','cancelled','interrupted'].includes(s.status))return s;await delay(80);}throw Error('timeout');}
async function fixture(t,{real=false,hooks={}}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tas-open-cycle-')),store=new LocalStore(root);
  const config={...tasConfig({MOCK_MODE:'true'}),dataRoot:root,mockDelayMs:0,allowFaults:true};
  const media={versions:async()=>({ffmpeg:'test',ffprobe:'test'}),recoverPartials:async()=>{},prepare:async a=>{assert.equal(await store.exists(a.asset_ref),true);return {...a,source_sha256:a.sha256,preprocess_version:'test.v1',transform:{version:'test.v1'}};}};
  const mock=new MockModelAdapter(config),sent=[];
  let model=mock,cloud;
  if(real){Object.assign(config,{mockMode:false,approvedReal:true,maxUploadBytes:999999,minFreeBytes:1,bucket:'isolated',project:'isolated',location:'global',host:'https://example.invalid',modelStage1:'test-stage1',modelStage2:'test-stage2',revisionScope:'test',timeoutMs:10000});
    model=new GeapAdapter(config,{tokenProvider:async()=> 'test-only',fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);sent.push(body);const context=JSON.parse(body.contents[0].parts[0].text),schema=body.generationConfig.responseSchema,kind=schema===null?'':schema.properties.schema_version.enum[0];let stage,input,video;
      if(kind==='stage1.discover.v1'){stage='stage1';video={duration_s:context.duration_s};}else{stage=kind==='observation-naming.v1'?'naming':'alignment';input={segments:context.intervals,examples:context.examples??[]};}
      const res=await mock.call({stage,input,video,settings:{audio_enabled:false},body});return new Response(JSON.stringify(res.payload),{status:200});}});
    cloud={upload:async()=> 'isolated-generation',remove:async()=>{},metadata:async()=>({generation:'isolated-generation'})};
  }
  const service=new TasService(config,{store,media,model,cloud,hooks,authCheck:async()=> 'test-only'});await service.ready;
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5});});
  for(const [videoId,duration] of [['video-a',12],['video-b',18]]){const asset={asset_id:videoId,video_id:videoId,asset_ref:`media/${videoId}/original.mp4`,mime_type:'video/mp4',sha256:sha256(videoId),duration_s:duration,video_timeline:{version:'primary-video-stream.v1'},synthetic:true};await store.immutable(`media/${videoId}/asset.json`,asset);await fs.writeFile(store.resolve(asset.asset_ref),'isolated fixture');}
  const request=(video='video-a',extra={})=>({client_request_id:id(),input_video_id:video,label_policy:'observation_open.v1',analysis_strategy:'text_only',analysis_mode:'zero_shot',consent_confirmed:true,...extra});
  return {service,request,sent,root};
}
function reviewBody(result,confirmed=true){return {editor:'reviewer',comment:'',original_result_sha256:sha256(result),segments:result.segments.map(s=>({segment_id:s.segment_id,task_type_id:s.task_type_id,start_s:s.start_s,end_s:s.end_s,reviewed_title:'新しい自由名',action_description:s.action_description,observation:s.observation,human_evidence_note:'映像の手・物体・位置と根拠を確認',confirmed_fields:confirmed?['boundaries','title','action_description','observation','evidence']:[]}))};}
async function analysis(service,request){const r=await service.createAnalysis(request),s=await wait(service,r.run_id);assert.equal(s.status,'succeeded',JSON.stringify(s.error));return service.result(r.run_id);}
async function standard(service,result,review){return service.createReviewedStandard({source_run_id:result.run_id,review_id:review.review_id,review_sha256:review.content_sha256,segment_ids:review.segments.map(s=>s.segment_id),name:'レビュー由来見本',confirmed_by:'reviewer'});}

for(const real of [false,true])test(`observation cycle with zero vocabulary and immutable review -> reference -> B (${real?'REAL adapter replaced transport':'mock'})`,async t=>{
  const {service,request,sent}=await fixture(t,{real});assert.equal((await service.vocabularies()).length,0);
  const a=await analysis(service,request());assert.equal(a.vocabulary,null);assert.equal(a.discriminators,null);assert.equal(a.naming.output.schema_version,'observation-naming.v1');assert.ok(a.segments[0].action_description.includes(a.segments[0].observation.operation.value));
  const rev=await service.saveReview(a.run_id,reviewBody(a)),ref=await standard(service,a,rev);assert.equal(ref.source_artifact_kind,'stage1.discover.v1');assert.equal(ref.source_stage1_artifact_sha256,a.stage1.artifact_sha256);assert.equal(ref.examples[0].standard_duration_s,null);assert.notEqual(ref.examples[0].reference_task_id,ref.examples[1].reference_task_id);assert.equal(ref.examples[0].reviewed_title,ref.examples[1].reviewed_title);assert.deepEqual(await service.result(a.run_id),a);
  const b=await analysis(service,request('video-b',{analysis_mode:'few_shot',reviewed_standard_id:ref.standard_id}));assert.ok(b.alignment);assert.equal(b.segments[0].title_status,'ai_proposed');assert.notEqual(b.segments[0].proposed_title,ref.examples[0].reviewed_title);assert.deepEqual(b.segments.map(s=>[s.segment_id,s.start_s,s.end_s]),b.stage1.output.segments.map(s=>[s.segment_id,s.start_s,s.end_s]));assert.equal(b.alignment.human_confirmed,false);assert.equal(b.alignment.time_allocation,null);
  const later=reviewBody(a);later.segments[0].reviewed_title='後日改名';await service.saveReview(a.run_id,later);assert.equal((await service.getReviewedStandard(ref.standard_id)).content_sha256,ref.content_sha256);
  const bZero=await analysis(service,request('video-b',{stage1_artifact_id:b.stage1.artifact_id}));assert.equal(bZero.stage1.artifact_id,b.stage1.artifact_id);assert.equal(bZero.alignment,null);
  for(const run of [a,b,bZero])for(const attempt of run.attempts){const body=await service.store.read(attempt.request_ref),context=JSON.parse(body.contents[0].parts[0].text);assert.equal('vocabulary' in context,false);assert.equal('discriminators' in context,false);if(context.examples){const text=JSON.stringify(context.examples);for(const prohibited of ['start_s','end_s','duration_s','source_run_id','review_id','standard_order','source_video','gt_'])assert.equal(text.includes(prohibited),false);}}
  if(real){assert.equal(a.mock,false);assert.ok(sent.some(b=>sha256(b.generationConfig.responseSchema)===sha256(NAMING_SCHEMA)));assert.ok(sent.some(b=>sha256(b.generationConfig.responseSchema)===sha256(ALIGNMENT_SCHEMA)));assert.equal((await service.status(b.run_id)).cleanup.cleanup_status,'deleted');}
});

test('consent, unsupported combinations, GT injection, absent/same reference and unconfirmed review are rejected',async t=>{
  const {service,request}=await fixture(t);await assert.rejects(service.createAnalysis(request('video-a',{consent_confirmed:false})),{code:'CONSENT_REQUIRED'});
  for(const partition of ['whole','chunked'])for(const strategy of ['text_only','vocabulary_guided','visual_evidence','joint'])if(partition!=='whole'||strategy!=='text_only')await assert.rejects(service.createAnalysis(request('video-a',{video_partition:partition,analysis_strategy:strategy})),{code:'OPEN_FLOW_UNSUPPORTED'});
  await assert.rejects(service.createAnalysis(request('video-a',{gt_ref:'secret'})),{code:'INVALID_INPUT'});await assert.rejects(service.createAnalysis(request('video-a',{vocabulary_ref:'arbitrary'})),{code:'OPEN_INPUT_CONFLICT'});await assert.rejects(service.createAnalysis(request('video-b',{analysis_mode:'few_shot'})),{code:'REVIEW_STANDARD_REQUIRED'});
  const a=await analysis(service,request());const r=await service.saveReview(a.run_id,reviewBody(a,false));await assert.rejects(standard(service,a,r),{code:'EXAMPLE_UNCONFIRMED'});await assert.rejects(standard(service,a,{...r,review_id:'not-saved'}),{code:'SAVED_REVIEW_REQUIRED'});await assert.rejects(standard(service,a,{...r,content_sha256:'wrong'}),{code:'REVIEW_HASH_MISMATCH'});
  const ref=await standard(service,a,await service.saveReview(a.run_id,reviewBody(a)));await assert.rejects(service.createAnalysis(request('video-a',{analysis_mode:'few_shot',reviewed_standard_id:ref.standard_id})),{code:'REFERENCE_EQUALS_TARGET'});await assert.rejects(service.saveReview(a.run_id,{...reviewBody(a),original_result_sha256:'wrong'}),{code:'RESULT_HASH_MISMATCH'});await assert.rejects(service.rederiveSafety(a.run_id,{client_request_id:id()}),{code:'OPEN_SAFETY_UNSUPPORTED'});
});

test('fixed response validators reject invented times, evidence, duplication; support grain differences, repetition, short/unknown tasks',async()=>{
  const segments=[{segment_id:'s1',start_s:0,end_s:.2},{segment_id:'s2',start_s:.2,end_s:6}].map((s,i)=>({...s,observation:mockObservation(s,i)}));
  const output={schema_version:'observation-naming.v1',tasks:segments.map(s=>({segment_id:s.segment_id,proposed_title:'同名',action_description:'片手で部品を治具へ置く',knowledge_status:'observed',reason:'物体と位置の変化',missing_information:[],evidence_refs:[{segment_id:s.segment_id,field:'operation',evidence_id:'ev-1'}]}))};validateNaming(output,segments);assert.throws(()=>validateNaming({...output,tasks:output.tasks.map(t=>({...t,start_s:0}))},segments),{code:'INVALID_DISCOVERY'});assert.throws(()=>validateNaming({...output,tasks:output.tasks.map(t=>({...t,evidence_refs:[{segment_id:t.segment_id,field:'operation',evidence_id:'fake'}]}))},segments),{code:'INVALID_DISCOVERY'});
  const examples=segments.map((s,i)=>({example_id:'e'+i,observation:s.observation}));const relation={segment_ids:['s1','s2'],example_ids:['e0'],status:'candidate',reason:'物体・操作・位置が連続する候補',missing_information:[],evidence_refs:output.tasks[0].evidence_refs,example_evidence_refs:[{example_id:'e0',field:'operation',evidence_id:'ev-1'}]};const aligned={schema_version:'task-alignment.v1',relations:[relation],unmatched_example_ids:['e1']};validateAlignment(aligned,segments,examples);validateAlignment({...aligned,relations:[{...relation,segment_ids:['s1'],example_ids:['e0','e1'],example_evidence_refs:examples.map(e=>({example_id:e.example_id,field:'operation',evidence_id:'ev-1'}))},{segment_ids:['s2'],example_ids:[],status:'reference_unmatched',reason:'見本にない操作',missing_information:[],evidence_refs:[],example_evidence_refs:[]}],unmatched_example_ids:[]},segments,examples);assert.throws(()=>validateAlignment({...aligned,relations:[relation,relation]},segments,examples),{code:'INVALID_DISCOVERY'});assert.throws(()=>validateAlignment({...aligned,relations:[{...relation,start_s:0}]},segments,examples),{code:'INVALID_DISCOVERY'});
  const prompts=await openPrompts();assert.throws(()=>buildOpen({segments:segments.map(s=>({...s,observation:{...s.observation,gt_ref:'x'}})),settings:{stage2_generation_config:{}},prompts}),{code:'GT_LEAK'});
});

test('naming binds evidence to its own interval, including repeated evidence IDs and uncertainty',()=>{
  const segments=[{segment_id:'s1',start_s:0,end_s:6},{segment_id:'s2',start_s:6,end_s:12}].map((s,i)=>({...s,observation:mockObservation(s,i)}));
  const output={schema_version:'observation-naming.v1',tasks:segments.map(s=>({segment_id:s.segment_id,proposed_title:'部品を置く',action_description:'手で部品を治具へ置く',knowledge_status:'observed',reason:'対象区間の手・物体・位置',missing_information:[],evidence_refs:[{segment_id:s.segment_id,field:'operation',evidence_id:'ev-1'}]}))};
  const before=structuredClone(output);
  assert.equal(validateNaming(output,segments),output);
  assert.deepEqual(output,before);
  // ev-1 exists in both intervals: its text alone must never identify the source.
  const crossed=structuredClone(output);
  crossed.tasks.forEach((task,i)=>task.evidence_refs[0].segment_id=segments[1-i].segment_id);
  assert.throws(()=>validateNaming(crossed,segments),{code:'INVALID_DISCOVERY'});
  for(const status of ['uncertain','unknown']){
    const uncertain=structuredClone(output);
    uncertain.tasks.forEach(task=>Object.assign(task,{knowledge_status:status,missing_information:['遮蔽で対象物の状態が不明'],evidence_refs:[]}));
    const insufficient=segments.map(s=>({...s,observation:{...s.observation,insufficient_discriminative_features:true}}));
    assert.equal(validateNaming(uncertain,insufficient),uncertain);
    assert.throws(()=>validateNaming({...crossed,tasks:crossed.tasks.map(task=>({...task,knowledge_status:status,missing_information:['不足']}))},segments),{code:'INVALID_DISCOVERY'});
    assert.throws(()=>validateNaming(output,insufficient),{code:'INVALID_DISCOVERY'});
  }
  assert.throws(()=>validateNaming({...output,tasks:output.tasks.map(task=>({...task,evidence_refs:[]}))},segments),{code:'INVALID_DISCOVERY'});
  // Also reject a real ID that occurs only in the other interval.
  segments[1].observation.evidence[0].evidence_id='other-only';
  for(const field of Object.values(segments[1].observation))if(field?.evidence_ids)field.evidence_ids=field.evidence_ids.map(id=>id==='ev-1'?'other-only':id);
  crossed.tasks[0].evidence_refs[0].evidence_id='other-only';
  assert.throws(()=>validateNaming(crossed,segments),{code:'INVALID_DISCOVERY'});
});

for(const real of [false,true])test(`cross-interval naming cannot persist a successful result (${real?'replaced REAL':'mock'})`,async t=>{
  const {service,request}=await fixture(t,{real});
  const call=service.model.call.bind(service.model);
  service.model.call=async args=>{
    const response=await call(args);
    if(args.stage==='naming')response.output.tasks.forEach((task,i)=>task.evidence_refs.forEach(ref=>ref.segment_id=args.input.segments[1-i].segment_id));
    return response;
  };
  const run=await service.createAnalysis(request()),status=await wait(service,run.run_id);
  assert.equal(status.status,'failed');assert.equal(status.error.code,'INVALID_DISCOVERY');
  assert.ok(status.stage1);
  for(const file of ['discovery.json','alignment.json','result.json'])assert.equal(await service.store.exists(`runs/${run.run_id}/${file}`),false);
  const saved=await service.store.read(`runs/${run.run_id}/run.json`);
  assert.equal(saved.attempts.filter(attempt=>attempt.stage==='naming').length,1);
  assert.equal(await service.store.exists(saved.attempts.at(-1).response_ref),true);
});

test('changed boundaries require fitting human observation and confirmations; rename preserves interval ID',async t=>{
  const {service,request}=await fixture(t),a=await analysis(service,request());let body=reviewBody(a);body.segments[0].reviewed_title='改名';const r=await service.saveReview(a.run_id,body);assert.equal(r.segments[0].segment_id,a.segments[0].segment_id);assert.equal(r.segments[0].observation_origin,'stage1_discover');
  body=reviewBody(a);body.segments[0].end_s=5;body.segments[1].start_s=5;body.segments[1].observation=mockObservation(body.segments[1],1);body.segments[1].confirmed_fields=[];const pending=await service.saveReview(a.run_id,body);await assert.rejects(standard(service,a,pending),{code:'EXAMPLE_UNCONFIRMED'});body.segments[1].confirmed_fields=['boundaries','title','action_description','observation','evidence'];const confirmed=await service.saveReview(a.run_id,body),ref=await standard(service,a,confirmed);assert.equal(ref.examples[1].observation_origin,'human_review');
});

test('save failure and cancellation keep original and Stage1; retry freezes snapshot; restart verifies result',async t=>{
  let fail=true;const {service,request,root}=await fixture(t,{hooks:{beforeResultSave:async()=>{if(fail)throw Error('isolated persistence failure');}}});const run=await service.createAnalysis(request());assert.equal((await wait(service,run.run_id)).status,'failed');const original=await service.store.read(`runs/${run.run_id}/run.json`);assert.ok(original.stage1,JSON.stringify(original.error));fail=false;const retry=await service.retry(run.run_id,id());assert.equal((await wait(service,retry.run_id)).status,'succeeded');const result=await service.result(retry.run_id);assert.equal(result.stage1.artifact_id,original.stage1.artifact_id);assert.equal(retry.snapshot.label_policy,original.snapshot.label_policy);
  const originalImmutable=service.store.immutable.bind(service.store);service.store.immutable=async(ref,value)=>{if(ref.includes('/reviews/'))throw Error('isolated disk failure');return originalImmutable(ref,value);};await assert.rejects(service.saveReview(result.run_id,reviewBody(result)),/isolated disk failure/);assert.deepEqual(await service.result(result.run_id),result);service.store.immutable=originalImmutable;
  service.hooks.beforeResultSave=async r=>{await service.cancel(r.run_id);};const cancelled=await service.createAnalysis(request('video-b'));assert.equal((await wait(service,cancelled.run_id)).status,'cancelled');assert.equal(await service.store.exists(`runs/${cancelled.run_id}/result.json`),false);
  await service.close();const resumed=new TasService({...service.config,dataRoot:root},{media:service.media});await resumed.ready;t.after(()=>resumed.close());assert.equal((await resumed.status(result.run_id)).status,'succeeded');assert.equal(sha256(await resumed.result(result.run_id)),sha256(result));
});

test('new UI readiness allows empty vocabulary, requires consent and reports unsupported modes',()=>{
  const base={config:{ready:true},video:{sha256:'b',display_name:'B',duration_s:10},mode:'zero_shot',strategy:'text_only',partition:'whole',settings:{},busy:false,consent:true,labelPolicy:'observation_open.v1'};assert.equal(analysisReadiness(base).ready,true);assert.equal(analysisReadiness({...base,consent:false}).ready,false);assert.equal(analysisReadiness({...base,strategy:'vocabulary_guided'}).ready,false);assert.equal(analysisReadiness({...base,mode:'few_shot',reviewedStandard:{name:'A',source_video_sha256:'a'}}).ready,true);assert.equal(analysisReadiness({...base,mode:'few_shot',reviewedStandard:{name:'B',source_video_sha256:'b'}}).ready,false);
});

test('REAL HTTP admission, served UI and health identify the same cycle implementation; no cloud transport',async t=>{
  const {service,request}=await fixture(t,{real:true});const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const server=createAppServer({...service.config,port},{tasService:service});await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${port}`;
  const health=await (await fetch(base+'/api/health')).json();assert.equal(health.mode,'geap');assert.equal(health.implementation.fingerprint,STARTUP_FINGERPRINT);assert.deepEqual(health.implementation.features,FEATURES);assert.equal(health.implementation.assets_consistent,true);
  assert.match(await (await fetch(base+'/analysis.html')).text(),/labelPolicy/);assert.match(await (await fetch(base+'/discovery-review.js')).text(),/reviewed-standards/);
  const session=await (await fetch(base+'/api/session')).json();const post=async(url,body)=>{const response=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-local-token':session.token},body:JSON.stringify(body)});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  const run=await post('/api/analysis-runs',request());assert.equal((await wait(service,run.run_id)).status,'succeeded');const a=await (await fetch(base+`/api/analysis-runs/${run.run_id}/result`)).json();assert.equal(a.implementation_fingerprint,health.implementation.fingerprint);
  const review=await post(`/api/analysis-runs/${a.run_id}/reviews`,reviewBody(a));const ref=await post('/api/reviewed-standards',{source_run_id:a.run_id,review_id:review.review_id,review_sha256:review.content_sha256,segment_ids:review.segments.map(s=>s.segment_id),name:'HTTP確認見本',confirmed_by:'HTTP test'});const b=await post('/api/analysis-runs',request('video-b',{analysis_mode:'few_shot',reviewed_standard_id:ref.standard_id}));assert.equal((await wait(service,b.run_id)).status,'succeeded');assert.equal((await service.result(b.run_id)).alignment.standard_id,ref.standard_id);
});

test('unknown remote outcome, alignment partial failure, missing reference/media and cleanup failure remain separate',async t=>{
  const {service,request}=await fixture(t);const a=await analysis(service,request()),ref=await standard(service,a,await service.saveReview(a.run_id,reviewBody(a)));const originalCall=service.model.call.bind(service.model);
  service.model.call=async args=>{if(args.stage==='alignment')throw Object.assign(Error('remote unknown'),{code:'REMOTE_OUTCOME_UNKNOWN'});return originalCall(args);};const failed=await service.createAnalysis(request('video-b',{analysis_mode:'few_shot',reviewed_standard_id:ref.standard_id}));const status=await wait(service,failed.run_id);assert.equal(status.status,'failed');assert.equal(status.error.code,'REMOTE_OUTCOME_UNKNOWN');assert.equal(await service.store.exists(`runs/${failed.run_id}/discovery.json`),true);assert.equal(await service.store.exists(`runs/${failed.run_id}/result.json`),false);assert.equal((await service.store.read(`runs/${failed.run_id}/run.json`)).attempts.filter(a=>a.stage==='alignment').length,0);
  service.model.call=originalCall;service.cleanup.failRemove=async()=>{throw Error('isolated cleanup failure');};const retried=await service.retry(failed.run_id,id());assert.equal((await wait(service,retried.run_id)).status,'succeeded');assert.equal(retried.snapshot.reviewed_standard_sha256,ref.content_sha256);
  const current=await service.store.read(`runs/${retried.run_id}/run.json`);assert.equal(current.snapshot.review_example_view_sha256,sha256(exampleView(ref)));
  const cleanupFailure=await analysis(service,request('video-b',{settings:{fps:2}}));assert.equal((await service.status(cleanupFailure.run_id)).status,'succeeded');assert.equal((await service.status(cleanupFailure.run_id)).cleanup.cleanup_status,'retry_wait');
  await fs.rm(service.store.resolve('media/video-a/original.mp4'));assert.equal((await service.reviewedStandards())[0].source_video_available,false);await fs.rm(service.store.resolve(`reviewed-standards/${ref.standard_id}/standard.json`));await assert.rejects(service.createAnalysis(request('video-b',{analysis_mode:'few_shot',reviewed_standard_id:ref.standard_id})),{code:'REVIEW_STANDARD_UNAVAILABLE'});assert.equal((await service.result(retried.run_id)).alignment.standard_sha256,ref.content_sha256);
});

test('REAL unknown naming response is recorded once, never automatically resent, and retains Stage1',async t=>{
  const {service,request}=await fixture(t,{real:true});const originalFetch=service.model.fetch;let unknownCalls=0;
  service.model.fetch=async(url,options)=>{if(JSON.parse(options.body).generationConfig.responseSchema.properties.schema_version.enum[0]==='observation-naming.v1'){unknownCalls++;throw Error('isolated connection loss');}return originalFetch(url,options);};
  const run=await service.createAnalysis(request()),status=await wait(service,run.run_id);assert.equal(status.status,'failed');assert.equal(status.remote_outcome_unknown,true);assert.equal(status.error.code,'REMOTE_OUTCOME_UNKNOWN');assert.equal(unknownCalls,1);assert.ok(status.stage1);const saved=await service.store.read(`runs/${run.run_id}/run.json`);const attempt=saved.attempts.at(-1);assert.equal(attempt.stage,'naming');assert.equal(attempt.remote_outcome_unknown,true);assert.equal(await service.store.exists(attempt.request_ref),true);assert.equal(await service.store.exists(attempt.response_ref),true);
});

test('startup fingerprint stays frozen after disk changes and prevents serving mixed UI/backend',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tas-fingerprint-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
  for(const directory of ['src','public','prompts'])await fs.cp(new URL(`../${directory}`,import.meta.url),path.join(root,directory),{recursive:true});for(const file of ['server.js','package.json'])await fs.copyFile(new URL(`../${file}`,import.meta.url),path.join(root,file));
  const isolated=await import(pathToFileURL(path.join(root,'server.js')));const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));const server=isolated.createAppServer({mockMode:true,port,dataRoot:path.join(root,'isolated-data')});await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${port}`;
  const before=await (await fetch(base+'/api/health')).json();await fs.appendFile(path.join(root,'public','analysis.html'),'\n<!-- isolated changed asset -->');const after=await (await fetch(base+'/api/health')).json();assert.equal(after.implementation.fingerprint,before.implementation.fingerprint);assert.equal(after.implementation.assets_consistent,false);assert.equal((await fetch(base+'/analysis.html')).status,409);assert.equal((await fetch(base+'/api/config')).status,409);
});
