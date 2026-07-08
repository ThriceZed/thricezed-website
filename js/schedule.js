// Reads the schedule from a public Google Sheet (exported as CSV) and renders it as a table.
// Edit the sheet directly at https://docs.google.com/spreadsheets/d/1XSSSw6Xz2cQz4dmMo7OnhsBDUKHt4IPsUHC3xUzkCWM/edit
// The sheet must stay shared as "Anyone with the link can view" for this to keep working.

const SCHEDULE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1XSSSw6Xz2cQz4dmMo7OnhsBDUKHt4IPsUHC3xUzkCWM/export?format=csv&gid=0';

function parseCSVLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseCSV(text) {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

  if (lines.length === 0) return { header: [], rows: [] };

  const [headerLine, ...rowLines] = lines;
  const header = parseCSVLine(headerLine);
  const rows = rowLines.map(parseCSVLine);

  return { header, rows };
}

function renderSchedule(header, rows) {
  const container = document.getElementById('schedule-container');
  if (!container) return;

  if (rows.length === 0) {
    container.innerHTML = '<p class="schedule-empty">No upcoming events on the schedule yet — check back soon.</p>';
    return;
  }

  const thead = `<thead><tr>${header.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;

  container.innerHTML = `<div class="schedule-table-wrap"><table class="schedule-table">${thead}${tbody}</table></div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('schedule-container');
  if (!container) return;

  fetch(SCHEDULE_SHEET_URL)
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error('not found'))))
    .then((text) => {
      const { header, rows } = parseCSV(text);
      renderSchedule(header, rows);
    })
    .catch(() => {
      container.innerHTML = '<p class="schedule-empty">No upcoming events on the schedule yet — check back soon.</p>';
    });
});
