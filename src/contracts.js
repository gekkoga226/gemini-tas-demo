import { demand, fault, segmentId } from './core.js';
import { qualityWarningsV1 } from '../public/segments.js';

export const FIELDS = ['objects_parts', 'work_location_fixture', 'tools_held', 'operation', 'state_before', 'state_after', 'audio_cues'];
export const NON_WORK = ['検査・測定', '運搬・段取り', '探索・確認', '手待ち（外因）', '中断（内因）', '手直し', 'その他'];
export const SAFETY = Object.freeze({ safety_policy_version: 'safety-policy.v1', quality_policy_version: 'quality-policy.v1', tie_margin: .05, forced_confidence_cap: .49, review_threshold: .70 });
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = value => typeof value === 'string' && value.trim().length > 0;
const num = value => typeof value === 'number' && Number.isFinite(value);
const unit = value => num(value) && value >= 0 && value <= 1;
const exact = (v, keys) => obj(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function check(ok, path, reason) { if (!ok) throw new Error(`${path}: ${reason}`); }
function wrap(code, fn) { try { return fn(); } catch (e) { if (e.code) throw e; throw fault(code, `${code}: ${e.message}`, 422, [e.message]); } }
function strings(v, p) { check(Array.isArray(v) && v.every(str), p, '文字列配列が必要です'); }
function idSet(items, expected, p) { check(Array.isArray(items) && items.length === expected.length && new Set(items.map(x => x?.segment_id)).size === expected.length && items.every(x => expected.includes(x?.segment_id)), p, 'IDの欠落・重複・未知ID'); }

export function validateCoverage(segments, duration, idKey = null) {
  check(num(duration) && duration > 0 && Array.isArray(segments) && segments.length > 0, 'segments', '動画長と区間が必要です');
  let end = 0;
  segments.forEach((s, i) => {
    check(obj(s) && num(s.start_s) && num(s.end_s) && s.start_s === end && s.end_s > s.start_s && s.end_s <= duration, `segments[${i}]`, '時刻の隙間・重複・逆順・範囲外');
    if (idKey === 'segment_id') check(s.segment_id === segmentId(i), `segments[${i}]`, '匿名連番IDが必要です');
    end = s.end_s;
  });
  check(end === duration, 'segments', '動画全長を覆っていません');
  if (idKey) check(new Set(segments.map(s => s[idKey])).size === segments.length && segments.every(s => str(s[idKey])), 'segments', '一意のIDが必要です');
  return segments;
}
export function validateObservation(o, interval, audio) {
  check(exact(o, [...FIELDS, 'unobserved_occlusions', 'insufficient_discriminative_features', 'insufficiency_reasons', 'evidence']), 'observation', 'observation.v1の必須項目/未知項目');
  check(Array.isArray(o.evidence), 'evidence', '配列が必要です');
  const evidence = new Map();
  o.evidence.forEach(e => {
    check(exact(e, ['evidence_id','source','start_s','end_s','description']) && str(e.evidence_id) && !evidence.has(e.evidence_id) && str(e.description), 'evidence', '不正な根拠');
    check(['video', 'audio'].includes(e.source) && (audio || e.source !== 'audio'), 'evidence.source', '音声条件違反');
    check(num(e.start_s) && num(e.end_s) && e.start_s >= interval.start_s && e.start_s <= e.end_s && e.end_s <= interval.end_s, 'evidence', '根拠時刻は指定区間内');
    evidence.set(e.evidence_id, e);
  });
  check(Array.isArray(o.unobserved_occlusions), 'unobserved_occlusions', '配列が必要です');
  o.unobserved_occlusions.forEach(x => { check(exact(x, ['field','reason','evidence_ids']) && FIELDS.includes(x.field) && str(x.reason), 'occlusion', '不正な不足記録'); strings(x.evidence_ids, 'occlusion.evidence_ids'); check(x.evidence_ids.every(i => evidence.has(i)), 'occlusion', '不明な根拠ID'); });
  FIELDS.forEach(f => {
    const x = o[f]; check(exact(x, ['status','value','evidence_ids']) && ['observed','unknown','not_applicable'].includes(x.status), f, '観察項目の構造不正');
    strings(x.evidence_ids, f); check(x.evidence_ids.every(i => evidence.has(i)), f, '根拠IDが存在しません');
    check(x.status === 'observed' ? str(x.value) && x.evidence_ids.length > 0 : x.value === null && o.unobserved_occlusions.some(y => y.field === f), f, '値・根拠・不足理由が不整合');
  });
  check(audio || o.audio_cues.status === 'not_applicable', 'audio_cues', '音声なしではnot_applicable');
  check(typeof o.insufficient_discriminative_features === 'boolean', 'insufficient', 'booleanが必要です');
  strings(o.insufficiency_reasons, 'insufficiency_reasons');
  check(o.insufficient_discriminative_features ? o.insufficiency_reasons.length > 0 : o.insufficiency_reasons.length === 0, 'insufficiency_reasons', '自己申告との不整合');
  return o;
}
export function validateStage1(output, { duration_s, audio_enabled = false, boundaries = null }) {
  return wrap('INVALID_STAGE1', () => {
    if (boundaries) {
      validateCoverage(boundaries, duration_s, 'segment_id');
      check(exact(output, ['schema_version','observations']) && output.schema_version === 'stage1.fixed.v1', 'stage1', '固定モードの別スキーマが必要です');
      idSet(output.observations, boundaries.map(b => b.segment_id), 'observations');
      output.observations.forEach(s => { check(exact(s, ['segment_id','observation']), s.segment_id, '時刻/ラベル/境界根拠の追加禁止'); validateObservation(s.observation, boundaries.find(b => b.segment_id === s.segment_id), audio_enabled); });
    } else {
      check(exact(output, ['schema_version','segments']) && output.schema_version === 'stage1.discover.v1', 'stage1', '発見モードのスキーマが必要です');
      validateCoverage(output.segments, duration_s, 'segment_id');
      output.segments.forEach(s => { check(exact(s, ['segment_id','start_s','end_s','boundary_evidence','observation']), s.segment_id, 'ラベル/未知項目禁止'); check(exact(s.boundary_evidence, ['start_reason','end_reason']) && Object.values(s.boundary_evidence).every(str), 'boundary_evidence', '境界理由が必要です'); validateObservation(s.observation, s, audio_enabled); });
    }
    return output;
  });
}
export function joinFixed(output, boundaries) { return boundaries.map(b => ({ ...b, observation: output.observations.find(o => o.segment_id === b.segment_id).observation })); }
export function validateVocabulary(v) {
  return wrap('INVALID_VOCABULARY', () => {
    check(obj(v) && v.schema_version === 'vocabulary.v1' && str(v.vocabulary_version) && str(v.non_work_labels_version) && Object.hasOwn(v, 'source_pdf_sha256') && Array.isArray(v.labels), 'vocabulary', '語彙契約不正');
    const ids = new Set();
    v.labels.forEach(l => {
      check(exact(l, ['job_no','job_title','page_number','kind','standard_duration_s','standard_order']) && str(l.job_no) && str(l.job_title) && str(l.page_number) && !ids.has(l.job_no) && ['work','non_work'].includes(l.kind), 'label', 'ラベル組またはIDの不正'); ids.add(l.job_no);
      check(l.standard_duration_s === null || (num(l.standard_duration_s) && l.standard_duration_s > 0), 'duration', '正数/null');
      check(l.standard_order === null || (Number.isInteger(l.standard_order) && l.standard_order >= 0), 'order', '整数/null');
    });
    NON_WORK.forEach((title, i) => check(v.labels.some(l => l.job_no === `NW0${i+1}` && l.job_title === title && l.kind === 'non_work' && l.page_number === '-'), 'non_work', '予約7種の一致が必要です'));
    check(v.labels.filter(l => l.kind === 'non_work').length === 7 && v.labels.every(l => l.kind !== 'work' || !/^NW0[1-7]$/.test(l.job_no)), 'non_work', '予約IDと衝突しています');
    return v;
  });
}
export function validateDiscriminators(d, v) {
  return wrap('INVALID_DISCRIMINATORS', () => {
    check(obj(d) && d.schema_version === 'discriminators.v1' && str(d.discriminator_version) && d.vocabulary_version === v.vocabulary_version && Array.isArray(d.source_refs) && str(d.approved_by) && str(d.approved_at) && Array.isArray(d.conditions), 'discriminators', '確認済み識別条件が必要です');
    const ids = new Set(v.labels.map(l => l.job_no));
    check(new Set(d.conditions.map(c => c.job_no)).size === d.conditions.length, 'conditions', '重複');
    d.conditions.forEach(c => { check(exact(c,['job_no','similar_job_nos','observable_features','unknown_when']) && ids.has(c.job_no), 'conditions', '語彙不一致'); strings(c.similar_job_nos, 'similar_job_nos'); check(c.similar_job_nos.every(n => ids.has(n)), 'similar_job_nos','語彙不一致'); strings(c.unknown_when, 'unknown_when'); check(Array.isArray(c.observable_features) && c.observable_features.every(f => exact(f,['field','criterion']) && FIELDS.includes(f.field) && str(f.criterion)), 'features', '観察可能な特徴が必要です'); });
    return d;
  });
}
export function validateGT(gt, video, vocabulary) {
  return wrap('INVALID_GT', () => {
    check(obj(gt) && str(gt.gt_version) && gt.video_id === video.video_id && gt.duration_s === video.duration_s, 'gt', '動画との不一致');
    validateCoverage(gt.segments, video.duration_s, 'gt_segment_id');
    check(gt.segments.every(s => str(s.gt_process_id) && vocabulary.labels.some(l => l.job_no === s.job_no && l.job_title === s.job_title)), 'gt','出現ID/ラベル不一致');
    check(new Set(gt.segments.map(s => s.gt_process_id)).size === gt.segments.length, 'gt_process_id','出現ID重複');
    return gt;
  });
}
export function validateSafety(policy) { demand(str(policy.safety_policy_version) && unit(policy.tie_margin) && unit(policy.review_threshold) && unit(policy.forced_confidence_cap) && policy.forced_confidence_cap < policy.review_threshold, 'INVALID_SAFETY_POLICY', '安全網の版・閾値・capを確認してください。'); return policy; }
export function validateStage2(output, input) {
  return wrap('INVALID_STAGE2', () => {
    const { segments, vocabulary, examples = [], images = [], analysis_strategy, analysis_mode, video_id } = input;
    check(exact(output, ['schema_version','labels']) && output.schema_version === 'stage2.v1', 'stage2', 'stage2.v1の応答が必要です');
    idSet(output.labels, segments.map(s => s.segment_id), 'labels');
    const matches = l => exact(l,['job_no','job_title']) && vocabulary.labels.some(v => v.job_no === l.job_no && v.job_title === l.job_title);
    function refs(refs, s) {
      check(Array.isArray(refs), 'evidence_refs', '配列が必要です');
      refs.forEach(r => {
        check(obj(r), 'ref', '根拠参照不正');
        if (r.kind === 'observation' || r.kind === 'example') {
          const isExample = r.kind === 'example'; const key = isExample ? 'example_id' : 'segment_id';
          check(exact(r,['kind',key,'field','evidence_id']) && FIELDS.includes(r.field), 'ref', '観察項目/構造不正');
          check(!isExample || analysis_mode === 'few_shot', 'ref', 'Zero-shotへ標準根拠の混入');
          const source = isExample ? examples.find(e => e.example_id === r.example_id) : segments.find(e => e.segment_id === r.segment_id && e.segment_id === s.segment_id);
          check(source && source.observation[r.field]?.evidence_ids.includes(r.evidence_id) && source.observation.evidence.some(e => e.evidence_id === r.evidence_id), 'ref', '入力にない観察根拠');
        } else if (r.kind === 'actual_video') {
          check(exact(r,['kind','video_id','start_s','end_s']) && analysis_strategy === 'visual_evidence' && r.video_id === video_id && num(r.start_s) && num(r.end_s) && r.start_s >= s.start_s && r.start_s <= r.end_s && r.end_s <= s.end_s, 'ref', '動画条件/時刻違反');
        } else if (r.kind === 'standard_image') {
          check(exact(r,['kind','image_id']) && analysis_strategy === 'visual_evidence' && analysis_mode === 'few_shot' && images.some(i => i.image_id === r.image_id), 'ref', '入力にない標準画像');
        } else check(false, 'ref', '未知の根拠種別');
      });
    }
    output.labels.forEach(l => {
      check(exact(l,['segment_id','final_label','confidence_raw','candidates','tie','adoption_reason','evidence_refs']), 'label', '必須項目/時刻追加/未知項目');
      check(matches(l.final_label) && unit(l.confidence_raw) && typeof l.tie === 'boolean' && str(l.adoption_reason), l.segment_id, '語彙/確信度/理由不正');
      check(Array.isArray(l.candidates) && l.candidates.length >= 1 && l.candidates.length <= 3 && new Set(l.candidates.map(c => c.job_no)).size === l.candidates.length, 'candidates', '1〜3件・重複禁止');
      const s = segments.find(s => s.segment_id === l.segment_id);
      l.candidates.forEach((c,i) => { check(exact(c,['job_no','job_title','score','reason','evidence_refs']) && matches({job_no:c.job_no,job_title:c.job_title}) && unit(c.score) && str(c.reason) && (!i || l.candidates[i-1].score >= c.score), 'candidate', '語彙/降順スコア/理由不正'); refs(c.evidence_refs,s); });
      const fallback = l.final_label.job_no === 'NW07';
      check(fallback || l.candidates.some(c => c.job_no === l.final_label.job_no), 'final_label', '最終ラベルが候補にありません');
      check(!l.tie || (fallback && l.candidates.length >= 2), 'tie', '同着自己申告は候補2件以上・その他');
      refs(l.evidence_refs,s);
      check(fallback || l.evidence_refs.some(r => r.kind === 'observation' || r.kind === 'actual_video'), 'evidence_refs', '実作業の根拠が必要です');
    });
    return output;
  });
}
export function saveStage2(raw, input, policy = SAFETY) {
  validateSafety(policy); validateStage2(raw, input);
  const joined = input.segments.map(s => ({ ...s, ...raw.labels.find(l => l.segment_id === s.segment_id).final_label }));
  const warnings = qualityWarningsV1(joined, input.vocabulary.labels, input.duration_s);
  const labels = raw.labels.map(l => {
    const s = input.segments.find(s => s.segment_id === l.segment_id);
    const tie_detected = l.tie || (l.candidates.length >= 2 && l.candidates[0].score - l.candidates[1].score <= policy.tie_margin + Number.EPSILON);
    const reasons = [];
    if (s.observation.insufficient_discriminative_features) reasons.push('stage1_insufficient');
    const used = l.evidence_refs.filter(r => r.kind === 'example');
    if (used.some(r => input.examples.find(e=>e.example_id===r.example_id)?.observation.insufficient_discriminative_features)) reasons.push('standard_insufficient');
    if (tie_detected) reasons.push('forced_low');
    else if (l.confidence_raw < policy.review_threshold) reasons.push('ordinary_low');
    if (l.final_label.job_no === 'NW07') reasons.push('fallback');
    if (warnings.some(w=>w.segment_ids.includes(l.segment_id))) reasons.push('quality_warning');
    return { ...l, tie_detected, forced_low_confidence:tie_detected, confidence:tie_detected ? Math.min(l.confidence_raw,policy.forced_confidence_cap) : l.confidence_raw, review_reasons:reasons, review_required:reasons.length>0, auto_accepted:reasons.length===0 };
  });
  return { output:{schema_version:'stage2.v1',labels}, warnings };
}
