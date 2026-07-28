import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const examples = join(root, "examples", "monitoring");
const rulesPath = join(examples, "minime.rules.yml");
const alertmanagerPath = join(examples, "alertmanager.yml");
const fixturePath = join(examples, "minime.rules.test.yml");

interface AlertRule {
  alert: string;
  expr: string;
  for: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

interface RuleFile {
  groups: Array<{
    name: string;
    rules: AlertRule[];
  }>;
}

interface AlertmanagerFile {
  route: {
    receiver: string;
    group_by: string[];
    group_wait: string;
    group_interval: string;
    repeat_interval: string;
  };
  receivers: Array<{
    name: string;
    webhook_configs: Array<{
      url: string;
      send_resolved: boolean;
    }>;
  }>;
}

interface RuleTestAlert {
  exp_labels: Record<string, string>;
  exp_annotations: Record<string, string>;
}

interface RuleTestCase {
  name: string;
  input_series?: Array<{
    series: string;
    values: string;
  }>;
  alert_rule_test: Array<{
    eval_time: string;
    alertname: string;
    exp_alerts: RuleTestAlert[];
  }>;
}

interface RuleTestFixture {
  rule_files: string[];
  evaluation_interval: string;
  tests: RuleTestCase[];
}

function readYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, "utf8")) as T;
}

function normalizePromql(expression: string): string {
  return expression.trim().replace(/\s+/g, " ");
}

function cronRules(): AlertRule[] {
  return readYaml<RuleFile>(rulesPath).groups
    .flatMap((group) => group.rules)
    .filter((rule) => rule.alert.startsWith("MinimeCron"));
}

describe("cron terminal monitoring contract", () => {
  it("defines bounded failure and telemetry alerts without per-cron policy selectors", () => {
    const rules = cronRules();
    assert.deepEqual(
      rules.map((rule) => rule.alert),
      ["MinimeCronTerminalFailure", "MinimeCronTelemetryIncomplete"],
    );

    const terminal = rules[0];
    assert.equal(terminal.for, "5m");
    assert.deepEqual(terminal.labels, {
      severity: "warning",
      component: "cron",
      failure_class: "terminal",
    });
    assert.equal(
      normalizePromql(terminal.expr),
      "max by (cron) ( (minime_cron_last_exit_code != 0) and on (cron) "
        + "(minime_cron_last_run_timestamp_seconds <= time() + 300) )",
    );

    const incomplete = rules[1];
    assert.equal(incomplete.for, "5m");
    assert.deepEqual(incomplete.labels, {
      severity: "warning",
      component: "cron",
      failure_class: "telemetry_incomplete",
    });
    assert.equal(
      normalizePromql(incomplete.expr),
      "max by (cron) ( ( minime_cron_last_exit_code unless on (cron) "
        + "minime_cron_last_run_timestamp_seconds ) or ( minime_cron_last_exit_code "
        + "and on (cron) (minime_cron_last_run_timestamp_seconds > time() + 300) ) )",
    );

    for (const rule of rules) {
      assert.deepEqual(Object.keys(rule.labels).sort(), ["component", "failure_class", "severity"]);
      assert.ok(Object.values(rule.labels).every((value) => !value.includes("$")));
      assert.ok(!rule.expr.includes("{"), `${rule.alert} must not select cron names or private labels`);
      assert.ok(!rule.expr.includes("minime_cron_runs_total"), `${rule.alert} must not alert on counter resets`);
      assert.match(rule.expr, /on \(cron\)/);
      assert.deepEqual(Object.keys(rule.annotations).sort(), ["description", "summary"]);
    }
  });

  it("groups one stable incident per alert and cron with repeats and recovery enabled", () => {
    const config = readYaml<AlertmanagerFile>(alertmanagerPath);
    assert.deepEqual(config.route.group_by, ["alertname", "cron"]);
    assert.equal(config.route.repeat_interval, "4h");
    assert.equal(config.route.receiver, "minime-native-webhook");

    const receiver = config.receivers.find((entry) => entry.name === config.route.receiver);
    assert.ok(receiver);
    assert.equal(receiver.webhook_configs.length, 1);
    assert.equal(receiver.webhook_configs[0].send_resolved, true);
    assert.match(receiver.webhook_configs[0].url, /PLACEHOLDER/);
  });

  it("checks every terminal-state edge case while keeping counter values out of alert identity", () => {
    const fixture = readYaml<RuleTestFixture>(fixturePath);
    assert.deepEqual(fixture.rule_files, ["examples/monitoring/minime.rules.yml"]);
    assert.equal(fixture.evaluation_interval, "1m");

    const cases = new Map(fixture.tests.map((testCase) => [testCase.name, testCase]));
    for (const name of [
      "terminal success stays healthy",
      "terminal failure waits for the configured pending period",
      "repeated failures and a counter reset retain one alert identity",
      "successful terminal state resolves a firing failure",
      "stale terminal failure remains firing",
      "missing terminal timestamp reports incomplete telemetry",
      "future terminal timestamp reports incomplete telemetry",
      "missing all terminal series stays unobservable",
    ]) {
      assert.ok(cases.has(name), `missing promtool scenario: ${name}`);
    }

    const stableIdentity = cases.get("repeated failures and a counter reset retain one alert identity");
    assert.ok(stableIdentity);
    const failureCounter = stableIdentity.input_series?.find((series) =>
      series.series.includes('outcome="failure"')
    );
    assert.equal(failureCounter?.values, "7 8 9 0 1 2 3 4 5 6 7");
    const terminalSeries = stableIdentity.input_series?.filter((series) =>
      series.series.startsWith("minime_cron_last_")
    ) ?? [];
    assert.ok(terminalSeries.length > 0);
    for (const series of terminalSeries) {
      assert.match(series.series, /job="node-exporter"/);
      assert.match(series.series, /instance="127\.0\.0\.1:9100"/);
      assert.match(series.series, /scrape_scope="fixture"/);
    }

    const expectedAlerts = stableIdentity.alert_rule_test.flatMap((evaluation) => evaluation.exp_alerts);
    assert.equal(expectedAlerts.length, 2);
    assert.deepEqual(expectedAlerts[0], expectedAlerts[1]);
    assert.deepEqual(Object.keys(expectedAlerts[0].exp_labels).sort(), [
      "component",
      "cron",
      "failure_class",
      "severity",
    ]);

    const recovery = cases.get("successful terminal state resolves a firing failure");
    assert.ok(recovery);
    assert.deepEqual(
      recovery.input_series?.map((series) => series.values),
      ["1x6 0x4", "0x6 420x4"],
    );
    assert.equal(recovery.alert_rule_test.at(-1)?.eval_time, "7m");
    assert.deepEqual(recovery.alert_rule_test.at(-1)?.exp_alerts, []);

    const missingTimestamp = cases.get("missing terminal timestamp reports incomplete telemetry");
    assert.ok(missingTimestamp);
    assert.match(missingTimestamp.input_series?.[0]?.series ?? "", /job="node-exporter"/);
    assert.match(missingTimestamp.input_series?.[0]?.series ?? "", /instance="127\.0\.0\.1:9100"/);
    assert.match(missingTimestamp.input_series?.[0]?.series ?? "", /scrape_scope="fixture"/);
    const incompleteLabels = missingTimestamp.alert_rule_test
      .flatMap((evaluation) => evaluation.exp_alerts)
      .map((alert) => Object.keys(alert.exp_labels).sort());
    assert.deepEqual(incompleteLabels, [[
      "component",
      "cron",
      "failure_class",
      "severity",
    ]]);

    const missingAll = cases.get("missing all terminal series stays unobservable");
    assert.ok(missingAll);
    assert.equal(missingAll.input_series, undefined);
    assert.ok(missingAll.alert_rule_test.every((evaluation) => evaluation.exp_alerts.length === 0));
  });

  it("passes the checked-in rule fixture when a local promtool is available", (t) => {
    const version = spawnSync("promtool", ["--version"], {
      cwd: root,
      encoding: "utf8",
    });
    if (version.error || version.status !== 0) {
      t.skip("compatible promtool is not installed");
      return;
    }

    const result = spawnSync("promtool", ["test", "rules", fixturePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
