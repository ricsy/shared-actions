import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('repo-doctor reusable workflow', () => {
  it('isolates credentials and checks out helper code from the called workflow revision', async () => {
    const source = await readFile('.github/workflows/repo-doctor.yml', 'utf8')
    const inspect = source.slice(source.indexOf('\n  inspect:'), source.indexOf('\n  report:'))

    expect(source).toContain('repository: ${{ job.workflow_repository }}')
    expect(source).toContain('ref: ${{ job.workflow_sha }}')
    expect(source).toContain('--prod --frozen-lockfile --ignore-scripts')
    expect(source).not.toContain('actions/upload-artifact')
    expect(inspect).not.toContain('REPO_DOCTOR_TOKEN')
    expect(inspect.match(/COMMON_LIB_TOKEN/gu)).toHaveLength(1)
    expect(inspect.match(/persist-credentials: false/gu)).toHaveLength(3)
  })
})
