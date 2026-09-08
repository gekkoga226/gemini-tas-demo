import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { demand, fault, delay } from './core.js';

const exec=promisify(execFile);
export async function getAccessToken(config,fetchImpl=fetch) {
  if(config.authMode==='service_account') {
    try { const r=await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(10000)}); demand(r.ok,'AUTH_REQUIRED','実行環境のサービスアカウント認証が必要です。'); const v=await r.json(); demand(typeof v.access_token==='string','AUTH_REQUIRED','認証応答が不正です。'); return v.access_token; } catch { throw fault('AUTH_REQUIRED','実行環境のサービスアカウント認証を確認してください。'); }
  }
  demand(config.authMode==='gcloud','AUTH_REQUIRED','認証方式をgcloudまたはservice_accountに設定してください。');
  try {
    const r=process.platform==='win32'?await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','& gcloud.cmd auth print-access-token'],{windowsHide:true,timeout:30000,maxBuffer:65536}):await exec('gcloud',['auth','print-access-token'],{windowsHide:true,timeout:30000,maxBuffer:65536});
    const token=r.stdout.trim(); demand(token.length>0,'AUTH_REQUIRED','gcloudにログインしてください。'); return token;
  } catch { throw fault('AUTH_REQUIRED','gcloudのログインと認証主体を確認してから再試行してください。'); }
}
export function findAgenticTraces(value, path='$', hits=[]) {
  if(!value||typeof value!=='object')return hits;
  for(const [key,child] of Object.entries(value)) { const n=key.toLowerCase().replace(/_/g,''); if(n.includes('processingcall')||n.includes('processingresult')||(key==='type'&&typeof child==='string'&&/processing_?(call|result)/i.test(child))) hits.push({path:`${path}.${key}`,value:child}); findAgenticTraces(child,`${path}.${key}`,hits); }
  return hits;
}
export const usageOf = payload => payload?.usageMetadata??null;
export const extractText = payload => (payload?.candidates?.[0]?.content?.parts??[]).filter(p=>typeof p.text==='string'&&!p.thought).map(p=>p.text).join('');
export function parseModelOutput(payload) {
  demand(payload?.candidates?.length===1,'INVALID_MODEL_OUTPUT','モデルの候補応答がありません。',422);
  demand(!payload.candidates[0].finishReason || payload.candidates[0].finishReason==='STOP','OUTPUT_NOT_COMPLETE','出力が打ち切られました。区間を省略せず、設定を確認してください。',422);
  try { return JSON.parse(extractText(payload)); } catch { throw fault('INVALID_MODEL_OUTPUT','モデル応答をJSONとして読み取れません。',422); }
}
export class GeapAdapter {
  constructor(config,{fetchImpl=fetch,tokenProvider=()=>getAccessToken(config,fetchImpl),waitImpl=delay}={}) { this.config=config; this.fetch=fetchImpl; this.tokenProvider=tokenProvider;this.wait=waitImpl; }
  assertReady(settings) {
    demand(this.config.approvedReal && this.config.bucket && settings.project&&settings.location&&settings.host&&settings.stage1_model&&settings.stage2_model,'ENVIRONMENT_NOT_CONFIRMED','送信同意・プロジェクト・バケット・モデル・権限の環境確認が必要です。');
    demand(settings.api_version==='v1beta1' && /^https:\/\/[^/]+$/.test(settings.host),'INVALID_ENDPOINT','HTTPS接続先とv1beta1を指定してください。');
    demand(/^[\w.-]+$/.test(settings.project)&&/^[\w-]+$/.test(settings.location)&&/^[\w.-]+$/.test(settings.stage1_model)&&/^[\w.-]+$/.test(settings.stage2_model),'INVALID_ENDPOINT','接続先識別子が不正です。');
  }
  async call({body,settings,stage,signal,onRequest=async()=>{},onAttempt=async()=>{},onRetry=async()=>{},timeoutMs=this.config.timeoutMs}) {
    this.assertReady(settings);
    const model=stage==='stage1'?settings.stage1_model:settings.stage2_model;
    const url=`${settings.host}/v1beta1/projects/${settings.project}/locations/${settings.location}/publishers/google/models/${model}:generateContent`;
    let authRetries=0,transientRetries=0;
    while(true) {
      signal?.throwIfAborted(); const started=Date.now(); const token=await this.tokenProvider();
      await onRequest({url,body,model_id:model});
      const timeout=AbortSignal.timeout(timeoutMs); const combined=signal?AbortSignal.any([signal,timeout]):timeout;
      let r,raw,payload;
      try { r=await this.fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body),signal:combined}); raw=await r.text(); try {payload=JSON.parse(raw);}catch{payload=null;} }
      catch(e) { await onAttempt({url,body,raw_response:null,payload:null,http_status:null,elapsed_ms:Date.now()-started,usage:null,remote_outcome_unknown:true,error_code:'REMOTE_OUTCOME_UNKNOWN',model_id:model,model_version:null}); throw fault('REMOTE_OUTCOME_UNKNOWN','送信後の結果が不明です。自動再送はしません。再試行は新しい実行になります。',502); }
      const info={url,body,raw_response:raw,payload,http_status:r.status,elapsed_ms:Date.now()-started,usage:usageOf(payload),remote_outcome_unknown:false,error_code:r.ok?null:`GEAP_HTTP_${r.status}`,model_id:model,model_version:payload?.modelVersion??null,agentic_traces:findAgenticTraces(payload)};
      await onAttempt(info);
      if(r.status===401 && authRetries++===0) { await onRetry({reason:'auth_refresh',delay_ms:0}); continue; }
      if((r.status===429||r.status>=500)&&transientRetries<2) {
        const h=r.headers.get('retry-after'); const retryAfter=h?(Number.isFinite(Number(h))?Number(h)*1000:Math.max(0,Date.parse(h)-Date.now())):0;
        const wait=Math.max([5000,20000][transientRetries++],Number.isFinite(retryAfter)?retryAfter:0); await onRetry({reason:`HTTP_${r.status}`,delay_ms:wait}); await this.wait(wait,signal); continue;
      }
      if(!r.ok) throw fault(r.status===401?'AUTH_REQUIRED':r.status===403?'PERMISSION_DENIED':r.status===404?'INPUT_UNAVAILABLE':`GEAP_HTTP_${r.status}`,'GEAPとの通信に失敗しました。保存済み試行と接続設定を確認してください。',502);
      return {output:parseModelOutput(payload),...info};
    }
  }
}

export class GcsAdapter {
  constructor(config,{fetchImpl=fetch,tokenProvider=()=>getAccessToken(config,fetchImpl)}={}) {this.config=config;this.fetch=fetchImpl;this.tokenProvider=tokenProvider;}
  split(uri) { const m=/^gs:\/\/([^/]+)\/(.+)$/.exec(uri); demand(m&&m[1]===this.config.bucket&&m[2].startsWith('tas-temp/'),'INVALID_TEMP_URI','専用台帳の一時URIだけを操作できます。'); return {bucket:m[1],object:m[2]}; }
  async request(url,options) { for(let i=0;i<2;i++){ const token=await this.tokenProvider(); const r=await this.fetch(url,{...options,headers:{...options.headers,authorization:`Bearer ${token}`}}); if(r.status!==401||i===1)return r; } }
  async upload(entry,file,mime,signal) {
    const {bucket,object}=this.split(entry.uri); const token=await this.tokenProvider();
    // No automatic stream retry: an uncertain upload is reconciled by the ledger.
    let r;
    try { r=await this.fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(object)}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':mime},body:createReadStream(file),duplex:'half',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.config.timeoutMs)]):AbortSignal.timeout(this.config.timeoutMs)}); }
    catch {throw fault('UPLOAD_OUTCOME_UNKNOWN','アップロード結果が不明です。削除台帳で回収します。',502);}
    demand(r.ok,'UPLOAD_FAILED','一時バケットへのアップロードに失敗しました。',502); return (await r.json()).generation;
  }
  async metadata(entry) {
    const {bucket,object}=this.split(entry.uri);const r=await this.request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`,{signal:AbortSignal.timeout(30000)});
    if(r.status===404)return null; demand(r.ok,'CLEANUP_FAILED','一時媒体の照合に失敗しました。',502); return r.json();
  }
  async remove(entry) {
    const {bucket,object}=this.split(entry.uri);
    let generation=entry.generation;
    if(generation===null) { const m=await this.metadata(entry); if(!m)return; generation=m.generation; }
    const r=await this.request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?ifGenerationMatch=${encodeURIComponent(generation)}`,{method:'DELETE',signal:AbortSignal.timeout(30000)});
    demand(r.ok||r.status===404,'CLEANUP_FAILED','一時媒体の削除に失敗しました。権限を確認してください。',502);
  }
}
