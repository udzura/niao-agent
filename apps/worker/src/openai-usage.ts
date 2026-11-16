import {utcDay} from "./usage";

const tokyoOffsetMs = 9 * 60 * 60 * 1000;

export function tokyoDay(now: Date) {
  const shifted = utcDay(new Date(now.getTime() + tokyoOffsetMs));
  return {
    date: shifted.dayStart.slice(0, 10),
    dayStart: new Date(Date.parse(shifted.dayStart) - tokyoOffsetMs).toISOString(),
    dayEnd: new Date(Date.parse(shifted.dayEnd) - tokyoOffsetMs).toISOString(),
  };
}

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  attempts: number;
  unmeasuredAttempts: number;
}

export interface OpenAIModelUsage extends TokenTotals {
  modelId: string;
}

function sumUsage(rows: TokenTotals[]): TokenTotals {
  return rows.reduce((totals, row) => ({
    inputTokens: totals.inputTokens + row.inputTokens,
    outputTokens: totals.outputTokens + row.outputTokens,
    totalTokens: totals.totalTokens + row.totalTokens,
    attempts: totals.attempts + row.attempts,
    unmeasuredAttempts: totals.unmeasuredAttempts + row.unmeasuredAttempts,
  }), {inputTokens: 0, outputTokens: 0, totalTokens: 0, attempts: 0, unmeasuredAttempts: 0});
}

export function summarizeOpenAIUsage(rows: OpenAIModelUsage[]) {
  const byModel = new Map<string, OpenAIModelUsage[]>();
  for (const row of rows) {
    const group = byModel.get(row.modelId) ?? [];
    group.push(row);
    byModel.set(row.modelId, group);
  }
  const models = Array.from(byModel, ([modelId, group]) => ({modelId, ...sumUsage(group)}));
  models.sort((a, b) => b.totalTokens - a.totalTokens || a.modelId.localeCompare(b.modelId));
  return {totals: sumUsage(models), models};
}
