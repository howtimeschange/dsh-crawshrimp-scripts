# dsh-crawshrimp-scripts

这是一个独立的 DeepSeek Harness（DSH）插件，把抓虾适配包中的便携页面脚本
注册成两个 DSH 工具：

- `crawshrimp_scripts_list`：扫描配置的适配包根目录并列出适配器和任务。
- `crawshrimp_scripts_run`：在插件创建的新 Playwright 浏览器上下文中打开入口网址，
  执行任务脚本，并把 JSON 结果保存为不覆盖已有文件的 artifact。

插件不导入抓虾后端，不调用抓虾 HTTP API，也不接管用户已有的标签页。它只支持一次
页面执行的便携子集；登录持久化、当前标签页匹配、自动翻页、定时调度、Excel 导出、
通知和后端 token/API bridge 仍由完整抓虾运行时负责。

## 安装

安装已发布的 GitHub 版本：

```sh
dsh plugin --profile demo add -w github:howtimeschange/dsh-crawshrimp-scripts#v0.1.0
```

本地安装和验证：

```sh
git clone https://github.com/howtimeschange/dsh-crawshrimp-scripts.git
cd dsh-crawshrimp-scripts
npm ci
dsh plugin --profile demo add -w "$PWD"
```

`-w` 让 DSH 将插件加入 profile 的工作区依赖。插件通过
`package.json` 的 `dsh.bundle.patch` 指向包根目录的 `cordis.patch.yml`，由官方加载器
注册插件和默认配置。

## 配置

在 DSH profile 中覆盖插件配置。生产环境应使用适配包根目录的绝对路径：

```yaml
adapterRoots:
  - /absolute/path/to/adapters
workspaceDir: /absolute/path/to/dsh-script-workspace
browserChannel: chrome
storageStatePath: /absolute/path/to/private/storage-state.json
timeoutMs: 120000
maxScriptBytes: 524288
maxOutputBytes: 2097152
```

默认使用机器上的 Chrome channel。若 Chrome 不在标准位置，可设置
`CHROME_PATH` 或 `executablePath`；也可配置 `cdpEndpoint`。无论使用哪种方式，每次
执行都会请求新的 BrowserContext；CDP 端点无法创建隔离上下文时，任务会直接失败，
不会回退到已有页面。

每次运行都要先经过 DSH 原生 approval。缺少 approval 服务、缺少 agent session、拒绝、
取消、等待出错或 DSH `never` deny policy 都会 fail closed。只有一次性的
`allowed-once` 结果可以启动浏览器。

## 适配包格式

每个配置的根目录可以直接是一个适配包，也可以包含多个带 `manifest.yaml` 的子目录。
没有 manifest 的 README、素材或其他目录会被忽略：

```yaml
id: dsh-demo-table
name: DSH demo table
version: 0.1.0
entry_url: https://example.com
tasks:
  - id: read-table
    name: Read page title and table
    script: read-table.js
```

支持的 manifest 字段是 `id`、`name`、`version`、可选的 `description` 和 `author`、
`entry_url`、`tasks`。任务支持 `id`、`name`、可选 `description` 和相对 `.js` 脚本路径。
适配器和任务 ID 必须是小写 slug，任务 ID 不能重复。脚本、manifest 的真实路径必须
留在适配器目录内，符号链接逃逸会被拒绝。

任务脚本必须是文件末尾实际调用的 async IIFE。它从 `window.__PARAMS__` 读取调用方
传入的 JSON 对象，并返回：

```js
;(async () => {
  return {
    success: true,
    data: [{ /* JSON row */ }],
    meta: { /* JSON metadata */ },
  }
})()
```

`success: false` 是脚本可以声明的业务失败状态；工具仍会返回它的 `data`、`meta` 和
artifact，调用方应根据该字段决定后续处理。脚本抛错、返回非 JSON、结果超过
`maxOutputBytes` 或无法写入 artifact 才会作为工具错误报告。

结果写入 `workspaceDir/artifacts/<adapter>/<task>/`，每个文件使用独占创建，已有文件不会
被覆盖。返回值中的 `artifact.path` 是相对于 `workspaceDir` 的路径。

需要登录的站点可以设置 `storageStatePath`，指向用户明确选择的 Playwright storage-state
JSON 文件。插件只读该文件，每次新建上下文时加载，文件上限为 5 MiB，默认不加载任何
状态。可以用下面的 headful Chrome 辅助程序先手动登录并保存状态；它不会覆盖已有文件：

```sh
CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \\
  node examples/save-storage-state.js https://example.com /absolute/path/fixture.storage-state.json
```

建议使用 `.storage-state.json` 后缀；该后缀已加入本包的 `.gitignore`。请把状态文件
保存在私有目录，不要提交到仓库或写入日志。

## 从完整抓虾适配包迁移

复制便携的页面任务，删除 `auth`、`trigger`、`params`、`output`、任务入口覆盖和调度
声明等后端字段；将 `window.__CRAWSHRIMP_PARAMS__` 改成 `window.__PARAMS__`，并确保
外层 IIFE 最终返回 `{ success, data, meta }`。调用方参数通过
`crawshrimp_scripts_run` 的 `params` 传入。

示例见 [`examples/demo-adapter`](examples/demo-adapter)。

## 开发验证

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

测试会启动本地合成 HTTP 页面和真实无头 Chrome，不访问真实电商站点或账号。CI 没有
Chrome channel 时，可以用 `CHROME_PATH` 指定浏览器可执行文件。
