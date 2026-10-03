import {analysisReadiness,runPresentation} from './analysis-state.js';
import {standardSources} from './standard-analytics.js';
import {renderStandardCharts} from './standard-charts.js';
import {createStandardEditor} from './standard-editor.js';
import {createRunObserver} from './run-observer.js';
import {secondsToTime,timeToSeconds,matchingSegment,REVIEW_REASON_LABELS,validateSegments} from './segments.js';
import {timeDifferences} from './result-compare.js';
import {resultSetLabels,standardNotice} from './result-labels.js';
import {memoAfterSave} from './unsaved-state.js';
import {isStackedLayout} from './narrow-layout.js';
import {comparisonTarget} from './st-comparison.js';
import {renderStViews} from './st-view.js';
const STRATEGIES={text_only:'案1：項目化した文章照合',vocabulary_guided:'案2：語彙補助の文章照合',visual_evidence:'案3：映像根拠併用'};
const STATUS={queued:'受付',preparing:'準備',uploading:'送信',stage1_running:'区間分割',stage1_ready:'区間分割保存済み',stage2_running:'ラベル照合',validating:'結果検証',persisting:'保存',retry_wait:'再試行待ち',succeeded:'完了',failed:'失敗',cancel_requested:'中断要求済み',cancelled:'中断',interrupted:'前回処理の中断',awaiting_approval:'内容の確認待ち'};
const setStatusText=s=>s.status==='ready'?'公開済み':s.status==='retired'?'利用停止':s.approval_available?'内容の確認待ち':STATUS[s.build_status??s.status]??s.status;
const CLEANUP={not_needed:'対象なし',pending:'削除待ち',waiting_lease:'参照・猶予期間の終了待ち',deleting:'削除中',retry_wait:'削除失敗・再試行待ち',deleted:'削除完了',cleanup_failed:'削除が24時間以上未完了・対応が必要'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const costText=c=>c?.total===null||c?.total===undefined?'不明（未測定／内訳不足）':`${Number(c.total).toFixed(4)} ${c.currency??''}（${c.cost_status==='estimated'?'概算':'追加APIなし'}）`;
const sec=v=>`${Number(Number(v).toFixed(1))}秒`;
const signed=v=>(v>0?'+':v<0?'−':'±')+sec(Math.abs(v));
export function createWorkflow({state,$,render,setStatus,toast,renderDirty,hasUnsaved,seek,selectSegment,pendingDetailStop,selectPanel,switchView}) {
  let config=null,sets=[],media=[],vocabularies=[],mode='few_shot',activeRun=null,result=null,display=null,review=null,buildId=null,originalReview=[];
  let standardSegments=[],standardExamples=[],standardImages=[],lastStandardId=null,lastActualId=null,syncBusy=false,diffSource='auto';
  let vocabularyRunId=null,editor=null,submitting=false,pendingUploads=0,resultSet=null,resultNote='',inspectedSet=null,restoreObservedInputs=false,reviewList=[],stMode='average',currentPlace='new',libraryReturnPlace='new';
  const busy=()=>state.running||submitting||pendingUploads>0;
  async function api(url,body,method) {const response=await fetch(url,{method:method||(body?'POST':'GET'),headers:body?{'content-type':'application/json','x-local-token':state.session.token}:{},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok){const error=new Error(`${data.message} (${data.code})`);error.status=response.status;throw error;}return data;}
  const safely=fn=>async(...args)=>{try{await fn(...args);}catch(e){toast(e.message);setStatus('error','操作を完了できません',e.message);}};
  function settings() {return {...config.settings,processing_mode:$('#processingMode').value,fps:Number($('#inputFps').value),audio_enabled:$('#audioEnabled').checked,prompt_release:$('#promptRelease').value};}
  function sameStage1Settings(a,b){return ['stage1_model','model_revision_scope','project','location','host','api_version','processing_mode','audio_enabled','fps','media_resolution','prompt_release','stage1_generation_config'].every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));}
  function labels(){return (sets.find(x=>x.standard_set_id===result?.standard_set_id)?.vocabulary??vocabularies.find(v=>v.vocabulary.vocabulary_version===result?.versions.vocabulary.version)?.vocabulary)?.labels??[];}
  function labelSelector(form,value){const input=form.elements.job_no,select=document.createElement('select');select.name='job_no';labels().forEach(l=>select.add(new Option(`${l.job_no} ${l.job_title}`,l.job_no)));select.value=value||labels()[0]?.job_no;input.replaceWith(select);form.elements.job_title.readOnly=true;form.elements.page_number.readOnly=true;const choose=()=>{const l=labels().find(l=>l.job_no===select.value);if(l){form.elements.job_title.value=l.job_title;form.elements.page_number.value=l.page_number;}};select.addEventListener('change',choose);choose();}
  function warnings(){const shown=state.view==='prediction'?state.prediction:state.reviewed,structural=validateSegments(shown,state.videoDuration);state.warnings=shown.map((s,i)=>[...new Set([...(structural[i]||[]),...(result?.segments.find(x=>x.segment_id===s.segment_id)?.review_reasons??[]).filter(r=>r!=='quality_warning').map(r=>`自動判定：${REVIEW_REASON_LABELS[r]}`),...(result?.warnings??[]).filter(w=>w.segment_ids.includes(s.segment_id)).map(w=>w.code==='MISSING_PROCESS'?'自動判定：工程抜けの候補があります。動画全体の確認事項を参照してください。':`自動判定：${w.message}`)])]);}
  function inputState() {
    if(!config)return;
    const set=effectiveSet(),strategy=$('#analysisStrategy').value,video=media.find(m=>m.video_id===$('#registeredVideo').value);
    const readiness=analysisReadiness({config,video,set,vocabulary:$('#vocabularySelect').value,mode,strategy,settings:settings(),busy:busy(),consent:$('#consentConfirmed').checked});
    $('#startButton').disabled=!readiness.ready;
    $('#inputSummary').textContent=pendingUploads?'動画をローカルへ登録・検証しています。':submitting?'分析を受け付けています。':readiness.message;
    $('#readinessList').innerHTML=readiness.checks.filter(c=>c.key!=='consent').map(c=>`<li class="${c.ok?'is-ready':''}"><span class="check-mark" aria-hidden="true">${c.ok?'✓':'○'}</span><span>${esc(c.text)}</span></li>`).join('');
    $('#videoMeta').textContent=pendingUploads?'ローカルへ登録・検証中':video?`選択中：${video.display_name} ／ ${secondsToTime(video.duration_s)}`:'動画はまだ選ばれていません';
    $('#videoDrop').classList.toggle('selected',Boolean(video));
    $('#vocabularyChoice').hidden=mode!=='zero_shot';$('#vocabularySelect').options[0].textContent=mode==='zero_shot'&&set?`${set.name}の作業名一覧を使用`:'選択してください';
    $('#standardChoice').hidden=mode==='zero_shot';
    $('#referenceTitle').textContent=mode==='zero_shot'?'作業名一覧を選ぶ':'お手本を選ぶ';
    $('#modeHelp').textContent=mode==='zero_shot'?'お手本動画は不要です。確認済みの作業名一覧と識別条件を使って対象動画を分析します。':'公開済みのお手本セットと対象動画を照合します。';
    $('#startButton').textContent=mode==='zero_shot'?'作業の分析を開始':'お手本と照合を開始';
    const rerunCompatible=result&&sameStage1Settings(result.execution,settings())&&result.input.video_id===video?.video_id&&result.standard_set_id===(set?.standard_set_id??null)&&((result.analysis_strategy==='vocabulary_guided')===(strategy==='vocabulary_guided'));
    $('#rerunStage2').textContent=result&&!rerunCompatible?'区間分割から再分析':'同じ区間でラベルを再判定';
    $('#rerunStage2').disabled=!readiness.ready||!result;
    $('#inputNotice').textContent=config.mode==='mock'?'合成モック：動画はこのPCに保存します。外部通信はありません。映像は解析されず、区間・ラベル・使用量は固定パターンの合成データです（精度確認には使えません）。':`送信先：Google Cloud / ${config.settings.project} / ${config.settings.location}。動画1本を送信します。${strategy==='visual_evidence'?`照合時も実動画${mode==='few_shot'?`とお手本の代表画像${set?.representative_images.length??0}枚`:''}を使用します。`:'同じ区間の再判定は文章のみです。'} 業務精度・長時間性能・費用は未検証です。`;
    $('#settingsSummary').textContent=`モデル：${config.settings.stage1_model??'未設定'} / ${config.settings.stage2_model??'未設定'}\n音声：${settings().audio_enabled?'あり':'なし（音声トラックを除去）'} / FPS：${settings().fps} / ${settings().processing_mode}\n${state.running?'実行中の設定は固定されています。変更は次回の実行に適用します。':''}`;
    $('#pdfMeta').textContent=mode==='zero_shot'?(set?`${set.name}の確認済み作業名一覧を使います。お手本の記述・画像は送信しません。`:$('#vocabularySelect').value?'確認済みの作業名一覧を使います。お手本の記述・画像は送信しません。':'作業名一覧がなければ「お手本を登録・確認」から作業名一覧・識別条件を登録してください。'):set?`${set.name} ／ ${setStatusText(set)} ／ お手本${set.sources?.length??1}本・代表画像${set.representative_images.length}枚`:sets.some(s=>s.status==='ready')?'公開済みのお手本セットを選んでください。':'公開済みのお手本がありません。「お手本を登録・確認」からセットを作成・公開してください。';
    editor?.update();
  }
  function effectiveSet(){const selected=sets.find(s=>s.standard_set_id===$('#standardSet').value);return mode==='zero_shot'&&($('#vocabularySelect').value||selected?.status!=='ready')?null:selected;}
  function fillSelect(el,items,valueKey,text,empty='選択してください') {const previous=el.value;el.replaceChildren(new Option(empty,''),...items.map(x=>new Option(text(x),x[valueKey])));if(items.some(x=>x[valueKey]===previous))el.value=previous;}
  async function refreshInputs() {
    const priorAssets=JSON.stringify([media.map(m=>m.video_id),vocabularies.map(v=>v.ref)]);
    const [a,b,c]=await Promise.all([api('/api/standard-sets'),api('/api/media'),api('/api/vocabularies')]);sets=a.standard_sets;media=b.media.filter(a=>a.mime_type==='video/mp4');vocabularies=c.vocabularies;
    fillSelect($('#standardSet'),sets.filter(s=>s.status!=='retired'),'standard_set_id',s=>`${s.name}（${setStatusText(s)}）`);
    fillSelect($('#registeredVideo'),media,'video_id',m=>m.display_name);fillSelect($('#librarySet'),sets,'standard_set_id',s=>`${s.name}（${setStatusText(s)}・${s.sources?.length??1}本）`,'新しいセットを作成');
    fillSelect($('#vocabularySelect'),vocabularies,'ref',v=>v.vocabulary.vocabulary_version,'選択してください');fillSelect($('#buildVocabulary'),vocabularies,'ref',v=>v.vocabulary.vocabulary_version);if(priorAssets!==JSON.stringify([media.map(m=>m.video_id),vocabularies.map(v=>v.ref)]))editor?.refresh();inputState();
  }
  async function uploadVideo(file) {
    if(!file||file.size===0||!file.name.toLowerCase().endsWith('.mp4'))throw new Error('0バイトではないMP4動画を選んでください。');
    if(file.size>config.limits.max_upload_bytes)throw new Error('動画が登録上限を超えています。短い動画を選ぶか管理者へ確認してください。');
    const response=await fetch('/api/media',{method:'POST',headers:{'content-type':'video/mp4','x-display-name':encodeURIComponent(file.name),'x-local-token':state.session.token},body:file});
    const data=await response.json();if(!response.ok)throw new Error(data.message);
    await refreshInputs();return data;
  }
  async function selectVideo(file) {
    if(!file)return;
    pendingUploads++;inputState();
    try {const video=await uploadVideo(file);$('#registeredVideo').value=video.video_id;$('#consentConfirmed').checked=false;toast('動画をこのPCに登録しました。');}
    finally{pendingUploads--;$('#videoInput').value='';inputState();}
  }
  async function demo() {
    $('#demoInputButton').disabled=true;setStatus('running','合成サンプルを準備中','ローカルの再生用動画、お手本の記述、代表画像を作成します。');
    try{const d=await api('/api/demo-fixture',{});await refreshInputs();$('#registeredVideo').value=d.actual_video_id;$('#buildVocabulary').value=d.vocabulary_ref;editor?.refresh();$('#standardSet').value=d.standard_set_id;buildId=d.standard_set_id;activeRun=d.run_id;$('#setManager').hidden=false;await observe(d.run_id);if(sets.find(s=>s.standard_set_id===d.standard_set_id)?.status==='ready')await inspectSet(d.standard_set_id);inputState();}finally{$('#demoInputButton').disabled=false;}
  }
  async function start(reuse=false) {
    if(busy())return;
    inputState();if($('#startButton').disabled)return;
    submitting=true;inputState();
    try {
    const strategy=$('#analysisStrategy').value,set=effectiveSet(),compatible=result&&sameStage1Settings(result.execution,settings())&&((strategy==='vocabulary_guided')===(result.analysis_strategy==='vocabulary_guided'))&&result.input.video_id===$('#registeredVideo').value&&result.standard_set_id===(set?.standard_set_id??null);
    const request={client_request_id:crypto.randomUUID(),input_video_id:$('#registeredVideo').value,standard_set_id:set?.standard_set_id??null,vocabulary_ref:set?null:$('#vocabularySelect').value,discriminator_ref:null,analysis_strategy:strategy,analysis_mode:mode,settings:settings(),stage1_artifact_id:reuse&&compatible?result.stage1.artifact_id:null,parent_run_id:reuse&&result?result.run_id:null,comparison_session_id:null,consent_confirmed:$('#consentConfirmed').checked};
    if(hasUnsaved())await persistReview(false);
    const r=await api('/api/analysis-runs',request);localStorage.setItem('tas-active-run',r.run_id);await observe(r.run_id);
    }finally{submitting=false;inputState();}
  }
  const observe=createRunObserver({
    read:observeOnce,
    onConnected:()=>{$('#connectionStatus').textContent='画面の接続：正常';},
    onError:(error,failures)=>{$('#connectionStatus').textContent=failures?`画面の接続が途切れています（${failures}回）。最後の状態を表示中。自動で再確認します。サーバー上の処理状態は未確認です。`:'前回の実行がこの保存先に見つかりません。実行履歴から選び直してください。';}
  });
  async function observeOnce(runId,isCurrent) {
    const r=await api(`/api/analysis-runs/${runId}`);
    if(!isCurrent())return false;
    if(restoreObservedInputs){restoreObservedInputs=false;if(r.job_kind==='analysis'){$('#registeredVideo').value=r.input_video_id;$('#standardSet').value=r.standard_set_id??'';$('#vocabularySelect').value=r.vocabulary_ref??'';$('#analysisStrategy').value=r.analysis_strategy;mode=r.analysis_mode;restoreSettings(r.settings);modeTabs();}}
    activeRun=runId;localStorage.setItem('tas-active-run',runId);const activeUrl=new URL(location.href);activeUrl.searchParams.delete('new');window.history.replaceState(null,'',activeUrl);
    const presentation=runPresentation(r),ended=presentation.ended;state.running=!ended;state.startedAt=Date.parse(r.started_at??r.created_at);$('#cancelButton').hidden=ended;
    const elapsed=Math.floor((Date.parse(r.finished_at??new Date().toISOString())-state.startedAt)/1000);$('#elapsedText').textContent=`${Math.floor(elapsed/60).toString().padStart(2,'0')}:${(elapsed%60).toString().padStart(2,'0')}`;
    setStatus(presentation.kind,STATUS[r.status]??r.status,presentation.message);
    const phaseDetail=r.phase_history?.at(-1)?.detail;
    $('#activeRunSummary').textContent=`${r.job_kind==='standard_build'?`お手本セットの作成${phaseDetail?.source_index?`：${phaseDetail.source_index} / ${phaseDetail.source_count}本目`:''}`:r.job_kind==='vocabulary_extract'?'作業名一覧の抽出':`対象：${media.find(m=>m.video_id===r.input_video_id)?.display_name??r.input_video_id} ／ ${STRATEGIES[r.analysis_strategy]??''}`} ／ 受付 ${new Date(r.created_at).toLocaleString()}`;
    $('#resultLink').hidden=!r.result_available;
    $('#resultLink').textContent=r.result_available?'要確認の区間から結果を見る →':'結果を確認';
    $('#retryRun').hidden=!['failed','cancelled','interrupted'].includes(r.status);
    $('#retryRun').dataset.runId=runId;
    $('#cleanupStatus').dataset.pending=String(presentation.observe_cleanup);
    $('#cleanupStatus').textContent=`一時媒体：${CLEANUP[r.cleanup.cleanup_status]}${r.remote_outcome_unknown?' ／ リモート結果不明・猶予リースあり':''}`;
    if(r.job_kind==='standard_build'&&r.status==='awaiting_approval'){buildId=r.standard_set_id;await refreshInputs();$('#standardSet').value=buildId;$('#setManager').hidden=false;if(inspectedSet?.standard_set_id!==buildId||!inspectedSet.approval_available)await inspectSet(buildId);}
    if(r.job_kind==='vocabulary_extract'&&r.status==='awaiting_approval'){vocabularyRunId=r.run_id;const draft=await api(`/api/vocabulary-extractions/${r.run_id}`);$('#setManager').hidden=false;$('#vocabularyDraft').hidden=false;$('#vocabularyDraft').parentElement.open=true;$('#draftVocabulary').value=JSON.stringify(draft.vocabulary,null,2);$('#draftDiscriminators').value=JSON.stringify(draft.discriminators,null,2);}
    if(r.result_available&&result?.run_id!==runId)await openResult(runId,false);
    if(ended){await refreshInputs();if(!isCurrent())return false;await history();}
    inputState();
    return !ended||presentation.observe_cleanup;
  }
  async function cancel(){if(activeRun){await api(`/api/analysis-runs/${activeRun}/cancel`,{});await observe(activeRun);}}
  async function openResult(runId,restoreInputs=true,vocabularyRef=null) {
    const nextResult=await api(`/api/analysis-runs/${runId}/result`),nextDisplay=await api(`/api/analysis-runs/${runId}/display`);
    const set=nextResult.standard_set_id?await api(`/api/standard-sets/${nextResult.standard_set_id}/inspection`):null;
    const reviews=(await api(`/api/analysis-runs/${runId}/reviews`)).reviews;
    const savedReview=hasUnsaved()?await persistReview(false):null;
    if(savedReview?.original_run_id===runId)reviews.push(savedReview);
    if(hasUnsaved())throw new Error('保存中に新しい入力がありました。現在の入力を保存してから結果を開いてください。');
    if(result?.run_id!==runId)$('#reviewComment').value='';
    result=nextResult;resultSet=set;display=nextDisplay;review=reviews.at(-1)??null;state.labels=labels();
    state.result=result;state.prediction=structuredClone(display.prediction);state.reviewed=structuredClone(display.prediction);originalReview=review?.segments??result.segments;
    if(review)state.reviewed=review.segments.map(s=>{const d=display.prediction.find(x=>x.segment_id===s.segment_id);return {...(d??{work_content:'人による追加',hand_movement:'-',tools_and_parts:'-'}),segment_id:s.segment_id,start_time:secondsToTime(s.start_s),end_time:secondsToTime(s.end_s),duration_seconds:Math.floor(s.end_s)-Math.floor(s.start_s),job_no:s.job_no,job_title:s.job_title,page_number:s.page_number};});
    state.videoDuration=result.input.duration_s;state.demoInput=false;state.videoUrl=`/api/media/${result.input.video_id}/content`;$('#videoPlayer').src=state.videoUrl;$('#videoPlaceholder').hidden=true;
    state.predictionWarnings=result.segments.map(s=>s.review_reasons.map(k=>REVIEW_REASON_LABELS[k]));state.warnings=structuredClone(state.predictionWarnings);state.selected=0;state.view='reviewed';state.undoStack=[];state.redoStack=[];state.dirty=false;state.currentTime=0;state.timestamp=result.created_at;$('#workspace').hidden=false;
    standardExamples=set?.examples?.[result.analysis_strategy==='vocabulary_guided'?'guided':'unguided']??[];standardImages=set?.representative_images??[];
    const sources=standardSources(set);fillSelect($('#standardSource'),sources,'source_id',s=>s.name,'お手本を選択');$('#standardSource').value=sources[0]?.source_id??'';chooseResultSource();
    const hasComparison=Boolean(result.examples_used&&set&&sources.length);
    $('#workspace').classList.toggle('is-zero',!hasComparison);
    $('#resultModeChip').textContent=result.examples_used?'お手本と照合':'お手本なしで分析';
    const setLabels=resultSetLabels({examplesUsed:result.examples_used,set,sourceCount:sources.length});resultNote=setLabels.note;
    $('#resultSetChip').textContent=setLabels.chip;$('#resultSetChip').hidden=!set;
    const targetMedia=media.find(m=>m.video_id===result.input.video_id);
    $('#targetName').textContent=`${targetMedia?.display_name??result.input.video_id}（${secondsToTime(result.input.duration_s)}）`;
    $('#tab-diff').hidden=!hasComparison;diffSource='auto';state.filter='review';state.listPins=null;state.align='zero';state.detailMoreOpen=false;$('#evidenceDisclosure').open=false;
    $('#tab-st').hidden=hasComparison;stMode='average';
    if(!hasComparison)state.view='prediction';
    selectPanel(hasComparison?'diff':'st');
    $('#zeroAnalyticsDisclosure').hidden=hasComparison;$('#zeroAnalyticsDisclosure').open=false;
    $('.result-videos').setAttribute('aria-label',hasComparison?'お手本と対象の動画':'対象の動画');
    $('#resultAnalyticsDisclosure').hidden=!hasComparison;
    if(hasComparison)renderStandardCharts($('#resultAnalytics'),set,{actual:result,onSelect:(source,segment)=>{if(source.kind==='standard'){$('#standardSource').value=source.source_id;chooseResultSource();$('#standardPlayer').currentTime=segment.start_s;render();}else seek(segment.start_s);}});
    else $('#resultAnalytics').replaceChildren();
    $('#standardInferenceNotice').textContent=standardNotice(result.examples_used);
    reviewList=reviews;renderReviewHistory();
    if(restoreInputs){$('#standardSet').value=result.standard_set_id??'';$('#vocabularySelect').value=vocabularyRef??'';$('#registeredVideo').value=result.input.video_id;$('#analysisStrategy').value=result.analysis_strategy;$('#consentConfirmed').checked=false;mode=result.analysis_mode;restoreSettings(result.execution);}
    modeTabs();render();
  }
  function chooseResultSource() {
    if(result&&!result.examples_used){standardSegments=[];state.standardSegments=[];state.standardDuration=0;$('#standardPlayer').pause();$('#standardPlayer').removeAttribute('src');$('#standardPlayer').hidden=true;$('#standardRowLabel').textContent='';return;}
    const source=standardSources(resultSet).find(s=>s.source_id===$('#standardSource').value);
    standardSegments=source?.display_segments??[];state.standardSegments=standardSegments;state.standardDuration=source?.source_video.duration_s??0;lastStandardId=null;lastActualId=null;$('#standardRowLabel').textContent=source?.name??'';
    const player=$('#standardPlayer');player.pause();
    if(source&&source.video_available!==false){player.hidden=false;player.src=`/api/media/${source.source_video.video_id}/content`;}else{player.removeAttribute('src');player.hidden=true;}
    $('#syncStatus').textContent=source?.video_available===false?'お手本動画が見つかりません。集計と出典は保持しています。':'同じ作業名の区間へ移動します。独立再生も選べます。';
  }
  function restoreSettings(s){$('#processingMode').value=s.processing_mode;$('#inputFps').value=s.fps;$('#audioEnabled').checked=s.audio_enabled;$('#promptRelease').value=s.prompt_release;}
  function modeTabs(){for(const [sel,value]of [['#fewShotTab','few_shot'],['#zeroShotTab','zero_shot']]){const active=mode===value;$(sel).classList.toggle('active',active);$(sel).setAttribute('aria-pressed',String(active));}inputState();}
  function exactReviewed() {
    return state.reviewed.map(s=>{const original=originalReview.find(x=>x.segment_id===s.segment_id)??result.segments.find(x=>x.segment_id===s.segment_id);return {segment_id:s.segment_id??(s.segment_id=`human-${crypto.randomUUID()}`),start_s:original&&s.start_time===secondsToTime(original.start_s)?original.start_s:timeToSeconds(s.start_time),end_s:original&&s.end_time===secondsToTime(original.end_s)?original.end_s:timeToSeconds(s.end_time),job_no:s.job_no,job_title:s.job_title,page_number:s.page_number};});
  }
  function renderReviewHistory() {
    $('#reviewHistory').textContent=reviewList.length?`修正履歴 ${reviewList.length}件（新しい順）`:'人による確認はまだ保存されていません。';
    $('#reviewHistoryList').innerHTML=reviewList.slice().reverse().map(r=>`<li><span class="meta">${esc(new Date(r.created_at).toLocaleString())} ／ 確認者：${esc(r.editor)}</span><p class="memo${r.comment?'':' empty'}">${r.comment?esc(r.comment):'（メモなし）'}</p></li>`).join('');
    $('#memoCount').textContent=reviewList.length?String(reviewList.length):'';
  }
  async function persistReview(show=true) {if(!result)return null;const stop=pendingDetailStop();if(stop)throw new Error(`保存しませんでした。${stop}`);const segments=exactReviewed(),saving=JSON.stringify(state.reviewed),comment=$('#reviewComment').value;review=await api(`/api/analysis-runs/${result.run_id}/reviews`,{editor:$('#reviewEditor').value,comment,original_result_sha256:display.original_result_sha256,segments});state.dirty=JSON.stringify(state.reviewed)!==saving;originalReview=review.segments;$('#reviewComment').value=memoAfterSave(comment,$('#reviewComment').value);renderDirty();reviewList=[...reviewList,review];renderReviewHistory();renderDiff();renderZero();if(show)toast('自動判定を残したまま、修正を履歴に保存しました。');return review;}
  async function download(type) {if(!result)return;const data=type==='reviewed'?await persistReview(false):result,a=document.createElement('a');a.href=type==='reviewed'?`/api/analysis-runs/${result.run_id}/reviews/${data.review_id}?download=1`:`/api/analysis-runs/${result.run_id}/result?download=1`;a.download=`${result.mock?'MOCK_':''}${result.run_id}_${type}.json`;document.body.append(a);a.click();a.remove();toast(`${type==='reviewed'?'修正後':'自動判定'}JSONを出力しました。`);}
  function extras() {
    if(!result)return;
    const globalWarningsText=(result.warnings??[]).filter(w=>w.code==='MISSING_PROCESS').map(w=>`動画全体の確認事項（自動判定）：${w.message}`).join('\n');
    $('#globalWarnings').textContent=globalWarningsText;$('#globalWarnings').hidden=!globalWarningsText;
    $('#mockResultWarning').hidden=!result.mock;$('#mockResultBadge').hidden=!result.mock;
    $('#resultIdentity').textContent=`${STRATEGIES[result.analysis_strategy]} ／ ${result.segments.filter(s=>s.review_required).length}区間が要確認 ／ 費用：${costText(result.metrics_runtime.cost)} ／ 実行 ${new Date(result.created_at).toLocaleString()}`;
    if(resultNote){const note=document.createElement('span');note.className='identity-note';note.textContent=resultNote;$('#resultIdentity').append(note);}
    const pending=result.segments.filter(s=>s.review_required).length;
    $('#firstPending').textContent=pending?`要確認 ${pending}区間から見る`:'先頭区間を見る';
    $('#reviewCount').textContent=pending?`要確認 ${pending}`:'';
    $('#memoCount').textContent=reviewList.length?String(reviewList.length):'';
    renderDiff();renderZero();
    const shown=(state.view==='prediction'?state.prediction:state.reviewed)[state.selected],s=result.segments.find(x=>x.segment_id===shown?.segment_id);const panel=$('#evidencePanel');
    const form=$('#detailForm');if(form&&state.view==='reviewed'&&!state.formDirty)labelSelector(form,shown.job_no);
    if(!s){panel.textContent='人が追加した区間です。自動判定の候補はありません。';return;}
    panel.innerHTML=`<h3>候補・観察根拠</h3><p>${s.review_required?'要確認':'要確認ではない（人の承認ではありません）'}：${s.review_reasons.map(k=>esc(k==='quality_warning'?'動画全体・区間の確認事項あり（具体的な説明を参照）':REVIEW_REASON_LABELS[k])).join(' ／ ')||'確認理由なし'}</p><p>生の確信度 ${s.confidence_raw.toFixed(2)} ／ 表示用 ${s.confidence.toFixed(2)}${s.forced_low_confidence?' ／ 同着による強制低下':''}</p><p>${esc(s.adoption_reason)}</p><ul>${s.candidates.map(c=>`<li><strong>${esc(c.job_no)} ${esc(c.job_title)} ／ ${c.score.toFixed(2)}</strong><p>${esc(c.reason)}</p></li>`).join('')}</ul><details><summary>採用根拠の参照</summary><pre>${esc(JSON.stringify(s.evidence_refs,null,2))}</pre></details><details><summary>共通Observationの全項目</summary><pre>${esc(JSON.stringify(s.observation,null,2))}</pre></details>`;
    const refMarkup=ref=>{if(ref.kind==='standard_image'){const image=standardImages.find(i=>i.image_id===ref.image_id);return image?`<figure><img class="evidence-image" src="/api/standard-images/${result.standard_set_id}/${image.image_id}" alt="根拠として参照されたお手本の画像"><figcaption>お手本 ${image.extracted_time_s.toFixed(2)}秒 ／ ${esc(image.image_id)}</figcaption></figure>`:'お手本の画像を確認できません。';}if(ref.kind==='actual_video')return `<button type="button" class="icon-button evidence-seek" data-second="${ref.start_s}">対象動画 ${ref.start_s.toFixed(2)}〜${ref.end_s.toFixed(2)}秒を確認</button>`;const obs=ref.kind==='example'?standardExamples.find(e=>e.example_id===ref.example_id)?.observation:s.observation;const ev=obs?.evidence.find(e=>e.evidence_id===ref.evidence_id);return `<p>${ref.kind==='example'?'お手本の観察':'対象動画の観察'}：${esc(obs?.[ref.field]?.value??'不明')}<br>${esc(ev?.description??'根拠を確認できません。')} ${ev?`（${ev.start_s.toFixed(2)}〜${ev.end_s.toFixed(2)}秒）`:''}</p>`;};
    const readable=document.createElement('div');readable.className='readable-evidence';readable.innerHTML=`<h3>参照された映像・記述</h3>${s.evidence_refs.map(refMarkup).join('')}<details><summary>候補ごとの根拠</summary>${s.candidates.map(c=>`<h4>${esc(c.job_no)} ${esc(c.job_title)}</h4>${c.evidence_refs.map(refMarkup).join('')}`).join('')}</details>`;panel.append(readable);readable.querySelectorAll('.evidence-seek').forEach(b=>b.addEventListener('click',()=>seek(Number(b.dataset.second))));

  }
  function renderDiff() {
    for(const b of document.querySelectorAll('[data-diff-source]'))b.setAttribute('aria-checked',String(b.dataset.diffSource===diffSource));
    if(!(result?.examples_used&&state.standardSegments.length)){$('#diffTable').replaceChildren();$('#diffSourceLabel').textContent='';$('#diffContext').textContent='';return;}
    const label=$('#diffSourceLabel');label.dataset.source=diffSource;label.textContent=diffSource==='auto'?'表示中：自動判定（今回の分析の結果。人の修正は含みません）':`表示中：修正後（画面上の最新の修正${state.dirty||state.formDirty?'。未保存の修正を含みます':''}${reviewList.length?`。保存 ${reviewList.length}回`:''}。自動判定は変わりません）`;
    const target=diffSource==='auto'?result.segments:exactReviewed();
    const {rows,total}=timeDifferences(state.standardSegments,target,labels());
    $('#diffContext').textContent=`比べるお手本：${standardSources(resultSet).find(s=>s.source_id===$('#standardSource').value)?.name??''}`;
    const selectedJobNo=(state.view==='prediction'?state.prediction:state.reviewed)[state.selected]?.job_no;
    const maxDiff=Math.max(1,...rows.map(r=>Math.abs(r.diff_s??0)));
    const delta=diff=>diff===null?'<span>—</span>':`<i class="bar" data-width="${Math.max(2,Math.round(Math.abs(diff)/maxDiff*48))}px"></i><span>${signed(diff)}</span>`;
    $('#diffTable').innerHTML=`<div class="diff-head" role="row"><span role="columnheader">工程（差の大きい順）</span><span class="diff-num" role="columnheader">お手本</span><span class="diff-num" role="columnheader">対象</span><span class="diff-num" role="columnheader">差（対象−お手本）</span></div>`+rows.map(r=>`<div class="diff-row" role="row" data-job="${esc(r.job_no)}" aria-current="${r.job_no===selectedJobNo}"><span class="diff-job" role="rowheader"><button type="button" class="diff-pick"><b>${esc(r.job_title)}</b><small>No.${esc(r.job_no)}${r.kind==='non_work'?' · 作業外':r.st_s!=null?` · ST ${sec(r.st_s)}`:''}</small></button></span><span class="diff-num" role="cell">${r.standard_s===null?'該当なし':sec(r.standard_s)}</span><span class="diff-num" role="cell">${r.target_s===null?'該当なし':sec(r.target_s)}</span><span class="diff-delta${r.diff_s>0?' plus':r.diff_s<0?' minus':''}" role="cell">${delta(r.diff_s)}</span></div>`).join('')+`<div class="diff-total" role="row"><span role="rowheader">合計（全区間）</span><span class="diff-num" role="cell">${sec(total.standard_s)}</span><span class="diff-num" role="cell">${sec(total.target_s)}</span><span class="diff-delta${total.diff_s>0?' plus':total.diff_s<0?' minus':''}" role="cell"><span>${signed(total.diff_s)}</span></span></div>`;
    $('#diffTable').querySelectorAll('.bar').forEach(bar=>{bar.style.width=bar.dataset.width;});
  }
  function renderZero() {
    if(!result || !$('#workspace').classList.contains('is-zero'))return;
    const auto=state.view==='prediction';
    const source=auto?'auto':'reviewed';
    for(const button of document.querySelectorAll('[data-st-source]'))button.setAttribute('aria-checked',String(button.dataset.stSource===source));
    for(const button of document.querySelectorAll('[data-st-mode]'))button.setAttribute('aria-checked',String(button.dataset.stMode===stMode));
    const description=auto?'表示中：自動判定（人の修正は含みません）':`表示中：修正後（区間に反映した修正${state.dirty?'。未保存の修正を含みます':''}。保存 ${reviewList.length}回。自動判定は変わりません）`;
    for(const selector of ['#stSourceLabel','#zeroSourceLabel']){$(selector).textContent=description;$(selector).dataset.source=source;}
    renderStViews({table:$('#stTable'),summary:$('#stSummary'),missing:$('#stMissing'),analytics:$('#zeroAnalytics'),segments:auto?result.segments:exactReviewed(),labels:labels(),mode:stMode,selectedId:(auto?state.prediction:state.reviewed)[state.selected]?.segment_id});
  }
  function focusStRow(row) {
    const stop=pendingDetailStop();if(stop){toast(stop);return;}
    const auto=state.view==='prediction',segments=auto?result.segments:exactReviewed();
    const target=comparisonTarget(segments,{job_no:row.dataset.stJob,segment_id:row.dataset.stSegment},state.currentTime);
    if(!target)return;
    const index=(auto?state.prediction:state.reviewed).findIndex(segment=>segment.segment_id===target.segment_id);
    selectSegment(index);seek(target.start_s);
  }
  const places={new:['新しい分析','.analysis-launch','#inputTitle'],history:['実行履歴','.history-card','#historyTitle'],library:['お手本ライブラリ','#setManager','#setManagerTitle'],result:['分析結果','#workspace','#resultHeading']};
  function showPlace(place) {
    const [name,section,heading]=places[place];if($(section).hidden)return;
    currentPlace=place;document.title=`${name}｜作業みえる`;
    for(const entry of document.querySelectorAll('[data-place],#openLibrary')){if((entry.dataset.place??'library')===place)entry.setAttribute('aria-current','location');else entry.removeAttribute('aria-current');}
    $(section).scrollIntoView({block:'start'});$(heading).focus({preventScroll:true});
    const url=new URL(location.href);url.hash=place==='library'?'library':heading.slice(1);window.history.replaceState(null,'',url);
  }
  function setSyncStatus(text,warn=false){$('#syncStatus').textContent=text;$('#syncStatus').classList.toggle('warn',warn);}
  function focusJob(jobNo) {
    const viewSegments=state.view==='prediction'?state.prediction:state.reviewed;
    const targets=viewSegments.map(s=>({segment_id:s.segment_id,start_s:timeToSeconds(s.start_time),end_s:timeToSeconds(s.end_time),job_no:s.job_no,job_title:s.job_title}));
    const target=matchingSegment(targets,jobNo,$('#videoPlayer').currentTime),standard=matchingSegment(state.standardSegments,jobNo,$('#standardPlayer').currentTime);
    const title=labels().find(l=>l.job_no===jobNo)?.job_title??jobNo;
    syncBusy=true;
    if(target){lastActualId=target.segment_id;selectSegment(viewSegments.findIndex(s=>s.segment_id===target.segment_id));}
    if(standard){lastStandardId=standard.segment_id;if(!$('#standardPlayer').hidden)$('#standardPlayer').currentTime=standard.start_s;}
    if(!target)setSyncStatus(`対象に「${title}」の区間はありません。お手本だけ移動しました。`,true);
    else if(!standard)setSyncStatus(`対応区間なし：お手本に「${title}」の区間はありません。対象だけ移動しました。`,true);
    else setSyncStatus(`「${title}」の区間へ両方の動画を移動しました（対象 ${secondsToTime(target.start_s)}／お手本 ${secondsToTime(standard.start_s)}）`,false);
    setTimeout(()=>{syncBusy=false;},150);
  }
  function syncFrom(side,segment) {
    if(syncBusy||!$('#syncPlayback').checked)return;
    const target=side==='standard'?exactReviewed():standardSegments,player=side==='standard'?$('#videoPlayer'):$('#standardPlayer');const matching=matchingSegment(target,segment.job_no,player.currentTime);
    if(!matching){setSyncStatus(`対応区間なし：${segment.job_no} ${segment.job_title}`,true);return;}
    syncBusy=true;player.currentTime=matching.start_s;if(side==='standard'){state.currentTime=matching.start_s;seek(matching.start_s);lastActualId=matching.segment_id;}else lastStandardId=matching.segment_id;
    setSyncStatus(`区間同期：${segment.job_no} ${segment.job_title} ／ ${matching.start_s.toFixed(2)}秒へ移動`,false);setTimeout(()=>{syncBusy=false;},100);
  }
  async function history() {
    const runs=(await api('/api/analysis-runs')).runs;const list=$('#historyList');list.replaceChildren();
    if(!runs.length){list.innerHTML='<div class="empty-state"><h3>実行履歴はまだありません</h3><p>分析すると、結果をここから開けます。</p><a class="button secondary" href="#inputTitle" data-place="new">新しい分析へ</a></div>';return;}
    for(const r of runs){const row=document.createElement('div');row.className='history-row';row.innerHTML=`<div><strong>${esc(new Date(r.created_at).toLocaleString())} ／ ${esc(STATUS[r.status])}</strong><p>${r.job_kind==='vocabulary_extract'?'作業標準書から作業名一覧を抽出':r.job_kind==='standard_build'?'お手本セット作成':`${esc(STRATEGIES[r.analysis_strategy])} ／ ${r.analysis_mode==='few_shot'?'お手本と照合':'お手本なしで分析'}`} ／ 要確認 ${r.review_count??'—'} ／ 費用：${esc(costText(r.cost))}</p><small>${esc(r.settings.stage1_model)} ／ セット ${esc(sets.find(s=>s.standard_set_id===r.standard_set_id)?.name??r.standard_set_id??'なし')}<br>Stage1 ${esc(r.stage1?.artifact_id??'未作成')} ／ 共有元 ${esc(r.stage1?.producer_run_id??'なし')}<br>一時媒体：${esc(CLEANUP[r.cleanup.cleanup_status])}</small></div>`;
      const actions=document.createElement('div');actions.className='action-row';const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.className='icon-button';b.textContent=text;b.addEventListener('click',safely(fn));actions.append(b);};
      button(r.result_available?'結果を開く':'状態を開く',async()=>{if(hasUnsaved())await persistReview(false);if(r.result_available)await openResult(r.run_id,true,r.vocabulary_ref);await observe(r.run_id);showPlace(r.result_available?'result':'new');});
      if(['failed','cancelled','interrupted'].includes(r.status))button('再試行',async()=>{const n=await api(`/api/analysis-runs/${r.run_id}/retry`,{client_request_id:crypto.randomUUID()});await observe(n.run_id);});
      if(['retry_wait','cleanup_failed'].includes(r.cleanup.cleanup_status))button('削除を再試行',async()=>{await api(`/api/analysis-runs/${r.run_id}/cleanup-retry`,{});await history();});
      row.append(actions);list.append(row);
    }
  }
  async function inspectSet(setId) {
    const s=await api(`/api/standard-sets/${setId}/inspection`);inspectedSet=s;buildId=setId;$('#librarySet').value=setId;$('#buildInspectionConfirmed').checked=false;
    const sources=standardSources(s),panel=$('#setInspection');
    panel.innerHTML=`<h3>${esc(s.name)} ／ ${esc(setStatusText(s))}</h3><p>お手本 ${sources.length}本 ／ 作業名一覧 ${esc(s.vocabulary.vocabulary_version)} ／ 代表画像 ${s.representative_images.length}枚${s.media_state?.images_missing?`（${s.media_state.images_missing}枚が削除・欠落）`:''}</p>${sources.map(source=>`<details class="set-source-inspection"><summary>${esc(source.name)} · ${source.source_video.duration_s}秒 · ${source.display_segments.length}区間</summary><p class="hint">出典動画ID：${esc(source.source_video.video_id)}<br>SHA-256：${esc(source.source_video.sha256)}</p>${source.video_available===false?'<p>原本動画が見つかりません。記述・出典は残っています。</p>':`<video class="source-player" src="/api/media/${source.source_video.video_id}/content" controls preload="metadata"></video>`}${['unguided','guided'].map(profile=>`<h4>${profile==='unguided'?'案1・3用の記述':'案2用の記述'}</h4>${(s.examples?.[profile]??[]).filter(e=>e.source_id?e.source_id===source.source_id:source.source_video.video_id===s.source_video.video_id).map(e=>`<div class="observation-copy"><strong>${esc(e.label.job_no)} ${esc(e.label.job_title)}</strong><p>${esc(e.observation.operation.value??'観察できませんでした')}</p><p>${e.observation.insufficient_discriminative_features?`特徴不足の自己申告：${e.observation.insufficiency_reasons.map(esc).join(' ／ ')}`:'特徴不足の自己申告なし（精度保証ではありません）'}</p><small>出典：${esc(source.name)} ／ 区間 ${esc(e.segment_id)} ／ お手本ID ${esc(e.example_id)}</small><details><summary>すべての観察項目・根拠を確認</summary><pre>${esc(JSON.stringify(e.observation,null,2))}</pre></details></div>`).join('')||'<p>この方式の記述は生成されていません。</p>'}`).join('')}<div class="frame-grid">${s.representative_images.filter(i=>i.source_video_id===source.source_video.video_id).map(i=>`<figure>${i.available===false?'<p>画像は削除・欠落しています</p>':`<img src="/api/standard-images/${setId}/${i.image_id}" alt="${esc(source.name)} ${esc(i.segment_id)} ${i.extracted_time_s}秒">`}<figcaption>${esc(source.name)} ／ ${esc(i.segment_id)} ／ ${i.extracted_time_s.toFixed(2)}秒<br>お手本ID ${esc(i.example_id)}</figcaption></figure>`).join('')}</div></details>`).join('')}`;
    renderStandardCharts($('#standardAnalytics'),s);
    $('#approveSetButton').disabled=true;$('#retireSetButton').disabled=s.status!=='ready';
    $('#approveSetButton').hidden=!s.approval_available;$('#buildInspectionConfirmed').closest('label').hidden=!s.approval_available;$('#setReviewer').closest('label').hidden=!s.approval_available;$('#retireSetButton').hidden=s.status!=='ready';
    $('.approval-area').hidden=!s.approval_available&&s.status!=='ready';
    if(s.approval_available)$('#buildEditor').open=false;
  }
  async function openLibrary() {if(currentPlace!=='library')libraryReturnPlace=currentPlace;$('#setManager').hidden=false;if($('#standardSet').value)await inspectSet($('#standardSet').value);if(!$('#librarySet').value&&!sets.length)$('#setInspection').innerHTML='<div class="empty-state"><h3>お手本はまだありません</h3><p>お手本を登録するか、お手本なしで分析できます。</p><button class="button secondary" type="button" id="emptyRegisterSet">お手本を登録</button></div>';$('#emptyRegisterSet')?.addEventListener('click',()=>{$('#buildEditor').open=true;$('#setName').focus();});showPlace('library');}
  async function readFile(input){const file=$(input).files[0];if(!file)throw new Error('必要なJSONファイルを選択してください。');return JSON.parse(await file.text());}
  async function initialize() {
    state.session=await api('/api/session');config=await api('/api/config');$('#modeBadge').textContent=config.mode==='mock'?'合成モック · 映像は解析しません':'Google Cloud · 業務精度は未検証';$('#demoInputButton').hidden=config.mode!=='mock';await refreshInputs();await history();
    editor=createStandardEditor({$,api,uploadVideo,getMedia:()=>media,getVocabularies:()=>vocabularies,settings,getConfig:()=>config,getBusy:busy,onBusy:value=>{pendingUploads+=value?1:-1;inputState();},onCreated:async run=>{buildId=run.standard_set_id;localStorage.setItem('tas-active-run',run.run_id);await observe(run.run_id);}});editor.reset();$('.approval-area').hidden=true;$('#pdfDestination').textContent=config.mode==='mock'?'合成モック：PDFはこのPCに保存します。外部通信はありません。':`送信先：Google Cloud / ${config.settings.project} / ${config.settings.location}。作業標準書PDFを送信して作業名を抽出します。`;inputState();
    $('#rerunStage2').addEventListener('click',safely(()=>start(true)));$('#saveReviewButton').addEventListener('click',safely(()=>persistReview()));$('#refreshHistory').addEventListener('click',safely(history));
    $('#retryRun').addEventListener('click',safely(async()=>{const id=$('#retryRun').dataset.runId;if(!id)return;const n=await api(`/api/analysis-runs/${id}/retry`,{client_request_id:crypto.randomUUID()});await observe(n.run_id);}));
    const beginReview=()=>{
      showPlace('result');
      selectPanel('segments');state.filter='review';state.listPins=null;
      const firstFlagged=result?.segments.find(s=>s.review_required);
      const viewSegments=state.view==='prediction'?state.prediction:state.reviewed;
      const index=firstFlagged?viewSegments.findIndex(s=>s.segment_id===firstFlagged.segment_id):-1;
      selectSegment(Math.max(0,index));
      if(!isStackedLayout()){$('#segmentList .segment-row.selected')?.focus({preventScroll:true});$('#workspace').scrollIntoView({block:'start'});return;}
      const field=$('#detailForm [name=job_no]:not(:disabled)')??$('#segmentList .segment-row.selected');
      $('#workspace > .result-panel').scrollIntoView({block:'start'});field?.focus({preventScroll:true});field?.scrollIntoView({block:'nearest'});
    };
    $('#firstPending').addEventListener('click',beginReview);
    $('#resultLink').addEventListener('click',event=>{if(!result)return;event.preventDefault();beginReview();});
    for(const b of document.querySelectorAll('[data-diff-source]'))b.addEventListener('click',()=>{diffSource=b.dataset.diffSource;renderDiff();});
    for(const button of document.querySelectorAll('[data-st-source]'))button.addEventListener('click',()=>{const stop=pendingDetailStop();if(stop){toast(stop);return;}switchView(button.dataset.stSource==='auto'?'prediction':'reviewed');});
    for(const button of document.querySelectorAll('[data-st-mode]'))button.addEventListener('click',()=>{stMode=button.dataset.stMode;renderZero();});
    for(const selector of ['#stTable','#zeroAnalytics'])$(selector).addEventListener('click',event=>{const row=event.target.closest('[data-st-job]');if(row)focusStRow(row);});
    document.addEventListener('click',event=>{const entry=event.target.closest('[data-place]');if(entry){event.preventDefault();showPlace(entry.dataset.place);}});
    $('#diffTable').addEventListener('click',event=>{const row=event.target.closest('.diff-row');if(row)focusJob(row.dataset.job);});
    $('#extractVocabulary').addEventListener('click',safely(async()=>{if(!$('#pdfConsent').checked)throw new Error('作業標準書の送信範囲を確認してください。');const file=$('#vocabularyPdf').files[0];if(!file)throw new Error('作業標準書PDFを選択してください。');const response=await fetch('/api/media',{method:'POST',headers:{'content-type':'application/pdf','x-display-name':encodeURIComponent(file.name),'x-local-token':state.session.token},body:file});const pdf=await response.json();if(!response.ok)throw new Error(pdf.message);const run=await api('/api/vocabulary-extractions',{client_request_id:crypto.randomUUID(),pdf_asset_id:pdf.asset_id,settings:settings(),consent_confirmed:$('#pdfConsent').checked});await observe(run.run_id);}));
    $('#approveVocabulary').addEventListener('click',safely(async()=>{const vocabulary=JSON.parse($('#draftVocabulary').value),discriminators=JSON.parse($('#draftDiscriminators').value);discriminators.approved_by=$('#setReviewer').value;discriminators.approved_at=new Date().toISOString();const v=await api(`/api/vocabulary-extractions/${vocabularyRunId}/approve`,{vocabulary,discriminators,approved_by:$('#setReviewer').value});await refreshInputs();$('#buildVocabulary').value=v.ref;editor?.refresh();$('#vocabularyDraft').hidden=true;await history();toast('作業標準書の作業名一覧と識別条件を確認済みとして登録しました。');}));
    $('#fewShotTab').addEventListener('click',()=>{mode='few_shot';modeTabs();});$('#zeroShotTab').addEventListener('click',()=>{mode='zero_shot';modeTabs();});
    for(const sel of ['#standardSet','#registeredVideo','#vocabularySelect','#analysisStrategy','#processingMode','#inputFps','#audioEnabled','#promptRelease','#consentConfirmed'])$(sel).addEventListener('change',inputState);
    $('#manageSets').addEventListener('click',safely(openLibrary));$('#openLibrary').addEventListener('click',safely(openLibrary));$('#closeSetManager').addEventListener('click',()=>{$('#setManager').hidden=true;showPlace(libraryReturnPlace);});
    $('#registerVocabulary').addEventListener('click',safely(async()=>{const r=await api('/api/vocabularies',{vocabulary:await readFile('#vocabularyFile'),discriminators:await readFile('#discriminatorFile'),approved_by:$('#setReviewer').value});await refreshInputs();$('#buildVocabulary').value=r.ref;editor?.refresh();toast('作業名一覧・識別条件を登録しました。');}));
    $('#approveSetButton').addEventListener('click',safely(async()=>{if(!inspectedSet?.approval_available||!$('#buildInspectionConfirmed').checked)return;await api(`/api/standard-sets/${buildId}/approve`,{approved_by:$('#setReviewer').value});await refreshInputs();$('#standardSet').value=buildId;await inspectSet(buildId);await history();inputState();setStatus('done','お手本セットを公開しました','対象動画と方式を選び、同意欄を確認して分析を開始できます。');}));
    $('#retireSetButton').addEventListener('click',safely(async()=>{const setId=$('#librarySet').value;await api(`/api/standard-sets/${setId}/retire`,{});await refreshInputs();await inspectSet(setId);toast('セットの新規利用を停止しました。実行履歴は残ります。');}));
    $('#standardSource').addEventListener('change',()=>{chooseResultSource();render();});
    $('#librarySet').addEventListener('change',safely(async()=>{if($('#librarySet').value){await inspectSet($('#librarySet').value);$('#buildEditor').open=false;}else{$('#setInspection').replaceChildren();$('#standardAnalytics').replaceChildren();$('.approval-area').hidden=true;$('#buildEditor').open=true;}}));
    $('#buildInspectionConfirmed').addEventListener('change',()=>{$('#approveSetButton').disabled=!inspectedSet?.approval_available||!$('#buildInspectionConfirmed').checked;});
    $('#newSetDraft').addEventListener('click',()=>{$('#librarySet').value='';$('#setInspection').replaceChildren();$('#standardAnalytics').replaceChildren();$('.approval-area').hidden=true;$('#buildEditor').open=true;editor.refresh();$('#setName').focus();});
    $('#registeredVideo').addEventListener('change',()=>{$('#videoInput').value='';$('#consentConfirmed').checked=false;inputState();});
    $('#standardPlayer').addEventListener('error',()=>{$('#standardPlayer').hidden=true;$('#syncStatus').textContent='お手本動画を再生できません。保存状態を確認してください。';});
    $('#standardPlayer').addEventListener('timeupdate',()=>{const t=$('#standardPlayer').currentTime,s=standardSegments.find(s=>s.start_s<=t&&t<s.end_s);if(s&&s.segment_id!==lastStandardId){lastStandardId=s.segment_id;syncFrom('standard',s);}});
    $('#videoPlayer').addEventListener('timeupdate',()=>{if(!result)return;const t=$('#videoPlayer').currentTime,s=exactReviewed().find(s=>s.start_s<=t&&t<s.end_s);if(s&&s.segment_id!==lastActualId){lastActualId=s.segment_id;syncFrom('actual',s);}});
    const params=new URLSearchParams(location.search),running=params.has('new')?null:localStorage.getItem('tas-active-run');if(running)try{restoreObservedInputs=true;await observe(running);}catch{localStorage.removeItem('tas-active-run');}
    if(location.hash==='#library')await openLibrary();
    else if(location.hash==='#historyTitle')showPlace('history');
    else if(!$('#workspace').hidden&&!params.has('new'))showPlace('result');
    window.addEventListener('hashchange',()=>{const place=location.hash==='#historyTitle'?'history':location.hash==='#inputTitle'?'new':location.hash==='#workspace'?'result':null;if(place)showPlace(place);else if(location.hash==='#library')safely(openLibrary)();});
  }
  return {inputState,selectVideo:safely(selectVideo),demo:safely(demo),start:safely(start),cancel:safely(cancel),download:safely(download),initialize:safely(initialize),extras,warnings,prepareAdd:()=>labelSelector($('#addForm')),seekStandard:s=>{$('#standardPlayer').currentTime=s.start_s;syncFrom('standard',s);}};
}
