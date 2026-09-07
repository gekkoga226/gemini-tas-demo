import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createAppServer,loadConfig} from '../server.js';
import {TasService} from '../src/pipeline.js';
import {tasConfig,defaultSettings} from '../src/settings.js';
import {prepareConnectivityInputs} from '../tools/prepare-connectivity-inputs.mjs';
import {waitRun} from '../test-support/fixture.js';
import {id} from '../src/core.js';

test('connectivity inputs register into an empty store with valid matching GT and no model results',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tas-connectivity-'));
  const config={...tasConfig({MOCK_MODE:'true'}),dataRoot:path.join(root,'data'),mockDelayMs:1};
  const service=new TasService(config);await service.ready;t.after(()=>service.close());
  const app=createAppServer({...loadConfig({}),...config,port:0},{tasService:service});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>app.close());
  const inputs=path.join(root,'inputs');
  const prepared=await prepareConnectivityInputs(`http://127.0.0.1:${app.address().port}`,inputs);
  assert.equal(prepared.standard.duration_s,24);assert.equal(prepared.actual.duration_s,30);
  assert.deepEqual(await service.history(),[]);assert.deepEqual(await service.store.list('standard-sets'),[]);
  const read=name=>fs.readFile(path.join(inputs,name),'utf8').then(JSON.parse);
  const gt=await read('standard-gt.json');assert.equal(gt.video_id,prepared.standard.video_id);
  const vocabulary=await read('vocabulary.json'),discriminators=await read('discriminators.json');
  const v=await service.registerVocabulary(vocabulary,discriminators,{approved_by:'local-test'});
  const g=await service.registerGT(gt),settings=defaultSettings(config);
  const build=await service.createStandard({client_request_id:id(),name:'合成・接続確認',source_video_id:prepared.standard.video_id,build_gt_asset_id:g.build_gt_asset_id,vocabulary_ref:v.ref,profiles:['unguided'],generate_images:false,settings,consent_confirmed:true});
  assert.equal((await waitRun(service,build.run_id)).status,'awaiting_approval');await service.approve(build.standard_set_id,'local-test');
  for(const mode of ['few_shot','zero_shot']){
    const run=await service.createAnalysis({client_request_id:id(),input_video_id:prepared.actual.video_id,standard_set_id:build.standard_set_id,analysis_strategy:'text_only',analysis_mode:mode,settings,consent_confirmed:true});
    assert.equal((await waitRun(service,run.run_id)).status,'succeeded');
  }
});

test('connectivity preparation rejects external destinations before doing work',async()=>{
  await assert.rejects(prepareConnectivityInputs('https://example.com'),/127.0.0.1/);
});
