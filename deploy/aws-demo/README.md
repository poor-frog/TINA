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

For the separate Speech host, `asr-controller.py` runs on Core's private Compose
network alongside `asr_control.py` and `preflight.py`. It reads both worker URLs
and tokens from Identity's Global defaults, verifies each worker's model and
authenticated audio endpoint before saving an account selection, and reports
their remote status. Configure `gipformer_url` and `viegem_url` with the Speech
host's private endpoints. Speech's deployment manages worker container lifecycles.
The controller requires `TINA_INTERNAL_API_SECRET`, a persistent `/state` directory,
and access to Identity at `ADMIN_API_URL` (default `http://admin-api:8001`). Keep
port 18007 private to the Compose network.

The `TINA - AWS demo Terminal and Bot` workflow publishes these two application
images from `demo/aws` after relevant source changes. Both builds must pass before
their existing `:demo` tags are updated. The main-branch release workflow continues
to publish the complete image set.

## Automatic cleanup of stopped bot and agent workers

`container-cleanup.py` is a Linux host maintenance command, independent of whether
the permanent services use Compose or ECS. It selects only `runtime.managed=true`
bot/worker containers on the operator-selected `DOCKER_NETWORK`, stopped for at
least 15 minutes. ECS services, Compose services/init jobs and running containers
are excluded. The command defaults to a read-only report; `--apply` enables removal.

Before removing a container, it saves its log and all added/modified writable
files into a private, checksummed bundle under
`/var/lib/tina/container-cleanup/archives/<container-id>/<stopped-identity>/`.
This preserves recordings and model caches left in the writable layer. Mounted
volumes stay in place and their contents are not copied through a parent directory.
Container identity/state is rechecked after the archive is flushed to disk;
removal uses the exact ID without force or volume removal. An archive failure,
size limit, or insufficient disk space leaves the container intact. The default
archive budget is 2 GiB per container, with a 1 GiB free-disk reserve. Archives
have no automatic expiry and may contain private session files; keep them private
and review them separately before removing any preserved data.

On Core, install using the exact network configured in runtime's `DOCKER_NETWORK`:

```bash
sudo bash deploy/aws-demo/install-container-cleanup.sh tina-v012_tina
sudo python3 /opt/tina/maintenance/container-cleanup.py --network tina-v012_tina
sudo systemctl start tina-container-cleanup.service
systemctl list-timers tina-container-cleanup.timer
sudo journalctl -u tina-container-cleanup.service -n 30 --no-pager
```

The installer enables a systemd timer every ten minutes while the host is running
(with an initial boot delay). It does not turn on EC2. Runs are serialized with a
file lock and limited to 100 removals each. The service has a CPU/memory budget and
only uses the local Docker socket. Both archive reads and removal target that
same socket, regardless of the operator's Docker context. A CloudWatch Docker log
collector can flush the stopped container during the 15-minute grace; the private
log archive is retained even when remote logging is unavailable. No image rebuild,
GHCR tag change or additional EC2 instance is required.

Run the focused safety tests with:

```bash
python -m unittest discover -s deploy/aws-demo/tests -p 'test_container_cleanup.py' -v
```
