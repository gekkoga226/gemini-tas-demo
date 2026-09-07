import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSegmentationStructure,checkSafetyNet,scoreTAS,f1Match,monotoneMatch,aggregate,windowScores,pairedEvidence} from '../tools/geap-probe/scoring.mjs';
const s=(job_no,start_s,end_s,extra={})=>({job_no,job_title:job_no,start_s,end_s,segment_id:`p-${start_s}`,gt_segment_id:`g-${start_s}`,review_required:false,review_reasons:[],confidence_raw:.9,confidence:.9,forced_low_confidence:false,...extra});
test('Check 8 hand calculations distinguish merge and split with one-to-one boundaries',()=>{
  const merge=checkSegmentationStructure([s('?',0,20)],[s('A',0,10),s('B',10,20)],20);assert.equal(merge.merged.numerator,1);assert.equal(merge.oracle_MoF.value,.5);assert.equal(merge.hidden_by_merge,1);assert.equal(merge.missed.numerator,1);
  const split=checkSegmentationStructure([s('?',0,10),s('?',10,20)],[s('A',0,20)],20);assert.equal(split.split.numerator,1);assert.equal(split.boundary[1].extra,1);assert.equal(split.boundary[1].recall.value,null);assert.equal(split.oracle_MoF.value,1);
  assert.equal(checkSegmentationStructure([s('?',0,12),s('?',10,20)],[s('A',0,20)],20).oracle_MoF,null);
  assert.deepEqual(monotoneMatch([9,11],[10],(p,g)=>Math.abs(p-g)<=1?-Math.abs(p-g):null),[[0,0]]);
});
test('TAS keeps non-work, samples half-open fractional intervals, F1 does not choose a second-best GT',()=>{
  const gt=[s('A',0,.15),s('NW07',.15,.35)];const exact=scoreTAS(gt,gt,.35);assert.equal(exact.frame_count,4);assert.equal(exact.Acc.value,1);assert.equal(exact.Edit,100);assert.equal(exact.F1[50].tp,2);
  const p=[{label:'A',start_s:0,end_s:9},{label:'A',start_s:2,end_s:10}],g=[{label:'A',start_s:0,end_s:10},{label:'A',start_s:10,end_s:11}];assert.equal(f1Match(p,g,.1).tp,1);
  const invalid=scoreTAS([s('X',0,.35)],gt,.35,{status:'invalid'});assert.equal(invalid.Edit,0);assert.equal(invalid.Acc.value,0);assert.equal(invalid.F1[10].tp,0);
  const report=aggregate([exact,scoreTAS([],gt,.35,{status:'communication_failed'}),scoreTAS([],gt,.35,{status:'not_run'})]);assert.equal(report.Acc.value,1);assert.equal(report.effective_Acc.value,.5);assert.equal(report.remaining,1);
});
test('Check 10 strict boundary errors, raw bins, overlaps, null denominators and Check 11 paired regressions',()=>{
  const gt=[s('A',0,10),s('B',10,20)],pred=[s('A',0,12,{confidence_raw:.95,confidence:.49,forced_low_confidence:true,review_required:true,review_reasons:['forced_low','stage1_insufficient']}),s('B',12,20)];
  const safety=checkSafetyNet(pred,gt,20);assert.equal(safety.errors[0].E,true);assert.equal(safety.errors[0].majority_error,false);assert.equal(safety.errors[0].wrong_seconds,2);assert.equal(safety.error_detection.value,1);assert.equal(safety.auto_error.value,0);assert.equal(safety.raw_bins.forced[9].count,1);assert.equal(safety.display_bins[4].count,1);assert.equal(safety.factors.forced_low.uniquely_detected,0);assert.equal(safety.union_detected,1);
  const clean=checkSafetyNet(gt,gt,20);assert.equal(clean.error_detection.value,null);assert.equal(clean.review_precision.value,null);
  assert.equal(checkSafetyNet([],gt,20,{status:'invalid'}).review_time.value,1);assert.equal(checkSafetyNet([],gt,20,{status:'communication_failed'}).metrics,null);
  const after=pred.map(p=>({...p,job_no:'B',job_title:'B'}));assert.deepEqual(pairedEvidence(pred,after,gt).majority.regressed,['p-0']);
});
test('similar-group windows stay separate; pooled MoC uses GT classes and class IoU includes prediction-only labels',()=>{
  const gt=[s('A',0,1),s('B',1,2),s('A',2,3)],p=[s('A',0,1),s('X',1,2),s('A',2,3)];const ws=windowScores(p,gt,[{video_id:'v',start_s:0,end_s:1},{video_id:'v',start_s:2,end_s:3}],'v');assert.equal(ws.length,2);assert.ok(ws.every(w=>w.score.Edit===100));const a=aggregate([scoreTAS(p,gt,3)]);assert.equal(a.MoC,.5);assert.equal(a.mean_class_iou,1/3);
});
