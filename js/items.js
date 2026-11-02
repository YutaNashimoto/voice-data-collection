import { SESSION_PRESET, getPreset } from '../config.js';

export function validateItems(items, block, preset = SESSION_PRESET) {
  const expected = getPreset(preset).blocks.find(entry => entry.id === block);
  if (!expected || !Array.isArray(items) || items.length !== expected.count) throw new Error('項目の件数が正しくありません。');
  const ids = new Set();
  for (const item of items) {
    if (!/^[A-Za-z0-9_-]+$/.test(item.item_id) || ids.has(item.item_id) || typeof item.text !== 'string' || !item.text || typeof item.reading !== 'string') {
      throw new Error('項目データが正しくありません。');
    }
    ids.add(item.item_id);
  }
  return items;
}

export async function loadItems(block, fetcher = fetch, preset = SESSION_PRESET) {
  const definition = getPreset(preset).blocks.find(entry => entry.id === block);
  if (!definition) throw new Error('項目の件数が正しくありません。');
  const response = await fetcher(new URL(`../items/${definition.source}.json`, import.meta.url));
  if (!response.ok) throw new Error('項目を読み込めません。ページを開き直してください。');
  const source = await response.json();
  const items = definition.filter && Array.isArray(source)
    ? source.filter(item => typeof item.item_id === 'string' && item.item_id.endsWith(definition.filter.item_id_suffix))
    : source;
  return validateItems(items, block, preset);
}
