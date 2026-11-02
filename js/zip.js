// 非圧縮ZIP。動画はすでに圧縮済みなので、追加の圧縮依存は不要。
export const MAX_ZIP_BYTES = 3.5 * 1024 ** 3;
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function normalize(entries) {
  const names = new Set();
  return entries.map(entry => {
    if (!entry.name || /[\\\0]/.test(entry.name) || entry.name.startsWith('/') || entry.name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('ZIP内のファイル名が不正です。');
    if (names.has(entry.name)) throw new Error('ZIP内のファイル名が重複しています。');
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    if (name.length > 65535) throw new Error('ZIP内のファイル名が長すぎます。');
    return { name, blob: entry.data instanceof Blob ? entry.data : new Blob([entry.data]) };
  });
}

export function zipSize(entries) {
  const normalized = normalize(entries);
  const size = normalized.reduce((sum, entry) => sum + 30 + 46 + 2 * entry.name.length + entry.blob.size, 22);
  if (size > MAX_ZIP_BYTES || normalized.length > 65535) throw new Error('ZIPが3.5 GBを超えるため保存できません。実験者に連絡してください。');
  return size;
}

function header(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

export async function createZip(entries, date = new Date()) {
  zipSize(entries);
  const normalized = normalize(entries);
  const parts = [], directory = [];
  let offset = 0;
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  for (const entry of normalized) {
    let crc = 0;
    // 大きい動画を一度にArrayBufferへ展開しない。
    for (let start = 0; start < entry.blob.size; start += 1024 * 1024) {
      crc = crc32(new Uint8Array(await entry.blob.slice(start, start + 1024 * 1024).arrayBuffer()), crc);
    }
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(10, dosTime, true);
    local.view.setUint16(12, dosDate, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, entry.blob.size, true);
    local.view.setUint32(22, entry.blob.size, true);
    local.view.setUint16(26, entry.name.length, true);
    parts.push(local.bytes, entry.name, entry.blob);
    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(12, dosTime, true);
    central.view.setUint16(14, dosDate, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, entry.blob.size, true);
    central.view.setUint32(24, entry.blob.size, true);
    central.view.setUint16(28, entry.name.length, true);
    central.view.setUint32(42, offset, true);
    directory.push(central.bytes, entry.name);
    offset += 30 + entry.name.length + entry.blob.size;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, normalized.length, true);
  end.view.setUint16(10, normalized.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.bytes], { type: 'application/zip' });
}
