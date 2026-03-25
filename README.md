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
        ├── pypi.yml      # PyPI 发布（workflow_call）
        └── release-pypi.yml # PyPI Release 发布（release trigger）
```

## Action

### actions/pypi

构建 Python 包（仅构建，不发布）。

| 参数 | 默认值 | 说明 |
|-----|-------|------|
| `python-version` | `"3.x"` | Python 版本 |
| `package-dir` | `"."` | 包目录路径 |

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

| 参数 | 默认值 | 说明 | 必需 |
|-----|-------|------|-----|
| `python-version` | `"3.11"` | Python 版本 | 否 |
| `install-flags` | `"-e ."` | pip install 安装参数 | 否 |
| `tests-dir` | `"tests/"` | 测试目录路径 | 否 |

```yaml
jobs:
  build:
    uses: ricsy/shared-actions/.github/workflows/python/build.yml@master
```

### publish/pypi

发布 Python 包到 PyPI（可被其他工作流调用）。

> 大部分参数使用默认即可

| 参数 | 默认值 | 说明 | 必需 |
|-----|-------|------|-----|
| `python-version` | `"3.x"` | Python 版本 | 否 |
| `package-dir` | `"."` | 包目录路径 | 否 |

```yaml
jobs:
  publish:
    uses: ricsy/shared-actions/.github/workflows/publish/pypi.yml@master
```

**前置要求**：仓库需设置 environment 并配置 Trusted Publishing (OIDC)

### publish/release-pypi

在 GitHub Release 发布时自动构建并发布到 PyPI。

```yaml
# 项目 .github/workflows/release.yml
on:
  release:
    types: [published]

jobs:
  release:
    uses: ricsy/shared-actions/.github/workflows/publish/release-pypi.yml@master
```

**前置要求**：仓库需设置 `pypi` environment 并配置 Trusted Publishing (OIDC)

## 贡献

欢迎提交 PR 添加新的通用工作流。详见 [CONTRIBUTING.md](CONTRIBUTING.md)
