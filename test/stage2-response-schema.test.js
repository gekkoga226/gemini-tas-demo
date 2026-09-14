import test from 'node:test';
import assert from 'node:assert/strict';
import {STAGE2_SCHEMA,STAGE2_SCHEMA_VERSION,STAGE2_EMPTY_EVIDENCE_SCHEMA,STAGE2_EMPTY_EVIDENCE_SCHEMA_VERSION} from '../src/response-schemas.js';
import {validateStage2,FIELDS} from '../src/contracts.js';
import {mockObservation,demoVocabulary,demoDiscriminators} from '../src/mock-model.js';
import {findAgenticTraces} from '../src/geap.js';
import {buildStage2,loadPrompts} from '../src/inputs.js';
import {tasConfig,defaultSettings} from '../src/settings.js';

const segment={segment_id:'seg-0001',start_s:0,end_s:10};
segment.observation=mockObservation(segment,0);
const input={segments:[segment],vocabulary:demoVocabulary(),examples:[{example_id:'ex-1',observation:segment.observation}],images:[{image_id:'img-1'}],analysis_strategy:'visual_evidence',analysis_mode:'few_shot',video_id:'video-1'};
const validRefs=[
  {kind:'observation',segment_id:'seg-0001',field:'operation',evidence_id:'ev-1'},
  {kind:'example',example_id:'ex-1',field:'operation',evidence_id:'ev-1'},
  {kind:'actual_video',video_id:'video-1',start_s:0,end_s:1},
  {kind:'standard_image',image_id:'img-1'},
];
const output=refs=>({schema_version:'stage2.v1',labels:[{segment_id:segment.segment_id,final_label:{job_no:'100',job_title:'部品を準備する'},confidence_raw:.8,candidates:[{job_no:'100',job_title:'部品を準備する',score:.8,reason:'映像で確認',evidence_refs:refs}],tie:false,adoption_reason:'観察に一致',evidence_refs:refs}]});

test('API schema rejects the measured missing-field reference in candidates and adopted evidence',()=>{
  const label=STAGE2_SCHEMA.properties.labels.items.properties;
  for(const schema of [label.evidence_refs.items,label.candidates.items.properties.evidence_refs.items]){
    // Check the actual branch requirements, without claiming to emulate the remote decoder.
    const accepts=ref=>schema.anyOf.some(branch=>branch.properties.kind.enum.includes(ref.kind)&&branch.required.every(key=>Object.hasOwn(ref,key)));
    assert.equal(accepts({kind:'observation',segment_id:'seg-0001',video_id:''}),false);
    for(const ref of validRefs){
      assert.equal(accepts(ref),true);
      const branch=schema.anyOf.find(b=>b.properties.kind.enum.includes(ref.kind));
      assert.deepEqual(Object.keys(branch.properties).sort(),Object.keys(ref).sort());
      for(const key of Object.keys(ref)){
        const missing={...ref};delete missing[key];assert.equal(accepts(missing),false,key);
      }
    }
  }
  assert.notEqual(STAGE2_SCHEMA_VERSION,'stage2.v1');
});

test('server still rejects extra keys, invented evidence, wrong modes and out-of-segment video times',()=>{
  assert.doesNotThrow(()=>validateStage2(output(validRefs),input));
  const invalid=[
    {kind:'observation',segment_id:'seg-0001',video_id:''},
    {...validRefs[0],video_id:''},
    {...validRefs[0],evidence_id:'invented'},
    {...validRefs[0],segment_id:'seg-0002'},
    {...validRefs[2],end_s:11},
    {...validRefs[3],image_id:'invented'},
  ];
  for(const ref of invalid)assert.throws(()=>validateStage2(output([validRefs[0],ref]),input),{code:'INVALID_STAGE2'});
  assert.throws(()=>validateStage2(output(validRefs),{...input,analysis_strategy:'text_only'}),{code:'INVALID_STAGE2'});
  assert.throws(()=>validateStage2(output(validRefs),{...input,analysis_mode:'zero_shot'}),{code:'INVALID_STAGE2'});
});

test('tool token usage alone does not confirm agentic processing',()=>{
  assert.deepEqual(findAgenticTraces({usageMetadata:{toolUsePromptTokenCount:3956,toolUsePromptTokensDetails:[{modality:'IMAGE',tokenCount:1584},{modality:'TEXT',tokenCount:2372}]}}),[]);
  assert.equal(findAgenticTraces({candidates:[{content:{parts:[{processingCall:{}}]}}]}).length,1);
});

test('text input with only occlusion evidence forbids references; real field or video evidence remains usable',async()=>{
  const unknown=structuredClone(segment);
  for(const f of FIELDS)unknown.observation[f]={status:'unknown',value:null,evidence_ids:[]};
  unknown.observation.unobserved_occlusions=FIELDS.map(field=>({field,reason:'作業対象が存在しない',evidence_ids:['ev-1']}));
  const vocabulary=demoVocabulary();
  const args={segments:[unknown],video:{video_id:'video-1',uri:'mock://video-1',mime_type:'video/mp4',duration_s:10},settings:defaultSettings(tasConfig({MOCK_MODE:'true'})),prompts:await loadPrompts(),analysis_strategy:'text_only',analysis_mode:'few_shot',set:{examples:{unguided:[{example_id:'ex-1',label:{job_no:'100',job_title:'部品を準備する'},observation:unknown.observation}]}},vocabulary,discriminators:demoDiscriminators(vocabulary)};
  const built=buildStage2(args);
  assert.deepEqual(built.schema,STAGE2_EMPTY_EVIDENCE_SCHEMA);
  assert.equal(built.schema_version,STAGE2_EMPTY_EVIDENCE_SCHEMA_VERSION);
  const properties=built.schema.properties.labels.items.properties;
  assert.equal(properties.evidence_refs.maxItems,0);
  assert.equal(properties.candidates.items.properties.evidence_refs.maxItems,0);
  assert.deepEqual(JSON.parse(built.body.contents[0].parts[0].text).intervals[0].observation,unknown.observation);
  assert.throws(()=>validateStage2(output([{kind:'observation',segment_id:'seg-0001',field:'objects_parts',evidence_id:'ev-1'}]),{...input,segments:[unknown]}),{code:'INVALID_STAGE2'});
  assert.deepEqual(buildStage2({...args,segments:[segment]}).schema,STAGE2_SCHEMA);
  const withExample={...args,set:{examples:{unguided:[{...args.set.examples.unguided[0],observation:segment.observation}]}}};
  assert.deepEqual(buildStage2(withExample).schema,STAGE2_SCHEMA);
  assert.deepEqual(buildStage2({...withExample,analysis_mode:'zero_shot'}).schema,STAGE2_EMPTY_EVIDENCE_SCHEMA);
  assert.deepEqual(buildStage2({...args,analysis_strategy:'visual_evidence',analysis_mode:'zero_shot'}).schema,STAGE2_SCHEMA);
});
