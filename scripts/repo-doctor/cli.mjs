import { Command } from 'commander'
import { GitHubClient } from './github-client.mjs'
import { runInspection } from './inspect.mjs'
import { createPreflightClients, runPreflight } from './preflight.mjs'
import { InspectionStage, RepoDoctorError, RepoDoctorErrorCode } from './protocol.mjs'
import { runReport } from './report.mjs'

const program = new Command()
  .name('repo-doctor')
  .description('Run repository inspection workflow stages.')
  .showHelpAfterError()

program.command('preflight')
  .description('Resolve repositories, checkpoints, and the inspection mode.')
  .action(() => execute(input => runPreflight(input, createPreflightClients(process.env))))

program.command('inspect')
  .description('Run the immutable repository inspection plan.')
  .action(() => execute(runInspection))

program.command('report')
  .description('Merge inspection state and update the central issue.')
  .action(() => execute(input => runReport(input, new GitHubClient({
    token: process.env.REPO_DOCTOR_TOKEN,
    baseUrl: process.env.GITHUB_API_URL,
  }))))

await program.parseAsync(process.argv)

/** 读取标准输入并执行单个巡检阶段，将结果稳定编码为 JSON。 */
async function execute(operation) {
  try {
    const result = await operation(await readInput())
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
  catch (cause) {
    // CLI 边界只序列化受控领域错误，未知异常仅作为 cause 保留，不直接泄露到输出。
    const error = cause instanceof RepoDoctorError
      ? cause
      : new RepoDoctorError({
          errorCode: RepoDoctorErrorCode.ReportFailed,
          stage: InspectionStage.Prepare,
          detail: 'Repo doctor command failed.',
          cause,
        })
    process.stderr.write(`${JSON.stringify(error)}\n`)
    process.exitCode = 1
  }
}

/** 从标准输入读取一个 JSON 对象，拒绝空输入和无法解析的内容。 */
async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(chunk)
  const source = Buffer.concat(chunks).toString('utf8').trim()
  if (source.length === 0) {
    throw new RepoDoctorError({
      errorCode: RepoDoctorErrorCode.InvalidInput,
      stage: InspectionStage.Prepare,
      detail: 'Expected a JSON object on stdin.',
    })
  }
  try {
    return JSON.parse(source)
  }
  catch (cause) {
    throw new RepoDoctorError({
      errorCode: RepoDoctorErrorCode.InvalidInput,
      stage: InspectionStage.Prepare,
      detail: 'stdin did not contain valid JSON.',
      cause,
    })
  }
}
