import { SESSION_PRESET } from '../config.js';

export function nextUnrecorded(items, saved = {}) {
  const index = items.findIndex(item => !Object.hasOwn(saved, item.item_id));
  return index < 0 ? items.length : index;
}

export function sessionKey(participant, block, preset = SESSION_PRESET) {
  // fullは初版のキーを維持し、保存済み308項目版を再開できる。
  return preset === 'full' ? `${participant}/${block}` : `${participant}/${preset}/${block}`;
}
export function clipKey(session, itemId) { return `${session.key}/${itemId}`; }

export class Database {
  constructor(db) { this.db = db; }

  static async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('vsr-collect-v1', 1);
      request.onupgradeneeded = () => {
        for (const name of ['settings', 'sessions', 'clips']) request.result.createObjectStore(name);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('ほかのタブを閉じてから、開き直してください。'));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(new Database(request.result));
      };
    });
  }

  async get(store, key) {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async write(operations) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([...new Set(operations.map(op => op.store))], 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('保存を中断しました。'));
      transaction.onerror = () => {};
      for (const op of operations) {
        const store = transaction.objectStore(op.store);
        if (op.type === 'clear') store.clear();
        else if (op.type === 'delete') store.delete(op.key);
        else store.put(op.value, op.key);
      }
    });
  }

  put(store, key, value) { return this.write([{ store, key, value }]); }
  clear() { return this.write(['settings', 'sessions', 'clips'].map(store => ({ store, type: 'clear' }))); }
}

// 動画と進捗を同じトランザクションで確定する。失敗時は両方とも変更しない。
export async function saveTake(db, session, itemId, take) {
  const updated = structuredClone(session);
  updated.saved[itemId] = take.metadata;
  clearSent(updated);
  updated.zip_saved_at = null;
  await db.write([
    { store: 'clips', key: clipKey(session, itemId), value: take.blob },
    { store: 'sessions', key: session.key, value: updated },
  ]);
  return updated;
}

export async function removeTakes(db, session, itemIds) {
  const updated = structuredClone(session);
  for (const id of itemIds) delete updated.saved[id];
  clearSent(updated);
  updated.zip_saved_at = null;
  await db.write([
    ...itemIds.map(id => ({ store: 'clips', key: clipKey(session, id), type: 'delete' })),
    { store: 'sessions', key: session.key, value: updated },
  ]);
  return updated;
}

function clearSent(session) {
  if (session.sent) {
    const epoch = Date.now();
    session.log.push({ event: 'sent_mark_cleared', item_id: '', epoch_ms: epoch, rel_sec: (epoch - session.started_at) / 1000 });
  }
  session.sent = false;
}

// 全プリセットの動画・進捗・番号を一つのトランザクション内で付け替える。
export function changeParticipant(db, profile, code) {
  return new Promise((resolve, reject) => {
    const transaction = db.db.transaction(['settings', 'sessions', 'clips'], 'readwrite');
    const sessions = transaction.objectStore('sessions'), clips = transaction.objectStore('clips');
    const nextProfile = structuredClone(profile), oldCode = profile.participant.code;
    let failure;
    const abortWithReason = message => { failure = new Error(message); transaction.abort(); };
    nextProfile.participant.code = code;
    const request = sessions.getAll();
    transaction.oncomplete = () => resolve(nextProfile);
    transaction.onabort = () => reject(failure || transaction.error || new Error('番号を変更できませんでした。'));
    transaction.onerror = () => {};
    request.onsuccess = () => {
      const all = request.result;
      if (all.some(value => value.participant.code === code) && code !== oldCode) {
        abortWithReason('変更先の番号の動画がすでに残っています。番号を確認し、実験者に連絡してください。');
        return;
      }
      for (const original of all.filter(value => value.participant.code === oldCode)) {
        const updated = structuredClone(original);
        updated.key = sessionKey(code, original.block, original.preset);
        updated.participant.code = code;
        clearSent(updated);
        updated.zip_saved_at = null;
        const epoch = Date.now();
        updated.log.push({ event: 'participant_changed', item_id: `${oldCode}->${code}`, epoch_ms: epoch, rel_sec: (epoch - updated.started_at) / 1000 });
        for (const itemId of Object.keys(original.saved)) {
          const from = clipKey(original, itemId), to = clipKey(updated, itemId);
          const read = clips.get(from);
          read.onsuccess = () => {
            if (!read.result) {
              abortWithReason('保存済みの動画を読み出せません。番号は変更していません。実験者に連絡してください。');
              return;
            }
            clips.put(read.result, to);
            if (from !== to) clips.delete(from);
          };
        }
        if (original.key !== updated.key) sessions.delete(original.key);
        sessions.put(updated, updated.key);
      }
      transaction.objectStore('settings').put(nextProfile, 'profile');
    };
  });
}
