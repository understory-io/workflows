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

- **`tests-passed`** - One check to require on every PR: waits for every other check on the PR head commit and passes only if they all passed (see below)
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
- Only the newest run of each check counts, so a re-run that passes replaces the failure. The gate doesn't re-run itself, though: after re-running a failed check, re-run `tests-passed` too.
- Dependabot's read-only token is enough; the gate only reads.

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
