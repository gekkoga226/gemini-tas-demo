import path from 'node:path';
import { id, demand, clone } from './core.js';
import { SAFETY, validateSafety } from './contracts.js';

export function tasConfig(env=process.env) {
  const mockMode=String(env.MOCK_MODE??'true').toLowerCase()!=='false';
  const location=env.GEAP_LOCATION||null;
  const priceTableRef=env.GEAP_PRICE_TABLE||null;
  return { mockMode, dataRoot:path.resolve(env.DATA_ROOT||'data'), maxUploadBytes:Number(env.MAX_UPLOAD_BYTES|| (mockMode?2147483648:0)), minFreeBytes:Number(env.MIN_FREE_BYTES||(mockMode?268435456:0)), mockDelayMs:Number(env.MOCK_DELAY_MS??600), ffmpeg:env.FFMPEG_PATH||'ffmpeg', ffprobe:env.FFPROBE_PATH||'ffprobe', authMode:env.GEAP_AUTH_MODE||'gcloud', principal:env.GEAP_PRINCIPAL||null, project:env.GEAP_PROJECT||null, location, host:env.GEAP_HOST||(location?`https://${location}-aiplatform.googleapis.com`:null), bucket:env.GEAP_BUCKET||null, modelStage1:env.GEAP_STAGE1_MODEL||null, modelStage2:env.GEAP_STAGE2_MODEL||null, apiVersion:'v1beta1', revisionScope:env.MODEL_REVISION_SCOPE||(mockMode?'mock-contract.v1':id()), approvedReal:env.GEAP_ENVIRONMENT_CONFIRMED==='true', timeoutMs:Number(env.GEAP_TIMEOUT_MS||3600000), jobTimeoutMs:Number(env.JOB_TIMEOUT_MS||10800000), graceMs:Number(env.REMOTE_GRACE_MS||7200000), cleanupTickMs:Number(env.CLEANUP_TICK_MS||60000), allowFaults:mockMode && env.ENABLE_MOCK_FAULTS==='true', appVersion:'0.2.0', priceTable:null,priceTableRef };
}
export function defaultSettings(config) {
  return {mode:config.mockMode?'mock':'geap', stage1_model:config.mockMode?'mock-gemini-contract.v1':config.modelStage1,stage2_model:config.mockMode?'mock-gemini-contract.v1':config.modelStage2,model_revision_scope:config.revisionScope,project:config.mockMode?null:config.project,location:config.mockMode?null:config.location,host:config.mockMode?null:config.host,api_version:'v1beta1',processing_mode:'AGENTIC',audio_enabled:false,fps:1,media_resolution:'api_default',stage1_generation_config:{temperature:0},stage2_generation_config:{temperature:0},prompt_release:'round18.v1',safety_policy:clone(SAFETY)};
}
export function normalizeSettings(input,config) {
  const defaults=defaultSettings(config); const allowed=Object.keys(defaults);
  demand(input===undefined || (input&&typeof input==='object'&&!Array.isArray(input)), 'INVALID_SETTINGS','設定はオブジェクトで指定してください。');
  demand(Object.keys(input||{}).every(k=>allowed.includes(k)), 'INVALID_SETTINGS','不明な設定です。');
  const s={...defaults,...clone(input||{})};
  demand(s.mode===defaults.mode && s.api_version==='v1beta1' && ['AGENTIC','STATIC'].includes(s.processing_mode) && typeof s.audio_enabled==='boolean' && Number.isFinite(s.fps)&&s.fps>0&&s.fps<=24 && typeof s.prompt_release==='string','INVALID_SETTINGS','処理設定が不正です。');
  for(const key of ['stage1_model','stage2_model','model_revision_scope']) demand(typeof s[key]==='string'&&s[key].length>0,'MODEL_REQUIRED','確認したモデルIDと検証セッションを設定してください。');
  for(const key of ['stage1_generation_config','stage2_generation_config']) demand(s[key]&&typeof s[key]==='object'&&!Array.isArray(s[key])&&!('seed' in s[key])&&!('responseSchema' in s[key])&&!('responseMimeType' in s[key]),'INVALID_SETTINGS','生成条件のseed/スキーマ上書きは使用できません。');
  for(const key of ['project','location','host']) demand(s[key]===defaults[key],'INVALID_SETTINGS','接続先はサーバー設定に従ってください。');
  validateSafety(s.safety_policy); return s;
}
