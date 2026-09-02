import { execa } from 'execa'
import { z } from 'zod'
import {
  aggregateInspectionStatus,
  InspectionStage,
  InspectionStatus,
  RepoDoctorError,
  RepoDoctorErrorCode,
  RepoDoctorRunMode,
} from './protocol.mjs'

const commandSchema = z.object({
  id: z.string().min(1),
  stage: z.enum(Object.values(InspectionStage)),
  executable: z.literal('pnpm'),
  args: z.array(z.string()),
}).strict()

const inspectionInputSchema = z.object({
  mode: z.enum(Object.values(RepoDoctorRunMode)),
  sourceRoot: z.string().min(1),
  repoKitCli: z.string().min(1),
  commandTimeoutMs: z.number().int().positive(),
  projectReadToken: z.string().min(1).optional(),
  commandPlan: z.array(commandSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.mode === RepoDoctorRunMode.Full
    && (value.commandPlan[0].id !== 'install' || value.commandPlan[0].stage !== InspectionStage.Prepare)) {
    context.addIssue({ code: 'custom', message: 'Full inspection requires install as the first command.' })
  }
  if (value.mode === RepoDoctorRunMode.Full && !value.projectReadToken)
    context.addIssue({ code: 'custom', message: 'Full inspection requires a project read token.' })
})

/** 按不可变命令计划执行巡检，并返回所有检查的聚合状态。 */
export async function runInspection(input, { execaImpl = execa, now = Date.now } = {}) {
  input = parseInput(input)
  if (input.mode === RepoDoctorRunMode.Skip)
    return { mode: input.mode, status: InspectionStatus.Passed, checks: [] }

  const checks = []
  if (input.mode === RepoDoctorRunMode.Full) {
    // 安装失败意味着后续项目命令的运行环境不可信，但 standards 仍可独立检查模板漂移。
    const install = input.commandPlan[0]
    const prepare = await runPrepare(install, input, { execaImpl, now })
    checks.push(prepare)
    checks.push(await runStandards(input, { execaImpl, now }))
    if (prepare.status === InspectionStatus.Passed) {
      for (const command of input.commandPlan.slice(1))
        checks.push(await runCommand(command, input, { execaImpl, now }, false))
    }
  }
  else {
    checks.push(await runStandards(input, { execaImpl, now }))
  }

  return {
    mode: input.mode,
    status: aggregateInspectionStatus(checks.map(check => check.status)),
    checks,
  }
}

/** 禁用依赖脚本完成认证抓取，再撤销凭证并离线安装。 */
async function runPrepare(command, input, dependencies) {
  const fetch = await runCommand({
    ...command,
    args: ['fetch', '--frozen-lockfile', '--ignore-scripts'],
  }, input, dependencies, true, gitReadEnvironment(input.projectReadToken))
  if (fetch.status !== InspectionStatus.Passed)
    return fetch

  const install = await runCommand({
    ...command,
    args: command.args.includes('--offline') ? command.args : [...command.args, '--offline'],
  }, input, dependencies, true)
  return { ...install, durationMs: fetch.durationMs + install.durationMs }
}

/** 使用当前 repo-kit CLI 对源仓库执行 manifest standards 检查。 */
async function runStandards(input, dependencies) {
  return runCommand({
    id: 'standards',
    stage: InspectionStage.Standards,
    executable: 'node',
    args: [input.repoKitCli, 'manifest', 'check', '--path', input.sourceRoot, '--json'],
  }, input, dependencies, false)
}

/** 执行一条计划命令，并将进程结果映射为稳定检查状态。 */
async function runCommand(command, input, { execaImpl, now }, prepare, environment) {
  const startedAt = now()
  const result = await runProcess(command, input, execaImpl, environment)
  const durationMs = Math.max(0, Math.round(now() - startedAt))
  if (result.kind === 'timeout') {
    return check(command, InspectionStatus.Incomplete, durationMs, {
      errorCode: RepoDoctorErrorCode.CommandTimedOut,
    })
  }
  if (result.kind === 'spawn-error') {
    return check(command, InspectionStatus.Incomplete, durationMs, {
      errorCode: RepoDoctorErrorCode.CommandSpawnFailed,
    })
  }
  if (result.exitCode === 0)
    return check(command, InspectionStatus.Passed, durationMs, { exitCode: 0 })
  return check(
    command,
    prepare ? InspectionStatus.Incomplete : InspectionStatus.Failed,
    durationMs,
    { exitCode: result.exitCode, errorCode: RepoDoctorErrorCode.CommandFailed },
  )
}

/** 在无 shell 的受控子进程中执行命令，隔离超时与启动失败。 */
async function runProcess(command, input, execaImpl, environment) {
  try {
    const result = await execaImpl(command.executable, command.args, {
      cwd: input.sourceRoot,
      ...(environment ? { env: environment } : {}),
      shell: false,
      stdio: ['ignore', process.stderr, process.stderr],
      timeout: input.commandTimeoutMs,
      reject: false,
      windowsHide: true,
    })
    if (result.timedOut)
      return { kind: 'timeout' }
    if (!Number.isInteger(result.exitCode))
      return { kind: 'spawn-error' }
    return { kind: 'exit', exitCode: Math.max(0, result.exitCode) }
  }
  catch {
    // 外部命令异常只记录稳定分类，原始参数和 stderr 不进入结果合同。
    return { kind: 'spawn-error' }
  }
}

/** 仅为无脚本抓取进程注入 GitHub HTTPS 只读凭证。 */
function gitReadEnvironment(token) {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.https://x-access-token:${encodeURIComponent(token)}@github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }
}

/** 构造一个符合巡检协议的检查结果。 */
function check(command, status, durationMs, extra) {
  return {
    stage: command.stage,
    command: command.id,
    status,
    durationMs,
    ...extra,
  }
}

/** 校验 inspect 阶段输入并返回规范化值。 */
function parseInput(input) {
  const result = inspectionInputSchema.safeParse(input)
  if (!result.success)
    throw invalidInput(result.error.issues[0]?.message ?? 'Inspection input is invalid.')
  return result.data
}

/** 创建 inspect 阶段的输入错误。 */
function invalidInput(detail) {
  return new RepoDoctorError({
    errorCode: RepoDoctorErrorCode.InvalidInput,
    stage: InspectionStage.Prepare,
    detail,
  })
}
