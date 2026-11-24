# TINA AWS demo deployment kit

Core uses the base Compose file with `core.override.yml` and Caddy. Speech uses
`speech.compose.yml` with VieGem + KenLM + FSMN-VAD and a one-time model download. The deploy scripts use
prebuilt GHCR images and read runtime configuration from SSM Parameter Store.

- `bootstrap-docker.sh` prepares the EC2 hosts.
- `setup-nat-on-core.sh` is for a topology that uses Core to provide Internet
  egress to Speech. Speech needs connectivity to pull images and fetch models.
- `deploy-core.sh` and `deploy-speech.sh` start their respective stacks.
- `core.env.example` and `speech.env.example` document configuration. Store real
  values in Parameter Store. Private GHCR packages require a read credential.

Review the scripts' SSM region (`us-east-1`), network settings, IAM access, and
Caddy domain before executing any commands. This kit has not been run on EC2.
The original deployment guide is supplied separately in the kit archive.

For the separate Speech host, `asr-controller.py` runs on Core's private Compose
network alongside `asr_control.py` and `preflight.py`. It reads the VieGem URL and token from Identity, verifies the model and authenticated audio
endpoint before saving an account selection, and reports remote status. Set the Speech private
endpoint via the existing `TRANSCRIPTION_SERVICE_URL` in Core's SSM environment. Speech manages
its worker container lifecycle. For an upgrade, end active captures, deploy Speech first,
then deploy Core.
The controller requires `TINA_INTERNAL_API_SECRET`, a persistent `/state` directory,
and access to Identity at `ADMIN_API_URL` (default `http://admin-api:8001`). Keep
port 18007 private to the Compose network.

The `TINA - AWS demo Terminal and Bot` workflow publishes these two application
images from `demo/aws` after relevant source changes. Both builds must pass before
their existing `:demo` tags are updated. The main-branch release workflow continues
to publish the complete image set.
