// Marca do parceiro nos painéis (Parceria, 25/10/2026): para o parceiro e
// para os clientes dele, o painel mostra o nome, a logo e a cor do parceiro,
// o "← Site" e o "Sair" levam para a página dele e o WhatsApp flutuante vai
// para o WhatsApp dele — o site parece dele, com domínio próprio ou não. Os
// dados vêm de /api/auth/me (campo parceiro, ver marcaParceiroDoUsuario no
// server.js). Tudo que é do parceiro entra por textContent/atributo, nunca
// innerHTML.
(function () {
  let marca = null;

  // Página de entrada depois de sair: a do parceiro (com a aba Entrar aberta)
  // ou o /entrar de sempre.
  window.urlSaidaParceiro = function () {
    if (!marca) return '/entrar';
    return marca.url + (marca.url.includes('?') ? '&' : '?') + 'entrar=1';
  };

  window.aplicarMarcaParceiro = function (parceiro, opcoes) {
    marca = parceiro || null;
    if (!marca) return;
    const { subtitulo } = opcoes || {};
    document.title = document.title.replace('DESPACHANTES CONSULTAS', marca.nome);

    const nome = document.getElementById('marca-nome');
    if (nome) nome.textContent = marca.nome;
    const sub = document.getElementById('marca-sub');
    if (sub && subtitulo) sub.textContent = subtitulo;
    const caixa = document.getElementById('marca-logo');
    if (caixa && marca.logo) {
      const img = document.createElement('img');
      img.src = marca.logo;
      img.alt = '';
      img.className = 'w-9 h-9 rounded-lg object-contain bg-white p-0.5';
      caixa.replaceWith(img);
    }
    if (marca.cor) {
      const barra = document.getElementById('sidebar');
      if (barra) barra.style.backgroundColor = marca.cor;
    }
    document.querySelectorAll('a.link-site').forEach(a => { a.href = marca.url; });

    const zap = document.getElementById('whatsapp-flutuante');
    if (zap) {
      if (marca.whatsapp) zap.href = `https://wa.me/55${encodeURIComponent(marca.whatsapp)}`;
      else zap.remove();
    }
    const seja = document.getElementById('btn-seja-parceiro');
    if (seja) seja.remove();
  };
})();
