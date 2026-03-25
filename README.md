# shared-actions

通用 GitHub Actions 工作流和 Action 集合。

## 特性

- **Action** - 可复用的步骤组合，直接被 workflow 调用
- **Workflow** - 触发器定义，负责启动 CI/CD 流程

## 目录结构

```
.github/
├── actions/
│   └── pypi/
│       └── action.yml     # Python 包构建
└── workflows/
    ├── python/
    │   └── build.yml     # Python 项目构建和测试
    └── publish/
        └── pypi.yml      # PyPI 发布（workflow_call）
```

## Action

### actions/pypi

构建 Python 包（仅构建，不发布）。

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

### python/build

Python 项目构建和测试（检出代码、安装依赖、运行测试）。

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

发布 Python 包到 PyPI（可被其他工作流调用）。

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
