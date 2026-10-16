# Crawshrimp Scripts — migrated to Browser

This standalone repository is retired. All webpage work is maintained in [dsh-crawshrimp-browser](https://github.com/howtimeschange/dsh-crawshrimp-browser), including interactive page actions, explicit login state, portable scripts, parameter validation, pagination, live preview and manual takeover.

There is no standalone Scripts 0.2.0 release. Browser runs independently and does not depend on this package or the Crawshrimp backend. The original [v0.1.0 source and release](https://github.com/howtimeschange/dsh-crawshrimp-scripts/releases/tag/v0.1.0) remain available for history.

## Migration

Copy your configured adapter roots, artifact workspace and private login-state path into the Browser row. Keep the old `workspaceDir` explicitly if you want to continue using previous artifacts. Then remove the old plugin and install Browser:

```sh
dsh plugin --profile ecommerce remove -w dsh-crawshrimp-scripts
dsh plugin --profile ecommerce add -w github:howtimeschange/dsh-crawshrimp-browser#v0.2.0
dsh --profile ecommerce --dump-config
```

Remove any custom `crawshrimp-scripts` row from your profile overlay. Configure the existing/new `crawshrimp-browser` row instead; do not keep both plugins loaded.

| Old tool/config | Browser equivalent |
| --- | --- |
| `crawshrimp_scripts_list` | `crawshrimp_browser_script_list` |
| `crawshrimp_scripts_run` | `crawshrimp_browser_script_run` |
| No offline validator | `crawshrimp_browser_script_validate` |
| `browserChannel` | `channel` |
| `timeoutMs` | `scriptTimeoutMs` |
| `adapterRoots`, `workspaceDir`, `storageStatePath`, `executablePath`, `cdpEndpoint` | Same explicit values |
| Default workspace `~/.dsh-crawshrimp-scripts` | `~/.dsh-crawshrimp-browser`, unless explicitly configured |

Update saved prompts/workflows to the new tool names. Existing artifacts and private login-state files are not moved or deleted automatically. See the [complete migration guide](https://github.com/howtimeschange/dsh-crawshrimp-browser/blob/v0.2.0/docs/migration-from-scripts.md) for the portable manifest subset and configuration details.

[中文迁移说明](README.zh-CN.md)
