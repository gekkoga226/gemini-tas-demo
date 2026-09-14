import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStage1} from '../src/contracts.js';

// 2026-09-12の実接続測定で観測した実モデルの形。音声なし入力に対し audio_cues を
// not_applicable としつつ unobserved_occlusions には記載しない。仕様5.2.1の改訂により有効。
function fixedOutput({audioOccluded=false,unknownOccluded=true}={}) {
  const evidence=[{evidence_id:'e1',source:'video',start_s:0,end_s:1,description:'対象物が映る。'}];
  const observed={status:'observed',value:'説明',evidence_ids:['e1']};
  const occlusions=[];
  if(unknownOccluded)occlusions.push({field:'state_after',reason:'手で隠れて確認できない。',evidence_ids:[]});
  if(audioOccluded)occlusions.push({field:'audio_cues',reason:'音声なしの入力条件',evidence_ids:[]});
  return {schema_version:'stage1.fixed.v1',observations:[{segment_id:'seg-0001',observation:{
    objects_parts:observed,work_location_fixture:observed,tools_held:observed,operation:observed,
    state_before:observed,
    state_after:{status:'unknown',value:null,evidence_ids:[]},
    audio_cues:{status:'not_applicable',value:null,evidence_ids:[]},
    unobserved_occlusions:occlusions,insufficient_discriminative_features:false,insufficiency_reasons:[],evidence}}]};
}
const boundaries=[{segment_id:'seg-0001',start_s:0,end_s:10}];
const opts={duration_s:10,audio_enabled:false,boundaries};

test('not_applicableはunobserved_occlusions未記載でも通る', () => {
  assert.doesNotThrow(() => validateStage1(fixedOutput(),opts));
});

test('not_applicableを記載しても従来どおり通る', () => {
  assert.doesNotThrow(() => validateStage1(fixedOutput({audioOccluded:true}),opts));
});

test('unknownは従来どおり理由の記載が必要', () => {
  assert.throws(() => validateStage1(fixedOutput({unknownOccluded:false}),opts),
    e => e.code==='INVALID_STAGE1' && /state_after/.test(e.message));
});

test('音声なしでaudio_cuesがobservedなら従来どおり不正', () => {
  const out=fixedOutput();
  out.observations[0].observation.audio_cues={status:'observed',value:'打音',evidence_ids:['e1']};
  assert.throws(() => validateStage1(out,opts), e => e.code==='INVALID_STAGE1' && /audio_cues/.test(e.message));
});
