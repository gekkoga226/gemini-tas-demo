import test from 'node:test';
import assert from 'node:assert/strict';
import {stComparison, comparisonTarget} from '../public/st-comparison.js';

const seg = (segment_id, start_s, end_s, job_no) => ({segment_id,start_s,end_s,job_no,job_title:`作業${job_no}`});
const segments = [seg('a',0,17,'100'),seg('b',17,23,'100'),seg('c',23,31,'200'),seg('d',31,39,'NW07'),seg('e',39,46,'999')];
const labels = [{job_no:'100',job_title:'ねじを締める',kind:'work',standard_duration_s:14},{job_no:'200',job_title:'貼る',kind:'work',standard_duration_s:null},{job_no:'300',job_title:'梱包',kind:'work',standard_duration_s:20},{job_no:'NW07',job_title:'その他',kind:'non_work',standard_duration_s:null}];
test('ST average counts occurrences rather than inferring cycles', () => {
  const r=stComparison(segments,labels);const a=r.rows.find(x=>x.job_no==='100');
  assert.deepEqual([a.target_s,a.st_s,a.diff_s,a.count],[11.5,14,-2.5,2]);
});
test('ST total compares target total with ST times occurrence count', () => {
  const a=stComparison(segments,labels,'total').rows.find(x=>x.job_no==='100');
  assert.deepEqual([a.target_s,a.st_s,a.diff_s],[23,28,-5]);
});
test('ST occurrence rows preserve each original ID, precise start and duration', () => {
  const a=stComparison(segments,labels,'occurrence').rows.filter(x=>x.job_no==='100');
  assert.deepEqual(a.sort((x,y)=>x.start_s-y.start_s).map(x=>[x.segment_id,x.start_s,x.target_s,x.diff_s]),[['a',0,17,3],['b',17,6,-8]]);
});
test('missing ST, unlisted names and non-work are distinct and never zero comparisons', () => {
  const r=stComparison(segments,labels);
  assert.deepEqual(['200','999','NW07'].map(no=>{const x=r.rows.find(x=>x.job_no===no);return[x.status,x.st_s,x.diff_s];}),[['no-st',null,null],['unlisted',null,null],['non-work',null,null]]);
});
test('no list is different from a present list whose STs are all unregistered', () => {
  const noList=stComparison(segments,null);const noST=stComparison(segments,labels.map(x=>({...x,standard_duration_s:null})));
  assert.equal(noList.hasList,false);assert.equal(noST.hasList,true);
  for(const r of [noList,noST])assert.deepEqual([r.total.target_s,r.total.st_s,r.total.diff_s,r.total.job_count],[null,null,null,0]);
  assert.equal(noST.rows.find(x=>x.job_no==='100').status,'no-st');
});
test('comparison total includes only comparable work and reports excluded time', () => {
  const r=stComparison(segments,labels);
  assert.deepEqual(r.total,{target_s:23,st_s:28,diff_s:-5,job_count:1,excluded_s:23,all_s:46});
});
test('absent work is listed separately, never added as zero seconds', () => {
  const r=stComparison(segments,labels);assert.deepEqual(r.absent.map(x=>x.job_no),['300']);assert.ok(!r.rows.some(x=>x.job_no==='300'));
});
test('empty results have no comparison or invented samples', () => {
  const r=stComparison([],labels);assert.equal(r.rows.length,0);assert.equal(r.groups.length,0);assert.equal(r.total.diff_s,null);assert.equal(r.total.all_s,0);
});
test('fractional inference seconds are used before display rounding', () => {
  const a=stComparison([seg('x',0.1,0.42,'100')],[{...labels[0],standard_duration_s:0.3}]).rows[0];
  assert.ok(Math.abs(a.target_s-0.32)<1e-12);assert.ok(Math.abs(a.diff_s-0.02)<1e-12);
});
test('calculation leaves inference, saved review and vocabulary inputs unchanged', () => {
  const input=structuredClone([segments,labels]);const before=JSON.stringify(input);
  for(const mode of ['average','total','occurrence'])stComparison(...input,mode);
  assert.equal(JSON.stringify(input),before);
});
test('row target follows the chosen source even if a correction renamed or removed an occurrence', () => {
  const original=[seg('x',49,55,'100')];const reviewed=[seg('x',47,55,'200')];
  assert.equal(comparisonTarget(original,{job_no:'100'},0).start_s,49);
  assert.equal(comparisonTarget(reviewed,{job_no:'100'},0),null);
  assert.equal(comparisonTarget(reviewed,{segment_id:'x'},0).start_s,47);
});
test('aggregated rows seek the next occurrence, wrapping only after the last', () => {
  assert.equal(comparisonTarget(segments,{job_no:'100'},10).segment_id,'b');
  assert.equal(comparisonTarget(segments,{job_no:'100'},24).segment_id,'a');
});
