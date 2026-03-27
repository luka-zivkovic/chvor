export function validatePort(value: string): string {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1 || num > 65535 || String(num) !== value) {
    throw new Error(`Invalid port: "${value}". Must be an integer between 1 and 65535.`);
  }
  return value;
}

export function validateInstanceName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error(
      `Invalid instance name "${name}". Use only letters, digits, hyphens, and underscores (max 64 chars, must start with alphanumeric).`
    );
  }
  return name;
}
