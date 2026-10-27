/**
 * Column lookup and value encoding for `set`: find a board column by id, title or alias, and turn
 * the user's plain value ("6", "2026-11-03", "Ready For QA", "Alex") into the JSON shape
 * change_multiple_column_values expects for that column type. An empty value clears the column.
 */

/** A column by exact id, a configured alias (e.g. "estimate"), or case-insensitive title. */
function findColumn(columns, key, aliases = {}) {
  const lc = String(key).toLowerCase();
  const byId = columns.find((c) => c.id === key) || columns.find((c) => c.id === aliases[key]);
  if (byId) return byId;
  const byTitle = columns.filter((c) => (c.title || '').toLowerCase() === lc);
  if (byTitle.length === 1) return byTitle[0];
  const partial = columns.filter((c) => (c.title || '').toLowerCase().includes(lc));
  if (byTitle.length > 1 || partial.length > 1) {
    const list = (byTitle.length > 1 ? byTitle : partial).map((c) => `${c.title} (${c.id})`).join(', ');
    throw new Error(`Column "${key}" is ambiguous: ${list}. Pass the column id.`);
  }
  if (partial.length === 1) return partial[0];
  throw new Error(`No column "${key}" on this board. Columns: ${columns.map((c) => `${c.title} (${c.id})`).join(', ')}`);
}

/** The board's estimate column: the "estimate" alias, else the one numbers column titled like an estimate. */
function findEstimateColumn(columns, aliases = {}) {
  const alias = aliases.estimate || aliases.timeEstimateHrs;
  const hit = columns.find((c) => c.id === alias);
  if (hit) return hit;
  const numeric = columns.filter((c) => c.type === 'numbers' && /estimat/i.test(c.title || ''));
  if (numeric.length === 1) return numeric[0];
  const list = numeric.length ? numeric.map((c) => `${c.title} (${c.id})`).join(', ') : 'none found';
  throw new Error(`Can't tell which column is the estimate (${list}). Use  set <itemId> <column> <hours>  or add "aliases": {"estimate": "<columnId>"} to the board in reference.json.`);
}

function statusLabelsOf(col) {
  const s = JSON.parse(col.settings_str || '{}');
  const dead = new Set(s.deactivated_labels || []);

  return Object.entries(s.labels || {}).filter(([i, n]) => n && !dead.has(Number(i))).map(([, n]) => n);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The column_values entry for one column. `values` are the remaining CLI words; `resolvePerson`
 * maps a name to a user id.
 */
function columnValue(col, values, resolvePerson) {
  const raw = values.join(' ').trim();
  if (!raw) return col.type === 'numbers' || col.type === 'text' ? '' : {};
  const encoders = {
    numbers: () => {
      if (!Number.isFinite(Number(raw))) throw new Error(`"${raw}" is not a number (column ${col.title}).`);

      return String(Number(raw));
    },
    text: () => raw,
    long_text: () => ({ text: raw }),
    email: () => ({ email: raw, text: raw }),
    phone: () => ({ phone: raw.replace(/[^\d+]/g, '') }),
    checkbox: () => (/^(true|yes|1|on|checked)$/i.test(raw) ? { checked: 'true' } : null),
    rating: () => ({ rating: Number(raw) }),
    date: () => {
      const [date, time] = raw.split(/[ T]/);
      if (!DATE.test(date)) throw new Error(`"${raw}" is not a date: use YYYY-MM-DD [HH:MM:SS] (column ${col.title}).`);

      return time ? { date, time: time.length === 5 ? `${time}:00` : time } : { date };
    },
    timeline: () => {
      const [from, to] = raw.split(/\s*(?:\.\.|\bto\b)\s*/);
      if (!DATE.test(from || '') || !DATE.test(to || '')) throw new Error(`Timeline needs "YYYY-MM-DD..YYYY-MM-DD" (column ${col.title}).`);

      return { from, to };
    },
    link: () => {
      const [url, ...text] = values;

      return { url, text: text.join(' ') || url };
    },
    dropdown: () => ({ labels: raw.split(/\s*,\s*/) }),
    status: () => {
      const labels = statusLabelsOf(col);
      if (labels.length && !labels.includes(raw)) {
        throw new Error(`"${raw}" is not a label of ${col.title}. Valid: ${labels.join(', ')}`);
      }

      return { label: raw };
    },
    people: () => ({ personsAndTeams: raw.split(/\s*,\s*/).map((n) => ({ id: Number(resolvePerson(n)), kind: 'person' })) }),
  };
  encoders.color = encoders.status;
  encoders.person = encoders.people;
  encoders['multiple-person'] = encoders.people;
  if (!encoders[col.type]) {
    const hint = col.type === 'time_tracking' || col.type === 'duration'
      ? 'The public API cannot write time tracking.'
      : 'Use  mon.js mcp change_item_column_values  for this type.';
    throw new Error(`Column ${col.title} has type "${col.type}", which set doesn't encode. ${hint}`);
  }

  return encoders[col.type]();
}

module.exports = { findColumn, findEstimateColumn, columnValue, statusLabelsOf };
