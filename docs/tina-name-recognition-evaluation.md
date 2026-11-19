Current behavior: the suggested variants (`ti na ơi`, `tiên na ơi`, `tinh anh ơi`, `tin anh ơi`)
are now built-in by owner request, alongside TINA/TINA ơi/tin ơi. The evaluation below is historical;
its text-match counts are not a benchmark of the current expanded built-in set.

# TINA name recognition: alias rollout and paired VieGem trial

## Applied behavior

The latest owner-approved Google Meet (meeting 8) was saved with `ti na ơi`, `tiên na ơi` and `tinh anh ơi`
variants. Only its voice policy changed through the existing owner-scoped revision/CAS repository
operation; source selection, enabled state, recordings and raw/canonical transcript were preserved.
The completed meeting is prepared for a continued bot session. These names are now built-in for all
new bots. Terminal no longer exposes per-meeting alias controls.
At the time of this evaluation, `anh ơi` and `tin ơi` were refused. The owner later requested
`tin ơi` as a fixed accepted prefix; `anh ơi` remains refused. The measurements below describe the
earlier alias set. Matching remains anchored at the utterance
prefix and case-insensitive. In the 34 saved ASR segments of meeting 8, the expanded exact-match
set matches four prefixes versus three with only TINA/TINA ơi. These are text match counts,
not manually verified true activations or audio recall.

## Decoder trial

Pinned VieGem + KenLM + FSMN on local Apple MPS. Same VAD ranges and CTC probabilities were reused
for baseline and name-prior weights 0.25, 0.5, 1.0; alpha=0.35, beta=1.5, beam=32 unchanged.
There were 8 real candidate snippets and 4 additional real snippets from the saved recording,
plus 2 Vietnamese synthetic name calls and 4 synthetic negative sentences including human calls.
Real candidates were located through stored ASR spelling and have no verified reference labels.
They must not be counted as positive ground truth. Audio stayed in private temporary directories;
only hashes, counts and timings were copied to the ignored evaluation report.

| Measurement | Baseline | Each tested positive bias |
| --- | ---: | ---: |
| Changed outputs across all 18 clips | 0 | 0 |
| TINA/ti na prefixes among 8 real candidates | 2 | 2 |
| Such prefixes among 4 unlabeled real controls | 0 | 0 |
| Such prefixes among 4 synthetic negatives | 0 | 0 |
| Such prefixes among 2 synthetic positives | 0 | 0 |

**Decision: production bias remains 0 (off).** This small sweep provides no measured benefit.
Zero observed negative insertions does not establish safety. The synthetic positive misses also
show that a decoder prior alone does not guarantee name recovery. Inference candidate pruning
or acoustic/token alternatives can limit any LM prior; this experiment does not isolate the cause.

The optional server-only `TINA_VIEGEM_NAME_BIAS` knob is bounded to 0..2 and wired for native
MPS and Docker CPU/CUDA startup. It admits the lowercase name to the LM vocabulary and supplies a
completed-word score; even a small positive value changes both lexical eligibility and scoring.
The baseline decoder is not mutated and clients cannot request tuning. Gipformer decoding stays
unchanged. CUDA was not exercised because this host has no NVIDIA GPU.

Before further decoder tuning or training, manually label consented positive/negative meeting
clips, include multiple voices and ordinary calls such as “anh ơi”, and score missed calls,
false activations, transcript errors and response latency on held-out clips. Never globally
replace a common phrase with TINA in saved ASR.
