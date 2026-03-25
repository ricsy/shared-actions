# shared-actions

通用 GitHub Actions 工作流集合

## 目录结构

```
.github/
├── actions/            # 可复用 Action
│   └── pypi/          # PyPI 构建和发布
│       └── action.yml  # 复用步骤
└── workflows/
    ├── python/         # Python 相关
    │   └── build.yml   # 构建和测试
    └── publish/        # 发布相关
        ├── pypi.yml        # PyPI 发布（workflow_call）
        └── release-pypi.yml # PyPI Release 发布（release trigger）
```

## Action

### actions/pypi

PyPI 构建和发布 Action，其他项目可直接调用。

| 参数               | 默认值      | 说明                  |
|------------------|----------|---------------------|
| `python-version` | `"3.x"`  | Python 版本           |
| `package-dir`    | `"."`    | 包目录路径               |
| `environment`    | `"pypi"` | PyPI environment 名称 |

```yaml
# 项目自己的 workflow
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: ricsy/shared-actions/.github/actions/pypi@main
        with:
          python-version: "3.x"
          environment: pypi
```

## 工作流

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
    uses: owner/shared-actions/.github/workflows/python/build.yml@main
```

### publish/pypi

发布 Python 包到 PyPI（可被其他工作流调用）

> 大部分参数使用默认即可

| 参数               | 默认值      | 说明                  | 必需 |
|------------------|----------|---------------------|----|
| `python-version` | `"3.x"`  | Python 版本           | 否  |
| `package-dir`    | `"."`    | 包目录路径               | 否  |
| `environment`    | `"pypi"` | PyPI environment 名称 | 否  |

```yaml
jobs:
  publish:
    uses: owner/shared-actions/.github/workflows/publish/pypi.yml@main
```

**前置要求**：仓库需设置 environment 并配置 Trusted Publishing (OIDC)

### publish/release-pypi

在 GitHub Release 发布时自动构建并发布到 PyPI。

> 推荐直接使用 action

```yaml
# 在项目 .github/workflows/release.yml 中
on:
  release:
    types: [published]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: ricsy/shared-actions/.github/actions/pypi@main
```

**前置要求**：仓库需设置 `pypi` environment 并配置 Trusted Publishing (OIDC)

## 贡献

欢迎提交 PR 添加新的通用工作流详见 [CONTRIBUTING.md](CONTRIBUTING.md)
