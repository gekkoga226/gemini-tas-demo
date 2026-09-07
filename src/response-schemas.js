// API acceptance is unmeasured. Server validators are authoritative and stricter.
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
const ref = object({kind:{type:'string',enum:['observation','example','actual_video','standard_image']},segment_id:string,field:string,evidence_id:string,example_id:string,video_id:string,start_s:number,end_s:number,image_id:string},['kind']);
export const STAGE2_SCHEMA = object({schema_version:{type:'string',enum:['stage2.v1']},labels:array(object({segment_id:string,final_label:object({job_no:string,job_title:string}),confidence_raw:number,candidates:array(object({job_no:string,job_title:string,score:number,reason:string,evidence_refs:array(ref)})),tie:boolean,adoption_reason:string,evidence_refs:array(ref)}))});
export const FREEFORM_SCHEMA = object({schema_version:{type:'string',enum:['probe.stage1.freeform.fixed.v1']},observations:array(object({segment_id:string,description:string,insufficient_discriminative_features:boolean,insufficiency_reasons:strings,evidence:array(evidence)}))});
export const VOCABULARY_SCHEMA = object({labels:array(object({job_no:string,job_title:string,page_number:string,standard_duration_s:{type:'number',nullable:true},standard_order:{type:'integer',nullable:true}}))});
