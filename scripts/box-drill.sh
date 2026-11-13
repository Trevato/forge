#!/usr/bin/env bash
# Prove the forge box comes back by itself (docs/EXTRACT.md, "The box beside production").
#
#   scripts/box-drill.sh kill [url]   as root: SIGKILL the forge, wait for `/` to answer
#                                     from a new process, print how long it took.
#   scripts/box-drill.sh boot [url]   after `reboot`: the unit is enabled, active, came up
#                                     on its own this boot, and `/` answers; print when.
#
# url defaults to http://127.0.0.1:${PORT:-3000}/. It only reads systemd and the URL;
# the one thing it changes is the forge process it kills.
set -euo pipefail

unit=forge
mode="${1:-}"
url="${2:-http://127.0.0.1:${PORT:-3000}/}"
limit="${DRILL_LIMIT:-120}" # seconds to wait for `/` before failing

answers() {
  local code
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$url" || true)"
  [[ "$code" =~ ^[23][0-9][0-9]$ ]]
}

main_pid() { systemctl show -p MainPID --value "$unit"; }

case "$mode" in
  kill)
    [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
    answers || { echo "FAIL: $url does not answer before the kill" >&2; exit 1; }
    before="$(main_pid)"
    [ "$before" != 0 ] || { echo "FAIL: $unit has no main process" >&2; exit 1; }
    start="$(date +%s.%N)"
    kill -KILL "$before"
    echo "killed $unit pid $before at $(date -u +%FT%TZ)"
    while :; do
      now="$(main_pid)"
      if [ "$now" != 0 ] && [ "$now" != "$before" ] && answers; then break; fi
      if awk -v s="$start" -v n="$(date +%s.%N)" -v l="$limit" 'BEGIN{exit !(n-s>l)}'; then
        echo "FAIL: $url did not answer within ${limit}s of the kill" >&2
        exit 1
      fi
      sleep 0.2
    done
    took="$(awk -v s="$start" -v n="$(date +%s.%N)" 'BEGIN{printf "%.1f", n-s}')"
    echo "back: pid $now answers $url ${took}s after the kill"
    ;;
  boot)
    enabled="$(systemctl is-enabled "$unit" || true)"
    [ "$enabled" = enabled ] || { echo "FAIL: $unit is $enabled at boot, not enabled" >&2; exit 1; }
    systemctl is-active --quiet "$unit" || { echo "FAIL: $unit is not active" >&2; exit 1; }
    waited=0
    until answers; do
      [ "$waited" -lt "$limit" ] || { echo "FAIL: $url does not answer" >&2; exit 1; }
      sleep 1; waited=$((waited + 1))
    done
    # ActiveEnterTimestampMonotonic counts microseconds since this boot.
    up="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$unit")"
    echo "booted $(uptime -s); $unit enabled, active $(awk -v u="$up" 'BEGIN{printf "%.1f", u/1e6}')s after boot, pid $(main_pid) answers $url"
    ;;
  *)
    echo "usage: $0 kill|boot [url]" >&2
    exit 2
    ;;
esac
