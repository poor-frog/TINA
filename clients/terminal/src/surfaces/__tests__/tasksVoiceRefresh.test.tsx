import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const fixtures=vi.hoisted(()=>({component:null as React.ComponentType|null,paths:[] as string[]}));
vi.mock('../../contributions',()=>({registerList:(value:{component:React.ComponentType})=>{fixtures.component=value.component;}}));
vi.mock('../../app/mode',()=>({meetingsOnly:()=>false}));
vi.mock('../previewPinTab',()=>({usePreviewPinTab:()=>({onClick:()=>{},onDoubleClick:()=>{}})}));
vi.mock('../workspaceApi',()=>({listWorkspaceTree:async()=>fixtures.paths,
  readWorkspaceFile:async()=>`---\ntype: task\nid: voice-test\ntitle: Demo đã duyệt\nstate: open\n---\nTask details.`}));
import '../tasks';
afterEach(()=>{cleanup();fixtures.paths=[];});

it('refreshes Tasks when a voice draft is approved',async()=>{
  const Component=fixtures.component!;render(<Component/>);
  await screen.findByText('No tasks yet — ask the agent in Chat.');
  fixtures.paths=['kg/entities/task/voice-test.md'];
  await act(async()=>{window.dispatchEvent(new Event('tina:tasks-changed'));});
  expect(await screen.findByText('Demo đã duyệt')).toBeTruthy();
});
