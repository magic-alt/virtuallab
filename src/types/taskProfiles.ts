import type {TaskVerificationProfile} from './tasks';
export interface TaskProfileRecord {id:string;revision:number;profile:TaskVerificationProfile;updatedAtMs:number}
export interface SaveTaskProfileRequest {profile:TaskVerificationProfile;expectedRevision:number|null}
