# CLAUDE.md - Comprehensive Repository Documentation

This document provides comprehensive documentation about the Understory Workflows repository for AI assistants (particularly Claude) to understand the repository structure, purposes, and how to work with it effectively.

## Repository Purpose

This repository contains **shared GitHub Actions actions and workflows** used across the Understory organization. It serves as a central location for reusable CI/CD components that can be called from other repositories.

## Repository Structure

```
.github/
├── actions/           # Reusable composite actions
│   ├── docker-build/  # Docker image building and pushing to ECR
│   ├── image-exists/  # Fail unless an image reference resolves
│   ├── lambda-deploy/ # Lambda function deployment
│   └── test-report/   # Test results as job summary, check run and PR comment
└── workflows/         # Reusable workflows
dash0/
└── tests/             # Dash0 "Tests" dashboard over test-report's and the E2E reporters' spans, applied by hand (README.md)
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

### 3. image-exists (`/.github/actions/image-exists/action.yml`)

**Purpose**: Fail unless an image reference resolves in its registry, before a release names it. Deploy tools that only rewrite a tag (Forest's `pin_image` provider) cannot tell a pushed image from a typo or a cancelled build, and ECS then retries the pull indefinitely.

**Inputs**: `image` (required, full reference), `attempts` (optional, default 3, linear 5 s backoff).

**Output**: `digest` (`sha256:…`), also written to the step summary.

**Credentials**: none of its own. For a private registry put `docker/login-action` before it (for GHCR the job needs `packages: read`). An auth failure is refused the same as a missing image.

**Test**: `image-exists.yml` (this repo's own CI) checks that a present public image yields a digest and a never-pushed tag is refused.

### 4. test-report (`/.github/actions/test-report/action.yml`)

**Purpose**: Show test results on every run: a job summary (counts, each failure's output, slowest tests), a check run with an annotation on each failure's line, and one PR comment per `title` that each run updates. Uploads the JUnit files as an artifact. All in `report.py` (stdlib Python); it takes JUnit files, or converts a `go test -v` log with go-junit-report v2.1.0 first.

**Secrets**: raw test output goes only into the job summary, which the runner masks like the log. The check run, its annotations and the PR comment go through the API, which masks nothing, so they carry test name, package, `file:line` and a link to the job, never output. Keep it that way: the test environment holds tokens (`MISE_GITHUB_TOKEN`, the private-modules PAT in `~/.gitconfig`).

**Inputs**: `title` (required; names the check and identifies the comment, so unique per PR), `go-test-log` (a `go test -v` log; lines of parallel mise tasks, prefixed `[task] `, are split per task before conversion) or `junit-path` (newline-separated globs), `artifact-name` (default `test-results`, unique per run), `go-module-dir` (puts each Go failure on the `_test.go` line it reports), `test-outcome` (`steps.<id>.outcome` of the test step), `token` (default `github.token`).

**Comment states**: the comment shows the head commit and the test step's outcome. A run with a report creates or updates it. A run without one (tests never ran, output not readable, results that contradict `test-outcome`) only updates an existing comment, to say so for that commit, so a green comment never outlives a red head. A run for a commit that is no longer the PR's head never touches the comment, so runs that finish out of order can't put an old result back. Results that contradict `test-outcome` stay in the summary.

**JUnit from other runners** (vitest, `junit-path`): a failure is annotated and linked at its line when the class names a test file that exists and the failure prints it as `file:line:column`. The class is read relative to a directory above the JUnit file (the project root in a monorepo, so keep the file under the project) and then to the repository root. Failures without such a line are listed without a location. Used by storefront and backoffice.

**Counting**: Go subtests count, their parents don't, unless the parent failed on its own. Output that go-junit-report can't attribute (gotestsum's own formats leave the package empty) gives no report rather than wrong numbers. Without `go test -v` only failed tests are listed, and the summary says so.

**Never fails the build**: it ignores test failures. A 403 on the check or the comment (Dependabot, or a caller that narrowed `permissions:`) becomes a note in the summary, and the failures are annotated through log commands instead (masked, at most 10). Callers still put `continue-on-error: true` on the step.

**Used by**: `ci-go-mise-lambda.yml` and `ci-go-library-mise.yml`, which tee `mise test` into `$RUNNER_TEMP/go-test.log` and pass it as `go-test-log`. They check the action out from `job.workflow_repository@job.workflow_sha` into `.understory-workflows/` (like terraform.yml's semgrep rules) rather than `uses: …@main`: callers get the action that matches the workflow they pinned, and a failed checkout fails one `continue-on-error` step instead of the job's setup. The report steps run on `!cancelled()`, also when the tests never ran, so the comment can say so.

**Dash0 export** (`otlp.py`, inputs `otlp-endpoint` and `otlp-headers`): when both are set, one trace per report goes to Dash0 over OTLP/HTTP JSON (stdlib, gzip): a root span named after `title`, and a span per counted test (Go subtests, not their parents). Resource: `service.name` = `<repo>-tests`, `service.namespace` = `understory`, `test.suite` = `title`, `github.repository`, `github.branch` (head ref on PRs), `github.sha`, `github.pr_number`, `github.event_name`, `github.workflow`, `github.job`, `github.run_id`, `github.run_attempt`, `github.run_url`. Span: `test.name`, `test.full_name`, `test.package`, `test.file`/`test.line` (failures with a location), `test.outcome` (`expected`/`unexpected`/`skipped`, Playwright's words), `test.status`, `test.duration_ms`, `test.is_flaky` (false), `test.retries` (0). These keys match storefront's and backoffice's Playwright reporters, so one dashboard over `dash0.spans` covers all suites; there is deliberately no metric, as `dash0.spans` counts exactly and per-test metric labels would be thousands of series. Never test output (same reason as the check run). Takes the gRPC endpoint (`DASH0_OTLP_ENDPOINT_GRPC`, what callers pass) and posts to the same host on 443. Bounded: `timeout 60`, 45 s for all requests, at most 20,000 tests (failures always sent), `continue-on-error`. Without the inputs, or on any error, it writes one line in the summary (a warning on error) and nothing else. Results that disagree with `test-outcome` aren't sent. The reusable Go workflows take optional secrets `dash0_otlp_endpoint`/`dash0_otlp_headers` (`dash0-otlp-*` in the library one); callers must pass them explicitly, as reusable workflows never see the caller's secrets. Test: `test-report-selftest.yml` runs `test/test_otlp.py` against a local OTLP server, and runs the action itself on `test/fixtures/junit.xml` against `test/otlp_collector.py`. Errors show only a status code, a connection error's reason or the script's own message, never a header value; headers with a line break are refused (http.client's own error quotes the value, which the runner's per-line masking misses).

**Permissions**: neither workflow declares `permissions:`. A called job that asks for more than its caller grants makes the caller's whole run fail to start (`startup_failure`), so declaring `checks: write` there would break any caller that narrowed its token. Callers on a read-only default token that want the check and comment grant `contents: read`, `checks: write`, `pull-requests: write` on the calling job.

## GitHub Workflows (Reusable Workflows)

### Infrastructure & Deployment Workflows

#### 1. lambda-ecr (`lambda-ecr.yml`)

- **Purpose**: Build and push Docker images for Lambda functions
- **Trigger**: `workflow_call`
- **Architecture Support**: ARM64 and x86_64
- **Uses**: `docker-build` action internally

#### 2. lambda-netcore-ecr (`lambda-netcore-ecr.yml`)

- **Purpose**: Build and deploy .NET Core Lambda functions
- **Similar to**: lambda-ecr but for .NET Core

#### 3. glue (`glue.yml`)

- **Purpose**: Build and deploy AWS Glue Lambda services
- **Trigger**: `workflow_call`

### Library & Application Build Workflows

#### 4. build-netcore-library (`build-netcore-library.yml`)

- **Purpose**: Build .NET Core libraries
- **Trigger**: `workflow_call`

#### 5. build-deploy-netcore-library (`build-deploy-netcore-library.yml`)

- **Purpose**: Build and deploy .NET Core libraries
- **Trigger**: `workflow_call`

#### 6. ci-go-library (`ci-go-library.yml`)

- **Purpose**: CI pipeline for Go libraries
- **Features**:
  - Private Go modules access setup
  - Go cache management (with date-based keys)
  - Module download verification with `-x` flag
  - Read-only module mode (`-mod=readonly`) to prevent re-downloads
  - Build and test execution via Makefile
  - AWS credentials provided for testing

#### 7. ci-go-library-mise (`ci-go-library-mise.yml`)

- **Purpose**: CI pipeline for Go libraries (Mise-based toolchain)
- **Trigger**: `workflow_call`
- **What it does**: checkout → Setup Go (`go-version-file: go.mod`, ahead of mise so mise's `go:`-backend tool resolution never runs against the runner's older baked-in Go) → private Go module config → Mise install → Go cache restore → `go mod download && go mod tidy` → LocalStack cache/load (optional) → `mise run test` (output teed into the `test-report` action, title `Go tests`, artifact `go-test-results`) → `mise run build` → Go cache save (main only)

### Testing & Quality Workflows

#### 8. poeditor-check (`poeditor-check.yml`)

- **Purpose**: Verify all POEditor terms are translated
- **Use Case**: Internationalization validation
- **Optional Inputs**:
  - `ignore_languages`: Pipe-separated POEditor language names to leave out of the
    check (e.g. `French|Polish`), for languages the project tracks but does not ship

#### 9. crowdin-pull-translations (`crowdin-pull-translations.yml`)

- **Purpose**: Pull translations from Crowdin and open a PR
- **Trigger**: `workflow_call`

#### 9b. tests-passed (`tests-passed.yml`)

- **Purpose**: one check (`tests-passed / tests-passed`) a ruleset can require on every PR, since path-filtered workflows leave their own required checks pending forever. Caller template in README.md: `on: pull_request` with no filters, `concurrency` per PR, `actions: read`, `checks: read`, `statuses: read`.
- **Trigger**: `workflow_call`
- **Inputs**: `ignore` (newline list; a line matches a check whose name equals it or fully matches it as a regex, or `<workflow name> / <check name>`), `timeout_minutes` (45), `settle_seconds` (60), `poll_seconds` (30), `sha` (default PR head), `runner` (`ubuntu-24.04-arm`)
- **How it decides**: one `actions/github-script` step polls workflow runs, check runs (`filter: all`) and commit statuses for the head SHA. It drops every run of its own workflow (the caller file must hold only the gate). Like GitHub's required checks, the newest check run of a name counts, per workflow and event, so a later run that skips a job doesn't hide an earlier failure; within a run, same-named check runs collapse only on a re-run attempt (`run_attempt > 1`). Statuses: newest per context. success/neutral/skipped pass; anything else completed fails. The newest run per workflow and event also counts: pending while it has no jobs, failed if it ended badly without a failed check (`startup_failure` leaves no check run). A failed poll resets the settle timer; 403 (not rate limit), 404 and 422 fail at once, 10 failed polls in a row fail. The result is final after `settle_seconds` with nothing running and nothing new.
- **Timeout**: the job's `timeout-minutes` is `timeout_minutes`; the script stops 90 s earlier to fail with the list of what is still running (no arithmetic in expressions).
- **Test**: `tests-passed-selftest.yml` runs `test/tests-passed.mjs`, which cuts the script out of the YAML (by its 12-space indent) and runs it against a mocked API and a fake clock (27 scenarios; add one per behaviour change). Keep the script at that indent.

### Release Management Workflows

#### 10. create-deployment-prs (`create-deployment-prs.yml`)

- **Purpose**: Automatically update release pull requests
- **Trigger**: `workflow_call`
- **Key Inputs**: `promotionPairs` (required), `prepare_command` (optional), `record_target_ancestry` (optional)
- **Note**: `prepare_command` runs a mise task after the branch is reset to the source branch and before the PR is created, so anything it writes is committed with the promotion. Used by `whatsapp-templates` to generate its consumer API only on a commit that has passed the approval gate.
- **Note**: `record_target_ancestry` merges the target into the promotion branch with `--strategy=ours` right after the reset, giving the promotion head the target as a parent without changing its tree. Without it the merge base is the previous promotion, so whatever `prepare_command` generated last cycle conflicts add/add with this cycle's. Off by default, because `--strategy=ours` would revert a hotfix committed straight to the target. The checkout is unconditionally full-depth: at depth 1 the merge sees unrelated histories.

#### 11. publish-releases (`publish-releases.yml`)

- **Purpose**: Publish releases (details not provided in name)
- **Trigger**: `workflow_call`

#### 12. release-drafter-go (`release-drafter-go.yml`)

- **Purpose**: Draft releases for Go projects
- **Trigger**: `workflow_call`

#### 13. ci-go-mise-lambda (`ci-go-mise-lambda.yml`)

- **Purpose**: Shared build/test/package job for mise-based Go Lambda services
- **Trigger**: `workflow_call`
- **Replaces**: Duplicated `build` jobs in per-service workflows (bookings-core, experience-core, storefronts-core)
- **Key Inputs**:
  - `app_name` (required): artifact name, e.g. "bookings-core"
  - `app_dir` (required): path to the app, e.g. "apps/bookings-core"
  - `localstack_image` (optional, default: `localstack/localstack`): allows pinning a specific version
- **Key Secret**: `go_private_modules_pat`
- **What it does**: checkout → Setup Go (`go-version-file` from the app's own go.mod, ahead of mise so mise's `go:`-backend tool resolution never runs against the runner's older baked-in Go) → private Go module config → Mise install → Go cache restore → `go mod download -x` → LocalStack cache/load → `mise local:up` → `mise test` (output teed into the `test-report` action, title `Go tests (<app_name>)`, artifact `go-test-results-<app_name>`) → `mise build` → artifact upload → Go cache save (main only)
- **Cache key fix**: uses `hashFiles(format('{0}/go.mod', inputs.app_dir))` to correctly hash the subdirectory go.mod (nested `${{ }}` inside `hashFiles()` is not evaluated by GitHub Actions)

### Utility Workflows

#### 14. repo-data (`repo-data.yml`)

- **Purpose**: Extract and process repository metadata
- **Trigger**: `workflow_call`

#### 15. terraform (`terraform.yml`)

- **Purpose**: Plan on PRs with the result commented back, apply on push, for every infrastructure repo
- **Trigger**: `workflow_call`
- **Semgrep (`semgrep: true`)**: on pull requests only, checks out `semgrep/terraform.yml` from `${{ job.workflow_repository }}@${{ job.workflow_sha }}` (sparse, into `.understory-workflows/`; falls back to `understory-io/workflows@main` if the `job.workflow_*` context is empty; must stay ahead of the private-modules ssh rewrite) and scans with it plus the caller's `.semgrep.yml` when that file exists (next to `working_directory` first, then the repo root). Diff-scoped with `--baseline-commit origin/<base>`, so only new findings fail a PR. Rules repo is public: rule messages must not describe internal systems.
- **Rule tests**: `semgrep-rules.yml` (this repo's own CI, not `workflow_call`) runs `semgrep --test semgrep/` on PRs touching `semgrep/`, and fails if a rules file has no fixture beside it (`semgrep --test` alone passes that). Every rule needs `# ruleid:` and `# ok:` fixtures in `semgrep/terraform.tf`.
- **Blast radius**: `@main` is what every caller pins, so a change here reaches all semgrep-enabled repos on their next PR.

#### 16. contracts-breaking (`contracts-breaking.yml`)

- **Purpose**: Fail a PR that breaks a Buf module (`buf breaking`) or, optionally, an OpenAPI spec (`oasdiff breaking`) compared with the PR's base commit. Publishes nothing, needs no secrets (not the fungus registry either)
- **Trigger**: `workflow_call`, from a caller on `pull_request` with no branch or path filter. The caller job is named `contracts`
- **Inputs** (all optional): `buf_modules` (proto roots without a buf.yaml, e.g. a fungus event port's `sdk/proto`), `buf_exclude` (consumed copies of another service's contract), `openapi_specs`, `approval_label` (default `breaking-change-approved`), `timeout_minutes`
- **How**: discovers modules from `git ls-tree` at the head and the base (a deleted module counts as breaking), skips untouched ones, and diffs against the base commit `github.event.pull_request.base.sha` in the default merge checkout, so a base that moved on after the branch point causes no false breaks. buf is `bufbuild/buf-setup-action` pinned by SHA and `BUF_VERSION`; oasdiff is the release tarball pinned by version and sha256 (`OASDIFF_VERSION`, `OASDIFF_SHA256`)
- **Label**: read live from the API, so a re-run honours a label added after the run; falls back to the event payload. Breaking changes become warnings; a failure to run (build error, unreadable spec) always fails
- **Not a publisher**: do not add `fungus publish` here. fungus's own `contracts.yml` publishes unstable versions to the production registry per PR

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
- **Job Timeouts**: Every job sets `timeout-minutes` so a hung step fails fast instead of running to GitHub's 6h default. Values are sized at ~2-4x the observed p90/max run time (sampled from real org CI): trivial script/PR jobs 5 min; npm/NuGet/docker build jobs 10-20 min; Cypress/Terraform 30 min. Each workflow exposes an optional `timeout_minutes` input (`type: number`, default = the measured value) wired as `timeout-minutes: ${{ inputs.timeout_minutes }}`, so callers can override per-repo without changing the shared workflow. Only `inputs`/`vars` contexts are valid in that expression (not `secrets`). When adding a new workflow, add the input + timeout. Note: `timeout-minutes` cannot be set on a job that calls a reusable workflow via `uses:` (e.g. `build-deploy-netcore-library.yml`) — there the input is forwarded down to the leaf job inside the called workflow (`build-netcore-library.yml`).

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
