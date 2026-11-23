# TINA AWS deployment kit

Core uses the base Compose file with `core.override.yml` and Caddy. Speech uses
`speech.compose.yml` with Gipformer and a one-time model download. VieGem is
published by the extra-images workflow for later use. The deploy scripts use
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
network alongside `asr_control.py` and `preflight.py`. It reads both worker URLs
and tokens from Identity's Global defaults, verifies each worker's model and
authenticated audio endpoint before saving an account selection, and reports
their remote status. Configure `gipformer_url` and `viegem_url` with the Speech
host's private endpoints. Speech's deployment manages worker container lifecycles.
The controller requires `TINA_INTERNAL_API_SECRET`, a persistent `/state` directory,
and access to Identity at `ADMIN_API_URL` (default `http://admin-api:8001`). Keep
port 18007 private to the Compose network.

The `TINA - AWS Terminal and Bot` workflow publishes these two application
images from `demo/aws` after relevant source changes. Both builds must pass before
their existing `:prod` tags are updated. The main-branch release workflow continues
to publish the complete image set.
