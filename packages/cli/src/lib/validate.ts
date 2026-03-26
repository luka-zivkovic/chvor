export function validatePort(value: string): string {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1 || num > 65535 || String(num) !== value) {
    throw new Error(`Invalid port: "${value}". Must be an integer between 1 and 65535.`);
  }
  return value;
}
