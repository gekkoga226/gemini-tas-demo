import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunObserver} from '../public/run-observer.js';

test('status polling recovers after repeated failures and continues through cleanup',async()=>{
  let next=null,calls=0,connected=0;const waits=[],errors=[];
  const observe=createRunObserver({
    read:async()=>{calls++;if(calls<=4)throw new Error('offline');return calls<7;},
    onError:(e,n)=>errors.push(n),onConnected:()=>connected++,
    schedule:(fn,ms)=>{next=fn;waits.push(ms);return fn;},unschedule:()=>{next=null;}
  });
  await observe('run');
  while(next){const fn=next;next=null;await fn();}
  assert.equal(calls,7);assert.equal(connected,3);assert.deepEqual(errors,[1,2,3,4]);
  assert.deepEqual(waits,[4000,8000,16000,30000,2000,2000]);
});

test('switching runs suppresses delayed responses and old reconnect timers',async()=>{
  let resolveOld,next=null;const shown=[];
  const observe=createRunObserver({read:async(id,current)=>{
    if(id==='old')await new Promise(resolve=>{resolveOld=resolve;});
    if(current())shown.push(id);return true;
  },onError:()=>assert.fail('unexpected error'),onConnected:()=>{},schedule:fn=>(next=fn),unschedule:()=>{next=null;}});
  const old=observe('old');await observe('new');const newTimer=next;resolveOld();await old;
  assert.deepEqual(shown,['new']);assert.equal(next,newTimer);
});

test('missing run stops polling and presents a recoverable history choice',async()=>{
  const errors=[];
  const observe=createRunObserver({read:async()=>{throw Object.assign(new Error('missing'),{status:404});},onError:(e,n)=>errors.push(n),onConnected:()=>assert.fail(),schedule:()=>assert.fail('must not retry a missing run'),unschedule:()=>{}});
  await observe('absent');assert.deepEqual(errors,[0]);
});
