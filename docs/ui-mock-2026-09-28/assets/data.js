// Fictional, synthetic data only. Shapes follow tas-result.v1 (target segments) and the published
// standard set's display segments; values are invented for the UI review and are not measurements.
window.MOCK_DATA = (() => {
  const labels = [
    { job_no: '100', job_title: '部品を準備する', st_s: 12, kind: 'work' },
    { job_no: '110', job_title: '部品を位置決めする', st_s: 10, kind: 'work' },
    { job_no: '120', job_title: 'ねじを仮締めする', st_s: 14, kind: 'work' },
    { job_no: '130', job_title: 'ねじを本締めする', st_s: 14, kind: 'work' },
    { job_no: '140', job_title: '仕上がりを確認する', st_s: 10, kind: 'work' },
    { job_no: '150', job_title: '完成品を置く', st_s: 8, kind: 'work' },
    { job_no: 'NW07', job_title: 'その他（部品待ち）', st_s: null, kind: 'non_work' },
  ];
  const title = (jobNo) => labels.find((l) => l.job_no === jobNo).job_title;
  const standard = (prefix, rows) => rows.map(([jobNo, start, end], i) => ({
    segment_id: `${prefix}-${String(i + 1).padStart(2, '0')}`, start_s: start, end_s: end, job_no: jobNo, job_title: title(jobNo),
  }));
  const seg = (n, start, end, jobNo, review, reasons, confidence, raw, candidates, startReason, endReason, observation) => ({
    segment_id: `seg-${String(n).padStart(4, '0')}`, start_s: start, end_s: end, job_no: jobNo, job_title: title(jobNo),
    review_required: review, review_reasons: reasons, confidence, confidence_raw: raw,
    candidates: candidates.map(([no, score]) => ({ job_no: no, job_title: title(no), score })),
    boundary_evidence: { start_reason: startReason, end_reason: endReason }, observation,
  });

  const segments = [
    seg(1, 0, 13, '100', false, [], 0.91, 0.91, [['100', 0.91], ['110', 0.05]], '動画の開始', '部品を治具の横に置く',
      { operation: '両手でトレイから部品を取る', tools: 'なし', parts: 'ベース板・ブラケット' }),
    seg(2, 13, 24, '110', false, [], 0.86, 0.86, [['110', 0.86], ['120', 0.08]], '部品を治具に当てる', '位置決めピンに合う',
      { operation: '部品を治具に合わせて押さえる', tools: 'なし', parts: 'ブラケット' }),
    seg(3, 24, 41, '120', true, ['ordinary_low'], 0.58, 0.62, [['120', 0.62], ['130', 0.31], ['110', 0.07]], 'ねじを手に取る', 'ドライバーを置く',
      { operation: 'ねじを穴に入れて軽く回す', tools: '電動ドライバー（低トルク）', parts: 'ねじ M4 × 4本' }),
    seg(4, 41, 49, 'NW07', true, ['fallback'], 0.41, 0.41, [['NW07', 0.41], ['120', 0.33]], '手が止まる', '部品が届く',
      { operation: '手を止めて周りを見る', tools: 'なし', parts: '—' }),
    seg(5, 49, 55, '120', true, ['forced_low'], 0.5, 0.64, [['120', 0.64], ['130', 0.64]], 'ねじを取り直す', 'ドライバーを持ち替える',
      { operation: '1本目のねじを締め直す', tools: '電動ドライバー（低トルク）', parts: 'ねじ M4 × 1本' }),
    seg(6, 55, 69, '130', false, [], 0.83, 0.83, [['130', 0.83], ['120', 0.12]], 'ドライバーの設定を変える', 'ドライバーを置く',
      { operation: '4本のねじを順に本締めする', tools: '電動ドライバー（規定トルク）', parts: 'ねじ M4 × 4本' }),
    seg(7, 69, 78, '140', true, ['stage1_insufficient'], 0.61, 0.61, [['140', 0.61], ['150', 0.22]], '製品を持ち上げる', '製品を置く',
      { operation: '製品を回して見る（手元が隠れる）', tools: 'なし', parts: '完成品' }),
    seg(8, 78, 84, '150', false, [], 0.88, 0.88, [['150', 0.88]], '製品を棚へ運ぶ', '動画の終了',
      { operation: '完成品を棚に置く', tools: 'なし', parts: '完成品' }),
  ];

  // One earlier save (修正後 v1): the end of the waiting segment was moved 2 seconds earlier.
  const v1 = segments.map(({ segment_id, start_s, end_s, job_no, job_title }) => ({ segment_id, start_s, end_s, job_no, job_title }));
  v1[3].end_s = 47;
  v1[4].start_s = 47;

  return {
    vocabulary: { vocabulary_version: 'mock-vocabulary.v1', name: '部品ユニット組立の作業名一覧', labels },
    result: {
      schema_version: 'tas-result.v1', run_id: 'mock-run-0927-1432', analysis_mode: 'few_shot', mock: true,
      title: '組立ライン A・2026-09-27 14:32 の分析',
      input_video: { display_name: '組立ライン_0927_1432.mp4', duration_s: 84 },
      standard_set: {
        standard_set_id: 'mock-set-assembly-v3', name: '部品ユニット組立 v3', status: 'ready',
        sources: [
          { source_id: 'std-a', display_name: '組立_お手本A', duration_s: 64,
            display_segments: standard('std-a', [['100', 0, 11], ['110', 11, 20], ['120', 20, 33], ['130', 33, 46], ['140', 46, 56], ['150', 56, 64]]) },
          { source_id: 'std-b', display_name: '組立_お手本B', duration_s: 60,
            display_segments: standard('std-b', [['100', 0, 10], ['110', 10, 18], ['120', 18, 30], ['130', 30, 42], ['140', 42, 53], ['150', 53, 60]]) },
          { source_id: 'std-c', display_name: '組立_お手本C', duration_s: 71,
            display_segments: standard('std-c', [['100', 0, 12], ['110', 12, 22], ['120', 22, 36], ['130', 36, 50], ['140', 50, 63], ['150', 63, 71]]) },
        ],
      },
      segments,
    },
    reviews: [
      { version: 1, saved_at: '2026-09-27T17:05:00+09:00', reviewer: '佐藤（架空）',
        comment: '部品待ちの終わりを2秒早めた（部品が届いた時点に合わせる）。', segments: v1 },
    ],
  };
})();
