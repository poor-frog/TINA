# Approved action search and calculation tools

The existing LiveKit loop now has `search_approved_actions` and `calculate`. ASR, KWS, VAD,
TTS, model selection, turn deadlines and the two-plan/four-tool limit remain unchanged.

## Share approved actions

In Settings → Voice assistant → Meeting overrides, choose the active meeting and enable
**Share approved tasks and decisions from this meeting**, then save. It defaults off for both
new and existing rooms. Changing it increments the room policy revision and stops the current
voice turn. It does not broaden the four existing source/default options.

Ask “TINA ơi, task demo đã giao ai và hạn khi nào?” or “Quyết định đã lưu của meeting này là gì?”.
The source is the current workspace entity from an approved voice draft belonging to this owner
and this meeting. Approval records nominate server-generated task/decision paths; pending or
discarded drafts, other owners/meetings, mismatched entity identity, symlinks and deleted files are
excluded. No general workspace scan or other meeting access is granted. User-edited current
task status/due/assignee text is read as evidence, with the full document fingerprint. Approved
decision notes indicate owner review, not agreement by every participant.

Up to 32 approved entities are read from at most 1000 draft records, through the existing bounded
document reader. Exceeding a bound refuses the request rather than silently claiming full coverage.
Normal source chunk/retrieval budgets still apply. `search_shared_documents` does not implicitly
search these entities unless separately shared as linked documents. Source inspection, final
answers and history retain fingerprint/policy checks. Revoking this option prevents old references
from granting access, even if an approved draft was created under an older policy revision.

## Calculate

For explicit numeric input, ask “TINA ơi, tính 100 cộng 200”. The planner may call
`calculate` with `{"expression":"100+200"}`. Arithmetic uses a bounded AST interpreter and
Decimal (28 significant digits), with addition, subtraction, multiplication, division,
parentheses and remainder (`%`, not percent conversion). It never evaluates Python functions,
attributes, arbitrary code, powers or expressions over the size bound. There is no currency/unit
conversion, ambiguous comma-number parsing or automatic conversion of spoken number words.

For calendar dates, ask “Đến 2026-11-20 còn bao nhiêu ngày?”. The query is
`{"start_date":"today","end_date":"2026-11-20"}`. `today` is computed using
Asia/Ho_Chi_Minh; other dates must be explicit ISO dates present in the question or source.
The result is signed calendar days, end minus start, not business days. Relative dates such as
“thứ Sáu” need an explicit date, rather than guessing which Friday the speaker meant.

When inputs come from an approved source, lookup returns context handles. A subsequent calculation
can use up to two such handles in `context_handles`; the current question or exactly those sources
must contain all numeric/date operands. The server checks that handles were returned in this turn.
Unsupported/missing inputs produce a tool error, and an empty-evidence final answer asks for explicit
numbers/dates instead of inventing a result. The final model still must use supplied calculation
evidence and original source units; deterministic evaluation alone does not validate that the
planner chose the correct business operation.

Calculated sources contain the expression/date inputs and derived result. Their fingerprints bind
the current operand source fingerprints, and finalization recomputes the successful queries. Removing
or changing an operand source invalidates old results. Original operand references accompany the
answer. Terminal and Extension label these proofs **Phép tính được kiểm tra**, without fabricating
a document or transcript target. Source inspection recomputes proofs against current authorization;
`today`-based proofs may expire across a calendar-day boundary. Calculations are not persisted as
canonical meeting facts, and private contexts never flow into general/public web routes.

Only read-only tools are added. Tests cover SDK tool calls, policy UI/CAS, same-owner/meeting
approval filtering, current status edits, revocation during generation, safe arithmetic/date inputs,
calculation source rendering and unchanged draft review. Real provider planning and meeting audio
remain separate acceptance checks.
