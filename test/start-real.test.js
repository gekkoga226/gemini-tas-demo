import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
async function fixture(kind, port) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tas-launch real-'));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.copyFile(new URL('../start-app-real.bat', import.meta.url), path.join(root, 'start-app-real.bat'));
  await fs.copyFile(new URL('../scripts/start-real.ps1', import.meta.url), path.join(root, 'scripts/start-real.ps1'));
  await fs.writeFile(path.join(root, 'bin/gcloud.cmd'), '@exit /b 0\r\n');
  await fs.writeFile(path.join(root, 'server.js'), `require('fs').writeFileSync('launched.json',JSON.stringify({mode:process.env.MOCK_MODE,port:process.env.PORT,data:process.env.DATA_ROOT,cwd:process.cwd()}));`);
  if (kind === 'env') {
    await fs.writeFile(path.join(root, 'real-connection.env'), `MOCK_MODE=true\nPORT=${port}\nDATA_ROOT=must-not-use\nGEAP_ENVIRONMENT_CONFIRMED=true\n`);
  } else {
    await fs.mkdir(path.join(root, '.local-validation'));
    await fs.writeFile(path.join(root, '.local-validation/connectivity-env.ps1'), `$env:MOCK_MODE='true'\n$env:PORT='${port}'\n$env:DATA_ROOT='must-not-use'\n$env:GEAP_ENVIRONMENT_CONFIRMED='true'\n`);
  }
  const env = {...process.env, PATH: `${path.dirname(process.execPath)};${path.join(root, 'bin')};${process.env.PATH}`, GEAP_AUTH_MODE: 'gcloud', DATA_ROOT: '', PORT: ''};
  return {root, env};
}
async function listening() {
  const server = net.createServer(socket => socket.end('still alive'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
for (const kind of ['env', 'legacy']) {
  test(`real launcher preserves an occupied port and fails before starting (${kind})`, {skip: process.platform !== 'win32'}, async t => {
    const server = await listening();
    t.after(() => new Promise(resolve => server.close(resolve)));
    const {root, env} = await fixture(kind, server.address().port);
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    await assert.rejects(exec('cmd.exe', ['/d', '/c', 'start-app-real.bat'], {cwd: root, env, windowsHide: true, timeout: 15000}), error => error.code === 1 && /Port \d+ is unavailable/.test(error.stderr));
    assert.equal(server.listening, true);
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      socket.on('error', reject);
      socket.once('data', data => {socket.destroy(); resolve(data.toString());});
    });
    assert.equal(response, 'still alive');
    await assert.rejects(fs.access(path.join(root, 'launched.json')));
  });
  test(`real launcher honors isolated caller data/port and forces real mode (${kind})`, {skip: process.platform !== 'win32'}, async t => {
    const busy = await listening();
    t.after(() => new Promise(resolve => busy.close(resolve)));
    const free = await listening();
    const port = free.address().port;
    await new Promise(resolve => free.close(resolve));
    const {root, env} = await fixture(kind, busy.address().port);
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const data = path.join(root, 'isolated data');
    await exec('cmd.exe', ['/d', '/c', 'start-app-real.bat'], {cwd: root, env: {...env, PORT: String(port), DATA_ROOT: data}, windowsHide: true, timeout: 15000});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'launched.json'), 'utf8')), {mode: 'false', port: String(port), data, cwd: root});
    assert.equal(busy.listening, true);
  });
}

for (const mismatch of [null, 'workspace', 'data', 'pid', 'mode']) {
  test(`reusing a REAL server requires matching workspace, data root and worker (${mismatch || 'matching'})`, {skip: process.platform !== 'win32'}, async t => {
    const {root, env} = await fixture('env', 1);
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const data = path.join(root, 'isolated data');
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, 'worker.lock'), JSON.stringify({pid: process.pid}));
    const hash = value => crypto.createHash('sha256').update(value.toLowerCase()).digest('hex');
    const identity = {pid: process.pid, workspace_sha256: hash(root), data_root_sha256: hash(data)};
    if (mismatch === 'workspace') identity.workspace_sha256 = hash(root + '-old-checkout');
    if (mismatch === 'data') identity.data_root_sha256 = hash(data + '-other-data');
    if (mismatch === 'pid') identity.pid += 1;
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({mode: mismatch === 'mode' ? 'mock' : 'geap', launcher: identity}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const launch = exec('cmd.exe', ['/d', '/c', 'start-app-real.bat -ReuseExisting'], {cwd: root, env: {...env, PORT: String(server.address().port), DATA_ROOT: data}, windowsHide: true, timeout: 15000});
    if (mismatch) await assert.rejects(launch, error => error.code === 1 && /unavailable/.test(error.stderr));
    else assert.match((await launch).stdout, /Using the existing REAL server/);
    assert.equal(server.listening, true);
    await assert.rejects(fs.access(path.join(root, 'launched.json')));
  });
}
