// Popup de instalação: no mobile (Android e iOS) oferece criar um atalho na
// tela de início (PWA); em desktop (Windows/Mac/Linux) mostra um botão
// flutuante para instalar o site como app. Android usa o evento nativo
// beforeinstallprompt do Chrome; iOS Safari não expõe esse evento, então
// mostramos instruções manuais (compartilhar → adicionar à tela de início).
(function () {
  var ua = navigator.userAgent || '';
  var isAndroid = /Android/i.test(ua);
  var isIOS = /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS se identifica como Mac
  var isMobile = isAndroid || isIOS;
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  // Já instalado/aberto como app — não mostra nenhum popup de instalação.
  if (isStandalone) return;

  function popupShell(bodyHtml) {
    var el = document.createElement('div');
    el.id = 'pwa-shortcut-popup';
    el.setAttribute('role', 'dialog');
    el.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;';
    el.innerHTML =
      '<div style="width:100%;max-width:480px;background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;border-radius:1rem 1rem 0 0;padding:1.25rem 1.25rem 1.5rem;box-shadow:0 -8px 30px rgba(0,0,0,.35);animation:pwaSlideUp .35s cubic-bezier(.175,.885,.32,1.275) both;">' +
        bodyHtml +
      '</div>';
    document.body.appendChild(el);

    if (!document.getElementById('pwa-shortcut-style')) {
      var style = document.createElement('style');
      style.id = 'pwa-shortcut-style';
      style.textContent = '@keyframes pwaSlideUp{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}}';
      document.head.appendChild(style);
    }

    function close() {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 250);
    }
    return { el: el, close: close };
  }

  function header(subtitle) {
    return (
      '<div style="display:flex;align-items:center;gap:.75rem;">' +
        '<img src="/apple-touch-icon.png" alt="" style="width:48px;height:48px;border-radius:12px;flex-shrink:0;">' +
        '<div style="flex:1;">' +
          '<div style="font-weight:800;font-size:1rem;">Adicione à Tela de Início</div>' +
          '<div style="font-size:.8rem;color:#bfdbfe;margin-top:.15rem;">' + subtitle + '</div>' +
        '</div>' +
        '<button id="pwa-shortcut-close" aria-label="Fechar" style="background:rgba(255,255,255,.12);border:none;color:#fff;width:28px;height:28px;border-radius:50%;font-size:1.1rem;line-height:1;flex-shrink:0;cursor:pointer;">&times;</button>' +
      '</div>'
    );
  }

  // ── iOS: instruções manuais (Safari não permite disparar isso via JS) ──────
  function showIosShortcutPopup() {
    var body =
      header('Acesso rápido direto da tela do seu iPhone/iPad.') +
      '<div style="font-size:.85rem;line-height:1.6;margin-top:1rem;color:#e2e8f0;">' +
        '<div style="display:flex;gap:.6rem;align-items:center;margin-bottom:.5rem;">' +
          '<span style="background:rgba(255,255,255,.12);border-radius:.5rem;width:24px;height:24px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:700;">1</span>' +
          '<span>Toque no ícone <strong>Compartilhar</strong> (□ com seta pra cima) na barra do Safari.</span>' +
        '</div>' +
        '<div style="display:flex;gap:.6rem;align-items:center;">' +
          '<span style="background:rgba(255,255,255,.12);border-radius:.5rem;width:24px;height:24px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:700;">2</span>' +
          '<span>Toque em <strong>"Adicionar à Tela de Início"</strong>.</span>' +
        '</div>' +
      '</div>' +
      '<button id="pwa-shortcut-ok" style="width:100%;margin-top:1.1rem;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:700;font-size:.9rem;padding:.75rem 1rem;border:none;border-radius:.65rem;cursor:pointer;">Entendi</button>';

    var popup = popupShell(body);
    document.getElementById('pwa-shortcut-close').onclick = popup.close;
    document.getElementById('pwa-shortcut-ok').onclick = popup.close;
  }

  // ── Android: dispara o prompt nativo do Chrome dentro do nosso popup ───────
  function showAndroidShortcutPopup(deferredPrompt) {
    var body =
      header('Acesso mais rápido direto do seu celular Android.') +
      '<div style="display:flex;gap:.6rem;margin-top:1.1rem;">' +
        '<button id="pwa-shortcut-add" style="flex:1;text-align:center;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:700;font-size:.9rem;padding:.75rem 1rem;border:none;border-radius:.65rem;cursor:pointer;">➕ Adicionar</button>' +
        '<button id="pwa-shortcut-later" style="background:rgba(255,255,255,.1);color:#94a3b8;border:1px solid rgba(255,255,255,.15);font-weight:600;font-size:.85rem;padding:.75rem 1rem;border-radius:.65rem;cursor:pointer;">Agora não</button>' +
      '</div>';

    var popup = popupShell(body);
    document.getElementById('pwa-shortcut-close').onclick = popup.close;
    document.getElementById('pwa-shortcut-later').onclick = popup.close;
    document.getElementById('pwa-shortcut-add').onclick = function () {
      popup.close();
      deferredPrompt.prompt();
    };
  }

  if (isIOS) {
    document.addEventListener('DOMContentLoaded', showIosShortcutPopup);
  }

  if (isAndroid) {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      showAndroidShortcutPopup(e);
    });
  }

  // ── Desktop: botão flutuante (Windows/Mac/Linux) ────────────────────────────
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
