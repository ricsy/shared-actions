# shared-actions

通用 GitHub Actions 工作流和 Action 集合

## 特性

- **Action** - 可复用的步骤组合，直接被 workflow 调用
- **Workflow** - 触发器定义，负责启动 CI/CD 流程

## 目录结构

```text
.github/
├── actions/
│   └── pypi/
│       └── action.yml     # Python 包构建
└── workflows/
    ├── repo-doctor.yml  # 仓库日常巡检（workflow_call）
    ├── python/
    │   └── build.yml     # Python 项目构建和测试
    └── publish/
        └── pypi.yml      # PyPI 发布（workflow_call）
```

## Action

### actions/pypi

构建 Python 包（仅构建，不发布）

| 参数               | 默认值     | 说明        |
|------------------|---------|-----------|
| `python-version` | `"3.x"` | Python 版本 |
| `package-dir`    | `"."`   | 包目录路径     |

```yaml
# 项目 workflow 中调用
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: ricsy/shared-actions/.github/actions/pypi@master
```

## 工作流

### repo-doctor

对 pnpm 仓库执行版本感知的日常巡检。工作流按 `preflight → inspect → report` 分为三个 job：源码或标准版本没有变化时跳过；只有 repo-kit/shared-actions 变化时仅检查 standards；源码变化或手动强制时执行完整命令计划。

调用入口应由 repo-kit 生成，避免手写命令计划或遗漏固定 SHA：

```bash
rpk action apply repo-doctor \
  --results-repo <owner/repo> \
  --yes --json
```

生成的调用方结构如下，其中 `uses` 必须固定为 40 位 shared-actions commit SHA：

```yaml
jobs:
  inspect:
    uses: ricsy/shared-actions/.github/workflows/repo-doctor.yml@<40-character-commit-sha>
    with:
      results_repository: owner/repo-doctor
      runner: ${{ vars.REPO_DOCTOR_RUNNER || 'ubuntu-latest' }}
      node_version: '24'
      pnpm_version: '11.8.0'
      command_plan: '[{"id":"lint","stage":"lint","executable":"pnpm","args":["run","lint"]}]'
      timeout_minutes: 60
      force: false
    secrets:
      REPO_DOCTOR_TOKEN: ${{ secrets.REPO_DOCTOR_TOKEN }}
      COMMON_LIB_TOKEN: ${{ secrets.COMMON_LIB_TOKEN }}
```

| 输入 | 必需 | 说明 |
| --- | --- | --- |
| `results_repository` | 是 | 保存当前巡检状态的私有仓库 |
| `runner` | 否 | 三个巡检 job 使用的 runner 标签，默认 `ubuntu-latest` |
| `node_version` | 是 | 项目命令使用的 Node.js 版本 |
| `pnpm_version` | 是 | 项目命令使用的 pnpm 版本 |
| `command_plan` | 是 | repo-kit 生成的不可变 JSON 命令计划 |
| `timeout_minutes` | 是 | inspect job 的超时分钟数 |
| `force` | 否 | 忽略 checkpoint 并执行 full，默认 `false` |

| Secret | 最小权限 | 使用位置 |
| --- | --- | --- |
| `REPO_DOCTOR_TOKEN` | 结果仓库 Issues read/write | preflight、report |
| `COMMON_LIB_TOKEN` | repo-kit、shared-actions 与项目私有 Git 依赖 Contents read | preflight、repo-kit checkout、无脚本依赖抓取 |

inspect 不接收 `REPO_DOCTOR_TOKEN`。`COMMON_LIB_TOKEN` 仅传给禁用生命周期脚本的 `pnpm fetch`，随后立即撤销，真正的 install 使用离线缓存；两个 token 都不会传入 audit、lint、test、coverage 或 build，也不会持久化到 checkout。

repo-kit 生成的调用方会读取仓库变量 `REPO_DOCTOR_RUNNER`；未设置时使用 `ubuntu-latest`。使用仓库级 self-hosted runner 时，将该变量设为 runner 的专用标签，例如 `repo-doctor`。

#### 状态语义

- `passed`：所有适用检查完成并通过，推进对应 checkpoint。
- `failed`：检查完整执行但发现问题，推进对应 checkpoint，避免同一提交每日重复运行。
- `incomplete`：准备、启动、超时、网络或协议失败，保留旧 checkpoint，下一次继续重试。

每个源仓依据稳定 repository ID 对应一个 `[Doctor] 仓库巡检：owner/repo` Issue。工作流只更新一条带 `<!-- repo-doctor-status:v1 -->` 的受管评论和受管 labels，不新增历史状态评论、不删除人工评论，也不改变 Issue 的 open/closed 状态。完整日志保留在源仓 Actions run，可通过评论中的 run URL 或以下命令读取：

```bash
gh run view <run-id> --repo <owner/repo> --log-failed
```

#### 恢复

- preflight 提示 token 缺失或拒绝访问：修正两个 Secret 的仓库范围和最小权限后重新运行。
- 唯一受管评论 JSON 损坏：下一次运行会执行 full 并原位重建。
- 同一 repository ID 出现重复 Issue，或一个 Issue 出现多条受管评论：人工保留唯一实体后重新运行；工作流不会猜测、合并或删除。
- 新 shared-actions 版本异常：把调用方 `uses` 恢复到上一个已验证 SHA；不要改用浮动分支。

维护 helper 时运行：

```bash
pnpm test
pnpm run lint:action
pnpm run repo-doctor --help
```

### python/build

Python 项目构建和测试（检出代码、安装依赖、运行测试）

> 大部分参数使用默认即可

| 参数               | 默认值        | 说明               | 必需 |
|------------------|------------|------------------|----|
| `python-version` | `"3.11"`   | Python 版本        | 否  |
| `install-flags`  | `"-e ."`   | pip install 安装参数 | 否  |
| `tests-dir`      | `"tests/"` | 测试目录路径           | 否  |

```yaml
jobs:
  build:
    uses: ricsy/shared-actions/.github/workflows/python/build.yml@master
```

### publish/pypi

发布 Python 包到 PyPI（可被其他工作流调用）

> 大部分参数使用默认即可

| 参数               | 默认值     | 说明        | 必需 |
|------------------|---------|-----------|----|
| `python-version` | `"3.x"` | Python 版本 | 否  |
| `package-dir`    | `"."`   | 包目录路径     | 否  |

```yaml
jobs:
  publish:
    uses: ricsy/shared-actions/.github/workflows/publish/pypi.yml@master
```

**前置要求**：仓库需设置 environment 并配置 Trusted Publishing (OIDC)

## 注意事项

### Action 文件命名

- Action 目录下的入口文件**必须**命名为 `action.yml`
- 自定义文件名（如 `build.yml`）会导致 GitHub Actions 报错：`Can't find 'action.yml'`

### Composite Action 与 Docker

- **不要**在 composite action 中直接使用需要 Docker 的 action（如 `pypa/gh-action-pypi-publish`）
- GitHub 会尝试将 composite action 所在仓库作为 Docker 镜像来源，导致错误
- **解决方案**：构建 action 只负责构建，发布步骤放在调用方 workflow 中

### Workflow 触发器限制

- 带有 `release` 触发器的 workflow **不能**通过 `uses:` 被其他 workflow 复用
- 原因：`release` 是事件触发型，无法作为 `workflow_call` 被调用
- **解决方案**：对于 release 发布，需在项目 workflow 中直接引用 action，而不是引用 workflow

### 示例：正确的 Release Workflow

```yaml
# 项目 .github/workflows/release.yml
name: 发布到 PyPI

on:
  release:
    types: [published]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      # 直接使用 action 构建
      - uses: ricsy/shared-actions/.github/actions/pypi@master
      # 下载构建产物
      - uses: actions/download-artifact@v4
        with:
          name: release-dists
          path: dist/
      # 发布到 PyPI（不在 composite action 中）
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          packages-dir: dist/
```

## 贡献

欢迎提交 PR 添加新的通用工作流。详见 [CONTRIBUTING.md](CONTRIBUTING.md)
