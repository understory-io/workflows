# Tests dashboard in Dash0

`dashboard.yaml` shows pass rate, failures and flaky tests per repository and suite.
Its data is one span per test:

| Source | `service.name` | `test.suite` |
|---|---|---|
| test-report action, unit and acceptance tests in PR and main CI | `<repo>-tests` | the report's title, e.g. `Go tests (bookings-core)` |
| storefront Playwright reporter, `E2E (dev)` | `storefront-e2e` | `E2E (dev)` |
| backoffice Playwright reporter, `RM E2E (dev)` | `rm-e2e`, `rm-e2e-smoke` | the workflow name |

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

On create, Dash0 assigns its own id. After the first apply, add it to the file as
`metadata.dash0Extensions.id`, or the next apply creates a second dashboard. Edit the
dashboard here and apply it again rather than in the Dash0 UI, or the next apply
reverts the edit.

## Query notes

- Every selector has `service_namespace="understory"` and an exact `test_outcome`.
  Without the namespace a 7-day query over `dash0.spans` timed out on 2026-11-19, and
  `test_outcome=~"…"` also matched spans that have no `test.outcome`.
- A test span is one with `test.name`; the test report's root span has none.
- "Passed and failed on the same commit" is how unit tests show as flaky, as they
  don't retry. It needs two runs of one commit, such as a re-run of a failed job.
