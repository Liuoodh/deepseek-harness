import { expect, it } from 'vitest'
import { desktopTargetBuildPaths, LINUX_DESKTOP_APP_ID } from '../scripts/desktop-build-paths.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

const local = {
  DSH_DESKTOP_APP_ID: LINUX_DESKTOP_APP_ID,
  DSH_DESKTOP_UNSIGNED: '1',
  DSH_DESKTOP_TARGET_PLATFORM: 'linux',
}

it.each(['x64', 'arm64'] as const)('configures a local native Linux %s desktop without update feeds', arch => {
  const config = createElectronBuilderConfig({
    ...local,
    DSH_DESKTOP_TARGET_ARCH: arch,
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_UPDATE_CHANNEL: 'stable',
  }, 'linux', arch)
  const paths = desktopTargetBuildPaths(`linux-${arch}`)
  expect(config).toMatchObject({
    appId: 'io.github.liuoodh.dshlinux',
    productName: 'DSH Linux',
    protocols: [{ name: 'DSH Linux', schemes: ['dsh'] }],
    extraMetadata: {
      dshDesktopAppId: 'io.github.liuoodh.dshlinux',
      productName: 'DSH Linux',
      desktopName: 'io.github.liuoodh.dshlinux.desktop',
      homepage: 'https://github.com/Liuoodh/deepseek-harness',
    },
    artifactName: 'dsh-linux-${version}-${os}-${arch}-unsigned.${ext}',
    linux: { executableName: 'dsh-linux', target: ['deb', 'rpm'], syncDesktopName: true },
    deb: { packageName: 'dsh-linux', depends: expect.arrayContaining([
      'libgtk-3-0t64 | libgtk-3-0', 'libatspi2.0-0t64 | libatspi2.0-0',
      'libasound2t64 | libasound2', 'libgbm1', 'libcups2t64 | libcups2', 'libudev1', 'libnspr4',
    ]) },
    rpm: { packageName: 'dsh-linux', depends: expect.arrayContaining([
      'gtk3', 'at-spi2-core', 'alsa-lib', 'mesa-libgbm', 'cups-libs', 'systemd-libs', 'nspr',
    ]) },
    directories: { output: paths.unsignedArtifacts },
    electronDist: paths.electron,
    asar: true,
    electronFuses: { runAsNode: true },
    publish: null,
  })
  expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  expect(config.extraMetadata).not.toHaveProperty('dshDesktopUpdateChannel')
  expect(config.linux?.maintainer).toMatch(/^DSH Linux community build /u)
  expect(config.linux).not.toHaveProperty('executableArgs')
  expect(config.asarUnpack).toContain(`**/node_modules/@deepseek-ai/node-addon-system-linux-${arch}/bin/landlock-run`)
  expect(config.extraResources.map(resource => resource.to)).toEqual(['runtime', 'icon.png'])
  expect(config.linux?.icon).toMatch(/[/\\]icon-linux\.png$/u)
  expect(config.extraResources.find(resource => resource.to === 'icon.png')?.from).toBe(config.linux?.icon)
})

it('rejects nonlocal Linux releases and private update-qualification payloads', () => {
  expect(() => createElectronBuilderConfig({ ...local, DSH_DESKTOP_UNSIGNED: '0' }, 'linux', 'x64'))
    .toThrow('Linux is only supported for local unsigned builds')
  expect(() => createElectronBuilderConfig(local, 'linux', 'x64', 'qualification-runtime'))
    .toThrow('Linux is only supported for local unsigned builds')
  expect(() => createElectronBuilderConfig({ ...local, DSH_DESKTOP_APP_ID: 'com.deepseek.harness' }, 'linux', 'x64'))
    .toThrow('Linux requires DSH_DESKTOP_APP_ID=io.github.liuoodh.dshlinux')
})

it('requires a matching native Linux build host even with an npm target override', () => {
  const target = { ...local, DSH_DESKTOP_TARGET_ARCH: 'arm64' }
  expect(() => createElectronBuilderConfig(target, 'linux', 'x64'))
    .toThrow('linux-arm64 requires a native Linux arm64 build host')
  expect(() => createElectronBuilderConfig(target, 'win32', 'arm64'))
    .toThrow('linux-arm64 requires a native Linux arm64 build host')
  expect(() => createElectronBuilderConfig({ ...target, DSH_DESKTOP_TARGET_PLATFORM: undefined, npm_config_platform: 'linux' }, 'darwin', 'arm64'))
    .toThrow('linux-arm64 requires a native Linux arm64 build host')
})
