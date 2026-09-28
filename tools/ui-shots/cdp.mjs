// Minimal Chrome DevTools Protocol client: headless Chrome with a throwaway profile in the OS temp folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    ws.onerror = () => reject(new Error('Chrome への接続に失敗しました。'));
    ws.onclose = () => { for (const { fail } of pending.values()) fail(new Error('Chrome との接続が切れました。')); pending.clear(); };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.fail(new Error(`${entry.method}: ${message.error.message}`));
        else entry.done(message.result);
      } else for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    };
    ws.onopen = () => resolve({
      send(method, params = {}, timeoutMs = 30000) {
        return new Promise((done, fail) => {
          const id = ++nextId;
          const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method}: 応答がありません（${timeoutMs}ms）`)); }, timeoutMs);
          pending.set(id, { method, done, fail, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, listener) {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
        return () => listeners.get(method).delete(listener);
      },
      close() { ws.close(); },
    });
  });
}

async function waitFor(read, timeoutMs, message, failure) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (failure()) throw failure();
    const value = await read().catch(() => null);
    if (value) return value;
    await sleep(150);
  }
  throw new Error(message);
}

export async function launchChrome(chromePath) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-shots-'));
  const proc = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--mute-audio',
    '--force-device-scale-factor=1', '--lang=ja-JP', 'about:blank',
  ], { stdio: 'ignore' });
  let startError = null;
  proc.once('error', (error) => { startError = new Error(`Chrome を起動できません: ${error.message}`); });
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  const removeProfile = () => fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  const failure = () => startError;
  try {
    const port = await waitFor(async () => Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || null,
      20000, 'Chrome が起動しませんでした（DevToolsActivePort が作られません）。', failure);
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'),
      10000, 'Chrome のページに接続できませんでした。', failure);
    const session = await connect(target.webSocketDebuggerUrl);
    return {
      session,
      async close() {
        await session.send('Browser.close', {}, 5000).catch(() => {});
        session.close();
        await Promise.race([exited, sleep(5000)]);
        if (proc.exitCode === null) proc.kill();
        await removeProfile();
      },
    };
  } catch (error) {
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    await removeProfile();
    throw error;
  }
}
