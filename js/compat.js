// モジュールを読めないブラウザでも、白い画面にしない。
(function () {
  var message = 'このブラウザでは使えません。最新の Chrome か Safari で開いてください';
  var script = document.createElement('script');
  if (!('noModule' in script) || !window.indexedDB || !window.MediaRecorder || !Object.hasOwn || !window.structuredClone) {
    window.__unsupportedBrowser = true;
    document.getElementById('screen').textContent = message;
  }
  var ua = navigator.userAgent;
  if (/Line\/|Instagram|FBAN|FBAV|Twitter|\bX\/|TikTok|musical_ly|Bytedance/i.test(ua)) {
    var banner = document.createElement('aside');
    banner.className = 'browser-banner';
    banner.setAttribute('role', 'status');
    banner.appendChild(document.createTextNode('このアプリの中のブラウザでは録画や保存がうまくいかないことがあります。Safari か Chrome で開き直してください'));
    var button = document.createElement('button');
    button.textContent = 'URLをコピー';
    button.onclick = function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(location.href).then(function () { button.textContent = 'コピーしました'; }, function () { showUrl(); });
      } else showUrl();
    };
    function showUrl() {
      var input = banner.querySelector('input');
      if (!input) {
        input = document.createElement('input');
        input.value = location.href;
        input.readOnly = true;
        input.setAttribute('aria-label', 'このページのURL（選択してコピーしてください）');
        banner.appendChild(input);
      }
      input.select();
    }
    banner.appendChild(button);
    document.body.insertBefore(banner, document.getElementById('screen'));
  }
}());
