import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { parse as parseYaml } from 'yaml'
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

/** 先认证构建本地 Git 镜像，再撤销凭证并执行正常安装。 */
async function runPrepare(command, input, dependencies) {
  const startedAt = dependencies.now()
  let mirrorRoot
  try {
    const repositories = await readGitRepositories(join(input.sourceRoot, 'pnpm-lock.yaml'))
    if (repositories.length === 0)
      return runCommand(command, input, dependencies, true)

    mirrorRoot = await mkdtemp(join(tmpdir(), 'repo-doctor-git-'))
    const mirrors = []
    for (const [index, repository] of repositories.entries()) {
      const mirror = join(mirrorRoot, String(index))
      const init = await runProcess({ executable: 'git', args: ['init', '--bare', mirror] }, input, dependencies.execaImpl)
      if (init.kind !== 'exit' || init.exitCode !== 0)
        return processCheck(command, init, elapsed(startedAt, dependencies.now), true)

      for (const commit of repository.commits) {
        const fetch = await runProcess({
          executable: 'git',
          args: ['-C', mirror, 'fetch', '--depth', '1', repository.url, commit],
        }, input, dependencies.execaImpl, gitReadEnvironment(input.projectReadToken))
        if (fetch.kind !== 'exit' || fetch.exitCode !== 0)
          return processCheck(command, fetch, elapsed(startedAt, dependencies.now), true)
      }
      mirrors.push({ url: repository.url, mirror })
    }

    const install = await runCommand({
      ...command,
      args: command.args.includes('--force') ? command.args : [...command.args, '--force'],
    }, input, dependencies, true, gitMirrorEnvironment(mirrors))
    return { ...install, durationMs: elapsed(startedAt, dependencies.now) }
  }
  catch {
    return check(command, InspectionStatus.Incomplete, elapsed(startedAt, dependencies.now), {
      errorCode: RepoDoctorErrorCode.CommandSpawnFailed,
    })
  }
  finally {
    if (mirrorRoot)
      await rm(mirrorRoot, { recursive: true, force: true })
  }
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
  return processCheck(command, result, elapsed(startedAt, now), prepare)
}

/** 将受控进程结果映射为稳定检查状态。 */
function processCheck(command, result, durationMs, prepare) {
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

/** 计算非负整数毫秒耗时。 */
function elapsed(startedAt, now) {
  return Math.max(0, Math.round(now() - startedAt))
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

/** 从 pnpm lockfile 收集需要认证的 GitHub HTTPS 仓库和提交。 */
async function readGitRepositories(lockfilePath) {
  const lockfile = parseYaml(await readFile(lockfilePath, 'utf8'))
  const repositories = new Map()
  for (const value of Object.values(lockfile?.packages ?? {})) {
    const { resolution } = value ?? {}
    if (resolution?.type !== 'git'
      || typeof resolution.repo !== 'string'
      || !resolution.repo.startsWith('https://github.com/')
      || typeof resolution.commit !== 'string') {
      continue
    }
    const commits = repositories.get(resolution.repo) ?? new Set()
    commits.add(resolution.commit)
    repositories.set(resolution.repo, commits)
  }
  return [...repositories].map(([url, commits]) => ({ url, commits: [...commits] }))
}

/** 将 GitHub URL 映射到不含凭证的本地 bare mirror。 */
function gitMirrorEnvironment(mirrors) {
  const environment = { GIT_CONFIG_COUNT: String(mirrors.length) }
  for (const [index, { url, mirror }] of mirrors.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = `url.${pathToFileURL(mirror).href}.insteadOf`
    environment[`GIT_CONFIG_VALUE_${index}`] = url
  }
  return environment
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
