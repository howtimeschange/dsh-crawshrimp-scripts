# Demo adapter

This adapter is a portable example for the standalone `dsh-crawshrimp-scripts` plugin. It reads `document.title`, extracts text from the first HTML table, and copies the optional `params.label` into one JSON row.

The example uses the portable subset only: `manifest.yaml` declares `id`, `name`, `version`, `entry_url`, and `tasks`; the task points to one async IIFE JavaScript file that returns `{ success, data, meta }`.
