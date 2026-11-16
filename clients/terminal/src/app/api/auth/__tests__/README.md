# auth/__tests__

Unit tests for the auth routes (login find-or-create against a mocked admin-api).

Calendar regressions cover missing/expired link intent, owner-bound account linking, ordinary Google
login with a stale link cookie, and complete CalendarList pagination before grant persistence.
