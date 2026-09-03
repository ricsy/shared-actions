import { z } from 'zod'
import {
  aggregateInspectionStatus,
  checkSchema,
  InspectionStage,
  InspectionStatus,
  managedStatusMarker,
  RepoDoctorError,
  RepoDoctorErrorCode,
  repoDoctorRunModeSchema,
  runSchema,
  statusDocumentSchema,
  validateStatusDocument,
} from './protocol.mjs'

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/u)
const reportInputSchema = z.object({
  resultsRepository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
  repository: z.object({
    id: z.number().int().positive(),
    fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    defaultBranch: z.string().min(1),
  }).strict(),
  mode: repoDoctorRunModeSchema,
  sourceSha: shaSchema,
  repoKitSha: shaSchema,
  sharedActionsSha: shaSchema,
  previousStatus: statusDocumentSchema.nullable(),
  inspection: z.object({
    mode: repoDoctorRunModeSchema,
    status: z.enum(Object.values(InspectionStatus)),
    checks: z.array(checkSchema).min(1),
  }).strict(),
  run: runSchema,
}).strict()

/** 合并本次检查与历史双 checkpoint，构造新的状态文档。 */
export function buildStatusDocument(rawInput) {
  const input = parseInput(rawInput)
  const attemptStatus = aggregateInspectionStatus(input.inspection.checks.map(check => check.status))
  if (input.inspection.mode !== input.mode || input.inspection.status !== attemptStatus)
    throw invalidInput('Inspection result does not match the requested mode or aggregate status.')

  const standardsChecks = input.inspection.checks.filter(check => check.stage === InspectionStage.Standards)
  if (standardsChecks.length === 0)
    throw invalidInput('Inspection result must contain a standards check.')

  let quality
  if (input.mode === 'standards-only') {
    if (input.previousStatus === null)
      throw invalidInput('standards-only report requires previous status.')
    // standards-only 不触碰代码质量结果，原样保留上次 full 的 quality checkpoint。
    quality = input.previousStatus.quality
  }
  else {
    const qualityChecks = input.inspection.checks.filter(check => check.stage !== InspectionStage.Standards)
    if (qualityChecks.length === 0)
      throw invalidInput('Full inspection result must contain quality checks.')
    quality = domain(qualityChecks, { sourceSha: input.sourceSha }, input.previousStatus?.quality, input.run)
  }

  const standards = domain(standardsChecks, {
    sourceSha: input.sourceSha,
    repoKitSha: input.repoKitSha,
    sharedActionsSha: input.sharedActionsSha,
  }, input.previousStatus?.standards, input.run)

  return validateStatusDocument({
    schemaVersion: 1,
    repository: input.repository,
    overall: aggregateInspectionStatus([quality.status, standards.status]),
    quality,
    standards,
    latestAttempt: { mode: input.mode, status: attemptStatus, run: input.run },
    checks: input.inspection.checks,
  })
}

/** 根据整体状态和未通过阶段生成完整受管 label 集合。 */
export function managedLabels(document) {
  const stages = [...document.quality.checks, ...document.standards.checks]
    .filter(check => check.status !== InspectionStatus.Passed)
    .map(check => `stage:${check.stage}`)
  return [`inspection:${document.overall}`, ...new Set(stages)].sort((left, right) => {
    if (left.startsWith('inspection:'))
      return -1
    if (right.startsWith('inspection:'))
      return 1
    return left.localeCompare(right)
  })
}

/** 渲染同时面向人和机器消费的唯一受管状态正文。 */
export function renderManagedStatus(document) {
  validateStatusDocument(document)
  const failedStages = managedLabels(document).filter(label => label.startsWith('stage:'))
  return [
    managedStatusMarker,
    '',
    '## 当前状态',
    '',
    `- Repository: \`${document.repository.fullName}@${document.repository.defaultBranch}\``,
    `- Overall: \`${document.overall}\``,
    `- Quality: \`${document.quality.status}\``,
    `- Standards: \`${document.standards.status}\``,
    `- Latest run: [${document.latestAttempt.run.id}](${document.latestAttempt.run.url}) (attempt ${document.latestAttempt.run.attempt})`,
    `- Failed stages: ${failedStages.length === 0 ? 'none' : failedStages.map(label => `\`${label}\``).join(', ')}`,
    '',
    '```json',
    JSON.stringify(document, null, 2),
    '```',
  ].join('\n')
}

/** 将状态写入唯一 Issue 正文和受管 labels。 */
export async function runReport(input, client) {
  const document = buildStatusDocument(input)
  const foundIssue = await client.findInspectionIssue(input.resultsRepository, document.repository.id)
  const issue = await client.upsertInspectionIssue(
    input.resultsRepository,
    document.repository,
    foundIssue,
    renderManagedStatus(document),
  )
  // repo-doctor 只管理 inspection/stage 前缀，人工添加的普通 labels 必须保留。
  const preserved = (issue.labels ?? [])
    .map(label => typeof label === 'string' ? label : label.name)
    .filter(label => typeof label === 'string' && !isManagedLabel(label))
  await client.replaceIssueLabels(
    input.resultsRepository,
    issue.number,
    [...preserved, ...managedLabels(document)],
  )
  return { overall: document.overall, issueNumber: issue.number }
}

/** 构造单个质量域；incomplete 不推进 checkpoint，避免把未完成结果当成新基线。 */
function domain(checks, nextCheckpoint, previous, run) {
  const status = aggregateInspectionStatus(checks.map(check => check.status))
  return {
    status,
    checkpoint: status === InspectionStatus.Incomplete ? previous?.checkpoint ?? null : nextCheckpoint,
    checks,
    run,
  }
}

/** 校验 report 阶段输入并返回规范化值。 */
function parseInput(value) {
  const result = reportInputSchema.safeParse(value)
  if (!result.success)
    throw invalidInput(result.error.issues[0]?.message ?? 'Report input is invalid.')
  return result.data
}

/** 判断 label 是否属于 repo-doctor 管理范围。 */
function isManagedLabel(label) {
  return label.startsWith('inspection:') || label.startsWith('stage:')
}

/** 创建 report 阶段的输入错误。 */
function invalidInput(detail) {
  return new RepoDoctorError({
    errorCode: RepoDoctorErrorCode.InvalidInput,
    stage: InspectionStage.Prepare,
    detail,
  })
}
