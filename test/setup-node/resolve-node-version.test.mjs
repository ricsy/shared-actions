import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lowestSupportedNodeVersion, resolveNodeVersion } from '../../.github/actions/setup-node/resolve-node-version.mjs'

const script = '.github/actions/setup-node/resolve-node-version.mjs'

describe('lowestSupportedNodeVersion', () => {
  // 与 repo-kit tests/actions/repo-doctor/command-plan.test.ts 的用例保持一致。
  it.each([
    ['>=24', '^24.0.0'],
    ['>= 24', '^24.0.0'],
    ['^24.11 || ^26', '^24.11.0'],
    ['24.x', '^24.0.0'],
    ['24', '^24.0.0'],
    ['24.11.1', '24.11.1'],
    ['=24.11.1', '24.11.1'],
    ['>=24 <24.5', '24.0.0'],
    ['^22.19.0 || >=24.0.0', '^22.19.0'],
    ['^24.15.0 || >=26.0.0', '^24.15.0'],
    ['>=24.11', '^24.11.0'],
    ['>23', '^24.0.0'],
    ['~24.1', '24.1.0'],
    ['24 - 26', '^24.0.0'],
  ])('runs %s on its lowest supported release line', (range, expected) => {
    expect(lowestSupportedNodeVersion(range)).toBe(expected)
  })

  it.each(['not-a-range', '*', '<20', '>=26 <24'])('rejects %s that has no usable lower bound', (range) => {
    expect(() => lowestSupportedNodeVersion(range)).toThrow('engines.node to be a semver range with a lower bound')
  })
})

describe('resolveNodeVersion', () => {
  it('prefers explicit sources in the repo-kit priority order', () => {
    const manifest = { volta: { node: '22.1.0' }, engines: { node: '>=20' } }
    expect(resolveNodeVersion({ override: '23.0.0', manifest, nodeVersionFile: '21.0.0\n', nvmrc: 'v20.0.0\n' })).toBe('23.0.0')
    expect(resolveNodeVersion({ override: '', manifest, nodeVersionFile: '21.0.0\n', nvmrc: 'v20.0.0\n' })).toBe('22.1.0')
    expect(resolveNodeVersion({ manifest: { engines: { node: '>=20' } }, nodeVersionFile: '21.0.0\n', nvmrc: 'v20.0.0\n' })).toBe('21.0.0')
    expect(resolveNodeVersion({ manifest: { engines: { node: '>=20' } }, nodeVersionFile: '', nvmrc: 'v20.0.0\n' })).toBe('v20.0.0')
    expect(resolveNodeVersion({ manifest: { engines: { node: '>=20' } } })).toBe('^20.0.0')
  })

  it('keeps explicit ranges as written', () => {
    expect(resolveNodeVersion({ override: '>=23', manifest: { engines: { node: '>=24' } } })).toBe('>=23')
  })

  it('fails without engines.node instead of guessing a version', () => {
    expect(() => resolveNodeVersion({ manifest: {} })).toThrow('engines.node')
  })
})

describe('resolve-node-version CLI', () => {
  let root
  afterEach(() => root && rmSync(root, { recursive: true, force: true }))

  it('writes the resolved version to GITHUB_OUTPUT', () => {
    root = mkdtempSync(join(tmpdir(), 'setup-node-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: '>=24' } }))
    const output = join(root, 'output')
    writeFileSync(output, '')
    execFileSync(process.execPath, [script, join(root, 'package.json'), ''], { env: { ...process.env, GITHUB_OUTPUT: output } })
    expect(readFileSync(output, 'utf8')).toBe('version=^24.0.0\n')
  })

  it('reports a workflow error and exits non-zero for an unusable range', () => {
    root = mkdtempSync(join(tmpdir(), 'setup-node-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: '*' } }))
    expect(() => execFileSync(process.execPath, [script, join(root, 'package.json')], { stdio: 'pipe' })).toThrow(/::error::setup-node requires/u)
  })
})
