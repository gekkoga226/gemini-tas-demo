import crypto from 'node:crypto';

export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const clone = value => structuredClone(value);
export function canonicalJSON(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  throw new Error('canonicalJSON requires finite JSON values; use null, never undefined');
}
export const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value)).digest('hex');
export function fault(code, message, status = 400, details = null) { return Object.assign(new Error(message), { code, status, details }); }
export function demand(condition, code, message, status = 400) { if (!condition) throw fault(code, message, status); }
export const segmentId = i => `seg-${String(i + 1).padStart(4, '0')}`;
export const profileFor = strategy => strategy === 'vocabulary_guided' ? 'guided' : 'unguided';
export const STRATEGIES = ['text_only', 'vocabulary_guided', 'visual_evidence'];
export const MODES = ['zero_shot', 'few_shot'];
export const TERMINAL = ['succeeded', 'failed', 'cancelled', 'interrupted'];
export async function delay(ms, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason ?? fault('CANCELLED', '中断しました。')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
