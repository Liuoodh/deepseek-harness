# DSH Linux 桌面移植计划

[English](linux-port.md)

本分支是社区移植，不是 DeepSeek 官方 Linux 安装器。源代码遵循仓库 MIT 许可证和品牌规范；第三方二进制仍遵循其各自许可。

## 架构与改造范围

- Electron 主进程加载本地 Web UI，同一打包产物内通过 Electron Node mode 启动私有 Desktop Host；Host 经现有 CLI profile runner 组装 Cordis、插件与 Skill，通过已认证的回环传输与界面交互。不另建 Web 服务、协议或插件 API。
- 桌面打包仍绑定同源的 Electron、`dsh`、Host、Web、Node/Python/pnpm 和目标架构。只给原打包链加 Linux 目标分支；保留版本清单、权限、可执行文件、ASAR 外置和冒烟检查。Windows/macOS 的发行、签名及更新策略不改。
- Linux 原生 `x64`（amd64/x86_64）和 `arm64`（aarch64）分别构建、执行和验证，不用一种架构跑通来替另一种背书。候选产物提供 DEB 和 RPM，使用独立的 `DSH Linux` 应用标识及启动器图标。Linux 不接入官方 macOS/Windows 更新源；发行候选由 fork 验证后再发布。
- Chromium renderer 沙箱、DSH 工具沙箱、安装器的文件权限是独立验收项。目标系统需要可用的 Chromium 沙箱以及 DSH 支持的 bubblewrap 或符合能力要求的 Landlock；无可用后端时保留拒绝行为，不用 `--no-sandbox` 或自动放开代理工具权限。

## 可行性及验收目标

| 目标 | 当前结论 | 上线前验收 |
|---|---|---|
| Ubuntu 24.04 x64 / arm64 | 第一个构建与功能验收基线，源码已有 Linux 原生工具及运行时目标 | 各架构独立打包、安装、非 root 启动，核对 Electron、Host、Office 和原生工具执行；桌面窗口建立连接、发起并完成实际会话 |
| CentOS Stream 9 x64 / arm64 | 候选；不把 RPM 格式或 Ubuntu 成功等同于支持 | 安装依赖及升级/卸载、ELF/GLIBC/GLIBCXX、X11/Wayland、Chromium/工具沙箱、真实工作区与插件验收 |
| 银河麒麟桌面 V10 SP1 ARM64（`5.4.96-49-kr9a0`） | **首验目标**；实机预检：`dpkg` 架构为 `arm64`，Wayland，glibc 2.31，bubblewrap 0.4.0。先用 ARM64 DEB。 | 对比成品的 ELF 依赖并核对原生包依赖，再验证普通用户启动、Chromium 沙箱、DSH 工具沙箱、中文输入、文件选择器和原有插件/Skill |
| 其他银河麒麟桌面 V10 x64 / arm64 | 候选；[V10 SP1 2503](https://www.kylinos.cn/upload/1/kycms/20250610/1932360363166240768.pdf) 是公开镜像参考，不代表截图中的设备 | 与 CentOS 相同的应用基线，外加麒麟的包管理、桌面及系统加固策略；每个已测 SP/架构单独记录 |
| 银河麒麟桌面 V11 x64 / arm64 | 单独评估，不能继承 V10 的结果 | 先验证[应用隔离及磐石架构](https://www.kylinos.cn/about/news/1962451207332626434.html)下的安装格式、启动方式，以及 Chromium 与 DSH 工具沙箱能否保持可用 |
| CentOS Linux 7 / 8 等旧版本 | 不承诺；旧发行版已结束维护，运行时 ABI 与内核能力也需单独评估 | 只有明确列出目标版本且安全运行时可维护，才另行评估；不为了安装降低系统或应用安全策略 |
| 现有插件和 Skill | 保持 Cordis 接口、profile 和 Skill 发现机制；数据、纯 JS、跨平台工具与 OS 专属依赖分开判定 | 覆盖已有仓库自带插件以及用户样本：加载/配置、客户端、Skills 发现及引用、Pty/搜索/Office、Python/Node、stdio MCP；Windows COM/PowerShell 专属、macOS helper 或仅某 CPU 的二进制须有对应 Linux 后端才可能功能等价 |

## 构建候选安装包

从仓库根目录运行，使用 Node >=24.9 和根清单固定的 pnpm。在 Ubuntu 24.04 原生构建机上另需编译工具（含 `musl-tools`）、`python3`、`pkg-config`、`rpm`、`xz-utils`、`dpkg-dev` 和 `fakeroot`；打包冒烟测试要求构建机内核支持 Landlock 功能探测，仅有 `musl-gcc` 不够；执行 Electron 冒烟测试还需要 [CI 所列的运行依赖](../../../.github/workflows/desktop-linux.yml)。不能在 Windows 或 x64 上代替原生 ARM64 打包。先安装冻结的依赖，再对本机架构进行只读配置与工具链检查：

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/desktop run package:linux:x64 --check
# 在另一台 ARM64 构建机上改用 package:linux:arm64。
```

每次实际打包需先确认精确版本，再传入 `--build-version`；Linux 不接受 `auto`，不会读官方分发配置。生成的 `.deb`、`.rpm` 位于 `apps/desktop/.desktop-build/targets/linux-<arch>/unsigned-artifacts/`。手动运行 [Linux Desktop 工作流](../../../.github/workflows/desktop-linux.yml) 会核对两种包的元数据和架构，并在 Ubuntu 安装、冒烟测试和卸载 DEB，再将包及校验值作为工作流附件留存。不是正式发布，也不会配置应用内更新。GitHub 仅在 fork 默认分支已有工作流文件时接收手动触发；只推送候选分支还不能启动手动构建。默认分支未引入工作流时，可使用原生主机打包命令。Linux 不提供 Desktop 的全局 `dsh` 命令安装菜单；桌面 Host 仍使用包内运行时。

若 CI 的 Ubuntu 环境准备失败，先区分是刷新 APT 软件源索引，还是安装构建依赖。两个步骤分别设有超时；这两类失败都不是安装包构建结果。

## 长期更新

将移植改动提交到 fork 的 `port/` 维护分支。本 fork 用 `port/linux-kylin-arm64` 维护两种 Linux 架构，`upstream` 获取地址使用 `https://github.com/deepseek-ai/deepseek-harness.git`。使用完整 Git 历史，以免遗漏合并基点。获取并审查上游提交和产品版本，把审查过的完整 SHA 和候选分支名填入下例：

```sh
git fetch upstream refs/heads/master:refs/remotes/upstream/master
git rev-parse upstream/master
reviewed=REVIEWED_FULL_SHA
port_ref=refs/heads/port/linux-kylin-arm64
candidate=port/linux-candidate/example
node apps/desktop/scripts/check-linux-upstream.mjs "$reviewed" "$port_ref"
```

预检只检查已提交的内容，不包含未提交改动。它记录移植和上游提交及预计合并树，不改动检出文件、索引或引用；检测到冲突时返回非零并列出涉及文件。预检无冲突后，在干净的工作区从报告记录的移植提交建候选分支，不依赖可能已移动的分支名：

```sh
git switch -c "$candidate" RECORDED_PORT_COMMIT
git merge --no-ff "$reviewed"
git rev-parse 'HEAD^{tree}'
```

核对实际合并树与报告一致。预检有冲突时，先在候选分支解决、审查冲突，再进行测试，不视为预检通过。在 fork 上用候选 PR 跑 [Linux Desktop 工作流](../../../.github/workflows/desktop-linux.yml) 的两个架构，并保留官方已有的跨平台检查。合并前处理冲突和回归；对同一候选提交确认版本后打包，记录 SHA-256 并完成目标机的安装、升级、卸载、账户和插件/Skill 验收。未验证的组合标为未测，不显示为支持。未来官方接口、Electron ABI 或插件清单变化不保证自动兼容；任一已支持组合退化应阻止发布。不使用官方分发端，也不以官方二进制替换 fork 安装。用独立测试 Home 验收升级，保留旧候选安装包并备份数据；上游存储迁移不一定支持降级后读取新数据。

## 目标机验收记录

首验的银河麒麟 ARM64 桌面先采集以下只读信息，无需管理员权限或安装任何软件。`bwrap` 版本只表示程序存在，不证明当前系统策略允许启动沙箱。内核版本也不足以判定是否有厂商回移的 Landlock。记录输出前删除内部标识，不需主机名或用户信息。

```sh
uname -rm
awk -F= '$1 ~ /^(ID|PRETTY_NAME|VERSION_ID|VERSION|BUILD_ID|VARIANT_ID)$/ { print }' /etc/os-release
getconf GNU_LIBC_VERSION
printf 'session=%s\n' "${XDG_SESSION_TYPE:-unknown}"
if command -v dpkg >/dev/null 2>&1; then dpkg --print-architecture; fi
if command -v rpm >/dev/null 2>&1; then rpm --eval '%{_arch}'; fi
if command -v bwrap >/dev/null 2>&1; then bwrap --version; else printf 'bwrap not found\n'; fi
```

安装包在常规桌面依赖之外，声明 Electron 使用的 ALSA、GBM、CUPS、udev 和 NSPR 对应的系统包；DEB 在改名项上允许旧包名或 `t64` 包名。CI 即使已为 Ubuntu 预装这些库，仍检查生成包的依赖字段。两种安装包的版本字段和 APT 实际安装的版本都要与已确认版本一致；CI 解出 RPM 的核心运行文件和 ELF 清单，与已安装 DEB 对比。不执行 RPM 安装脚本，也不等同于在 CentOS 安装。

Ubuntu 安装器冒烟测试以非 root 用户在独立的 X11 显示、D-Bus 会话和空白配置目录中执行已安装的启动器。保留 Chromium 沙箱，只在此进程确实显示首启欢迎窗口时通过。此项不验证登录、真实会话或 Wayland。

手动工作流随包提供 `ELF-ABI.json`，列出 Ubuntu 安装 DEB 后、应用归档之外的目标架构 ELF 文件直接依赖的共享库（`DT_NEEDED`），以及 GLIBC、GLIBCXX、CXXABI 版本要求。`otherElf` 单列捆绑的其他架构预编译文件。此清单有助于在 CentOS Stream 和银河麒麟上预判 ABI 不匹配，但不验证归档内文件、间接依赖、系统内核或运行结果，不能替代目标机验收。已安装目录可用 `node apps/desktop/scripts/report-linux-payload.mjs --app-root '/opt/DSH Linux' --arch x64` 重采集，依赖 GNU `readelf`（`binutils`）；ARM64 改传 `arm64`。

在首验麒麟机上安装 ARM64 DEB 前，可先在开发机把 CI 的成品清单与已观测的 glibc 版本对比；命令不会加载或执行候选安装包中的程序：

```sh
node apps/desktop/scripts/report-linux-payload.mjs --arch arm64 --report /path/to/ELF-ABI.json --target-glibc 2.31
```

存在需要更高 GLIBC 版本的文件，或存在无法按数字版本判断的 GLIBC ABI 名称时，该命令会列出文件和符号并返回非零。无异常也不等于通过验收：这一步不检测 `libstdc++`、依赖解析、Wayland 或沙箱。Ubuntu 的 X11 冒烟不能替代麒麟 Wayland 会话实测；应记录实际显示后端，并测试中文输入和目录选择器。

工作流还随包提供构建阶段生成的 `desktop-runtime.json`，其 SHA-256 也列入 `SHA256SUMS`。在目标机先从可信工作流下载目录执行 `sha256sum -c SHA256SUMS` 并安装匹配的包。使用同一候选提交的开发 checkout，装好开发依赖并生成仓库构建产物后，可运行与 CI 相同的已安装 Host 冒烟，不需要在目标机自己重新打包：

```sh
pnpm --dir apps/desktop exec tsx scripts/smoke-packaged-runtime.ts \
  --installed-linux-root '/opt/DSH Linux' \
  --expected-runtime-dir '/absolute/path/to/workflow-download' \
  --expected-build-version "$APPROVED_VERSION"
```

将 `APPROVED_VERSION` 设为工作流确认的原始版本号（不做 DEB/RPM 格式转换），以普通测试用户执行。验证器先核对架构、应用标识和版本，并用构建侧清单比对安装后的 DSH 归档和外置文件，再用临时配置启动安装包内的 Host，检查原生工具、离线样例插件和 Office Skill。它不验证个人插件、在线登录或安装包签名。安装验收记录 Landlock 探测结果，并要求安装包内的 Host 通过实际选中的 bubblewrap 或 Landlock 执行一条固定命令、报告约束级别。两种后端都不可用时验收失败。构建机仍须支持 Landlock。

每个系统和架构分别记录 `/etc/os-release`、内核和桌面版本、`getconf GNU_LIBC_VERSION`、包 SHA-256、安装/卸载返回码和相关日志。核对非 root 从系统菜单启动、默认 Chromium 沙箱、实际的 DSH 工具沙箱后端、登录和真实会话、中文输入、文件选择器及上一版资料升级。插件/Skill 用允许公开的样本测试，不提交用户的凭证、私有配置或技能正文。Docker/WSL 和 Windows 上的单元测试不能替代目标桌面实测。
