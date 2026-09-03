import { Octokit } from 'octokit'
import {
  InspectionStage,
  managedStatusMarker,
  parseManagedStatus,
  RepoDoctorError,
  RepoDoctorErrorCode,
} from './protocol.mjs'

/** 根据稳定的 GitHub repository ID 生成 Issue 身份标记。 */
export function repositoryIdentityMarker(repositoryId) {
  return `<!-- repo-doctor-repository-id:${repositoryId} -->`
}

/** 封装 repo-doctor 所需的 GitHub API，并统一错误映射与分页行为。 */
export class GitHubClient {
  /** 创建指定巡检阶段使用的 GitHub 客户端。 */
  constructor({ token, baseUrl = 'https://api.github.com', stage = InspectionStage.Prepare, octokit }) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new RepoDoctorError({
        errorCode: RepoDoctorErrorCode.MissingToken,
        stage,
        detail: 'Required GitHub token is not configured.',
      })
    }
    this.stage = stage
    this.octokit = octokit ?? new Octokit({ auth: token, baseUrl: baseUrl.replace(/\/$/u, '') })
  }

  /** 读取仓库元数据。 */
  async getRepository(fullName) {
    const { owner, repo } = repositoryParts(fullName)
    return this.request(() => this.octokit.rest.repos.get({ owner, repo }))
  }

  /** 解析仓库某个 ref 对应的完整提交 SHA。 */
  async getCommitSha(fullName, ref) {
    const { owner, repo } = repositoryParts(fullName)
    const commit = await this.request(() => this.octokit.rest.repos.getCommit({ owner, repo, ref }))
    if (typeof commit?.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(commit.sha))
      throw stateInvalid(this.stage, 'GitHub commit response did not contain a full SHA.')
    return commit.sha
  }

  /** 按稳定 repository ID 查找唯一的巡检 Issue。 */
  async findInspectionIssue(resultsRepository, repositoryId) {
    const marker = repositoryIdentityMarker(repositoryId)
    const { owner, repo } = repositoryParts(resultsRepository)
    const issues = await this.paginate(this.octokit.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 })
    const matches = issues.filter(issue => typeof issue.body === 'string' && issue.body.includes(marker))
    // repository ID 是唯一主键；重复 Issue 必须人工消歧，不能静默选择其中一个。
    if (matches.length > 1)
      throw stateConflict(this.stage, `Found ${matches.length} issues for repository ID ${repositoryId}.`)
    return matches[0] ?? null
  }

  /** 创建巡检 Issue，或原位更新仓库身份与当前状态。 */
  async upsertInspectionIssue(resultsRepository, repository, existingIssue, statusBody) {
    const { owner, repo } = repositoryParts(resultsRepository)
    const title = `[Doctor] 仓库巡检：${repository.fullName}`
    const body = `${repositoryIdentityMarker(repository.id)}\n\n${statusBody}`
    if (existingIssue === null) {
      return this.request(() => this.octokit.rest.issues.create({ owner, repo, title, body }))
    }
    if (existingIssue.title === title && existingIssue.body === body)
      return existingIssue
    return this.request(() => this.octokit.rest.issues.update({ owner, repo, issue_number: existingIssue.number, title, body }))
  }

  /** 从巡检 Issue 正文解析当前状态。 */
  readInspectionStatus(issue) {
    if (typeof issue?.body !== 'string' || !issue.body.includes(managedStatusMarker))
      return { status: null, invalid: false }
    try {
      return { status: parseManagedStatus(issue.body), invalid: false }
    }
    catch (error) {
      if (error instanceof RepoDoctorError && error.errorCode === RepoDoctorErrorCode.StateInvalid)
        return { status: null, invalid: true }
      throw error
    }
  }

  /** 用完整目标集合替换 Issue labels。 */
  async replaceIssueLabels(resultsRepository, issueNumber, labels) {
    const { owner, repo } = repositoryParts(resultsRepository)
    return this.request(() => this.octokit.rest.issues.setLabels({ owner, repo, issue_number: issueNumber, labels }))
  }

  /** 执行 Octokit 分页请求并校验列表响应。 */
  async paginate(route, parameters) {
    try {
      const values = await this.octokit.paginate(route, parameters)
      if (!Array.isArray(values))
        throw stateInvalid(this.stage, 'GitHub list response was not an array.')
      return values
    }
    catch (cause) {
      if (cause instanceof RepoDoctorError)
        throw cause
      throw githubRequestFailed(this.stage, cause)
    }
  }

  /** 执行单次 Octokit 请求并只返回 data。 */
  async request(operation) {
    try {
      const response = await operation()
      return response.data
    }
    catch (cause) {
      throw githubRequestFailed(this.stage, cause)
    }
  }
}

/** 将 owner/repository 字符串拆成 GitHub API 参数。 */
function repositoryParts(fullName) {
  if (typeof fullName !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(fullName))
    throw stateInvalid(InspectionStage.Prepare, 'Repository must use owner/repository format.')
  const [owner, repo] = fullName.split('/')
  return { owner, repo }
}

/** 将 GitHub API 异常映射为稳定、可重试判断的领域错误。 */
function githubRequestFailed(stage, cause) {
  const status = Number.isInteger(cause?.status) ? cause.status : undefined
  return new RepoDoctorError({
    errorCode: RepoDoctorErrorCode.GitHubRequestFailed,
    stage,
    detail: status === undefined
      ? 'GitHub API request could not be completed.'
      : `GitHub API request failed with status ${status}.`,
    retryable: status === undefined || status === 429 || status >= 500,
    cause,
  })
}

/** 创建需要人工消歧的状态冲突错误。 */
function stateConflict(stage, detail) {
  return new RepoDoctorError({ errorCode: RepoDoctorErrorCode.StateConflict, stage, detail })
}

/** 创建无法继续消费的状态格式错误。 */
function stateInvalid(stage, detail, cause) {
  return new RepoDoctorError({ errorCode: RepoDoctorErrorCode.StateInvalid, stage, detail, cause })
}
