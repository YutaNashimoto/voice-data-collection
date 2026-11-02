// 同意画面が必要になった場合は文面と版を見直し、設定を変更する。
export const APP_VERSION = '1.1.4';
export const GOOGLE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSccnkhrIjERHGRSCFqfz2LueMHRmPxUHBnnS-Av1aWTHa4uag/viewform';
export const GOOGLE_FORM_PARTICIPANT_ENTRY = 'entry.920564838';
export const CONSENT_REQUIRED = false;
export const CONSENT_VERSION = '2026-11-02';
export const PARTICIPANT_PATTERN = '^(?:[A-Z]\\d{3}|N[0-9a-f]{32})$';
export const PARTICIPANT_HINT = '英字1文字と数字3桁で入力してください（例：P001）。全角・小文字も使えます。';
export const PARTICIPANT_NAME_HINT = 'お名前を80文字以内で入力してください。';
export const FACE = {
  moduleUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm',
  wasmUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  modelUrl: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  timeoutMs: 10000,
  // 枠は映像全体に対する比率。CSSのガイドにも同じ値を使う。
  guide: { left: 0.35, right: 0.65, top: 0.56, bottom: 0.74 },
  minMouthWidth: 0.08,
  minLuma: 60,
};
export const LIMITS = { minMs: 0, maxMs: 12000, autoStopMs: 11800 };
const FULL_BLOCKS = [
  { id: 'B1', title: '口の動きの準備', detail: '校正文', count: 20, minutes: '2〜3' },
  { id: 'B2', title: '単語をゆっくり', detail: '52語を2回ずつ', count: 104, minutes: '12〜15' },
  { id: 'B3', title: 'ふだんのひとこと', detail: '日常フレーズ', count: 60, minutes: '8〜9' },
  { id: 'B4', title: 'もう一度、単語', detail: '同じ52語をさらに2回ずつ', count: 104, minutes: '12〜15' },
  { id: 'B5', title: '文章を読もう', detail: '文章', count: 20, minutes: '3〜4' },
].map(block => ({ ...block, source: block.id, filter: null }));

// 'full' にすると10/15の全5ブロックを選べる。
export const SESSION_PRESET = 'short';
export const PRESETS = {
  short: {
    minutes: '15',
    blocks: [
      { ...FULL_BLOCKS[1], minutes: '12' },
      { id: 'B3S', title: 'ふだんのひとこと', detail: 'ふだん使う20の言葉', source: 'B3', filter: { item_id_suffix: '_r1' }, count: 20, minutes: '3' },
    ],
  },
  full: { minutes: '40〜45', blocks: FULL_BLOCKS },
};

export function getPreset(name = SESSION_PRESET) {
  if (!Object.hasOwn(PRESETS, name)) throw new Error('収録プリセットが正しくありません。');
  return PRESETS[name];
}
export function totalsText(name = SESSION_PRESET) {
  const preset = getPreset(name);
  return `${preset.blocks.reduce((sum, block) => sum + block.count, 0)} 問・約 ${preset.minutes} 分`;
}
export const BLOCKS = getPreset().blocks;
export const TOTALS_TEXT = totalsText();
export const INTRO_TEXT = `画面の言葉を、声を出さずに口だけで伝えます。全体で${TOTALS_TEXT}です。ブロックごとに休めます。
顔を含む動画を録画します。入力したお名前も動画と一緒にZIPに含まれます。名前と動画はこのブラウザに保存され、ZIPを保存してGoogleフォームから自分で送るまで、外には送られません。
送信にはGoogleへのログインが必要です。アカウントの名前・メールアドレス・写真がGoogleフォームに記録されます。
いつでも途中でやめられます。顔の位置の確認は端末内で行います（確認用プログラムとモデルを外部サイトから読み込みます）。`;
export const CONSENT_TEXT = INTRO_TEXT + '\n上の説明を読み、顔を含む動画を研究に利用することに同意して参加します。';
export function normalizeParticipantCode(value) { return value.normalize('NFKC').trim().toUpperCase(); }
export function normalizeParticipantName(value) {
  if (typeof value !== 'string') throw new Error(PARTICIPANT_NAME_HINT);
  const normalized = value.normalize('NFKC');
  if (/[\p{Cc}\p{Cf}]/u.test(normalized)) throw new Error('お名前に改行や制御文字は使えません。入力し直してください。');
  const name = normalized.trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > 80) throw new Error(PARTICIPANT_NAME_HINT);
  return name;
}
export function createParticipantCode() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return 'N' + [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function participantFormUrl(name) {
  if (!GOOGLE_FORM_URL) return '';
  const url = new URL(GOOGLE_FORM_URL);
  url.searchParams.set('usp', 'pp_url');
  url.searchParams.set(GOOGLE_FORM_PARTICIPANT_ENTRY, name);
  return url.href;
}
