import fs from 'node:fs/promises';
import {LocalStore,safeId} from './store.js';
import {tasConfig,normalizeSettings,defaultSettings} from './settings.js';
import {id,now,clone,sha256,canonicalJSON,demand,fault,profileFor,STRATEGIES,MODES,TERMINAL,segmentId} from './core.js';
import {validateVocabulary,validateDiscriminators,validateGT,validateStage1,joinFixed,saveStage2,SAFETY} from './contracts.js';
import {loadPrompts,buildStage1,buildStage2,stage1Key,compatibleKeys,inputSignature,profileConditions} from './inputs.js';
import {MediaTools,hashFile} from './media.js';
import {GeapAdapter,GcsAdapter,getAccessToken,parseModelOutput} from './geap.js';
import {VOCABULARY_SCHEMA} from './response-schemas.js';
import {estimateCost,validatePriceTable} from './cost.js';
import {MockModelAdapter,demoVocabulary,demoDiscriminators} from './mock-model.js';
import {CleanupLedger} from './cleanup.js';
import {secondsToTime} from '../public/segments.js';

export function displayAdapter(segments) {return segments.map(s=>({segment_id:s.segment_id,start_time:secondsToTime(s.start_s),end_time:secondsToTime(s.end_s),duration_seconds:Math.floor(s.end_s)-Math.floor(s.start_s),job_no:s.job_no,page_number:s.page_number,job_title:s.job_title,work_content:s.observation.operation.value??'不明',hand_movement:s.observation.operation.value??'不明',tools_and_parts:[s.observation.tools_held,s.observation.objects_parts].filter(x=>x.status==='observed').map(x=>x.value).join(', ')||'不明'}));}
export class TasService {
  constructor(config=tasConfig(),options={}) {
    this.config=config;this.store=options.store||new LocalStore(config.dataRoot);this.media=options.media||new MediaTools(config,this.store);
    this.model=options.model||(config.mockMode?new MockModelAdapter(config):new GeapAdapter(config));
    this.cleanup=options.cleanup||new CleanupLedger(this.store,config,options.cloud||new GcsAdapter(config));
    this.hooks=options.hooks||{};this.lock=options.lock!==false;this.worker=null;this.controller=null;this.stopping=false;this.serial=Promise.resolve();this.ready=this.initialize();
  }
  async initialize() {
    await this.store.init();if(this.lock)await this.store.acquire();
    if(this.config.priceTableRef)this.config.priceTable=validatePriceTable(JSON.parse(await fs.readFile(this.config.priceTableRef,'utf8')));
    this.environment={mode:this.config.mockMode?'mock':'geap',checks:[],ready:true};
    try {this.environment.tools=await this.media.versions();this.environment.checks.push({name:'FFmpeg / ffprobe',ok:true});} catch {this.environment.checks.push({name:'FFmpeg / ffprobe',ok:false,message:'動画登録・音声除去・画像抽出にはFFmpeg/ffprobeが必要です。'});this.environment.ready=false;}
    if(!this.config.maxUploadBytes||!this.config.minFreeBytes){this.environment.ready=false;this.environment.checks.push({name:'保存上限',ok:false,message:'MAX_UPLOAD_BYTESとMIN_FREE_BYTESを設定してください。'});}
    if(!this.config.mockMode) {try{this.model.assertReady(defaultSettings(this.config));await getAccessToken(this.config);this.environment.checks.push({name:'GEAP設定・認証取得',ok:true});}catch(e){this.environment.ready=false;this.environment.checks.push({name:'GEAP設定・認証取得',ok:false,message:e.message});}}
    await this.media.recoverPartials();
    for(const runId of await this.store.list('runs')) {
      const r=await this.store.read(`runs/${runId}/run.json`,null);if(!r)continue;
      if(await this.store.exists(`runs/${runId}/result.json`)) {const result=await this.store.read(`runs/${runId}/result.json`);if(result.schema_version==='tas-result.v1'&&result.run_id===runId){r.status='succeeded';r.result_sha256=sha256(result);r.finished_at=result.finished_at;await this.saveRun(r);}}
      else if(r.status==='cancel_requested') {r.status='cancelled';r.finished_at=now();r.remote_outcome_unknown=Boolean(r.active_attempt_id);await this.saveRun(r);}
      else if(![...TERMINAL,'queued','awaiting_approval'].includes(r.status)) {r.status='interrupted';r.error={code:'PROCESS_INTERRUPTED',stage:r.phase,message:'前回の処理が中断されました。保存済み区間から再試行できます。'};r.remote_outcome_unknown=Boolean(r.active_attempt_id);r.finished_at=now();await this.saveRun(r);}
    }
    await this.cleanup.recover();this.timer=setInterval(()=>this.cleanup.sweep().catch(()=>{}),this.config.cleanupTickMs);this.timer.unref?.();
    queueMicrotask(()=>this.pump());return this;
  }
  async exclusive(fn) {const next=this.serial.then(fn,fn);this.serial=next.catch(()=>{});return next;}
  async saveRun(r) {
    this.runWrites??=new Map();const previousWrite=this.runWrites.get(r.run_id)||Promise.resolve();
    const writing=previousWrite.then(async()=>{const prior=await this.store.read(`runs/${r.run_id}/run.json`,null);r.revision=Math.max(r.revision||0,prior?.revision||0)+1;
      if(prior?.cancel_requested){r.cancel_requested=true;if(!TERMINAL.includes(r.status))r.status='cancel_requested';for(const event of prior.phase_history.filter(e=>e.phase==='cancel_requested'))if(!r.phase_history.some(e=>e.phase===event.phase&&e.at===event.at))r.phase_history.push(event);}
      await this.store.write(`runs/${r.run_id}/run.json`,r);
    });this.runWrites.set(r.run_id,writing.catch(()=>{}));return writing;
  }
  async phase(r,status,detail=null) {
    const previous=await this.store.read(`runs/${r.run_id}/run.json`);
    if(previous.cancel_requested){r.cancel_requested=true;throw fault('CANCELLED','利用者が中断しました。');}
    this.controller?.signal.throwIfAborted();r.status=status;r.phase=status;r.phase_history.push({phase:status,at:now(),detail});await this.saveRun(r);await this.hooks.phase?.(r,status);
    if(r.snapshot.faults?.fail_phase===status)throw fault('MOCK_INJECTED_FAILURE','モックの故障注入です。通常条件で再試行してください。',500);
  }
  async getMedia(assetId) {return this.store.read(`media/${safeId(assetId)}/asset.json`);}
  async getSet(setId) {const set=await this.store.read(`standard-sets/${safeId(setId)}/manifest.json`);if(['ready','retired'].includes(set.status)){const published=await this.store.read(`standard-sets/${setId}/published.json`);demand(sha256({...published,content_sha256:null})===published.content_sha256&&sha256({...set,status:'ready'})===sha256(published),'SET_HASH_MISMATCH','公開標準セットの内容が変更されています。',409);}return set;}
  publicSet(s) {const available=STRATEGIES.filter(a=>s.status==='ready'&&s.description_profiles[profileFor(a)]&&(a!=='visual_evidence'||s.representative_images.length>0));return {schema_version:s.schema_version,standard_set_id:s.standard_set_id,parent_set_id:s.parent_set_id,name:s.name,status:s.status,approved_at:s.approved_at,approved_by:s.approved_by,source_video:s.source_video,vocabulary:s.vocabulary,discriminators:s.discriminators,display_segments:s.display_segments,description_profiles:s.description_profiles,representative_images:s.representative_images.map(({asset_ref,gt_version,gt_process_id,...rest})=>rest),available_strategies:available,provenance:s.provenance};}
  async sets() {const result=[];for(const k of await this.store.list('standard-sets')){const s=await this.store.read(`standard-sets/${k}/manifest.json`,null);if(s)result.push(this.publicSet(s));}return result;}
  async mediaList() {const list=[];for(const k of await this.store.list('media')){const a=await this.store.read(`media/${k}/asset.json`,null);if(a){const {asset_ref,...view}=a;list.push(view);}}return list;}
  async registerVocabulary(vocabulary,discriminators,{approved_by,approved_at=now(),extraction=null}={}) {
    validateVocabulary(vocabulary);validateDiscriminators(discriminators,vocabulary);demand(approved_by,'APPROVAL_REQUIRED','語彙と識別条件の確認者を入力してください。');
    await this.store.version('vocabulary',vocabulary.vocabulary_version,sha256(vocabulary));await this.store.version('discriminators',discriminators.discriminator_version,sha256(discriminators));
    const ref=id(),asset={ref,vocabulary,discriminators,approved_by,approved_at,extraction};await this.store.immutable(`vocabularies/${ref}/vocabulary.json`,asset);return asset;
  }
  async vocabularies() {const result=[];for(const k of await this.store.list('vocabularies')){const v=await this.store.read(`vocabularies/${k}/vocabulary.json`,null);if(v)result.push(v);}return result;}
  async registerGT(gt) {
    const video=await this.getMedia(gt.video_id);demand(Array.isArray(gt.segments)&&gt.segments.length&&gt.duration_s===video.duration_s,'INVALID_GT','標準動画とGT区間を確認してください。');
    validateGT(gt,video,{labels:gt.segments});
    await this.store.version(`standard-gt:${video.video_id}`,gt.gt_version,sha256(gt));
    const gtId=id();await this.store.immutable(`build-inputs/${gtId}/gt.json`,gt);return {build_gt_asset_id:gtId,sha256:sha256(gt)};
  }
  async newRun(body,kind,snapshot,extra={}) {
    snapshot={...snapshot,price_table:clone(this.config.priceTable??null)};
    if(snapshot.prompt_manifest_sha256){await this.store.version('prompt-release',snapshot.settings.prompt_release,snapshot.prompt_manifest_sha256);const prompts=await loadPrompts(snapshot.settings.prompt_release);for(const [name,p] of Object.entries(prompts.loaded))await this.store.version(`prompt:${name}`,p.version,p.sha256);}
    await this.store.version('safety-policy',snapshot.settings.safety_policy.safety_policy_version,sha256(snapshot.settings.safety_policy));
    demand(typeof body.client_request_id==='string'&&body.client_request_id.length>0&&body.client_request_id.length<=200,'REQUEST_ID_REQUIRED','操作IDが必要です。');
    const key=sha256({kind,client_request_id:body.client_request_id}),fingerprint=sha256(body);const previous=await this.store.read(`requests/${key}/request.json`,null);
    if(previous){demand(previous.sha256===fingerprint,'IDEMPOTENCY_CONFLICT','同じ操作IDで入力が変更されています。',409);return this.store.read(`runs/${previous.run_id}/run.json`);}
    const runId=id();const r={schema_version:'analysis-run.v1',run_id:runId,job_kind:kind,status:'queued',phase:'queued',revision:0,created_at:now(),started_at:null,finished_at:null,parent_run_id:body.parent_run_id??null,comparison_session_id:body.comparison_session_id??null,snapshot,attempts:[],phase_history:[{phase:'queued',at:now(),detail:null}],stage1:null,error:null,cancel_requested:false,remote_outcome_unknown:false,active_attempt_id:null,metrics:{preparation:0,upload:0,stage1:0,stage2:0,validation:0,persistence:0,cleanup:0},...extra};
    await this.saveRun(r);await this.store.immutable(`requests/${key}/request.json`,{sha256:fingerprint,run_id:runId});queueMicrotask(()=>this.pump());return r;
  }
  async createAnalysis(body) {await this.ready;return this.exclusive(async()=>{
    const allowed=['client_request_id','input_video_id','standard_set_id','vocabulary_ref','discriminator_ref','analysis_mode','analysis_strategy','settings','stage1_artifact_id','comparison_session_id','parent_run_id','consent_confirmed','faults'];
    demand(Object.keys(body).every(k=>allowed.includes(k)),'INVALID_INPUT','未対応の入力またはGTが含まれています。');
    demand(body.consent_confirmed===true,'CONSENT_REQUIRED','作業者の同意を確認してください。');demand(STRATEGIES.includes(body.analysis_strategy)&&MODES.includes(body.analysis_mode),'INVALID_MODE','分析方式とお手本の有無を選択してください。');
    const settings=normalizeSettings(body.settings,this.config),prompts=await loadPrompts(settings.prompt_release);const video=await this.getMedia(body.input_video_id);demand(video.mime_type==='video/mp4','INVALID_VIDEO','実作業動画を選択してください。');
    let set=null,vocabulary,discriminators;
    if(body.standard_set_id) {set=await this.getSet(body.standard_set_id);demand(set.status==='ready','SET_NOT_READY','公開済み標準セットを選択してください。');vocabulary=set.vocabulary;discriminators=set.discriminators;}
    else {demand(body.analysis_mode==='zero_shot'&&body.vocabulary_ref,'SET_REQUIRED','お手本か確認済み語彙を選択してください。');const v=await this.store.read(`vocabularies/${safeId(body.vocabulary_ref)}/vocabulary.json`);vocabulary=v.vocabulary;discriminators=v.discriminators;}
    if(body.vocabulary_ref) {const v=await this.store.read(`vocabularies/${safeId(body.vocabulary_ref)}/vocabulary.json`);demand(sha256(v.vocabulary)===sha256(vocabulary)&&sha256(v.discriminators)===sha256(discriminators),'VOCABULARY_MISMATCH','語彙・条件を標準セットと揃えてください。');}
    if(body.discriminator_ref)demand(body.discriminator_ref===body.vocabulary_ref,'DISCRIMINATOR_MISMATCH','対応する確認済み語彙・識別条件を指定してください。');
    validateVocabulary(vocabulary);validateDiscriminators(discriminators,vocabulary);
    if(set) {const profile=profileFor(body.analysis_strategy),d=set.description_profiles[profile];demand(d,'PROFILE_UNAVAILABLE','対応する標準記述をセット作成で生成してください。');demand(canonicalJSON(d.conditions)===canonicalJSON(profileConditions(settings,prompts,profile)),'PROFILE_INCOMPATIBLE','標準と実作業のStage1条件が異なります。対応する標準セットを作成してください。');}
    if(body.analysis_strategy==='visual_evidence'&&body.analysis_mode==='few_shot')demand(set.representative_images.length>0,'IMAGES_UNAVAILABLE','案3のお手本照合には標準代表画像が必要です。セットを作成してください。');
    if(body.comparison_session_id){const session=await this.store.read(`comparison-sessions/${safeId(body.comparison_session_id)}/session.json`);demand(session.status==='open'&&Date.parse(session.expires_at)>Date.now(),'SESSION_CLOSED','比較セッションは終了しています。');demand(sha256(settings)===sha256(session.settings)&&video.video_id===session.input_video_id&&(body.standard_set_id??null)===session.standard_set_id,'COMPARISON_CONDITION_MISMATCH','比較セッションの動画・標準・設定を固定してください。');}
    if(body.faults)demand(this.config.allowFaults,'FAULT_INJECTION_DISABLED','故障注入はモックの検証専用設定が必要です。');
    if(!this.config.mockMode)this.model.assertReady(settings);
    const snapshot={input_video_id:video.video_id,video,vocabulary_ref:body.vocabulary_ref??null,standard_set_id:body.standard_set_id??null,standard_set_sha256:set?set.content_sha256:null,vocabulary,discriminators,analysis_strategy:body.analysis_strategy,analysis_mode:body.analysis_mode,settings,stage1_artifact_id:body.stage1_artifact_id??null,consent_confirmed:true,faults:body.faults??null,prompt_manifest_sha256:prompts.sha256};
    if(snapshot.stage1_artifact_id)await this.resolveArtifact(snapshot,prompts);
    return this.newRun(body,'analysis',snapshot);
  });}
  async createStandard(body) {await this.ready;return this.exclusive(async()=>{
    demand(body.consent_confirmed===true,'CONSENT_REQUIRED','標準動画の作業者の同意を確認してください。');const settings=normalizeSettings(body.settings,this.config);const prompts=await loadPrompts(settings.prompt_release);
    const video=await this.getMedia(body.source_video_id);const gt=await this.store.read(`build-inputs/${safeId(body.build_gt_asset_id)}/gt.json`);const v=await this.store.read(`vocabularies/${safeId(body.vocabulary_ref)}/vocabulary.json`);validateGT(gt,video,v.vocabulary);
    demand(Array.isArray(body.profiles)&&body.profiles.length>0&&new Set(body.profiles).size===body.profiles.length&&body.profiles.every(p=>['unguided','guided'].includes(p)),'INVALID_PROFILE','標準記述の方式を選択してください。');
    const setId=id();const snapshot={source_video_id:video.video_id,build_gt_asset_id:body.build_gt_asset_id,vocabulary_ref:body.vocabulary_ref,profiles:body.profiles,generate_images:body.generate_images===true,settings,consent_confirmed:true,prompt_manifest_sha256:prompts.sha256};
    const r=await this.newRun(body,'standard_build',snapshot,{standard_set_id:setId});
    if(r.standard_set_id!==setId)return r;
    const s={schema_version:'standard-set.v1',standard_set_id:setId,parent_set_id:body.parent_set_id??null,name:String(body.name||'標準作業セット').slice(0,200),status:'draft',created_at:now(),approved_at:null,approved_by:null,source_video:{video_id:video.video_id,asset_ref:video.asset_ref,sha256:video.sha256,duration_s:video.duration_s,mime_type:video.mime_type},vocabulary:v.vocabulary,discriminators:v.discriminators,build_only_gt:{asset_ref:`build-inputs/${body.build_gt_asset_id}/gt.json`,sha256:sha256(gt),gt_version:gt.gt_version},description_profiles:{unguided:null,guided:null},examples:{unguided:[],guided:[]},display_segments:[],representative_images:[],provenance:{build_run_id:r.run_id,source_hashes:{video:video.sha256,gt:sha256(gt),vocabulary:sha256(v.vocabulary),discriminators:sha256(v.discriminators)},tools:null,created_at:now(),warnings:[],build_rule_version:'standard-build.v1',synthetic:this.config.mockMode},content_sha256:null};
    await this.store.write(`standard-sets/${setId}/manifest.json`,s);return r;
  });}
  async resolveArtifact(snapshot,prompts) {
    const artifact=await this.store.read(`stage1-artifacts/${safeId(snapshot.stage1_artifact_id)}/artifact.json`);const checksum=await this.store.read(`stage1-artifacts/${snapshot.stage1_artifact_id}/checksum.json`);
    demand(sha256(artifact)===checksum.sha256,'INVALID_ARTIFACT','区間分割データのハッシュが一致しません。',409);
    const video={...artifact.video,source_sha256:snapshot.video.sha256,video_id:snapshot.video.video_id};
    const key=stage1Key({strategy:snapshot.analysis_strategy,video,settings:snapshot.settings,prompts,vocabulary:snapshot.vocabulary,discriminators:snapshot.discriminators,standard_set_id:snapshot.standard_set_id});
    const migration=await this.store.read(`stage1-migrations/${sha256({artifact_id:artifact.artifact_id,key})}/migration.json`,null);
    demand((compatibleKeys(artifact.key_fields,key)||(migration?.artifact_sha256===sha256(artifact)&&migration.target_key_sha256===sha256(key)))&&artifact.video.source_sha256===snapshot.video.sha256&&artifact.video.duration_s===snapshot.video.duration_s,'INCOMPATIBLE_STAGE1','この方式・入力条件では同じ区間を再利用できません。区間分割から再分析してください。',409);
    validateStage1(artifact.output,{duration_s:video.duration_s,audio_enabled:snapshot.settings.audio_enabled});return {artifact,key,video};
  }
  async cacheReference(r,key,artifact,reused,reason=null) {
    const hash=sha256(artifact),cacheKey=sha256(key);const ref={schema_version:'stage1-cache.v1',cache_key:cacheKey,key_fields:key,analysis_strategy:r.snapshot.analysis_strategy,artifact_id:artifact.artifact_id,artifact_sha256:hash,producer_run_id:artifact.producer_run_id,producer_analysis_strategy:artifact.producer_analysis_strategy,reuse_reason:reason??(reused?'compatible_cached_artifact':'generated'),created_at:now(),validation_status:'valid'};
    await this.store.immutable(`stage1-cache/${cacheKey}/references/${id()}.json`,ref);await this.store.write(`stage1-cache/${cacheKey}/reference.json`,ref);
    r.stage1={cache_key:cacheKey,artifact_id:artifact.artifact_id,artifact_sha256:hash,producer_run_id:artifact.producer_run_id,producer_analysis_strategy:artifact.producer_analysis_strategy,reused,boundary_mode:'discover',output:artifact.output};await this.saveRun(r);return ref;
  }
  async attemptStage(r,stage,built,extras={}) {
    let attemptId=null;const started=Date.now();
    const response=await this.model.call({...extras,stage,body:built.body,settings:r.snapshot.settings,signal:this.controller.signal,
      onRequest:async req=>{attemptId=id();await this.store.immutable(`runs/${r.run_id}/requests/${attemptId}.json`,req.body);r.active_attempt_id=attemptId;r.last_api_sent_at=now();await this.saveRun(r);},
      onAttempt:async a=>{attemptId??=id();await this.store.immutable(`runs/${r.run_id}/responses/${attemptId}.json`,{raw:a.raw_response,payload:a.payload});const record={attempt_id:attemptId,stage,request_ref:`runs/${r.run_id}/requests/${attemptId}.json`,request_sha256:sha256(a.body),response_ref:`runs/${r.run_id}/responses/${attemptId}.json`,response_sha256:sha256({raw:a.raw_response,payload:a.payload}),http_status:a.http_status,elapsed_ms:a.elapsed_ms,usageMetadata:a.usage,usage_is_synthetic:this.config.mockMode,model_id:a.model_id,modelVersion:a.model_version,agentic_traces:a.agentic_traces??[],remote_outcome_unknown:a.remote_outcome_unknown,error_code:a.error_code};r.attempts.push(record);r.active_attempt_id=null;r.remote_outcome_unknown||=a.remote_outcome_unknown;await this.saveRun(r);},
      onRetry:async detail=>{await this.phase(r,'retry_wait',detail);}
    });
    r.metrics[stage]+=Date.now()-started;
    if(stage==='stage2'&&r.snapshot.faults?.invalid_stage2)response.output.labels[0].start_s=0;
    return response;
  }
  async processAnalysis(r) {
    const s=r.snapshot,prompts=await loadPrompts(s.settings.prompt_release);demand(prompts.sha256===s.prompt_manifest_sha256,'VERSION_HASH_CONFLICT','受付後にプロンプト構成が変更されました。',409);
    const set=s.standard_set_id?await this.getSet(s.standard_set_id):null;if(set)demand(set.content_sha256===s.standard_set_sha256,'SET_CHANGED','受付後に標準セットの内容が変わっています。');
    let video,artifact,key,remote=null;const preparedAt=Date.now();
    if(s.stage1_artifact_id) ({artifact,key,video}=await this.resolveArtifact(s,prompts));
    else {
      video=await this.media.prepare(s.video,s.settings,r.run_id,this.cleanup,this.controller.signal);key=stage1Key({strategy:s.analysis_strategy,video,settings:s.settings,prompts,vocabulary:s.vocabulary,discriminators:s.discriminators,standard_set_id:s.standard_set_id});
      for(const k of await this.store.list('stage1-cache')) {const ref=await this.store.read(`stage1-cache/${k}/reference.json`,null);if(ref?.validation_status==='valid'&&compatibleKeys(ref.key_fields,key)){const candidate=await this.store.read(`stage1-artifacts/${ref.artifact_id}/artifact.json`);if(sha256(candidate)===ref.artifact_sha256){artifact=candidate;break;}}}
    }
    r.metrics.preparation+=Date.now()-preparedAt;
    if(artifact) {
      validateStage1(artifact.output,{duration_s:video.duration_s,audio_enabled:s.settings.audio_enabled});
      const sigVideo={...video,uri:'mock://signature/video'};const check=buildStage1({video:sigVideo,settings:s.settings,prompts,profile:profileFor(s.analysis_strategy),vocabulary:s.vocabulary,discriminators:s.discriminators});
      demand(inputSignature(check.body,[sigVideo])===artifact.input_signature_sha256,'INPUT_SIGNATURE_MISMATCH','同じ入力本文として区間を再利用できません。',409);
      const migration=await this.store.read(`stage1-migrations/${sha256({artifact_id:artifact.artifact_id,key})}/migration.json`,null);
      await this.cacheReference(r,key,artifact,true,migration?'explicit_verified_migration':null);
    } else {
      await this.phase(r,'uploading');let start=Date.now();demand(s.consent_confirmed,'CONSENT_REQUIRED','動画送信の同意が必要です。');remote=await this.cleanup.upload(video,r.run_id,r.comparison_session_id,this.controller.signal);r.metrics.upload+=Date.now()-start;
      const built=buildStage1({video:remote,settings:s.settings,prompts,profile:profileFor(s.analysis_strategy),vocabulary:s.vocabulary,discriminators:s.discriminators});await this.phase(r,'stage1_running');
      const res=await this.attemptStage(r,'stage1',built,{video:remote});validateStage1(res.output,{duration_s:video.duration_s,audio_enabled:s.settings.audio_enabled});
      const artifactId=id();artifact={artifact_id:artifactId,stage1_profile:profileFor(s.analysis_strategy),producer_run_id:r.run_id,producer_analysis_strategy:s.analysis_strategy,key_fields:key,video:{video_id:video.video_id,source_sha256:video.source_sha256,sha256:video.sha256,duration_s:video.duration_s,mime_type:video.mime_type,preprocess_version:video.preprocess_version,transform:video.transform},request_sha256:sha256(built.body),input_signature_sha256:inputSignature(built.body,[remote]),output:res.output,raw_response_ref:r.attempts.at(-1).response_ref,raw_response_sha256:r.attempts.at(-1).response_sha256,execution:{settings:s.settings,modelVersion:res.model_version,agentic_traces:res.agentic_traces},usage:res.usage,created_at:now()};
      await this.store.immutable(`stage1-artifacts/${artifactId}/artifact.json`,artifact);await this.store.immutable(`stage1-artifacts/${artifactId}/checksum.json`,{sha256:sha256(artifact)});await this.cacheReference(r,key,artifact,false);
    }
    await this.phase(r,'stage1_ready');
    if(s.analysis_strategy!=='visual_evidence'){await this.cleanup.releaseRun(r.run_id);await this.cleanup.sweep();}
    const images=[];
    if(s.analysis_strategy==='visual_evidence') {
      await this.phase(r,'uploading',{stage:'stage2'});const start=Date.now();
      if(!remote) {if(!video.asset_ref)video=await this.media.prepare(s.video,s.settings,r.run_id,this.cleanup,this.controller.signal);demand(video.sha256===artifact.video.sha256,'INPUT_HASH_CHANGED','同じ送信バイトを再現できません。',409);remote=await this.cleanup.upload(video,r.run_id,r.comparison_session_id,this.controller.signal);}
      if(s.analysis_mode==='few_shot')for(const img of set.representative_images){demand(await this.store.exists(img.asset_ref)&&await hashFile(this.store.resolve(img.asset_ref))===img.sha256,'INPUT_UNAVAILABLE','標準画像が削除・変更されています。セットを再作成してください。',404);images.push(await this.cleanup.upload(img,r.run_id,r.comparison_session_id,this.controller.signal));}
      r.metrics.upload+=Date.now()-start;
    }
    const inputVideo={...artifact.video,...(remote||{}),video_id:s.video.video_id};
    const built=buildStage2({segments:artifact.output.segments,video:inputVideo,settings:s.settings,prompts,analysis_strategy:s.analysis_strategy,analysis_mode:s.analysis_mode,set,vocabulary:s.vocabulary,discriminators:s.discriminators,images});
    await this.phase(r,'stage2_running');const res=await this.attemptStage(r,'stage2',built,{input:built.input,video:inputVideo});
    await this.phase(r,'validating');let start=Date.now();const saved=saveStage2(res.output,built.input,s.settings.safety_policy);r.metrics.validation+=Date.now()-start;
    const segments=artifact.output.segments.map(seg=>{const l=saved.output.labels.find(l=>l.segment_id===seg.segment_id),v=s.vocabulary.labels.find(v=>v.job_no===l.final_label.job_no);const {final_label,...fields}=l;return {...seg,...fields,...final_label,page_number:v.page_number};});
    await this.phase(r,'persisting');start=Date.now();
    const result={schema_version:'tas-result.v1',run_id:r.run_id,parent_run_id:r.parent_run_id,comparison_session_id:r.comparison_session_id,analysis_strategy:s.analysis_strategy,analysis_mode:s.analysis_mode,mock:this.config.mockMode,data_origin:this.config.mockMode?'synthetic_mock':'geap_inference',accuracy_claim:null,eligibility:'unverified',input:{video_id:s.video.video_id,source_sha256:s.video.sha256,submitted_sha256:artifact.video.sha256,duration_s:artifact.video.duration_s,preprocess_version:artifact.video.preprocess_version,transform:artifact.video.transform,synthetic_video:s.video.synthetic},standard_set_id:s.standard_set_id,examples_used:s.analysis_mode==='few_shot',versions:{vocabulary:{version:s.vocabulary.vocabulary_version,sha256:sha256(s.vocabulary)},discriminators:{version:s.discriminators.discriminator_version,sha256:sha256(s.discriminators)},non_work_labels:{version:s.vocabulary.non_work_labels_version,sha256:sha256(s.vocabulary.labels.filter(l=>l.kind==='non_work'))},observation:{version:'observation.v1',sha256:prompts.observation_sha256},stage1_prompt:{version:artifact.key_fields.stage1_prompt_version,sha256:artifact.key_fields.stage1_prompt_sha256},stage2_prompt:{version:built.prompt.version,sha256:built.prompt.sha256},stage1_schema:{version:'stage1.discover.v1',sha256:artifact.key_fields.response_schema_sha256},stage2_schema:{version:'stage2.v1',sha256:sha256(built.schema)},safety_policy:{version:s.settings.safety_policy.safety_policy_version,sha256:sha256(s.settings.safety_policy)},quality_policy:{version:'quality-policy.v1',sha256:sha256(await fs.readFile(new URL('../public/segments.js',import.meta.url),'utf8'))},standard_images:{version:images.length?'uniform3.v1/jpeg768.v1':null,sha256:images.length?sha256(images.map(i=>({image_id:i.image_id,sha256:i.sha256}))):null,reason:images.length?null:'not_used_in_this_condition'},prompt_manifest:{version:s.settings.prompt_release,sha256:prompts.sha256}},execution:{...s.settings,stage1:{model_id:s.settings.stage1_model,modelVersion:artifact.execution.modelVersion,agentic_traces:artifact.execution.agentic_traces,agentic_status:this.config.mockMode?'synthetic_not_measured':artifact.execution.agentic_traces.length?'confirmed':'agentic_unconfirmed',generationConfig:buildStage1({video:{...artifact.video,uri:'mock://metadata/video'},settings:s.settings,prompts,profile:profileFor(s.analysis_strategy),vocabulary:s.vocabulary,discriminators:s.discriminators}).body.generationConfig},stage2:{model_id:s.settings.stage2_model,modelVersion:res.model_version,agentic_traces:res.agentic_traces,agentic_status:s.analysis_strategy==='visual_evidence'?(this.config.mockMode?'synthetic_not_measured':res.agentic_traces.length?'confirmed':'agentic_unconfirmed'):'not_applicable',generationConfig:built.body.generationConfig},server_location:'local',auth_method:this.config.mockMode?'none':this.config.authMode,principal:this.config.mockMode?null:this.config.principal,app_version:this.config.appVersion},stage1:r.stage1,stage2:{input_sha256:sha256(built.body),output:saved.output,standard_image_ids:images.map(i=>i.image_id),evidence_condition:built.evidence_condition},segments,warnings:saved.warnings,metrics_runtime:{elapsed_ms:r.metrics,attempt_usage:r.attempts.map(a=>({attempt_id:a.attempt_id,stage:a.stage,usageMetadata:a.usageMetadata,synthetic:a.usage_is_synthetic})),countTokens:null,cost:{total:null,status:'unknown',cost_status:'unknown',currency:null,price_table:null,formula:null,reason:this.config.mockMode?'疑似使用量。実費・精度は未測定。':'料金表または費用内訳が未設定。',actual_spend:null,standalone_attribution:null}},status:'succeeded',error:null,cleanup:await this.cleanup.summary(r.run_id),created_at:r.created_at,started_at:r.started_at,finished_at:now(),attempts:r.attempts};
    const attributedStage1=r.stage1.reused?(await this.store.read(`runs/${artifact.producer_run_id}/run.json`)).attempts.filter(a=>a.stage==='stage1'):[];
    result.metrics_runtime.cost=estimateCost(r.attempts,s.price_table,{mock:this.config.mockMode,attributedStage1});
    result.metrics_runtime.sent_media_bytes={stage1:r.stage1.reused?0:video.size_bytes??s.video.size_bytes,stage2:s.analysis_strategy==='visual_evidence'?(video.size_bytes??s.video.size_bytes)+images.reduce((n,i)=>n+(i.size_bytes||0),0):0};
    await this.hooks.beforeResultSave?.(r,result);await this.exclusive(async()=>{const current=await this.store.read(`runs/${r.run_id}/run.json`);demand(!current.cancel_requested&&!this.controller.signal.aborted,'CANCELLED','中断後の結果は確定しません。');await this.store.immutable(`runs/${r.run_id}/result.json`,result);r.metrics.persistence+=Date.now()-start;r.result_sha256=sha256(result);r.status='succeeded';r.finished_at=result.finished_at;await this.saveRun(r);});
  }
  async processStandard(r) {
    const s=r.snapshot,set=await this.getSet(r.standard_set_id),prompts=await loadPrompts(s.settings.prompt_release);
    const video=await this.getMedia(s.source_video_id),originalGT=await this.store.read(`build-inputs/${safeId(s.build_gt_asset_id)}/gt.json`);
    validateGT(originalGT,video,set.vocabulary);set.status='preparing';await this.store.write(`standard-sets/${set.standard_set_id}/manifest.json`,set);
    const gt={...originalGT,segments:originalGT.segments.map((seg,i)=>({...seg,segment_id:segmentId(i)}))};
    const boundaries=gt.segments.map(({segment_id,start_s,end_s})=>({segment_id,start_s,end_s}));
    const start=Date.now(),prepared=await this.media.prepare(video,s.settings,r.run_id,this.cleanup,this.controller.signal);r.metrics.preparation+=Date.now()-start;
    await this.phase(r,'uploading');demand(s.consent_confirmed,'CONSENT_REQUIRED','標準動画の同意を確認してください。');const remote=await this.cleanup.upload(prepared,r.run_id,null,this.controller.signal);
    const exampleIds=Object.fromEntries(boundaries.map(b=>[b.segment_id,id()]));
    for(const profile of s.profiles) {
      await this.phase(r,'stage1_running',{profile,boundary_mode:'fixed'});
      const built=buildStage1({video:remote,settings:s.settings,prompts,profile,boundaries,vocabulary:set.vocabulary,discriminators:set.discriminators});
      const res=await this.attemptStage(r,'stage1',built,{video:remote,boundaries});validateStage1(res.output,{duration_s:video.duration_s,audio_enabled:s.settings.audio_enabled,boundaries});
      const artifactId=id();const artifact={artifact_id:artifactId,stage1_profile:profile,boundary_mode:'fixed',output:res.output,boundary_manifest_sha256:sha256(boundaries),request_sha256:sha256(built.body),input_signature_sha256:inputSignature(built.body,[remote]),raw_response_ref:r.attempts.at(-1).response_ref,raw_response_sha256:r.attempts.at(-1).response_sha256,execution:{settings:s.settings,modelVersion:res.model_version,agentic_traces:res.agentic_traces},usage:res.usage,created_at:now()};
      await this.store.immutable(`stage1-artifacts/${artifactId}/artifact.json`,artifact);await this.store.immutable(`stage1-artifacts/${artifactId}/checksum.json`,{sha256:sha256(artifact)});
      set.description_profiles[profile]={artifact_id:artifactId,artifact_sha256:sha256(artifact),observation_version:'observation.v1',conditions:profileConditions(s.settings,prompts,profile),validation_status:'valid',modelVersion:res.model_version};
      set.examples[profile]=joinFixed(res.output,boundaries).map(x=>{const g=gt.segments.find(g=>g.segment_id===x.segment_id);return {example_id:exampleIds[x.segment_id],segment_id:x.segment_id,label:{job_no:g.job_no,job_title:g.job_title},observation:x.observation};});
    }
    set.display_segments=gt.segments.map(({segment_id,start_s,end_s,job_no,job_title})=>({segment_id,start_s,end_s,job_no,job_title}));
    if(s.generate_images) {
      await this.phase(r,'preparing',{operation:'representative_images'});
      const frames=await this.media.extractFrames({asset:video,gt,setId:set.standard_set_id,exampleIds,signal:this.controller.signal});set.representative_images=frames.images;set.provenance.tools=frames.tools;set.provenance.image_extraction=frames.settings;
    }
    await this.phase(r,'validating');demand(Object.values(set.description_profiles).some(Boolean),'INVALID_SET','有効な標準記述が必要です。');
    set.provenance.warnings=Object.values(set.examples).flat().filter(e=>e.observation.insufficient_discriminative_features).map(e=>({code:'STANDARD_INSUFFICIENT',example_id:e.example_id}));
    await this.store.write(`standard-sets/${set.standard_set_id}/manifest.json`,set);
    await this.phase(r,'awaiting_approval');await this.cleanup.releaseRun(r.run_id);await this.cleanup.sweep();
  }
  async approve(setId,reviewer) {await this.ready;return this.exclusive(async()=>{
    demand(typeof reviewer==='string'&&reviewer.trim().length>0,'REVIEWER_REQUIRED','確認者を入力してください。');const set=await this.getSet(setId);const r=await this.store.read(`runs/${set.provenance.build_run_id}/run.json`);
    demand(r.status==='awaiting_approval'&&set.status==='preparing','NOT_AWAITING_APPROVAL','承認待ちのセットを指定してください。',409);
    for(const p of Object.values(set.description_profiles).filter(Boolean)){const a=await this.store.read(`stage1-artifacts/${p.artifact_id}/artifact.json`);demand(sha256(a)===p.artifact_sha256,'INVALID_ARTIFACT','標準記述のハッシュ不一致');}
    for(const img of set.representative_images)demand(await hashFile(this.store.resolve(img.asset_ref))===img.sha256,'INVALID_IMAGE','標準画像のハッシュ不一致');
    set.status='ready';set.approved_by=reviewer.trim();set.approved_at=now();set.content_sha256=sha256({...set,content_sha256:null});await this.store.immutable(`standard-sets/${setId}/published.json`,set);await this.store.write(`standard-sets/${setId}/manifest.json`,set);
    r.status='succeeded';r.finished_at=now();r.phase_history.push({phase:'approved',at:now(),detail:{approved_by:set.approved_by}});await this.saveRun(r);return this.publicSet(set);
  });}
  async retire(setId) {await this.ready;const set=await this.getSet(setId);demand(set.status==='ready','SET_NOT_READY','公開済みセットを指定してください。');set.status='retired';await this.store.write(`standard-sets/${setId}/manifest.json`,set);return this.publicSet(set);}
  async deleteSetMedia(setId) {
    const set=await this.getSet(setId);demand(set.status==='retired','SET_NOT_RETIRED','先に標準セットの利用を停止してください。');
    for(const k of await this.store.list('runs')){const r=await this.store.read(`runs/${k}/run.json`);demand(TERMINAL.includes(r.status)||r.snapshot.standard_set_id!==setId,'SET_IN_USE','実行中の参照が残っています。',409);}
    const refs=[];for(const k of await this.store.list('standard-sets')){if(k===setId)continue;const other=await this.getSet(k);refs.push(...other.representative_images.map(i=>i.asset_ref));}
    for(const image of set.representative_images)if(!refs.includes(image.asset_ref))await fs.rm(this.store.resolve(image.asset_ref),{force:true});
    await this.store.immutable(`standard-sets/${setId}/media-deletion-${id()}.json`,{deleted_at:now(),image_ids:set.representative_images.map(i=>i.image_id)});return {standard_set_id:setId,status:'retired',images_deleted:true};
  }
  async createSession(body) {await this.ready;return this.exclusive(async()=>{
    const settings=normalizeSettings(body.settings,this.config);await this.getMedia(body.input_video_id);if(body.standard_set_id)await this.getSet(body.standard_set_id);
    const key=sha256({kind:'comparison',client_request_id:body.client_request_id});const prev=await this.store.read(`requests/${key}/request.json`,null);if(prev){demand(prev.sha256===sha256(body),'IDEMPOTENCY_CONFLICT','同じ操作IDで入力が変わっています。',409);return this.store.read(`comparison-sessions/${prev.session_id}/session.json`);}
    const session={comparison_session_id:id(),settings,input_video_id:body.input_video_id,standard_set_id:body.standard_set_id??null,status:'open',created_at:now(),expires_at:new Date(Date.now()+86400000).toISOString()};
    await this.store.immutable(`comparison-sessions/${session.comparison_session_id}/session.json`,session);await this.store.immutable(`requests/${key}/request.json`,{session_id:session.comparison_session_id,sha256:sha256(body)});return session;
  });}
  async closeSession(sessionId) {const ref=`comparison-sessions/${safeId(sessionId)}/session.json`,s=await this.store.read(ref);s.status='closed';s.closed_at=now();await this.store.write(ref,s);await this.cleanup.sweep();return s;}
  async pump() {
    if(this.worker||this.stopping)return;
    this.worker=(async()=>{
      await this.ready;await this.serial;
      while(!this.stopping) {
        const list=[];for(const k of await this.store.list('runs')){const r=await this.store.read(`runs/${k}/run.json`,null);if(r?.status==='queued')list.push(r);}
        list.sort((a,b)=>a.created_at.localeCompare(b.created_at));const r=list[0];if(!r)break;
        this.activeRunId=r.run_id;this.controller=new AbortController();const timeout=setTimeout(()=>this.controller?.abort(fault('JOB_TIMEOUT','ジョブ全体の制限時間を超えました。')),this.config.jobTimeoutMs);timeout.unref?.();
        try {r.started_at=now();await this.phase(r,'preparing');if(r.job_kind==='analysis')await this.processAnalysis(r);else if(r.job_kind==='vocabulary_extract')await this.processVocabulary(r);else if(r.job_kind==='safety_rederive')await this.processSafety(r);else await this.processStandard(r);}
        catch(e) {
          const current=await this.store.read(`runs/${r.run_id}/run.json`,r);r.cancel_requested=current.cancel_requested;
          r.remote_outcome_unknown||=(!this.config.mockMode&&Boolean(r.active_attempt_id))||e.code==='REMOTE_OUTCOME_UNKNOWN';
          r.status=r.cancel_requested?'cancelled':this.stopping?'interrupted':'failed';r.error={code:r.cancel_requested?'CANCELLED':e.code||'PROCESSING_FAILED',stage:r.phase,message:e.status?e.message:'処理・保存に失敗しました。入力・保存先を確認して再試行してください。',details:e.details??null};r.finished_at=now();
          await this.saveRun(r);if(r.job_kind==='standard_build'){const set=await this.getSet(r.standard_set_id);set.status='failed';await this.store.write(`standard-sets/${set.standard_set_id}/manifest.json`,set);}
        } finally {clearTimeout(timeout);await this.cleanup.releaseRun(r.run_id,{unknown:r.remote_outcome_unknown});const started=Date.now();await this.cleanup.sweep();r.metrics.cleanup+=Date.now()-started;await this.store.write(`runs/${r.run_id}/runtime.json`,{metrics:r.metrics,cleanup:await this.cleanup.summary(r.run_id),updated_at:now()});this.controller=null;}
      }
    })();
    try{await this.worker;}finally{this.worker=null;}
  }
  async status(runId) {await this.ready;const r=await this.store.read(`runs/${safeId(runId)}/run.json`);return {run_id:r.run_id,parent_run_id:r.parent_run_id,comparison_session_id:r.comparison_session_id,job_kind:r.job_kind,standard_set_id:r.standard_set_id??r.snapshot.standard_set_id??null,status:r.status,phase:r.phase,revision:r.revision,created_at:r.created_at,started_at:r.started_at,finished_at:r.finished_at,settings:r.snapshot.settings,analysis_strategy:r.snapshot.analysis_strategy??null,analysis_mode:r.snapshot.analysis_mode??null,input_video_id:r.snapshot.input_video_id??r.snapshot.source_video_id,error:r.error,stage1:r.stage1?{...r.stage1,output:undefined}:null,result_available:Boolean(r.result_sha256),result_sha256:r.result_sha256??null,cleanup:await this.cleanup.summary(r.run_id),remote_outcome_unknown:r.remote_outcome_unknown,phase_history:r.phase_history,cost:r.result_sha256?(await this.result(runId)).metrics_runtime.cost:{total:null,status:'unknown'},mock:this.config.mockMode};}
  async history() {await this.ready;const list=[];for(const k of await this.store.list('runs')){const status=await this.status(k);if(status.result_available){const result=await this.result(k);status.review_count=result.segments.filter(s=>s.review_required).length;}else status.review_count=null;list.push(status);}return list.sort((a,b)=>b.created_at.localeCompare(a.created_at));}
  async result(runId) {const ref=`runs/${safeId(runId)}/result.json`;demand(await this.store.exists(ref),'RESULT_NOT_READY','結果はまだ保存されていません。',409);return this.store.read(ref);}
  async cancel(runId) {await this.ready;return this.exclusive(async()=>{const r=await this.store.read(`runs/${safeId(runId)}/run.json`);if(TERMINAL.includes(r.status))return this.status(runId);r.cancel_requested=true;r.status=['queued','awaiting_approval'].includes(r.status)?'cancelled':'cancel_requested';r.phase_history.push({phase:'cancel_requested',at:now(),detail:null});if(r.status==='cancelled')r.finished_at=now();await this.saveRun(r);if(this.controller&&this.activeRunId===runId)this.controller.abort(fault('CANCELLED','利用者が中断しました。'));return this.status(runId);});}
  async retry(runId,clientRequestId) {await this.ready;const r=await this.store.read(`runs/${safeId(runId)}/run.json`);demand(TERMINAL.includes(r.status),'RUN_ACTIVE','実行終了後に再試行してください。',409);if(r.job_kind==='vocabulary_extract')return this.createVocabularyExtraction({client_request_id:clientRequestId,pdf_asset_id:r.snapshot.pdf.asset_id,settings:r.snapshot.settings,consent_confirmed:r.snapshot.consent_confirmed});if(r.job_kind==='safety_rederive')return this.rederiveSafety(r.snapshot.source_run_id,{client_request_id:clientRequestId,safety_policy:r.snapshot.settings.safety_policy});if(r.job_kind==='standard_build')return this.createStandard({...r.snapshot,client_request_id:clientRequestId,parent_run_id:runId,name:(await this.getSet(r.standard_set_id)).name,source_video_id:r.snapshot.source_video_id,parent_set_id:r.standard_set_id});const s=r.snapshot;return this.createAnalysis({client_request_id:clientRequestId,input_video_id:s.input_video_id,vocabulary_ref:s.vocabulary_ref??null,standard_set_id:s.standard_set_id,analysis_mode:s.analysis_mode,analysis_strategy:s.analysis_strategy,settings:s.settings,stage1_artifact_id:r.stage1?.artifact_id??null,parent_run_id:runId,consent_confirmed:s.consent_confirmed});}
  async reviews(runId) {const result=[];for(const k of await this.store.list(`runs/${safeId(runId)}/reviews`)){const v=await this.store.read(`runs/${runId}/reviews/${k}/review.json`,null);if(v)result.push(v);}return result.sort((a,b)=>a.created_at.localeCompare(b.created_at));}
  async migrateArtifact(body) {await this.ready;return this.exclusive(async()=>{
    demand(body.reason?.trim()&&body.editor?.trim(),'MIGRATION_REASON_REQUIRED','移行理由と確認者が必要です。');
    const a=await this.store.read(`stage1-artifacts/${safeId(body.artifact_id)}/artifact.json`),checksum=await this.store.read(`stage1-artifacts/${body.artifact_id}/checksum.json`);demand(sha256(a)===checksum.sha256&&a.key_fields.boundary_mode==='discover','INVALID_ARTIFACT','有効な発見artifactが必要です。');
    const set=await this.getSet(body.standard_set_id),settings=normalizeSettings(body.settings,this.config),prompts=await loadPrompts(settings.prompt_release),strategy=body.analysis_strategy;
    demand(STRATEGIES.includes(strategy)&&set.status==='ready','INVALID_MIGRATION','公開セットと方式を指定してください。');
    const key=stage1Key({strategy,video:a.video,settings,prompts,vocabulary:set.vocabulary,discriminators:set.discriminators,standard_set_id:set.standard_set_id});const old={...a.key_fields};
    if(profileFor(strategy)==='guided')for(const k of ['vocabulary_version','vocabulary_sha256','discriminator_version','discriminator_sha256','non_work_labels_version'])demand(old[k]===key[k],'INCOMPATIBLE_STAGE1','guidedの語彙・識別条件変更は再生成が必要です。');
    for(const k of ['analysis_strategy','standard_set_id','vocabulary_version','vocabulary_sha256','discriminator_version','discriminator_sha256','non_work_labels_version'])old[k]=key[k];
    demand(sha256(old)===sha256(key),'INCOMPATIBLE_STAGE1','媒体・モデル・プロンプト等の条件が異なるため移行できません。');
    const video={...a.video,uri:'mock://signature/video'},built=buildStage1({video,settings,prompts,profile:profileFor(strategy),vocabulary:set.vocabulary,discriminators:set.discriminators});
    demand(inputSignature(built.body,[video])===a.input_signature_sha256,'INPUT_SIGNATURE_MISMATCH','語彙等の変更で実入力が変わっています。再生成してください。');
    const record={schema_version:'stage1-migration.v1',artifact_id:a.artifact_id,artifact_sha256:sha256(a),source_key:a.key_fields,target_key:key,target_key_sha256:sha256(key),input_signature_sha256:a.input_signature_sha256,reason:body.reason,editor:body.editor,created_at:now()};
    await this.store.immutable(`stage1-migrations/${sha256({artifact_id:a.artifact_id,key})}/migration.json`,record);return record;
  });}
  async rederiveSafety(runId,body) {await this.ready;return this.exclusive(async()=>{const original=await this.store.read(`runs/${safeId(runId)}/run.json`);await this.result(runId);const settings=normalizeSettings({...original.snapshot.settings,safety_policy:body.safety_policy},this.config);await this.store.version('safety-policy',settings.safety_policy.safety_policy_version,sha256(settings.safety_policy));return this.newRun({...body,parent_run_id:runId},'safety_rederive',{...original.snapshot,settings,source_run_id:runId});});}
  async processSafety(r) {
    const source=await this.result(r.snapshot.source_run_id),sourceRun=await this.store.read(`runs/${r.snapshot.source_run_id}/run.json`),s=r.snapshot,rawSource=source.derivation?.raw_source_run_id?await this.result(source.derivation.raw_source_run_id):source,attempt=rawSource.attempts.findLast(a=>a.stage==='stage2');
    const response=await this.store.read(attempt.response_ref);demand(sha256(response)===attempt.response_sha256,'INVALID_RAW_RESPONSE','生応答ハッシュ不一致');const raw=parseModelOutput(response.payload),set=s.standard_set_id?await this.getSet(s.standard_set_id):null;
    const prompts=await loadPrompts(s.settings.prompt_release),images=source.stage2.standard_image_ids.map(image_id=>({...set.representative_images.find(i=>i.image_id===image_id),uri:`mock://saved/${image_id}`}));
    const built=buildStage2({segments:source.stage1.output.segments,video:{...source.input,video_id:source.input.video_id,mime_type:'video/mp4',uri:'mock://saved/video'},settings:s.settings,prompts,analysis_strategy:s.analysis_strategy,analysis_mode:s.analysis_mode,set,vocabulary:s.vocabulary,discriminators:s.discriminators,images});
    await this.phase(r,'validating');const saved=saveStage2(raw,built.input,s.settings.safety_policy);const derived={...clone(source),run_id:r.run_id,parent_run_id:source.run_id,derivation:{kind:'safety_only',raw_source_run_id:rawSource.run_id,source_result_sha256:sha256(source),raw_response_sha256:attempt.response_sha256,model_recalled:false},created_at:r.created_at,started_at:r.started_at,finished_at:now(),execution:{...source.execution,safety_policy:s.settings.safety_policy},versions:{...source.versions,safety_policy:{version:s.settings.safety_policy.safety_policy_version,sha256:sha256(s.settings.safety_policy)}},stage2:{...source.stage2,output:saved.output},segments:source.segments.map(seg=>{const l=saved.output.labels.find(l=>l.segment_id===seg.segment_id);const {final_label,...fields}=l;return {...seg,...fields,...final_label};}),warnings:saved.warnings,attempts:[],metrics_runtime:{...source.metrics_runtime,attempt_usage:[],cost:{total:0,status:'no_model_call',cost_status:'not_applicable',reason:'保存済み生応答の安全網再計算。追加API使用なし。'}},cleanup:await this.cleanup.summary(r.run_id)};
    r.stage1=sourceRun.stage1;await this.phase(r,'persisting');await this.exclusive(async()=>{const current=await this.store.read(`runs/${r.run_id}/run.json`);demand(!current.cancel_requested&&!this.controller.signal.aborted,'CANCELLED','中断後の結果は確定しません。');await this.store.immutable(`runs/${r.run_id}/result.json`,derived);r.result_sha256=sha256(derived);r.status='succeeded';r.finished_at=derived.finished_at;await this.saveRun(r);});
  }
  async createVocabularyExtraction(body) {await this.ready;return this.exclusive(async()=>{demand(body.consent_confirmed===true,'CONSENT_REQUIRED','標準書の送信範囲を確認してください。');const pdf=await this.getMedia(body.pdf_asset_id);demand(pdf.mime_type==='application/pdf','INVALID_PDF','登録済みPDFを選択してください。');const settings=normalizeSettings(body.settings,this.config);const prompts=await loadPrompts(settings.prompt_release);return this.newRun(body,'vocabulary_extract',{pdf,settings,consent_confirmed:true,prompt_manifest_sha256:prompts.sha256});});}
  async processVocabulary(r) {
    const s=r.snapshot,prompts=await loadPrompts(s.settings.prompt_release);demand(prompts.sha256===s.prompt_manifest_sha256,'VERSION_HASH_CONFLICT','プロンプトが受付後に変更されました。');demand(await hashFile(this.store.resolve(s.pdf.asset_ref))===s.pdf.sha256,'INPUT_HASH_CHANGED','PDFハッシュ不一致');
    await this.phase(r,'uploading');const remote=await this.cleanup.upload(s.pdf,r.run_id,null,this.controller.signal);const built={body:{systemInstruction:{parts:[{text:prompts.loaded.vocabulary.text}]},contents:[{role:'user',parts:[{fileData:{fileUri:remote.uri,mimeType:'application/pdf'}},{text:'標準書の作業語彙を抽出してください。人が確認するまで公開しません。'}]}],generationConfig:{...s.settings.stage1_generation_config,responseMimeType:'application/json',responseSchema:VOCABULARY_SCHEMA}}};
    await this.phase(r,'stage1_running');const res=await this.attemptStage(r,'stage1',built,{vocabularyExtraction:true});demand(res.output&&Object.keys(res.output).length===1&&Array.isArray(res.output.labels)&&res.output.labels.length,'INVALID_VOCABULARY','語彙抽出の構造が不正です。');
    const vocabulary=demoVocabulary();vocabulary.vocabulary_version=`vocabulary-${r.run_id}`;vocabulary.source_pdf_sha256=s.pdf.sha256;vocabulary.labels=[...res.output.labels.map(l=>({...l,kind:'work'})),...vocabulary.labels.filter(l=>l.kind==='non_work')];validateVocabulary(vocabulary);const discriminators=demoDiscriminators(vocabulary);discriminators.discriminator_version=`discriminators-${r.run_id}`;discriminators.source_refs=[{kind:'standard_pdf',sha256:s.pdf.sha256}];discriminators.approved_by='pending_human_review';
    await this.store.immutable(`runs/${r.run_id}/vocabulary-draft.json`,{vocabulary,discriminators,extraction:{run_id:r.run_id,pdf_sha256:s.pdf.sha256,request_sha256:sha256(built.body),prompt_sha256:prompts.loaded.vocabulary.sha256,model_id:s.settings.stage1_model,modelVersion:res.model_version,mock:this.config.mockMode},approval_required:true});await this.phase(r,'awaiting_approval');
  }
  async approveVocabulary(runId,body) {const r=await this.store.read(`runs/${safeId(runId)}/run.json`);demand(r.job_kind==='vocabulary_extract'&&r.status==='awaiting_approval','NOT_AWAITING_APPROVAL','確認待ち語彙を指定してください。');const draft=await this.store.read(`runs/${runId}/vocabulary-draft.json`);demand(body.vocabulary.source_pdf_sha256===draft.extraction.pdf_sha256,'SOURCE_HASH_MISMATCH','標準書の出自を維持してください。');const asset=await this.registerVocabulary(body.vocabulary,body.discriminators,{approved_by:body.approved_by,extraction:draft.extraction});r.status='succeeded';r.finished_at=now();r.vocabulary_ref=asset.ref;await this.saveRun(r);return asset;}
  async saveReview(runId,body) {
    const source=await this.result(runId),run=await this.store.read(`runs/${runId}/run.json`);demand(typeof body.editor==='string'&&body.editor.trim(),'REVIEWER_REQUIRED','確認者を入力してください。');demand(body.original_result_sha256===sha256(source),'RESULT_HASH_MISMATCH','元結果が一致しません。履歴を開き直してください。',409);
    demand(Array.isArray(body.segments),'INVALID_REVIEW','修正区間の配列が必要です。');let lastEnd=0;const ids=new Set();const vocabulary=run.snapshot.vocabulary;
    const segments=body.segments.map(s=>{
      demand(Object.keys(s).every(k=>['segment_id','start_s','end_s','job_no','job_title','page_number'].includes(k)),'INVALID_REVIEW','修正できない項目が含まれています。');
      demand(typeof s.segment_id==='string'&&!ids.has(s.segment_id)&&Number.isFinite(s.start_s)&&Number.isFinite(s.end_s)&&s.start_s>=lastEnd&&s.end_s>s.start_s&&s.end_s<=source.input.duration_s,'INVALID_REVIEW','重複・逆順・動画範囲外の修正は保存できません。');ids.add(s.segment_id);lastEnd=s.end_s;
      const label=vocabulary.labels.find(l=>l.job_no===s.job_no&&l.job_title===s.job_title);demand(label,'INVALID_REVIEW','作業ラベルは語彙から選択してください。');
      const original=source.segments.find(x=>x.segment_id===s.segment_id);return {...(original??{segment_id:s.segment_id,observation:null,human_added:true}),...s,page_number:label.page_number};
    });
    const review={schema_version:'reviewed-result.v1',original_result:source,review_id:id(),original_run_id:runId,original_result_sha256:sha256(source),editor:body.editor.trim(),created_at:now(),mock:source.mock,data_origin:source.data_origin,segments,changes:[]};
    for(const original of source.segments){const after=segments.find(s=>s.segment_id===original.segment_id)??null;if(sha256(original)!==sha256(after))review.changes.push({segment_id:original.segment_id,before:original,after});}
    for(const after of segments)if(!source.segments.some(s=>s.segment_id===after.segment_id))review.changes.push({segment_id:after.segment_id,before:null,after});
    await this.store.immutable(`runs/${runId}/reviews/${review.review_id}/review.json`,review);return review;
  }
  async demo() {
    await this.ready;demand(this.config.mockMode,'MOCK_ONLY','サンプル作成はモック専用です。');const previous=await this.store.read('demo/fixture.json',null);if(previous)return previous;
    const vocabulary=demoVocabulary(),discriminators=demoDiscriminators(vocabulary),v=await this.registerVocabulary(vocabulary,discriminators,{approved_by:'合成データ作成処理'});
    const standard=await this.media.syntheticVideo(24,'合成・標準動画 24秒'),actual=await this.media.syntheticVideo(30,'合成・実作業動画 30秒');
    const gt={gt_version:'synthetic-standard-gt.v1',video_id:standard.video_id,duration_s:24,segments:vocabulary.labels.filter(l=>l.kind==='work').map((l,i)=>({gt_segment_id:`synthetic-${i+1}`,gt_process_id:`occurrence-${i+1}`,start_s:i*6,end_s:(i+1)*6,job_no:l.job_no,job_title:l.job_title}))};
    const registered=await this.registerGT(gt);const run=await this.createStandard({client_request_id:'synthetic-standard-v1',name:'合成サンプル標準セット',source_video_id:standard.video_id,build_gt_asset_id:registered.build_gt_asset_id,vocabulary_ref:v.ref,profiles:['unguided','guided'],generate_images:true,settings:defaultSettings(this.config),parent_set_id:null,consent_confirmed:true});
    const result={actual_video_id:actual.video_id,standard_video_id:standard.video_id,vocabulary_ref:v.ref,standard_set_id:run.standard_set_id,run_id:run.run_id,synthetic:true};await this.store.immutable('demo/fixture.json',result);return result;
  }
  async close() {this.stopping=true;clearInterval(this.timer);this.controller?.abort(fault('PROCESS_INTERRUPTED','サーバーを終了しました。'));await this.worker?.catch(()=>{});await this.serial;await this.store.release();}
}
