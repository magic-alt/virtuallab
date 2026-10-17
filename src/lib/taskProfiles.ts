import {invoke} from '@tauri-apps/api/core';
import {isDesktopRuntime} from './backend';
import type {TaskProfileRecord,SaveTaskProfileRequest} from '@/types/taskProfiles';
function desktopOnly() {if(!isDesktopRuntime())throw new Error('Profile 库需要 Tauri 桌面运行时；可使用手动 Profile JSON。');}
export async function listTaskProfiles():Promise<TaskProfileRecord[]> {desktopOnly();return invoke('task_profile_list');}
export async function saveTaskProfile(request:SaveTaskProfileRequest):Promise<TaskProfileRecord> {desktopOnly();return invoke('task_profile_save',{request});}
