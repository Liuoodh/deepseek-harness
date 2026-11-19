# DSH Linux Desktop port

[简体中文](linux-port.zh.md)

This is a community port, not an official DeepSeek Linux installer. It starts at `ca33fd6843b205e279c7ccb6cb73a472c78f5760` (`0.2.2-rc.4`), under the repository's MIT license and brand guidelines. Bundled third-party binaries retain their own licenses.

## Architecture and scope

- Electron loads the existing Web UI. The same app starts a private Desktop Host in Electron's Node mode. The Host composes Cordis plugins and skills through the existing CLI profile runner and uses authenticated loopback transport. Linux needs no replacement server or plugin API.
- The existing preparation stages still bind Electron, dsh, Host, Web assets, and the primary Node/Python/pnpm runtime to the target. They retain version metadata, executable permissions, ASAR payload checks, and Host smoke tests. The Windows and macOS release, signing, and update paths are unchanged.
- Build and test `x64` (`amd64`/`x86_64`) and `arm64` (`aarch64`) on matching Linux hosts. DEB and RPM use the fork's `DSH Linux` identity and a separate launcher icon. Linux does not join the official macOS or Windows update feed.
- Verify the Chromium renderer sandbox and the DSH tool sandbox independently. The tool path requires working bubblewrap or a Landlock backend with the required capabilities. Do not disable either sandbox to make a machine pass.

## Qualification targets

| Target | Status | Evidence required before support |
|---|---|---|
| Ubuntu 24.04 x64 and arm64 | First build and test baseline | Build, install, launch as a non-root user, verify Electron, Host, Office and native tools; run a real session from the Desktop UI on each architecture |
| CentOS Stream 9 x64 and arm64 | Candidate, not qualified by an RPM header or an Ubuntu run | Install, upgrade and remove with native package tools; check ELF, GLIBC/GLIBCXX, X11/Wayland, Chromium and DSH sandbox, workspace and plugin behavior |
| User's Kylin ARM64 desktop (`5.4.96-49-kr9a0`) | **First target for qualification**; `aarch64` and the `KYLINOS` kernel marker observed; desktop release, service pack, and package format pending | Check runtime libraries and the active tool sandbox first; then validate non-root install and launch, Chinese input, file picker, existing plugins and skills |
| Other Kylin Desktop V10 x64 and arm64 images | Candidates; [V10 SP1 2503](https://www.kylinos.cn/upload/1/kycms/20250610/1932360363166240768.pdf) is a public reference image, not a claim about the photographed machine | Same checks as CentOS, plus Kylin package tooling, desktop behavior and system security policy; record each tested release and architecture separately |
| Kylin Desktop V11 x64 and arm64 | Separate qualification target, not covered by V10 results | Check the accepted installation format, launch method, and verified operation of both Chromium and DSH sandboxes under the vendor's [application isolation and immutable system](https://www.kylinos.cn/about/news/1962451207332626434.html) |
| End-of-life CentOS Linux 7 and 8 | Not a support target | Require a separate agreement on OS version and a maintainable runtime and security baseline |
| Existing plugins and skills | Existing Cordis, profiles and discovery interfaces are retained | Check built-in and representative user plugins, config, client UI, skill discovery and scripts, PTY, search, Office, Python/Node and stdio MCP. Windows COM/PowerShell-only tools, macOS helpers, and architecture-specific binaries need equivalent Linux dependencies for feature parity |

## Build candidate installers

Run from the repository root with Node >=24.9 and the pnpm version pinned in the root manifest. Native Ubuntu 24.04 build hosts also need build tools including `musl-tools`, `python3`, `pkg-config`, `rpm`, `xz-utils`, `dpkg-dev`, and `fakeroot`. The build kernel must support the functional Landlock probe used by the packaged-runtime smoke; having `musl-gcc` alone is not sufficient. For Electron smoke requirements, see the [Linux Desktop workflow](../../../.github/workflows/desktop-linux.yml). Run dependency installation and the target preflight on the matching host:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/desktop run package:linux:x64 --check
# Use package:linux:arm64 on the separate ARM64 build host.
```

Confirm the exact version before each packaging run and pass it as `--build-version`. Linux rejects `auto` and does not read official distribution settings. Outputs are `.deb` and `.rpm` under `apps/desktop/.desktop-build/targets/linux-<arch>/unsigned-artifacts/`. The manual [workflow](../../../.github/workflows/desktop-linux.yml) checks both package formats and their architectures, installs and removes the DEB on Ubuntu, and attaches the packages and checksums to the run. It neither publishes a release nor configures in-app updates. Linux does not expose Desktop's global `dsh` command installer; the desktop Host still uses the bundled runtime.

## Maintain the fork against upstream

Use `https://github.com/deepseek-ai/deepseek-harness.git` as the `upstream` fetch remote and commit the port to `port/linux-desktop`. Use a full checkout so Git has the history needed to find merge bases. Fetch upstream, review its proposed SHA and product version, then substitute the reviewed full SHA and name the candidate branch:

```sh
git fetch upstream refs/heads/master:refs/remotes/upstream/master
git rev-parse upstream/master
reviewed=REVIEWED_FULL_SHA
candidate=port/linux-candidate/example
node apps/desktop/scripts/check-linux-upstream.mjs "$reviewed"
```

The preflight tests committed trees, not uncommitted work. It records the port and upstream commits and the predicted merge tree without changing the checkout, index or refs. A conflict exits nonzero and lists affected files. For a clean result, start from a clean checkout and use the recorded port commit rather than relying on a branch that may have moved:

```sh
git switch -c "$candidate" RECORDED_PORT_COMMIT
git merge --no-ff "$reviewed"
git rev-parse 'HEAD^{tree}'
```

Compare that tree with the report. If there were conflicts, resolve and review them on a candidate branch before testing instead of treating the preflight as a pass. Run both [Linux Desktop CI jobs](../../../.github/workflows/desktop-linux.yml) on a candidate PR within the fork and keep upstream cross-platform checks. Fix conflicts and regressions before merging. After confirming the build version, package the candidate commit, record SHA-256 checksums, and qualify install, upgrade, uninstall, account, plugins and skills on target systems. Unsupported or untested combinations remain unqualified. Future API, Electron ABI or plugin changes are not automatically compatible; a regression on a supported combination blocks release. Do not send the fork's artifacts to the official distribution service or replace the fork with official binaries. Use a temporary test home to verify upgrades and retain backups and previous installers. An older version may not read data migrated by a newer release.

## Target-machine evidence

On the first Kylin ARM64 desktop, collect the following read-only facts as a regular user before choosing the package format. A `bwrap` version does not prove that system policy permits it to run, and a kernel version does not identify vendor Landlock backports. Remove internal identifiers before sharing the output; no hostname or username is needed.

```sh
uname -rm
awk -F= '$1 ~ /^(ID|PRETTY_NAME|VERSION_ID|VERSION|BUILD_ID|VARIANT_ID)$/ { print }' /etc/os-release
getconf GNU_LIBC_VERSION
printf 'session=%s\n' "${XDG_SESSION_TYPE:-unknown}"
if command -v dpkg >/dev/null 2>&1; then dpkg --print-architecture; fi
if command -v rpm >/dev/null 2>&1; then rpm --eval '%{_arch}'; fi
if command -v bwrap >/dev/null 2>&1; then bwrap --version; else printf 'bwrap not found\n'; fi
```

The package headers declare providers for Electron's ALSA, GBM, CUPS, udev, and NSPR libraries in addition to the usual desktop dependencies. The DEB accepts both the legacy and `t64` library names where they differ. CI checks the dependency fields even if its Ubuntu image already has the necessary libraries. It also checks the approved version against both native package headers, checks the version actually installed by APT, and compares the extracted RPM's core runtime files and ELF inventory against the installed DEB. It does not run RPM installation scripts or test CentOS.

The Ubuntu installer smoke starts the installed launcher as a non-root user under a private X11 display, D-Bus session, and empty configuration. It requires a visible first-run welcome window from that process without disabling Chromium sandboxing. This checks installed startup, not sign-in, a real session, or Wayland.

The manual workflow attaches an `ELF-ABI.json` report from the installed Ubuntu DEB. It lists direct shared-library imports (`DT_NEEDED`) and GLIBC, GLIBCXX, and CXXABI version requirements of target-architecture ELF files outside application archives. `otherElf` lists bundled prebuilds for other architectures separately. The report can identify ABI mismatches before testing CentOS Stream and Kylin, but does not verify archived files, transitive dependencies, kernel capabilities, or runtime behavior. To inspect an installation, run `node apps/desktop/scripts/report-linux-payload.mjs --app-root '/opt/DSH Linux' --arch x64` with GNU `readelf` (`binutils`) or pass `arm64` for that build.

The workflow also attaches the preparation `desktop-runtime.json`, with its SHA-256 in `SHA256SUMS`. On a target machine, first check `sha256sum -c SHA256SUMS` from the trusted workflow download and install the matching package. With a development checkout of the same candidate and its dependencies and repository artifacts built, run the same installed Host smoke without running packaging on the target:

```sh
pnpm --dir apps/desktop exec tsx scripts/smoke-packaged-runtime.ts \
  --installed-linux-root '/opt/DSH Linux' \
  --expected-runtime-dir '/absolute/path/to/workflow-download' \
  --expected-build-version "$APPROVED_VERSION"
```

Set `APPROVED_VERSION` to the workflow's exact installer version (before native package version conversion). Run as a regular test user. The verifier checks the expected architecture, app identity and version, and compares the installed DSH archive and unpacked files with the independent build inventory before booting the packaged Host under a temporary profile. It tests native tools, an offline fixture plugin, and Office skills; it does not test personal plugins, online sign-in, or verify a package signature. Installed verification reports the Landlock probe result but requires the packaged Host to run a fixed command through its selected tool sandbox, either bubblewrap or Landlock, and report its enforcement level. With neither backend usable, verification fails. The native build still requires working Landlock.

Record `/etc/os-release`, kernel and desktop versions, `getconf GNU_LIBC_VERSION`, package checksums, installer exit codes and test logs per OS and architecture. Check non-root launch from the system menu, default Chromium sandbox, the active DSH sandbox backend, account sign-in and a real session, Chinese input, file-picker behavior and upgrade from a previous test install. Use public or approved synthetic plugin and skill samples. Never commit credentials, private configuration, or private skill contents. Container, WSL and Windows unit tests are not substitutes for target desktop qualification.
