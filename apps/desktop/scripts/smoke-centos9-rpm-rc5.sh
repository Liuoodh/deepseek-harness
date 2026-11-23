#!/usr/bin/env bash
# Validate only the pinned unsigned rc.5 RPM inside a disposable CentOS Stream 9 container.
set -Eeuo pipefail
export LC_ALL=C
trap 'printf "CentOS RPM check failed at line %s.\n" "$LINENO" >&2' ERR

stage=${1:-}
arch=${2:-}
digest=${3:-}
if (( $# != 3 )) || [[ ! -f /.dockerenv || ! $digest =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Expected a disposable Docker container, stage, native RPM architecture and digest.' >&2
  exit 2
fi
case $arch in
  x86_64|aarch64) ;;
  *) exit 2 ;;
esac
case $stage in
  install|remove) (( EUID == 0 )) ;;
  runtime) (( EUID != 0 )) ;;
  *) exit 2 ;;
esac

# os-release uses shell-compatible assignments with optional quotes.
source /etc/os-release
[[ ${ID:-} == centos && ${NAME:-} == 'CentOS Stream' && ${VERSION_ID:-} == 9 ]]
test "$(uname -m)" = "$arch"
test "$(rpm --eval '%{_arch}')" = "$arch"

pkg=/mnt/dsh-rpm/candidate.rpm
root='/opt/DSH Linux'
menu=/usr/share/applications/io.github.liuoodh.dshlinux.desktop
identity="dsh-linux|0.2.2~rc.5.20261118.1|$arch"
qf='%{NAME}|%{VERSION}|%{ARCH}'

assert_clean() {
  local names
  names=$(rpm -qa --queryformat '%{NAME}\n')
  if grep -qx dsh-linux <<< "$names"; then
    printf '%s\n' 'The RPM was unexpectedly registered.' >&2
    exit 1
  fi
  for path in "$root/dsh-linux" "$menu" /usr/bin/dsh-linux; do
    test ! -e "$path" && test ! -L "$path" || exit 1
  done
}

case $stage in
  install)
    assert_clean
    printf '%s  %s\n' "$digest" "$pkg" | sha256sum --check --strict
    test "$(rpm -qp --queryformat "$qf" "$pkg")" = "$identity"
    dnf -y --setopt=timeout=30 --setopt=retries=2 --setopt=install_weak_deps=False install "$pkg"
    test "$(rpm -q --queryformat "$qf" dsh-linux)" = "$identity"
    test "$(readlink -f /usr/bin/dsh-linux)" = "$root/dsh-linux"
    test -x "$root/chrome-sandbox"
    test -f "$root/resources/app.asar"
    test ! -e "$root/resources/app-update.yml"
    grep -Eq '^MimeType=.*x-scheme-handler/dsh;' "$menu"
    printf 'CentOS Stream 9 installed exact rc.5 RPM and desktop registration (%s).\n' "$arch"
    ;;
  runtime)
    test "$(rpm -q --queryformat "$qf" dsh-linux)" = "$identity"
    linked=$(ldd "$root/dsh-linux")
    if grep -q 'not found' <<< "$linked"; then
      printf '%s\n' "$linked" >&2
      exit 1
    fi
    primary="$root/resources/runtime/primary-runtime/dependencies"
    "$primary/node/bin/node" -e 'if (process.versions.node !== "24.21.0") process.exit(1)'
    "$primary/python/bin/python3" -I -c 'import math, ssl, sys; sys.exit(sys.version_info[:3] != (3, 12, 14))'
    printf 'CentOS Stream 9 resolved Electron libraries and ran bundled Node and Python as non-root (%s).\n' "$arch"
    ;;
  remove)
    dnf -y --setopt=timeout=30 --setopt=retries=2 --setopt=clean_requirements_on_remove=False remove dsh-linux
    assert_clean
    printf 'CentOS Stream 9 removed the RPM and desktop entrypoints (%s).\n' "$arch"
    ;;
esac
