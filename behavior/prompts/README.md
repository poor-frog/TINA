# Meeting report prompts

`process-meeting.md` is the baked prompt for the post-meeting summary job. It asks the agent to
read the complete transcript and return a grounded Vietnamese report. The flow persists that
report as the meeting summary before notifying recipients.

Keep the `{mid}`, `{native}` and `{date}` inputs compatible with `flows_defs.production`.
Deployment-specific overrides follow the existing behavior/workspace prompt lookup.
