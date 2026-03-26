import cronstrue from "cronstrue";
import { parseExpression } from "cron-parser";

export function cronToHuman(expression: string): string {
  try {
    return cronstrue.toString(expression, { use24HourTimeFormat: false });
  } catch {
    return expression;
  }
}

export function getNextRun(expression: string): Date | null {
  try {
    const interval = parseExpression(expression);
    return interval.next().toDate();
  } catch {
    return null;
  }
}

export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = date.getTime() - now;
  if (diff < 0) return "overdue";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}
