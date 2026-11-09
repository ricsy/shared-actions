// 按 repo-kit `rpk action repo-doctor` 的同一规则，从 package.json 所在目录解析 setup-node 的版本。
// 只用 Node 内置模块：composite action 里没有安装依赖的步骤，runner 自带的 Node 即可运行。
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lowerBoundHint = 'package.json#engines.node to be a semver range with a lower bound such as >=24, or an explicit Node version via node-version, volta.node, .node-version, or .nvmrc'

/** 显式来源优先，原样返回；否则取 engines.node 最低支持的大版本线。 */
export function resolveNodeVersion({ override, manifest, nodeVersionFile, nvmrc }) {
  const explicit = override?.trim() || manifest.volta?.node?.trim() || nodeVersionFile?.trim() || nvmrc?.trim()
  if (explicit)
    return explicit
  const range = manifest.engines?.node?.trim()
  if (!range)
    throw new Error(`setup-node requires ${lowerBoundHint}.`)
  return lowestSupportedNodeVersion(range)
}

/**
 * engines.node 是支持范围，原样交给 setup-node 会装上最新版本或 runner 缓存里的任意版本；
 * 改为在最低支持的大版本线内取最新补丁（`^下限`），上限落在同一大版本内时退回下限本身。
 */
export function lowestSupportedNodeVersion(range) {
  if (parseExact(range) !== null)
    return range.trim().replace(/^=/u, '')
  const sets = parseRange(range)
  const usable = sets?.filter(set => set.upper === undefined || compare(set.lower, set.upper) < 0)
  if (!usable?.length)
    throw new Error(`setup-node requires ${lowerBoundHint}.`)
  const floor = usable.map(set => set.lower).reduce((a, b) => compare(a, b) <= 0 ? a : b)
  if (floor[0] === 0)
    throw new Error(`setup-node requires ${lowerBoundHint}.`)
  const caretUpper = [floor[0] + 1, 0, 0]
  // shortcut: 只判断单个比较集能否容纳 ^下限，不处理多个集合拼接覆盖的情形；遇到这类写法时改用 semver.subset。
  const fitsCaret = usable.some(set => compare(set.lower, floor) <= 0 && (set.upper === undefined || compare(set.upper, caretUpper) >= 0))
  const version = floor.join('.')
  return fitsCaret ? `^${version}` : version
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i])
      return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** 解析 `=1.2.3`、`v1.2.3`、`1.2.3` 这类精确版本；不是精确版本时返回 null。 */
function parseExact(text) {
  const match = /^=?v?(\d+)\.(\d+)\.(\d+)$/u.exec(text.trim())
  return match === null ? null : match.slice(1, 4).map(Number)
}

/** 解析部分版本：返回已写出的数字，`x`、`*` 和缺省位视为未写。 */
function parsePartial(text) {
  const match = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?$/iu.exec(text)
  if (match === null)
    return null
  const parts = []
  for (const part of match.slice(1, 4)) {
    if (part === undefined || /^[x*]$/iu.test(part))
      break
    parts.push(Number(part))
  }
  return parts
}

const fill = parts => [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
/** 部分版本之后的第一个版本，如 24 → 25.0.0、24.1 → 24.2.0。 */
const after = parts => parts.length === 0 ? [Infinity, 0, 0] : fill([...parts.slice(0, -1), parts.at(-1) + 1])

/** 把范围拆成比较集，每个集合折算为 [lower, upper) 区间；无法识别的写法返回 null。 */
function parseRange(range) {
  const sets = []
  for (const raw of range.split('||')) {
    const text = raw.trim().replace(/(>=|<=|[<>=^~])\s+/gu, '$1')
    let lower = [0, 0, 0]
    let upper
    const raise = bound => { if (compare(bound, lower) > 0) lower = bound }
    const cap = bound => { if (upper === undefined || compare(bound, upper) < 0) upper = bound }
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(text)
    const comparators = hyphen === null ? (text === '' ? ['*'] : text.split(/\s+/u)) : []
    if (hyphen !== null) {
      const from = parsePartial(hyphen[1])
      const to = parsePartial(hyphen[2])
      if (from === null || to === null)
        return null
      raise(fill(from))
      cap(after(to))
    }
    for (const comparator of comparators) {
      const match = /^(>=|<=|[<>=^~])?(.*)$/u.exec(comparator)
      const parts = parsePartial(match[2])
      if (parts === null)
        return null
      const op = match[1] ?? ''
      if (op === '>=') raise(fill(parts))
      else if (op === '>') raise(parts.length === 3 ? [parts[0], parts[1], parts[2] + 1] : after(parts))
      else if (op === '<') cap(fill(parts))
      else if (op === '<=') cap(after(parts))
      else if (op === '^') { raise(fill(parts)); cap(parts.length === 0 ? [Infinity, 0, 0] : [parts[0] + 1, 0, 0]) }
      else if (op === '~') { raise(fill(parts)); cap(parts.length >= 2 ? [parts[0], parts[1] + 1, 0] : after(parts)) }
      else { raise(fill(parts)); cap(after(parts)) }
    }
    sets.push({ lower, upper: upper?.[0] === Infinity ? undefined : upper })
  }
  return sets
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8')
  }
  catch (error) {
    if (error?.code === 'ENOENT')
      return undefined
    throw error
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [packageJson = 'package.json', override = ''] = process.argv.slice(2)
  try {
    const root = dirname(packageJson)
    const version = resolveNodeVersion({
      override,
      manifest: JSON.parse(readFileSync(packageJson, 'utf8')),
      nodeVersionFile: readOptional(join(root, '.node-version')),
      nvmrc: readOptional(join(root, '.nvmrc')),
    })
    if (/[\r\n]|\$\{\{/u.test(version))
      throw new Error('setup-node requires a literal Node version (no line breaks or GitHub expressions).')
    console.log(`Resolved Node.js ${version} from ${packageJson}`)
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  }
  catch (error) {
    console.error(`::error::${error.message}`)
    process.exit(1)
  }
}
