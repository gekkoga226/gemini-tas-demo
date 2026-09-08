import {createRunObserver} from './run-observer.js';
import {secondsToTime,timeToSeconds,matchingSegment,REVIEW_REASON_LABELS,validateSegments} from './segments.js';
const STRATEGIES={text_only:'案1：項目化した文章照合',vocabulary_guided:'案2：語彙補助の文章照合',visual_evidence:'案3：映像根拠併用'};
const STATUS={queued:'受付',preparing:'準備',uploading:'送信',stage1_running:'区間分割',stage1_ready:'区間分割保存済み',stage2_running:'ラベル照合',validating:'結果検証',persisting:'保存',retry_wait:'再試行待ち',succeeded:'完了',failed:'失敗',cancel_requested:'中断要求済み',cancelled:'中断',interrupted:'前回処理の中断',awaiting_approval:'内容の確認待ち'};
const CLEANUP={not_needed:'対象なし',pending:'削除待ち',waiting_lease:'参照・猶予期間の終了待ち',deleting:'削除中',retry_wait:'削除失敗・再試行待ち',deleted:'削除完了',cleanup_failed:'削除が24時間以上未完了・対応が必要'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const costText=c=>c?.total===null||c?.total===undefined?'不明（未測定／内訳不足）':`${Number(c.total).toFixed(4)} ${c.currency??''}（${c.cost_status==='estimated'?'概算':'追加APIなし'}）`;
export function createWorkflow({state,$,render,setStatus,toast,renderDirty,seek,applyPendingDetail}) {
  let config=null,sets=[],media=[],vocabularies=[],mode='few_shot',activeRun=null,result=null,display=null,review=null,buildId=null,originalReview=[];
  let standardSegments=[],standardExamples=[],standardImages=[],lastStandardId=null,lastActualId=null,syncBusy=false;
  let vocabularyRunId=null;
  async function api(url,body,method) {const response=await fetch(url,{method:method||(body?'POST':'GET'),headers:body?{'content-type':'application/json','x-local-token':state.session.token}:{},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok){const error=new Error(`${data.message} (${data.code})`);error.status=response.status;throw error;}return data;}
  const safely=fn=>async(...args)=>{try{await fn(...args);}catch(e){toast(e.message);setStatus('error','操作を完了できません',e.message);}};
  function settings() {return {...config.settings,processing_mode:$('#processingMode').value,fps:Number($('#inputFps').value),audio_enabled:$('#audioEnabled').checked,prompt_release:$('#promptRelease').value};}
  function sameStage1Settings(a,b){return ['stage1_model','model_revision_scope','project','location','host','api_version','processing_mode','audio_enabled','fps','media_resolution','prompt_release','stage1_generation_config'].every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));}
  function labels(){return (sets.find(x=>x.standard_set_id===result?.standard_set_id)?.vocabulary??vocabularies.find(v=>v.vocabulary.vocabulary_version===result?.versions.vocabulary.version)?.vocabulary)?.labels??[];}
  function labelSelector(form,value){const input=form.elements.job_no,select=document.createElement('select');select.name='job_no';labels().forEach(l=>select.add(new Option(`${l.job_no} ${l.job_title}`,l.job_no)));select.value=value||labels()[0]?.job_no;input.replaceWith(select);form.elements.job_title.readOnly=true;form.elements.page_number.readOnly=true;const choose=()=>{const l=labels().find(l=>l.job_no===select.value);if(l){form.elements.job_title.value=l.job_title;form.elements.page_number.value=l.page_number;}};select.addEventListener('change',choose);choose();}
  function warnings(){const shown=state.view==='prediction'?state.prediction:state.reviewed,structural=validateSegments(shown,state.videoDuration);state.warnings=shown.map((s,i)=>[...new Set([...(structural[i]||[]),...(result?.segments.find(x=>x.segment_id===s.segment_id)?.review_reasons??[]).filter(r=>r!=='quality_warning').map(r=>`推論原本：${REVIEW_REASON_LABELS[r]}`),...(result?.warnings??[]).filter(w=>w.segment_ids.includes(s.segment_id)).map(w=>w.code==='MISSING_PROCESS'?'推論原本：工程抜けの候補があります。動画全体の確認事項を参照してください。':`推論原本：${w.message}`)])]);}
  function inputState() {
    if(!config)return;
    const set=sets.find(s=>s.standard_set_id===$('#standardSet').value),strategy=$('#analysisStrategy').value,video=media.find(m=>m.video_id===$('#registeredVideo').value);
    const profile=strategy==='vocabulary_guided'?'guided':'unguided';
    const available=(mode==='zero_shot'&&!set?Boolean($('#vocabularySelect').value):set?.status==='ready'&&set.description_profiles[profile]&&(strategy!=='visual_evidence'||mode==='zero_shot'||set.representative_images.length>0));
    $('#startButton').disabled=state.running||!video||!available||!$('#consentConfirmed').checked||!config.ready;
    $('#inputSummary').textContent=!config.ready?config.checks.filter(c=>!c.ok).map(c=>c.message).join(' '):!available?'利用可能な公開セット／語彙を選択してください。必要な記述・画像は「標準セットを作成・確認」から生成できます。':video?`${video.display_name} ／ ${secondsToTime(video.duration_s)} ／ ${mode==='few_shot'?'お手本あり':'お手本なし'} ／ ${STRATEGIES[strategy]}`:'実作業動画を登録・選択してください。';
    const rerunCompatible=result&&sameStage1Settings(result.execution,settings())&&result.input.video_id===video?.video_id&&result.standard_set_id===(set?.standard_set_id??null)&&((result.analysis_strategy==='vocabulary_guided')===(strategy==='vocabulary_guided'));
    $('#rerunStage2').textContent=result&&!rerunCompatible?'区間分割から再分析':'同じ区間でラベルを再判定';
    $('#rerunStage2').disabled=$('#startButton').disabled||!result;
    $('#inputNotice').textContent=config.mode==='mock'?'LOCAL MOCK：結果・観察・候補・使用量は合成データです。動画はローカル保存のみ、外部通信はありません。方式の精度差を測定した結果ではありません。':`送信先：貴社Google Cloud / ${config.settings.project} / ${config.settings.location}。Stage1は実動画1本。${strategy==='visual_evidence'?`Stage2も実動画1本${mode==='few_shot'?'と標準代表JPEG':'（標準画像なし）'}を送信します。`:'Stage2再判定は文章だけを送信します。'} 実接続の精度・費用・運用成立は未検証です。`;
    $('#settingsSummary').textContent=`モデル：${config.settings.stage1_model??'未設定'} / ${config.settings.stage2_model??'未設定'}\n音声：${settings().audio_enabled?'あり':'なし（音声トラックを除去）'} / FPS：${settings().fps} / ${settings().processing_mode}\n${state.running?'実行中の設定は固定されています。変更は次回の実行に適用します。':''}`;
    $('#pdfMeta').textContent=set?`${set.name} ／ ${set.status} ／ ${set.representative_images.length}枚`:'標準セット未選択';
  }
  function fillSelect(el,items,valueKey,text,empty='選択してください') {const previous=el.value;el.replaceChildren(new Option(empty,''),...items.map(x=>new Option(text(x),x[valueKey])));if(items.some(x=>x[valueKey]===previous))el.value=previous;}
  async function refreshInputs() {
    const [a,b,c]=await Promise.all([api('/api/standard-sets'),api('/api/media'),api('/api/vocabularies')]);sets=a.standard_sets;media=b.media.filter(a=>a.mime_type==='video/mp4');vocabularies=c.vocabularies;
    fillSelect($('#standardSet'),sets.filter(s=>s.status!=='retired'),'standard_set_id',s=>`${s.name}（${s.status==='ready'?'公開済み':STATUS[s.status]??s.status}）`);
    fillSelect($('#registeredVideo'),media.filter(m=>m.mime_type==='video/mp4'),'video_id',m=>m.display_name);fillSelect($('#buildVideo'),media.filter(m=>m.mime_type==='video/mp4'),'video_id',m=>m.display_name);
    fillSelect($('#vocabularySelect'),vocabularies,'ref',v=>v.vocabulary.vocabulary_version,'標準セットの語彙を使用');fillSelect($('#buildVocabulary'),vocabularies,'ref',v=>v.vocabulary.vocabulary_version);inputState();
  }
  async function selectVideo(file) {
    if(!file||file.size===0||!file.name.toLowerCase().endsWith('.mp4'))throw new Error('0バイトではないMP4動画を選んでください。');
    $('#videoMeta').textContent='ローカルへ登録・検証中';$('#startButton').disabled=true;
    const r=await fetch('/api/media',{method:'POST',headers:{'content-type':'video/mp4','x-display-name':encodeURIComponent(file.name),'x-local-token':state.session.token},body:file});const data=await r.json();if(!r.ok)throw new Error(data.message);
    await refreshInputs();$('#registeredVideo').value=data.video_id;$('#videoMeta').textContent=`登録済み：${data.display_name} ／ ${secondsToTime(data.duration_s)}`;inputState();toast('動画をローカルに登録しました。');
  }
  async function demo() {
    $('#demoInputButton').disabled=true;setStatus('running','合成サンプルを準備中','ローカルの再生用動画、標準記述、代表画像を作成します。');
    try{const d=await api('/api/demo-fixture',{});await refreshInputs();$('#registeredVideo').value=d.actual_video_id;$('#buildVideo').value=d.standard_video_id;$('#buildVocabulary').value=d.vocabulary_ref;$('#standardSet').value=d.standard_set_id;buildId=d.standard_set_id;activeRun=d.run_id;$('#setManager').hidden=false;await observe(d.run_id);if(sets.find(s=>s.standard_set_id===d.standard_set_id)?.status==='ready')await inspectSet(d.standard_set_id);inputState();}finally{$('#demoInputButton').disabled=false;}
  }
  async function start(reuse=false) {
    if(state.running)return;
    if(state.dirty||state.formDirty)await persistReview(false);
    const strategy=$('#analysisStrategy').value,compatible=result&&sameStage1Settings(result.execution,settings())&&((strategy==='vocabulary_guided')===(result.analysis_strategy==='vocabulary_guided'))&&result.input.video_id===$('#registeredVideo').value&&result.standard_set_id===($('#standardSet').value||null);
    const request={client_request_id:crypto.randomUUID(),input_video_id:$('#registeredVideo').value,standard_set_id:$('#standardSet').value||null,vocabulary_ref:$('#standardSet').value?null:$('#vocabularySelect').value,discriminator_ref:null,analysis_strategy:strategy,analysis_mode:mode,settings:settings(),stage1_artifact_id:reuse&&compatible?result.stage1.artifact_id:null,parent_run_id:reuse&&result?result.run_id:null,comparison_session_id:null,consent_confirmed:$('#consentConfirmed').checked};
    const r=await api('/api/analysis-runs',request);localStorage.setItem('tas-active-run',r.run_id);await observe(r.run_id);
  }
  const observe=createRunObserver({
    read:observeOnce,
    onConnected:()=>{$('#connectionStatus').textContent='画面の接続：正常';},
    onError:(error,failures)=>{$('#connectionStatus').textContent=failures?`画面の接続が途切れています（${failures}回）。最後の状態を表示中。自動で再確認します。`:'前回の実行がこの保存先に見つかりません。実行履歴から選び直してください。';}
  });
  async function observeOnce(runId,isCurrent) {
    activeRun=runId;const r=await api(`/api/analysis-runs/${runId}`);
    if(!isCurrent())return false;
    const ended=['succeeded','failed','cancelled','interrupted','awaiting_approval'].includes(r.status);state.running=!ended;state.startedAt=Date.parse(r.started_at??r.created_at);$('#cancelButton').hidden=ended;
    const elapsed=Math.floor((Date.parse(r.finished_at??new Date().toISOString())-state.startedAt)/1000);$('#elapsedText').textContent=`${Math.floor(elapsed/60).toString().padStart(2,'0')}:${(elapsed%60).toString().padStart(2,'0')}`;
    setStatus(r.status==='failed'?'error':ended?'done':'running',STATUS[r.status]??r.status,r.error?.message??(config.mode==='mock'?'合成データによる処理です。サーバー側の実際の処理段階を表示しています。':'サーバーで処理を継続しています。'));
    $('#cleanupStatus').textContent=`一時媒体：${CLEANUP[r.cleanup.cleanup_status]}${r.remote_outcome_unknown?' ／ リモート結果不明・猶予リースあり':''}`;
    if(r.job_kind==='standard_build'&&r.status==='awaiting_approval'){buildId=r.standard_set_id;await refreshInputs();$('#standardSet').value=buildId;$('#setManager').hidden=false;await inspectSet(buildId);}
    if(r.job_kind==='vocabulary_extract'&&r.status==='awaiting_approval'){vocabularyRunId=r.run_id;const draft=await api(`/api/vocabulary-extractions/${r.run_id}`);$('#setManager').hidden=false;$('#vocabularyDraft').hidden=false;$('#vocabularyDraft').parentElement.open=true;$('#draftVocabulary').value=JSON.stringify(draft.vocabulary,null,2);$('#draftDiscriminators').value=JSON.stringify(draft.discriminators,null,2);}
    if(r.result_available&&result?.run_id!==runId)await openResult(runId);
    if(ended){await refreshInputs();if(!isCurrent())return false;await history();}
    inputState();
    return !ended||!['deleted','not_needed'].includes(r.cleanup.cleanup_status);
  }
  async function cancel(){if(activeRun){await api(`/api/analysis-runs/${activeRun}/cancel`,{});await observe(activeRun);}}
  async function openResult(runId) {
    const nextResult=await api(`/api/analysis-runs/${runId}/result`),nextDisplay=await api(`/api/analysis-runs/${runId}/display`);
    const set=nextResult.standard_set_id?await api(`/api/standard-sets/${nextResult.standard_set_id}/inspection`):null;
    const reviews=(await api(`/api/analysis-runs/${runId}/reviews`)).reviews;
    const savedReview=(state.dirty||state.formDirty)?await persistReview(false):null;
    if(savedReview?.original_run_id===runId)reviews.push(savedReview);
    if(state.dirty||state.formDirty)throw new Error('保存中に新しい入力がありました。現在の入力を保存してから結果を開いてください。');
    result=nextResult;display=nextDisplay;review=reviews.at(-1)??null;
    state.result=result;state.prediction=structuredClone(display.prediction);state.reviewed=structuredClone(display.prediction);originalReview=review?.segments??result.segments;
    if(review)state.reviewed=review.segments.map(s=>{const d=display.prediction.find(x=>x.segment_id===s.segment_id);return {...(d??{work_content:'人による追加',hand_movement:'-',tools_and_parts:'-'}),segment_id:s.segment_id,start_time:secondsToTime(s.start_s),end_time:secondsToTime(s.end_s),duration_seconds:Math.floor(s.end_s)-Math.floor(s.start_s),job_no:s.job_no,job_title:s.job_title,page_number:s.page_number};});
    state.videoDuration=result.input.duration_s;state.demoInput=false;state.videoUrl=`/api/media/${result.input.video_id}/content`;$('#videoPlayer').src=state.videoUrl;$('#videoPlaceholder').hidden=true;
    state.predictionWarnings=result.segments.map(s=>s.review_reasons.map(k=>REVIEW_REASON_LABELS[k]));state.warnings=structuredClone(state.predictionWarnings);state.selected=0;state.view='reviewed';state.undoStack=[];state.redoStack=[];state.dirty=false;state.currentTime=0;state.timestamp=result.created_at;$('#workspace').hidden=false;
    standardSegments=set?.display_segments??[];standardExamples=set?.examples?.[result.analysis_strategy==='vocabulary_guided'?'guided':'unguided']??[];standardImages=set?.representative_images??[];state.standardDuration=set?.source_video.duration_s??0;
    if(set)$('#standardPlayer').src=`/api/media/${set.source_video.video_id}/content`;else $('#standardPlayer').removeAttribute('src');
    $('#standardInferenceNotice').textContent=result.examples_used?'上段：公開済み標準セットのお手本。実作業GTは表示しません。':'お手本なし：上段は表示用です。標準記述・標準画像は推論へ送信していません。';
    $('#reviewHistory').textContent=reviews.length?`修正履歴 ${reviews.length}件 ／ 最終確認：${review.editor} ／ ${new Date(review.created_at).toLocaleString()}`:'人による確認はまだ保存されていません。';
    $('#standardSet').value=result.standard_set_id??'';$('#registeredVideo').value=result.input.video_id;$('#analysisStrategy').value=result.analysis_strategy;mode=result.analysis_mode;restoreSettings(result.execution);modeTabs();render();
  }
  function restoreSettings(s){$('#processingMode').value=s.processing_mode;$('#inputFps').value=s.fps;$('#audioEnabled').checked=s.audio_enabled;$('#promptRelease').value=s.prompt_release;}
  function modeTabs(){for(const [sel,value]of [['#fewShotTab','few_shot'],['#zeroShotTab','zero_shot']]){const active=mode===value;$(sel).classList.toggle('active',active);$(sel).setAttribute('aria-selected',String(active));}inputState();}
  function exactReviewed() {
    return state.reviewed.map(s=>{const original=originalReview.find(x=>x.segment_id===s.segment_id)??result.segments.find(x=>x.segment_id===s.segment_id);return {segment_id:s.segment_id??(s.segment_id=`human-${crypto.randomUUID()}`),start_s:original&&s.start_time===secondsToTime(original.start_s)?original.start_s:timeToSeconds(s.start_time),end_s:original&&s.end_time===secondsToTime(original.end_s)?original.end_s:timeToSeconds(s.end_time),job_no:s.job_no,job_title:s.job_title,page_number:s.page_number};});
  }
  async function persistReview(show=true) {if(!result)return null;if(!applyPendingDetail())throw new Error('入力を修正してから保存してください。未反映の内容は画面に残っています。');const segments=exactReviewed(),saving=JSON.stringify(state.reviewed);review=await api(`/api/analysis-runs/${result.run_id}/reviews`,{editor:$('#reviewEditor').value,original_result_sha256:display.original_result_sha256,segments});state.dirty=JSON.stringify(state.reviewed)!==saving;originalReview=review.segments;renderDirty();$('#reviewHistory').textContent=`修正を保存しました：${review.editor} ／ ${new Date(review.created_at).toLocaleString()}`;if(show)toast('推論原本を残して修正履歴を保存しました。');return review;}
  async function download(type) {if(!result)return;const data=type==='reviewed'?await persistReview(false):result,a=document.createElement('a');a.href=type==='reviewed'?`/api/analysis-runs/${result.run_id}/reviews/${data.review_id}?download=1`:`/api/analysis-runs/${result.run_id}/result?download=1`;a.download=`${result.mock?'MOCK_':''}${result.run_id}_${type}.json`;document.body.append(a);a.click();a.remove();toast(`${type==='reviewed'?'確認・修正済み':'推論原本'}JSONを出力しました。`);}
  function extras() {
    if(!result)return;
    $('#globalWarnings').textContent=(result.warnings??[]).filter(w=>w.code==='MISSING_PROCESS').map(w=>`動画全体の確認事項（推論原本）：${w.message}`).join('\n');
    $('#resultIdentity').textContent=`${result.mock?'合成モック結果 ／ ':''}${STRATEGIES[result.analysis_strategy]} ／ ${result.examples_used?'お手本あり':'お手本なし'} ／ ${result.segments.filter(s=>s.review_required).length}区間が要確認 ／ 費用：${costText(result.metrics_runtime.cost)}`;
    const container=$('#standardTimelineSegments');container.replaceChildren();const axis=Math.max(state.videoDuration,state.standardDuration||0);
    standardSegments.forEach((s,i)=>{const b=document.createElement('button');b.type='button';b.className='standard-segment';b.style.left=`${s.start_s/axis*100}%`;b.style.width=`${(s.end_s-s.start_s)/axis*100}%`;b.textContent=`標準 ${i+1}`;b.title=`${s.job_title} ${s.start_s}–${s.end_s}秒`;b.addEventListener('click',e=>{e.stopPropagation();$('#standardPlayer').currentTime=s.start_s;syncFrom('standard',s);});container.append(b);});
    const shown=(state.view==='prediction'?state.prediction:state.reviewed)[state.selected],s=result.segments.find(x=>x.segment_id===shown?.segment_id);const panel=$('#evidencePanel');
    const form=$('#detailForm');if(form&&state.view==='reviewed'&&!state.formDirty)labelSelector(form,shown.job_no);
    if(!s){panel.textContent='人が追加した区間です。推論候補はありません。';return;}
    panel.innerHTML=`<h3>候補・観察根拠</h3><p>${s.review_required?'要確認':'確認対象外（人の承認ではありません）'}：${s.review_reasons.map(k=>esc(k==='quality_warning'?'動画全体・区間の確認事項あり（具体的な説明を参照）':REVIEW_REASON_LABELS[k])).join(' ／ ')||'確認理由なし'}</p><p>生の確信度 ${s.confidence_raw.toFixed(2)} ／ 表示用 ${s.confidence.toFixed(2)}${s.forced_low_confidence?' ／ 同着による強制低下':''}</p><p>${esc(s.adoption_reason)}</p><ul>${s.candidates.map(c=>`<li><strong>${esc(c.job_no)} ${esc(c.job_title)} ／ ${c.score.toFixed(2)}</strong><p>${esc(c.reason)}</p></li>`).join('')}</ul><details><summary>採用根拠の参照</summary><pre>${esc(JSON.stringify(s.evidence_refs,null,2))}</pre></details><details><summary>共通Observationの全項目</summary><pre>${esc(JSON.stringify(s.observation,null,2))}</pre></details>`;
    const refMarkup=ref=>{if(ref.kind==='standard_image'){const image=standardImages.find(i=>i.image_id===ref.image_id);return image?`<figure><img class="evidence-image" src="/api/standard-images/${result.standard_set_id}/${image.image_id}" alt="根拠として参照された標準画像"><figcaption>標準 ${image.extracted_time_s.toFixed(2)}秒 ／ ${esc(image.image_id)}</figcaption></figure>`:'標準画像を確認できません。';}if(ref.kind==='actual_video')return `<button type="button" class="icon-button evidence-seek" data-second="${ref.start_s}">実作業 ${ref.start_s.toFixed(2)}〜${ref.end_s.toFixed(2)}秒を確認</button>`;const obs=ref.kind==='example'?standardExamples.find(e=>e.example_id===ref.example_id)?.observation:s.observation;const ev=obs?.evidence.find(e=>e.evidence_id===ref.evidence_id);return `<p>${ref.kind==='example'?'標準の観察':'実作業の観察'}：${esc(obs?.[ref.field]?.value??'不明')}<br>${esc(ev?.description??'根拠を確認できません。')} ${ev?`（${ev.start_s.toFixed(2)}〜${ev.end_s.toFixed(2)}秒）`:''}</p>`;};
    const readable=document.createElement('div');readable.className='readable-evidence';readable.innerHTML=`<h3>参照された映像・記述</h3>${s.evidence_refs.map(refMarkup).join('')}<details><summary>候補ごとの根拠</summary>${s.candidates.map(c=>`<h4>${esc(c.job_no)} ${esc(c.job_title)}</h4>${c.evidence_refs.map(refMarkup).join('')}`).join('')}</details>`;panel.append(readable);readable.querySelectorAll('.evidence-seek').forEach(b=>b.addEventListener('click',()=>seek(Number(b.dataset.second))));

  }
  function syncFrom(side,segment) {
    if(syncBusy||!$('#syncPlayback').checked)return;
    const target=side==='standard'?exactReviewed():standardSegments,player=side==='standard'?$('#videoPlayer'):$('#standardPlayer');const matching=matchingSegment(target,segment.job_no,player.currentTime);
    if(!matching){$('#syncStatus').textContent=`対応区間なし：${segment.job_no} ${segment.job_title}`;return;}
    syncBusy=true;player.currentTime=matching.start_s;if(side==='standard'){state.currentTime=matching.start_s;seek(matching.start_s);lastActualId=matching.segment_id;}else lastStandardId=matching.segment_id;
    $('#syncStatus').textContent=`区間同期：Job ${segment.job_no} ／ ${matching.start_s.toFixed(2)}秒へ移動`;setTimeout(()=>{syncBusy=false;},100);
  }
  async function history() {
    const runs=(await api('/api/analysis-runs')).runs;const list=$('#historyList');list.replaceChildren();
    if(!runs.length){list.textContent='まだ実行履歴はありません。';return;}
    for(const r of runs){const row=document.createElement('div');row.className='history-row';row.innerHTML=`<div><strong>${esc(new Date(r.created_at).toLocaleString())} ／ ${esc(STATUS[r.status])}</strong><p>${r.job_kind==='vocabulary_extract'?'標準書から語彙抽出':r.job_kind==='standard_build'?'標準セット作成':`${esc(STRATEGIES[r.analysis_strategy])} ／ ${r.analysis_mode==='few_shot'?'お手本あり':'お手本なし'}`} ／ 確認対象 ${r.review_count??'—'} ／ 費用：${esc(costText(r.cost))}</p><small>${esc(r.settings.stage1_model)} ／ セット ${esc(sets.find(s=>s.standard_set_id===r.standard_set_id)?.name??r.standard_set_id??'なし')}<br>Stage1 ${esc(r.stage1?.artifact_id??'未作成')} ／ 共有元 ${esc(r.stage1?.producer_run_id??'なし')}<br>一時媒体：${esc(CLEANUP[r.cleanup.cleanup_status])}</small></div>`;
      const actions=document.createElement('div');actions.className='action-row';const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.className='icon-button';b.textContent=text;b.addEventListener('click',safely(fn));actions.append(b);};
      button(r.result_available?'結果を開く':'状態を開く',async()=>{if(state.dirty||state.formDirty)await persistReview(false);if(r.result_available)await openResult(r.run_id);await observe(r.run_id);});
      if(['failed','cancelled','interrupted'].includes(r.status))button('再試行',async()=>{const n=await api(`/api/analysis-runs/${r.run_id}/retry`,{client_request_id:crypto.randomUUID()});await observe(n.run_id);});
      if(['retry_wait','cleanup_failed'].includes(r.cleanup.cleanup_status))button('削除を再試行',async()=>{await api(`/api/analysis-runs/${r.run_id}/cleanup-retry`,{});await history();});
      row.append(actions);list.append(row);
    }
  }
  async function inspectSet(setId) {
    const s=await api(`/api/standard-sets/${setId}/inspection`);buildId=setId;const panel=$('#setInspection');
    panel.innerHTML=`<h3>${esc(s.name)} ／ ${esc(s.status)}</h3><p>語彙 ${esc(s.vocabulary.vocabulary_version)} ／ 標準動画 ${s.source_video.duration_s}秒 ／ 画像 ${s.representative_images.length}枚</p><div class="frame-grid">${s.representative_images.map(i=>`<figure><img src="/api/standard-images/${setId}/${i.image_id}" alt="標準 ${esc(i.segment_id)} ${i.extracted_time_s}秒"><figcaption>${esc(i.segment_id)} ／ ${i.extracted_time_s.toFixed(2)}秒<br>${esc(i.selection_rule_version)}</figcaption></figure>`).join('')}</div><details><summary>生成した標準記述・不足申告を確認</summary><pre>${esc(JSON.stringify(s.examples,null,2))}</pre></details>`;
    $('#approveSetButton').disabled=s.status!=='preparing';
  }
  async function readFile(input){const file=$(input).files[0];if(!file)throw new Error('必要なJSONファイルを選択してください。');return JSON.parse(await file.text());}
  async function initialize() {
    state.session=await api('/api/session');config=await api('/api/config');$('#modeBadge').textContent=config.mode==='mock'?'LOCAL MOCK｜合成データ・外部通信なし':'GEMINI / GEAP｜実接続・実測未確認';$('#demoInputButton').hidden=config.mode!=='mock';await refreshInputs();await history();inputState();
    $('#rerunStage2').addEventListener('click',safely(()=>start(true)));$('#saveReviewButton').addEventListener('click',safely(()=>persistReview()));$('#refreshHistory').addEventListener('click',safely(history));
    $('#extractVocabulary').addEventListener('click',safely(async()=>{const file=$('#vocabularyPdf').files[0];if(!file)throw new Error('標準書PDFを選択してください。');const response=await fetch('/api/media',{method:'POST',headers:{'content-type':'application/pdf','x-display-name':encodeURIComponent(file.name),'x-local-token':state.session.token},body:file});const pdf=await response.json();if(!response.ok)throw new Error(pdf.message);const run=await api('/api/vocabulary-extractions',{client_request_id:crypto.randomUUID(),pdf_asset_id:pdf.asset_id,settings:settings(),consent_confirmed:$('#consentConfirmed').checked});await observe(run.run_id);}));
    $('#approveVocabulary').addEventListener('click',safely(async()=>{const vocabulary=JSON.parse($('#draftVocabulary').value),discriminators=JSON.parse($('#draftDiscriminators').value);discriminators.approved_by=$('#setReviewer').value;discriminators.approved_at=new Date().toISOString();const v=await api(`/api/vocabulary-extractions/${vocabularyRunId}/approve`,{vocabulary,discriminators,approved_by:$('#setReviewer').value});await refreshInputs();$('#buildVocabulary').value=v.ref;$('#vocabularyDraft').hidden=true;await history();toast('標準書の語彙と識別条件を確認済みとして登録しました。');}));
    $('#fewShotTab').addEventListener('click',()=>{mode='few_shot';modeTabs();});$('#zeroShotTab').addEventListener('click',()=>{mode='zero_shot';modeTabs();});
    for(const sel of ['#standardSet','#registeredVideo','#vocabularySelect','#analysisStrategy','#processingMode','#inputFps','#audioEnabled','#promptRelease','#consentConfirmed'])$(sel).addEventListener('change',inputState);
    $('#manageSets').addEventListener('click',safely(async()=>{$('#setManager').hidden=false;if($('#standardSet').value)await inspectSet($('#standardSet').value);}));$('#closeSetManager').addEventListener('click',()=>{$('#setManager').hidden=true;});
    $('#registerVocabulary').addEventListener('click',safely(async()=>{const r=await api('/api/vocabularies',{vocabulary:await readFile('#vocabularyFile'),discriminators:await readFile('#discriminatorFile'),approved_by:$('#setReviewer').value});await refreshInputs();$('#buildVocabulary').value=r.ref;toast('語彙・識別条件を登録しました。');}));
    $('#buildSetButton').addEventListener('click',safely(async()=>{const gt=await api('/api/standard-set-build-inputs/gt',await readFile('#buildGtFile'));const r=await api('/api/standard-sets',{client_request_id:crypto.randomUUID(),name:$('#setName').value,source_video_id:$('#buildVideo').value,build_gt_asset_id:gt.build_gt_asset_id,vocabulary_ref:$('#buildVocabulary').value,discriminator_ref:$('#buildVocabulary').value,profiles:$('#buildGuided').checked?['unguided','guided']:['unguided'],generate_images:$('#buildImages').checked,settings:settings(),parent_set_id:null,consent_confirmed:$('#consentConfirmed').checked});buildId=r.standard_set_id;await observe(r.run_id);}));
    $('#approveSetButton').addEventListener('click',safely(async()=>{await api(`/api/standard-sets/${buildId}/approve`,{approved_by:$('#setReviewer').value});await refreshInputs();$('#standardSet').value=buildId;await inspectSet(buildId);await history();inputState();setStatus('done','標準セットを公開しました','実作業動画と方式を選び、同意欄を確認して分析を開始できます。');}));
    $('#retireSetButton').addEventListener('click',safely(async()=>{await api(`/api/standard-sets/${$('#standardSet').value}/retire`,{});await refreshInputs();toast('セットの新規利用を停止しました。履歴は残ります。');}));
    $('#standardPlayer').addEventListener('timeupdate',()=>{const t=$('#standardPlayer').currentTime,s=standardSegments.find(s=>s.start_s<=t&&t<s.end_s);if(s&&s.segment_id!==lastStandardId){lastStandardId=s.segment_id;syncFrom('standard',s);}});
    $('#videoPlayer').addEventListener('timeupdate',()=>{if(!result)return;const t=$('#videoPlayer').currentTime,s=exactReviewed().find(s=>s.start_s<=t&&t<s.end_s);if(s&&s.segment_id!==lastActualId){lastActualId=s.segment_id;syncFrom('actual',s);}});
    const running=localStorage.getItem('tas-active-run');if(running)try{await observe(running);}catch{localStorage.removeItem('tas-active-run');}
  }
  return {inputState,selectVideo:safely(selectVideo),demo:safely(demo),start:safely(start),cancel:safely(cancel),download:safely(download),initialize:safely(initialize),extras,warnings,prepareAdd:()=>labelSelector($('#addForm'))};
}
