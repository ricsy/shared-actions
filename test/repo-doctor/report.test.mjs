import { describe, expect, it } from 'vitest'
import {
  buildStatusDocument,
  renderManagedStatus,
  runReport,
} from '../../scripts/repo-doctor/report.mjs'
import {
  InspectionStage,
  InspectionStatus,
  parseManagedStatus,
  RepoDoctorErrorCode,
  RepoDoctorRunMode,
} from '../../scripts/repo-doctor/protocol.mjs'

describe('repo-doctor report', () => {
  it.each([
    [InspectionStatus.Passed, InspectionStatus.Passed, 'b'],
    [InspectionStatus.Failed, InspectionStatus.Failed, 'b'],
    [InspectionStatus.Incomplete, InspectionStatus.Incomplete, 'a'],
  ])('records %s and advances checkpoints only for completed attempts', (checkStatus, expectedStatus, expectedCheckpoint) => {
    const value = buildStatusDocument(input({
      previousStatus: previousStatus('a'),
      inspection: inspection([
        check(InspectionStage.Standards, checkStatus),
        check(InspectionStage.Lint, checkStatus),
      ]),
      sourceSha: 'b'.repeat(40),
    }))

    expect(value.overall).toBe(expectedStatus)
    expect(value.quality.checkpoint.sourceSha).toBe(expectedCheckpoint.repeat(40))
    expect(value.standards.checkpoint.sourceSha).toBe(expectedCheckpoint.repeat(40))
    expect(parseManagedStatus(renderManagedStatus(value))).toEqual(value)
  })

  it('preserves quality during standards-only and renders every current failing stage', () => {
    const previous = previousStatus('a', InspectionStatus.Failed, [
      check(InspectionStage.Lint, InspectionStatus.Failed),
      check(InspectionStage.Build, InspectionStatus.Failed),
    ])
    const value = buildStatusDocument(input({
      mode: RepoDoctorRunMode.StandardsOnly,
      previousStatus: previous,
      inspection: {
        ...inspection([check(InspectionStage.Standards, InspectionStatus.Passed)]),
        mode: RepoDoctorRunMode.StandardsOnly,
      },
    }))

    expect(value.quality).toEqual(previous.quality)
    expect(value.overall).toBe(InspectionStatus.Failed)
    expect(renderManagedStatus(value)).toContain('- Failed stages: `stage:build`, `stage:lint`')
  })

  it('stores the only managed status in the issue body without changing labels', async () => {
    const calls = []
    const client = {
      findInspectionIssue: async () => ({ number: 7 }),
      upsertInspectionIssue: async (...args) => {
        calls.push(['issue', ...args])
        return args[2]
      },
    }

    const result = await runReport(input({
      inspection: inspection([
        check(InspectionStage.Standards, InspectionStatus.Passed),
        check(InspectionStage.Test, InspectionStatus.Failed),
      ]),
    }), client)

    expect(result.overall).toBe(InspectionStatus.Failed)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('issue')
    expect(calls[0][4]).toMatch(/- Repository: `acme\/widget@main`/u)
    expect(calls[0][4]).toContain('- Failed stages: `stage:test`')
  })
})

function input(overrides = {}) {
  return {
    resultsRepository: 'ricsy/repo-doctor',
    repository: { id: 42, fullName: 'acme/widget', defaultBranch: 'main' },
    mode: RepoDoctorRunMode.Full,
    sourceSha: 'b'.repeat(40),
    repoKitSha: 'c'.repeat(40),
    sharedActionsSha: 'd'.repeat(40),
    previousStatus: null,
    inspection: inspection([
      check(InspectionStage.Standards, InspectionStatus.Passed),
      check(InspectionStage.Lint, InspectionStatus.Passed),
    ]),
    run: { id: 10, attempt: 1, url: 'https://github.com/acme/widget/actions/runs/10' },
    ...overrides,
  }
}

function inspection(checks) {
  return {
    mode: RepoDoctorRunMode.Full,
    status: checks.some(value => value.status === InspectionStatus.Incomplete)
      ? InspectionStatus.Incomplete
      : checks.some(value => value.status === InspectionStatus.Failed)
        ? InspectionStatus.Failed
        : InspectionStatus.Passed,
    checks,
  }
}

function check(stage, status) {
  return {
    stage,
    command: stage,
    status,
    durationMs: 10,
    ...(status === InspectionStatus.Passed ? { exitCode: 0 } : {
      exitCode: 1,
      errorCode: RepoDoctorErrorCode.CommandFailed,
    }),
  }
}

function previousStatus(source, qualityStatus = InspectionStatus.Passed, qualityChecks = [check(InspectionStage.Lint, qualityStatus)]) {
  const run = { id: 9, attempt: 1, url: 'https://github.com/acme/widget/actions/runs/9' }
  const quality = {
    status: qualityStatus,
    checkpoint: { sourceSha: source.repeat(40) },
    checks: qualityChecks,
    run,
  }
  const standards = {
    status: InspectionStatus.Passed,
    checkpoint: {
      sourceSha: source.repeat(40),
      repoKitSha: 'c'.repeat(40),
      sharedActionsSha: 'd'.repeat(40),
    },
    checks: [check(InspectionStage.Standards, InspectionStatus.Passed)],
    run,
  }
  return {
    schemaVersion: 1,
    repository: { id: 42, fullName: 'acme/widget', defaultBranch: 'main' },
    overall: qualityStatus,
    quality,
    standards,
    latestAttempt: { mode: RepoDoctorRunMode.Full, status: qualityStatus, run },
    checks: [...qualityChecks, ...standards.checks],
  }
}
