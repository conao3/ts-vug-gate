import { generateKeyPairSync } from "node:crypto"
import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vite-plus"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GITHUB_APP_ID: "123",
          GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }),
          GITHUB_WEBHOOK_SECRET: "test-webhook",
          GITHUB_ACTIONS_TOKEN: "test-actions",
          MANAGEMENT_REPO: "example/gate",
          MANAGEMENT_REF: "master",
          MANAGEMENT_SHA: "0".repeat(40),
          MANAGEMENT_REPOSITORY_ID: "90",
          POLICY_DIGEST: "7".repeat(64),
          TARGETS: JSON.stringify([{ repo: "example/packages", repo_id: 99, installation_id: 10 }]),
        },
      },
    }),
  ],
  fmt: {
    semi: false,
    singleQuote: false,
    trailingComma: "all",
    sortPackageJson: false,
    ignorePatterns: [".direnv"],
  },
  lint: {
    categories: { correctness: "error", suspicious: "warn" },
    ignorePatterns: ["node_modules", "dist", ".direnv"],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    tasks: {
      check: { command: "vp check && vitest run", cache: false },
    },
  },
})
