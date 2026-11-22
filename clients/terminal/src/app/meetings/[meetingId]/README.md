# app/meetings/[meetingId]

One page: the workbench, with the meeting id carried in the path. `Workbench.resolveFirstView` reads it
(via `meetingIdFromPath`) at first render and opens that meeting's tab; an id that resolves to nothing
renders the meeting tab's not-found state.

`?askTina=1` is a one-shot extension deep link: the matching meeting opens with Ask TINA expanded,
then the flag is removed from the address bar.
