export function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(columns, rows) {
  return [columns.join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}

export const MANIFEST_COLUMNS = ['item_id', 'text', 'reading', 'file', 'start_epoch_ms', 'duration_ms', 'redo_count', 'width', 'height', 'fps', 'camera_label', 'mime', 'fps_source'];
export const LOG_COLUMNS = ['item_id', 'event', 'rel_sec', 'epoch_ms'];
