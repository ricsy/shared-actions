import { describe, expect, it } from 'vitest'
import {
  createPreflightClients,
  decideRunMode,
  runPreflight,
} from '../../scripts/repo-doctor/preflight.mjs'
import {
  InspectionStatus,
  RepoDoctorErrorCode,
  RepoDoctorRunMode,
} from '../../scripts/repo-doctor/protocol.mjs'

const sourceSha = 'a'.repeat(40)
const repoKitSha = 'b'.repeat(40)
const sharedActionsSha = 'c'.repeat(40)

describe('repo-doctor preflight', () => {
  it('selects full, standards-only, skip, and force from the two checkpoints', () => {
    expect(decideRunMode({ force: false, previousStatus: null, sourceSha, repoKitSha, sharedActionsSha })).toBe(RepoDoctorRunMode.Full)
    expect(decideRunMode({ force: false, previousStatus: status({ sourceSha: 'd'.repeat(40) }), sourceSha, repoKitSha, sharedActionsSha })).toBe(RepoDoctorRunMode.Full)
    expect(decideRunMode({ force: false, previousStatus: status({ repoKitSha: 'd'.repeat(40) }), sourceSha, repoKitSha, sharedActionsSha })).toBe(RepoDoctorRunMode.StandardsOnly)
    expect(decideRunMode({ force: false, previousStatus: status(), sourceSha, repoKitSha, sharedActionsSha })).toBe(RepoDoctorRunMode.Skip)
    expect(decideRunMode({ force: true, previousStatus: status(), sourceSha, repoKitSha, sharedActionsSha })).toBe(RepoDoctorRunMode.Full)
  })

  it('forces full when the managed status in the issue body is damaged', async () => {
    const result = await runPreflight({
      sourceRepository: 'acme/widget',
      resultsRepository: 'ricsy/repo-doctor',
      repoKitRepository: 'ricsy/repo-kit',
      sharedActionsRepository: 'ricsy/shared-actions',
      force: false,
    }, clients({ invalid: true }))

    expect(result.mode).toBe(RepoDoctorRunMode.Full)
    expect(result.rebuildStatus).toBe(true)
    expect(result.issueNumber).toBe(7)
    expect(result.previousStatus).toBeNull()
  })

  it('requires each token before creating API clients', () => {
    for (const missing of ['GITHUB_TOKEN', 'COMMON_LIB_TOKEN', 'REPO_DOCTOR_TOKEN']) {
      const environment = {
        GITHUB_TOKEN: 'source-token',
        COMMON_LIB_TOKEN: 'common-token',
        REPO_DOCTOR_TOKEN: 'result-token',
      }
      delete environment[missing]
      expect(() => createPreflightClients(environment))
        .toThrowError(expect.objectContaining({ errorCode: RepoDoctorErrorCode.MissingToken }))
    }
  })
})

function clients({ invalid = false } = {}) {
  return {
    sourceClient: {
      getRepository: async () => ({ id: 42, full_name: 'acme/widget', default_branch: 'main' }),
      getCommitSha: async (repository) => repository === 'acme/widget' ? sourceSha : sharedActionsSha,
    },
    standardsClient: { getCommitSha: async () => repoKitSha },
    resultsClient: {
      findInspectionIssue: async () => ({ number: 7, body: 'managed status' }),
      readInspectionStatus: () => ({
        status: invalid ? null : status(),
        invalid,
      }),
    },
  }
}

function status(overrides = {}) {
  return {
    overall: InspectionStatus.Passed,
    quality: {
      status: InspectionStatus.Passed,
      checkpoint: { sourceSha: overrides.sourceSha ?? sourceSha },
    },
    standards: {
      status: InspectionStatus.Passed,
      checkpoint: {
        sourceSha,
        repoKitSha: overrides.repoKitSha ?? repoKitSha,
        sharedActionsSha: overrides.sharedActionsSha ?? sharedActionsSha,
      },
    },
  }
}
