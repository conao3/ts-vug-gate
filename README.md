# vug gate

vug gate runs the merge-policy checks for package pull requests and publishes `vug/merge-policy` on the inspected head SHA. A GitHub App delivers events to a Cloudflare Worker. The Worker reads the pull request and Git objects through the GitHub API and dispatches the managed workflow.

## Development

```sh
nix develop
pnpm install --frozen-lockfile
vp run check
pnpm exec wrangler deploy --dry-run --outdir dist
```

On NixOS, run `steam-run vp run check` in the development shell for the upstream workerd and TypeScript lint binaries. The Cloudflare Vitest plugin runs the tests with workerd and local Durable Object storage. `nix run .` starts a local Worker from the Nix package. GitHub must be available and authenticated to dispatch the managed workflow manually.

## Queue and result identity

One SQLite-backed Durable Object coordinates the configured repositories and owns the author and global limits. SQLite-backed Durable Objects and their alarms are available on Workers Free. The single object can update PR records and reserve slots in the same transaction and resume dispatch, cancellation, and check publication after eviction. The defaults are one running and one waiting pull request per author ID and one running pull request globally. A deferred pull request gets a failed check with the deferral reason and becomes eligible when that author's waiting slot opens.

The Worker keys a pull request by repository ID and number. It reserves an execution UUID before dispatch and associates the GitHub run ID with the repository, PR, base, head, tree, and policy digest. After a head or base change, it cancels the old run and waits for completion before dispatching the replacement in the same slot. After an ambiguous dispatch response it looks up the execution UUID in the managed workflow's runs. The slot stays reserved until GitHub exposes the run or an operator can establish that the dispatch failed. GitHub webhook delivery failures can be redelivered from the app's advanced settings.

The callback job uses GitHub Actions OIDC. The Worker validates the issuer, audience, repository ID, workflow and commit, event, run ID, and first attempt, then checks the candidate against the active execution. The Worker reads GitHub again before publishing a successful check. Every published conclusion other than `auto_merge` fails the check. A workflow rerun has a different OIDC attempt. To reconsider a completed candidate after an infrastructure failure, close and reopen its pull request.

Workers Free allows 100,000 Worker requests per day, 10 ms of Worker CPU per invocation and 50 subrequests per invocation. Durable Objects Free allows 100,000 requests and 13,000 GB-s per day. SQLite storage allows 5 million rows read and 100,000 rows written per day and 5 GB total. Polling and refreshing pull requests consume those allowances. Monitor both the Worker and Durable Objects metrics during the sandbox trial. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) · [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Managed workflow

The workflow fetches Git objects into a bare repository. The inspection script reads changed modes and blobs by object ID and materializes package records, services, systems, and the seed into temporary directories. The workflow and policy come from the managed repository. The candidate must contain the supplied base. The workflow fixes vug and the package-builds script by commit and verifies the build script and seed digests.

The inspection job runs `vug record check-tree`, `vug record verify-provenance`, and the scope decision. On an eligible candidate, separate GitHub-hosted jobs build and test changed packages and their reverse dependencies, and rebuild the changed packages in an independent store. The jobs require enabled tests with an empty skip list and read output IDs from the vug store index. The decision job calls `vug record decide-merge` with the inspection and build results. Only the callback job can request OIDC.

The provenance file contains the initial allowlist for the which and unibilium smoke runs. Expand it with reviewed source and patch origins before enabling additional packages. A plan over 12 packages or a changed historical version yields an incomplete check. The inspection job writes provenance-checked candidate sources and patches to the `verified-inputs` artifact, along with the fixed seed and the transitive build inputs verified against the base commit. Its manifest records the candidate identity and each input's package, version, SHA-256 and supplying commit. The primary and repeat jobs download the same artifact and run the build step in a network namespace. vug reads the SHA-256-named inputs from the artifact and rejects missing or corrupt files before building.

To run a smoke check, substitute an already-merged package commit and its parent. This mode produces the decision in the run logs and skips the callback.

```sh
gh workflow run merge-policy.yml -f candidate='{"repo":"<OWNER>/<REPO>","base_sha":"<PARENT_SHA>","head_sha":"<COMMIT_SHA>"}'
```

## Registration and deployment

1. Select the sandbox repository for the first installation. Replace `<APP_HOME_URL>` and `<WEBHOOK_URL>` in a local copy of `github-app.manifest.json`. The webhook path is `/webhook`. Register the app from the manifest, retain its private key and webhook secret, and install it on the sandbox repository.
2. Create a fine-grained GitHub token with Actions write access to the managed repository only. Set the managed repository secret `VUG_RESULT_URL` to the Worker URL with the `/result` path.
3. Set the following runtime bindings in a local Wrangler config used for deploy. Keep the Worker account ID in the environment variable `CLOUDFLARE_ACCOUNT_ID`. Use an authenticated Wrangler session or provide `CLOUDFLARE_API_TOKEN` in that environment.

| Worker binding                                              | Value                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `MANAGEMENT_REPO`                                           | Managed repository in owner/repository form                                         |
| `MANAGEMENT_REPOSITORY_ID`                                  | Managed GitHub repository numeric ID as a string                                    |
| `MANAGEMENT_REF`                                            | Managed workflow branch, such as `master`                                           |
| `MANAGEMENT_SHA`                                            | Full commit SHA of that branch at deployment                                        |
| `POLICY_DIGEST`                                             | SHA-256 of `policy/provenance.json` at that commit                                  |
| `TARGETS`                                                   | JSON array of objects with `repo`, numeric `repo_id`, and numeric `installation_id` |
| `RUNNING_PER_AUTHOR`, `WAITING_PER_AUTHOR`, `RUNNING_TOTAL` | The queue limits in `wrangler.jsonc`                                                |

4. The local secret JSON holds `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and `GITHUB_ACTIONS_TOKEN`. Deploy with `pnpm exec wrangler deploy --config <LOCAL_CONFIG> --secrets-file <LOCAL_SECRET_JSON>`. Recompute the workflow SHA and policy digest when promoting a new managed workflow revision.
5. Confirm GitHub's ping delivery, then use the sandbox acceptance procedure before configuring a production target.

## Sandbox acceptance

1. From a fork of the sandbox, open a PR editing only the hello version record within the record-change policy, such as adding an allowed configure flag. Confirm the app's check on that head succeeds only after the managed run succeeds.
2. Open a PR that also modifies a candidate `.github/workflows/` file. Confirm the managed decision rejects it or requires approval and the app's check fails. A passing run from the PR's own workflow is independent of the app's check.
3. For a running PR, push a second head or advance the base. Confirm the old managed run is cancelled and a new run starts in its slot. Observe the exact head SHA on the check and confirm only a run for the current candidate can publish success.
4. Open three PRs by one author and one by another author. With the default limits, check for one running and one waiting from the first author and a deferral on the third. Verify even after webhook redelivery and Durable Object eviction that there is at most one managed run and the author still has only one waiting slot. Check the transition from deferred to waiting when the slot opens.
