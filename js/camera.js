import { FACE } from '../config.js';

// 録画中の符号化設定の変化を保持できるavc3を優先し、未対応環境は従来形式へ戻す。
export const MIME_TYPES = ['video/mp4;codecs=avc3', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
export function chooseMime(recorder = globalThis.MediaRecorder) {
  const mime = MIME_TYPES.find(value => recorder?.isTypeSupported(value));
  if (!mime) throw new Error('このブラウザでは動画を録れません。新しいChrome・Edge・Safariで開いてください。');
  return mime;
}

export async function openCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラが使えません。https または localhost のURLで開いてください。');
  chooseMime();
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'user' } }),
      width: { min: 1280, ideal: 1920 }, height: { min: 720, ideal: 1080 }, frameRate: { ideal: 30 },
    },
  }).catch(async error => {
    if (error.name !== 'OverconstrainedError') throw error;
    // 小さいカメラでも実測値と注意を残して続行できる。
    return navigator.mediaDevices.getUserMedia({ audio: false, video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'user' } }),
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
    } });
  });
}

export function cameraSettings(stream) {
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  const result = { label: sanitizeCameraLabel(track.label) };
  for (const key of ['width', 'height', 'frameRate', 'aspectRatio', 'resizeMode', 'facingMode']) {
    if (settings[key] !== undefined) result[key] = settings[key];
  }
  return result;
}

export function sanitizeCameraLabel(label) {
  // 機器名には所有者名やファイルの場所が入るため、元の文字列は残さない。
  const value = String(label || '');
  if (/[/\\]/.test(value)) return 'カメラ';
  if (/iphone/i.test(value)) return 'iPhone連係カメラ';
  if (/ipad/i.test(value)) return 'iPadカメラ';
  if (/facetime|built[ -]?in|integrated|内蔵/i.test(value)) return '内蔵カメラ';
  if (/front|前面/i.test(value)) return '前面カメラ';
  if (/back|rear|背面/i.test(value)) return '背面カメラ';
  return 'カメラ';
}

export function measureFrames(video, nominal) {
  const measurement = { width: video.videoWidth, height: video.videoHeight, fps: nominal || 0, fps_source: 'nominal' };
  let active = true, callback, first, last, count = 0;
  const sample = (_, metadata) => {
    if (!active) return;
    first ??= metadata.mediaTime;
    last = metadata.mediaTime;
    count++;
    callback = video.requestVideoFrameCallback(sample);
  };
  if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(sample);
  return { stop() {
    active = false;
    if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
    if (count > 1 && last > first) {
      measurement.fps = Number(((count - 1) / (last - first)).toFixed(3));
      measurement.fps_source = 'measured';
    }
    return measurement;
  } };
}

export async function attachVideo(video, stream) {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  let timer;
  try {
    await Promise.race([video.play(), new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused) resolve();
        else reject(new Error('映像の準備に時間がかかっています。カメラを確認してもう一度試してください。'));
      }, 8000);
    })]);
  } finally { clearTimeout(timer); }
}

export class FaceCheck {
  constructor() {
    this.status = 'loading';
    this.detector = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 64;
    this.canvas.height = 36;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.lastTime = -1;
    this.exceptions = 0;
    this.retryScheduled = false;
  }

  async load() {
    this.status = 'loading';
    let expired = false, timer;
    const loading = (async () => {
      const vision = await import(FACE.moduleUrl);
      const files = await vision.FilesetResolver.forVisionTasks(FACE.wasmUrl);
      const detector = await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE.modelUrl, delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 1,
      });
      if (expired) { detector.close(); return; }
      this.detector?.close();
      this.detector = detector;
    })();
    try {
      await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('顔チェックの読み込み時間切れ')), FACE.timeoutMs);
      })]);
      this.status = 'available';
      this.exceptions = 0;
      // 復旧後の別の障害にも、一度だけ再試行できるように戻す。
      this.retryScheduled = false;
    } catch {
      expired = true;
      this.status = 'unavailable';
      this.scheduleRetry();
    } finally { clearTimeout(timer); }
    return this.status;
  }

  scheduleRetry() {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    setTimeout(() => void this.load(), 30000);
  }

  check(video) {
    if (video.readyState < 2 || video.currentTime === this.lastTime) return null;
    this.lastTime = video.currentTime;
    let meanLuma = null;
    try {
      this.context.drawImage(video, 0, 0, 64, 36);
      const pixels = this.context.getImageData(0, 0, 64, 36).data;
      let total = 0;
      for (let index = 0; index < pixels.length; index += 4) total += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
      meanLuma = total / (64 * 36);
    } catch { /* 映像の準備前は次のフレームで明るさを確認する。 */ }
    const dark = meanLuma !== null && meanLuma < FACE.minLuma;
    const fallback = () => ({ status: this.status, mean_luma: meanLuma, too_dark: dark, message: [dark ? '暗すぎます。顔の前から明かりを当ててください。' : '', this.status === 'loading' ? '顔の確認を準備中です。枠を目安に位置を合わせてください。' : '自動チェックは使えません。枠を目安に位置を合わせて、そのまま進めます。'].filter(Boolean).join(' ') });
    if (this.status !== 'available') return fallback();
    try {
      const result = this.detector.detectForVideo(video, performance.now());
      this.exceptions = 0;
      const landmarks = result.faceLandmarks[0];
      const messages = [], guide = FACE.guide;
      if (dark) messages.push('暗すぎます。顔の前から明かりを当ててください。');
      if (!landmarks) return { status: 'available', face_found: false, mean_luma: meanLuma, too_dark: dark, message: ['顔が見つかりません。顔を正面に向けてください。', ...messages].join(' ') };
      const mouth = [61, 291, 0, 17, 13, 14, 78, 308].map(index => landmarks[index]);
      const width = Math.abs(landmarks[291].x - landmarks[61].x);
      const inside = mouth.every(point => point.x >= guide.left && point.x <= guide.right && point.y >= guide.top && point.y <= guide.bottom);
      const far = width < FACE.minMouthWidth;
      messages.unshift(inside ? '顔が見つかりました。口が枠に入っています。' : '顔が見つかりました。口を枠の中へ合わせてください。');
      if (far) messages.push('遠すぎます。カメラに少し近づいてください。');
      return { status: 'available', face_found: true, mouth_inside: inside, mouth_width: width, too_far: far, too_dark: dark, mean_luma: meanLuma, message: messages.join(' ') };
    } catch {
      this.exceptions++;
      if (this.exceptions < 3) return null;
      this.status = 'unavailable';
      this.scheduleRetry();
      return fallback();
    }
  }
}
