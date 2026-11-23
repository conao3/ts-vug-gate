import { env } from "cloudflare:workers"
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test"
import { setupNetwork } from "@msw/cloudflare"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { http, HttpResponse } from "msw"
import { afterAll, beforeAll, expect, it } from "vitest"
import { Buffer } from "node:buffer"
import * as z from "zod"
import { dispatchSchema } from "../src/protocol.ts"
import type { Dispatch, Env } from "../src/protocol.ts"

const network = setupNetwork()
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
type WorkerEnv = Env
const config = env
const worker = SELF
const sha = (digit: string) => digit.repeat(40)
const origin = "https://api.github.com"
const repo = `${origin}/repos/example/packages`
const actions = `${origin}/repos/example/gate/actions`
const snapshots = new Map([
  [1, { author: 100, head: sha("1") }],
  [2, { author: 100, head: sha("2") }],
  [3, { author: 100, head: sha("3") }],
  [4, { author: 101, head: sha("4") }],
])
const closed = new Set<number>()
const checks: {
  id: number
  head_sha?: string
  external_id: string
  status: string
  conclusion?: string
  output: { summary: string }
}[] = []
const jobs: { candidate: Dispatch; status: string; conclusion: string | null }[] = []
const checkBody = z.object({
  head_sha: z.string().optional(),
  external_id: z.string(),
  status: z.string(),
  conclusion: z.string().optional(),
  output: z.object({ summary: z.string() }),
})
let reads = 0
const signing = await generateKeyPair("RS256", { extractable: true })
const jwk = { ...(await exportJWK(signing.publicKey)), kid: "test-jwk", alg: "RS256" }

beforeAll(() => {
  network.enable()
  network.use(
    http.get("https://token.actions.githubusercontent.com/.well-known/jwks", () =>
      HttpResponse.json({ keys: [jwk] }),
    ),
    http.post(`${origin}/app/installations/10/access_tokens`, () =>
      HttpResponse.json(
        { token: "installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      ),
    ),
    http.get(repo, () =>
      HttpResponse.json({ id: 99, full_name: "example/packages", default_branch: "master" }),
    ),
    http.get(`${repo}/pulls/:pr`, ({ params }) => {
      reads++
      const row = snapshots.get(Number(params.pr))
      if (!row) return new HttpResponse(null, { status: 404 })
      return HttpResponse.json({
        number: Number(params.pr),
        state: closed.has(Number(params.pr)) ? "closed" : "open",
        draft: false,
        merged: false,
        user: { id: row.author },
        base: { ref: "master", repo: { id: 99 } },
        head: { sha: row.head },
      })
    }),
    http.get(`${repo}/git/ref/heads/master`, () =>
      HttpResponse.json({ object: { sha: sha("a") } }),
    ),
    http.get(`${repo}/git/commits/:head`, ({ params }) =>
      HttpResponse.json({ sha: params.head, tree: { sha: sha("b") } }),
    ),
    http.get(`${repo}/commits/:head/check-runs`, ({ params }) => {
      const latest = new Map(checks.map((entry) => [entry.id, entry]))
      return HttpResponse.json({
        check_runs: [...latest.values()].filter((entry) => entry.head_sha === params.head),
      })
    }),
    http.post(`${repo}/check-runs`, async ({ request }) => {
      const body = checkBody.parse(await request.json())
      const id = checks.length + 50
      checks.push({ ...body, id })
      return HttpResponse.json({ id }, { status: 201 })
    }),
    http.patch(`${repo}/check-runs/:id`, async ({ request, params }) => {
      const id = Number(params.id)
      const before = checks.findLast((entry) => entry.id === id)
      const body = checkBody.parse(await request.json())
      checks.push({ ...before, ...body, head_sha: body.head_sha ?? before?.head_sha, id })
      return HttpResponse.json({ id })
    }),
    http.post(`${actions}/workflows/merge-policy.yml/dispatches`, async ({ request }) => {
      const data = z
        .object({ inputs: z.object({ candidate: z.string() }) })
        .parse(await request.json())
      jobs.push({
        candidate: dispatchSchema.parse(JSON.parse(data.inputs.candidate)),
        status: "in_progress",
        conclusion: null,
      })
      return HttpResponse.json({ workflow_run_id: jobs.length })
    }),
    http.post(`${actions}/runs/:id/cancel`, ({ params }) => {
      const job = jobs[Number(params.id) - 1]
      if (!job) return new HttpResponse(null, { status: 404 })
      job.status = "completed"
      job.conclusion = "cancelled"
      return new HttpResponse(null, { status: 202 })
    }),
    http.get(`${actions}/runs/:id`, ({ params }) => {
      const id = Number(params.id)
      const job = jobs[id - 1]
      if (!job) return new HttpResponse(null, { status: 404 })
      return HttpResponse.json({
        id,
        display_title: `Merge policy ${job.candidate.id}`,
        status: job.status,
        conclusion: job.conclusion,
        head_sha: config.MANAGEMENT_SHA,
        html_url: "https://example.test/run",
      })
    }),
  )
})

afterAll(() => network.disable())

const stub = () => config.QUEUE.getByName("merge-policy")

async function event(number: number, valid = true) {
  const body = JSON.stringify({
    number,
    repository: { id: 99 },
    action: "closed",
    pull_request: { draft: true, head: { sha: sha("f") }, user: { id: 999 } },
  })
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(valid ? config.GITHUB_WEBHOOK_SECRET : "incorrect"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  ).toString("hex")
  return worker.fetch("https://example.test/webhook", {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": `sha256=${signature}`, "x-github-event": "pull_request" },
  })
}

async function result(candidate: Dispatch, run: number, workflowSha = config.MANAGEMENT_SHA) {
  const token = await new SignJWT({
    repository: config.MANAGEMENT_REPO,
    repository_id: config.MANAGEMENT_REPOSITORY_ID,
    sha: workflowSha,
    workflow_sha: workflowSha,
    workflow_ref: "example/gate/.github/workflows/merge-policy.yml@refs/heads/master",
    event_name: "workflow_dispatch",
    run_id: String(run),
    run_attempt: "1",
    runner_environment: "github-hosted",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-jwk" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience("vug-gate-result")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signing.privateKey)
  return worker.fetch("https://example.test/result", {
    method: "POST",
    body: JSON.stringify({ candidate, decision: "auto_merge" }),
    headers: { authorization: `Bearer ${token}` },
  })
}

const stored = z.object({ pr: z.number(), phase: z.string() })
async function entries() {
  return runInDurableObject(stub(), (_instance, state) =>
    state.storage.sql
      .exec<{ entry: string }>("SELECT entry FROM queue ORDER BY pr")
      .toArray()
      .map((row) => stored.parse(JSON.parse(row.entry))),
  )
}

async function alarms(count: number) {
  for (let index = 0; index < count; index++) {
    if (!(await runDurableObjectAlarm(stub()))) break
  }
}

it("authenticates intake and results and preserves slots across replay, cancellation and a restart", async () => {
  expect((await event(1, false)).status).toBe(401)
  expect(reads).toBe(0)
  for (const pr of [1, 1, 2, 3, 4]) expect((await event(pr)).status).toBe(202)
  await alarms(14)
  expect(jobs.map((job) => job.candidate.pr)).toEqual([1])
  const old = jobs[0]
  if (!old) throw new Error("Missing first dispatch")
  expect(old.candidate).toMatchObject({
    head_sha: sha("1"),
    base_sha: sha("a"),
    tree_oid: sha("b"),
  })
  expect((await entries()).map(({ phase }) => phase)).toEqual([
    "running",
    "waiting",
    "deferred",
    "waiting",
  ])
  expect(
    checks.some(
      (check) => check.conclusion === "failure" && check.output.summary.startsWith("Deferred"),
    ),
  ).toBe(true)

  await evictDurableObject(stub())
  expect((await event(1)).status).toBe(202)
  await alarms(3)
  expect(jobs).toHaveLength(1)
  expect((await entries()).map(({ phase }) => phase)).toEqual([
    "running",
    "waiting",
    "deferred",
    "waiting",
  ])
  expect((await result(old.candidate, 1, sha("5"))).status).toBe(401)
  expect((await result({ ...old.candidate, tree_oid: sha("6") }, 1)).status).toBe(409)

  snapshots.set(1, { author: 100, head: sha("5") })
  expect((await event(1)).status).toBe(202)
  expect((await result(old.candidate, 1)).status).toBe(409)
  await alarms(3)
  expect(checks.findLast((check) => check.head_sha === sha("1"))).toMatchObject({
    status: "completed",
    conclusion: "failure",
    output: { summary: "A newer candidate replaced this result." },
  })
  expect(old.conclusion).toBe("cancelled")
  expect(jobs).toHaveLength(1)
  await runInDurableObject(stub(), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE queue SET entry = json_set(entry, '$.active.poll', 0) WHERE pr = 1",
    )
  })
  await alarms(5)
  const current = jobs[1]
  if (!current) throw new Error("Missing replacement dispatch")
  expect(current.candidate).toMatchObject({ pr: 1, head_sha: sha("5") })
  expect(current.candidate.id).not.toBe(old.candidate.id)
  expect((await result(current.candidate, 2)).status).toBe(204)
  expect((await result(current.candidate, 2)).status).toBe(204)
  current.status = "completed"
  current.conclusion = "success"
  await alarms(3)
  expect(
    checks.filter((check) => check.conclusion === "success").map((check) => check.head_sha),
  ).toEqual([sha("5")])
  expect((await result(current.candidate, 2)).status).toBe(409)

  const completed = checks.findLast((check) => check.head_sha === sha("5"))
  for (const pr of [1, 2, 3]) {
    closed.add(pr)
    expect((await event(pr)).status).toBe(202)
  }
  await alarms(4)
  closed.delete(1)
  expect((await event(1)).status).toBe(202)
  await alarms(2)
  const reopened = checks.findLast((check) => check.head_sha === sha("5"))
  expect(reopened?.id).not.toBe(completed?.id)
  expect(reopened?.status).toBe("queued")
}, 30_000)

it("only squashes a matching candidate with the inspection App's successful check", async () => {
  const { GitHub } = await import("../src/github.ts")
  const github = new GitHub({
    ...config,
    GITHUB_APP_ID: "11",
    MERGE_APP_ID: "22",
    MERGE_APP_PRIVATE_KEY: config.GITHUB_APP_PRIVATE_KEY,
    MERGE_INSTALLATION: JSON.stringify({ repo_id: 99, installation_id: 20, branch: "master" }),
  })
  const inspection = { repo: "example/packages", repo_id: 99, installation_id: 10 }
  const merger = github.mergeTarget(inspection)!
  snapshots.set(9, { author: 100, head: sha("9") })
  const { candidate } = await github.snapshot(inspection, 9)
  if (!candidate) throw new Error("Missing fixture candidate")
  let appId = 22
  let merges = 0
  network.use(
    http.post(`${origin}/app/installations/20/access_tokens`, () =>
      HttpResponse.json({
        token: "merge-installation",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ),
    http.get(`${repo}/check-runs/123`, () =>
      HttpResponse.json({
        id: 123,
        app: { id: appId },
        name: "vug/merge-policy",
        external_id: "99:9",
        head_sha: sha("9"),
        status: "completed",
        conclusion: "success",
      }),
    ),
    http.get(`${repo}/compare/:range`, () => HttpResponse.json({ status: "ahead" })),
    http.put(`${repo}/pulls/9/merge`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer merge-installation")
      expect(await request.json()).toEqual({ sha: sha("9"), merge_method: "squash" })
      merges++
      return HttpResponse.json({ merged: true, sha: sha("c") })
    }),
    http.get(`${repo}/git/commits/${sha("c")}`, () =>
      HttpResponse.json({ tree: { sha: sha("b") }, parents: [{ sha: sha("a") }] }),
    ),
  )

  expect(await github.squash(inspection, merger, candidate, 123)).toBe(false)
  appId = 11
  expect(await github.squash(inspection, merger, { ...candidate, base_sha: sha("d") }, 123)).toBe(
    false,
  )
  expect(await github.squash(inspection, merger, { ...candidate, tree_oid: sha("d") }, 123)).toBe(
    false,
  )
  snapshots.set(9, { author: 100, head: sha("8") })
  expect(await github.squash(inspection, merger, candidate, 123)).toBe(false)
  expect(merges).toBe(0)
  snapshots.set(9, { author: 100, head: sha("9") })
  expect(await github.squash(inspection, merger, candidate, 123)).toBe(true)
  expect(merges).toBe(1)
  expect(await github.squash(inspection, { ...merger, branch: "other" }, candidate, 123)).toBe(
    false,
  )
  expect(merges).toBe(1)

  const review = {
    id: 1,
    state: "APPROVED",
    commit_id: sha("8"),
    user: { id: 101, login: "maintainer" },
  }
  const reviews = [review]
  let permission = "admin"
  network.use(
    http.get(`${repo}/pulls/9/reviews`, () => HttpResponse.json(reviews)),
    http.get(`${repo}/collaborators/maintainer/permission`, () =>
      HttpResponse.json({ permission, user: { id: 101 } }),
    ),
  )
  expect(await github.approved(merger, candidate, 100)).toBe(false)
  review.commit_id = sha("9")
  expect(await github.approved(merger, candidate, 101)).toBe(false)
  permission = "write"
  expect(await github.approved(merger, candidate, 100)).toBe(false)
  permission = "admin"
  expect(await github.approved(merger, candidate, 100)).toBe(true)
  reviews.push({ ...review, id: 2, state: "DISMISSED" })
  expect(await github.approved(merger, candidate, 100)).toBe(false)
})
