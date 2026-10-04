import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

async function copy(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tas-assets-regression-'));
  for(const directory of ['src','public','prompts'])await fs.cp(new URL(`../${directory}`,import.meta.url),path.join(root,directory),{recursive:true});
  for(const file of ['server.js','package.json'])await fs.copyFile(new URL(`../${file}`,import.meta.url),path.join(root,file));
  return root;
}

test('post-start missing, unreadable and temporarily replaced assets preserve the child server and startup identity',async t=>{
  const root=await copy();
  const program=`
    import fs from 'node:fs';
    const {createAppServer}=await import(${JSON.stringify(pathToFileURL(path.join(root,'server.js')).href)});
    const server=createAppServer({mockMode:true,port:0,dataRoot:${JSON.stringify(path.join(root,'empty-data'))}});
    const read=fs.readFileSync;
    process.on('message',message=>{
      if(message==='deny')fs.readFileSync=function(file,...args){if(file===${JSON.stringify(path.join(root,'package.json'))})throw Object.assign(Error('isolated read denied'),{code:'EACCES'});return read.call(this,file,...args);};
      if(message==='restore')fs.readFileSync=read;
      process.send({ack:message});
    });
    server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await fs.rm(root,{recursive:true,force:true,maxRetries:5});});
  const first=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error(`child exited ${code}: ${stderr}`);})]);
  const base=`http://127.0.0.1:${first[0].port}`;
  const health=async()=>{const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return response.json();};
  const before=await health();assert.equal(before.implementation.assets_consistent,true);
  const check=async consistent=>{
    const current=await health();assert.equal(current.launcher.pid,before.launcher.pid);assert.equal(current.implementation.fingerprint,before.implementation.fingerprint);assert.equal(current.implementation.assets_consistent,consistent);assert.equal(child.exitCode,null);
    if(!consistent)for(const route of ['/','/analysis.html','/fewshot.js','/api/session','/api/config']){const response=await fetch(base+route,{signal:AbortSignal.timeout(5000)});assert.equal(response.status,409,route);assert.equal((await response.json()).code,'IMPLEMENTATION_CHANGED');}
  };
  const packageFile=path.join(root,'package.json'),backup=packageFile+'.backup';
  await fs.rename(packageFile,backup);await check(false);
  await fs.rename(backup,packageFile);await check(true);
  // Deterministic EACCES injection is confined to this child; no host ACL changes.
  for(const message of ['deny','restore']){const ack=once(child,'message');child.send(message);assert.equal((await ack)[0].ack,message);await check(message==='restore');}
  // An actual filesystem read error during replacement, followed by recovery.
  await fs.rename(packageFile,backup);await fs.mkdir(packageFile);await check(false);
  await fs.rmdir(packageFile);await fs.rename(backup,packageFile);await check(true);
  const asset=path.join(root,'public','analysis.html');await fs.appendFile(asset,'\n<!-- isolated content change -->');await check(false);
  assert.equal(stderr,'');
});

test('missing required asset at startup still prevents backend initialization',async t=>{
  const root=await copy();t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));await fs.rename(path.join(root,'package.json'),path.join(root,'package.json.backup'));
  const program=`await import(${JSON.stringify(pathToFileURL(path.join(root,'src/implementation.js')).href)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const [code]=await once(child,'exit');assert.notEqual(code,0);assert.match(stderr,/ENOENT/);
});
