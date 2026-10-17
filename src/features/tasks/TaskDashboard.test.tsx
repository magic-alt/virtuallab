import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {TaskDashboard} from './TaskDashboard';
import {taskFixture} from './fixtures';
describe('actionable task dashboard',()=>{
 it('labels unavailable counts separately from zero',()=>{
  const page=render(<TaskDashboard tasks={[]} readiness={{}} loading={false} error="unavailable" onOpenTask={vi.fn()}/>);expect(screen.queryAllByText('—').length).toBeGreaterThan(0);
  page.rerender(<TaskDashboard tasks={[]} readiness={{}} loading={false} onOpenTask={vi.fn()}/>);expect(screen.getAllByText('0').length).toBeGreaterThan(0);
 });
 it('routes guidance without invoking native work',async()=>{
  const task=taskFixture();const open=vi.fn();render(<TaskDashboard tasks={[task]} readiness={{}} loading={false} onOpenTask={open}/>);
  await userEvent.click(screen.getAllByRole('button',{name:/修复解析器/})[0]);expect(open).toHaveBeenCalledWith(task.id,'概览');expect(screen.getByText(/可同时属于多个/)).toBeVisible();
 });
});
it('does not display a zero readiness-dependent count when a task observation is unavailable',()=>{
 render(<TaskDashboard tasks={[taskFixture()]} readiness={{}} loading={false} onOpenTask={vi.fn()}/>);
 const section=screen.getByRole('heading',{name:'当前修订已验收'}).closest('section')!;expect(section.querySelector('strong')).toHaveTextContent('—');
});
