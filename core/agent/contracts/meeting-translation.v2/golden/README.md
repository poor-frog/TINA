# Grouped translation fixtures

Two consecutive ASR fragments form one original/English phrase with preserved source IDs.

`Translation.grouped.json` is a complete v2 snapshot with one translated group whose `members`
contain both original fragments. Speaker identity and start/end times belong to the whole group;
the English result is returned once. The matching schema is `../translation.schema.json`.

`Translation.partial-retry.json` keeps a timed-out phrase in its own retry cooldown while a new
phrase remains eligible (`can_advance: true`). `Translation.service-pause.json` shows the same
overlay during an owner-wide quota cooldown; clients retain the original text and poll GET
without automatic POST until the cooldown expires.

Runtime grouping, buffering, failed-provider and edited-source cases are covered by
`core/agent/tests/test_translation_groups.py` and `core/agent/tests/test_meeting_translation.py`
(paths relative to the repository root).
