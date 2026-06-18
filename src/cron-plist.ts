export interface CronPlistDef {
  name: string;
  schedule: string;
  type?: "llm" | "script";
  engine?: "pi";
  prompt?: string;
  command?: string;
  agentId: string;
  deliveryChatId?: number;
  timeout?: number;
  enabled?: boolean;
}

const CRON_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const CRON_NAME_REQUIREMENT = "use 1-80 letters, numbers, dots, underscores, or hyphens";
const MAX_LAUNCHD_INTERVALS = 10_000;

export function validateCronNameForPlist(name: unknown): string | undefined {
  if (typeof name !== "string") {
    return `(unnamed) has invalid name (${CRON_NAME_REQUIREMENT})`;
  }
  if (!CRON_NAME_PATTERN.test(name)) {
    return `${name || "(unnamed)"} has invalid name (${CRON_NAME_REQUIREMENT})`;
  }
  return undefined;
}

export function validateCronForPlist(cron: CronPlistDef): string | undefined {
  const nameError = validateCronNameForPlist(cron.name);
  if (nameError) {
    return nameError;
  }
  const cronName = cron.name;
  const scheduleError = validateCronScheduleForPlist(cron.schedule);
  if (scheduleError) {
    return `${cronName} has invalid schedule: ${scheduleError}`;
  }
  const cronType = cron.type ?? "llm";
  if (cronType !== "llm" && cronType !== "script") {
    return `${cronName} has invalid type "${cron.type}" (must be "llm" or "script")`;
  }
  if (cronType === "llm" && cron.engine !== undefined && cron.engine !== "pi") {
    return `${cronName} has invalid engine "${cron.engine}" (must be "pi" or omitted)`;
  }
  if (cronType === "script" && (typeof cron.command !== "string" || !cron.command.trim())) {
    return `${cronName} is type "script" but missing required "command" field`;
  }
  if (cronType === "llm" && (typeof cron.prompt !== "string" || !cron.prompt.trim())) {
    return `${cronName} is type "llm" but missing required "prompt" field`;
  }
  return undefined;
}

export function validateCronScheduleForPlist(schedule: unknown): string | undefined {
  if (typeof schedule !== "string") {
    return "schedule is required";
  }
  const trimmed = schedule.trim();
  if (!trimmed) {
    return "schedule is required";
  }

  const everyMatch = trimmed.match(/^every\s+([1-9][0-9]*)$/);
  if (everyMatch) {
    const seconds = Number(everyMatch[1]);
    return Number.isSafeInteger(seconds) ? undefined : "every interval is too large";
  }
  if (trimmed.startsWith("every ")) {
    return "every interval must be a positive integer number of seconds";
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return "expected five cron fields or 'every N'";
  }
  if (parts[2] !== "*" && parts[4] !== "*") {
    return "restricting both day-of-month and weekday is unsupported for launchd plists; split it into separate crons";
  }

  try {
    const counts = [
      expandCronField(parts[0], 0, 59).length,
      expandCronField(parts[1], 0, 23).length,
      expandCronField(parts[2], 1, 31).length,
      expandCronField(parts[3], 1, 12).length,
      expandCronField(parts[4], 0, 7).length,
    ];
    const intervalCount = counts.reduce((product, count) => product * count, 1);
    if (intervalCount > MAX_LAUNCHD_INTERVALS) {
      return `schedule expands to ${intervalCount} launchd intervals (max ${MAX_LAUNCHD_INTERVALS})`;
    }
  } catch (err) {
    return (err as Error).message;
  }

  return undefined;
}

export function parseEveryScheduleSeconds(schedule: string): number | undefined {
  const match = schedule.trim().match(/^every\s+([1-9][0-9]*)$/);
  return match ? Number(match[1]) : undefined;
}

export function expandCronField(field: string, min: number, max: number): number[] {
  if (field === "*") return [-1];

  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(`empty cron field segment in "${field}"`);
    }
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) {
      throw new Error(`invalid step syntax "${part}"`);
    }
    const step = stepPart === undefined ? 1 : parseCronInteger(stepPart, "step");
    if (step <= 0) {
      throw new Error(`step must be positive in "${part}"`);
    }

    const [start, end] = parseCronRange(rangePart, min, max);
    for (let value = start; value <= end; value += step) {
      values.add(max === 7 && value === 7 ? 0 : value);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

function parseCronRange(range: string, min: number, max: number): [number, number] {
  if (range === "*") {
    return [min, max];
  }
  if (range.includes("-")) {
    const [startRaw, endRaw, extra] = range.split("-");
    if (extra !== undefined) {
      throw new Error(`invalid range syntax "${range}"`);
    }
    const start = parseCronInteger(startRaw, "range start");
    const end = parseCronInteger(endRaw, "range end");
    assertCronFieldValue(start, min, max);
    assertCronFieldValue(end, min, max);
    if (start > end) {
      throw new Error(`range start must be <= end in "${range}"`);
    }
    return [start, end];
  }

  const value = parseCronInteger(range, "field value");
  assertCronFieldValue(value, min, max);
  return [value, value];
}

function parseCronInteger(raw: string, label: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${label} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is too large`);
  }
  return value;
}

function assertCronFieldValue(value: number, min: number, max: number): void {
  if (value < min || value > max) {
    throw new Error(`value ${value} outside allowed range ${min}-${max}`);
  }
}
