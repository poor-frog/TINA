#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root'; exit 1; fi
command -v iptables >/dev/null || { echo 'Install iptables-nft first'; exit 1; }
cat > /etc/sysctl.d/95-tina-forward.conf <<'SYS'
net.ipv4.ip_forward=1
SYS
sysctl -w net.ipv4.ip_forward=1
cat > /usr/local/sbin/tina-nat.sh <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
NIC=$(ip -4 route show default | awk 'NR==1 {print $5}')
[[ -n "$NIC" ]] || { echo 'No default network interface'; exit 1; }
iptables -t nat -C POSTROUTING -s 10.20.2.0/24 -o "$NIC" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s 10.20.2.0/24 -o "$NIC" -j MASQUERADE
# Forwarded traffic from private subnet toward outbound internet.
iptables -C FORWARD -s 10.20.2.0/24 -o "$NIC" -j ACCEPT 2>/dev/null || \
  iptables -I FORWARD 1 -s 10.20.2.0/24 -o "$NIC" -j ACCEPT
iptables -C FORWARD -d 10.20.2.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
  iptables -I FORWARD 2 -d 10.20.2.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
SCRIPT
chmod 0755 /usr/local/sbin/tina-nat.sh
cat > /etc/systemd/system/tina-nat.service <<'UNIT'
[Unit]
Description=TINA demo NAT on public Core EC2 (private Speech subnet)
Wants=network-online.target
After=network-online.target docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tina-nat.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now tina-nat.service
iptables -t nat -S POSTROUTING | grep '10.20.2.0/24' || true
printf '%s\n' 'NOTE: Also DISABLE Core EC2 source/destination check and add private route 0.0.0.0/0 -> Core ENI in AWS Console.'
