// Agendamento Detran RJ como página do site (/extensao-chrome).
//
// A página é o MESMO painel.html de ferramentas/agendamento-detran (o que abre
// em http://localhost:3939). Lá quem responde /api/dados, /api/agendar,
// /api/andamento… é o servidor.js, que roda o agendar.js com o Chrome do
// computador. Aqui este script responde no lugar dele, sem mudar o painel:
//
// - com a extensão Despachantes Consultas (1.2.0+), pela ponte-site.js: a lista
//   fica no chrome.storage da extensão e o background.js abre o Detran, para no
//   captcha e tenta de novo — o papel do agendar.js;
// - sem a extensão, a lista fica no localStorage deste navegador e "Agendar"
//   explica como instalar. Quando a extensão aparece, a lista passa para ela.
//
// Em nenhum dos dois casos a lista (CPF, renavam) vai para o servidor do site.
(function () {
  'use strict';

  const CHAVE_LOCAL = 'agendamentoDetranWeb';
  const VAZIO = { opcoes: { intervaloMinutos: 15, maxTentativas: 0 }, veiculos: [] };
  const ZIP = '/assets/extensao-chrome.zip';
  const LOJA = 'https://chromewebstore.google.com/detail/despachantes-consultas/cjplmhogifgnenghbgkihdpkghghbiji?hl=pt-BR';

  // ---------- ponte com a extensão (postMessage ↔ ponte-site.js) ----------
  let seq = 0;
  const pendentes = {};
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || !m.deExtensao || !pendentes[m.id]) return;
    pendentes[m.id](m.resposta);
    delete pendentes[m.id];
  });
  function pedir(op, extra, ms) {
    return new Promise((ok, falha) => {
      const id = ++seq;
      pendentes[id] = ok;
      window.postMessage({ paraExtensao: true, id, op, ...extra }, location.origin);
      if (ms) setTimeout(() => { if (pendentes[id]) { delete pendentes[id]; falha(new Error('sem resposta')); } }, ms);
    });
  }

  // A ponte é content script em document_start: responde logo, mas a primeira
  // mensagem pode sair antes de ela ouvir — por isso algumas tentativas.
  const extensao = (async () => {
    for (let i = 0; i < 5; i++) {
      try { return await pedir('ping', {}, 400); } catch (e) { /* de novo */ }
    }
    return null;
  })();

  // ---------- armazenamento ----------
  function lerLocal() {
    try { return JSON.parse(localStorage.getItem(CHAVE_LOCAL)) || null; } catch (e) { return null; }
  }

  async function lerDados() {
    if (await extensao) {
      const r = await pedir('ler', { chaves: ['agendDados'] });
      return r.agendDados || structuredClone(VAZIO);
    }
    return lerLocal() || structuredClone(VAZIO);
  }

  async function lerJob() {
    if (!(await extensao)) return null;
    return (await pedir('ler', { chaves: ['agendJob'] })).agendJob || null;
  }

  // O background.js acha cada veículo da fila pelo id; o painel não tem ids.
  function comIds(d) {
    d.veiculos = (d.veiculos || []).map((v) => (v.id ? v : { ...v, id: crypto.randomUUID() }));
    d.opcoes = { ...VAZIO.opcoes, ...(d.opcoes || {}) };
    return d;
  }

  async function gravarDados(d) {
    d = comIds(d);
    if (await extensao) {
      const r = await pedir('gravar', { obj: { agendDados: d } });
      if (r && r.erro) throw new Error(r.erro);
    } else {
      localStorage.setItem(CHAVE_LOCAL, JSON.stringify(d));
    }
  }

  // Lista digitada antes de instalar a extensão: passa para ela uma vez.
  const migracao = extensao.then(async (ext) => {
    const local = lerLocal();
    if (!ext || !local || !(local.veiculos || []).length) return;
    const atual = (await pedir('ler', { chaves: ['agendDados'] })).agendDados;
    if (atual && (atual.veiculos || []).length) return;
    await pedir('gravar', { obj: { agendDados: comIds(local) } });
    localStorage.removeItem(CHAVE_LOCAL);
  });

  // Mesmas regras do validar() do agendar.js: lá o erro saía no andamento;
  // aqui volta antes de abrir o Detran (poupa um captcha perdido).
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');
  function validar(v) {
    const erros = [];
    if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(String(v.placa || '').toUpperCase())) erros.push('placa inválida');
    if (!/^\d{9,11}$/.test(soDigitos(v.renavam))) erros.push('renavam inválido');
    const doc = soDigitos(v.cpfCnpj);
    if (doc.length !== 11 && doc.length !== 14) erros.push('CPF/CNPJ deve ter 11 ou 14 dígitos');
    if (!/^\d{8}$/.test(soDigitos(v.cep))) erros.push('CEP inválido');
    if (v.servico === 'propriedade') {
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(v.dataVenda || '')) erros.push('data da venda no formato dd/mm/aaaa');
      if (!soDigitos(v.duda)) erros.push('informe o DUDA');
    }
    if (v.servico === 'jurisdicao' && !v.ufOrigem) erros.push('informe a UF de origem');
    if (String(v.solicitante) === '03' && !soDigitos(v.matriculaDespachante)) erros.push('informe a matrícula do despachante');
    if (!v.cidade && !v.posto) erros.push('informe a cidade e/ou o posto');
    return erros;
  }

  // ---------- as rotas do servidor.js ----------
  let etapaAnterior = null;
  const rotas = {
    'GET /api/dados': async () => [200, await lerDados()],

    'GET /api/ambiente': async () => [200, { whatsapp: false }],

    'PUT /api/dados': async (corpo) => {
      const job = await lerJob();
      if (job && job.ativo) return [409, { erro: 'Espere o agendamento em andamento terminar (ou pare) antes de salvar.' }];
      if (!corpo || !Array.isArray(corpo.veiculos)) return [400, { erro: 'dados inválidos' }];
      await gravarDados(corpo);
      return [200, { ok: true }];
    },

    'POST /api/agendar': async (corpo) => {
      if (!(await extensao)) {
        mostrarInstalar(true);
        return [400, { erro: 'Para agendar, instale a extensão do Chrome (instruções no topo da página). Os veículos que você salvou aqui passam para ela sozinhos.' }];
      }
      const job = await lerJob();
      if (job && job.ativo) return [409, { erro: 'Já tem um agendamento rodando.' }];
      const d = await lerDados();
      const placa = corpo && corpo.placa ? String(corpo.placa).toUpperCase() : null;
      const lista = d.veiculos.filter((v) => !v.feito && (!placa || String(v.placa).toUpperCase() === placa));
      if (!lista.length) return [400, { erro: placa ? 'Esse veículo já foi agendado ou não está salvo.' : 'Nenhum veículo pendente para agendar.' }];
      const problemas = lista.map((v) => [v, validar(v)]).filter(([, e]) => e.length);
      if (problemas.length) return [400, { erro: problemas.map(([v, e]) => `${v.placa || 'Sem placa'}: ${e.join('; ')}`).join(' · ') }];
      const r = await pedir('enviar', { msg: { tipo: 'iniciar', ids: lista.map((v) => v.id), teste: !!(corpo && corpo.teste) } });
      if (r && r.erro) return [409, { erro: r.erro }];
      etapaAnterior = null;
      return [200, { ok: true }];
    },

    'POST /api/parar': async () => {
      if (await extensao) await pedir('enviar', { msg: { tipo: 'parar' } });
      return [200, { ok: true }];
    },

    // O painel pede "a partir da linha N"; o log do job é a lista de linhas.
    'GET /api/andamento': async (corpo, url) => {
      const job = await lerJob();
      const log = (job && job.log) || [];
      let desde = Number(url.searchParams.get('desde')) || 0;
      if (desde > log.length) desde = 0; // outro agendamento começou
      const linhas = log.slice(desde);
      // O painel tira o aviso amarelo ao ver "captcha marcado"; o log da
      // extensão não tem essa linha, então ela é deduzida da etapa do job.
      const etapa = job && job.ativo ? job.etapa : null;
      if (etapaAnterior === 'captcha' && etapa && etapa !== 'captcha') linhas.push('(captcha marcado)');
      etapaAnterior = etapa;
      return [200, { rodando: !!(job && job.ativo), inicio: 0, proximo: log.length, linhas }];
    },
  };

  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async function (entrada, opcoes) {
    const url = new URL(typeof entrada === 'string' ? entrada : entrada.url, location.href);
    const metodo = ((opcoes && opcoes.method) || 'GET').toUpperCase();
    const rota = url.origin === location.origin && rotas[`${metodo} ${url.pathname}`];
    if (!rota) return fetchOriginal(entrada, opcoes);
    await migracao.catch(() => {});
    let status, corpo;
    try {
      const enviado = opcoes && opcoes.body ? JSON.parse(opcoes.body) : null;
      [status, corpo] = await rota(enviado, url);
    } catch (e) {
      [status, corpo] = [500, { erro: e.message }];
    }
    return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
  };

  // ---------- o que muda na tela ----------
  const ESTILO = `
    .faixa-site { background:#0f172a; color:#cbd5e1; font:13px system-ui, "Segoe UI", Arial, sans-serif; padding:8px 20px; display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .faixa-site a { color:#fff; text-decoration:none; font-weight:600; }
    #instalar-extensao { background:#fff; border:2px solid #16a34a; border-radius:10px; padding:16px; font-size:14px; line-height:1.5; }
    #instalar-extensao h2 { font-size:17px; margin:0 0 6px; }
    #instalar-extensao ol { margin:6px 0; padding-left:20px; }
    #instalar-extensao code { background:#eef2f7; padding:1px 5px; border-radius:4px; }
    #instalar-extensao .botoes { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    #instalar-extensao .botoes a { text-decoration:none; border-radius:7px; padding:8px 14px; font-weight:700; background:#15803d; color:#fff; }
    #instalar-extensao .botoes a.sec { background:#e8f0fb; color:#0b4f9c; }
    #instalar-extensao .aviso { background:#fffbeb; border:1px solid #fcd34d; color:#92400e; border-radius:8px; padding:8px 10px; font-size:13px; margin-top:10px; }
  `;

  function mostrarInstalar(rolar) {
    const caixa = document.getElementById('instalar-extensao');
    if (!caixa) return;
    caixa.hidden = false;
    if (rolar) caixa.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const estilo = document.createElement('style');
    estilo.textContent = ESTILO;
    document.head.appendChild(estilo);

    const faixa = document.createElement('div');
    faixa.className = 'faixa-site';
    faixa.innerHTML = '<a href="/">← DESPACHANTES CONSULTAS</a><span>Grátis · sem cadastro · os veículos ficam só no seu navegador</span>';
    document.body.prepend(faixa);

    // "Minutos esperando o captcha" é opção do agendar.js; a extensão espera
    // o captcha enquanto a aba do Detran estiver aberta.
    const espera = document.getElementById('o-esperaCaptchaMinutos');
    if (espera && espera.parentElement) espera.parentElement.style.display = 'none';

    const caixa = document.createElement('section');
    caixa.id = 'instalar-extensao';
    caixa.hidden = true;
    caixa.innerHTML = `
      <h2>🧩 Para agendar por esta página, instale a extensão do Chrome (grátis)</h2>
      <p>Quem abre o site do Detran, preenche e espera você marcar o captcha é a extensão, no seu Chrome. Você já pode cadastrar os veículos abaixo: eles ficam salvos neste navegador e passam para a extensão quando ela for instalada.</p>
      <ol>
        <li>Baixe a extensão e <strong>descompacte</strong> o arquivo (botão direito → <em>Extrair tudo</em>).</li>
        <li>No Chrome, abra <code>chrome://extensions</code> e ligue o <strong>Modo do desenvolvedor</strong> (canto de cima, à direita).</li>
        <li>Clique em <strong>Carregar sem compactação</strong>, escolha a pasta descompactada e <strong>recarregue esta página</strong>.</li>
      </ol>
      <div class="botoes">
        <a href="${ZIP}" download>⬇️ Baixar extensão (.zip)</a>
        <a class="sec" href="${LOJA}" target="_blank" rel="noopener">Chrome Web Store ↗</a>
        <a class="sec" href="/baixar-app">💻 Ou o programa para Windows</a>
      </div>
      <div class="aviso"><strong>Aviso de "modo do desenvolvedor"?</strong> O Chrome mostra essa mensagem para toda extensão instalada fora da loja: é uma mensagem padrão e não quer dizer que a extensão é perigosa. A versão com o agendamento ainda está em análise na Chrome Web Store; até lá, use o .zip.</div>`;
    const main = document.querySelector('main');
    if (main) main.prepend(caixa);
    extensao.then((ext) => { if (!ext) mostrarInstalar(false); });
  });
})();
