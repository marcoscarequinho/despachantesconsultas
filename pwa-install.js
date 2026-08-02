// Popup de instalação: no Android mostra um card oferecendo o download do
// .apk; em desktop (Windows/Mac/Linux) mostra um botão flutuante para
// instalar o site como app via PWA (evento beforeinstallprompt do Chrome/Edge).
// No iOS não faz nada — o .apk não roda lá e o fluxo de "Adicionar à Tela de
// Início" do Safari não tem como ser disparado por JS.
(function () {
  var ua = navigator.userAgent || '';
  var isAndroid = /Android/i.test(ua);
  var isIOS = /iPhone|iPad|iPod/i.test(ua);
  var isMobile = isAndroid || isIOS;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  if (isAndroid) {
    document.addEventListener('DOMContentLoaded', showApkInstallPopup);
  }

  function showApkInstallPopup() {
    var el = document.createElement('div');
    el.id = 'pwa-apk-popup';
    el.setAttribute('role', 'dialog');
    el.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;';
    el.innerHTML =
      '<div style="width:100%;max-width:480px;background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;border-radius:1rem 1rem 0 0;padding:1.25rem 1.25rem 1.5rem;box-shadow:0 -8px 30px rgba(0,0,0,.35);animation:pwaSlideUp .35s cubic-bezier(.175,.885,.32,1.275) both;">' +
        '<div style="display:flex;align-items:center;gap:.75rem;">' +
          '<img src="/apple-touch-icon.png" alt="" style="width:48px;height:48px;border-radius:12px;flex-shrink:0;">' +
          '<div style="flex:1;">' +
            '<div style="font-weight:800;font-size:1rem;">Instale o app DESPACHANTES CONSULTAS</div>' +
            '<div style="font-size:.8rem;color:#bfdbfe;margin-top:.15rem;">Acesso mais rápido direto no seu celular Android.</div>' +
          '</div>' +
          '<button id="pwa-apk-close" aria-label="Fechar" style="background:rgba(255,255,255,.12);border:none;color:#fff;width:28px;height:28px;border-radius:50%;font-size:1.1rem;line-height:1;flex-shrink:0;cursor:pointer;">&times;</button>' +
        '</div>' +
        '<div style="font-size:.75rem;color:#fde68a;background:rgba(250,204,21,.12);border:1px solid rgba(250,204,21,.3);border-radius:.6rem;padding:.5rem .65rem;margin-top:.85rem;">' +
          '⚠️ O Android pode avisar que o app é de "fonte desconhecida" — isso é normal para apps fora da Play Store. Toque em "Instalar assim mesmo".' +
        '</div>' +
        '<div style="display:flex;gap:.6rem;margin-top:1rem;">' +
          '<a href="/despachantes-consultas.apk" download ' +
             'style="flex:1;text-align:center;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:700;font-size:.9rem;padding:.75rem 1rem;border-radius:.65rem;text-decoration:none;">' +
            '⬇️ Baixar App (.apk)' +
          '</a>' +
          '<button id="pwa-apk-later" style="background:rgba(255,255,255,.1);color:#94a3b8;border:1px solid rgba(255,255,255,.15);font-weight:600;font-size:.85rem;padding:.75rem 1rem;border-radius:.65rem;cursor:pointer;">Agora não</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    var style = document.createElement('style');
    style.textContent = '@keyframes pwaSlideUp{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}}';
    document.head.appendChild(style);

    function close() {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 250);
    }
    document.getElementById('pwa-apk-close').onclick = close;
    document.getElementById('pwa-apk-later').onclick = close;
  }

  if (!isMobile) {
    var deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      showDesktopInstallButton();
    });

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      var btn = document.getElementById('pwa-desktop-install-btn');
      if (btn) btn.remove();
    });

    function showDesktopInstallButton() {
      if (document.getElementById('pwa-desktop-install-btn')) return;
      var btn = document.createElement('button');
      btn.id = 'pwa-desktop-install-btn';
      btn.type = 'button';
      btn.innerHTML = '💻 Instalar App';
      btn.style.cssText = 'position:fixed;bottom:1.25rem;right:1.25rem;z-index:9996;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:700;font-size:.85rem;padding:.75rem 1.1rem;border:none;border-radius:.75rem;box-shadow:0 8px 24px rgba(249,115,22,.4);cursor:pointer;';
      btn.onclick = function () {
        if (!deferredPrompt) return;
        btn.disabled = true;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () {
          deferredPrompt = null;
          btn.remove();
        });
      };
      document.body.appendChild(btn);
    }
  }
})();
