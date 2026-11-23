#!/usr/bin/env bash
# Source-only witness on disposable GitHub-hosted Ubuntu; never run on a target machine.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $(id -u) != 0 ]]
[[ $# == 1 ]]
case "$1:$(uname -m)" in
  x64:x86_64) digest=765b846228245704d7796aaa8621b753cc5bbb9aec8d7ccd32c5fc268aa0348a ;;
  arm64:aarch64) digest=0bf637f2cecbd000a158d25b956b7982e30fd720a7537084f024a1a367f6cb11 ;;
  *) printf '%s\n' 'Expected a native Linux x64 or ARM64 runner.' >&2; exit 1 ;;
esac
[[ $(uname -s) == Linux && -s apps/desktop/lib/types/platform-view.js ]]

scratch=$(mktemp -d "$RUNNER_TEMP/dsh-alpha2-ui.XXXXXXXX")
sealed=
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n $sealed ]]; then
    if ! sudo -n rm -rf -- "$sealed"; then status=1; fi
  fi
  if ! rm -rf -- "$scratch"; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
release=44.11.5
archive=electron-v$release-linux-$1.zip
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --retry 1 --max-time 150 --max-filesize 300000000 \
  --output "$scratch/$archive" "https://github.com/electron/electron/releases/download/v$release/$archive"
printf '%s  %s\n' "$digest" "$scratch/$archive" | sha256sum --check --status

# Configure Chromium's documented Linux sandbox helper exclusively from the pinned official
# archive in a root-owned directory; never mark the workspace Electron helper privileged.
[[ $(stat -c '%u:%a' /opt) == 0:755 && ! -L /opt ]]
created=$(sudo -n mktemp -d /opt/dsh-alpha2-electron.XXXXXXXX)
[[ $created =~ ^/opt/dsh-alpha2-electron\.[A-Za-z0-9]{8}$ ]]
sealed=$created
sudo -n install -o root -g root -m 0644 "$scratch/$archive" "$sealed/electron.zip"
printf '%s  %s\n' "$digest" "$sealed/electron.zip" | sudo -n sha256sum --check --status
sudo -n unzip -q "$sealed/electron.zip" -d "$sealed"
sudo -n rm -- "$sealed/electron.zip"
unexpected=$(sudo -n find "$sealed" \( ! -user root -o -perm /022 -o \( ! -type f -a ! -type d \) -o -perm /6000 \) -print)
[[ -z $unexpected ]]
sudo -n test -x "$sealed/electron"
sudo -n test -f "$sealed/chrome-sandbox"
sudo -n chmod 4755 "$sealed/chrome-sandbox"
sudo -n chmod 0755 "$sealed"
[[ $(stat -c '%u:%a' "$sealed/chrome-sandbox") == 0:4755 ]]
unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ASAR ELECTRON_DISABLE_SANDBOX CHROME_DEVEL_SANDBOX
export DSH_TEST_ELECTRON="$sealed/electron"
printf '%s\n' 'Pinned Electron sandbox helper verified in a sealed runner directory.'

cat > "$scratch/preload.cjs" <<'JS'
require('electron').contextBridge.exposeInMainWorld('isSandboxed', process.sandboxed === true)
JS
cat > "$scratch/main.cjs" <<'JS'
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  await window.loadURL('data:text/html,<title>sandbox-check</title>')
  if (await window.webContents.executeJavaScript('globalThis.isSandboxed') !== true) {
    throw new Error('Electron renderer did not report an active sandbox')
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
JS
if timeout --kill-after=5s 45s xvfb-run -a "$DSH_TEST_ELECTRON" \
  --user-data-dir="$scratch/profile" "$scratch/main.cjs" > "$scratch/launch.log" 2>&1; then
  printf '%s\n' 'Chromium renderer reported an active sandbox.'
else
  status=$?
  tail -n 40 -- "$scratch/launch.log" >&2
  exit "$status"
fi
xvfb-run -a pnpm exec vitest run --config vitest.e2e.config.ts \
  apps/desktop/tests/platform-storage.e2e.ts | tee "$scratch/test.log"
grep -E 'Test Files[[:space:]]+1 passed \(1\)' "$scratch/test.log"
printf '%s\n' '- Electron UI: sandboxed renderer and Desktop storage smoke passed.' | tee -a "$GITHUB_STEP_SUMMARY"
printf '%s\n' 'Alpha source verification passed; no installer was built.' >> "$GITHUB_STEP_SUMMARY"
