// Local synthetic inputs only. No model calls and no copied mock results.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {MediaTools} from '../src/media.js';
import {LocalStore} from '../src/store.js';
import {tasConfig} from '../src/settings.js';
import {demoVocabulary,demoDiscriminators} from '../src/mock-model.js';

export async function prepareConnectivityInputs(base='http://127.0.0.1:4173',root='connectivity-inputs') {
  const url=new URL(base);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw new Error('接続先は同じPCの http://127.0.0.1:ポート に限定してください。');
  const call=async(route,options)=>{const r=await fetch(new URL(route,url),options);const data=await r.json();if(!r.ok)throw new Error(data.message);return data;};
  const session=await call('/api/session');
  const store=new LocalStore(root);await store.init();
  const media=new MediaTools(tasConfig({MOCK_MODE:'true',FFMPEG_PATH:process.env.FFMPEG_PATH,FFPROBE_PATH:process.env.FFPROBE_PATH}),store);
  const registered=[];
  for(const [duration,name] of [[24,'合成・接続確認用標準24秒'],[30,'合成・接続確認用実作業30秒']]) {
    const asset=await media.syntheticVideo(duration,name);
    registered.push(await call('/api/media',{method:'POST',headers:{'content-type':'video/mp4','x-display-name':encodeURIComponent(name),'x-local-token':session.token},body:await fs.readFile(store.resolve(asset.asset_ref))}));
  }
  const vocabulary=demoVocabulary(),discriminators=demoDiscriminators(vocabulary);
  const gt={gt_version:'synthetic-connectivity-gt.v1',video_id:registered[0].video_id,duration_s:24,segments:vocabulary.labels.filter(l=>l.kind==='work').map((l,i)=>({gt_segment_id:`synthetic-${i+1}`,gt_process_id:`occurrence-${i+1}`,start_s:i*6,end_s:(i+1)*6,job_no:l.job_no,job_title:l.job_title}))};
  for(const [name,value] of Object.entries({'vocabulary.json':vocabulary,'discriminators.json':discriminators,'standard-gt.json':gt}))await fs.writeFile(path.join(root,name),JSON.stringify(value,null,2));
  return {root:path.resolve(root),standard:registered[0],actual:registered[1]};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const r=await prepareConnectivityInputs(process.argv[2]);
  console.log(`合成MP4をローカル登録しました。JSON入力: ${r.root}\n画面を再読み込みし、ガイドの語彙登録・標準セット作成へ進んでください。外部API呼び出し・解析結果の作成は行っていません。`);
}
