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

| Action          | Purpose                             | Key Features                                 |
| --------------- | ----------------------------------- | -------------------------------------------- |
| `docker-build`  | Build and push Docker images to ECR | Multi-platform support, automatic tagging    |
| `lambda-deploy` | Deploy Docker images to Lambda      | Environment-aware, automatic role assumption |

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

#### Testing & Quality

- **`poeditor-check`** - Validate translations
- **`crowdin-pull-translations`** - Pull Crowdin translations and open a PR

#### Release Management

- **`create-deployment-prs`** - Auto-update release PRs
- **`publish-releases`** - Publish releases
- **`release-drafter-go`** - Draft Go releases

#### Utilities

- **`repo-data`** - Extract repository metadata
- **`pixel-collector`** - Collect component/package usage metrics

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
