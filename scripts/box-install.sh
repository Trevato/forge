#!/usr/bin/env bash
# Install the forge on a box as a systemd service (docs/EXTRACT.md steps 1-3).
# Run as root from a checkout: scripts/box-install.sh [/opt/forge [uid]]
# uid is the forge user's (the pod's, so a volume's files need no chown).
# It does not restore and does not start the forge; docs/RESTORE.md lines 3-6
# fill /var/lib/forge, then `systemctl enable --now forge`.
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-/opt/forge}"
uid="${2:-}"
[ -z "$uid" ] || [[ "$uid" =~ ^[0-9]{1,9}$ ]] || { echo "uid must be a number" >&2; exit 1; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
missing=""
for bin in bun git bwrap socat; do
  command -v "$bin" >/dev/null || missing="$missing $bin"
done
command -v chromium >/dev/null || command -v chromium-browser >/dev/null || missing="$missing chromium"
[ -x /usr/local/bin/cloudflared ] || echo "warning: /usr/local/bin/cloudflared is missing; cloudflared-forge cannot start until it is installed" >&2
for port in 3000 2222; do
  ! command -v ss >/dev/null || ! ss -ltn "sport = :$port" | grep -q LISTEN || echo "warning: :$port is already in use on this host; set PORT / FORGE_SSH_PORT in /etc/forge/forge.env" >&2
done
[ -z "$missing" ] || { echo "missing binaries:$missing (bwrap is bubblewrap)" >&2; exit 1; }
[ -x /usr/local/bin/bun ] || ln -s "$(command -v bun)" /usr/local/bin/bun

if ! id forge >/dev/null 2>&1; then
  useradd --system --home /var/lib/forge --shell /usr/sbin/nologin ${uid:+--uid "$uid"} forge
elif [ -n "$uid" ] && [ "$(id -u forge)" != "$uid" ]; then
  echo "user forge exists with uid $(id -u forge), not $uid" >&2; exit 1
fi
# The swap hands a listening socket to the new release (docs/OPERATING.md).
echo "net.ipv4.tcp_migrate_req=1" > /etc/sysctl.d/90-forge.conf
sysctl -p /etc/sysctl.d/90-forge.conf >/dev/null || echo "sysctl not applied now; it is at boot" >&2
install -d -o forge -g forge -m 700 /var/lib/forge
install -d -m 755 /etc/forge
if [ ! -e /etc/forge/forge.env ]; then
  umask 077
  cat > /etc/forge/forge.env <<'ENV'
# PORT=3000
# FORGE_SSH_PORT=2222
# FORGE_URL=https://forge.example
# FORGE_APP_DOMAIN=forge.example
# FORGE_SNAPSHOT_PASSPHRASE=
# S3_ENDPOINT= S3_BUCKET= S3_ACCESS_KEY= S3_SECRET_KEY= S3_REGION=
ENV
fi

if [ "$src" != "$dest" ]; then
  mkdir -p "$dest"
  cp -a "$src/." "$dest/"
fi
chown -R forge:forge "$dest"
(cd "$dest" && runuser -u forge -- bun install --frozen-lockfile)

install -m 644 "$dest/infra/forge-box/forge.service" /etc/systemd/system/forge.service
for u in cloudflared-forge.service forge-github-mirror.service forge-github-mirror.timer; do
  install -m 644 "$dest/infra/forge-box/$u" "/etc/systemd/system/$u"
done
[ -e /etc/forge/cloudflared.yml ] || install -m 644 "$dest/infra/forge-box/cloudflared-forge.yml" /etc/forge/cloudflared.yml
systemctl daemon-reload
echo "to run the GitHub mirror: systemctl enable --now forge-github-mirror.timer (nothing here enables it)"
echo "installed (cloudflared-forge and the mirror timer are installed, not started); restore into /var/lib/forge (docs/RESTORE.md), then: systemctl enable --now forge"
