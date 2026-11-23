import { createRemoteJWKSet, jwtVerify } from "jose"
import * as z from "zod"
import { workflow } from "./github.ts"
import { id, reportSchema } from "./protocol.ts"
import type { Env } from "./protocol.ts"

export { MergeQueue } from "./queue.ts"

const encoder = new TextEncoder()
const issuer = "https://token.actions.githubusercontent.com"
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`))
const envelope = z.object({
  repository: z.object({ id }),
  number: id.optional(),
})

async function verifyWebhook(body: ArrayBuffer, signature: string | null, secret: string) {
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false
  const digest = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  )
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  return crypto.subtle.verify("HMAC", key, digest, body)
}

async function workflowRun(authorization: string | null, env: Env) {
  if (!authorization?.startsWith("Bearer ")) return null
  try {
    const { payload } = await jwtVerify(authorization.slice(7), keys, {
      algorithms: ["RS256"],
      issuer,
      audience: "vug-gate-result",
      requiredClaims: ["exp", "iat"],
      maxTokenAge: "10 minutes",
    })
    if (
      payload.repository !== env.MANAGEMENT_REPO ||
      payload.repository_id !== env.MANAGEMENT_REPOSITORY_ID ||
      payload.workflow_ref !==
        `${env.MANAGEMENT_REPO}/.github/workflows/${workflow}@refs/heads/${env.MANAGEMENT_REF}` ||
      payload.workflow_sha !== env.MANAGEMENT_SHA ||
      payload.sha !== env.MANAGEMENT_SHA ||
      payload.event_name !== "workflow_dispatch" ||
      payload.run_attempt !== "1" ||
      payload.runner_environment !== "github-hosted" ||
      typeof payload.run_id !== "string" ||
      !/^[0-9]+$/.test(payload.run_id)
    )
      return null
    return id.parse(Number(payload.run_id))
  } catch {
    return null
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const stub = env.QUEUE.getByName("merge-policy")
    if (path === "/webhook") {
      const body = await request.arrayBuffer()
      if (
        !(await verifyWebhook(
          body,
          request.headers.get("x-hub-signature-256"),
          env.GITHUB_WEBHOOK_SECRET,
        ))
      ) {
        return new Response("Invalid signature", { status: 401 })
      }
      const kind = request.headers.get("x-github-event")
      if (kind !== "pull_request" && kind !== "push") return new Response(null, { status: 204 })
      const parsed = envelope.safeParse(await new Response(body).json().catch(() => null))
      if (!parsed.success || (kind === "pull_request" && !parsed.data.number)) {
        return new Response("Invalid event", { status: 400 })
      }
      return stub.fetch("https://queue.internal/intake", {
        method: "POST",
        body: JSON.stringify({
          repo: parsed.data.repository.id,
          pr: kind === "pull_request" ? parsed.data.number : undefined,
        }),
      })
    }
    if (path === "/result") {
      const run = await workflowRun(request.headers.get("authorization"), env)
      if (run === null) return new Response("Invalid workflow identity", { status: 401 })
      const report = reportSchema.safeParse(await request.json().catch(() => null))
      if (!report.success) return new Response("Invalid result", { status: 400 })
      return stub.fetch("https://queue.internal/result", {
        method: "POST",
        body: JSON.stringify({ run, report: report.data }),
      })
    }
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
