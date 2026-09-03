import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('repo-doctor reusable workflow', () => {
  it('installs shfmt before running project inspection', async () => {
    const source = await readFile('.github/workflows/repo-doctor.yml', 'utf8')
    const inspect = source.slice(source.indexOf('\n  inspect:'), source.indexOf('\n  report:'))
    const setupIndex = inspect.indexOf('- name: Setup project shfmt')

    expect(setupIndex).toBeGreaterThan(-1)
    expect(inspect).toContain('uses: mfinelli/setup-shfmt@e52fd78d3a9a28dcf46656d4729c5d76be40ac0e # v4.0.1')
    expect(inspect).toContain('shfmt-version: v3.14.0')
    expect(setupIndex).toBeLessThan(inspect.indexOf('- name: Run inspection'))
  })

  it('isolates credentials and checks out helper code from the called workflow revision', async () => {
    const source = await readFile('.github/workflows/repo-doctor.yml', 'utf8')
    const inspect = source.slice(source.indexOf('\n  inspect:'), source.indexOf('\n  report:'))

    expect(source).toContain('repository: ${{ job.workflow_repository }}')
    expect(source).toContain('ref: ${{ job.workflow_sha }}')
    expect(source).toContain('--prod --frozen-lockfile --ignore-scripts')
    expect(source).not.toContain('actions/upload-artifact')
    expect(source).toContain('default: ubuntu-latest')
    expect(source.match(/runs-on: \$\{\{ inputs\.runner \}\}/gu)).toHaveLength(3)
    expect(source.match(/dest: \$\{\{ runner\.temp \}\}\/repo-doctor\/pnpm-helper/gu)).toHaveLength(3)
    expect(source).toContain('dest: ${{ runner.temp }}/repo-doctor/pnpm-project')
    expect(source).not.toContain('dest: .repo-doctor/')
    expect(inspect).not.toContain('REPO_DOCTOR_TOKEN')
    expect(inspect.match(/COMMON_LIB_TOKEN/gu)).toHaveLength(2)
    expect(inspect).toContain('projectReadToken: process.env.PROJECT_READ_TOKEN')
    expect(inspect).toContain('unset PROJECT_READ_TOKEN')
    expect(inspect).toContain('- name: Enforce current inspection status')
    expect(inspect).toContain('JSON.parse(process.env.INSPECTION_RESULT).status !== "passed"')
    expect(inspect.match(/persist-credentials: false/gu)).toHaveLength(3)
  })
})
