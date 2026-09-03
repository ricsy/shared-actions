import { z } from 'zod'

/** Issue 正文中受管状态的唯一识别标记。 */
export const managedStatusMarker = '<!-- repo-doctor-status:v1 -->'

/** 巡检阶段的稳定取值。 */
export const InspectionStage = Object.freeze({
  /** 环境和依赖准备。 */
  Prepare: 'prepare',
  /** repo-kit 生成能力一致性检查。 */
  Standards: 'standards',
  /** 依赖安全审计。 */
  Audit: 'audit',
  /** 静态检查。 */
  Lint: 'lint',
  /** 自动化测试。 */
  Test: 'test',
  /** 测试覆盖率检查。 */
  Coverage: 'coverage',
  /** 项目构建。 */
  Build: 'build',
})

/** 单项与聚合巡检状态。 */
export const InspectionStatus = Object.freeze({
  /** 检查已完成且通过。 */
  Passed: 'passed',
  /** 检查已完成但未通过。 */
  Failed: 'failed',
  /** 环境或基础设施导致检查未完成。 */
  Incomplete: 'incomplete',
})

/** repo-doctor 支持的执行模式。 */
export const RepoDoctorRunMode = Object.freeze({
  /** 执行完整质量与 standards 检查。 */
  Full: 'full',
  /** 仅检查公共能力版本与生成产物。 */
  StandardsOnly: 'standards-only',
  /** checkpoint 均有效，不执行检查。 */
  Skip: 'skip',
})

/** 可对外序列化的稳定错误码。 */
export const RepoDoctorErrorCode = Object.freeze({
  /** 输入不符合运行时合同。 */
  InvalidInput: 'INVALID_INPUT',
  /** 缺少必需 token。 */
  MissingToken: 'MISSING_TOKEN',
  /** GitHub API 请求失败。 */
  GitHubRequestFailed: 'GITHUB_REQUEST_FAILED',
  /** 远端存在多个互相冲突的受管状态。 */
  StateConflict: 'STATE_CONFLICT',
  /** 远端受管状态格式无效。 */
  StateInvalid: 'STATE_INVALID',
  /** 外部命令以非零状态结束。 */
  CommandFailed: 'COMMAND_FAILED',
  /** 外部命令无法启动。 */
  CommandSpawnFailed: 'COMMAND_SPAWN_FAILED',
  /** 外部命令执行超时。 */
  CommandTimedOut: 'COMMAND_TIMED_OUT',
  /** inspect 阶段未返回结果。 */
  InspectionResultMissing: 'INSPECTION_RESULT_MISSING',
  /** report 阶段无法完成。 */
  ReportFailed: 'REPORT_FAILED',
})

const statusPriority = Object.freeze({
  [InspectionStatus.Passed]: 0,
  [InspectionStatus.Failed]: 1,
  [InspectionStatus.Incomplete]: 2,
})

const statuses = new Set(Object.values(InspectionStatus))
const shaPattern = /^[a-f0-9]{40}$/u

export const inspectionStageSchema = z.enum(Object.values(InspectionStage))
export const inspectionStatusSchema = z.enum(Object.values(InspectionStatus))
export const repoDoctorRunModeSchema = z.enum(Object.values(RepoDoctorRunMode))
export const runSchema = z.object({
  id: z.number().int().positive(),
  attempt: z.number().int().positive(),
  url: z.url({ protocol: /^https$/u }),
}).strict()
export const checkSchema = z.object({
  stage: inspectionStageSchema,
  command: z.string().min(1),
  status: inspectionStatusSchema,
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().nonnegative().optional(),
  errorCode: z.enum(Object.values(RepoDoctorErrorCode)).optional(),
}).strict()

const qualityCheckpointSchema = z.object({ sourceSha: z.string().regex(shaPattern) }).strict()
const standardsCheckpointSchema = qualityCheckpointSchema.extend({
  repoKitSha: z.string().regex(shaPattern),
  sharedActionsSha: z.string().regex(shaPattern),
}).strict()
const domainSchema = checkpointSchema => z.object({
  status: inspectionStatusSchema,
  checkpoint: checkpointSchema.nullable(),
  checks: z.array(checkSchema),
  run: runSchema,
}).strict()

export const statusDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.object({
    id: z.number().int().positive(),
    fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    defaultBranch: z.string().min(1),
  }).strict(),
  overall: inspectionStatusSchema,
  quality: domainSchema(qualityCheckpointSchema),
  standards: domainSchema(standardsCheckpointSchema),
  latestAttempt: z.object({
    mode: repoDoctorRunModeSchema,
    status: inspectionStatusSchema,
    run: runSchema,
  }).strict(),
  checks: z.array(checkSchema),
}).strict()

/** 承载稳定错误码、阶段和已脱敏诊断信息的领域错误。 */
export class RepoDoctorError extends Error {
  /** 创建一个可安全序列化的 repo-doctor 错误。 */
  constructor({ errorCode, stage, detail, retryable = false, outcome = 'failed', cause }) {
    super(errorCode, { cause })
    this.name = 'RepoDoctorError'
    this.errorCode = errorCode
    this.stage = stage
    this.detail = sanitizeDetail(detail)
    this.retryable = retryable
    this.outcome = outcome
  }

  /** 输出 GitHub Actions 可消费且不包含底层 cause 的错误合同。 */
  toJSON() {
    return {
      errorCode: this.errorCode,
      stage: this.stage,
      retryable: this.retryable,
      outcome: this.outcome,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    }
  }
}

/** 按 incomplete > failed > passed 优先级聚合检查状态。 */
export function aggregateInspectionStatus(values) {
  if (!Array.isArray(values) || values.length === 0)
    throw protocolError('At least one inspection status is required.')
  for (const value of values)
    assertStatus(value, 'inspection status')
  return values.reduce((current, value) => statusPriority[value] > statusPriority[current] ? value : current)
}

/** 从 Issue 正文的 JSON code block 解析受管状态文档。 */
export function parseManagedStatus(body) {
  // marker 缺失或重复都会让受管状态边界不明确，必须拒绝解析。
  if (typeof body !== 'string' || countOccurrences(body, managedStatusMarker) !== 1)
    throw protocolError('Managed status marker is missing or duplicated.')
  const markerIndex = body.indexOf(managedStatusMarker) + managedStatusMarker.length
  const match = /```json\s*([\s\S]*?)```/u.exec(body.slice(markerIndex))
  if (match === null)
    throw protocolError('Managed status JSON block is missing.')
  let value
  try {
    value = JSON.parse(match[1])
  }
  catch (cause) {
    throw protocolError('Managed status JSON is invalid.', cause)
  }
  return validateStatusDocument(value)
}

/** 使用共享 Zod 合同验证并规范化状态文档。 */
export function validateStatusDocument(value) {
  const result = statusDocumentSchema.safeParse(value)
  if (!result.success)
    throw protocolError(result.error.issues[0]?.message ?? 'Status document is invalid.', result.error)
  return result.data
}

/** 断言值属于受控巡检状态集合。 */
function assertStatus(value, name) {
  if (!statuses.has(value))
    throw protocolError(`${name} is invalid.`)
}

/** 创建状态协议错误，并保留不可序列化的底层 cause 供进程内排障。 */
function protocolError(detail, cause) {
  return new RepoDoctorError({
    errorCode: RepoDoctorErrorCode.StateInvalid,
    stage: InspectionStage.Standards,
    detail,
    cause,
  })
}

/** 对外输出前移除 token、Authorization 和本机用户路径。 */
function sanitizeDetail(value) {
  if (value === undefined)
    return undefined
  return String(value)
    .replace(/Authorization:\s*Bearer\s+\S+/giu, '[REDACTED]')
    .replace(/Bearer\s+\S+/giu, '[REDACTED]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/gu, '[REDACTED]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/giu, '[REDACTED_PATH]')
    .slice(0, 500)
}

/** 统计固定标记出现次数，用于保证 Issue 正文只有一个状态解析入口。 */
function countOccurrences(value, needle) {
  return value.split(needle).length - 1
}
