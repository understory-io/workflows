# Understory Workflows

Shared GitHub Actions and reusable workflows for the Understory organization.

## Overview

This repository provides centralized, reusable CI/CD components that can be called from any repository in the Understory organization. It helps maintain consistency and reduces duplication across projects.

## Quick Start

### Using a Reusable Workflow

```yaml
jobs:
  build-and-deploy:
    uses: understory-io/workflows/.github/workflows/lambda-ecr.yml@main
    with:
      ecr_repository_name: my-service
      image_tag_prefix: prod-
      artifacts_name: build-artifacts
    secrets:
      aws_access_key_id: ${{ secrets.AWS_ACCESS_KEY_ID }}
      aws_secret_access_key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      aws_region: ${{ secrets.AWS_REGION }}
```

### Using a Composite Action

```yaml
steps:
  - uses: understory-io/workflows/.github/actions/docker-build@main
    with:
      image_tag_prefix: dev-
      app_path: ./src
      ecr_repository_name: my-app
      # ... AWS credentials
```

## Available Components

### 🔧 Composite Actions

| Action          | Purpose                                       | Key Features                                                     |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `docker-build`  | Build and push Docker images to ECR           | Multi-platform support, automatic tagging                        |
| `lambda-deploy` | Deploy Docker images to Lambda                | Environment-aware, automatic role assumption                     |
| `image-exists`  | Refuse a release whose image was never pushed | Outputs the digest; works with any registry you are logged in to |

### 📦 Reusable Workflows

#### Build & Deploy

- **`lambda-ecr`** - Build and push Lambda Docker images
- **`lambda-netcore-ecr`** - Build and push .NET Core Lambda images
- **`glue`** - Deploy AWS Glue services

#### Libraries

- **`ci-go-library`** - CI pipeline for Go libraries
- **`ci-go-library-mise`** - CI pipeline for Go libraries (Mise-based)
- **`ci-go-mise-lambda`** - Build/test/package for mise-based Go Lambda services
- **`build-netcore-library`** - Build .NET Core libraries
- **`build-deploy-netcore-library`** - Build and deploy .NET libraries

#### Infrastructure

- **`terraform`** - Plan on PRs with the result commented back, apply on push. With `semgrep: true` it also lints the PR diff against the shared rules in [`semgrep/terraform.yml`](semgrep/terraform.yml) plus the calling repo's `.semgrep.yml`, if any.

### Contract breaking changes

`contracts-breaking` fails a PR that breaks a contract other services consume. It publishes nothing and needs no secrets.

- **Buf:** finds every `buf.yaml` / `buf.work.yaml` (skipping any path with a `generated`, `gen`, `vendor`, `node_modules`, `dist` or `target` directory) and runs `buf breaking <module> --against .git#ref=<base commit>,subdir=<module>`, with each module's own `breaking:` rules. Only modules the PR touches are checked. `buf` reads the PR's own `buf.yaml`, so a PR that changes it gets a note in the summary to check the `breaking:` rules. A moved module shows as removed plus new.
- **OpenAPI:** runs `oasdiff breaking` for each spec in `openapi_specs`, failing on ERR-level changes.
- **Summary:** every contract and its result goes in the job summary. A repo with no contracts, or a PR that touches none, passes.
- **Intentional breaks:** a PR labelled `breaking-change-approved` gets its breaking changes as warnings. Use it only for a step of expand, migrate, contract. Anyone who can label a PR can approve their own break, so a reviewer should check why the label is there. Labelling after the run needs a re-run of the job.

Call it from a workflow of its own, on `pull_request` with no `branches` or `paths` filter, and keep the job named `contracts`:

```yaml
name: Contracts
on:
  pull_request:

permissions:
  contents: read
  pull-requests: read

jobs:
  contracts:
    uses: understory-io/workflows/.github/workflows/contracts-breaking.yml@main
    # All inputs are optional. Paths are relative to the repo root, one per line.
    with:
      # Proto roots without a buf.yaml, such as the directory a fungus event port ships:
      buf_modules: |
        apps/my-service/internal/events/proto
      # Copies of another service's contract that this repo only consumes:
      buf_exclude: |
        apps/my-service/internal/client-copy
      openapi_specs: |
        openapi/my_spec.yml
```

### 🔍 Shared Semgrep rules

[`semgrep/terraform.yml`](semgrep/terraform.yml) holds Terraform lint rules every infrastructure repo gets through the `terraform` workflow. Fixtures sit beside it in `semgrep/terraform.tf`; add a `# ruleid:` and an `# ok:` case for every rule and run:

```bash
semgrep --test semgrep/
```

To run the shared rules from a laptop, in any Terraform repo:

```bash
semgrep scan --config https://raw.githubusercontent.com/understory-io/workflows/main/semgrep/terraform.yml
```

CI fetches the rules at the exact commit of the workflow the caller resolved, and scans only what the PR changed (`--baseline-commit`), so existing findings do not fail a PR that did not touch them. Leave out `--baseline-commit`, as above, to see the whole backlog.

#### Testing & Quality

- **`contracts-breaking`** - Fail a PR that breaks a Buf or OpenAPI contract, compared with its base ([how to call it](#contract-breaking-changes))
- **`tests-passed`** - One check to require on every PR: waits for every other check on the PR head commit and passes only if they all passed (see below)
- **`ai-review`** - An AI reviewer comments on every PR: invariants, existing data, blast radius, proving tests (see below)
- **`poeditor-check`** - Validate translations
- **`crowdin-pull-translations`** - Pull Crowdin translations and open a PR

#### Release Management

- **`create-deployment-prs`** - Auto-update release PRs
- **`publish-releases`** - Publish releases
- **`release-drafter-go`** - Draft Go releases

#### Utilities

- **`repo-data`** - Extract repository metadata

### ✅ `tests-passed`: one required check for every PR

Most service workflows are path-filtered, and a required check from a workflow that didn't run stays "Expected" forever. `tests-passed` runs on every PR instead and watches the head commit: every other check run and commit status (Vercel included). It passes when all of them succeeded, were neutral or skipped. It fails when any failed, was cancelled, timed out or needs action, or when a workflow couldn't start. The job summary lists every check and its result.

Add this file to a repo as `.github/workflows/tests-passed.yml`. Keep it a workflow of its own: the gate leaves out every check of the workflow that calls it.

```yaml
name: tests-passed

# No branches or paths filter: stacked PRs and PRs that touch no app need the gate too.
on:
  pull_request:

concurrency:
  group: tests-passed-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  actions: read
  checks: read
  statuses: read

jobs:
  tests-passed:
    uses: understory-io/workflows/.github/workflows/tests-passed.yml@main
    # with:
    #   ignore: |          # one name or regular expression per line
    #     RM E2E smoke (dev)
    #   timeout_minutes: 45
```

The check to require in the ruleset is **`tests-passed / tests-passed`** (GitHub Actions). Keep the caller's job id `tests-passed`, or the name changes.

- The result is final once nothing has been running or appeared for `settle_seconds` (default 60), so a PR with nothing else to run passes in about a minute.
- After `timeout_minutes` (default 45) it fails and names what is still running.
- Only the newest run of each check counts, so a re-run that passes replaces the failure. The result is fixed once the gate finishes, though: after re-running a check, re-run `tests-passed` too, in either direction.
- `ignore` lines also match as regular expressions against the whole name, so `.` matches any character; a bare job name such as `build` ignores it in every workflow. A deploy job that waits for an environment approval belongs here, or the gate times out.
- A PR can edit its own copy of this file. When it becomes required, protect `.github/workflows/tests-passed.yml` with CODEOWNERS.
- Dependabot's read-only token is enough; the gate only reads.

### 🤖 `ai-review`: an adversarial AI reader for every PR

A fresh Claude reads the PR's diff, plus the Linear issue named in its branch or title, and answers four questions: which invariant changes, which existing data it meets (stored rows, events, older clients), the blast radius, and which test proves it. It posts one PR comment, updated on each push, with a severity per finding.

Add this file to a repo as `.github/workflows/ai-review.yml`:

```yaml
name: AI review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  ai-review:
    uses: understory-io/workflows/.github/workflows/ai-review.yml@main
    secrets:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      linear_api_key: ${{ secrets.LINEAR_API_KEY }}
    # with:
    #   blocking: true     # fail on a high finding; leave off until calibrated
    #   max_diff_kb: 120
```

- **Advisory by default.** Nothing in it fails unless `blocking: true`, and then only the `Report` job: on a high finding, or on a diff over `max_diff_kb` (so growing a PR can't turn a red review green). A review that can't finish says so in the comment and passes.
- **One comment, always about the head.** When a newer commit isn't reviewed (skipped, too big, couldn't run), the comment is replaced by "commit … not reviewed" and the reason, so an older review never stands as current. A PR that was never reviewed gets no comment.
- **Skips with a notice, never red:** no `ANTHROPIC_API_KEY` (also on fork PRs), drafts, bots (Renovate, Dependabot, Crowdin's `understory-services`), a diff over `max_diff_kb`. Deleted, lock and generated files (`linguist-generated` in the base branch's `.gitattributes`) are listed by name and don't count towards the limit. Every diff reads `.gitattributes` from the base, so a PR's own `-diff` or `binary` can't hide its code.
- **Linear:** the issue key comes from the branch or title; issues of private teams are never read.
- **Cost:** each review stops at `max_turns` (40) and `max_budget_usd` ($3), about $0.50 in calibration. A new push cancels the review still running, and a review after a push waits 90 s first, so a burst of pushes is reviewed once. Set a monthly spend limit on the Anthropic workspace that owns the key.
- **Time:** `timeout_minutes` (25, at least 15) bounds the job. Claude Code stops 4 minutes before it, so the comment always says what happened. `tests-passed` waits for it, so keep the gate's own timeout above that.
- **Safety:** call it from `pull_request`, never `pull_request_target`. Claude Code runs with Read, Grep and Glob only, confined to the checkout, and gets no token but its own key. A separate job with no key posts the comment.

## Environment Conventions

### Tag Prefixes

- `prod-` → Production environment
- `dev-` → Development environment

### AWS Accounts

- **Production**: 189949407637
- **Development**: 115578597962

## Required Secrets

Most workflows require these organization secrets:

- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_REGION` - AWS region (e.g., us-east-1)

Additional secrets for specific workflows:

- `GO_PRIVATE_MODULES_PAT` - GitHub PAT for private Go modules
- `TF_API_TOKEN` - Terraform Cloud token

## Contributing

1. Create a feature branch
2. Make your changes
3. Test thoroughly (changes affect many repos!)
4. Update documentation
5. Submit a PR
