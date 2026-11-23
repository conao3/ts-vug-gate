import { createPrivateKey } from "node:crypto"
import { importPKCS8, SignJWT } from "jose"
import * as z from "zod"
import { digest, id, oid, repoName, sameCandidate } from "./protocol.ts"
import type { Candidate, Env, Target } from "./protocol.ts"

export const workflow = "merge-policy.yml"
const api = "https://api.github.com"
const check = "vug/merge-policy"
const pullSchema = z.object({
  number: id,
  user: z.object({ id }),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  base: z.object({ ref: z.string(), repo: z.object({ id }) }),
  head: z.object({ sha: oid }),
})
const repositorySchema = z.object({ id, full_name: repoName, default_branch: z.string() })
const runSchema = z.object({
  id,
  head_sha: oid,
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.url(),
  display_title: z.string(),
})
export type Run = z.infer<typeof runSchema>
type Notice = { summary: string; status: "queued" | "in_progress" | "completed"; success?: boolean }

export class GithubError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(`GitHub ${method} ${path} returned ${status}`)
  }
}

export class GitHub {
  private readonly installations = new Map<string, { token: string; expires: number }>()

  constructor(private readonly env: Env) {}

  private async request(path: string, token: string, method = "GET", input?: unknown) {
    const response = await fetch(api + path, {
      method,
      redirect: "manual",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "vug-gate",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new GithubError(response.status, method, path)
    return response.status === 204 || response.status === 202 ? undefined : response.json()
  }

  private async installation(target: Target, merge = false) {
    const app = merge ? this.env.MERGE_APP_ID : this.env.GITHUB_APP_ID
    const privateKey = merge ? this.env.MERGE_APP_PRIVATE_KEY : this.env.GITHUB_APP_PRIVATE_KEY
    if (!app || !privateKey) throw new Error("Missing GitHub App credentials")
    const key = `${app}:${target.installation_id}:${target.repo_id}`
    const cached = this.installations.get(key)
    if (cached && cached.expires > Date.now() + 60_000) return cached.token
    const pem = createPrivateKey(privateKey).export({
      type: "pkcs8",
      format: "pem",
    })
    const signingKey = await importPKCS8(pem, "RS256")
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(app)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
      .setExpirationTime("8m")
      .sign(signingKey)
    const value = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() }).parse(
      await this.request(
        `/app/installations/${target.installation_id}/access_tokens`,
        jwt,
        "POST",
        {
          repository_ids: [target.repo_id],
          permissions: merge
            ? { contents: "write", pull_requests: "read", checks: "read" }
            : { contents: "read", pull_requests: "read", checks: "write" },
        },
      ),
    )
    this.installations.set(key, { token: value.token, expires: Date.parse(value.expires_at) })
    return value.token
  }

  async snapshot(target: Target, pr: number) {
    const token = await this.installation(target)
    const root = `/repos/${target.repo}`
    const [repository, pull] = await Promise.all([
      this.request(root, token).then((value) => repositorySchema.parse(value)),
      this.request(`${root}/pulls/${pr}`, token).then((value) => pullSchema.parse(value)),
    ])
    if (
      repository.id !== target.repo_id ||
      repository.full_name !== target.repo ||
      pull.base.repo.id !== repository.id ||
      pull.number !== pr
    ) {
      throw new Error("GitHub repository or pull request identity mismatch")
    }
    const { sha: head_sha } = pull.head
    const state = {
      author: pull.user.id,
      head: head_sha,
      branch: pull.base.ref,
      merged: pull.merged,
    }
    const policy_digest = digest.parse(this.env.POLICY_DIGEST)
    if (pull.state !== "open" || pull.draft || pull.base.ref !== repository.default_branch) {
      return { ...state, candidate: null }
    }
    const ref = repository.default_branch.split("/").map(encodeURIComponent).join("/")
    const [base, head] = await Promise.all([
      this.request(`${root}/git/ref/heads/${ref}`, token).then((value) =>
        z.object({ object: z.object({ sha: oid }) }).parse(value),
      ),
      this.request(`${root}/git/commits/${head_sha}`, token).then((value) =>
        z.object({ sha: oid, tree: z.object({ sha: oid }) }).parse(value),
      ),
    ])
    if (head.sha !== head_sha) throw new Error("GitHub commit identity mismatch")
    const candidate: Candidate = {
      repo: repository.full_name,
      repo_id: repository.id,
      pr,
      head_sha,
      base_sha: base.object.sha,
      tree_oid: head.tree.sha,
      policy_digest,
    }
    return { ...state, candidate }
  }

  mergeTarget(target: Target) {
    if (!this.env.MERGE_INSTALLATION) return null
    const config = z
      .object({ repo_id: id, installation_id: id, branch: z.string().min(1) })
      .strict()
      .parse(JSON.parse(this.env.MERGE_INSTALLATION))
    if (config.repo_id !== target.repo_id) return null
    if (this.env.MERGE_APP_ID === this.env.GITHUB_APP_ID) {
      throw new Error("The inspection and merge Apps must have different identities")
    }
    return { ...target, installation_id: config.installation_id, branch: config.branch }
  }

  async approved(target: Target, candidate: Candidate, author: number) {
    const token = await this.installation(target, true)
    const root = `/repos/${target.repo}`
    const reviewSchema = z.array(
      z.object({
        id,
        state: z.string(),
        commit_id: oid.nullable(),
        user: z.object({ id, login: z.string() }).nullable(),
      }),
    )
    const latest = new Map<number, z.infer<typeof reviewSchema>[number]>()
    for (let page = 1; page <= 5; page++) {
      const reviews = reviewSchema.parse(
        await this.request(
          `${root}/pulls/${candidate.pr}/reviews?per_page=100&page=${page}`,
          token,
        ),
      )
      for (const review of reviews) {
        if (
          review.user &&
          review.user.id !== author &&
          ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
        ) {
          latest.set(review.user.id, review)
        }
      }
      if (reviews.length === 100) continue
      for (const review of latest.values()) {
        if (review.state !== "APPROVED" || review.commit_id !== candidate.head_sha || !review.user)
          continue
        const result = z
          .object({ permission: z.string(), user: z.object({ id }) })
          .parse(
            await this.request(
              `${root}/collaborators/${encodeURIComponent(review.user.login)}/permission`,
              token,
            ),
          )
        if (result.permission === "admin" && result.user.id === review.user.id) return true
      }
      return false
    }
    return false
  }

  async squash(
    inspection: Target,
    target: Target & { branch: string },
    candidate: Candidate,
    checkId: number,
  ) {
    const root = `/repos/${target.repo}`
    const token = await this.installation(target, true)
    const run = z
      .object({
        id,
        app: z.object({ id }).nullable(),
        name: z.string(),
        external_id: z.string().nullable(),
        head_sha: oid,
        status: z.string(),
        conclusion: z.string().nullable(),
      })
      .parse(await this.request(`${root}/check-runs/${checkId}`, token))
    if (
      run.id !== checkId ||
      run.app?.id !== Number(this.env.GITHUB_APP_ID) ||
      run.name !== check ||
      run.external_id !== `${target.repo_id}:${candidate.pr}` ||
      run.head_sha !== candidate.head_sha ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    )
      return false

    const comparison = z
      .object({ status: z.string() })
      .parse(
        await this.request(
          `${root}/compare/${candidate.base_sha}...${candidate.head_sha}?per_page=1`,
          token,
        ),
      )
    if (comparison.status !== "ahead") return false
    const latest = await this.snapshot(inspection, candidate.pr)
    if (
      latest.branch !== target.branch ||
      !latest.candidate ||
      !sameCandidate(candidate, latest.candidate)
    )
      return false
    const result = z.object({ merged: z.literal(true), sha: oid }).parse(
      await this.request(`${root}/pulls/${candidate.pr}/merge`, token, "PUT", {
        sha: candidate.head_sha,
        merge_method: "squash",
      }),
    )
    const commit = z
      .object({
        tree: z.object({ sha: oid }),
        parents: z.array(z.object({ sha: oid })),
      })
      .parse(await this.request(`${root}/git/commits/${result.sha}`, token))
    if (
      commit.tree.sha !== candidate.tree_oid ||
      commit.parents.length !== 1 ||
      commit.parents[0]?.sha !== candidate.base_sha
    ) {
      console.error("Merged commit differs from the inspected candidate", result.sha)
    }
    return true
  }

  async managedRun(path: string, method = "GET", input?: unknown) {
    const repo = repoName.parse(this.env.MANAGEMENT_REPO)
    return this.request(
      `/repos/${repo}/actions/${path}`,
      this.env.GITHUB_ACTIONS_TOKEN,
      method,
      input,
    )
  }

  async readRun(run: number) {
    return runSchema.parse(await this.managedRun(`runs/${run}`))
  }

  async check(target: Target, pr: number, head: string, notice: Notice, knownId?: number) {
    const token = await this.installation(target)
    const root = `/repos/${target.repo}`
    const external_id = `${target.repo_id}:${pr}`
    const body = {
      name: check,
      external_id,
      status: notice.status,
      ...(notice.status === "completed"
        ? { conclusion: notice.success ? "success" : "failure" }
        : {}),
      output: { title: check, summary: notice.summary },
    }
    if (knownId === undefined || notice.status !== "completed") {
      const runs = z
        .object({
          check_runs: z.array(
            z.object({ id, external_id: z.string().nullable(), status: z.string() }),
          ),
        })
        .parse(
          await this.request(
            `${root}/commits/${head}/check-runs?check_name=${encodeURIComponent(check)}&app_id=${encodeURIComponent(this.env.GITHUB_APP_ID)}&filter=all&per_page=100`,
            token,
          ),
        )
      knownId = runs.check_runs
        .filter(
          (run) =>
            run.external_id === external_id &&
            (notice.status === "completed" || run.status !== "completed"),
        )
        .reduce<number | undefined>((latest, run) => Math.max(latest ?? 0, run.id), undefined)
    }
    if (knownId === undefined) {
      return z
        .object({ id })
        .parse(await this.request(`${root}/check-runs`, token, "POST", { ...body, head_sha: head }))
        .id
    }
    return z
      .object({ id })
      .parse(await this.request(`${root}/check-runs/${knownId}`, token, "PATCH", body)).id
  }
}
