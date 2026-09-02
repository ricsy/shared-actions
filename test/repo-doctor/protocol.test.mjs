import { describe, expect, it } from 'vitest'
import {
  aggregateInspectionStatus,
  InspectionStage,
  InspectionStatus,
  parseStatusComment,
  RepoDoctorError,
  RepoDoctorErrorCode,
  RepoDoctorRunMode,
  statusCommentMarker,
} from '../../scripts/repo-doctor/protocol.mjs'

describe('repo-doctor protocol', () => {
  it('parses the managed status boundary', () => {
    const document = statusDocument()
    const parsed = parseStatusComment(`${statusCommentMarker}\n\nSummary\n\n\`\`\`json\n${JSON.stringify(document)}\n\`\`\``)

    expect(parsed).toEqual(document)
    expect(parsed.latestAttempt.mode).toBe(RepoDoctorRunMode.Full)
  })

  it('rejects invalid protocol values with a stable error', () => {
    const document = statusDocument()
    document.overall = 'unknown'

    expect(() => parseStatusComment(`${statusCommentMarker}\n\`\`\`json\n${JSON.stringify(document)}\n\`\`\``))
      .toThrowError(expect.objectContaining({
        name: new RepoDoctorError({ errorCode: RepoDoctorErrorCode.StateInvalid }).name,
        errorCode: RepoDoctorErrorCode.StateInvalid,
      }))
  })

  it('aggregates incomplete before failed before passed', () => {
    expect(aggregateInspectionStatus([InspectionStatus.Passed])).toBe(InspectionStatus.Passed)
    expect(aggregateInspectionStatus([InspectionStatus.Passed, InspectionStatus.Failed])).toBe(InspectionStatus.Failed)
    expect(aggregateInspectionStatus([InspectionStatus.Failed, InspectionStatus.Incomplete])).toBe(InspectionStatus.Incomplete)
  })

  it('redacts sensitive detail from external errors', () => {
    const error = new RepoDoctorError({
      errorCode: RepoDoctorErrorCode.GitHubRequestFailed,
      stage: InspectionStage.Standards,
      detail: 'Authorization: Bearer github_pat_secret C:\\Users\\Alice\\project',
      cause: new Error('github_pat_cause_secret'),
    })

    const external = error.toJSON()
    expect(external.errorCode).toBe(RepoDoctorErrorCode.GitHubRequestFailed)
    expect(external.stage).toBe(InspectionStage.Standards)
    expect(JSON.stringify(external)).not.toMatch(/github_pat_|Alice|Authorization/iu)
    expect(external).not.toHaveProperty('cause')
  })
})

function statusDocument() {
  const run = { id: 10, attempt: 1, url: 'https://github.com/acme/widget/actions/runs/10' }
  const check = {
    stage: InspectionStage.Lint,
    command: 'lint',
    status: InspectionStatus.Passed,
    durationMs: 12,
    exitCode: 0,
  }
  return {
    schemaVersion: 1,
    repository: { id: 42, fullName: 'acme/widget', defaultBranch: 'main' },
    overall: InspectionStatus.Passed,
    quality: {
      status: InspectionStatus.Passed,
      checkpoint: { sourceSha: 'a'.repeat(40) },
      checks: [check],
      run,
    },
    standards: {
      status: InspectionStatus.Passed,
      checkpoint: {
        sourceSha: 'a'.repeat(40),
        repoKitSha: 'b'.repeat(40),
        sharedActionsSha: 'c'.repeat(40),
      },
      checks: [],
      run,
    },
    latestAttempt: { mode: RepoDoctorRunMode.Full, status: InspectionStatus.Passed, run },
    checks: [check],
  }
}
