import { APP_VERSION, GOOGLE_FORM_URL, PARTICIPANT_PATTERN, PARTICIPANT_HINT, CONSENT_TEXT, INTRO_TEXT, CONSENT_REQUIRED, CONSENT_VERSION, normalizeParticipantCode, participantFormUrl, FACE, LIMITS, BLOCKS, SESSION_PRESET, TOTALS_TEXT } from '../config.js';
import { Database, sessionKey, nextUnrecorded, saveTake, removeTakes, changeParticipant } from './store.js';
import { loadItems } from './items.js';
import { openCamera, chooseMime, cameraSettings, sanitizeCameraLabel, attachVideo, FaceCheck, measureFrames } from './camera.js';
import { prepareExport, saveExport, downloadLink } from './export.js';

const $ = selector => document.querySelector(selector);
const screen = $('#screen');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
let db, profile, stream, face, session, items, index = 0;
let practice = false, tutorialPage = 0, busy = false, capture = null, pendingTake = null;
let prepared = null, exportGeneration = 0, afterCamera = null, previewVisible = true;
let emergency = false;
let consentAt = null;
const practiceItems = [{ item_id: 'practice_1', text: 'おはよう', reading: '' }, { item_id: 'practice_2', text: 'ありがとう', reading: '' }];

function notice(message = '') {
  $('#notice').textContent = message;
}
function setScreen(name, html) {
  exportGeneration++;
  const keepScroll = ['recording', 'practice'].includes(name) && screen.dataset.screen === name;
  screen.dataset.screen = name;
  screen.innerHTML = html;
  screen.focus({ preventScroll: true });
  if (!keepScroll) window.scrollTo(0, 0);
  notice();
  syncControls();
}

function on(selector, action, event = 'click') {
  $(selector)?.addEventListener(event, ev => { ev.preventDefault(); void run(() => action(ev)); });
}

async function run(action) {
  if (busy) return;
  busy = true;
  syncControls();
  try { await action(); }
  catch (error) {
    if (error.name !== 'AbortError') notice(error.name === 'QuotaExceededError'
      ? '端末の空き容量が足りず保存できません。まだ次の項目へ進んでいません。ほかの不要なファイルを減らして「保存を再試行」を押してください。'
      : `操作を完了できませんでした。${error.message || error.name} 保存済みの動画は残っています。`);
  } finally {
    busy = false;
    syncControls();
    if (emergency && ['practice', 'recording'].includes(screen.dataset.screen)) {
      emergency = false;
      void run(async () => {
        await interrupt();
        notice('画面が閉じられたか、カメラが止まったため中断しました。録画途中の1問は保存していません。保存済みの続きから再開できます。');
      });
    }
  }
}

function syncControls() {
  for (const element of screen.querySelectorAll('button, input[data-sent], #camera-select')) {
    if (busy && !element.dataset.busyDisabled) {
      element.dataset.busyDisabled = element.disabled ? 'yes' : 'no';
      element.disabled = true;
    } else if (!busy && element.dataset.busyDisabled) {
      element.disabled = element.dataset.busyDisabled === 'yes';
      delete element.dataset.busyDisabled;
    }
  }
  if (['recording', 'practice'].includes(screen.dataset.screen)) {
    $('#record').disabled = busy || Boolean(capture) || Boolean(pendingTake);
    $('#next').disabled = busy || (!capture && !pendingTake);
    $('#redo').disabled = busy;
    $('#redo-prev').disabled = busy || index === 0;
    $('#interrupt').disabled = busy;
    $('#next').innerHTML = pendingTake ? '保存を再試行' : '次へ <span class="key">Space / →</span>';
  }
}

function log(event, itemId = items?.[index]?.item_id || '', epoch = Date.now()) {
  session.log.push({ item_id: itemId, event, rel_sec: Number(((epoch - session.started_at) / 1000).toFixed(4)), epoch_ms: epoch });
}
async function persist() {
  if (!practice && session) await db.put('sessions', session.key, session);
}
function liveCamera() { return stream?.getVideoTracks()[0]?.readyState === 'live'; }

function showConsent() {
  if (!CONSENT_REQUIRED) {
    setScreen('intro', `<p class="step">はじめに</p><h1>声を出さずに、口の動きを記録します。</h1><div class="prose">${escapeHtml(INTRO_TEXT)}</div><div class="actions"><button id="begin" class="primary">はじめる</button></div>`);
    on('#begin', showInfo);
    return;
  }
  setScreen('consent', `<p class="step">はじめに</p><h1>参加の説明</h1><div class="prose consent">${escapeHtml(CONSENT_TEXT)}</div><label class="check"><input type="checkbox" id="consent-check">説明を読み、参加に同意します</label><div class="actions"><button id="consent-next" class="primary" disabled>同意して進む</button></div>`);
  $('#consent-check').addEventListener('change', () => { $('#consent-next').disabled = !$('#consent-check').checked; });
  on('#consent-next', async () => {
    if (!$('#consent-check').checked) return;
    consentAt = new Date().toISOString();
    if (profile?.participant) {
      profile.consent_at = consentAt;
      profile.consent_version = CONSENT_VERSION;
      await db.put('settings', 'profile', profile);
      if (profile.tutorial_completed) await showMenu();
      else await showCamera();
    } else showInfo();
  });
}

function showInfo() {
  setScreen('info', `<p class="step">準備 1 / 2</p><h1>参加者番号を教えてください</h1><p>氏名は入力しません。年代などは答えなくてもかまいません。</p><form id="info-form" novalidate><div class="fields"><label class="field code">参加者番号（必須）<input id="participant-code" required maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="P001" aria-describedby="code-hint"><span class="small" id="code-hint">${escapeHtml(PARTICIPANT_HINT)}</span></label><label class="field">年代（任意）<select id="age-band"><option value="">回答しない</option><option value="u19">10代以下</option><option value="20s">20代</option><option value="30s">30代</option><option value="40s">40代</option><option value="50s">50代</option><option value="60plus">60代以上</option></select></label><label class="field">性別（任意）<select id="sex"><option value="">回答しない</option><option value="female">女性</option><option value="male">男性</option><option value="other">その他</option></select></label><label class="field">眼鏡（任意）<select id="glasses"><option value="">回答しない</option><option value="yes">あり</option><option value="no">なし</option></select></label></div><div class="actions"><button type="submit" id="info-next" class="primary">カメラの確認へ</button></div></form>`);
  on('#info-form', async () => {
    const code = normalizeParticipantCode($('#participant-code').value);
    $('#participant-code').value = code;
    if (!new RegExp(PARTICIPANT_PATTERN).test(code) || !/^[A-Za-z0-9_-]+$/.test(code)) { notice(PARTICIPANT_HINT); return; }
    profile = { participant: { code, age_band: $('#age-band').value, sex: $('#sex').value, glasses: $('#glasses').value }, consent_at: CONSENT_REQUIRED ? consentAt : null, consent_version: CONSENT_REQUIRED ? CONSENT_VERSION : null, tutorial_completed: false, storage_persisted: false };
    await db.put('settings', 'profile', profile);
    $('#participant-label').textContent = `参加者 ${code}`;
    await showCamera();
  }, 'submit');
}

async function showCamera(destination = null) {
  afterCamera = destination;
  setScreen('camera', `<p class="step">準備 2 / 2</p><h1>顔と口の位置を合わせましょう</h1><p>明るい場所で、カメラを顔の正面へ。スマホは立てかけて固定してください。眼鏡はそのままで大丈夫です。</p><div class="actions"><button id="camera-start" class="primary">カメラを起動</button></div><label class="field" style="max-width:640px;margin-top:20px">使うカメラ<select id="camera-select"><option value="">自動で選ぶ（スマホは前面）</option></select></label><div class="camera-stage"><video id="camera-video" autoplay muted playsinline></video><div class="guide" aria-label="口を入れる枠"></div></div><div class="actions camera-next-actions"><button id="camera-next" class="primary" disabled>この位置で進む</button></div><p id="camera-actual" class="small">カメラの使用を許可してください。音声は録音しません。</p><p id="face-status" class="face-status" role="status" data-status="loading">黄色い枠の中に口が入るように合わせます。</p><p class="small">カメラが出ないときは、アドレス欄のカメラ許可を確認し、ほかの通話アプリを閉じてください。</p>`);
  positionGuides();
  on('#camera-start', () => startCamera($('#camera-select').value));
  on('#camera-select', () => startCamera($('#camera-select').value), 'change');
  on('#camera-next', async () => {
    if (!liveCamera()) return;
    if (afterCamera) await afterCamera();
    else if (profile.tutorial_completed) await showMenu();
    else showTutorial(0);
  });
  if (liveCamera()) await displayCamera();
}

async function startCamera(deviceId) {
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  $('#camera-next').disabled = true;
  try {
    stream = await openCamera(deviceId);
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (capture) { emergency = true; void run(async () => {}); }
      else notice('カメラが停止しました。ブロックを中断し、カメラを確認してください。');
    });
    await displayCamera();
    if (!face) {
      face = new FaceCheck();
      void face.load().then(() => updateFace());
    }
  } catch (error) {
    if (session && !practice) { log('camera_error', error.name); await persist(); }
    throw new Error(`カメラを起動できません（${error.name}）。カメラの許可と、ほかのアプリで使用中でないかを確認して、もう一度起動してください。`);
  }
}

async function displayCamera() {
  await attachVideo($('#camera-video'), stream);
  $('.camera-stage').classList.add('ready');
  const settings = cameraSettings(stream);
  const devices = await navigator.mediaDevices.enumerateDevices();
  $('#camera-select').innerHTML = devices.filter(device => device.kind === 'videoinput').map((device, position) => `<option value="${escapeHtml(device.deviceId)}">カメラ ${position + 1}（${escapeHtml(sanitizeCameraLabel(device.label))}）</option>`).join('');
  $('#camera-select').value = stream.getVideoTracks()[0].getSettings().deviceId;
  $('.camera-stage').style.setProperty('--video-ratio', $('#camera-video').videoWidth / $('#camera-video').videoHeight);
  $('#camera-start').hidden = true;
  $('#camera-actual').textContent = `実際の設定：${settings.width} × ${settings.height} / ${Number(settings.frameRate || 0).toFixed(1)} fps / ${settings.label}${settings.width < 1280 || settings.height < 720 ? '。推奨より小さい画質です。別のカメラがあれば選んでください。' : ''}`;
  $('#camera-next').disabled = false;
  $('#camera-next').dataset.busyDisabled = 'no';
  updateFace();
}

function positionGuides() {
  for (const guide of screen.querySelectorAll('.guide')) {
    Object.assign(guide.style, { left: `${(1 - FACE.guide.right) * 100}%`, top: `${FACE.guide.top * 100}%`, width: `${(FACE.guide.right - FACE.guide.left) * 100}%`, height: `${(FACE.guide.bottom - FACE.guide.top) * 100}%` });
  }
}

function updateFace() {
  const video = $('#camera-video') || $('#preview');
  const target = $('#face-status');
  if (!video || !target || !face) return;
  const result = face.check(video);
  if (!result) return;
  target.textContent = result.message;
  target.dataset.status = result.status;
  if (session && !practice && screen.dataset.screen === 'recording') {
    session.face_check = result.status === 'loading' ? 'unavailable' : result.status;
    if (capture) {
      const { message, ...sample } = result;
      session.face_checks.push({ ...sample, item_id: items[index].item_id, epoch_ms: Date.now() });
    }
  }
}
setInterval(updateFace, 1000);

function showTutorial(page) {
  tutorialPage = page;
  const pages = [
    ['声を出さずに、口だけ動かす', '画面の言葉を、声を出さずにはっきり口で伝えてください。始めと終わりに口を閉じて1秒ずつ待ちます。', ['口を閉じて1秒', '口だけ動かす', '口を閉じて1秒']],
    ['「録画」から「次へ」までが1問', '「録画」を押してから始めます。最後の1秒まで待って「次へ」を押すと、その動画を保存して次の言葉が出ます。目安は1問2〜6秒です。', ['録画を押す', '口を動かす', '次へを押す']],
    ['間違えても、録り直せます', '「やり直し」は今の1問を最初から。「1つ前をやり直す」は前の1問へ戻ります。どちらも押すとすぐ録画が始まります。「中断」で休めます。', ['今の1問をやり直す', '1つ前をやり直す']],
  ];
  const [title, text, steps] = pages[page];
  setScreen('tutorial', `<p class="step">操作の練習 ${page + 1} / 3</p><h1>${title}</h1><p class="lead">${text}</p><div class="tutorial-diagram">${steps.map(step => `<span>${step}</span>`).join('')}</div><p>パソコンでは Space で録画・次へ、R でやり直し、Backspace で1つ前をやり直せます。</p><div class="actions">${page ? '<button id="tutorial-back">前の説明へ</button>' : ''}<button id="tutorial-next" class="primary">${page < 2 ? '次の説明へ' : '2問、練習してみる'}</button></div>`);
  on('#tutorial-back', () => showTutorial(tutorialPage - 1));
  on('#tutorial-next', () => page < 2 ? showTutorial(page + 1) : startPractice());
}

function makeSession(block) {
  return {
    key: sessionKey(profile.participant.code, block), participant: structuredClone(profile.participant),
    block, preset: SESSION_PRESET, blocks: structuredClone(BLOCKS), app_version: APP_VERSION, consent_required: CONSENT_REQUIRED, consent_at: profile.consent_at, consent_version: profile.consent_version, storage_persisted: profile.storage_persisted || false, started_at: Date.now(),
    device: { user_agent: navigator.userAgent, platform: navigator.platform, language: navigator.language, screen: { width: window.screen.width, height: window.screen.height, pixel_ratio: devicePixelRatio }, viewport: { width: innerWidth, height: innerHeight } },
    face_check: face?.status === 'available' ? 'available' : 'unavailable', face_checks: [],
    camera_settings: liveCamera() ? cameraSettings(stream) : {}, saved: {}, log: [], sent: false,
  };
}

async function startPractice() {
  if (!liveCamera()) { await showCamera(startPractice); return; }
  practice = true;
  items = practiceItems;
  index = 0;
  session = makeSession('practice');
  await showItem();
}

async function showMenu() {
  practice = false;
  session = null;
  pendingTake = null;
  prepared = null;
  const sessions = await Promise.all(BLOCKS.map(block => db.get('sessions', sessionKey(profile.participant.code, block.id))));
  setScreen('menu', `<p class="step">参加者 ${escapeHtml(profile.participant.code)}</p><h1>どのブロックからでも始められます</h1><p>全部で${TOTALS_TEXT}。ひと区切りずつ録って、保存して、送ります。</p><div class="blocks">${BLOCKS.map((block, position) => {
    const saved = sessions[position], count = Object.keys(saved?.saved || {}).length;
    return `<section class="block"><div><div class="block-title"><b>${block.id}</b><h2>${block.title}</h2></div><p>${block.detail} / ${block.count}問 / 約${block.minutes}分</p><progress value="${count}" max="${block.count}" aria-label="${block.id}の保存済み項目"></progress><p>${count} / ${block.count}問 保存済み</p></div><div class="block-controls"><button class="primary" data-block="${block.id}">${count === block.count ? 'ZIP保存・送信へ' : count ? '続きから録る' : 'このブロックを録る'}</button><label class="check"><input type="checkbox" data-sent="${block.id}" ${saved?.sent ? 'checked' : ''} ${saved?.zip_saved_at ? '' : 'disabled'}>送信済み</label>${count === block.count ? `<button data-redo-last="${block.id}">最後の1問をやり直す</button>` : count ? `<button data-partial="${block.id}">ここまでの分をZIPにする</button>` : ''}${count ? `<button class="small" data-reset="${block.id}">このブロックを最初から録り直す</button>` : ''}</div></section>`;
  }).join('')}</div><div class="actions"><button id="change-participant">参加者番号を直す</button><button id="tutorial-again">練習をもう一度</button><button id="camera-again">カメラを確認</button><button id="clear-data" class="danger">この端末のデータをすべて消す</button></div><p class="small">同じ端末・同じブラウザで続きを録れます。保存済みでも、ブラウザのデータ消去や空き容量不足で消えることがあります。終わったブロックは早めにZIPで保存してください。</p>`);
  for (const button of screen.querySelectorAll('[data-block]')) on(`[data-block="${button.dataset.block}"]`, () => openBlock(button.dataset.block));
  for (const checkbox of screen.querySelectorAll('[data-sent]')) checkbox.addEventListener('change', () => { void run(async () => {
    const block = checkbox.dataset.sent;
    const saved = await db.get('sessions', sessionKey(profile.participant.code, block)) || makeSession(block);
    if (!saved.zip_saved_at) { checkbox.checked = false; return; }
    saved.sent = checkbox.checked;
    try { await db.put('sessions', saved.key, saved); }
    catch (error) { checkbox.checked = !checkbox.checked; throw error; }
  }); });
  for (const button of screen.querySelectorAll('[data-reset]')) on(`[data-reset="${button.dataset.reset}"]`, async () => {
    if (!confirm(`${button.dataset.reset}の保存済み動画を消して、最初から録り直しますか？ 先に必要なZIPを保存してください。`)) return;
    const saved = await db.get('sessions', sessionKey(profile.participant.code, button.dataset.reset));
    if (saved) {
      await db.write([...Object.keys(saved.saved).map(id => ({ store: 'clips', type: 'delete', key: `${saved.key}/${id}` })), { store: 'sessions', key: saved.key, type: 'delete' }]);
    }
    await showMenu();
  });
  on('#change-participant', showChangeParticipant);
  for (const button of screen.querySelectorAll('[data-partial]')) on(`[data-partial="${button.dataset.partial}"]`, async () => {
    items = await loadItems(button.dataset.partial);
    session = await db.get('sessions', sessionKey(profile.participant.code, button.dataset.partial));
    await finishBlock(true);
  });
  for (const button of screen.querySelectorAll('[data-redo-last]')) on(`[data-redo-last="${button.dataset.redoLast}"]`, async () => {
    await openBlock(button.dataset.redoLast, true);
  });
  on('#clear-data', async () => {
    if (!confirm('このブラウザに保存した全参加者の動画・番号・進捗をすべて消します。元に戻せません。よろしいですか？')) return;
    await db.clear();
    for (const track of stream?.getTracks() || []) track.stop();
    stream = null; profile = null; session = null;
    $('#participant-label').textContent = '無声発話の研究';
    showConsent();
  });
  on('#tutorial-again', () => liveCamera() ? showTutorial(0) : showCamera(() => showTutorial(0)));
  on('#camera-again', () => showCamera());
}

function showChangeParticipant() {
  setScreen('change-participant', `<h1>参加者番号を直す</h1><p>保存した動画と進み具合を、新しい番号にまとめて移します。保存済みのZIPは、新しい番号でもう一度保存してください。</p><p>すでにGoogleフォームで送ったブロックがあれば、新しい番号でZIPを保存して送り直し、番号を直したことを実験者に伝えてください。</p><form id="change-code-form" novalidate><label class="field">参加者番号<input id="participant-code" value="${escapeHtml(profile.participant.code)}" maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="code-hint"><span class="small" id="code-hint">${escapeHtml(PARTICIPANT_HINT)}</span></label><div class="actions"><button id="change-code-save" type="submit" class="primary">この番号に直す</button><button id="cancel-change" type="button">戻る</button></div></form>`);
  on('#cancel-change', showMenu);
  on('#change-code-form', async () => {
    const code = normalizeParticipantCode($('#participant-code').value);
    $('#participant-code').value = code;
    if (!new RegExp(PARTICIPANT_PATTERN).test(code) || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) { notice(PARTICIPANT_HINT); return; }
    if (code !== profile.participant.code) profile = await changeParticipant(db, profile, code);
    prepared = null;
    $('#participant-label').textContent = `参加者 ${code}`;
    await showMenu();
  }, 'submit');
}

async function openBlock(block, redoLastOnOpen = false) {
  practice = false;
  items = await loadItems(block);
  session = await db.get('sessions', sessionKey(profile.participant.code, block)) || makeSession(block);
  session.consent_required = CONSENT_REQUIRED;
  session.consent_at = profile.consent_at;
  session.consent_version = profile.consent_version;
  session.storage_persisted = profile.storage_persisted || false;
  session.preset = SESSION_PRESET;
  session.blocks = structuredClone(BLOCKS);
  index = nextUnrecorded(items, session.saved);
  if (index === items.length) {
    if (redoLastOnOpen) await redoLast();
    else await finishBlock();
    return;
  }
  if (!liveCamera()) { await showCamera(() => openBlock(block)); return; }
  session.app_version = APP_VERSION;
  log('app_version', APP_VERSION);
  log('resume', items[index].item_id);
  await persist();
  await showItem();
}

async function showItem() {
  if (index >= items.length) {
    if (practice) {
      profile.tutorial_completed = true;
      await db.put('settings', 'profile', profile);
      await showMenu();
      notice('練習が終わりました。練習の動画は保存していません。');
    } else await finishBlock();
    return;
  }
  const item = items[index];
  log('show');
  setScreen(practice ? 'practice' : 'recording', `<div class="record-top"><div><p class="step">${practice ? '練習・保存しません' : escapeHtml((session.blocks || []).find(block => block.id === session.block)?.title || BLOCKS.find(block => block.id === session.block)?.title || '口の動きの録画')}</p><h1>${practice ? 'まずは気軽に練習' : '声を出さずに、口だけで'}</h1><span id="counter" class="counter">${index + 1} / ${items.length}</span></div><div class="corner"><div class="preview-stage" ${previewVisible ? '' : 'hidden'}><video id="preview" autoplay muted playsinline ${previewVisible ? '' : 'hidden'}></video><div class="guide" aria-label="口を入れる枠"></div></div><button id="toggle-preview" aria-pressed="${previewVisible}">${previewVisible ? '小窓を隠す' : '小窓を表示'}</button></div></div><div class="item" id="item-text">${escapeHtml(item.text)}</div>${item.reading ? `<p class="reading">${escapeHtml(item.reading)}</p>` : ''}<p class="reminder">口を閉じて1秒 → 口だけ動かす → 口を閉じて1秒</p><div class="rec-status" id="record-state" role="status" data-state="idle">録画待ち <span id="elapsed">0.0秒</span></div><div class="record-actions"><button id="record" class="primary">録画 <span class="key">Space</span></button><button id="next" class="primary" disabled>次へ <span class="key">Space / →</span></button></div><div class="secondary-actions"><button id="redo">やり直し <span class="key">R</span></button><button id="redo-prev" ${index === 0 ? 'disabled' : ''}>1つ前をやり直す <span class="key">Backspace</span></button><button id="interrupt">中断</button></div><p id="face-status" class="face-status" role="status"></p><p class="small">目安は2〜6秒。2秒より短いときは一度お知らせします。12秒になる前に自動停止します。中断すると、録画中の1問は保存しません。</p>`);
  positionGuides();
  const round = Number(item.item_id.match(/_r(\d+)$/)?.[1]);
  const previousRound = Number(items[index - 1]?.item_id.match(/_r(\d+)$/)?.[1]);
  if (!practice && round > previousRound && previousRound > 0 && !session.rounds_notified?.includes(round) && !(round === 2 && session.round2_notified)) {
    session.rounds_notified = [...(session.rounds_notified || []), round];
    if (round === 2) session.round2_notified = true;
    notice(`ここから${round}周目です（同じ単語をもう一度）`);
    await persist();
  }
  on('#record', startRecording);
  on('#next', () => finishTake(false));
  on('#redo', () => redo(false));
  on('#redo-prev', () => redo(true));
  on('#interrupt', interrupt);
  on('#toggle-preview', () => {
    previewVisible = !previewVisible;
    $('#preview').hidden = !previewVisible;
    $('.preview-stage').hidden = !previewVisible;
    $('#toggle-preview').textContent = previewVisible ? '小窓を隠す' : '小窓を表示';
    $('#toggle-preview').setAttribute('aria-pressed', String(previewVisible));
  });
  // 映像の準備に失敗しても、中断してカメラを確認する操作は残す。
  await attachVideo($('#preview'), stream);
  updateFace();
}

async function startRecording() {
  if (capture || pendingTake) return;
  if (!liveCamera()) throw new Error('カメラが停止しています。「中断」からカメラを確認してください。');
  if ($('#preview').readyState < 2 || !$('#preview').videoWidth || !$('#preview').videoHeight) throw new Error('カメラの映像を準備できていません。少し待つか、「中断」からカメラを確認してください。');
  const recorder = new MediaRecorder(stream, { mimeType: chooseMime() });
  const chunks = [];
  const attempt = { recorder, chunks, startEpoch: Date.now(), startPerf: performance.now(), settings: cameraSettings(stream), error: null };
  attempt.done = new Promise(resolve => {
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = event => { attempt.error = event.error || new Error('録画に失敗しました。'); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
  });
  recorder.start();
  attempt.measurement = measureFrames($('#preview'), attempt.settings.frameRate);
  capture = attempt;
  log('record_start', items[index].item_id, attempt.startEpoch);
  log('recording_start', items[index].item_id, attempt.startEpoch);
  log('camera_settings', `label=${attempt.settings.label}|size=${attempt.settings.width}x${attempt.settings.height}|fps=${attempt.settings.frameRate}|mime=${recorder.mimeType}`);
  session.camera_settings = attempt.settings;
  $('#record-state').dataset.state = 'recording';
  $('#record-state').innerHTML = '録画中 <span id="elapsed">0.0秒</span>';
  notice();
  attempt.ticker = setInterval(() => {
    if ($('#elapsed')) $('#elapsed').textContent = `${((performance.now() - attempt.startPerf) / 1000).toFixed(1)}秒`;
    if (performance.now() - attempt.startPerf >= LIMITS.autoStopMs && !busy) void run(() => finishTake(true));
  }, 100);
  try { await persist(); }
  catch (error) { await discardCapture('save_error'); throw error; }
}

async function stopCapture() {
  const attempt = capture;
  if (!attempt) return null;
  clearInterval(attempt.ticker);
  attempt.duration = performance.now() - attempt.startPerf;
  attempt.actual = attempt.measurement.stop();
  attempt.stopEpoch = Date.now();
  if (attempt.recorder.state !== 'inactive') attempt.recorder.stop();
  const blob = await attempt.done;
  capture = null;
  log('record_stop', items[index].item_id, attempt.stopEpoch);
  log('recording_stop', items[index].item_id, attempt.stopEpoch);
  if ($('#record-state')) {
    $('#record-state').dataset.state = 'idle';
    $('#record-state').textContent = '録画待ち';
  }
  return { ...attempt, blob };
}

async function discardCapture(reason) {
  if (capture) { await stopCapture(); log('discard', items[index].item_id); }
  if (pendingTake) log('discard', items[index].item_id);
  pendingTake = null;
  if (reason) log(reason);
}

async function finishTake(automatic) {
  if (!capture && !pendingTake) return;
  if (capture && !automatic) {
    const now = performance.now();
    if (now - capture.startPerf < 2000 && capture.shortWarnedAt === undefined) {
      capture.shortWarnedAt = now;
      log('short_warning');
      notice('口を閉じて1秒待ってから、もう一度「次へ」を押してください');
      return;
    }
    // 連打で警告が消えないよう、意図して押し直せるまで1秒待つ。
    if (capture.shortWarnedAt !== undefined && now - capture.shortWarnedAt < 1000) return;
  }
  if (!pendingTake) {
    const attempt = await stopCapture();
    if (automatic) log('max_duration_warning');
    if (attempt.error || !attempt.blob.size || attempt.duration > LIMITS.maxMs || attempt.duration < LIMITS.minMs || emergency) {
      log('discard');
      await persist();
      notice(attempt.error ? '録画に失敗しました。「録画」からもう一度お願いします。' : '動画の長さが範囲外、または画面が中断されたため保存しませんでした。もう一度録ってください。');
      return;
    }
    const item = items[index];
    const extension = attempt.blob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const metadata = { ...item, file: `clips/${item.item_id}.${extension}`, start_epoch_ms: attempt.startEpoch, duration_ms: Math.round(attempt.duration), redo_count: session.log.filter(row => row.event === 'redo' && row.item_id === item.item_id).length, width: attempt.actual.width, height: attempt.actual.height, fps: attempt.actual.fps, fps_source: attempt.actual.fps_source, camera_label: attempt.settings.label, mime: attempt.blob.type };
    pendingTake = { blob: attempt.blob, metadata };
  }
  $('#record-state').dataset.state = 'saving';
  $('#record-state').textContent = practice ? '練習を終えています' : '端末に保存しています';
  const working = structuredClone(session);
  const epoch = Date.now();
  working.log.push({ item_id: items[index].item_id, event: 'clip_saved', rel_sec: Number(((epoch - session.started_at) / 1000).toFixed(4)), epoch_ms: epoch });
  working.saved[items[index].item_id] = pendingTake.metadata;
  const nextIndex = nextUnrecorded(items, working.saved);
  working.log.push({ item_id: items[Math.min(nextIndex, items.length - 1)].item_id, event: 'next', rel_sec: Number(((epoch - session.started_at) / 1000).toFixed(4)), epoch_ms: epoch });
  try {
    if (practice) { working.saved[items[index].item_id] = pendingTake.metadata; session = working; }
    else session = await saveTake(db, working, items[index].item_id, pendingTake);
  } catch (error) {
    $('#record-state').dataset.state = 'idle';
    $('#record-state').textContent = '未保存です。「保存を再試行」を押してください';
    throw error;
  }
  prepared = null;
  if (!practice && !profile.storage_persist_requested && navigator.storage?.persist) {
    profile.storage_persist_requested = true;
    // 永続保存の失敗で、すでに保存した動画の進行は止めない。
    try {
      await db.put('settings', 'profile', profile);
      profile.storage_persisted = Boolean(await navigator.storage.persist());
      session.storage_persisted = profile.storage_persisted;
      await db.put('settings', 'profile', profile);
      await persist();
    } catch { session.storage_persisted = Boolean(profile.storage_persisted); }
  }
  pendingTake = null;
  index = nextIndex;
  const wasPractice = practice;
  await showItem();
  if (automatic) {
    const message = wasPractice
      ? `12秒に近づいたため練習を自動で停止しました。${index === items.length ? '「練習をもう一度」で試せます。' : '言い終わっていなければ「1つ前をやり直す」で試せます。'}練習の動画は保存していません。`
      : `12秒に近づいたため自動で停止・保存しました。言い終わっていなければ「${index === items.length ? '最後の1問をやり直す' : '1つ前をやり直す'}」で録り直してください。`;
    notice([$('#notice').textContent, message].filter(Boolean).join('\n'));
  }
}

async function redo(previous) {
  await discardCapture();
  const original = session, originalIndex = index, originalPrepared = prepared;
  session = structuredClone(session);
  if (previous && index > 0) {
    index--;
    log('redo_prev');
  }
  log('redo');
  prepared = null;
  session.log = session.log.filter(entry => entry.event !== 'end');
  try {
    if (practice) delete session.saved[items[index].item_id];
    else session = await removeTakes(db, session, [items[index].item_id]);
  } catch (error) {
    session = original;
    prepared = originalPrepared;
    index = originalIndex;
    throw error;
  }
  await showItem();
  await startRecording();
}

async function interrupt() {
  await discardCapture();
  log('back');
  await persist();
  await showMenu();
}

async function redoLast() {
  if (!liveCamera()) { prepared = null; await showCamera(redoLast); return; }
  index = items.length;
  await redo(true);
}

async function markZipSaved() {
  session.zip_saved_at = new Date().toISOString();
  log('zip_saved', session.block);
  await persist();
}

async function finishBlock(partial = false) {
  prepared = null;
  session.consent_required = CONSENT_REQUIRED;
  session.consent_at = profile.consent_at;
  session.consent_version = profile.consent_version;
  session.storage_persisted = Boolean(profile.storage_persisted);
  if (!partial && !session.log.some(entry => entry.event === 'end')) log('end', items.at(-1).item_id);
  session.app_version = APP_VERSION;
  if (session.log.filter(entry => entry.event === 'app_version').at(-1)?.item_id !== APP_VERSION) log('app_version', APP_VERSION);
  session.face_check = face ? (face.status === 'available' ? 'available' : 'unavailable') : (session.face_check || 'unavailable');
  setScreen('finished', `<p class="step">${session.block} / ${Object.keys(session.saved).length}問 保存済み${partial ? '（途中まで）' : ''}</p><h1>おつかれさまでした。<br>${GOOGLE_FORM_URL ? (partial ? 'ここまでの分を送りましょう。' : 'このブロックを送りましょう。') : '録った動画を保存しましょう。'}</h1><div class="zip-summary"><h2>1. ZIPファイルを保存</h2><p id="zip-name">ファイルを準備しています…</p><p id="zip-size"></p><button id="download" class="primary" disabled>ZIPを保存する</button><button id="download-fallback" hidden>ダウンロードで保存する</button><p class="small">iPhoneでは共有画面の「ファイルに保存」を選びます。共有できない場合はダウンロードで保存してください。</p></div>${GOOGLE_FORM_URL ? `<h2>2. Googleフォームで送信</h2><p>保存した ZIP を添付して送信してください（Google へのログインが必要です）</p><p>Googleフォームにアカウントの名前・メールアドレス・写真が記録されます。参加者番号を確認して送信してください。</p><a id="open-form" class="button primary" href="${escapeHtml(participantFormUrl(profile.participant.code))}" target="_blank" rel="noopener noreferrer">Googleフォームを開く</a><p>送信できたら、ブロック一覧で「送信済み」にチェックを付けてください。</p>` : '<h2>2. 実験者に連絡</h2><p>送り先はまだ設定されていません。ZIPを保存して実験者に連絡してください。</p><button id="open-form" disabled>Googleフォームを開く（未設定）</button>'}<div class="actions">${partial ? '' : '<button id="redo-last">最後の1問をやり直す</button>'}<button id="back-menu">ブロック一覧へ</button></div>`);
  on('#back-menu', showMenu);
  on('#redo-last', redoLast);
  on('#download', async () => {
    try { const message = await saveExport(prepared); await markZipSaved(); notice(message); }
    catch (error) {
      if (error.name === 'AbortError') { notice('保存を取り消しました。もう一度保存できます。'); return; }
      $('#download-fallback').hidden = false;
      throw new Error('保存画面を開けませんでした。「ダウンロードで保存する」を押してください。');
    }
  });
  on('#download-fallback', async () => { downloadLink(prepared); await markZipSaved(); notice('ダウンロード一覧で保存先を確認してください。'); });
  const generation = exportGeneration;
  try {
    const result = await prepareExport(db, session, items, { partial });
    if (generation !== exportGeneration) return;
    prepared = result;
    $('#zip-name').textContent = result.name;
    $('#zip-size').textContent = `${(result.blob.size / 1024 ** 2).toFixed(2)} MB（${result.blob.size.toLocaleString()} バイト）`;
    $('#download').disabled = false;
    $('#download').dataset.busyDisabled = 'no';
  } catch (error) {
    $('#zip-name').textContent = 'ZIPを準備できませんでした。';
    throw error;
  }
}

document.addEventListener('keydown', event => {
  if (!['recording', 'practice'].includes(screen.dataset.screen) || event.repeat || event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  const action = { Space: () => capture || pendingTake ? finishTake(false) : startRecording(), ArrowRight: () => finishTake(false), KeyR: () => redo(false), Backspace: () => index > 0 ? redo(true) : undefined }[event.code];
  if (action) { event.preventDefault(); void run(action); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && capture) { emergency = true; void run(async () => {}); }
});
window.addEventListener('pagehide', () => {
  if (capture?.recorder.state === 'recording') capture.recorder.stop();
  for (const track of stream?.getTracks() || []) track.stop();
});
window.addEventListener('beforeunload', event => {
  if (capture || pendingTake || busy) { event.preventDefault(); event.returnValue = ''; }
});

async function initialize() {
  if (window.__unsupportedBrowser) return;
  $('#version').textContent = `版 ${APP_VERSION}`;
  try {
    db = await Database.open();
    profile = await db.get('settings', 'profile');
    if (profile?.participant && (!CONSENT_REQUIRED || (profile.consent_at && profile.consent_version === CONSENT_VERSION))) {
      $('#participant-label').textContent = `参加者 ${profile.participant.code}`;
      if (profile.tutorial_completed) await showMenu();
      else await showCamera();
    } else showConsent();
  } catch (error) {
    setScreen('error', '<h1>このブラウザに保存できません</h1><p>通常のブラウザ画面で開き、端末の空き容量を確認してください。プライベートブラウズでは保存が制限されることがあります。</p>');
    notice(error.message);
  }
}

// 同じ保存領域を複数タブから書き換えない。ロックはタブを閉じると解除される。
if (navigator.locks) {
  void navigator.locks.request('vsr-collect-v1-writer', { ifAvailable: true }, async lock => {
    if (!lock) { setScreen('locked', '<h1>ほかのタブで開いています</h1><p>先に開いたタブを使うか、閉じてからこのページを開き直してください。</p>'); return; }
    await initialize();
    await new Promise(() => {});
  });
} else void initialize();
