import { resolve } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { RepoDoctorRunMode } from '../../scripts/repo-doctor/protocol.mjs'

const cli = resolve('scripts/repo-doctor/cli.mjs')

describe('repo-doctor CLI', () => {
  it('provides stable English subcommand help', async () => {
    const result = await execa(process.execPath, [cli, '--help'])

    expect(result.stdout).toContain('Usage: repo-doctor [options] [command]')
    expect(result.stdout).toContain('preflight')
    expect(result.stdout).toContain('inspect')
    expect(result.stdout).toContain('report')
  })

  it('reads JSON from stdin and writes one JSON result', async () => {
    const result = await execa(process.execPath, [cli, 'inspect'], {
      input: JSON.stringify({
        mode: RepoDoctorRunMode.Skip,
        sourceRoot: '.',
        repoKitCli: 'dist/index.mjs',
        commandTimeoutMs: 60_000,
        commandPlan: [{ id: 'install', stage: 'prepare', executable: 'pnpm', args: ['install'] }],
      }),
    })

    expect(JSON.parse(result.stdout)).toEqual({ mode: RepoDoctorRunMode.Skip, status: 'passed', checks: [] })
  })
})
