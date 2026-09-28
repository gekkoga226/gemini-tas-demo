export const END_STATES=['succeeded','failed','cancelled','interrupted','awaiting_approval'];
export function runPresentation(run) {
  const ended=END_STATES.includes(run.status);
  const kind=run.status==='failed'||run.status==='interrupted'?'error':run.status==='cancelled'?'idle':ended?'done':'running';
  let message=['failed','interrupted'].includes(run.status)?run.error?.message:null;
  if(!message)message=({succeeded:run.result_available?'分析結果を保存しました。映像と照らし合わせて内容を確認してください。':'作成した内容を保存しました。',failed:'処理に失敗しました。入力と履歴のエラーを確認し、必要に応じて再試行してください。',awaiting_approval:run.job_kind==='vocabulary_extract'?'抽出が終わりました。作業名と識別条件を確認して登録してください。':'生成が終わりました。お手本の記述と画像を確認して公開してください。',cancelled:'処理を中止しました。保存済みの記録は履歴に残っています。',interrupted:'前回の処理が中断されました。履歴から再試行できます。'})[run.status]??'サーバーで処理しています。この画面を閉じても処理は続きます。';
  return {ended,kind,message,observe_cleanup:!['deleted','not_needed'].includes(run.cleanup?.cleanup_status)};
}

export function analysisReadiness({config,video,set,vocabulary,mode,strategy,settings,busy,consent}) {
  const profile=strategy==='vocabulary_guided'?'guided':'unguided';
  const descriptor=set?.description_profiles?.[profile];
  const conditions=descriptor?.conditions;
  const incompatible=conditions&&['audio_enabled','fps','processing_mode','model_revision_scope'].some(k=>conditions[k]!==settings[k]);
  const checks=[
    {key:'video',ok:Boolean(video),text:video?`${video.display_name} · ${video.duration_s}秒`:'作業動画を選んでください'},
    {key:'standard',ok:Boolean(set?set.status==='ready'&&descriptor&&!incompatible&&(strategy!=='visual_evidence'||mode==='zero_shot'||set.representative_images?.length>0&&!set.media_state?.images_missing):mode==='zero_shot'&&vocabulary),text:''},
    {key:'consent',ok:consent,text:consent?'同意を確認済み':'作業者の同意を確認してください'},
    {key:'environment',ok:config?.ready===true,text:config?.ready?'接続・保存先の準備完了':(config?.checks??[]).filter(c=>!c.ok).map(c=>c.message).join(' ')||'接続を確認しています'}
  ];
  checks[1].text=checks[1].ok?(mode==='zero_shot'?(set?`${set.name}の確認済み作業名一覧を使用。お手本は推論に送りません`:'確認済みの作業名一覧を使用'):`${set.name} · ${set.sources?.length??1}本のお手本`):incompatible?'お手本と音声・FPSなどの設定を揃えてください':set?.media_state?.images_missing&&strategy==='visual_evidence'&&mode==='few_shot'?'代表画像が削除されています。お手本を新しいセットで作成してください':mode==='zero_shot'?'確認済みの作業名一覧を選んでください':'公開済みのお手本セットを選んでください';
  const missing=checks.filter(c=>!c.ok);
  return {checks,ready:!busy&&!missing.length,message:busy?'処理中です。完了後に次の分析を開始できます。':missing.length?missing[0].text:'準備ができました。分析を開始できます。'};
}
