import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clone, demand, sha256, canonicalJSON, profileFor } from './core.js';
import { DISCOVER_SCHEMA, FIXED_SCHEMA, STAGE2_SCHEMA, OBSERVATION_SCHEMA, FREEFORM_SCHEMA } from './response-schemas.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function loadPrompts(release='round18.v1') {
  demand(/^[\w.-]+$/.test(release),'INVALID_PROMPT','プロンプト版が不正です。');
  const manifest=JSON.parse(await fs.readFile(path.join(ROOT,'prompts',`${release}.json`),'utf8'));
  const loaded={};
  for(const [name,entry] of Object.entries(manifest.prompts)) {
    demand(/^[\w.-]+\.md$/.test(entry.file),'INVALID_PROMPT','ファイル参照不正');
    const text=await fs.readFile(path.join(ROOT,'prompts',entry.file),'utf8');
    demand(sha256(text)===entry.sha256,'VERSION_HASH_CONFLICT','プロンプト本文と版のハッシュが一致しません。',409);
    loaded[name]={...entry,text};
  }
  return {...manifest,loaded,sha256:sha256(manifest),observation_sha256:sha256(OBSERVATION_SCHEMA)};
}
export function vocabularyView(v) { return v.labels.map(({job_no,job_title,kind})=>({job_no,job_title,kind})).sort((a,b)=>a.job_no<b.job_no?-1:a.job_no>b.job_no?1:0); }
export function discriminatorView(d) { return d.conditions.map(({job_no,similar_job_nos,observable_features,unknown_when})=>({job_no,similar_job_nos,observable_features,unknown_when})).sort((a,b)=>a.job_no<b.job_no?-1:1); }
export function exampleView(set,profile) { return (set?.examples?.[profile]||[]).map(({example_id,label,observation})=>({example_id,label:clone(label),observation:clone(observation)})).sort((a,b)=>a.label.job_no<b.label.job_no?-1:a.label.job_no>b.label.job_no?1:a.example_id.localeCompare(b.example_id)); }
export function videoPart(media, settings) {
  const p={fileData:{fileUri:media.uri,mimeType:media.mime_type},mediaProcessing:settings.processing_mode,videoMetadata:{fps:settings.fps}};
  if(settings.media_resolution!=='api_default') p.mediaResolution=settings.media_resolution;
  return p;
}
const textPart = value => ({text:typeof value==='string'?value:canonicalJSON(value)});
export function buildStage1({video,settings,prompts,profile,boundaries=null,vocabulary,discriminators,freeform=false}) {
  const prompt=prompts.loaded[freeform?'freeform_fixed':`${profile}_${boundaries?'fixed':'discover'}`];
  const schema=freeform?FREEFORM_SCHEMA:boundaries?FIXED_SCHEMA:DISCOVER_SCHEMA;
  const parts=[textPart({task:'video_observation',duration_s:video.duration_s,audio_enabled:settings.audio_enabled})];
  if(profile==='guided') { parts.push(textPart({vocabulary:vocabularyView(vocabulary),discriminators:discriminatorView(discriminators)})); }
  if(boundaries) parts.push(textPart({fixed_intervals:boundaries.map(({segment_id,start_s,end_s})=>({segment_id,start_s,end_s}))}));
  parts.push(videoPart(video,settings),textPart('すべての対象区間を観察し、指定JSONのみを返してください。'));
  const body={systemInstruction:{parts:[{text:prompt.text}]},contents:[{role:'user',parts}],generationConfig:{...settings.stage1_generation_config,responseMimeType:'application/json',responseSchema:schema}};
  auditRequest(body); return {body,prompt,schema};
}
export function buildStage2({segments,video,settings,prompts,analysis_strategy,analysis_mode,set,vocabulary,discriminators,images=[],evidence_condition=null}) {
  const visual=analysis_strategy==='visual_evidence';
  const examples=analysis_mode==='few_shot'?exampleView(set,profileFor(analysis_strategy)):[];
  const usedImages=visual&&analysis_mode==='few_shot'&&evidence_condition!=='text_actual_video'?images:[];
  const prompt=prompts.loaded[visual?'stage2_visual':'stage2_text'];
  const parts=[textPart({task:'fixed_segment_labeling',intervals:segments.map(({segment_id,start_s,end_s,observation})=>({segment_id,start_s,end_s,observation})),examples,vocabulary:vocabularyView(vocabulary),discriminators:discriminatorView(discriminators)})];
  if(visual) parts.push(textPart({actual_video_id:video.video_id}),videoPart(video,settings));
  usedImages.forEach((img,i)=>{
    const example=examples.find(e=>e.example_id===img.example_id);
    demand(example,'INVALID_IMAGE','画像とお手本の対応が不正です。');
    parts.push(textPart({image_id:img.image_id,example_id:img.example_id,job_no:example.label.job_no,frame_order:i+1}),{fileData:{fileUri:img.uri,mimeType:'image/jpeg'}});
  });
  parts.push(textPart('全入力segment_idへラベルを一つずつ付けてください。時刻は出力せず、候補・生の確信度・根拠を返してください。'));
  const body={systemInstruction:{parts:[{text:prompt.text}]},contents:[{role:'user',parts}],generationConfig:{...settings.stage2_generation_config,responseMimeType:'application/json',responseSchema:STAGE2_SCHEMA}};
  auditRequest(body);
  return {body,prompt,schema:STAGE2_SCHEMA,input:{segments,vocabulary,discriminators,examples,images:usedImages,analysis_strategy,analysis_mode,video_id:video.video_id,duration_s:video.duration_s},evidence_condition:visual?(usedImages.length?'text_actual_video_standard_images':'text_actual_video'):'text'};
}
export function auditRequest(body) {
  const parts=body.contents.flatMap(c=>c.parts); const videos=parts.filter(p=>p.fileData?.mimeType.startsWith('video/'));
  demand(videos.length<=1,'MULTI_VIDEO_FORBIDDEN','通常推論は1リクエスト1動画です。');
  for(const p of parts) { if(p.fileData) demand(p.fileData.fileUri.startsWith('gs://')||p.fileData.fileUri.startsWith('mock://'),'INVALID_MEDIA_URI','媒体はCloud Storage URIで指定してください。'); if(p.mediaProcessing) demand(p.fileData?.mimeType.startsWith('video/'),'INVALID_PROCESSING_PART','mediaProcessingは動画Part直下のみです。'); }
  // Inspect context objects only; prompt prose may mention prohibited keys.
  const prohibited=new Set(['build_only_gt','display_segments','scoring_only','gt_segment_id','gt_process_id','gt_ref','scenario','observability','gt_version']);
  function walk(o) { if(!o||typeof o!=='object')return; for(const [k,v] of Object.entries(o)) { demand(!prohibited.has(k),'GT_LEAK','通常入力へGT/採点専用情報が混入しています。'); walk(v); } }
  for(const p of parts) if(p.text?.startsWith('{')) walk(JSON.parse(p.text));
  return true;
}
export function inputSignature(body, media) {
  const copy=clone(body); const lookup=new Map(media.map(m=>[m.uri,m.sha256]));
  for(const c of copy.contents) for(const p of c.parts) if(p.fileData) { demand(lookup.has(p.fileData.fileUri),'MISSING_MEDIA_HASH','入力媒体のハッシュがありません。'); p.fileData.fileUri=`sha256:${lookup.get(p.fileData.fileUri)}`; }
  return sha256(copy);
}
export function stage1Key({strategy,video,settings,prompts,vocabulary,discriminators,standard_set_id,boundaries=null}) {
  const profile=profileFor(strategy), prompt=prompts.loaded[`${profile}_${boundaries?'fixed':'discover'}`];
  return {cache_schema_version:'stage1-cache.v1',analysis_strategy:strategy,stage1_profile:profile,boundary_mode:boundaries?'fixed':'discover',video_id:video.video_id,source_sha256:video.source_sha256,submitted_sha256:video.sha256,duration_s:video.duration_s,preprocess_version:video.preprocess_version,stage1_prompt_version:prompt.version,stage1_prompt_sha256:prompt.sha256,observation_schema_version:'observation.v1',response_schema_sha256:sha256(boundaries?FIXED_SCHEMA:DISCOVER_SCHEMA),vocabulary_version:vocabulary.vocabulary_version,vocabulary_sha256:sha256(vocabulary),discriminator_version:discriminators.discriminator_version,discriminator_sha256:sha256(discriminators),non_work_labels_version:vocabulary.non_work_labels_version,standard_set_id:standard_set_id??null,model_id:settings.stage1_model,model_revision_scope:settings.model_revision_scope,project:settings.project,location:settings.location,host:settings.host,api_version:settings.api_version,processing_mode:settings.processing_mode,audio_enabled:settings.audio_enabled,fps:settings.fps,media_resolution:settings.media_resolution,generation_config:settings.stage1_generation_config,boundary_manifest_sha256:boundaries?sha256(boundaries):null};
}
export function compatibleKeys(a,b) { const aa=clone(a),bb=clone(b); delete aa.analysis_strategy; delete bb.analysis_strategy; return canonicalJSON(aa)===canonicalJSON(bb) && a.stage1_profile===b.stage1_profile; }
export function profileConditions(settings,prompts,profile) { return {prompt_pair_version:prompts.pairs[profile],fixed_prompt_sha256:prompts.loaded[`${profile}_fixed`].sha256,discover_prompt_sha256:prompts.loaded[`${profile}_discover`].sha256,observation_sha256:prompts.observation_sha256,model_id:settings.stage1_model,model_revision_scope:settings.model_revision_scope,project:settings.project,location:settings.location,host:settings.host,processing_mode:settings.processing_mode,audio_enabled:settings.audio_enabled,fps:settings.fps,media_resolution:settings.media_resolution,generation_config:settings.stage1_generation_config}; }
