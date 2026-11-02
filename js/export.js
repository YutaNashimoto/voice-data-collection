import { createZip } from './zip.js';
import { MANIFEST_COLUMNS, LOG_COLUMNS, toCsv } from './csv.js';
import { clipKey } from './store.js';

export function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function prepareExport(db, session, items, { partial = false } = {}) {
  const missing = items.filter(item => !session.saved[item.item_id]).map(item => item.item_id);
  if (!partial && missing.length) throw new Error('まだ録っていない項目があります。続きから録ってください。');
  const selected = items.filter(item => session.saved[item.item_id]);
  if (!selected.length) throw new Error('保存済みの動画がありません。');
  const manifest = selected.map(item => session.saved[item.item_id]);
  const { saved, log, key, ...details } = session;
  const entries = [
    { name: 'manifest.csv', data: toCsv(MANIFEST_COLUMNS, manifest) },
    { name: 'log.csv', data: toCsv(LOG_COLUMNS, log) },
    { name: 'session.json', data: JSON.stringify({ ...details, exported_at: new Date().toISOString(), item_count: selected.length, partial, missing_item_ids: missing }, null, 2) + '\n' },
  ];
  for (const item of selected) {
    const blob = await db.get('clips', clipKey(session, item.item_id));
    if (!(blob instanceof Blob) || !blob.size) throw new Error('動画が見つかりません。このブロックを録り直してください。');
    entries.push({ name: session.saved[item.item_id].file, data: blob });
  }
  return { name: `${session.participant.code}_${session.preset}_${session.block}_${partial ? 'partial_' : ''}${timestamp()}.zip`, blob: await createZip(entries) };
}

export function downloadLink(prepared) {
  const url = URL.createObjectURL(prepared.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = prepared.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 必ずクリックから呼ぶ。共有・保存先選択はユーザー操作の権限が必要。
export async function saveExport(prepared) {
  if (typeof window.showSaveFilePicker === 'function') {
    const handle = await window.showSaveFilePicker({ suggestedName: prepared.name, types: [{ description: '録画データ（ZIP）', accept: { 'application/zip': ['.zip'] } }] });
    const writable = await handle.createWritable();
    try { await prepared.blob.stream().pipeTo(writable); }
    catch (error) { try { await writable.abort(); } catch {} throw error; }
    return 'ファイルを保存しました。';
  }
  const file = new File([prepared.blob], prepared.name, { type: 'application/zip' });
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && navigator.canShare?.({ files: [file] }) && navigator.share) {
    await navigator.share({ files: [file], title: '録画データ' });
    return '共有画面を閉じました。「ファイルに保存」できたことを確認してください。';
  }
  downloadLink(prepared);
  return '保存を開始しました。ダウンロード一覧でファイルを確認してください。';
}
