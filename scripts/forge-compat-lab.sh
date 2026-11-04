#!/usr/bin/env bash
# Forge-to-forge compatibility lab: real forges in containers, real HTTP.
#
# Run on any docker host:  scripts/forge-compat-lab.sh [old-ref] [new-ref]
# It builds the old and new forge from this repository, starts forge-old,
# forge-new and forge-new2 on a private docker network, seeds each, drives
# them with scripts/forge-compat-lab/driver.ts, writes the matrix to
# docs/features/forge-origin-compat.md, and stops every container.
#
# old-ref defaults to the last trunk commit before /api/v1/version, whose
# routes match a real 0.5.29 forge (see the doc); new-ref to HEAD.
# LAB_KEEP=1 leaves the forges running to look at.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
old_ref="${1:-ce7846af21ad017d35b56af0feaa57a2694aa974}"
new_ref="${2:-HEAD}"
lab="${LAB_DIR:-/var/tmp/forge-lab}"
net=forge-lab
# exec on the tmpfs: a --mount tmpfs is noexec, and git then skips a repository's
# hooks without a word, which reads exactly like a push-through that never fires.
limits=(--cpus 4 --cpu-shares 256 --memory 4g --tmpfs /data:rw,exec,size=2g,mode=1777)
forges=(forge-old forge-new forge-new2)
mkdir -p "$lab/run"

tree() { # ref dir: a clean tree of what the image needs
  local ref="$1" dir="$2"
  mkdir -p "$dir"
  (cd "$here" && git archive "$ref" Dockerfile package.json tsconfig.json src docs/PRINCIPLES.md) | tar -x -C "$dir"
}

stop_all() {
  [ "${LAB_KEEP:-}" = 1 ] && return 0
  docker stop -t 1 "${forges[@]}" >/dev/null 2>&1 || true
}

if [ -z "${LAB_SKIP_BUILD:-}" ]; then
  tree "$old_ref" "$lab/tree-old"
  tree "$new_ref" "$lab/tree-new"
  docker build -q --build-arg VERSION=0.5.29 --build-arg COMMIT="$old_ref" -t forge-lab:old "$lab/tree-old" >/dev/null
  docker build -q --build-arg VERSION=0.0.0-lab --build-arg COMMIT="$new_ref" -t forge-lab:new "$lab/tree-new" >/dev/null
fi

docker network inspect "$net" >/dev/null 2>&1 || docker network create --internal --subnet "${LAB_SUBNET:-10.250.77.0/24}" "$net" >/dev/null
trap stop_all EXIT

# One throwaway authority for the lab; the forges and the driver trust it, nothing else does.
tls="$lab/run/tls"
mkdir -p "$tls"
docker run --rm -v "$tls:/tls" --user "$(id -u)" forge-lab:new sh -c '
  cd /tls
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj /CN=forge-lab-ca 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout s.key -out s.csr -subj /CN=forge-lab 2>/dev/null
  printf "subjectAltName=DNS:forge-old,DNS:forge-new,DNS:forge-new2" > ext
  openssl x509 -req -in s.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out s.crt -days 2 -extfile ext 2>/dev/null
  cat s.crt s.key > server.pem; chmod 644 server.pem ca.pem'

start() { # name image
  local name="$1" image="$2"
  docker stop -t 1 "$name" >/dev/null 2>&1 || true
  while docker inspect "$name" >/dev/null 2>&1; do sleep 0.2; done
  docker run -d --rm --name "$name" --network "$net" "${limits[@]}" \
    -e "FORGE_URL=https://$name:8443" \
    -e "FORGE_ORIGIN_ALLOW=forge-old:8443,forge-new:8443,forge-new2:8443,forge-gone:8443" \
    -e NODE_EXTRA_CA_CERTS=/tmp/lab-ca.pem -e GIT_SSL_CAINFO=/tmp/lab-ca.pem \
    "$image" sleep infinity >/dev/null
  docker cp "$tls/ca.pem" "$name:/tmp/lab-ca.pem" >/dev/null
  docker cp "$tls/server.pem" "$name:/tmp/lab-server.pem" >/dev/null
  docker cp "$here/scripts/forge-compat-lab/seed.ts" "$name:/tmp/seed.ts" >/dev/null
  docker exec -e "LAB_BULK=${LAB_BULK:-130}" "$name" bun /tmp/seed.ts >/dev/null
  docker exec "$name" cat /tmp/lab-seed.json > "$lab/run/$name.json"
  docker cp "$here/scripts/forge-compat-lab/serve.sh" "$name:/tmp/serve.sh" >/dev/null
  docker exec -d "$name" sh /tmp/serve.sh
  # TLS in front, as any real forge has: a forge refuses a plain-http redirect and token.
  docker exec -d "$name" socat "openssl-listen:8443,fork,reuseaddr,verify=0,cert=/tmp/lab-server.pem" tcp:127.0.0.1:8080
}

start forge-old forge-lab:old
start forge-new forge-lab:new
start forge-new2 forge-lab:new

# The driver stops and restarts forge-old's server, so it runs here, where docker is.
bun_driver=(docker run --rm --name forge-lab-driver --network "$net" --cpus 4 --memory 4g
  -v "$here/scripts/forge-compat-lab:/lab:ro" -v "$lab/run:/run-lab"
  -e "LAB_ONLY=${LAB_ONLY:-}" -e "LAB_BULK=${LAB_BULK:-130}" -e "OLD_REF=$old_ref" -e "NEW_REF=$new_ref" -e "HOME=/tmp" -e NODE_EXTRA_CA_CERTS=/run-lab/tls/ca.pem -e GIT_SSL_CAINFO=/run-lab/tls/ca.pem
  forge-lab:new bun /lab/driver.ts)

# The host side of the driver's requests: stop or start a forge's server.
ctl_loop() {
  while :; do
    if [ -f "$lab/run/ctl-request" ]; then
      read -r verb name name2 < "$lab/run/ctl-request" || true
      case "$verb" in
        down) docker exec "$name" sh -c 'kill -9 "$(cat /tmp/pid)"' >/dev/null 2>&1 || true ;;
        up) docker exec -d "$name" sh /tmp/serve.sh ;;
        sql) docker exec -e "LAB_SQL=$name2" "$name" bun -e 'import {Database} from "bun:sqlite"; new Database("/data/forge.db").run(process.env.LAB_SQL)' >/dev/null || true ;;
      esac
      cat "$lab/run/ctl-request" > "$lab/run/ctl-done"
      mv -f "$lab/run/ctl-request" "$lab/run/ctl-last"
    fi
    sleep 0.2
  done
}
chmod 777 "$lab/run"
mv -f "$lab/run/ctl-request" "$lab/run/ctl-stale" 2>/dev/null || true
: > "$lab/run/ctl-done"
chmod 666 "$lab/run/ctl-done"
ctl_loop &
ctl_pid=$!

"${bun_driver[@]}" | tee "$lab/run/driver.log" || true
kill "$ctl_pid" 2>/dev/null || true

if [ -f "$lab/run/matrix.md" ] && [ -f "$here/scripts/forge-compat-lab/compat-head.md" ]; then
  { cat "$here/scripts/forge-compat-lab/compat-head.md"; cat "$lab/run/matrix.md"; } > "${LAB_DOC:-$here/docs/features/forge-origin-compat.md}"
fi
