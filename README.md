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

- **Buf:** finds every `buf.yaml` / `buf.work.yaml` (skipping `generated`, `gen`, `vendor`, `node_modules`) and runs `buf breaking <module> --against .git#ref=<base commit>,subdir=<module>`, with each module's own `breaking:` rules. Only modules the PR touches are checked.
- **OpenAPI:** runs `oasdiff breaking` for each spec in `openapi_specs`, failing on ERR-level changes.
- **Summary:** every contract and its result goes in the job summary. A repo with no contracts, or a PR that touches none, passes.
- **Intentional breaks:** a PR labelled `breaking-change-approved` gets its breaking changes as warnings. Use it only for a step of expand, migrate, contract. Labelling after the run needs a re-run of the job.

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
- **`poeditor-check`** - Validate translations
- **`crowdin-pull-translations`** - Pull Crowdin translations and open a PR

#### Release Management

- **`create-deployment-prs`** - Auto-update release PRs
- **`publish-releases`** - Publish releases
- **`release-drafter-go`** - Draft Go releases

#### Utilities

- **`repo-data`** - Extract repository metadata

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
