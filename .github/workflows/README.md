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

`ghcr-publish.yml` builds and publishes 11 application images for Linux x86-64
from `demo/aws` to `ghcr.io/poor-frog/tina-<service>`. Each image gets the
`demo` tag and the full commit SHA. During the initial rollout, a push triggers
publishing only when it changes the workflow file. GitHub requires the workflow
on the default branch for the manual dispatch button.

The build uses a tracked source export that excludes dotenv files. The dashboard
uses the Compose gateway address `http://gateway:8000` as its build argument.
AWS deployment, bot and speech images are handled separately.
