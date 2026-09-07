import fs from 'node:fs/promises';
import path from 'node:path';
import { id, canonicalJSON, fault, demand, delay } from './core.js';

export class LocalStore {
  constructor(root) { this.root = path.resolve(root); }
  resolve(ref) {
    demand(typeof ref === 'string' && !ref.includes('\\') && !ref.split('/').some(p=>p==='..'||p==='.') && !path.isAbsolute(ref), 'INVALID_REFERENCE','保存参照が不正です。');
    const resolved = path.resolve(this.root, ref);
    demand(resolved.startsWith(this.root + path.sep), 'INVALID_REFERENCE','保存先の範囲外です。');
    return resolved;
  }
  async init() { await fs.mkdir(this.root,{recursive:true}); await this.write('health/write-check.json',{ok:true}); }
  async read(ref, fallback = undefined) {
    try { return JSON.parse(await fs.readFile(this.resolve(ref),'utf8')); }
    catch(e) { if(e.code==='ENOENT' && fallback!==undefined) return fallback; throw e; }
  }
  async write(ref, value) {
    const dest=this.resolve(ref); await fs.mkdir(path.dirname(dest),{recursive:true});
    const temp=dest+'.'+id()+'.tmp';
    const h=await fs.open(temp,'wx');
    try { await h.writeFile(canonicalJSON(value)+'\n','utf8'); await h.sync(); } finally { await h.close(); }
    for(let attempt=0;;attempt++) {
      try {await fs.rename(temp,dest);break;}
      catch(e) {if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt===7)throw e;await delay(10*(attempt+1));}
    }
  }
  async immutable(ref,value) {
    // Publish a fully flushed temporary file by hard link: exclusive destination,
    // no partially written immutable result can be mistaken for committed output.
    const dest=this.resolve(ref); await fs.mkdir(path.dirname(dest),{recursive:true});
    const temp=dest+'.'+id()+'.tmp'; const h=await fs.open(temp,'wx');
    try { await h.writeFile(canonicalJSON(value)+'\n','utf8'); await h.sync(); } finally { await h.close(); }
    try { await fs.link(temp,dest); } finally { await fs.rm(temp,{force:true}); }
  }
  async list(ref) { try { return (await fs.readdir(this.resolve(ref),{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort(); } catch(e) { if(e.code==='ENOENT') return []; throw e; } }
  async exists(ref) { try { await fs.access(this.resolve(ref)); return true; } catch { return false; } }
  async version(namespace,version,hash) {
    const key=Buffer.from(namespace+':'+version).toString('hex');
    const prior=await this.read(`versions/${key}.json`,null);
    demand(!prior || prior.sha256===hash,'VERSION_HASH_CONFLICT','同じ版で内容が変更されています。新版を発行してください。',409);
    if(!prior) await this.immutable(`versions/${key}.json`,{namespace,version,sha256:hash});
  }
  async acquire() {
    const ref='worker.lock'; const lock=this.resolve(ref);
    try { const h=await fs.open(lock,'wx'); await h.writeFile(JSON.stringify({pid:process.pid})); await h.close(); this.locked=true; }
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      const previous=await this.read(ref,null); let alive=false;
      if(previous?.pid) { try { process.kill(previous.pid,0); alive=true; } catch(err) { alive=err.code==='EPERM'; } }
      if(alive) throw fault('DATA_ROOT_IN_USE','この保存先は別サーバーが使用中です。',409);
      await fs.rm(lock,{force:true}); return this.acquire();
    }
  }
  async release() { if(this.locked) { await fs.rm(this.resolve('worker.lock'),{force:true}); this.locked=false; } }
}
export function safeId(value) { demand(typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value),'INVALID_ID','登録済みIDを指定してください。'); return value; }
