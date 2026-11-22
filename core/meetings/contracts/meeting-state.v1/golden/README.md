# Meeting-state fixtures

`Request.fast.json` is a pre-signing immutable fast job. `FastOutput.question.json` pins exact
transcript evidence and provisional extraction. `ReasonOutput.empty.json` pins a reconciliation with
no new items. Runtime checks additionally enforce source presence, exact revisions, identity, leases,
and current item versions; JSON Schema alone does not establish those properties.
