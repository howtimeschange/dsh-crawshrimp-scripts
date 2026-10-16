# Crawshrimp Scripts：已迁入浏览器插件

本独立仓库停止维护。所有网页相关能力统一由 [dsh-crawshrimp-browser](https://github.com/howtimeschange/dsh-crawshrimp-browser) 提供，包括页面操作、登录态、便携脚本、参数校验、翻页、实时预览和人工接管。

不会发布独立的 Scripts 0.2.0。浏览器包可以单独运行，不依赖本包或抓虾后端。原有 [v0.1.0 源码与 Release](https://github.com/howtimeschange/dsh-crawshrimp-scripts/releases/tag/v0.1.0) 保留供历史查阅。

## 迁移

先把 adapterRoots、workspaceDir、私有 storageStatePath 和浏览器配置迁入 `crawshrimp-browser` 配置行。如需继续使用旧产物目录，显式保留旧 workspaceDir。然后运行：

```sh
dsh plugin --profile ecommerce remove -w dsh-crawshrimp-scripts
dsh plugin --profile ecommerce add -w github:howtimeschange/dsh-crawshrimp-browser#v0.2.0
dsh --profile ecommerce --dump-config
```

删除 profile overlay 中自定义的 `crawshrimp-scripts` 行，保留浏览器包配置，避免同时加载两包。

| 原工具/配置 | 浏览器包对应项 |
| --- | --- |
| `crawshrimp_scripts_list` | `crawshrimp_browser_script_list` |
| `crawshrimp_scripts_run` | `crawshrimp_browser_script_run` |
| 原无离线校验 | `crawshrimp_browser_script_validate` |
| `browserChannel` | `channel` |
| `timeoutMs` | `scriptTimeoutMs` |
| adapterRoots、workspaceDir、storageStatePath、executablePath、cdpEndpoint | 复制原显式值 |
| 默认目录 `~/.dsh-crawshrimp-scripts` | `~/.dsh-crawshrimp-browser`，可显式配置旧目录 |

旧产物和登录文件不会自动移动或删除；保存的提示词和工作流需要替换工具名。更多配置与脚本兼容范围见[完整迁移指南](https://github.com/howtimeschange/dsh-crawshrimp-browser/blob/v0.2.0/docs/migration-from-scripts.md)。
