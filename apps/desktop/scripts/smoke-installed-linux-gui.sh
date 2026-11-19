#!/usr/bin/env bash
# Observe the first-run window of an installed Linux executable on a private X server.
set -euo pipefail
set +m
umask 077

if (( $# != 1 )) || [[ $1 != /* || ! -x $1 || -z ${DISPLAY:-} || -z ${XAUTHORITY:-} || -z ${DBUS_SESSION_BUS_ADDRESS:-} ]] || (( EUID == 0 )); then
  printf '%s\n' 'Usage (non-root): xvfb-run -a dbus-run-session -- bash smoke-installed-linux-gui.sh /absolute/installed/executable' >&2
  exit 2
fi

temporary=$(realpath -- "${RUNNER_TEMP:-/tmp}")
root=$(mktemp -d "$temporary/dsh-installed-gui.XXXXXX")
app_pid=
cleanup() {
  local status=$?
  if [[ -n $app_pid ]]; then
    # The smoke owns this session and all of its processes, not other display clients.
    if kill -TERM -- "-$app_pid" 2>/dev/null; then
      sleep 1
      kill -KILL -- "-$app_pid" 2>/dev/null || true
    else
      kill -TERM "$app_pid" 2>/dev/null || true
    fi
    wait "$app_pid" 2>/dev/null || true
  fi
  if (( status != 0 )); then
    for log in "$root/launch.log" "$root/startup-error.txt"; do
      if [[ -s $log ]]; then
        printf '\n--- %s ---\n' "${log##*/}" >&2
        tail -c 16384 -- "$log" >&2
      fi
    done
  fi
  cd /
  rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -- "$root/home" "$root/dsh" "$root/workspace" "$root/config" "$root/data" "$root/cache" "$root/runtime"

# Pass no credentials, inherited Electron switches or user settings to the app.
executable=$1
cd -- "$root/workspace"
setsid -- env -i PATH="$PATH" LANG=C.UTF-8 HOME="$root/home" DSH_HOME="$root/dsh" \
  XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" XDG_RUNTIME_DIR="$root/runtime" \
  DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  DSH_TELEMETRY_DISABLED=1 DSH_DESKTOP_DIAGNOSTIC_FILE="$root/startup-error.txt" \
  "$executable" --ozone-platform=x11 --user-data-dir="$root/browser" > "$root/launch.log" 2>&1 &
app_pid=$!

find_welcome() {
  timeout --kill-after=1s 3s xdotool search --onlyvisible --all --pid "$app_pid" --name '^DeepSeek Harness$'
}

# Upstream only shows this fresh-profile window after Host readiness and welcome.html load.
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if [[ -e "$root/startup-error.txt" ]] || ! kill -0 "$app_pid" 2>/dev/null; then
    printf '%s\n' 'Installed Desktop ended or reported a startup error before showing its welcome window.' >&2
    exit 1
  fi
  if window=$(find_welcome); then
    if [[ ! $window =~ ^[0-9]+$ ]]; then
      printf '%s\n' 'Expected exactly one visible welcome window from the installed Desktop process.' >&2
      exit 1
    fi
    sleep 1
    if [[ ! -e "$root/startup-error.txt" ]] && kill -0 "$app_pid" 2>/dev/null && [[ $(find_welcome) == "$window" ]]; then
      printf '%s\n' 'Installed Desktop showed a stable first-run welcome window on X11.'
      exit 0
    fi
    printf '%s\n' 'Installed Desktop did not keep its welcome window visible.' >&2
    exit 1
  else
    status=$?
    if (( status != 1 )); then
      printf 'Could not query the X11 window (exit %d).\n' "$status" >&2
      exit "$status"
    fi
  fi
  sleep 0.25
done
printf '%s\n' 'Timed out waiting for the installed Desktop welcome window.' >&2
exit 1
