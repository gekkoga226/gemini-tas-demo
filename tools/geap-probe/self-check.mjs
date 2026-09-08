// CLI entry point; filename is excluded from node --test discovery.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {id,sha256} from '../../src/core.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const files=['test/fewshot.test.js','test/assets.test.js','test/scoring.test.js','test/evaluation.test.js','test/failure-paths.test.js','test/geap-adapter.test.js','test/cost.test.js'];
const report={schema_version:'geap-local-acceptance.v1',run_id:id(),created_at:new Date().toISOString(),data_origin:'synthetic_local_tests',external_api_calls:0,real_checks:Object.fromEntries(Array.from({length:12},(_,i)=>[i,'NOT_RUN'])),coverage:['six_conditions','GT_isolation','stage1_sharing','immutable_times','raw_confidence','fixed_discover_schemas','persistent_jobs','disconnect','cancel','restart','retry_429_500_401','timeout_unknown','cleanup_403_grace_session','PDF_review','image_provenance','cache_migration','raw_safety_rederive','Checks_7_to_11_scoring'],node:process.version,hashes:{}};
for(const file of files)report.hashes[file]=sha256(await fs.readFile(path.join(root,file)));
try{const output=await promisify(execFile)(process.execPath,['--test',...files],{cwd:root,windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});report.status='LOCAL_TESTS_PASSED';report.output=output.stdout+output.stderr;}catch(e){report.status='LOCAL_TESTS_FAILED';report.output=(e.stdout||'')+(e.stderr||'');process.exitCode=1;}
const dir=path.join(root,'tools/geap-probe/runs',report.run_id);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'local-acceptance.json'),JSON.stringify(report,null,2)+'\n');console.log(report.status);console.log(`Local evidence (no real measurement): ${path.join(dir,'local-acceptance.json')}`);
