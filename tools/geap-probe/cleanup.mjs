import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {LocalStore} from '../../src/store.js';
import {tasConfig} from '../../src/settings.js';
import {GcsAdapter} from '../../src/geap.js';
import {CleanupLedger} from '../../src/cleanup.js';
import {id,demand} from '../../src/core.js';
export async function recoverProbe(root,env=process.env){const store=new LocalStore(path.resolve(root)),resolved=await store.read('resolved-manifest.json');const config=tasConfig({...env,MOCK_MODE:String(resolved.mock)});if(!config.mockMode)demand(config.bucket&&config.approvedReal,'ENVIRONMENT_NOT_CONFIRMED','台帳のバケット・認証主体を確認してください。');const ledger=new CleanupLedger(store,config,new GcsAdapter(config)),inflight=await store.read('inflight.json',null);const owners=new Set((await ledger.entries()).flatMap(e=>e.lease_run_ids));for(const run of owners)await ledger.releaseRun(run,{unknown:Boolean(inflight?.remote_outcome_unknown)});await ledger.sweep();const result={schema_version:'probe-cleanup-recovery.v1',recovery_id:id(),created_at:new Date().toISOString(),mock:config.mockMode,cleanup:await ledger.summary(resolved.evaluation_run_id)};await store.immutable(`cleanup-reports/${result.recovery_id}.json`,result);return result;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){demand(process.argv[2],'EVALUATION_DIRECTORY_REQUIRED','回収する評価runのディレクトリを指定してください。');try{console.log(JSON.stringify(await recoverProbe(process.argv[2]),null,2));}catch(e){console.error(e.code||'CLEANUP_FAILED',e.message);process.exitCode=1;}}
