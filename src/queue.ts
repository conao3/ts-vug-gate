import { DurableObject } from "cloudflare:workers"
import * as z from "zod"
import { GitHub, GithubError, workflow } from "./github.ts"
import {
  candidateSchema,
  decisionSchema,
  dispatchSchema,
  id,
  oid,
  reportSchema,
  sameCandidate,
  targetSchema,
  targets,
} from "./protocol.ts"
import type { Decision, Env, Report, Target } from "./protocol.ts"

const activeSchema = z.object({
  job: dispatchSchema,
  attempted: z.number().optional(),
  run: id.optional(),
  poll: z.number(),
  cancelled: z.boolean().optional(),
  result: decisionSchema.optional(),
})
const entrySchema = z.object({
  target: targetSchema,
  pr: id,
  author: id,
  head: oid,
  candidate: candidateSchema.nullable(),
  phase: z.enum(["waiting", "deferred", "running", "done", "inactive"]),
  queued: z.number(),
  active: activeSchema.optional(),
  dirty: z.boolean(),
  checkId: id.optional(),
  superseded: z.object({ head: oid, checkId: id }).optional(),
  outcome: decisionSchema.optional(),
  managementShaMismatch: z.boolean().optional(),
  mergePending: z.boolean().optional(),
  approvalPoll: z.number().optional(),
})
type Active = z.infer<typeof activeSchema>
type Entry = z.infer<typeof entrySchema>
type Snapshot = Awaited<ReturnType<GitHub["snapshot"]>>
const intakeSchema = z.object({ repo: id, pr: id.optional() })
const completionSchema = z.object({ run: id, report: reportSchema })
const TICK = 1_000
const POLL = 60_000
const APPROVAL_POLL = 5 * POLL

function checkNotice(entry: Entry, approved = false) {
  switch (entry.phase) {
    case "waiting":
      return { status: "queued", summary: "Waiting for a build slot." } as const
    case "deferred":
      return {
        status: "completed",
        summary: "Deferred: this author already has a waiting pull request.",
      } as const
    case "running":
      return { status: "in_progress", summary: "Checking the current candidate." } as const
    case "inactive":
      return {
        status: "completed",
        summary: "The pull request is closed, draft, or targets another branch.",
      } as const
    case "done":
      return {
        status: "completed",
        success: entry.outcome === "auto_merge" || approved,
        summary: {
          auto_merge: "All required checks passed.",
          incomplete: entry.managementShaMismatch
            ? "The management workflow commit differs from MANAGEMENT_SHA. Redeploy the Worker for the current management branch."
            : "One or more required checks did not complete.",
          reject: "The candidate failed the merge policy.",
          requires_approval: approved
            ? "A repository administrator approved the inspected candidate."
            : "The candidate requires maintainer approval.",
        }[entry.outcome ?? "incomplete"],
      } as const
    default:
      throw new Error("Invalid queue phase")
  }
}

function sameSnapshot(entry: Entry, next: Snapshot) {
  return (
    entry.head === next.head &&
    entry.author === next.author &&
    (entry.candidate && next.candidate
      ? sameCandidate(entry.candidate, next.candidate)
      : entry.candidate === next.candidate)
  )
}

export class MergeQueue extends DurableObject<Env> {
  private readonly github: GitHub
  private serial: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.github = new GitHub(env)
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS queue (repo INTEGER, pr INTEGER, refresh INTEGER NOT NULL DEFAULT 0, entry TEXT NOT NULL, PRIMARY KEY (repo, pr))",
    )
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS authors (id INTEGER PRIMARY KEY, last_served INTEGER NOT NULL)",
    )
  }

  private runSerial<T>(action: () => Promise<T>) {
    const result = this.serial.then(action)
    this.serial = result.catch(() => undefined)
    return result
  }

  private entries() {
    return this.ctx.storage.sql
      .exec<{ entry: string }>("SELECT entry FROM queue")
      .toArray()
      .map((row) => entrySchema.parse(JSON.parse(row.entry)))
      .toSorted((left, right) => left.queued - right.queued || left.pr - right.pr)
  }

  private save(entry: Entry) {
    this.ctx.storage.sql.exec(
      "INSERT INTO queue (repo, pr, entry) VALUES (?, ?, ?) ON CONFLICT (repo, pr) DO UPDATE SET entry = excluded.entry",
      entry.target.repo_id,
      entry.pr,
      JSON.stringify(entry),
    )
  }

  private limit(key: "RUNNING_PER_AUTHOR" | "WAITING_PER_AUTHOR" | "RUNNING_TOTAL") {
    return z.number().int().min(1).max(10).parse(Number(this.env[key]))
  }

  private async wake(delay: number) {
    const when = Date.now() + Math.max(TICK, delay)
    const previous = await this.ctx.storage.getAlarm()
    if (previous === null || previous > when) await this.ctx.storage.setAlarm(when)
  }

  private replace(target: Target, pr: number, next: Snapshot) {
    this.ctx.storage.transactionSync(() => {
      const entries = this.entries()
      const prior = entries.find(
        (entry) => entry.target.repo_id === target.repo_id && entry.pr === pr,
      )
      if (prior && sameSnapshot(prior, next)) return
      const authorWaiting = entries.filter(
        (entry) => entry.author === next.author && entry.phase === "waiting" && entry !== prior,
      ).length
      const changedHead = prior?.head !== next.head
      const superseded =
        changedHead &&
        prior?.checkId &&
        (prior.phase === "waiting" ||
          prior.phase === "running" ||
          prior.outcome === "auto_merge" ||
          prior.outcome === "requires_approval")
          ? { head: prior.head, checkId: prior.checkId }
          : prior?.superseded
      const phase = prior?.active
        ? "running"
        : !next.candidate
          ? "inactive"
          : authorWaiting >= this.limit("WAITING_PER_AUTHOR")
            ? "deferred"
            : "waiting"
      this.save({
        target,
        pr,
        author: next.author,
        head: next.head,
        candidate: next.candidate,
        phase,
        dirty: !next.merged,
        queued: prior?.queued ?? Date.now(),
        active: prior?.active ? { ...prior.active, poll: 0 } : undefined,
        checkId: changedHead ? undefined : prior?.checkId,
        superseded,
      })
    })
  }

  private async intake(repo: number, pr?: number) {
    const target = targets(this.env).find((entry) => entry.repo_id === repo)
    if (!target) return new Response(null, { status: 204 })
    if (pr === undefined) {
      await this.wake(TICK)
      this.ctx.storage.sql.exec("UPDATE queue SET refresh = 1 WHERE repo = ?", repo)
    } else {
      const next = await this.github.snapshot(target, pr)
      await this.wake(TICK)
      this.replace(target, pr, next)
    }
    return new Response(null, { status: 202 })
  }

  private async accept(run: number, report: Report) {
    const entry = this.entries().find(
      (row) => row.target.repo_id === report.candidate.repo_id && row.pr === report.candidate.pr,
    )
    const active = entry?.active
    if (
      !entry?.candidate ||
      !active ||
      active.job.id !== report.candidate.id ||
      (active.run !== undefined && active.run !== run) ||
      active.attempted === undefined ||
      active.cancelled ||
      !sameCandidate(active.job, report.candidate) ||
      !sameCandidate(entry.candidate, report.candidate) ||
      (active.result !== undefined && active.result !== report.decision)
    ) {
      return new Response("Stale or unknown result", { status: 409 })
    }
    const verified = await this.github.readRun(run)
    if (
      verified.display_title !== `Merge policy ${active.job.id}` ||
      verified.head_sha !== this.env.MANAGEMENT_SHA
    ) {
      return new Response("Run identity mismatch", { status: 409 })
    }
    await this.wake(TICK)
    this.ctx.storage.transactionSync(() => {
      this.save({ ...entry, active: { ...active, run, result: report.decision, poll: 0 } })
    })
    return new Response(null, { status: 204 })
  }

  override fetch(request: Request) {
    return this.runSerial(async () => {
      switch (new URL(request.url).pathname) {
        case "/intake": {
          const { repo, pr } = intakeSchema.parse(await request.json())
          return this.intake(repo, pr)
        }
        case "/result": {
          const { run, report } = completionSchema.parse(await request.json())
          return this.accept(run, report)
        }
        default:
          return new Response(null, { status: 404 })
      }
    })
  }

  private promote(entries: Entry[]) {
    const running = entries.filter((entry) => entry.active)
    const served = new Map(
      this.ctx.storage.sql
        .exec<{ id: number; last_served: number }>("SELECT id, last_served FROM authors")
        .toArray()
        .map((row) => [row.id, row.last_served]),
    )
    const slot =
      running.length >= this.limit("RUNNING_TOTAL")
        ? undefined
        : entries
            .filter(
              (entry) =>
                entry.phase === "waiting" &&
                running.filter((row) => row.author === entry.author).length <
                  this.limit("RUNNING_PER_AUTHOR"),
            )
            .toSorted(
              (left, right) => (served.get(left.author) ?? 0) - (served.get(right.author) ?? 0),
            )[0]
    if (slot?.candidate) {
      const active = { job: { ...slot.candidate, id: crypto.randomUUID() }, poll: 0 }
      this.save({ ...slot, phase: "running", active, dirty: true })
      this.ctx.storage.sql.exec(
        "INSERT INTO authors (id, last_served) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET last_served = excluded.last_served",
        slot.author,
        Date.now(),
      )
      return true
    }
    const deferred = entries.find(
      (entry) =>
        entry.phase === "deferred" &&
        entries.filter((row) => row.phase === "waiting" && row.author === entry.author).length <
          this.limit("WAITING_PER_AUTHOR"),
    )
    if (deferred) {
      this.save({ ...deferred, phase: "waiting", dirty: true })
      return true
    }
    return false
  }

  private async recoverRun(active: Active) {
    const sha = oid.parse(this.env.MANAGEMENT_SHA)
    const created = encodeURIComponent(`>=${new Date(active.attempted ?? 0).toISOString()}`)
    for (let page = 1; page <= 10; page++) {
      const result = z
        .object({
          workflow_runs: z.array(z.object({ id, display_title: z.string() })),
        })
        .parse(
          await this.github.managedRun(
            `workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${sha}&created=${created}&per_page=100&page=${page}`,
          ),
        )
      const run = result.workflow_runs.find(
        (item) => item.display_title === `Merge policy ${active.job.id}`,
      )
      if (run || result.workflow_runs.length < 100) return run?.id
    }
    return undefined
  }

  private async active(entry: Entry, active: Active) {
    const outdated = !entry.candidate || !sameCandidate(entry.candidate, active.job)
    if (active.attempted === undefined) {
      if (outdated) return this.finish(entry)
      const latest = await this.github.snapshot(entry.target, entry.pr)
      if (!sameSnapshot(entry, latest)) return this.replace(entry.target, entry.pr, latest)
      active.attempted = Date.now() - 5_000
      active.poll = Date.now() + POLL
      this.save(entry)
      try {
        const response = await this.github.managedRun(`workflows/${workflow}/dispatches`, "POST", {
          ref: this.env.MANAGEMENT_REF,
          inputs: { candidate: JSON.stringify(active.job) },
        })
        active.run = z.object({ workflow_run_id: id }).parse(response).workflow_run_id
        this.save(entry)
      } catch (error) {
        if (error instanceof GithubError && [400, 401, 403, 404, 422].includes(error.status)) {
          this.finish(entry)
        } else {
          throw error
        }
      }
      return
    }
    const run = active.run ?? (await this.recoverRun(active))
    active.run = run
    active.poll = Date.now() + POLL
    this.save(entry)
    if (run === undefined) return
    const info = await this.github.readRun(run)
    if (info.status !== "completed") {
      if ((outdated || info.head_sha !== this.env.MANAGEMENT_SHA) && !active.cancelled) {
        try {
          await this.github.managedRun(`runs/${run}/cancel`, "POST")
          active.cancelled = true
          this.save(entry)
        } catch (error) {
          if (!(error instanceof GithubError) || error.status !== 409) throw error
        }
      }
      return
    }
    const latest = await this.github.snapshot(entry.target, entry.pr)
    if (!sameSnapshot(entry, latest)) this.replace(entry.target, entry.pr, latest)
    const current = this.entries().find(
      (row) => row.target.repo_id === entry.target.repo_id && row.pr === entry.pr,
    )
    if (!current) throw new Error("Missing queue entry")
    const verified =
      current.candidate &&
      sameCandidate(current.candidate, active.job) &&
      !active.cancelled &&
      info.conclusion === "success" &&
      info.head_sha === this.env.MANAGEMENT_SHA
    this.finish(
      current,
      verified ? active.result : undefined,
      info.head_sha !== this.env.MANAGEMENT_SHA,
    )
  }

  private finish(entry: Entry, outcome?: Decision, managementShaMismatch?: boolean) {
    const changed =
      entry.candidate && entry.active && !sameCandidate(entry.candidate, entry.active.job)
    if (entry.candidate && changed) {
      this.save({
        ...entry,
        phase: "running",
        dirty: true,
        active: { job: { ...entry.candidate, id: crypto.randomUUID() }, poll: 0 },
      })
      return
    }
    this.save({
      ...entry,
      phase: entry.candidate ? "done" : "inactive",
      active: undefined,
      outcome,
      managementShaMismatch,
      dirty: entry.dirty || entry.candidate !== null,
    })
  }

  private async tick() {
    const refresh = this.ctx.storage.sql
      .exec<{ repo: number; pr: number }>(
        "SELECT repo, pr FROM queue WHERE refresh = 1 ORDER BY repo, pr LIMIT 1",
      )
      .toArray()[0]
    const entries = this.entries()
    if (refresh) {
      const entry = entries.find(
        (row) => row.target.repo_id === refresh.repo && row.pr === refresh.pr,
      )
      if (!entry) throw new Error("Missing refresh entry")
      this.replace(entry.target, entry.pr, await this.github.snapshot(entry.target, entry.pr))
      this.ctx.storage.sql.exec(
        "UPDATE queue SET refresh = 0 WHERE repo = ? AND pr = ?",
        refresh.repo,
        refresh.pr,
      )
      return TICK
    }
    const old = entries.find((entry) => entry.superseded)
    if (old?.superseded) {
      await this.github.check(
        old.target,
        old.pr,
        old.superseded.head,
        { status: "completed", summary: "A newer candidate replaced this result." },
        old.superseded.checkId,
      )
      this.save({ ...old, superseded: undefined })
      return TICK
    }
    const notice = entries.find((entry) => entry.dirty)
    if (notice) {
      const target = this.github.mergeTarget(notice.target)
      const candidate = notice.candidate
      const eligible =
        notice.phase === "done" &&
        candidate &&
        (notice.outcome === "auto_merge" || (target && notice.outcome === "requires_approval"))
      let mergeBranchMatches = false
      if (eligible) {
        const latest = await this.github.snapshot(notice.target, notice.pr)
        mergeBranchMatches = latest.branch === target?.branch
        if (!sameSnapshot(notice, latest)) {
          this.replace(notice.target, notice.pr, latest)
          return TICK
        }
      }
      const needsApproval =
        target && eligible && mergeBranchMatches && notice.outcome === "requires_approval"
      const approved = Boolean(
        needsApproval &&
        candidate &&
        (await this.github.approved(target, candidate, notice.author)),
      )
      const checkId = await this.github.check(
        notice.target,
        notice.pr,
        notice.head,
        checkNotice(notice, approved),
        notice.checkId,
      )
      this.save({
        ...notice,
        checkId,
        dirty: false,
        mergePending: Boolean(
          target && eligible && mergeBranchMatches && (!needsApproval || approved),
        ),
        approvalPoll: needsApproval && !approved ? Date.now() + APPROVAL_POLL : undefined,
      })
      return TICK
    }
    const pending = entries.find((entry) => entry.mergePending)
    if (pending?.candidate && pending.checkId) {
      const target = this.github.mergeTarget(pending.target)
      if (target) {
        if (
          pending.outcome === "requires_approval" &&
          !(await this.github.approved(target, pending.candidate, pending.author))
        ) {
          this.save({ ...pending, dirty: true, mergePending: false })
          return TICK
        }
        try {
          await this.github.squash(pending.target, target, pending.candidate, pending.checkId)
        } catch (error) {
          if (!(error instanceof GithubError) || ![405, 409, 422].includes(error.status))
            throw error
        }
      }
      this.save({ ...pending, mergePending: false })
      return TICK
    }
    const approval = entries.find((entry) => entry.approvalPoll && entry.approvalPoll <= Date.now())
    if (approval) {
      this.save({ ...approval, dirty: true, approvalPoll: undefined })
      return TICK
    }
    const ready = entries.find((entry) => entry.active && entry.active.poll <= Date.now())
    if (ready?.active) {
      await this.active(ready, ready.active)
      return TICK
    }
    if (this.ctx.storage.transactionSync(() => this.promote(entries))) return TICK
    const polls = entries.flatMap((entry) =>
      [entry.active?.poll, entry.approvalPoll].filter((time) => time !== undefined),
    )
    return polls.length ? Math.min(...polls) - Date.now() : null
  }

  override alarm() {
    return this.runSerial(async () => {
      await this.ctx.storage.setAlarm(Date.now() + POLL)
      const delay = await this.tick()
      if (delay === null) await this.ctx.storage.deleteAlarm()
      else await this.wake(delay)
    })
  }
}
