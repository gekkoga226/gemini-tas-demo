import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {safeId} from './store.js';
import {demand,sha256} from './core.js';
import {defaultSettings} from './settings.js';
import {displayAdapter} from './pipeline.js';

export async function readBody(request,limit=4*1024*1024) {let length=0,chunks=[];for await(const c of request){length+=c.length;demand(length<=limit,'REQUEST_TOO_LARGE','入力JSONが大きすぎます。',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{demand(false,'INVALID_JSON','JSONの書式が不正です。');}}
export async function streamFile(request,response,file,mime) {
  const stat=await fs.stat(file);const range=request.headers.range;
  let start=0,end=stat.size-1;
  if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2])){response.writeHead(416,{'content-range':`bytes */${stat.size}`});response.end();return;}
    if(!m[1])start=Math.max(0,stat.size-Number(m[2]));else {start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
    if(start>end||start>=stat.size){response.writeHead(416,{'content-range':`bytes */${stat.size}`});response.end();return;}
  }
  response.writeHead(range?206:200,{'content-type':mime,'accept-ranges':'bytes','content-length':end-start+1,...(range?{'content-range':`bytes ${start}-${end}/${stat.size}`}:{})});
  const stream=createReadStream(file,{start,end});response.on('close',()=>stream.destroy());stream.on('error',()=>response.destroy());stream.pipe(response);
}
export async function routeTas(request,response,url,service,json) {
  await service.ready;const p=url.pathname,m=request.method;
  if(m==='GET'&&p==='/api/config'){json(response,200,{...service.environment,settings:defaultSettings(service.config),limits:{max_upload_bytes:service.config.maxUploadBytes,min_free_bytes:service.config.minFreeBytes},fault_injection_enabled:service.config.allowFaults});return;}
  if(m==='GET'&&p==='/api/media'){json(response,200,{media:await service.mediaList()});return;}
  if(m==='POST'&&p==='/api/media'){const mime=request.headers['content-type']?.split(';')[0];const name=decodeURIComponent(request.headers['x-display-name']||'登録媒体');const a=await service.media.register(request,mime,name);const {asset_ref,...publicAsset}=a;json(response,201,publicAsset);return;}
  let match=p.match(/^\/api\/media\/([^/]+)\/content$/);
  if(m==='GET'&&match){const a=await service.getMedia(match[1]);await streamFile(request,response,service.store.resolve(a.asset_ref),a.mime_type);return;}
  if(m==='POST'&&p==='/api/demo-fixture'){json(response,202,await service.demo());return;}
  if(m==='GET'&&p==='/api/vocabularies'){json(response,200,{vocabularies:await service.vocabularies()});return;}
  if(m==='POST'&&p==='/api/vocabularies'){const b=await readBody(request);json(response,201,await service.registerVocabulary(b.vocabulary,b.discriminators,b));return;}
  if(m==='POST'&&p==='/api/vocabulary-extractions'){const r=await service.createVocabularyExtraction(await readBody(request));json(response,202,{run_id:r.run_id,status:r.status});return;}
  match=p.match(/^\/api\/vocabulary-extractions\/([^/]+)(?:\/(approve))?$/);
  if(match){const runId=safeId(match[1]);if(m==='POST'&&match[2])json(response,201,await service.approveVocabulary(runId,await readBody(request)));else if(m==='GET')json(response,200,await service.store.read(`runs/${runId}/vocabulary-draft.json`));else json(response,405,{code:'METHOD_NOT_ALLOWED'});return;}
  if(m==='POST'&&p==='/api/stage1-migrations'){json(response,201,await service.migrateArtifact(await readBody(request)));return;}
  match=p.match(/^\/api\/analysis-runs\/([^/]+)\/rederive-safety$/);if(m==='POST'&&match){const r=await service.rederiveSafety(safeId(match[1]),await readBody(request));json(response,202,{run_id:r.run_id,status:r.status});return;}
  if(m==='POST'&&p==='/api/standard-set-build-inputs/gt'){json(response,201,await service.registerGT(await readBody(request)));return;}
  if(m==='GET'&&p==='/api/standard-sets'){json(response,200,{standard_sets:await service.sets()});return;}
  if(m==='POST'&&p==='/api/standard-sets'){const r=await service.createStandard(await readBody(request));json(response,202,{run_id:r.run_id,standard_set_id:r.standard_set_id,status:r.status});return;}
  match=p.match(/^\/api\/standard-sets\/([^/]+)(?:\/(approve|retire|delete-media|inspection))?$/);
  if(match){const setId=safeId(match[1]);if(m==='POST'&&match[2]==='approve'){json(response,200,await service.approve(setId,(await readBody(request)).approved_by));return;}if(m==='POST'&&match[2]==='retire'){json(response,200,await service.retire(setId));return;}if(m==='POST'&&match[2]==='delete-media'){json(response,200,await service.deleteSetMedia(setId));return;}if(m==='GET'){const s=await service.getSet(setId);json(response,200,{...service.publicSet(s),...(match[2]==='inspection'?{examples:s.examples}: {})});return;}}
  match=p.match(/^\/api\/standard-images\/([^/]+)\/([^/]+)$/);
  if(m==='GET'&&match){const set=await service.getSet(match[1]),img=set.representative_images.find(i=>i.image_id===match[2]);demand(img,'IMAGE_NOT_FOUND','代表画像が見つかりません。',404);await streamFile(request,response,service.store.resolve(img.asset_ref),'image/jpeg');return;}
  if(m==='POST'&&p==='/api/comparison-sessions'){json(response,201,await service.createSession(await readBody(request)));return;}
  match=p.match(/^\/api\/comparison-sessions\/([^/]+)\/close$/);if(m==='POST'&&match){json(response,200,await service.closeSession(match[1]));return;}
  if(m==='GET'&&p==='/api/analysis-runs'){json(response,200,{runs:await service.history()});return;}
  if(m==='POST'&&p==='/api/analysis-runs'){const r=await service.createAnalysis(await readBody(request));json(response,202,{run_id:r.run_id,status:r.status,status_url:`/api/analysis-runs/${r.run_id}`});return;}
  match=p.match(/^\/api\/analysis-runs\/([^/]+)\/reviews\/([^/]+)$/);if(m==='GET'&&match){const runId=safeId(match[1]),reviewId=safeId(match[2]),review=await service.store.read(`runs/${runId}/reviews/${reviewId}/review.json`);if(url.searchParams.get('download')==='1')response.setHeader('content-disposition',`attachment; filename="${review.mock?'MOCK_':''}${runId}_reviewed.json"`);json(response,200,review);return;}
  match=p.match(/^\/api\/analysis-runs\/([^/]+)(?:\/(result|display|cancel|retry|reviews|cleanup-retry))?$/);
  if(match){const runId=safeId(match[1]),action=match[2];if(m==='GET'&&!action){json(response,200,await service.status(runId));return;}if(m==='GET'&&action==='result'){const result=await service.result(runId);if(url.searchParams.get('download')==='1')response.setHeader('content-disposition',`attachment; filename="${result.mock?'MOCK_':''}${runId}_prediction.json"`);json(response,200,result);return;}if(m==='GET'&&action==='display'){const r=await service.result(runId);json(response,200,{schema_version:'tas-display.v1',run_id:runId,original_result_sha256:sha256(r),prediction:displayAdapter(r.segments)});return;}if(m==='GET'&&action==='reviews'){json(response,200,{reviews:await service.reviews(runId)});return;}if(m==='POST'&&action==='reviews'){json(response,201,await service.saveReview(runId,await readBody(request)));return;}if(m==='POST'&&action==='cancel'){json(response,202,await service.cancel(runId));return;}if(m==='POST'&&action==='retry'){const r=await service.retry(runId,(await readBody(request)).client_request_id);json(response,202,{run_id:r.run_id,status:r.status});return;}if(m==='POST'&&action==='cleanup-retry'){await service.cleanup.sweep(true);json(response,200,await service.cleanup.summary(runId));return;}}
  json(response,404,{code:'NOT_FOUND',message:'対象が見つかりません。履歴を更新してください。'});
}
