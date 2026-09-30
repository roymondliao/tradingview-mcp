/** TTY-only single-line progress presentation for Strategy Run and Resume. */

const DEFAULT_COLUMNS = 120;
const MAX_EXPERIMENT_NAME_LENGTH = 100;
const MAX_BAR_WIDTH = 20;

function boundedInteger(value, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.trunc(number));
}

function sanitizeExperimentName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXPERIMENT_NAME_LENGTH) || 'unnamed';
}

function truncateName(value, maximum) {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return value.slice(0, 1);
  return `${value.slice(0, maximum - 1)}…`;
}

/** Format one bounded progress event without terminal control sequences. */
export function formatStrategyProgress(event, {
  columns = DEFAULT_COLUMNS,
  unicode = true,
} = {}) {
  const total = boundedInteger(event?.total);
  const processed = Math.min(total, boundedInteger(event?.processed));
  const succeeded = Math.min(processed, boundedInteger(event?.succeeded));
  const failed = Math.min(processed, boundedInteger(event?.failed));
  const percentage = total === 0 ? 0 : Math.min(100, (processed / total) * 100);
  const experimentIndex = boundedInteger(event?.experiment?.index, 1);
  const experimentCount = Math.max(experimentIndex, boundedInteger(event?.experiment?.count, 1));
  const rawName = sanitizeExperimentName(event?.experiment?.name);
  const parsedColumns = Number(columns);
  const width = Number.isFinite(parsedColumns)
    ? Math.max(1, Math.trunc(parsedColumns))
    : DEFAULT_COLUMNS;
  const beforeName = `${percentage.toFixed(1)}%  ${processed}/${total} processed | Experiment ${experimentIndex}/${experimentCount}: `;
  const afterName = ` | succeeded ${succeeded} | failed ${failed}`;
  const nameWidth = Math.max(1, Math.min(
    MAX_EXPERIMENT_NAME_LENGTH,
    width - beforeName.length - afterName.length,
  ));
  const details = `${beforeName}${truncateName(rawName, nameWidth)}${afterName}`;
  const availableBarWidth = Math.min(MAX_BAR_WIDTH, width - details.length - 3);
  if (availableBarWidth < 3) return details;
  const completed = Math.min(
    availableBarWidth,
    Math.floor((percentage / 100) * availableBarWidth),
  );
  const filled = unicode ? '█' : '#';
  const empty = unicode ? '░' : '-';
  const bar = filled.repeat(completed) + empty.repeat(availableBarWidth - completed);
  return `[${bar}] ${details}`;
}

/** Create a failure-isolated renderer that writes only to an interactive stderr-like stream. */
export function createStrategyProgressRenderer({
  stream = process.stderr,
  unicode = true,
} = {}) {
  const enabled = stream?.isTTY === true && typeof stream.write === 'function';
  let started = false;
  let finished = false;
  let previousLength = 0;

  function safeWrite(value) {
    try {
      stream.write(value);
      return true;
    } catch {
      return false;
    }
  }

  function update(event) {
    if (!enabled || finished) return;
    const line = formatStrategyProgress(event, {
      columns: stream.columns,
      unicode,
    });
    const padding = ' '.repeat(Math.max(0, previousLength - line.length));
    if (safeWrite(`\r${line}${padding}`)) {
      started = true;
      previousLength = line.length;
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (enabled && started) safeWrite('\n');
  }

  return Object.freeze({ enabled, update, finish });
}
