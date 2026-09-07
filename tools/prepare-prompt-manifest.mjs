import fs from 'node:fs/promises';
import {sha256} from '../src/core.js';
const files={unguided_discover:'stage1_discover_v1.md',unguided_fixed:'stage1_fixed_v1.md',guided_discover:'stage1_guided_discover_v1.md',guided_fixed:'stage1_guided_fixed_v1.md',stage2_text:'stage2_text_v1.md',stage2_visual:'stage2_visual_v1.md',freeform_fixed:'probe_stage1_freeform_fixed_v1.md',freeform_stage2:'probe_stage2_freeform_v1.md',vocabulary:'vocabulary_extract_v1.md'};
const prompts={};
for(const [key,file] of Object.entries(files)) { const text=await fs.readFile(new URL('../prompts/'+file,import.meta.url),'utf8'); prompts[key]={file,version:text.split('\n')[0].replace(/^# /,'').split(' /')[0],sha256:sha256(text)}; }
await fs.writeFile(new URL('../prompts/round18.v1.json',import.meta.url),JSON.stringify({schema_version:'prompt-manifest.v1',release:'round18.v1',pairs:{unguided:'unguided-pair.v1',guided:'guided-pair.v1'},prompts},null,2)+'\n');
