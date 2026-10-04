import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const FEATURES=Object.freeze(['observation-review-cycle.v1','review-derived-standard.v1','task-alignment.v1']);
export function implementationFingerprint(root=ROOT){
  const files=[];
  function walk(relative){const full=path.join(root,relative);for(const entry of fs.readdirSync(full,{withFileTypes:true})){const name=relative+'/'+entry.name;if(entry.isDirectory())walk(name);else if(entry.isFile()&&/\.(js|json|md|html|css|svg)$/.test(name))files.push(name);}}
  for(const directory of ['src','public','prompts'])walk(directory);
  files.push('server.js','package.json');
  const hash=crypto.createHash('sha256');for(const file of files.sort()){hash.update(file+'\0');hash.update(fs.readFileSync(path.join(root,file)));hash.update('\0');}return hash.digest('hex');
}
// Capture once when backend modules load. Never claim new disk code is executing.
export const STARTUP_FINGERPRINT=implementationFingerprint();
// Runtime failures (missing, unreadable or being replaced) mean assets cannot
// be verified. Keep startup computation strict and its captured identity fixed.
export function implementationAssetsConsistent(){
  try{return implementationFingerprint()===STARTUP_FINGERPRINT;}
  catch{return false;}
}
