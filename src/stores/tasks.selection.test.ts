import {beforeEach,describe,it,expect} from 'vitest';
import {useTaskStore,selectTask,setTaskFilters} from './tasks';
import {taskFixture} from '@/features/tasks/fixtures';
describe('workspace-scoped task selection',()=>{
 beforeEach(()=>useTaskStore.setState({tasks:[taskFixture()],roots:['/repo'],activeTaskId:null,activeTaskTab:'概览',filters:{query:'',repositoryRoot:'',attention:false}}));
 it('retains selected tab for the same task and rejects removed repository tasks',()=>{
  selectTask('task-1','证据');selectTask('task-1');expect(useTaskStore.getState().activeTaskTab).toBe('证据');
  useTaskStore.setState({roots:[]});selectTask('task-1','交付');expect(useTaskStore.getState().activeTaskId).toBeNull();
 });
 it('retains filters independently of task and tab navigation',()=>{
  setTaskFilters({query:'Unicode',repositoryRoot:'/repo',attention:true});selectTask('task-1','执行');expect(useTaskStore.getState().filters).toEqual({query:'Unicode',repositoryRoot:'/repo',attention:true});
 });
});
