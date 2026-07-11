const timestampParts =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isCanonicalTrajectoryTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = timestampParts.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** A UTC lexical key that retains every supplied fractional-second digit. */
export function trajectoryTimestampKey(value: string): string {
  if (!isCanonicalTrajectoryTimestamp(value)) {
    throw new TypeError("invalid canonical trajectory timestamp");
  }
  const parts = timestampParts.exec(value);
  if (!parts) throw new TypeError("invalid canonical trajectory timestamp");
  const epochSecond =
    Date.parse(
      `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}${parts[8]}`
    ) / 1_000;
  // The canonical four-digit local-year range fits safely inside this fixed
  // 13-digit shifted epoch range, including UTC spillover at offset bounds.
  const wholeSecond = String(epochSecond + 1_000_000_000_000).padStart(13, "0");
  const fraction = (parts[7] ?? "").replace(/0+$/, "");
  return fraction.length === 0 ? wholeSecond : `${wholeSecond}.${fraction}`;
}

export function compareTrajectoryTimestamps(left: string, right: string): number {
  const leftKey = trajectoryTimestampKey(left);
  const rightKey = trajectoryTimestampKey(right);
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}
