import {FIELDS,NON_WORK} from './contracts.js';
import {segmentId,delay,clone,now} from './core.js';
export function mockObservation(s,i,audio=false) {
  const evidence_id='ev-1';
  const values=['合成映像の対象部品','作業者視点の中央の治具','工具と対象部品',`合成観察: 部品に対する操作 ${i+1}`,'対象物が固定される前','対象物の向きが変わった後','合成の接触音'];
  const observation=Object.fromEntries(FIELDS.map((f,k)=>[f,{status:f==='audio_cues'&&!audio?'not_applicable':'observed',value:f==='audio_cues'&&!audio?null:values[k],evidence_ids:f==='audio_cues'&&!audio?[]:[evidence_id]}]));
  return {...observation,unobserved_occlusions:audio?[]:[{field:'audio_cues',reason:'音声なしの入力条件',evidence_ids:[]}],insufficient_discriminative_features:i%5===2,insufficiency_reasons:i%5===2?['合成例: 手で隠れた位置の違いを確認できません。']:[],evidence:[{evidence_id,source:'video',start_s:s.start_s,end_s:Math.min(s.end_s,s.start_s+.5),description:'合成例: 対象物と手の位置が変化する。'}]};
}
export class MockModelAdapter {
  constructor(config){this.config=config;}
  async call({stage,boundaries=null,video,input,settings,signal,onRequest=async()=>{},onAttempt=async()=>{},body,freeform=false,vocabularyExtraction=false}) {
    const started=Date.now();await onRequest({url:'mock://local/generateContent',body,model_id:'mock-gemini-contract.v1'});await delay(this.config.mockDelayMs,signal);
    let output;
    if(vocabularyExtraction)output={labels:demoVocabulary().labels.filter(l=>l.kind==='work').map(({kind,...l})=>l)};
    else if(stage==='stage1') {
      const count=Math.max(1,Math.min(60,Math.ceil(video.duration_s/6)));
      const intervals=boundaries??Array.from({length:count},(_,i)=>({segment_id:segmentId(i),start_s:video.duration_s*i/count,end_s:video.duration_s*(i+1)/count}));
      if(freeform)output={schema_version:'probe.stage1.freeform.fixed.v1',observations:intervals.map((s,i)=>{const o=mockObservation(s,i,settings.audio_enabled);return {segment_id:s.segment_id,description:o.operation.value,insufficient_discriminative_features:o.insufficient_discriminative_features,insufficiency_reasons:o.insufficiency_reasons,evidence:o.evidence};})};
      else output=boundaries?{schema_version:'stage1.fixed.v1',observations:intervals.map((s,i)=>({segment_id:s.segment_id,observation:mockObservation(s,i,settings.audio_enabled)}))}:{schema_version:'stage1.discover.v1',segments:intervals.map((s,i)=>({...s,boundary_evidence:{start_reason:'合成例の操作開始',end_reason:'合成例の操作変化'},observation:mockObservation(s,i,settings.audio_enabled)}))};
    } else {
      const work=input.vocabulary.labels.filter(l=>l.kind==='work');const labels=work.length?work:input.vocabulary.labels;
      output={schema_version:'stage2.v1',labels:input.segments.map((s,i)=>{
        const label=labels[i%labels.length],other=labels[(i+1)%labels.length],fallback=input.vocabulary.labels.find(l=>l.job_no==='NW07');const tie=i%5===2&&labels.length>1;
        const refs=[{kind:'observation',segment_id:s.segment_id,field:'operation',evidence_id:s.observation.operation.evidence_ids[0]}];
        const example=input.examples.find(e=>e.label.job_no===label.job_no);
        if(example)refs.push({kind:'example',example_id:example.example_id,field:'operation',evidence_id:example.observation.operation.evidence_ids[0]});
        if(input.analysis_strategy==='visual_evidence')refs.push({kind:'actual_video',video_id:input.video_id,start_s:s.start_s,end_s:Math.min(s.start_s+.5,s.end_s)});
        if(input.images[0])refs.push({kind:'standard_image',image_id:input.images[0].image_id});
        const candidate=l=>({job_no:l.job_no,job_title:l.job_title,score:tie?.81:.88,reason:'動作確認用の合成候補。実映像の判定ではありません。',evidence_refs:clone(refs)});
        const selected=tie?fallback:label;
        return {segment_id:s.segment_id,final_label:{job_no:selected.job_no,job_title:selected.job_title},confidence_raw:tie?.92:i%5===3?.62:.88,candidates:tie?[candidate(label),candidate(other)]:[candidate(label)],tie,adoption_reason:tie?'合成例: 候補を識別できないためその他にしています。':'動作確認用の合成ラベルです。精度を示す結果ではありません。',evidence_refs:refs};
      })};
    }
    const payload={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}],modelVersion:'mock-gemini-contract.v1',usageMetadata:{promptTokenCount:120,candidatesTokenCount:80,totalTokenCount:200}};
    const info={url:'mock://local/generateContent',body,raw_response:JSON.stringify(payload),payload,http_status:200,elapsed_ms:Date.now()-started,usage:payload.usageMetadata,usage_is_synthetic:true,remote_outcome_unknown:false,error_code:null,model_id:'mock-gemini-contract.v1',model_version:'mock-gemini-contract.v1',agentic_traces:[]};await onAttempt(info);return {output,...info};
  }
}
export function demoVocabulary() {
  return {schema_version:'vocabulary.v1',vocabulary_version:'synthetic-vocabulary.v1',non_work_labels_version:'non-work.v1',source_pdf_sha256:null,labels:[...['部品を準備する','部品を位置決めする','ねじを仮締めする','仕上がりを確認する'].map((title,i)=>({job_no:String(100+i*10),job_title:title,page_number:`p.${i+1}`,kind:'work',standard_duration_s:6,standard_order:i+1})),...NON_WORK.map((title,i)=>({job_no:`NW0${i+1}`,job_title:title,page_number:'-',kind:'non_work',standard_duration_s:null,standard_order:null}))]};
}
export function demoDiscriminators(v) {return {schema_version:'discriminators.v1',discriminator_version:'synthetic-discriminators.v1',vocabulary_version:v.vocabulary_version,source_refs:[{kind:'synthetic',description:'操作確認専用。評価GTを使用していません。'}],approved_by:'mock-fixture',approved_at:'2026-09-07T00:00:00.000Z',conditions:v.labels.map(l=>({job_no:l.job_no,similar_job_nos:[],observable_features:[],unknown_when:[]}))};}
