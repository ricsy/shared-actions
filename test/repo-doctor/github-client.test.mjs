import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitHubClient, repositoryIdentityMarker } from '../../scripts/repo-doctor/github-client.mjs'
import {
  InspectionStage,
  InspectionStatus,
  RepoDoctorErrorCode,
  RepoDoctorRunMode,
  statusCommentMarker,
} from '../../scripts/repo-doctor/protocol.mjs'

describe('GitHubClient', () => {
  let fixture

  beforeEach(async () => {
    fixture = await createGitHubFixture()
  })

  afterEach(async () => {
    await fixture.close()
  })

  it('finds and updates the repository issue without changing its state', async () => {
    fixture.issues.push({
      number: 7,
      title: 'Old title',
      body: `${repositoryIdentityMarker(42)}\nold`,
      state: 'closed',
    })
    const client = new GitHubClient({ token: 'result-token', baseUrl: fixture.baseUrl })

    const issue = await client.findInspectionIssue('ricsy/repo-doctor', 42)
    const updated = await client.upsertInspectionIssue('ricsy/repo-doctor', {
      id: 42,
      fullName: 'acme/widget',
      defaultBranch: 'main',
    }, issue)

    expect(updated.number).toBe(7)
    expect(fixture.issues[0].title).toBe('[Doctor] 仓库巡检：acme/widget')
    expect(fixture.issues[0].body).toMatch(/repo-doctor-repository-id:42/u)
    expect(fixture.issues[0].state).toBe('closed')
    expect(fixture.lastIssuePatch).not.toHaveProperty('state')
  })

  it('updates the only managed comment and preserves ordinary comments', async () => {
    fixture.comments.push(
      { id: 1, body: 'Human note' },
      { id: 2, body: managedComment(InspectionStatus.Failed) },
    )
    const client = new GitHubClient({ token: 'result-token', baseUrl: fixture.baseUrl })

    const managed = await client.findManagedStatusComment('ricsy/repo-doctor', 7)
    await client.upsertManagedStatusComment('ricsy/repo-doctor', 7, managedComment(InspectionStatus.Passed), managed.comment)

    expect(managed.status.overall).toBe(InspectionStatus.Failed)
    expect(fixture.comments.find(comment => comment.id === 1).body).toBe('Human note')
    expect(fixture.comments.find(comment => comment.id === 2).body).toMatch(/"overall":"passed"/u)
    expect(fixture.comments).toHaveLength(2)
  })

  it('rejects duplicate repository issues and managed comments', async () => {
    fixture.issues.push(
      { number: 7, title: 'One', body: repositoryIdentityMarker(42), state: 'open' },
      { number: 8, title: 'Two', body: repositoryIdentityMarker(42), state: 'open' },
    )
    const client = new GitHubClient({ token: 'result-token', baseUrl: fixture.baseUrl })

    await expect(client.findInspectionIssue('ricsy/repo-doctor', 42))
      .rejects.toMatchObject({ errorCode: RepoDoctorErrorCode.StateConflict })

    fixture.comments.push(
      { id: 2, body: managedComment(InspectionStatus.Passed) },
      { id: 3, body: managedComment(InspectionStatus.Failed) },
    )
    await expect(client.findManagedStatusComment('ricsy/repo-doctor', 7))
      .rejects.toMatchObject({ errorCode: RepoDoctorErrorCode.StateConflict })
  })
})

function managedComment(status) {
  const run = { id: 10, attempt: 1, url: 'https://github.com/acme/widget/actions/runs/10' }
  const check = { stage: InspectionStage.Lint, command: 'lint', status, durationMs: 10, exitCode: status === InspectionStatus.Passed ? 0 : 1 }
  const value = {
    schemaVersion: 1,
    repository: { id: 42, fullName: 'acme/widget', defaultBranch: 'main' },
    overall: status,
    quality: { status, checkpoint: { sourceSha: 'a'.repeat(40) }, checks: [check], run },
    standards: {
      status: InspectionStatus.Passed,
      checkpoint: { sourceSha: 'a'.repeat(40), repoKitSha: 'b'.repeat(40), sharedActionsSha: 'c'.repeat(40) },
      checks: [],
      run,
    },
    latestAttempt: { mode: RepoDoctorRunMode.Full, status, run },
    checks: [check],
  }
  return `${statusCommentMarker}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
}

async function createGitHubFixture() {
  const fixture = { issues: [], comments: [], lastIssuePatch: undefined }
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    const url = new URL(request.url, 'http://localhost')

    if (request.method === 'GET' && url.pathname === '/repos/ricsy/repo-doctor/issues')
      return json(response, 200, fixture.issues)
    if (request.method === 'POST' && url.pathname === '/repos/ricsy/repo-doctor/issues') {
      const issue = { number: fixture.issues.length + 1, state: 'open', ...body }
      fixture.issues.push(issue)
      return json(response, 201, issue)
    }
    if (request.method === 'PATCH' && url.pathname === '/repos/ricsy/repo-doctor/issues/7') {
      fixture.lastIssuePatch = body
      Object.assign(fixture.issues.find(issue => issue.number === 7), body)
      return json(response, 200, fixture.issues.find(issue => issue.number === 7))
    }
    if (request.method === 'GET' && url.pathname === '/repos/ricsy/repo-doctor/issues/7/comments')
      return json(response, 200, fixture.comments)
    if (request.method === 'PATCH' && url.pathname === '/repos/ricsy/repo-doctor/issues/comments/2') {
      Object.assign(fixture.comments.find(comment => comment.id === 2), body)
      return json(response, 200, fixture.comments.find(comment => comment.id === 2))
    }
    return json(response, 404, { message: 'not found' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return Object.assign(fixture, {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  })
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request)
    chunks.push(chunk)
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
