#!/usr/bin/env bash
# Install the forge on a box as a systemd service (docs/EXTRACT.md steps 1-3).
# Run as root from a checkout: scripts/box-install.sh [/opt/forge]
# It does not restore and does not start the forge; docs/RESTORE.md lines 3-6
# fill /var/lib/forge, then `systemctl enable --now forge`.
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-/opt/forge}"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
for bin in bun git; do
  command -v "$bin" >/dev/null || { echo "missing binary: $bin" >&2; exit 1; }
done
[ -x /usr/local/bin/bun ] || ln -s "$(command -v bun)" /usr/local/bin/bun

id forge >/dev/null 2>&1 || useradd --system --home /var/lib/forge --shell /usr/sbin/nologin forge
install -d -o forge -g forge -m 700 /var/lib/forge
install -d -m 755 /etc/forge
if [ ! -e /etc/forge/forge.env ]; then
  umask 077
  cat > /etc/forge/forge.env <<'ENV'
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
systemctl daemon-reload
echo "installed; restore into /var/lib/forge (docs/RESTORE.md), then: systemctl enable --now forge"
