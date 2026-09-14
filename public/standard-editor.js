const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createStandardEditor({$,api,uploadVideo,getMedia,getVocabularies,settings,getConfig,getBusy,onCreated,onBusy}) {
  let sources=[],submitting=false;
  const mediaFor=s=>getMedia().find(m=>m.video_id===s.videoId);
  const vocabulary=()=>getVocabularies().find(v=>v.ref===$('#buildVocabulary').value)?.vocabulary;
  const fresh=()=>({key:crypto.randomUUID(),name:'',videoId:'',intervals:[],gt:null,error:'',uploading:false});
  function errors(s) {
    const video=mediaFor(s),labels=vocabulary()?.labels??[];
    if(s.uploading)return '動画を登録・検証しています';
    if(!video)return 'お手本動画を選んでください';
    if(s.gt)return s.gt.video_id!==video.video_id||s.gt.duration_s!==video.duration_s?'GTの動画ID・長さが選択動画と一致しません':null;
    let end=0;
    if(!s.intervals.length)return '正解が確認された作業区間を入力してください';
    for(const row of s.intervals){if(!Number.isFinite(row.start)||!Number.isFinite(row.end)||row.start!==end||row.end<=row.start||row.end>video.duration_s)return '開始0秒から動画末尾まで、隙間・重複のない正の区間を入力してください';if(!labels.some(l=>l.job_no===row.job))return '各区間の作業名を選んでください';end=row.end;}
    return end===video.duration_s?null:`最後の終了を動画末尾 ${video.duration_s}秒に合わせてください`;
  }
  function update() {
    const reasons=[];
    if(!vocabulary())reasons.push('確認済みの作業名一覧（語彙）を選んでください');
    if(!$('#setName').value.trim())reasons.push('セット名を入力してください');
    if(new Set(sources.map(s=>s.videoId).filter(Boolean)).size!==sources.filter(s=>s.videoId).length)reasons.push('同じ動画が重複しています');
    for(const [i,s] of sources.entries()){const error=errors(s);if(error)reasons.push(`お手本${i+1}：${error}`);const status=$('#buildSources').querySelector(`[data-source-key="${s.key}"] .source-error`);if(status)status.textContent=s.error||error||'作業区間を入力済み';}
    if(!$('#buildConsent').checked)reasons.push('すべてのお手本動画について同意を確認してください');
    const config=getConfig();if(!config?.ready)reasons.push('接続・保存先の準備を確認してください');
    $('#buildSetButton').disabled=submitting||getBusy()||sources.some(s=>s.uploading)||!sources.length||reasons.length>0;
    $('#buildMessage').textContent=submitting?'お手本セットを受け付けています。':reasons[0]??`${sources.length}本のお手本を生成できます。`;
    $('#buildInputNotice').textContent=config?.mode==='mock'?`合成モック：${sources.length}本を個別に処理します。外部通信はありません。`:`送信先：Google Cloud / ${config?.settings.project??'未設定'} / ${config?.settings.location??'未設定'}。お手本${sources.length}本を1本ずつ送信し、${$('#buildGuided').checked?'各2回':'各1回'}の記述生成を行います。GTの正解ラベルは送信せず、指定区間だけを使用します。費用は未測定です。`;
  }
  function render() {
    const labels=vocabulary()?.labels??[];
    $('#buildSources').innerHTML=sources.map((s,i)=>{
      const video=mediaFor(s);
      return `<article class="build-source" data-source-key="${s.key}"><header><h3>お手本 ${i+1}</h3><button type="button" class="icon-button" data-action="remove" ${sources.length===1||submitting?'disabled':''}>この入力を外す</button></header>
      <div class="form-grid"><label>お手本の名前<input data-field="name" value="${esc(s.name)}" maxlength="200" placeholder="例：組立作業・1回目"></label><label>登録済みのお手本動画<select data-field="video" ${s.uploading?'disabled':''}><option value="">動画を選択</option>${getMedia().map(m=>`<option value="${esc(m.video_id)}" ${m.video_id===s.videoId?'selected':''}>${esc(m.display_name)}（${m.duration_s}秒）</option>`).join('')}</select></label><label>新しいお手本動画を登録<input type="file" accept="video/mp4,.mp4" data-field="upload" ${s.uploading?'disabled':''}></label></div>
      <p class="source-status">${s.uploading?'ローカルへ登録中':video?`${esc(video.display_name)} ／ ${video.duration_s}秒 ／ 動画ID：${esc(video.video_id)}`:'MP4を登録、または登録済み動画を選択してください。'}</p>
      ${s.gt?`<p>正解区間JSON：${esc(s.gtFileName)} ／ ${s.gt.segments?.length??0}区間</p><button type="button" class="icon-button" data-action="manual">表で入力し直す</button>`:`<div class="table-scroll"><table class="gt-table"><caption>確認済みの作業区間（秒）</caption><thead><tr><th scope="col">開始</th><th scope="col">終了</th><th scope="col">作業名</th><th scope="col">操作</th></tr></thead><tbody>${s.intervals.map((row,j)=>`<tr data-interval="${j}"><td><input aria-label="お手本${i+1} 区間${j+1}の開始秒" type="number" min="0" step="any" data-field="start" value="${row.start??''}"></td><td><input aria-label="お手本${i+1} 区間${j+1}の終了秒" type="number" min="0" step="any" data-field="end" value="${row.end??''}"></td><td><select aria-label="お手本${i+1} 区間${j+1}の作業名" data-field="job"><option value="">作業名を選択</option>${labels.map(l=>`<option value="${esc(l.job_no)}" ${row.job===l.job_no?'selected':''}>${esc(l.job_no)} ${esc(l.job_title)}</option>`).join('')}</select></td><td><button type="button" class="remove-interval" data-action="remove-interval" ${s.intervals.length===1?'disabled':''}>外す</button></td></tr>`).join('')}</tbody></table></div><button type="button" class="icon-button" data-action="add-interval" ${!video?'disabled':''}>＋ 最後の区間を分ける</button>`}
      <details><summary>正解区間JSON（GT）を読み込む</summary><p class="hint">選択した動画ID・長さと一致する、標準作成専用のJSONを指定してください。</p><input type="file" accept=".json,application/json" data-field="gt" aria-label="お手本${i+1}の正解区間JSON"></details>
      <p class="source-error" role="status"></p></article>`;
    }).join('');update();
  }
  function resetIntervals(s) {const video=mediaFor(s);s.intervals=video?[{start:0,end:video.duration_s,job:''}]:[];s.gt=null;s.error='';}
  $('#buildSources').addEventListener('input',e=>{const row=e.target.closest('[data-source-key]');if(!row)return;const s=sources.find(s=>s.key===row.dataset.sourceKey),field=e.target.dataset.field,index=e.target.closest('[data-interval]')?.dataset.interval;if(field==='name')s.name=e.target.value;if(index!==undefined){s.intervals[Number(index)][field]=field==='job'?e.target.value:e.target.value===''?null:Number(e.target.value);}update();});
  $('#buildSources').addEventListener('change',async e=>{
    const row=e.target.closest('[data-source-key]');if(!row)return;const s=sources.find(s=>s.key===row.dataset.sourceKey),field=e.target.dataset.field;
    if(field==='video'||field==='upload')$('#buildConsent').checked=false;
    try{
      if(field==='video'){s.videoId=e.target.value;if(!s.name)s.name=mediaFor(s)?.display_name??'';resetIntervals(s);render();}
      if(field==='upload'){const file=e.target.files[0];if(!file)return;s.uploading=true;onBusy(true);render();try{const video=await uploadVideo(file);s.videoId=video.video_id;if(!s.name)s.name=video.display_name;resetIntervals(s);}finally{s.uploading=false;onBusy(false);render();}}
      if(field==='gt'){const file=e.target.files[0];if(!file)return;const gt=JSON.parse(await file.text());if(!Array.isArray(gt.segments)||!gt.segments.length)throw new Error('GTのsegmentsには正解区間が必要です。');s.gt=gt;s.gtFileName=file.name;s.error='';render();}
    }catch(error){s.error=error.message;render();}
  });
  $('#buildSources').addEventListener('click',e=>{const button=e.target.closest('[data-action]');if(!button||submitting)return;const row=button.closest('[data-source-key]'),s=sources.find(s=>s.key===row.dataset.sourceKey);if(button.dataset.action==='remove')sources=sources.filter(x=>x!==s);if(button.dataset.action==='manual')resetIntervals(s);if(button.dataset.action==='add-interval'){const last=s.intervals.at(-1);if(last&&Number.isFinite(last.start)&&Number.isFinite(last.end)&&last.end>last.start){const end=last.end,mid=Number(((last.start+end)/2).toFixed(6));if(mid>last.start&&mid<end){last.end=mid;s.intervals.push({start:mid,end,job:''});}}}if(button.dataset.action==='remove-interval')s.intervals.splice(Number(button.closest('[data-interval]').dataset.interval),1);render();});
  $('#addBuildSource').onclick=()=>{if(submitting)return;sources.push(fresh());$('#buildConsent').checked=false;render();};
  $('#buildVocabulary').addEventListener('change',render);
  for(const selector of ['#buildConsent','#setName','#buildGuided','#buildImages'])$(selector).addEventListener('input',update);
  $('#buildSetButton').onclick=async()=>{
    update();if($('#buildSetButton').disabled)return;
    submitting=true;onBusy(true);update();let failure=null;
    try{
      // Freeze the entire submitted form before registering any GT asynchronously.
      const labels=vocabulary().labels,inputs=[],request={client_request_id:crypto.randomUUID(),name:$('#setName').value.trim(),vocabulary_ref:$('#buildVocabulary').value,profiles:$('#buildGuided').checked?['unguided','guided']:['unguided'],generate_images:$('#buildImages').checked,settings:settings(),parent_set_id:null,consent_confirmed:$('#buildConsent').checked};
      const submitted=sources.map(s=>{const video=mediaFor(s),gt=structuredClone(s.gt??{gt_version:`manual-${crypto.randomUUID()}`,video_id:video.video_id,duration_s:video.duration_s,segments:s.intervals.map(row=>{const label=labels.find(l=>l.job_no===row.job);return {gt_segment_id:crypto.randomUUID(),gt_process_id:crypto.randomUUID(),start_s:row.start,end_s:row.end,job_no:label.job_no,job_title:label.job_title};})});return {source_video_id:video.video_id,name:s.name.trim()||video.display_name,gt};});
      for(const source of submitted){const registered=await api('/api/standard-set-build-inputs/gt',source.gt);inputs.push({source_video_id:source.source_video_id,build_gt_asset_id:registered.build_gt_asset_id,name:source.name});}
      const run=await api('/api/standard-sets',{...request,sources:inputs});
      $('#buildEditor').open=false;await onCreated(run);
    }catch(error){failure=error;}
    finally{submitting=false;onBusy(false);update();if(failure){$('#buildMessage').textContent=failure.message;$('#buildMessage').dataset.error='true';}}
  };
  return {refresh:render,update,reset:()=>{sources=[fresh()];$('#buildConsent').checked=false;$('#buildEditor').open=true;render();}};
}
