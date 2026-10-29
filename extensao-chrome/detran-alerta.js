// Roda no "mundo" da própria página do Detran (world: MAIN), antes dos
// scripts dela. O site avisa recusa (placa, DUDA, captcha…) por alert(), que o
// detran.js — num mundo isolado — não enxerga. Aqui o alert continua aparecendo
// igual, e o texto fica num atributo do <html> para o detran.js ler e pôr no
// andamento. Não lê nem muda mais nada da página.
(function () {
  const original = window.alert;
  window.alert = function (msg) {
    try {
      const lista = JSON.parse(document.documentElement.getAttribute('data-detran-alertas') || '[]');
      lista.push(String(msg));
      document.documentElement.setAttribute('data-detran-alertas', JSON.stringify(lista.slice(-10)));
    } catch (e) { /* segue com o alert */ }
    return original.call(window, msg);
  };
})();
