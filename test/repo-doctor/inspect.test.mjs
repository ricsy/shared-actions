import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInspection } from '../../scripts/repo-doctor/inspect.mjs'
import {
  InspectionStage,
  InspectionStatus,
  RepoDoctorErrorCode,
  RepoDoctorRunMode,
} from '../../scripts/repo-doctor/protocol.mjs'

describe('repo-doctor inspect', () => {
  it('uses shell:false and keeps running after a quality failure', async () => {
    const fake = spawnSequence([0, 0, 1, 0])
    const result = await runInspection(input(), { execaImpl: fake.execa })

    expect(fake.calls.map(call => call.executable)).toEqual(['pnpm', 'node', 'pnpm', 'pnpm'])
    expect(fake.calls.every(call => call.options.shell === false)).toBe(true)
    expect(fake.calls.every(call => call.options.stdio[1] === process.stderr && call.options.stdio[2] === process.stderr)).toBe(true)
    expect(result.status).toBe(InspectionStatus.Failed)
    expect(result.checks.map(check => [check.command, check.status])).toEqual([
      ['install', InspectionStatus.Passed],
      ['standards', InspectionStatus.Passed],
      ['lint', InspectionStatus.Failed],
      ['test', InspectionStatus.Passed],
    ])
  })

  it('mirrors GitHub dependencies with a token before running install without it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-doctor-inspect-'))
    try {
      await writeFile(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
packages:
  agentlint@git:
    resolution: {commit: abc123, repo: https://github.com/example/agentlint.git, type: git}
`)
      const fake = spawnSequence([0, 0, 0, 0])
      await runInspection(input({
        sourceRoot: root,
        commandPlan: [input().commandPlan[0]],
      }), { execaImpl: fake.execa })

      expect(fake.calls.map(call => call.executable)).toEqual(['git', 'git', 'pnpm', 'node'])
      expect(fake.calls[1].options.env.GIT_CONFIG_KEY_0).toContain('read-token')
      expect(fake.calls[2].options.env.GIT_CONFIG_KEY_0).toContain('file:')
      expect(JSON.stringify(fake.calls.slice(2))).not.toContain('read-token')
      expect(fake.calls[2].args).toEqual(['install', '--frozen-lockfile', '--force'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops project quality commands after prepare failure but still records standards', async () => {
    const fake = spawnSequence([1, 0])
    const result = await runInspection(input(), { execaImpl: fake.execa })

    expect(fake.calls).toHaveLength(2)
    expect(result.status).toBe(InspectionStatus.Incomplete)
    expect(result.checks[0]).toMatchObject({
      stage: InspectionStage.Prepare,
      status: InspectionStatus.Incomplete,
    })
  })

  it('returns a timeout envelope without copying raw command output', async () => {
    const fake = spawnSequence(['hang'])
    const result = await runInspection(input({ mode: RepoDoctorRunMode.StandardsOnly, commandTimeoutMs: 5 }), { execaImpl: fake.execa })

    expect(result.status).toBe(InspectionStatus.Incomplete)
    expect(result.checks[0]).toMatchObject({
      command: 'standards',
      errorCode: RepoDoctorErrorCode.CommandTimedOut,
    })
    expect(JSON.stringify(result)).not.toMatch(/stdout|stderr|secret-output/iu)
  })
})

function input(overrides = {}) {
  return {
    mode: RepoDoctorRunMode.Full,
    sourceRoot: '.',
    repoKitCli: '.repo-doctor/repo-kit/dist/index.mjs',
    commandTimeoutMs: 60_000,
    projectReadToken: 'read-token',
    commandPlan: [
      { id: 'install', stage: InspectionStage.Prepare, executable: 'pnpm', args: ['install', '--frozen-lockfile'] },
      { id: 'lint', stage: InspectionStage.Lint, executable: 'pnpm', args: ['run', 'lint'] },
      { id: 'test', stage: InspectionStage.Test, executable: 'pnpm', args: ['run', 'test'] },
    ],
    ...overrides,
  }
}

function spawnSequence(sequence) {
  const calls = []
  return {
    calls,
    async execa(executable, args, options) {
      calls.push({ executable, args, options })
      const outcome = sequence.shift()
      if (outcome === 'hang')
        return { timedOut: true, exitCode: undefined }
      return { timedOut: false, exitCode: outcome }
    },
  }
}
