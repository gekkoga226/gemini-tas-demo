import fs from 'node:fs/promises';
import path from 'node:path';
import {id,now,demand} from './core.js';

export class CleanupLedger {
  constructor(store,config,cloud,{clock=()=>Date.now(),failRemove=null}={}) {this.store=store;this.config=config;this.cloud=cloud;this.clock=clock;this.failRemove=failRemove;this.busy=false;}
  async entries() {const all=[];for(const k of await this.store.list('cleanup')){const e=await this.store.read(`cleanup/${k}/entry.json`,null);if(e)all.push(e);}return all;}
  async update(assetId,patch) {const ref=`cleanup/${assetId}/entry.json`;const e=await this.store.read(ref);Object.assign(e,patch);await this.store.write(ref,e);return e;}
  async exclusive(fn) {const next=(this.serial||Promise.resolve()).then(fn,fn);this.serial=next.catch(()=>{});return next;}
  async register({runId,sessionId=null,uri,hash=null,backend,localRef=null}) {
    const assetId=id(); const e={asset_id:assetId,owner_id:'local',run_id:runId,session_id:sessionId,uri,content_sha256:hash,generation:null,created_at:now(),expires_at:new Date(this.clock()+86400000).toISOString(),lease_run_ids:[runId],cleanup_status:'pending',attempts:0,next_retry_at:null,last_error:null,remote_outcome_unknown:false,grace_until:null,backend,local_ref:localRef,deleted_at:null};
    await this.store.immutable(`cleanup/${assetId}/entry.json`,e);return e;
  }
  async registerLocal(ref,runId) {return this.register({runId,uri:`local://${ref}`,backend:'local',localRef:ref});}
  async upload(media,runId,sessionId,signal) {
    return this.exclusive(async()=>{
    if(sessionId) {const previous=(await this.entries()).find(e=>e.session_id===sessionId&&e.content_sha256===media.sha256&&e.backend!=='local'&&e.generation&&e.cleanup_status!=='deleted');if(previous){await this.update(previous.asset_id,{referenced_run_ids:[...new Set([...(previous.referenced_run_ids||[previous.run_id]),runId])],lease_run_ids:[...new Set([...previous.lease_run_ids,runId])]});return {...media,uri:previous.uri,cleanup_asset_id:previous.asset_id};}}
    const object=`tas-temp/local/${sessionId||runId}/${id()}`;const uri=this.config.mockMode?`mock://${object}`:`gs://${this.config.bucket}/${object}`;
    const e=await this.register({runId,sessionId,uri,hash:media.sha256,backend:this.config.mockMode?'mock':'gcs'});
    if(this.config.mockMode) {const ref=`mock-cloud/${e.asset_id}/object`;await fs.mkdir(path.dirname(this.store.resolve(ref)),{recursive:true});await fs.writeFile(this.store.resolve(ref),media.sha256);await this.update(e.asset_id,{generation:'mock-1',local_ref:ref});}
    else {demand(this.config.approvedReal,'CONSENT_REQUIRED','送信前の環境確認が必要です。');try{const generation=await this.cloud.upload(e,this.store.resolve(media.asset_ref),media.mime_type,signal);await this.update(e.asset_id,{generation});}catch(error){if(error.code==='UPLOAD_OUTCOME_UNKNOWN')await this.update(e.asset_id,{remote_outcome_unknown:true,grace_until:new Date(this.clock()+this.config.graceMs).toISOString()});throw error;}}
    return {...media,uri,cleanup_asset_id:e.asset_id};
    });
  }
  async releaseRun(runId,{unknown=false}={}) {return this.exclusive(async()=>{for(const e of await this.entries())if(e.lease_run_ids.includes(runId))await this.update(e.asset_id,{lease_run_ids:e.lease_run_ids.filter(x=>x!==runId),remote_outcome_unknown:e.remote_outcome_unknown||unknown,grace_until:unknown?new Date(this.clock()+this.config.graceMs).toISOString():e.grace_until});});}
  async releaseAsset(assetId,runId) {return this.exclusive(async()=>{const e=await this.store.read(`cleanup/${assetId}/entry.json`);await this.update(assetId,{lease_run_ids:e.lease_run_ids.filter(x=>x!==runId)});});}
  async recover() {
    for(const e of await this.entries()) {
      if(e.cleanup_status==='deleted')continue;const live=[];let unknown=false;
      for(const runId of e.lease_run_ids){const r=await this.store.read(`runs/${runId}/run.json`,null);if(r&&['queued','preparing','uploading','stage1_running','stage2_running','retry_wait','validating','persisting','stage1_ready'].includes(r.status))live.push(runId);else if(r?.remote_outcome_unknown)unknown=true;}
      await this.update(e.asset_id,{lease_run_ids:live,cleanup_status:'pending',remote_outcome_unknown:e.remote_outcome_unknown||unknown,grace_until:unknown?new Date(this.clock()+this.config.graceMs).toISOString():e.grace_until});
    }
    await this.sweep();
  }
  async sweep(force=false) {
    if(this.busy)return;this.busy=true;
    try {await this.exclusive(async()=>{for(const original of await this.entries()) {
      const e=await this.store.read(`cleanup/${original.asset_id}/entry.json`);if(e.cleanup_status==='deleted')continue;
      const session=e.session_id?await this.store.read(`comparison-sessions/${e.session_id}/session.json`,null):null;
      const sessionOpen=session?.status==='open'&&Date.parse(session.expires_at)>this.clock();
      if(e.lease_run_ids.length||sessionOpen||(e.grace_until&&Date.parse(e.grace_until)>this.clock())){await this.update(e.asset_id,{cleanup_status:'waiting_lease'});continue;}
      if(!force&&e.next_retry_at&&Date.parse(e.next_retry_at)>this.clock())continue;
      await this.update(e.asset_id,{cleanup_status:'deleting'});
      try {if(this.failRemove)await this.failRemove(e);if(e.backend==='gcs')await this.cloud.remove(e);else if(e.local_ref)await fs.rm(this.store.resolve(e.local_ref),{force:true});await this.update(e.asset_id,{cleanup_status:'deleted',deleted_at:now(),last_error:null,next_retry_at:null,attempts:e.attempts+1});}
      catch(err){const attempts=e.attempts+1,elapsed=this.clock()-Date.parse(e.created_at);const wait=[60000,300000,1800000][attempts-1]??3600000;await this.update(e.asset_id,{attempts,last_error:{code:err.code||'CLEANUP_FAILED',message:'一時媒体の削除に失敗しました。権限・保存先を確認してください。'},cleanup_status:elapsed>=86400000?'cleanup_failed':'retry_wait',next_retry_at:new Date(this.clock()+wait).toISOString()});}
    }});} finally {this.busy=false;}
  }
  async summary(runId) {const es=(await this.entries()).filter(e=>e.run_id===runId||e.lease_run_ids.includes(runId)||e.referenced_run_ids?.includes(runId));const statuses=es.map(e=>e.cleanup_status);const priority=['cleanup_failed','retry_wait','deleting','waiting_lease','pending'];return {cleanup_status:priority.find(s=>statuses.includes(s))||(es.length?'deleted':'not_needed'),ledger_ids:es.map(e=>e.asset_id),items:es.map(e=>({asset_id:e.asset_id,status:e.cleanup_status,attempts:e.attempts,next_retry_at:e.next_retry_at,deleted_at:e.deleted_at,remote_outcome_unknown:e.remote_outcome_unknown}))};}
}
