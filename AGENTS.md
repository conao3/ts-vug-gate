# Repository instructions

The Worker accepts GitHub webhooks and results from the managed workflow. The Durable Object owns queue and run state. Keep the report job separate from jobs that handle candidate Git objects or build packages.

Use Node 26 and pnpm through `nix develop`. Run `vp run check` in the development shell before committing. Use `nix fmt` for Nix files. Update and verify the Actions lockfile with `gh actions-lock --no-interactive` and `gh actions-lock --verify` when changing workflow dependencies.
