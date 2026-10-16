# dsh-crawshrimp-scripts

`dsh-crawshrimp-scripts` adds two standalone tools to DeepSeek Harness:

- `crawshrimp_scripts_list` discovers portable Crawshrimp adapters.
- `crawshrimp_scripts_run` opens the declared URL in a fresh isolated Playwright browser context, evaluates the declared page script, and saves the returned JSON rows as a uniquely named artifact.

The plugin has no Crawshrimp backend dependency. It supports the small portable adapter subset described below and does not claim login emulation, existing-page control, scheduling, Excel export, or the full Crawshrimp runtime.

## Install

For a released GitHub package:

```sh
dsh plugin --profile demo add -w github:howtimeschange/dsh-crawshrimp-scripts#v0.1.0
```

For a local checkout, clone the repository, install the lockfile dependencies, and add the absolute checkout path:

```sh
git clone https://github.com/howtimeschange/dsh-crawshrimp-scripts.git
cd dsh-crawshrimp-scripts
npm ci
dsh plugin --profile demo add -w /absolute/path/to/dsh-crawshrimp-scripts
```

The package declares `dsh.bundle.patch` metadata through `package.json`'s `dsh.bundle.patch` entry. `cordis.patch.yml` registers the plugin and is included in the package bundle.

## Configure

Set the plugin config in the DSH profile. Use absolute adapter roots in a real deployment:

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

The default browser is the installed Chrome channel. Set `CHROME_PATH` or `executablePath` when the executable is installed in a nonstandard location. `cdpEndpoint` is optional; when supplied, every run still requests a new browser context and fails with an isolation error if the endpoint cannot provide one. The plugin never selects or mutates existing user pages.

Every script run requires native DSH approval before browser startup. A missing approval service, missing agent, rejected request, cancelled request, or the DSH `never` deny policy fails closed. Only a one-shot `allowed-once` outcome can start the browser.

## Portable adapter subset

Each configured root contains adapter directories. Every adapter directory contains a strict `manifest.yaml`:

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

Supported manifest fields are `id`, `name`, `version`, optional `description` and `author`, `entry_url`, and `tasks`. Each task supports `id`, `name`, optional `description`, and a relative `.js` `script`. Adapter and task IDs must be lowercase slugs; task IDs must be unique. Symlinked manifests and scripts are resolved with `realpath` and are rejected when they escape their configured adapter directory.

The task script is an async IIFE evaluated in the page after navigation. It receives a JSON-cloned object at `window.__PARAMS__` and must resolve to:

```js
{
  success: true,
  data: [{ /* JSON row */ }],
  meta: { /* JSON metadata */ },
}
```

The result is bounded by `maxOutputBytes` and is saved under `workspaceDir/artifacts/<adapter>/<task>/` using exclusive file creation, so an existing artifact is never overwritten. The tool returns the artifact path relative to `workspaceDir`.

For sites that require a login, set `storageStatePath` to an explicitly selected Playwright storage-state JSON file. The file is read-only, bounded to 5 MiB, and loaded into each newly created context; the default is empty. Create one interactively with `node examples/save-storage-state.js <url> <absolute-output-path>` using a headful Chrome window. The helper never overwrites an existing state file. Prefer a filename ending in `.storage-state.json`; it is ignored by this package's `.gitignore`. Keep this file private and out of source control.

## Migration from the Crawshrimp backend

Copy only the portable page task into an adapter directory and remove backend-only manifest fields such as `auth`, `trigger`, `params`, `output`, task-specific entry overrides, and scheduling declarations. Rename `window.__CRAWSHRIMP_PARAMS__` to `window.__PARAMS__`, and end each task with the `{ success, data, meta }` result contract. Put any caller values in the `params` object passed to `crawshrimp_scripts_run`.

This plugin does not provide the Crawshrimp backend token/API bridge, login persistence, current-tab matching, task scheduling, pagination orchestration, download/export helpers, or Excel/notification sinks. A migrated script should perform only the page work it can complete inside one isolated browser context and return JSON rows.

See [`examples/demo-adapter`](examples/demo-adapter) for a synthetic title/table adapter.
