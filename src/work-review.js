import { sha256, demand } from './core.js';

// Read-only projection. Inference and its immutable result remain under Round 18.
// A non-work label alone cannot prove that an activity is absent from a standard.
export function toWorkReview(result, vocabulary, media) {
  demand(result.schema_version === 'tas-result.v1', 'WORK_REVIEW_FORMAT', 'この結果形式はレビュー画面に対応していません。', 422);
  const mode = result.analysis_mode === 'few_shot' ? 'few' : 'zero';
  const cards = vocabulary.labels.filter(label => label.kind === 'work').map(label => ({
    id: label.job_no, name: label.job_title, duration_sec: label.standard_duration_s,
    page: label.page_number, order: label.standard_order,
  }));
  const known = new Set(cards.map(card => card.id));
  const activities = { NW01: 'inspect', NW02: 'move', NW03: 'search', NW04: 'wait' };
  const value = (observation, key) => observation[key]?.status === 'observed' ? observation[key].value : '不明';
  const segments = result.segments.map(segment => {
    const o = segment.observation;
    const assigned = known.has(segment.job_no);
    return {
      id: segment.segment_id, start_sec: segment.start_s, end_sec: segment.end_s,
      action: value(o, 'operation'), activity: activities[segment.job_no] || 'unknown',
      object: value(o, 'objects_parts'), tool: value(o, 'tools_held'), location: value(o, 'work_location_fixture'),
      before: value(o, 'state_before'), after: value(o, 'state_after'),
      evidence: o.evidence.map(e => `${e.start_s}–${e.end_s}秒：${e.description}`).join(' / '),
      standard_id: assigned ? segment.job_no : null,
      match_status: assigned ? 'matched' : 'uncertain',
      method_status: 'unknown', order_status: 'unknown', review_status: 'draft', note: '',
      source_label: { job_no: segment.job_no, job_title: segment.job_title, confidence: segment.confidence,
        review_required: segment.review_required, review_reasons: segment.review_reasons, adoption_reason: segment.adoption_reason },
      source_observation: o,
    };
  });
  return {
    schema_version: '1.0', data_source: result.mock ? 'demo' : 'gemini',
    video: { name: media?.display_name || result.input.video_id, duration_sec: result.input.duration_s,
      size_bytes: media?.size_bytes ?? null, sha256: result.input.source_sha256 },
    tt_sec: null, standard_cards: cards, modes: { [mode]: { segments } },
    original_modes: { [mode]: { segments: structuredClone(segments) } }, history: [],
    source: { schema_version: result.schema_version, run_id: result.run_id,
      result_sha256: sha256(result), analysis_strategy: result.analysis_strategy,
      stage1_artifact_id: result.stage1.artifact_id, warnings: result.warnings,
      result_url: `/api/analysis-runs/${result.run_id}/result`,
      review_mapping: 'work-review.v1',
      note: '標準時間は語彙の記載値。活動・方法・順序の未記録事項は未判定。非作業ラベルは未記載を確定せず要確認として表示。人の確認状態は別に記録。' },
  };
}
