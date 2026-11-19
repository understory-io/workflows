# Tests dashboard in Dash0

`dashboard.yaml` shows pass rate, failures and flaky tests per repository and suite.
Its data is one span per test:

| Source | `service.name` | `test.suite` |
|---|---|---|
| test-report action, unit and acceptance tests in PR and main CI | `<repo>-tests` | the report's title, e.g. `Go tests (bookings-core)` |
| storefront Playwright reporter, `E2E (dev)` | `storefront-e2e` | `E2E (dev)` |
| backoffice Playwright reporter, `RM E2E (dev)` nightly | `rm-e2e` | `RM E2E (dev)` |
| backoffice Playwright reporter, smoke runs for a backend PR | `rm-e2e-smoke` | `RM E2E smoke (dev)`; `e2e.source.*` names the PR |

All of them use `service.namespace` `understory` and the same keys: `test.outcome`
(`expected`, `unexpected`, `flaky`, `skipped`), `test.full_name`, `github.branch`,
`github.sha`, `github.run_url`. The panels count spans with the `dash0.spans` metric,
which is exact; the E2E reporters' `e2e.test.result` counter isn't used.

## Apply

Nothing applies this automatically: the repository holds no Dash0 token. Apply it by
hand with the `dash0` CLI signed in to the organisation:

```bash
dash0 apply -f dash0/tests/ --dry-run   # validates the document, changes nothing
dash0 apply -f dash0/tests/             # creates or updates
```

Or import `dashboard.yaml` in Dash0 under Dashboards.

On create, Dash0 assigns its own id, kept in the file as `metadata.dash0Extensions.id`
so the next apply updates that dashboard instead of creating a second one (first
applied 2026-11-19, dashboard `2b05958c-c55c-4164-af2b-457eaf2f477f`). Edit the
dashboard here and apply it again rather than in the Dash0 UI, or the next apply
reverts the edit.

## Query notes

- Every selector has `service_namespace="understory"` and an exact `test_outcome`.
  Without the namespace a 7-day query over `dash0.spans` timed out on 2026-11-19, and
  `test_outcome=~"…"` also matched spans that have no `test.outcome`.
- A test span is one with `test.name`; the test report's root span has none.
- The Branch filter defaults to every branch, so the failure panels include PRs' red
  work in progress. It stays that way because storefront's main E2E spans had no
  `github.branch` before storefront#1823, and the same-commit panel needs PR runs.
- "Passed and failed on the same commit" is how unit tests show as flaky, as they
  don't retry. It needs a failing run and a passing run of one commit, such as a
  re-run of a failed job. It groups by `github_run_id` and `github_run_attempt` first:
  one run can repeat a name (storefront's `it.each` makes duplicate full names), and a
  name that both passed and failed within one run isn't flaky.
  It keeps to unit tests (`test_package!=""`): an E2E run tests whatever dev serves,
  so its commit doesn't pin the code under test.
- Spans from before the E2E reporters sent `test.suite` and `github.*` show as a
  suite with no name until they leave the window: 14 days after storefront#1823 and
  backoffice#6609 merge.
