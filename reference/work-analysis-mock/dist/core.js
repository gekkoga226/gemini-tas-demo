(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkAnalysis=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const modes=['zero','few'];
 const matchNames={matched:'標準作業',partial:'一部対応',unmatched:'未記載',uncertain:'要確認'};
 const activityNames={assembly:'組立',move:'運搬',inspect:'確認・検査',search:'探索候補',wait:'待機',prepare:'準備',unknown:'判定不能'};
 const reviewNames={draft:'未確認',reviewed:'確認中',verified:'確認済み'};
 const copy=x=>JSON.parse(JSON.stringify(x));
 const round=x=>Math.round(x*1000)/1000;
 const duration=s=>s.end_sec-s.start_sec;
 const mmss=s=>{s=Math.max(0,Math.floor(Number(s)||0));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`};
 const pretty=s=>s>=60?`${Math.floor(s/60)}分${Math.floor(s%60)?Math.floor(s%60)+'秒':''}`:`${Math.round(s)}秒`;
 const standards=()=>[
  ['S01','作業準備',180],['S02','部品の取り出し',420],['S03','位置合わせ',420],['S04','部品の取り付け',600],['S05','配線の接続',600],['S06','動作確認',480],['S07','外装の取り付け',720],['S08','外観検査',600],['S09','梱包',480],['S10','完成品の運搬',300]
 ].map(([id,name,duration_sec])=>({id,name,duration_sec}));
 const template=[
  ['作業台と工具を確認する','prepare','S01',180,'工具一式','作業台','工具が台に置かれている','使用する工具が並んだ'],
  ['棚の中を確認し工具を探す','search',null,150,'工具ケース','工具棚','目的の工具が見えていない','工具を取り出した'],
  ['箱から部品を取り出す','prepare','S02',300,'部品A','部品棚','部品が箱にある','部品が台車に載った'],
  ['台車から部品を作業台へ運ぶ','move','S02',180,'部品A','台車→作業台','部品が台車にある','作業台に置かれた'],
  ['治具に部品を置き位置を合わせる','assembly','S03',420,'部品A・治具','作業台','位置がずれている','治具の目印に合った'],
  ['部品を固定してねじを締める','assembly','S04',540,'部品A・ねじ','作業台','部品が未固定','ねじが締められた'],
  ['工具を持ち替えて締結を続ける','assembly','S04',210,'ねじ・ドライバー','作業台','一部のねじが未締結','残りのねじを締めた'],
  ['ケーブルを取り出し接続する','assembly','S05',480,'ケーブルB','作業台','端子が未接続','コネクタが接続された'],
  ['端子を見直し接続し直す','assembly','S05',240,'ケーブルB','作業台','接続部に再び触れる','端子を再接続した'],
  ['装置を操作して動作を確認する','inspect','S06',300,'操作パネル','検査台','装置が停止中','検査が開始された'],
  ['装置の動作が終わるまで待つ','wait',null,660,'装置','検査台','検査が動作中','完了表示が出た'],
  ['外装パネルを取り出す','prepare','S07',180,'外装パネル','部品棚','パネルが棚にある','台へ運び出した'],
  ['外装パネルを取り付ける','assembly','S07',540,'外装パネル','作業台','外装が未装着','外装が取り付けられた'],
  ['画面外で作業が続いている','unknown',null,210,'不明','作業台付近','手元が見えない','映像内へ戻った'],
  ['外観を確認して部品に触れる','inspect','S08',480,'完成品','検査台','検査前','外観確認が終了した'],
  ['梱包材を補充しに移動する','move',null,330,'梱包材','資材置場','梱包材が不足','梱包材が台に揃った'],
  ['保護材を取り付け梱包する','assembly','S09',480,'保護材・箱','梱包台','完成品が未梱包','箱に収められた'],
  ['ラベルを確認して貼り付ける','inspect','S09',180,'製品ラベル','梱包台','ラベルが未貼付','箱に貼付された'],
  ['完成品を台車へ載せて運ぶ','move','S10',300,'梱包済み製品','梱包台→置場','完成品が梱包台にある','完成品置場に到着した'],
  ['工具を戻し作業台を整える','prepare',null,240,'工具一式','作業台','工具が台に残る','作業台が整った']
 ];
 function createDemo(length=7200,name='工程A・サンプル動画',size=null){
  if(!Number.isFinite(length)||length<=0)throw Error('動画の長さを確認してください。');
  const total=template.reduce((t,r)=>t+r[3],0);let end=0;
  const base=template.map((r,i)=>{let start=end;end=i===template.length-1?length:round(end+r[3]/total*length);return {id:`seg_${String(i+1).padStart(3,'0')}`,start_sec:start,end_sec:end,action:r[0],activity:r[1],object:r[4],tool:r[0].includes('ねじ')?'ドライバー':'映像で確認',location:r[5],before:r[6],after:r[7],evidence:`${mmss(start)}〜${mmss(end)}の前後状態を確認（架空の観察記録）`,standard_id:r[2],match_status:r[2]?'matched':r[1]==='unknown'?'uncertain':'unmatched',method_status:'unknown',order_status:'unknown',review_status:i<3?'verified':'draft',note:r[0].includes('接続し直す')?'繰り返しを観察。手直しかどうかは現場確認が必要。':''}});
  const few=copy(base),zero=copy(base);
  [3,6,8,14,17].forEach(i=>{zero[i].standard_id=null;zero[i].match_status='uncertain';zero[i].review_status='draft';zero[i].note='対象や操作の意味を確認してください。'});
  zero[4].match_status='partial';few[8].match_status='partial';few[8].method_status='deviating';
  return {schema_version:'1.0',data_source:'demo',video:{name,duration_sec:length,size_bytes:size},tt_sec:4800,standard_cards:standards(),modes:{zero:{segments:zero},few:{segments:few}},history:[]};
 }
 function str(x,label,max=2000){if(typeof x!=='string'||x.length>max)throw Error(`${label}の文字列が不正です。`)}
 function validate(input){
  const r=copy(input);if(r.schema_version!=='1.0')throw Error('対応形式はschema_version: 1.0です。同梱のJSON例を確認してください。');
  if(!['demo','imported','gemini'].includes(r.data_source))throw Error('data_sourceをdemo / imported / geminiから指定してください。');
  if(!r.video||!Number.isFinite(r.video.duration_sec)||r.video.duration_sec<=0)throw Error('動画の長さが不正です。');
  str(r.video.name,'動画名',512);if(r.video.size_bytes!=null&&(!Number.isSafeInteger(r.video.size_bytes)||r.video.size_bytes<0))throw Error('動画容量が不正です。');
  if(!Array.isArray(r.standard_cards)||r.standard_cards.length>1000)throw Error('標準作業一覧を確認してください。');
  const ids=new Set();r.standard_cards.forEach(c=>{str(c.id,'標準ID',128);str(c.name,'標準作業名');if(!c.id||ids.has(c.id))throw Error('標準IDが重複または空です。');ids.add(c.id);if(c.duration_sec!=null&&(!Number.isFinite(c.duration_sec)||c.duration_sec<0))throw Error('標準時間が不正です。')});
  if(!r.modes||!modes.some(m=>r.modes[m]))throw Error('少なくとも一方式の結果が必要です。');
  modes.filter(m=>r.modes[m]).forEach(m=>{
   const segs=r.modes[m].segments;if(!Array.isArray(segs)||!segs.length||segs.length>5000)throw Error('区間数は1〜5,000件にしてください。');let prev=0;const seen=new Set();
   segs.forEach((s,i)=>{
    str(s.id,'区間ID',128);if(!s.id||seen.has(s.id))throw Error('区間IDが重複または空です。');seen.add(s.id);
    if(!Number.isFinite(s.start_sec)||!Number.isFinite(s.end_sec)||s.start_sec<0||s.end_sec<=s.start_sec||s.end_sec>r.video.duration_sec+0.01||Math.abs(prev-s.start_sec)>0.01)throw Error(`${m}の${i+1}区間目に時間の抜け・重複・逆転があります。`);
    s.start_sec=prev;prev=s.end_sec;
    ['action','object','tool','location','before','after','evidence','note'].forEach(k=>str(s[k],k));
    if(!Object.hasOwn(activityNames,s.activity)||!Object.hasOwn(matchNames,s.match_status)||!Object.hasOwn(reviewNames,s.review_status))throw Error('作業・対応・確認状態に未定義の値があります。');
    if(!['conforming','deviating','unknown','not_applicable'].includes(s.method_status)||!['allowed','violation_candidate','unknown'].includes(s.order_status))throw Error('方法・順序の判定値が不正です。');
    const assigned=['matched','partial'].includes(s.match_status);
    if(assigned&&!ids.has(s.standard_id))throw Error('対応する標準IDを確認してください。');
    if(!assigned&&s.standard_id!==null)throw Error('未記載・要確認のstandard_idはnullにしてください。');
   });if(Math.abs(prev-r.video.duration_sec)>0.01)throw Error('区間が動画の末尾までありません。');segs.at(-1).end_sec=r.video.duration_sec;
  });
  if(r.tt_sec==null)r.tt_sec=4800;if(!Number.isFinite(r.tt_sec)||r.tt_sec<=0)throw Error('基準時間が不正です。');
  if(!Array.isArray(r.history))r.history=[];if(r.history.length>10000)throw Error('変更履歴が大きすぎます。');return r;
 }
 function stats(result,mode){const segs=result.modes[mode]?.segments||[];const totals={matched:0,partial:0,unmatched:0,uncertain:0};segs.forEach(s=>totals[s.match_status]+=duration(s));return {count:segs.length,reviewed:segs.filter(s=>s.review_status==='verified').length,pending:segs.filter(s=>s.review_status!=='verified').length,totals,groups:result.standard_cards.map(c=>({...c,actual:segs.filter(s=>s.standard_id===c.id).reduce((v,s)=>v+duration(s),0),segments:segs.filter(s=>s.standard_id===c.id)}))}}
 function update(result,mode,id,patch){
  const r=copy(result),segs=r.modes[mode]?.segments;if(!segs)throw Error('対象方式の結果がありません。');const i=segs.findIndex(s=>s.id===id);if(i<0)throw Error('区間が見つかりません。');let before=copy(segs[i]);let s=segs[i];
  const a=Number(patch.start_sec),b=Number(patch.end_sec);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b||a<0||b>r.video.duration_sec)throw Error('開始・終了の秒数を確認してください。');
  if(i===0&&a!==0||i===segs.length-1&&b!==r.video.duration_sec)throw Error('動画の先頭・末尾の時刻は固定です。');
  if(i>0&&a<=segs[i-1].start_sec||i<segs.length-1&&b>=segs[i+1].end_sec)throw Error('隣の区間をなくす時刻には変更できません。');
  if(a!==s.start_sec&&i>0){segs[i-1].end_sec=a;segs[i-1].review_status='draft';}
  if(b!==s.end_sec&&i<segs.length-1){segs[i+1].start_sec=b;segs[i+1].review_status='draft';}
  ['standard_id','match_status','review_status','note'].forEach(k=>{if(k in patch)s[k]=patch[k]});
  if(a!==s.start_sec||b!==s.end_sec)s.review_status='draft';s.start_sec=a;s.end_sec=b;
  r.history.push({at:new Date().toISOString(),mode,segment_id:id,before,after:copy(s)});return validate(r);
 }
 function csv(result,mode){const safe=v=>{let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};const rows=[['データ種別','方式','区間ID','開始秒','終了秒','時間秒','観察した作業','活動','標準ID','標準との対応','確認状態','メモ']];(result.modes[mode]?.segments||[]).forEach(s=>rows.push([result.data_source,mode,s.id,s.start_sec,s.end_sec,round(duration(s)),s.action,activityNames[s.activity],s.standard_id,matchNames[s.match_status],reviewNames[s.review_status],s.note]));return '\uFEFF'+rows.map(r=>r.map(safe).join(',')).join('\r\n')}
 return {createDemo,validate,stats,update,csv,duration,mmss,pretty,matchNames,activityNames,reviewNames,copy};
});
