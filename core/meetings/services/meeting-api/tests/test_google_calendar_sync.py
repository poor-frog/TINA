"""Google snapshots must not retain revoked links or invent an all-day join time."""
from datetime import datetime, timezone

from meeting_api.calendar_sync import parse_google_events, sync_user
from meeting_api.collector.fakes import InMemoryTranscriptStore

NOW=datetime(2026,11,16,8,tzinfo=timezone.utc)
LINK='https://meet.google.com/abc-defg-hij'


def event(*,link=LINK,all_day=False,uid='demo'):
    return {'id':uid,'summary':'Demo','start':{'date':'2026-11-17'} if all_day else
        {'dateTime':'2026-11-17T09:00:00+07:00'},'end':{'date':'2026-11-18'} if all_day else
        {'dateTime':'2026-11-17T10:00:00+07:00'},**({'hangoutLink':link} if link else {})}


async def sync(store,item,calendar='work',now=NOW):
    return await sync_user(store,7,parse_google_events([item],now=now),calendar_id=calendar,auto_join_default=True)


async def test_google_link_revocation_disarms_only_the_imported_row_and_can_restore_it():
    store=InMemoryTranscriptStore();await sync(store,event())
    original=(await store.list_meetings(7))[0]
    await sync(store,event(link=None))
    row=(await store.list_meetings(7))[0]
    assert row['id']==original['id'] and row['native_meeting_id'] is None and row['platform']=='unknown'
    assert row.get('constructed_meeting_url') is None and not row['data']['auto_join']
    assert row['data']['scheduled_at']==original['data']['scheduled_at']
    assert (await sync(store,event(link=None)))['counts']=={'created':0,'updated':0,'cancelled':0}
    await sync(store,event())
    row=(await store.list_meetings(7))[0]
    assert row['id']==original['id'] and row['native_meeting_id']=='abc-defg-hij' and row['data']['auto_join']


async def test_revoking_one_calendar_does_not_remove_a_link_still_present_in_another():
    store=InMemoryTranscriptStore();await sync(store,event(),calendar='work');await sync(store,event(),calendar='personal')
    await sync(store,event(link=None),calendar='work')
    row=(await store.list_meetings(7))[0]
    assert row['native_meeting_id']=='abc-defg-hij' and row['data']['auto_join']
    await sync(store,event(link=None),calendar='personal')
    row=(await store.list_meetings(7))[0]
    assert row['native_meeting_id'] is None and not row['data']['auto_join']


async def test_a_revoked_identity_is_not_reused_for_a_new_event_on_the_old_link():
    store=InMemoryTranscriptStore();await sync(store,event())
    parsed=parse_google_events([event(link=None),event(uid='new-event')],now=NOW)
    await sync_user(store,7,parsed,calendar_id='work',auto_join_default=True)
    rows=await store.list_meetings(7)
    assert len(rows)==2
    assert next(r for r in rows if r['data']['calendar_uid']=='demo')['native_meeting_id'] is None
    assert next(r for r in rows if r['data']['calendar_uid']=='new-event')['native_meeting_id']=='abc-defg-hij'


def test_all_day_dates_are_retained_without_a_scheduled_instant_including_today():
    for now in [NOW,datetime(2026,11,17,15,tzinfo=timezone.utc)]:
        item=parse_google_events([event(all_day=True)],now=now)['events'][0]
        assert item['scheduled_at'] is None
        assert item['metadata']['all_day'] is True and item['metadata']['start_date']=='2026-11-17'
        assert item['metadata']['end_date']=='2026-11-18'


async def test_all_day_import_stays_idle_and_timed_transitions_keep_the_same_row():
    store=InMemoryTranscriptStore();await sync(store,event())
    original=(await store.list_meetings(7))[0]
    await sync(store,event(all_day=True))
    row=(await store.list_meetings(7))[0]
    assert row['id']==original['id'] and row['status']=='idle' and not row['data'].get('scheduled_at')
    assert not row['data']['auto_join'] and row['native_meeting_id']=='abc-defg-hij'
    await sync(store,event(all_day=True))
    assert len(await store.list_meetings(7))==1
    await sync(store,event())
    row=(await store.list_meetings(7))[0]
    assert row['status']=='scheduled' and row['data']['auto_join']


async def test_all_day_import_never_overrides_a_manual_schedule_or_its_link():
    store=InMemoryTranscriptStore()
    manual=await store.create_planned_meeting(7,platform='google_meet',native_meeting_id='abc-defg-hij',
        meeting_url=LINK,scheduled_at='2026-11-17T05:00:00+00:00',auto_join=True)
    assert 'canonical_notes' not in manual['data']
    await sync(store,event(all_day=True));await sync(store,event(link=None,all_day=True))
    row=(await store.list_meetings(7))[0]
    assert row['id']==manual['id'] and row['data']['scheduled_at']=='2026-11-17T05:00:00+00:00'
    assert row['native_meeting_id']=='abc-defg-hij' and row['data']['auto_join']


async def test_one_all_day_source_does_not_unschedule_another_timed_source():
    store=InMemoryTranscriptStore();await sync(store,event(),calendar='work')
    await sync(store,event(all_day=True),calendar='personal')
    row=(await store.list_meetings(7))[0]
    assert row['status']=='scheduled' and row['data']['scheduled_at']=='2026-11-17T02:00:00+00:00'
    assert row['data']['auto_join']


async def test_new_all_day_event_has_no_auto_join_time_even_if_calendar_auto_join_is_on():
    store=InMemoryTranscriptStore();await sync(store,event(all_day=True))
    row=(await store.list_meetings(7))[0]
    assert row['status']=='idle' and not row['data'].get('scheduled_at') and not row['data']['auto_join']
    assert row['data']['calendar_sources'][0]['event']['start_date']=='2026-11-17'


async def test_restoring_a_google_link_does_not_override_an_explicit_no_auto_join_choice():
    store=InMemoryTranscriptStore();await sync(store,event())
    row=(await store.list_meetings(7))[0]
    await store.update_planned_meeting(7,row['id'],{'auto_join':False,'auto_join_user_set':True})
    await sync(store,event(link=None));await sync(store,event())
    row=(await store.list_meetings(7))[0]
    assert row['native_meeting_id']=='abc-defg-hij' and not row['data']['auto_join']


async def test_removing_a_google_link_never_detaches_a_manual_plan():
    store=InMemoryTranscriptStore()
    manual=await store.create_planned_meeting(7,platform='google_meet',native_meeting_id='abc-defg-hij',
        meeting_url=LINK,scheduled_at='2026-11-17T02:00:00+00:00',auto_join=True)
    await sync(store,event());await sync(store,event(link=None))
    row=(await store.list_meetings(7))[0]
    assert row['id']==manual['id'] and row['native_meeting_id']=='abc-defg-hij' and row['data']['auto_join']


async def test_revoked_google_link_falls_back_to_another_calendars_actual_link():
    store=InMemoryTranscriptStore();await sync(store,event(),calendar='work');await sync(store,event(),calendar='personal')
    await sync(store,event(link='https://meet.google.com/xyz-abcd-efg'),calendar='personal')
    await sync(store,event(link=None),calendar='personal')
    row=(await store.list_meetings(7))[0]
    assert row['native_meeting_id']=='abc-defg-hij' and row['data']['auto_join']


async def test_source_updates_never_change_a_live_bot():
    store=InMemoryTranscriptStore();parsed=parse_google_events([event()],now=NOW)
    source={'id':'work','uid':'demo','name':'Work','auto_join':True,'event':parsed['events'][0]['metadata']}
    store.seed_meeting(user_id=7,platform='google_meet',native_meeting_id='abc-defg-hij',status='active',
        data={'calendar_managed':True,'calendar_sources':[source],'scheduled_at':'2026-11-17T02:00:00+00:00','auto_join':True})
    await sync(store,event(link=None,all_day=True))
    row=(await store.list_meetings(7))[0]
    assert row['status']=='active' and row['native_meeting_id']=='abc-defg-hij'
    assert row['data']['scheduled_at']=='2026-11-17T02:00:00+00:00' and row['data']['auto_join']


async def test_finished_all_day_occurrence_is_not_reimported_but_next_day_can_be():
    store=InMemoryTranscriptStore();item=parse_google_events([event(all_day=True)],now=NOW)['events'][0]
    store.seed_meeting(user_id=7,platform='google_meet',native_meeting_id='abc-defg-hij',status='completed',
        data={'calendar_managed':True,'calendar_sources':[{'id':'work','uid':'demo','event':item['metadata']}],
              'completion_reason':'stopped','stop_requested':True})
    await sync(store,event(all_day=True))
    assert len(await store.list_meetings(7))==1
    tomorrow=event(all_day=True);tomorrow.update(start={'date':'2026-11-18'},end={'date':'2026-11-19'})
    await sync(store,tomorrow)
    assert len(await store.list_meetings(7))==2


def test_malformed_google_dates_do_not_break_valid_events_or_create_join_times():
    invalid=[event()|{'start':'bad'},event()|{'start':{'date':'bad'}},
             event(all_day=True)|{'end':{'date':'bad'}}]
    parsed=parse_google_events(invalid+[event()],now=NOW)
    assert len(parsed['events'])==1 and parsed['events'][0]['scheduled_at']=='2026-11-17T02:00:00+00:00'


async def test_a_fallback_link_collision_cannot_leave_the_revoked_room_armed():
    store=InMemoryTranscriptStore();await sync(store,event(),calendar='work');await sync(store,event(),calendar='personal')
    await sync(store,event(link='https://meet.google.com/xyz-abcd-efg'),calendar='personal')
    await store.create_planned_meeting(7,platform='google_meet',native_meeting_id='abc-defg-hij',meeting_url=LINK,
        scheduled_at='2026-11-17T02:00:00+00:00',auto_join=True)
    await sync(store,event(link=None),calendar='personal')
    rows=await store.list_meetings(7)
    assert len(rows)==2 and all(r['native_meeting_id']!='xyz-abcd-efg' for r in rows)
    assert len([r for r in rows if r['native_meeting_id']=='abc-defg-hij'])==1
    assert not next(r for r in rows if r['native_meeting_id'] is None)['data']['auto_join']


def test_all_day_window_uses_the_calendar_date_not_the_utc_date():
    now=datetime(2026,11,18,2,tzinfo=timezone.utc)  # still Nov 17 in Los Angeles
    parsed=parse_google_events([event(all_day=True)],now=now,time_zone='America/Los_Angeles')
    assert len(parsed['events'])==1 and parsed['events'][0]['scheduled_at'] is None
    assert not parse_google_events([event(all_day=True)],now=now,time_zone='Asia/Ho_Chi_Minh')['events']


async def test_an_all_day_room_cannot_borrow_another_calendars_timed_auto_join():
    store=InMemoryTranscriptStore();await sync(store,event(),calendar='work');await sync(store,event(),calendar='personal')
    await sync(store,event(link='https://meet.google.com/xyz-abcd-efg',all_day=True),calendar='personal')
    row=(await store.list_meetings(7))[0]
    assert row['native_meeting_id']=='abc-defg-hij' and row['data']['scheduled_at']=='2026-11-17T02:00:00+00:00'
    assert row['data']['auto_join']


async def test_google_api_import_forwards_calendar_timezone_to_all_day_windowing(monkeypatch):
    import httpx
    from meeting_api.calendar_sync.adapters import fetch_google_events
    monkeypatch.setenv('GOOGLE_CLIENT_ID','synthetic-calendar-client')
    monkeypatch.setenv('GOOGLE_CLIENT_SECRET','synthetic-calendar-secret')
    async def upstream(request):
        if request.url.path=='/token':return httpx.Response(200,json={'access_token':'synthetic-access','expires_in':3600})
        return httpx.Response(200,json={'items':[event(all_day=True)]})
    config={'google_calendar_id':'work','google_refresh_token':'synthetic-timezone-refresh',
            'google_time_zone':'America/Los_Angeles'}
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        result,error=await fetch_google_events(config,now=datetime(2026,11,18,2,tzinfo=timezone.utc),client=client)
    assert error is None and result['events'][0]['scheduled_at'] is None
    assert result['events'][0]['metadata']['start_date']=='2026-11-17'
