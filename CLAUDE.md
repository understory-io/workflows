# CLAUDE.md - Comprehensive Repository Documentation

This document provides comprehensive documentation about the Understory Workflows repository for AI assistants (particularly Claude) to understand the repository structure, purposes, and how to work with it effectively.

## Repository Purpose

This repository contains **shared GitHub Actions actions and workflows** used across the Understory organization. It serves as a central location for reusable CI/CD components that can be called from other repositories.

## Repository Structure

```
.github/
├── actions/           # Reusable composite actions
│   ├── docker-build/  # Docker image building and pushing to ECR
│   └── lambda-deploy/ # Lambda function deployment
└── workflows/         # Reusable workflows
```

## GitHub Actions (Composite Actions)

### 1. docker-build (`/.github/actions/docker-build/action.yml`)

**Purpose**: Build Docker images and push them to Amazon ECR (Elastic Container Registry).

**Key Features**:

- Optional SSH key support for accessing private repositories during build
- AWS credentials configuration and ECR login
- Docker Buildx setup for multi-platform builds
- Image tagging with SHA, run number, and latest tags
- Provenance disabled for compatibility

**Required Inputs**:

- `image_tag_prefix`: Tag prefix for the image (e.g., "prod-", "dev-")
- `app_path`: Path to the application directory containing the Dockerfile
- `ecr_repository_name`: Name of the ECR repository
- `aws_access_key_id`: AWS access key (secret)
- `aws_secret_access_key`: AWS secret key (secret)
- `aws_region`: AWS region

**Optional Inputs**:

- `ssh_key`: SSH key for accessing private repos (secret)
- `target`: Docker build target
- `platform`: Build platform (e.g., "linux/arm64", "linux/amd64")

**Output Tags**:

- `{registry}/{repo}:{github.sha}`
- `{registry}/{repo}:{prefix}{run_number}`
- `{registry}/{repo}:{prefix}latest`

### 2. lambda-deploy (`/.github/actions/lambda-deploy/action.yml`)

**Purpose**: Deploy Docker images to AWS Lambda functions.

**Key Features**:

- Environment-aware role assumption (prod vs non-prod)
- Checks if Lambda function exists before updating
- Automatic role switching based on image tag prefix

**Required Inputs**:

- `aws_function_name`: Name of the Lambda function
- `image_tag_prefix`: Tag prefix (determines environment)
- `ecr_repository_name`: ECR repository name
- `aws_access_key_id`: AWS access key (secret)
- `aws_secret_access_key`: AWS secret key (secret)
- `aws_region`: AWS region

**Environment Logic**:

- If `image_tag_prefix` is "prod-": Uses production role (account: 189949407637)
- Otherwise: Uses non-production role (account: 115578597962)

## GitHub Workflows (Reusable Workflows)

### Infrastructure & Deployment Workflows

#### 1. terraform (`terraform.yml`)

- **Purpose**: Run Terraform operations (format, init, validate, plan, apply)
- **Trigger**: `workflow_call`
- **Key Inputs**: `tf_workspace`, `tf_version`, `tf_apply` (boolean)
- **Features**: PR comments with plan output, conditional apply

#### 2. lambda-ecr (`lambda-ecr.yml`)

- **Purpose**: Build and push Docker images for Lambda functions
- **Trigger**: `workflow_call`
- **Architecture Support**: ARM64 and x86_64
- **Uses**: `docker-build` action internally

#### 3. lambda-netcore-ecr (`lambda-netcore-ecr.yml`)

- **Purpose**: Build and deploy .NET Core Lambda functions
- **Similar to**: lambda-ecr but for .NET Core

#### 4. glue (`glue.yml`)

- **Purpose**: Build and deploy AWS Glue Lambda services
- **Trigger**: `workflow_call`

### Library & Application Build Workflows

#### 5. build-netcore-library (`build-netcore-library.yml`)

- **Purpose**: Build .NET Core libraries
- **Trigger**: `workflow_call`

#### 6. build-deploy-netcore-library (`build-deploy-netcore-library.yml`)

- **Purpose**: Build and deploy .NET Core libraries
- **Trigger**: `workflow_call`

#### 7. ci-go-library (`ci-go-library.yml`)

- **Purpose**: CI pipeline for Go libraries
- **Features**:
  - Private Go modules access setup
  - Go cache management (with date-based keys)
  - Module download verification with `-x` flag
  - Read-only module mode (`-mod=readonly`) to prevent re-downloads
  - Build and test execution via Makefile
  - AWS credentials provided for testing

### Testing & Quality Workflows

#### 8. cypress (`cypress.yml`)

- **Purpose**: Run Cypress end-to-end tests
- **Trigger**: `workflow_call`

#### 9. poeditor-check (`poeditor-check.yml`)

- **Purpose**: Verify all POEditor terms are translated
- **Use Case**: Internationalization validation

### Release Management Workflows

#### 10. create-deployment-prs (`create-deployment-prs.yml`)

- **Purpose**: Automatically update release pull requests
- **Trigger**: `workflow_call`

#### 11. assign-reviewers (`assign-reviewers.yml`)

- **Purpose**: Auto-assign reviewers to release PRs
- **Trigger**: `workflow_call`

#### 12. publish-releases (`publish-releases.yml`)

- **Purpose**: Publish releases (details not provided in name)
- **Trigger**: `workflow_call`

#### 13. release-drafter-go (`release-drafter-go.yml`)

- **Purpose**: Draft releases for Go projects
- **Trigger**: `workflow_call`

### Utility Workflows

#### 14. setup-node-aws-env (`setup-node-aws-env.yml`)

- **Purpose**: Setup Node.js with AWS environment
- **Use Case**: Node.js projects requiring AWS integration

#### 15. repo-data (`repo-data.yml`)

- **Purpose**: Extract and process repository metadata
- **Trigger**: `workflow_call`

#### 16. collect-components-usage (`collect-components-usage.yml`)

- **Purpose**: Collect usage metrics for all packages
- **Alternative**: `pixel-collector.yml` (similar purpose)

## Usage Patterns

### Calling a Reusable Workflow

Repositories can use these workflows by referencing them:

```yaml
jobs:
  deploy:
    uses: understory-io/workflows/.github/workflows/lambda-ecr.yml@main
    with:
      ecr_repository_name: my-service
      aws_function_name: my-lambda
      image_tag_prefix: prod-
      artifacts_name: docker-artifacts
    secrets:
      aws_access_key_id: ${{ secrets.AWS_ACCESS_KEY_ID }}
      aws_secret_access_key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      aws_region: ${{ secrets.AWS_REGION }}
```

### Using Composite Actions

Actions can be used directly in workflow steps:

```yaml
steps:
  - uses: understory-io/workflows/.github/actions/docker-build@main
    with:
      image_tag_prefix: dev-
      app_path: ./
      ecr_repository_name: my-repo
      aws_access_key_id: ${{ secrets.AWS_ACCESS_KEY_ID }}
      aws_secret_access_key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      aws_region: us-east-1
```

## Environment Conventions

### Tag Prefixes

- `prod-`: Production environment
- `dev-`: Development environment

### AWS Account Structure

- Production: 189949407637
- Non-Production: 115578597962

### Common Secrets Required

- `aws_access_key_id`: AWS access credentials
- `aws_secret_access_key`: AWS secret credentials
- `aws_region`: Target AWS region
- `go-private-modules-pat`: GitHub PAT for private Go modules
- `tf_token`: Terraform Cloud API token

## Best Practices

1. **Version Pinning**: Always reference workflows with `@main` or specific tags
2. **Secret Management**: Pass secrets explicitly through the `secrets` context
3. **Artifact Handling**: Use artifact names consistently across jobs
4. **Architecture Specification**: Explicitly specify `architecture` for Lambda deployments
5. **Environment Separation**: Use appropriate tag prefixes to target correct environments

## Common Patterns

### Docker-based Lambda Deployment Pattern

1. Build application artifacts
2. Upload artifacts using `actions/upload-artifact`
3. Call `lambda-ecr.yml` workflow
4. Workflow downloads artifacts and builds Docker image
5. Image pushed to ECR with appropriate tags
6. Optional: Deploy to Lambda using `lambda-deploy` action

### Terraform Infrastructure Pattern

1. Format check
2. Initialize workspace
3. Validate configuration
4. Plan changes (on PR)
5. Apply changes (when `tf_apply: true`)

### Go Library CI Pattern

1. Checkout code
2. Setup private module access via PAT
3. Restore Go cache (date-based keys)
4. Setup Go environment
5. Download Go modules with verification (`go mod download -x`)
6. Build with read-only modules (`GOFLAGS="-mod=readonly" make build`)
7. Run tests with read-only modules (`GOFLAGS="-mod=readonly" make test`)
8. Trim and save Go cache (only on main branch)

#### Go Cache Strategy

The workflow implements an optimized Go caching strategy based on https://danp.net/posts/github-actions-go-cache/:

- **Cache Key**: Uses `nonexistent` to always miss, forcing restore from `restore-keys`
- **Restore Pattern**: `{OS}-go-{hash(go.mod)}-{date}` for date-based cache freshness
- **Cache Paths**:
  - `~/go/pkg/mod` - Downloaded Go modules
  - `~/.cache/go-build` - Build cache
- **Cache Trimming**: Removes files older than 90 minutes to keep cache lean
- **Save Pattern**: Only saves on main branch with date-based keys

**Performance Optimizations**:
- Module download with `-x` flag for visibility
- Read-only module mode prevents redundant downloads during build/test
- Date-based cache keys ensure fresh caches
- Cache trimming prevents bloat

## Maintenance Notes

- **Docker Buildx**: Always enabled for multi-platform support
- **Provenance**: Disabled in Docker builds for compatibility
- **SSH Agent**: Conditionally configured only when SSH key provided
- **Cache Strategy**: Go workflows use date-based cache keys
- **Role Duration**: Lambda deployments use 900-second role sessions

## Instructions for AI Assistants

When working with this repository:

1. **Understand Context**: This is a shared workflow repository - changes affect multiple projects
2. **Preserve Compatibility**: Maintain backward compatibility when modifying existing workflows
3. **Document Changes**: Update this CLAUDE.md file when adding new workflows or actions
4. **Test Carefully**: Changes here can break CI/CD across the organization
5. **Follow Patterns**: New workflows should follow established patterns for consistency
6. **Security First**: Never expose secrets in logs or commit sensitive data

### Task Documentation

This documentation was created based on the following instruction:
"Build up knowledge on this repository's contents. It contains shared GitHub Actions actions and workflows used across the organization. Document in a light human readable format in README.md and extensive for future claude usage in CLAUDE.md. Make sure to document this instruction itself as well."

The documentation process involved:

1. Analyzing 2 GitHub Actions (composite actions)
2. Analyzing 15 GitHub Workflows (reusable workflows)
3. Creating comprehensive CLAUDE.md documentation for AI assistants
4. Creating human-readable README.md documentation for developers
