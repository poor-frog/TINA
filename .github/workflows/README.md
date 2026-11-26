# GitHub Actions workflows

`gates.yml` runs static, Node and Python checks in parallel, followed by the
aggregate `gates` check. Pushes to `main`, `Feat/LivetranslationVi2En` and
`feat/asr-quality-refinement`, release tags, pull requests and merge groups
trigger the workflow. Other feature branches run when a pull request is opened.

The ASR-quality branch is based on the latest main and keeps push validation
enabled while the recording-refinement work moves off the live-translation branch.

The Python lane uses Python 3.12 because the transcription worker still requires
NumPy <2.0; NumPy 1.26 has wheels through Python 3.12, not 3.13. The gate streams
package and test progress rather than buffering it until a package finishes.
Blocked tests print a stack after 120 seconds. The Python gate step fails after
20 minutes, and the complete Python job is bounded at 25 minutes; timeouts do not
count as passing checks. The separate TTS test step retains its Python 3.11 runtime.

Once `ghcr-publish.yml` is on `main`, a successful `gates` run for a push to
`main` (or a manual `workflow_dispatch` run) triggers publishing to the
`ghcr.io/poor-frog/tina-<service>` packages. The workflow builds the exact
tested commit for Linux x86-64 (with `provenance: false` and `sbom: false` for
clean AWS ECR/ECS manifests) and publishes each image under its full commit SHA,
including `tina-tts` (VieNeu CPU). It calls `ghcr-publish-extras.yml` to build
the meeting bot, LiveKit voice agent, VieGem (CPU), and optional Gipformer
(`include_gipformer: true`).

After all images build successfully, **Update GHCR prod and latest tags**
retags the complete set to `:prod` and `:latest` (skipping commits superseded on
`main`). Re-run failed jobs in GitHub Actions to retry a build or tag update.
AWS deployments and ECR mirrors pull the promoted `:prod` or `:latest` tags
after that job succeeds.

The build uses a tracked source export that excludes dotenv files. The dashboard
uses the Compose gateway address `http://gateway:8000` as its build argument.
