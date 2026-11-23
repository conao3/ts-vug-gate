import * as z from "zod"

z.config({ jitless: true })

export const oid = z.string().regex(/^[0-9a-f]{40}$/)
export const digest = z.string().regex(/^[0-9a-f]{64}$/)
export const id = z.number().int().positive()
export const repoName = z.string().regex(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/)
export const targetSchema = z.object({
  repo: repoName,
  repo_id: id,
  installation_id: id,
})
export const targetsSchema = z.array(targetSchema).min(1)
export type Target = z.infer<typeof targetSchema>

export const candidateSchema = z.strictObject({
  repo: repoName,
  repo_id: id,
  pr: id,
  base_sha: oid,
  head_sha: oid,
  tree_oid: oid,
  policy_digest: digest,
})
export type Candidate = z.infer<typeof candidateSchema>

export const dispatchSchema = candidateSchema.extend({ id: z.uuid() })
export type Dispatch = z.infer<typeof dispatchSchema>

export const decisionSchema = z.enum(["auto_merge", "reject", "requires_approval", "incomplete"])
export type Decision = z.infer<typeof decisionSchema>

export const reportSchema = z.strictObject({ candidate: dispatchSchema, decision: decisionSchema })
export type Report = z.infer<typeof reportSchema>

export type Env = {
  QUEUE: DurableObjectNamespace
  GITHUB_APP_ID: string
  GITHUB_APP_PRIVATE_KEY: string
  GITHUB_WEBHOOK_SECRET: string
  GITHUB_ACTIONS_TOKEN: string
  MERGE_APP_ID?: string
  MERGE_APP_PRIVATE_KEY?: string
  MERGE_INSTALLATION?: string
  MANAGEMENT_REPO: string
  MANAGEMENT_REF: string
  MANAGEMENT_SHA: string
  MANAGEMENT_REPOSITORY_ID: string
  POLICY_DIGEST: string
  TARGETS: string
  RUNNING_PER_AUTHOR: string
  WAITING_PER_AUTHOR: string
  RUNNING_TOTAL: string
}

export function sameCandidate(left: Candidate, right: Candidate) {
  return (
    left.repo_id === right.repo_id &&
    left.repo === right.repo &&
    left.pr === right.pr &&
    left.base_sha === right.base_sha &&
    left.head_sha === right.head_sha &&
    left.tree_oid === right.tree_oid &&
    left.policy_digest === right.policy_digest
  )
}

export function targets(env: Env) {
  return targetsSchema.parse(JSON.parse(env.TARGETS))
}
