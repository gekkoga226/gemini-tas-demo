const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../dist/core.js');

test('80/120 minute demos cover the exact whole timeline in both modes',()=>{
 for(const d of [3.21,4800,7200]){const r=C.validate(C.createDemo(d));for(const m of ['zero','few']){let ss=r.modes[m].segments;assert.equal(ss[0].start_sec,0);assert.equal(ss.at(-1).end_sec,d);for(let i=1;i<ss.length;i++)assert.equal(ss[i].start_sec,ss[i-1].end_sec);assert.ok(Math.abs(ss.reduce((t,s)=>t+C.duration(s),0)-d)<1e-7);const totals=C.stats(r,m).totals;assert.ok(Math.abs(Object.values(totals).reduce((a,b)=>a+b,0)-d)<1e-7)}}
});
test('both modes differ in matching while preserving the same observations',()=>{
 const r=C.createDemo();const a=r.modes.zero.segments,b=r.modes.few.segments;
 assert.deepEqual(a.map(s=>[s.start_sec,s.end_sec,s.action]),b.map(s=>[s.start_sec,s.end_sec,s.action]));
 assert.ok(C.stats(r,'zero').totals.uncertain>C.stats(r,'few').totals.uncertain);
 assert.equal(r.standard_cards.reduce((t,c)=>t+c.duration_sec,0),4800);
});
test('round trip keeps source, review and global time',()=>{const r=C.createDemo(6000,'abc.mp4',1000);r.modes.zero.segments[2].note='<img src=x onerror=alert(1)>';assert.deepEqual(C.validate(JSON.parse(JSON.stringify(r))),r)});
test('invalid intervals and unrelated standard IDs are rejected',()=>{
 for(const change of [r=>r.modes.zero.segments[1].start_sec+=1,r=>r.modes.zero.segments[0].start_sec=2,r=>r.modes.zero.segments[3].end_sec=1,r=>r.modes.zero.segments.at(-1).end_sec-=20,r=>r.modes.zero.segments[0].standard_id='not-real',r=>r.modes.zero.segments[0].match_status='unmatched',r=>r.modes.zero.segments[0].match_status='toString',r=>r.modes.zero.segments[0].activity='constructor']){let r=C.createDemo();change(r);assert.throws(()=>C.validate(r))}
});
test('boundary update changes neighboring boundary and review without corrupting another mode',()=>{
 const r=C.createDemo(),s=r.modes.zero.segments[1],end=s.end_sec+10,begin=s.start_sec+10;
 const updated=C.update(r,'zero',s.id,{...s,start_sec:begin,end_sec:end,review_status:'verified'});
 assert.equal(updated.modes.zero.segments[0].end_sec,begin);assert.equal(updated.modes.zero.segments[2].start_sec,end);
 assert.equal(updated.modes.zero.segments[0].review_status,'draft');assert.equal(updated.modes.zero.segments[1].review_status,'draft');
 assert.deepEqual(updated.modes.few,r.modes.few);assert.notEqual(r.modes.zero.segments[1].start_sec,begin);assert.equal(updated.history.length,1);
});
test('invalid edit leaves original untouched',()=>{const r=C.createDemo();const before=JSON.stringify(r);const s=r.modes.zero.segments[1];assert.throws(()=>C.update(r,'zero',s.id,{...s,start_sec:0}));assert.equal(JSON.stringify(r),before)});
test('one-mode result works, no result does not',()=>{let r=C.createDemo();delete r.modes.few;assert.equal(C.validate(r).modes.few,undefined);delete r.modes.zero;assert.throws(()=>C.validate(r))});
test('CSV protects spreadsheet formula prefixes and preserves source labels',()=>{let r=C.createDemo();r.modes.zero.segments[0].note='=HYPERLINK("bad")';let csv=C.csv(r,'zero');assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('"demo","zero"'));assert.equal(csv.charCodeAt(0),0xfeff)});
