# TINA agent front door

TINA is a self-hosted meeting and agent system. This checkout has an independent Git repository,
but no remote, public issue tracker, hosted API, or image registry is configured. Do not push or
publish artifacts until the project owner supplies those endpoints.

## Before editing

- Inspect `git status --short --branch` and preserve changes already in the checkout.
- Keep changes limited to the requested behavior. Update every affected caller, configuration
  example, fixture, and document when changing a shared contract.
- The core owns API and event contracts; clients adapt at their boundary.
- For schema or contract changes, update the corresponding seals. For architecture or data-flow
  changes, update `architecture.calm.json` in the same change.
- Keep secrets out of source, logs, examples, and generated artifacts.

## Local development

- Node.js: `>=22.13`; package manager: `pnpm@11.7.0`.
- `make all` builds and starts the Docker Compose stack from this checkout.
- `make lite` builds and starts TINA Lite locally.
- Configure transcription through a self-hosted OpenAI-compatible STT endpoint. TINA has no hosted
  account or transcription service.
- For Kubernetes, build and preload the images yourself; the chart defaults to `imagePullPolicy: Never`.

## Git and release state

- The TINA `.git` directory is standalone and has no remote configured.
- Preserve Apache-2.0 and upstream copyright/third-party notices.
- Do not create commits, rewrite history, add a remote, or publish images unless the user explicitly
  asks and provides any required ownership or destination details.

## Docker cleanup after deployment

- The owner requests automatic cleanup whenever an agent deploys a new container version here.
  After verifying the replacement services are healthy, remove reviewed, stopped, disposable TINA
  containers from completed worker jobs, ended meetings, and superseded deployments without asking
  again. Recheck each candidate's state and remove by exact container ID, without force or volume removal.
- Preserve running services and meetings, Compose initialization dependencies such as `storage-init`,
  all volumes, recordings, model caches, and containers belonging to other projects. Do not use a
  global Docker prune or expand container cleanup to images or build caches without a separate request.
