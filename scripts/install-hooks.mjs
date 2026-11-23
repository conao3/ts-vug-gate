import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"

const runGit = (...args) => spawnSync("git", args, { encoding: "utf8" })
const workspace = runGit("rev-parse", "--show-toplevel")
if (
  workspace.status === 0 &&
  workspace.stdout.trim() === process.cwd() &&
  runGit("config", "--get", "core.hooksPath").status !== 0
) {
  mkdirSync(".vite-hooks", { recursive: true })
  writeFileSync(
    ".vite-hooks/pre-commit",
    `#!/bin/sh
if [ -e /etc/NIXOS ] && command -v steam-run >/dev/null; then
  exec nix develop --command steam-run vp run check
fi
exec nix develop --command vp run check
`,
    { mode: 0o755 },
  )
  const configured = runGit("config", "--local", "core.hooksPath", ".vite-hooks")
  if (configured.status !== 0) throw new Error(configured.stderr)
}
