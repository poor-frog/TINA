import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {SettingsDialog} from '../settings';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('keeps credentials masked and sends only the edited model from the redesigned account form',async()=>{
  const prefs={mode:'groq',model:'openai/gpt-oss-20b',api_key:'********abcd'};
  const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/models')return Response.json(init?.method==='PUT'?{...prefs,...JSON.parse(init.body as string)}:prefs);
    if(path==='/api/user/transcription')return Response.json({backend:'default'});
    if(path==='/api/models/catalog')return Response.json({models:[]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetchMock);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Models'}));
  const credential=await screen.findByLabelText('Credential') as HTMLInputElement;
  expect(credential.type).toBe('password');expect(credential.value).toBe('********abcd');
  fireEvent.change(screen.getByLabelText('Chat model'),{target:{value:'openai/gpt-oss-120b'}});
  expect(screen.getByRole('button',{name:'Test model credentials'}).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>{
    const saved=fetchMock.mock.calls.find(([url,init])=>String(url)==='/api/user/models'&&init?.method==='PUT');
    expect(saved).toBeTruthy();expect(JSON.parse(String(saved![1]!.body))).toEqual({model:'openai/gpt-oss-120b',effort:''});
  });
});
