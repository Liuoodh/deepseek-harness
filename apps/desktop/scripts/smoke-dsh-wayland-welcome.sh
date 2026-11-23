#!/usr/bin/env bash
# Run an already-installed unsigned test candidate in a private Weston session, never a real user profile.
set -euo pipefail
set +m
umask 077

if (( $# != 2 || EUID == 0 )) || [[ $1 != /* || ! -x $1 || -z ${DBUS_SESSION_BUS_ADDRESS:-} || $2 != default && $2 != explicit ]]; then
  printf '%s\n' 'Usage (non-root): dbus-run-session -- bash smoke-dsh-wayland-welcome.sh /absolute/installed/executable {default|explicit}' >&2
  exit 2
fi
if [[ $(uname -s) != Linux ]] || ! (command -v weston && command -v wayland-info && command -v node && command -v setsid && command -v timeout) >/dev/null; then
  printf '%s\n' 'Expected Linux, Weston, wayland-info, Node, setsid and timeout.' >&2
  exit 2
fi

parser=$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")/read-dsh-wayland-welcome.mjs")
executable=$1
mode=$2
ozone=()
if [[ $mode == explicit ]]; then ozone=(--ozone-platform=wayland); fi
root=$(mktemp -d /tmp/dsh-wayland-smoke.XXXXXXXX)
compositor=
app_pid=
stop_group() {
  local pid=$1
  [[ -n $pid ]] || return 0
  if kill -TERM -- "-$pid" 2>/dev/null; then
    local attempt
    for attempt in {1..10}; do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
  else
    kill -TERM -- "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  local status=$?
  if (( status != 0 )) && [[ -f $root/client.log ]]; then
    printf 'Wayland client event counts (%s): ' "$mode" >&2
    timeout --kill-after=1s 4s node "$parser" --summary "$root/client.log" >&2 || printf '%s\n' 'unavailable' >&2
  fi
  stop_group "$app_pid"
  stop_group "$compositor"
  cd /
  rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -- "$root/home" "$root/dsh" "$root/workspace" "$root/config" "$root/data" "$root/cache" "$root/runtime"

socket=dsh-test-wayland
setsid -- env -i PATH="$PATH" LANG=C.UTF-8 HOME="$root/home" XDG_RUNTIME_DIR="$root/runtime" \
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  weston --backend=headless-backend.so --use-pixman --socket="$socket" --idle-time=0 --no-config \
  > "$root/weston.log" 2>&1 &
compositor=$!
deadline=$((SECONDS + 15))
while [[ ! -S $root/runtime/$socket ]] && (( SECONDS < deadline )); do
  kill -0 "$compositor" 2>/dev/null || break
  sleep 0.2
done
if [[ ! -S $root/runtime/$socket ]] || ! kill -0 "$compositor" 2>/dev/null; then
  printf '%s\n' 'Private Weston compositor did not start.' >&2
  exit 1
fi

if ! env -i PATH="$PATH" XDG_RUNTIME_DIR="$root/runtime" WAYLAND_DISPLAY="$socket" \
  timeout 6s wayland-info > "$root/control.log" 2>&1 || ! grep -qF 'xdg_wm_base' "$root/control.log"; then
  printf '%s\n' 'Control client could not query the private Wayland compositor and xdg-shell globals.' >&2
  exit 1
fi
printf 'Wayland control client confirmed xdg-shell (%s).\n' "$mode"

cd -- "$root/workspace"
# The default test inherits neither X11 nor an Electron override. The explicit mode only diagnoses backend selection.
setsid -- env -i PATH="$PATH" LANG=C.UTF-8 HOME="$root/home" DSH_HOME="$root/dsh" \
  XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" \
  XDG_RUNTIME_DIR="$root/runtime" XDG_SESSION_TYPE=wayland WAYLAND_DISPLAY="$socket" WAYLAND_DEBUG=client \
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" DSH_TELEMETRY_DISABLED=1 \
  DSH_DESKTOP_DIAGNOSTIC_FILE="$root/startup-error.txt" \
  "$executable" "${ozone[@]}" --user-data-dir="$root/browser" > "$root/client.log" 2>&1 &
app_pid=$!

healthy() {
  [[ ! -e $root/startup-error.txt ]] && kill -0 "$compositor" 2>/dev/null && kill -0 "$app_pid" 2>/dev/null
}
observed() {
  timeout --kill-after=1s 4s node "$parser" "$root/client.log" >/dev/null
}
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if ! healthy; then
    printf '%s\n' 'Installed Desktop or the compositor stopped or reported a startup error.' >&2
    exit 1
  fi
  if observed; then
    sleep 1
    if healthy && observed; then
      printf 'Installed Desktop committed a stable welcome buffer on native Wayland (Weston headless, %s backend selection).\n' "$mode"
      exit 0
    fi
    printf '%s\n' 'Installed Desktop did not keep its native Wayland welcome surface.' >&2
    exit 1
  else
    status=$?
    if (( status != 1 )); then
      printf 'Unable to inspect the private Wayland trace (exit %d).\n' "$status" >&2
      exit "$status"
    fi
  fi
  sleep 0.25
done
printf '%s\n' 'Timed out waiting for a configured and buffered native Wayland welcome surface.' >&2
exit 1
