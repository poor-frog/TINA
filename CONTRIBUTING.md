# Contributing to TINA

TINA is a self-hosted project. Changes can be proposed through pull requests to the configured
GitHub repository.

## Before making a change

- Read [`AGENTS.md`](AGENTS.md) and inspect the current working tree.
- Keep changes narrow and update affected callers, configuration, fixtures, and documentation.
- Preserve Apache-2.0 and third-party attribution files.
- Push changes to the configured GitHub repository; do not publish images.

## Local development

- Node.js `>=22.13`, `pnpm@11.7.0`; Python services use their local `pyproject.toml`/`uv.lock`.
- `make all` builds the self-hosted Compose stack from this checkout.
- `make lite` builds the TINA Lite image locally.
- Configure model credentials and a private OpenAI-compatible STT endpoint in `.env`.

## Contribution rights

Contributors must have permission to submit their changes under Apache-2.0. See
[`CONTRIBUTOR_RIGHTS.md`](CONTRIBUTOR_RIGHTS.md) for the local rights paths. When DCO sign-off is
required, each author must add their own. Never add sign-offs on another person's behalf or rewrite
shared Git history.

## Automated review

CodeRabbit is configured to review pull requests automatically. Check its comments before merging.
