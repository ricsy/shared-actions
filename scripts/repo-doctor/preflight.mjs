import { GitHubClient } from './github-client.mjs'
import { z } from 'zod'
import {
  InspectionStage,
  RepoDoctorError,
  RepoDoctorErrorCode,
  RepoDoctorRunMode,
} from './protocol.mjs'

const repositoryNameSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u)
const preflightInputSchema = z.object({
  sourceRepository: repositoryNameSchema,
  resultsRepository: repositoryNameSchema,
  repoKitRepository: repositoryNameSchema,
  sharedActionsRepository: repositoryNameSchema,
  force: z.boolean(),
}).strict()

const repositorySchema = z.object({
  id: z.number().int().positive(),
  fullName: repositoryNameSchema,
  defaultBranch: z.string().min(1),
}).strict()

/** 按 token 权限边界创建源仓、公共能力仓和结果仓客户端。 */
export function createPreflightClients(environment, { baseUrl = environment.GITHUB_API_URL } = {}) {
  return {
    sourceClient: new GitHubClient({ token: environment.GITHUB_TOKEN, baseUrl }),
    standardsClient: new GitHubClient({ token: environment.COMMON_LIB_TOKEN, baseUrl, stage: InspectionStage.Standards }),
    resultsClient: new GitHubClient({ token: environment.REPO_DOCTOR_TOKEN, baseUrl }),
  }
}

/** 比较双 checkpoint 与最新提交，决定 full、standards-only 或 skip。 */
export function decideRunMode({ force, previousStatus, sourceSha, repoKitSha, sharedActionsSha }) {
  if (force || previousStatus === null)
    return RepoDoctorRunMode.Full
  // 源代码变化会使质量结果失效，必须重新执行完整巡检。
  if (previousStatus.quality?.checkpoint?.sourceSha !== sourceSha)
    return RepoDoctorRunMode.Full
  const standards = previousStatus.standards?.checkpoint
  // 仅公共能力版本变化时复用质量结果，只重跑低成本的 standards 检查。
  if (standards?.sourceSha !== sourceSha
    || standards?.repoKitSha !== repoKitSha
    || standards?.sharedActionsSha !== sharedActionsSha) {
    return RepoDoctorRunMode.StandardsOnly
  }
  return RepoDoctorRunMode.Skip
}

/** 解析仓库与历史状态，生成后续 inspect/report 共享的预检结果。 */
export async function runPreflight(input, clients) {
  input = parse(preflightInputSchema, input, 'Preflight input is invalid.')
  const repositoryResponse = await clients.sourceClient.getRepository(input.sourceRepository)
  const repository = {
    id: repositoryResponse?.id,
    fullName: repositoryResponse?.full_name,
    defaultBranch: repositoryResponse?.default_branch,
  }
  const sourceRepository = parse(repositorySchema, repository, 'Source repository metadata is invalid.')

  const sourceSha = await clients.sourceClient.getCommitSha(sourceRepository.fullName, sourceRepository.defaultBranch)
  const repoKitSha = await clients.standardsClient.getCommitSha(input.repoKitRepository, 'main')
  const sharedActionsSha = await clients.standardsClient.getCommitSha(input.sharedActionsRepository, 'main')
  // 先按 repository ID 定位 Issue，再从唯一受管评论恢复 checkpoint。
  const issue = await clients.resultsClient.findInspectionIssue(input.resultsRepository, sourceRepository.id)
  const managed = issue === null
    ? { comment: null, status: null, invalid: false }
    : await clients.resultsClient.findManagedStatusComment(input.resultsRepository, issue.number)
  const mode = decideRunMode({
    force: input.force,
    previousStatus: managed.status,
    sourceSha,
    repoKitSha,
    sharedActionsSha,
  })

  return {
    mode,
    repository: sourceRepository,
    sourceSha,
    repoKitSha,
    sharedActionsSha,
    issueNumber: issue?.number ?? null,
    commentId: managed.comment?.id ?? null,
    previousStatus: managed.status,
    rebuildComment: managed.invalid,
  }
}

/** 使用指定 Zod schema 校验边界输入，并统一转换校验错误。 */
function parse(schema, value, fallback) {
  const result = schema.safeParse(value)
  if (!result.success)
    throw invalidInput(result.error.issues[0]?.message ?? fallback)
  return result.data
}

/** 创建 preflight 阶段的输入错误。 */
function invalidInput(detail) {
  return new RepoDoctorError({
    errorCode: RepoDoctorErrorCode.InvalidInput,
    stage: InspectionStage.Prepare,
    detail,
  })
}
