# TINA AWS demo deployment kit

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
