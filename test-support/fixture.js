import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {TasService} from '../src/pipeline.js';
import {tasConfig} from '../src/settings.js';
import {delay} from '../src/core.js';
export async function waitRun(service,runId){for(let n=0;n<1500;n++){const r=await service.status(runId);if(['succeeded','failed','cancelled','interrupted','awaiting_approval'].includes(r.status))return r;await delay(20);}throw new Error('local job timeout');}
export async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'tas-round18-'));const config={...tasConfig({MOCK_MODE:'true'}),dataRoot:root,mockDelayMs:10,allowFaults:true};const service=new TasService(config);await service.ready;t.after(()=>service.close());const demo=await service.demo();const r=await waitRun(service,demo.run_id);assert.equal(r.status,'awaiting_approval',JSON.stringify(r.error));await service.approve(demo.standard_set_id,'local-test');return {service,config,demo};}
