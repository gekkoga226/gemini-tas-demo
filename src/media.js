import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {id,now,sha256,demand,fault} from './core.js';
const exec=promisify(execFile);
const TIMELINE_TOLERANCE_S=.001;
const finite=value=>{const number=Number(value);return Number.isFinite(number)?number:null;};
function timeBaseSeconds(value) {
  const match=/^(\d+)\/(\d+)$/.exec(String(value??''));
  if(!match)return null;
  const denominator=Number(match[2]);return denominator>0?Number(match[1])/denominator:null;
}
function videoTimeline(probe) {
  const stream=probe.streams?.find(s=>s.codec_type==='video');
  demand(stream,'INVALID_VIDEO','有効なMP4動画を選んでください。',422);
  const timeBase=timeBaseSeconds(stream.time_base),startPts=finite(stream.start_pts),durationTs=finite(stream.duration_ts);
  const startTime=finite(stream.start_time)??(startPts!==null&&timeBase!==null?startPts*timeBase:null)??finite(probe.format?.start_time)??0;
  const duration=finite(stream.duration)??(durationTs!==null&&timeBase!==null?durationTs*timeBase:null)??finite(probe.format?.duration);
  const frameCount=finite(stream.nb_frames);
  return {version:'primary-video-stream.v1',start_time_s:startTime,duration_s:duration,time_base:stream.time_base??null,start_pts:startPts,duration_ts:durationTs,frame_count:Number.isSafeInteger(frameCount)&&frameCount>=0?frameCount:null,codec_name:stream.codec_name??null};
}
function sameVideoTimeline(source,submitted) {
  const a=source.video_timeline,b=submitted.video_timeline;
  return Math.abs(a.start_time_s-b.start_time_s)<=TIMELINE_TOLERANCE_S&&Math.abs(a.duration_s-b.duration_s)<=TIMELINE_TOLERANCE_S&&
    a.codec_name===b.codec_name&&source.width===submitted.width&&source.height===submitted.height&&
    (a.frame_count===null||b.frame_count===null||a.frame_count===b.frame_count);
}
export async function hashFile(file) {const h=crypto.createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export class MediaTools {
  constructor(config,store) {this.config=config;this.store=store;}
  async command(bin,args,signal) { try{return await exec(bin,args,{windowsHide:true,maxBuffer:128*1024*1024,signal});}catch(e){throw fault(signal?.aborted?'CANCELLED':'MEDIA_PROCESSING_FAILED','媒体の検証・変換に失敗しました。FFmpeg/ffprobeと入力を確認してください。',422);}}
  async versions() {const a=await this.command(this.config.ffmpeg,['-version']);const b=await this.command(this.config.ffprobe,['-version']);return {ffmpeg:a.stdout.split(/\r?\n/)[0],ffprobe:b.stdout.split(/\r?\n/)[0]};}
  async probe(file) {const r=await this.command(this.config.ffprobe,['-v','error','-show_format','-show_streams','-of','json',file]);return JSON.parse(r.stdout);}
  async inspect(file,mime) {
    if(mime==='application/pdf') {const b=await fs.readFile(file);demand(b.subarray(0,5).toString()==='%PDF-','INVALID_PDF','PDFの形式が不正です。',422);let info;try{info=await this.command(this.config.pdfinfo||process.env.PDFINFO_PATH||'pdfinfo',[file]);}catch{throw fault('PDF_VALIDATION_FAILED','有効なPDFとpdfinfo（PDFINFO_PATH）の設定を確認してください。',422);}demand(/^Encrypted:\s+no\b/m.test(info.stdout)&&/^Pages:\s+[1-9]\d*\s*$/m.test(info.stdout),'INVALID_PDF','暗号化されていない、ページを持つPDFを選んでください。',422);return {mime_type:mime,duration_s:null,has_audio:false,page_count:Number(/^Pages:\s+(\d+)/m.exec(info.stdout)[1])};}
    demand(mime==='video/mp4','UNSUPPORTED_MEDIA','MP4またはPDFを指定してください。',415);
    const p=await this.probe(file),timeline=videoTimeline(p),video=p.streams.find(s=>s.codec_type==='video'),containerDuration=finite(p.format?.duration);
    demand(p.format?.format_name?.split(',').includes('mp4')&&Number.isFinite(timeline.duration_s)&&timeline.duration_s>0,'INVALID_VIDEO','有効なMP4動画を選んでください。',422);
    return {mime_type:'video/mp4',duration_s:timeline.duration_s,container_duration_s:containerDuration,has_audio:p.streams.some(s=>s.codec_type==='audio'),start_time_s:timeline.start_time_s,width:video.width,height:video.height,video_timeline:timeline};
  }
  async register(request,mime,displayName) {
    demand(Number.isFinite(this.config.maxUploadBytes)&&this.config.maxUploadBytes>0&&Number.isFinite(this.config.minFreeBytes)&&this.config.minFreeBytes>0,'STORAGE_LIMITS_REQUIRED','受信上限と空き容量条件を設定してください。');
    const assetId=id(),ref=`media/${assetId}/source.bin`,partial=`media/${assetId}/upload.partial`;const file=this.store.resolve(partial);
    await fs.mkdir(path.dirname(file),{recursive:true});
    const h=await fs.open(file,'wx');let size=0;const hash=crypto.createHash('sha256');let pendingSpaceCheck=0;
    try {
      for await(const chunk of request) {
        size+=chunk.length;demand(size<=this.config.maxUploadBytes,'UPLOAD_TOO_LARGE','受信上限を超えました。小さいファイルを選んでください。',413);
        if(size>=pendingSpaceCheck){const disk=await fs.statfs(this.store.root);demand(Number(disk.bavail)*Number(disk.bsize)-chunk.length>=this.config.minFreeBytes,'INSUFFICIENT_STORAGE','保存先の空き容量を確保してください。',507);pendingSpaceCheck=size+8*1024*1024;}
        await h.write(chunk);hash.update(chunk);
      }
      demand(size>0,'EMPTY_MEDIA','0バイトのファイルは登録できません。'); await h.sync(); await h.close();
      const info=await this.inspect(file,mime);await fs.rename(file,this.store.resolve(ref));
      const asset={asset_id:assetId,video_id:assetId,asset_ref:ref,sha256:hash.digest('hex'),size_bytes:size,display_name:String(displayName||'登録媒体').slice(0,200),created_at:now(),synthetic:false,...info};
      await this.store.immutable(`media/${assetId}/asset.json`,asset);return asset;
    } catch(e){await h.close().catch(()=>{});await fs.rm(file,{force:true}).catch(()=>{});throw e;}
  }
  async prepare(asset,settings,runId,cleanup,signal) {
    const source=this.store.resolve(asset.asset_ref);demand(await this.store.exists(asset.asset_ref),'INPUT_UNAVAILABLE','常設動画が見つかりません。再登録してください。',404);
    demand(await hashFile(source)===asset.sha256,'INPUT_HASH_CHANGED','登録後に動画のバイトが変わっています。再登録してください。',409);
    const sourceInfo=await this.inspect(source,'video/mp4'),versions=await this.versions();
    if(settings.audio_enabled) {const transform={version:'original-audio.v2',tools:versions,args:[],timeline_validation:'primary-video-stream.v1'};return {...asset,...sourceInfo,source_sha256:asset.sha256,preprocess_version:sha256(transform),transform};}
    const ref=`temporary/${runId}/${id()}.mp4`;await fs.mkdir(path.dirname(this.store.resolve(ref)),{recursive:true});
    const entry=await cleanup.registerLocal(ref,runId);
    const args=['-nostdin','-v','error','-i',source,'-map','0:v:0','-c:v','copy','-an','-map_metadata','-1','-map_chapters','-1','-y',this.store.resolve(ref)];
    await this.command(this.config.ffmpeg,args,signal);const info=await this.inspect(this.store.resolve(ref),'video/mp4');
    if(info.has_audio||!sameVideoTimeline(sourceInfo,info))throw fault('PREPROCESS_TIME_CHANGED','音声除去後に映像ストリームの時刻原点・動画長が変わりました。',422,{source:sourceInfo.video_timeline,submitted:info.video_timeline});
    const hash=await hashFile(this.store.resolve(ref));await cleanup.update(entry.asset_id,{content_sha256:hash,generation:'local'});
    const publicArgs=['-map','0:v:0','-c:v','copy','-an','-map_metadata','-1','-map_chapters','-1'];
    const transform={version:'strip-audio.v2',tools:versions,args:publicArgs,timeline_validation:'primary-video-stream.v1'};
    return {...asset,...info,asset_ref:ref,size_bytes:(await fs.stat(this.store.resolve(ref))).size,sha256:hash,source_sha256:asset.sha256,preprocess_version:sha256(transform),transform,cleanup_asset_id:entry.asset_id};
  }
  async extractFrames({asset,gt,setId,sourceId=null,exampleIds,signal}) {
    const source=this.store.resolve(asset.asset_ref),versions=await this.versions();
    const r=await this.command(this.config.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',source],signal);
    const frames=JSON.parse(r.stdout).frames.map((f,index)=>({index,time:Number(f.best_effort_timestamp_time)-(asset.start_time_s||0)})).filter(f=>Number.isFinite(f.time));
    const selections=[];
    for(const s of gt.segments) {
      const inRange=frames.filter(f=>f.time>=s.start_s&&f.time<s.end_s);demand(inRange.length,'FRAME_EXTRACTION_FAILED','区間内に抽出可能なフレームがありません。',422);
      const used=new Set();
      for(const portion of [.2,.5,.8]) { const requested=Number((s.start_s+portion*(s.end_s-s.start_s)).toFixed(9));const f=inRange.find(f=>f.time>=requested)??inRange.at(-1);if(used.has(f.index))continue;used.add(f.index);selections.push({s,requested,f}); }
    }
    demand(sourceId===null || /^[a-zA-Z0-9-]+$/.test(sourceId),'INVALID_SOURCE_ID','お手本の参照IDが不正です。');
    const indices=[...new Set(selections.map(x=>x.f.index))].sort((a,b)=>a-b);const dir=`standard-sets/${setId}/frames${sourceId?`/${sourceId}`:''}`;await fs.mkdir(this.store.resolve(dir),{recursive:true});
    const select=indices.map(i=>`eq(n\\,${i})`).join('+');
    const filter=`select=${select},scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease`;
    const args=['-nostdin','-v','error','-i',source,'-map','0:v:0','-vf',filter,'-vsync','vfr','-q:v','2','-map_metadata','-1','-map_chapters','-1','-an','-y',this.store.resolve(dir+'/%06d.jpg')];
    await this.command(this.config.ffmpeg,args,signal);
    const images=[];
    for(const x of selections) {
      const asset_ref=`${dir}/${String(indices.indexOf(x.f.index)+1).padStart(6,'0')}.jpg`;const p=await this.probe(this.store.resolve(asset_ref));const stream=p.streams[0];
      demand(stream.codec_name==='mjpeg'&&stream.width<=768&&stream.height<=768,'INVALID_IMAGE','代表画像の形式・サイズが不正です。',422);
      images.push({image_id:id(),standard_set_id:setId,source_video_id:asset.video_id,source_video_sha256:asset.sha256,gt_version:gt.gt_version,gt_process_id:x.s.gt_process_id,segment_id:x.s.segment_id,example_id:exampleIds[x.s.segment_id],requested_time_s:x.requested,extracted_time_s:x.f.time,selection_rule_version:'uniform3.v1',transform_version:'jpeg768.v1',width:stream.width,height:stream.height,size_bytes:(await fs.stat(this.store.resolve(asset_ref))).size,mime_type:'image/jpeg',sha256:await hashFile(this.store.resolve(asset_ref)),asset_ref,created_at:now()});
    }
    return {images,tools:versions,settings:{selection:'uniform3.v1',transform:'jpeg768.v1',quality:2,filter,arguments:args.map(a=>a===source?'SOURCE_VIDEO':a===this.store.resolve(dir+'/%06d.jpg')?'OUTPUT/%06d.jpg':a)}};
  }
  async experimentalWindow(asset,unit,runId,cleanup,signal) {
    demand(this.config.mockMode&&asset.synthetic===true,'EXPERIMENT_SYNTHETIC_ONLY','PTS実験は合成モック専用です。');
    const source=this.store.resolve(asset.asset_ref),origin=asset.start_time_s??0;
    const probe=async file=>{const data=JSON.parse((await this.command(this.config.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_streams','-show_entries','frame=best_effort_timestamp,pkt_duration:stream=time_base','-of','json',file],signal)).stdout),base=timeBaseSeconds(data.streams?.[0]?.time_base);demand(base>0,'EXPERIMENT_PTS_UNSUPPORTED','原本time_baseが不明です。');const pts=data.frames.map(f=>Number(f.best_effort_timestamp)),times=pts.map(p=>p*base);times.native_pts=pts;times.frame_durations=data.frames.map(f=>Number(f.pkt_duration)*base);times.time_base_s=base;return times;};
    const timestamps=await probe(source);
    demand(timestamps.length>=2&&timestamps.every((t,i)=>Number.isFinite(t)&&timestamps.frame_durations[i]>0&&(!i||t>timestamps[i-1]&&Math.abs(t-timestamps[i-1]-timestamps.frame_durations[i-1])<=.001)),'EXPERIMENT_PTS_UNSUPPORTED','原本PTSの非単調・不連続またはフレーム時間不足は未対応です。');
    demand(Math.abs(timestamps[0]-origin)<=.001&&Math.abs(timestamps.at(-1)+timestamps.frame_durations.at(-1)-origin-asset.duration_s)<=.001,'EXPERIMENT_PTS_UNSUPPORTED','原本PTSの原点・末尾が動画長と一致しません。');
    const selectedIndices=timestamps.flatMap((t,i)=>t-origin>=unit.window_start_s&&t-origin<unit.window_end_s?[i]:[]),selected=selectedIndices.map(i=>timestamps[i]);
    demand(selected.length>=2&&selected.every((t,i)=>Number.isFinite(t)&&(!i||t>selected[i-1])),'EXPERIMENT_PTS_UNSUPPORTED','フレーム不足またはPTS非単調です。');
    const ref=`temporary/${runId}/${id()}.mp4`;await fs.mkdir(path.dirname(this.store.resolve(ref)),{recursive:true});const entry=await cleanup.registerLocal(ref,runId);
    const filter=`trim=start=${unit.window_start_s}:end=${unit.window_end_s},setpts=PTS-STARTPTS`;
    await this.command(this.config.ffmpeg,['-nostdin','-v','error','-i',source,'-map','0:v:0','-vf',filter,'-vsync','0','-c:v','libx264','-an','-map_metadata','-1','-y',this.store.resolve(ref)],signal);
    const derived=await probe(this.store.resolve(ref)),info=await this.inspect(this.store.resolve(ref),'video/mp4');
    demand(derived.length===selected.length&&derived.every((t,i)=>Math.abs((t-derived[0])-(selected[i]-selected[0]))<=.001),'EXPERIMENT_PTS_UNSUPPORTED','派生映像のPTS対応が一致しません。');
    const actualStart=selected[0]-origin,expectedEnd=actualStart+info.duration_s;
    demand(Math.abs(expectedEnd-unit.window_end_s)<=.001,'EXPERIMENT_PTS_UNSUPPORTED','切出し末尾と原本時刻が一致しません。');
    const hash=await hashFile(this.store.resolve(ref));await cleanup.update(entry.asset_id,{content_sha256:hash,generation:'local'});
    const samples=selectedIndices.map((sourceIndex,i)=>({local_s:derived[i]-derived[0],pts:timestamps.native_pts[sourceIndex],derived_pts:derived.native_pts[i]}));samples.push({local_s:info.duration_s,pts:(origin+expectedEnd)/timestamps.time_base_s,boundary_sentinel:true});
    const timeline={version:'pts-map.v1',clock:'derived_seconds',time_base_s:timestamps.time_base_s,derived_time_base_s:derived.time_base_s,source_stream:0,origin_s:origin,samples,validation:'all-frame-timestamp-deltas.v1',source_validation:'all-frame-contiguous-durations.v1',source_frame_count:timestamps.length,derived_frame_count:derived.length,requested_start_s:unit.window_start_s,requested_end_s:unit.window_end_s,actual_start_s:actualStart,actual_end_s:expectedEnd,source_sha256:asset.source_sha256??asset.sha256,derived_sha256:hash,transform:{version:'trim-pts.v1',filter,arguments:['-map','0:v:0','-vf',filter,'-vsync','0','-c:v','libx264','-an','-map_metadata','-1'],tools:await this.versions()}};
    return {video:{...asset,...info,asset_ref:ref,sha256:hash,size_bytes:(await fs.stat(this.store.resolve(ref))).size,cleanup_asset_id:entry.asset_id},timeline};
  }
  async syntheticVideo(duration=30,name='合成テスト動画') {
    const assetId=id(),ref=`media/${assetId}/source.mp4`;await fs.mkdir(path.dirname(this.store.resolve(ref)),{recursive:true});
    await this.command(this.config.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',`testsrc2=size=480x270:rate=10:duration=${duration}`,'-c:v','libx264','-pix_fmt','yuv420p','-an','-movflags','+faststart','-y',this.store.resolve(ref)]);
    const info=await this.inspect(this.store.resolve(ref),'video/mp4');const asset={asset_id:assetId,video_id:assetId,asset_ref:ref,sha256:await hashFile(this.store.resolve(ref)),size_bytes:(await fs.stat(this.store.resolve(ref))).size,display_name:name,created_at:now(),synthetic:true,...info};await this.store.immutable(`media/${assetId}/asset.json`,asset);return asset;
  }
  async recoverPartials() {for(const assetId of await this.store.list('media')) {const partial=`media/${assetId}/upload.partial`;if(await this.store.exists(partial))await fs.rm(this.store.resolve(partial),{force:true});}}
}
