/* ── Tema claro/escuro ─────────────────────────────────────────────────────────
 *
 * Carregado SEM defer/async no <head>: a classe precisa entrar no <html> antes
 * da primeira pintura, senão a tela pisca branca antes de escurecer.
 *
 * Precedência: escolha manual (localStorage) > preferência do sistema
 * (prefers-color-scheme) > claro. Enquanto o usuário não clicar no botão, o
 * tema acompanha o sistema — inclusive se ele mudar com a página aberta.
 *
 * O botão é criado por aqui em todas as páginas (canto inferior direito). Para
 * fixá-lo em outro lugar, basta a página trazer um elemento com
 * [data-tema-toggle]: existindo um, ele é usado e nada flutuante é criado.
 *
 * Ver assets/tema.css para as cores.
 */
(function () {
  var CHAVE = 'mcd-tema';           // 'dark' | 'light' | ausente = segue o sistema
  var raiz  = document.documentElement;

  function salvo() {
    try { return localStorage.getItem(CHAVE); } catch (e) { return null; }  // modo anônimo/cookies bloqueados
  }
  function sistemaEscuro() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function escuroAgora() {
    var s = salvo();
    return s ? s === 'dark' : sistemaEscuro();
  }
  function aplicar(escuro) {
    raiz.classList.toggle('dark', escuro);
    var btn = document.querySelector('[data-tema-toggle]');
    if (btn) {
      btn.textContent   = escuro ? '☀️' : '🌙';
      btn.title         = escuro ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', String(escuro));
    }
  }

  // Antes da primeira pintura — o botão ainda não existe, e tudo bem: aplicar()
  // só cuida dele quando existe.
  aplicar(escuroAgora());

  function montar() {
    var btn = document.querySelector('[data-tema-toggle]');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tema-toggle';
      btn.setAttribute('data-tema-toggle', '');
      document.body.appendChild(btn);
    }
    btn.addEventListener('click', function () {
      var escuro = !raiz.classList.contains('dark');
      try { localStorage.setItem(CHAVE, escuro ? 'dark' : 'light'); } catch (e) {}
      aplicar(escuro);
    });
    aplicar(escuroAgora());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar);
  else montar();

  // Sistema mudou de tema: só acompanha quem ainda não escolheu na mão.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var aoMudar = function (e) { if (!salvo()) aplicar(e.matches); };
    if (mq.addEventListener) mq.addEventListener('change', aoMudar);
    else if (mq.addListener) mq.addListener(aoMudar);         // Safari antigo
  }
})();
