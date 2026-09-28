import test from 'node:test';
import assert from 'node:assert/strict';
import {id} from '../src/core.js';
import {MediaTools} from '../src/media.js';
import {defaultSettings} from '../src/settings.js';
import {fixture} from '../test-support/fixture.js';

test('media inspection uses the primary video stream instead of a longer MP4 container',async()=>{
  const media=new MediaTools({},null);
  media.probe=async()=>({format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',start_time:'0.000000',duration:'50.043000'},streams:[
    {codec_type:'video',codec_name:'h264',width:1920,height:1080,time_base:'1/15360',start_pts:0,start_time:'0.000000',duration_ts:768000,duration:'50.000000',nb_frames:'1500'},
    {codec_type:'audio',codec_name:'aac',start_time:'0.000000',duration:'50.000000'}
  ]});
  const info=await media.inspect('unused.mp4','video/mp4');
  assert.equal(info.duration_s,50);
  assert.equal(info.container_duration_s,50.043);
  assert.equal(info.start_time_s,0);
  assert.equal(info.video_timeline.frame_count,1500);
  assert.equal(info.has_audio,true);
});

test('primary video stream defines analysis time and legacy container duration does not break audio stripping',async t=>{
  const {service,config}=await fixture(t),source=await service.media.syntheticVideo(1,'timeline source');
  const {video_timeline,...withoutTimeline}=source,legacyId=id();
  const legacy={...withoutTimeline,asset_id:legacyId,video_id:legacyId,duration_s:source.duration_s+.043,start_time_s:source.start_time_s+.01};
  await service.store.write(`media/${legacyId}/asset.json`,legacy);

  const normalized=await service.getMedia(legacyId);
  assert.equal(normalized.duration_s,source.duration_s);
  assert.equal(normalized.start_time_s,source.start_time_s);
  assert.equal(normalized.video_timeline.version,'primary-video-stream.v1');

  const runId=id(),prepared=await service.media.prepare(legacy,{...defaultSettings(config),audio_enabled:false},runId,service.cleanup);
  assert.equal(prepared.duration_s,source.duration_s);
  assert.equal(prepared.start_time_s,source.start_time_s);
  assert.equal(prepared.has_audio,false);
  assert.equal(prepared.video_timeline.frame_count,source.video_timeline.frame_count);
  assert.equal(prepared.transform.version,'strip-audio.v2');
  assert.equal(prepared.transform.timeline_validation,'primary-video-stream.v1');
  await service.cleanup.releaseRun(runId);await service.cleanup.sweep();
});

test('audio stripping still fails when the primary video stream timeline actually changes',async t=>{
  const {service,config}=await fixture(t),source=await service.media.syntheticVideo(1,'changed timeline source');
  const inspect=service.media.inspect.bind(service.media);let inspection=0;
  service.media.inspect=async(...args)=>{
    const info=await inspect(...args);inspection++;
    return inspection===2?{...info,duration_s:info.duration_s+.01,video_timeline:{...info.video_timeline,duration_s:info.video_timeline.duration_s+.01}}:info;
  };
  const runId=id();
  await assert.rejects(service.media.prepare(source,{...defaultSettings(config),audio_enabled:false},runId,service.cleanup),error=>error.code==='PREPROCESS_TIME_CHANGED'&&error.details.source.duration_s===1&&error.details.submitted.duration_s===1.01);
  await service.cleanup.releaseRun(runId);await service.cleanup.sweep();
});
