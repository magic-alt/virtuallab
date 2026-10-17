import {parseTaskProfile} from '@/features/tasks/model';
import type {TaskVerificationProfile} from '@/types/tasks';
export function parseProfileDocument(text:string):TaskVerificationProfile {
 if(new TextEncoder().encode(text).byteLength>65536)throw new Error('Profile JSON 不得超过 64 KiB。');
 const profile=parseTaskProfile(text);if(!profile)throw new Error('Profile 不能是 null。');return profile;
}
export function newProfile():TaskVerificationProfile {return {schemaVersion:1,id:'checks',name:'验证检查',description:'',gates:[{id:'unit',label:'Unit',kind:'unit',required:true,approval:'none',executor:{type:'process',program:'npm',args:['test'],cwd:'workspace'}}]};}
export const copyProfile=(profile:TaskVerificationProfile):TaskVerificationProfile=>JSON.parse(JSON.stringify(profile));
