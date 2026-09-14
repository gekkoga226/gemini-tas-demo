// Server validators additionally enforce exact keys, input references and mode constraints.
const string = {type:'string'};
const number = {type:'number'};
const boolean = {type:'boolean'};
const array = items => ({type:'array',items});
const object = (properties, required=Object.keys(properties)) => ({type:'object',properties,required});
const strings = array(string);
const field = object({status:{type:'string',enum:['observed','unknown','not_applicable']},value:{type:'string',nullable:true},evidence_ids:strings});
const evidence = object({evidence_id:string,source:{type:'string',enum:['video','audio']},start_s:number,end_s:number,description:string});
export const OBSERVATION_SCHEMA = object({objects_parts:field,work_location_fixture:field,tools_held:field,operation:field,state_before:field,state_after:field,audio_cues:field,unobserved_occlusions:array(object({field:string,reason:string,evidence_ids:strings})),insufficient_discriminative_features:boolean,insufficiency_reasons:strings,evidence:array(evidence)});
export const FIXED_SCHEMA = object({schema_version:{type:'string',enum:['stage1.fixed.v1']},observations:array(object({segment_id:string,observation:OBSERVATION_SCHEMA}))});
export const DISCOVER_SCHEMA = object({schema_version:{type:'string',enum:['stage1.discover.v1']},segments:array(object({segment_id:string,start_s:number,end_s:number,boundary_evidence:object({start_reason:string,end_reason:string}),observation:OBSERVATION_SCHEMA}))});
// This is the API schema revision; the unchanged output contract remains stage2.v1.
export const STAGE2_SCHEMA_VERSION = 'stage2.response.v2';
const reference = (kind, properties) => object({kind:{type:'string',enum:[kind]},...properties});
const ref = {anyOf:[
  reference('observation',{segment_id:string,field:string,evidence_id:string}),
  reference('example',{example_id:string,field:string,evidence_id:string}),
  reference('actual_video',{video_id:string,start_s:number,end_s:number}),
  reference('standard_image',{image_id:string}),
]};
const stage2Schema = refs => object({schema_version:{type:'string',enum:['stage2.v1']},labels:array(object({segment_id:string,final_label:object({job_no:string,job_title:string}),confidence_raw:number,candidates:array(object({job_no:string,job_title:string,score:number,reason:string,evidence_refs:refs})),tie:boolean,adoption_reason:string,evidence_refs:refs}))});
export const STAGE2_SCHEMA = stage2Schema(array(ref));
// Negative/occlusion evidence is not a field observation reference. With no
// linkable field evidence and no video, references must be empty, not invented.
export const STAGE2_EMPTY_EVIDENCE_SCHEMA_VERSION = 'stage2.no-evidence.v1';
export const STAGE2_EMPTY_EVIDENCE_SCHEMA = stage2Schema({...array(ref),maxItems:0,description:'入力に参照可能な観察項目の根拠がないため、空配列を返す。'});
export const FREEFORM_SCHEMA = object({schema_version:{type:'string',enum:['probe.stage1.freeform.fixed.v1']},observations:array(object({segment_id:string,description:string,insufficient_discriminative_features:boolean,insufficiency_reasons:strings,evidence:array(evidence)}))});
export const VOCABULARY_SCHEMA = object({labels:array(object({job_no:string,job_title:string,page_number:string,standard_duration_s:{type:'number',nullable:true},standard_order:{type:'integer',nullable:true}}))});
