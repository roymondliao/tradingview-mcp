/**
 * Convert a Unix timestamp while preserving the numeric source field.
 * Public market-data timestamps in this repo use seconds unless documented
 * otherwise.
 */
export function unixSecondsToIso(value) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toISOString();
  } catch {
    return null;
  }
}

export function unixMillisecondsToIso(value) {
  if (value == null || value === '') return null;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toISOString();
  } catch {
    return null;
  }
}

export function withUnixSecondsIso(value, fields) {
  const result = { ...value };
  for (const field of fields) {
    result[`${field}_iso`] = unixSecondsToIso(value?.[field]);
  }
  return result;
}
