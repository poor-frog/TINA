#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root'; exit 1; fi
NETWORK=${1:?Usage: install-container-cleanup.sh RUNTIME_DOCKER_NETWORK}
AGE=${TINA_CONTAINER_CLEANUP_MIN_AGE_SECONDS:-900}
if [[ ! "$NETWORK" =~ ^[a-zA-Z0-9_.-]+$ || ! "$AGE" =~ ^[0-9]+$ ]]; then
  echo 'Invalid runtime network or cleanup age'; exit 1
fi
docker network inspect "$NETWORK" >/dev/null
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 0755 /opt/tina/maintenance
install -d -m 0700 /var/lib/tina/container-cleanup
install -m 0755 "$SCRIPT_DIR/container-cleanup.py" /opt/tina/maintenance/container-cleanup.py
cat > /etc/systemd/system/tina-container-cleanup.service <<EOF
[Unit]
Description=Archive and remove expired stopped TINA bot and worker containers
After=docker.service amazon-cloudwatch-agent.service
ConditionPathExists=/var/run/docker.sock

[Service]
Type=oneshot
User=root
UMask=0077
ExecStart=/usr/bin/python3 /opt/tina/maintenance/container-cleanup.py --network $NETWORK --min-age-seconds $AGE --apply
Environment=DOCKER_CONFIG=/run/tina-container-cleanup/docker
RuntimeDirectory=tina-container-cleanup
RuntimeDirectoryMode=0700
Nice=10
IOSchedulingClass=idle
CPUQuota=20%
MemoryMax=256M
TimeoutStartSec=30min
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/tina/container-cleanup
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/tina-container-cleanup.timer <<'EOF'
[Unit]
Description=Clean stopped TINA runtime containers every ten minutes

[Timer]
OnBootSec=5min
OnUnitInactiveSec=10min
AccuracySec=30s
RandomizedDelaySec=30s
Unit=tina-container-cleanup.service

[Install]
WantedBy=timers.target
EOF
systemd-analyze verify /etc/systemd/system/tina-container-cleanup.service /etc/systemd/system/tina-container-cleanup.timer
systemctl daemon-reload
systemctl enable --now tina-container-cleanup.timer
echo 'TINA cleanup timer enabled; run the service once to process existing expired containers.'
