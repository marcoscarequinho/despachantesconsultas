/*
 * Tour animado da home — "vídeo" feito de HTML/CSS, sem arquivo de vídeo.
 *
 * Por que não é um .mp4: o tour mostra telas do painel, e tela muda toda
 * semana. Aqui cada cena é markup; mudar um preço ou um passo é editar um
 * texto, não regravar e reexportar um vídeo. Quando o vídeo com avatar
 * (HeyGen) existir, ele entra no mesmo player flutuante.
 *
 * Mini-player no canto ESQUERDO porque o direito é do WhatsApp, e acima
 * do botão de tema (.tema-toggle), que mora no rodapé esquerdo.
 * Fechar lembra por 7 dias (localStorage, com try/catch: em aba anônima o
 * acesso lança e o tour só volta a aparecer — nada quebra).
 *
 * Narração: speechSynthesis em pt-BR, só depois do clique (o navegador
 * bloqueia voz sem gesto do usuário) e com botão para calar. Sem voz em
 * português instalada, a legenda segue sozinha.
 */
(function () {
  'use strict';

  var CHAVE_FECHADO = 'tourFechadoEm';
  var DIAS_ESCONDIDO = 7;

  try {
    var t = parseInt(localStorage.getItem(CHAVE_FECHADO) || '0', 10);
    if (t && Date.now() - t < DIAS_ESCONDIDO * 864e5) return;
  } catch (e) { /* sem storage: mostra o tour */ }

  var reduzMovimento = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Cenas ──────────────────────────────────────────────────────────────
  // `fala` é a legenda E a narração. `dur` em ms é o mínimo da cena: ela só
  // vira depois disso E de a voz terminar a frase (ver tick).
  var CENAS = [
    {
      cap: 'Boas-vindas',
      dur: 9000,
      fala: 'Bem-vindo à Despachantes Consultas: a plataforma de consultas veiculares feita para despachantes, lojistas e escritórios jurídicos.',
      html:
        '<div class="tv-intro">' +
          '<div class="tv-logo"><span class="tv-logo-ic">🚗</span><span class="tv-scan"></span></div>' +
          '<h2 class="tv-title">DESPACHANTES <b>CONSULTAS</b></h2>' +
          '<p class="tv-sub">Consultas veiculares, CRLV-e e ATPV-e num painel só</p>' +
          '<div class="tv-pills">' +
            '<span style="--d:.6s">💸 Sem mensalidade</span>' +
            '<span style="--d:.9s">⚡ PIX na hora</span>' +
            '<span style="--d:1.2s">📲 PDF no WhatsApp</span>' +
          '</div>' +
        '</div>'
    },
    {
      cap: 'Cadastro e saldo',
      dur: 11000,
      fala: 'Crie sua conta grátis e coloque saldo por PIX: o QR Code aparece na tela e o crédito cai na hora. Também aceitamos cartão de crédito em até 18 vezes.',
      html:
        '<div class="tv-split">' +
          '<div class="tv-card tv-pop">' +
            '<div class="tv-card-h">Recarga PIX</div>' +
            '<div class="tv-qr">' + qr() + '<span class="tv-qr-ok">✓ Pago</span></div>' +
            '<div class="tv-muted">Copia e cola ou QR Code</div>' +
          '</div>' +
          '<div class="tv-card tv-pop" style="--d:.4s">' +
            '<div class="tv-card-h">Saldo disponível</div>' +
            '<div class="tv-saldo" data-conta="100">R$ 0,00</div>' +
            '<div class="tv-muted">💳 Cartão em até 18x</div>' +
          '</div>' +
        '</div>'
    },
    {
      cap: 'Achar a consulta',
      dur: 10000,
      fala: 'No painel, a Visão Geral mostra todas as consultas. Digite o que procura na busca, ou filtre por grupo, e clique no card para abrir o formulário.',
      html:
        '<div class="tv-panel">' +
          '<div class="tv-search">🔎 <span class="tv-typing" data-texto="ATPV-e"></span><i class="tv-caret"></i></div>' +
          '<div class="tv-chips"><b>Todos</b><span>CRLV-e</span><span>Débitos</span><span>CNH</span><span>CRV</span></div>' +
          '<div class="tv-grid">' +
            card('📝', 'ATPV-e RJ', 'R$ 70,00', 'hit') +
            card('📝', 'ATPV-e MG', 'R$ 70,00', 'hit') +
            card('🔢', 'ATPVe c/ Comunicação', 'R$ 120,00', 'hit') +
            card('📄', 'CRLV-e RJ', 'R$ 20,00', 'fade') +
            card('💰', 'Débitos', '', 'fade') +
            card('🪪', 'CNH', '', 'fade') +
          '</div>' +
        '</div>'
    },
    {
      cap: 'ATPV-e RJ e MG',
      dur: 16000,
      fala: 'Intenção de Venda, ATPV-e do Rio e de Minas. Clique em Importar CRLV-e: placa, renavam, chassi e vendedor são preenchidos sozinhos, e o PDF já fica anexado. Complete o comprador, anexe os comprovantes de endereço e envie. Depois é só clicar em Registrar no Detran e acompanhar a barra até o documento chegar.',
      html:
        '<div class="tv-split tv-split-wide">' +
          '<div class="tv-card tv-form">' +
            '<div class="tv-card-h">📝 ATPV-e RJ · MG <em>R$ 70,00</em></div>' +
            '<div class="tv-import">📥 Importar CRLV-e</div>' +
            campo('Placa', 'ABC1D23', 1) +
            campo('Renavam', '01234567890', 2) +
            campo('Chassi', '9BWZZZ377VT004251', 3) +
            campo('Vendedor', 'JOSÉ DA SILVA', 4) +
            '<div class="tv-anexos"><span style="--d:5.2s">📎 CRLV-e</span><span style="--d:5.8s">📎 End. vendedor</span><span style="--d:6.4s">📎 End. comprador</span></div>' +
          '</div>' +
          '<div class="tv-card tv-steps">' +
            '<div class="tv-step" style="--d:7.5s">✅ Cadastro enviado</div>' +
            '<div class="tv-btn tv-click" style="--d:9s">🏛️ Registrar no Detran</div>' +
            '<div class="tv-bar"><i style="--d:10s"></i></div>' +
            '<div class="tv-step tv-done" style="--d:14s">📄 ATPV-e pronto · 📲 enviado no WhatsApp</div>' +
          '</div>' +
        '</div>'
    },
    {
      cap: 'ATPVe com Comunicação',
      dur: 12000,
      fala: 'Precisa da segunda via de uma ATPV-e que já tem comunicação de venda? Use a Reemissão da ATPVe com Comunicação de Venda: informe só a placa e receba o documento em PDF, na hora.',
      html:
        '<div class="tv-split">' +
          '<div class="tv-card tv-pop">' +
            '<div class="tv-card-h">🔢 Reemissão da ATPVe<br>com Comunicação de Venda</div>' +
            '<div class="tv-placa"><small>BRASIL</small><span class="tv-typing" data-texto="RIO2A18"></span></div>' +
            '<div class="tv-btn tv-click" style="--d:3.2s">Consultar · R$ 120,00</div>' +
          '</div>' +
          '<div class="tv-pdf" style="--d:4.5s">' +
            '<div class="tv-pdf-h">PDF</div>' +
            '<i></i><i></i><i class="s"></i><i></i><i class="s"></i>' +
            '<div class="tv-pdf-stamp">ATPV-e</div>' +
          '</div>' +
        '</div>'
    },
    {
      cap: 'CRLV-e',
      dur: 12000,
      fala: 'CRLV-e digital: Rio de Janeiro, Pernambuco, Ceará e Bahia saem na hora, só com a placa. Para os outros estados existe o CRLV-e agendado, e o documento chega sozinho no seu WhatsApp.',
      html:
        '<div class="tv-split">' +
          '<div class="tv-ufs">' +
            uf('RJ', '.2s') + uf('PE', '.5s') + uf('CE', '.8s') + uf('BA', '1.1s') +
            '<div class="tv-muted tv-ufs-nota">⚡ na hora · 🕒 demais estados agendado</div>' +
          '</div>' +
          '<div class="tv-phone">' +
            '<div class="tv-phone-top">💬 MC Despachadoria</div>' +
            '<div class="tv-bubble" style="--d:2.5s">✅ Seu CRLV-e está pronto!</div>' +
            '<div class="tv-bubble tv-file" style="--d:4s">📄 CRLV-e-RIO2A18.pdf</div>' +
          '</div>' +
        '</div>'
    },
    {
      cap: 'Outras consultas',
      dur: 11000,
      fala: 'E tem muito mais: débitos por estado, CNH, número do CRV, consulta completa, leilão, cadastros, crédito e dívida ativa. Tudo cobra só quando traz resultado, e fica no seu histórico para baixar de novo sem pagar outra vez.',
      html:
        '<div class="tv-cloud">' +
          ['💰 Débitos por Estado', '🪪 CNH', '🔢 Número do CRV', '🧾 Consulta Completa', '🔨 Leilão',
           '👤 Cadastros', '📊 Crédito', '🏛️ Dívida Ativa', '📑 Documentos', '🔎 Consulta de Placa']
            .map(function (t, i) { return '<span style="--d:' + (0.15 * i).toFixed(2) + 's">' + t + '</span>'; }).join('') +
          '<div class="tv-garantia" style="--d:2.4s">🛡️ Sem resultado, sem cobrança · 🗂️ Histórico para baixar de novo</div>' +
        '</div>'
    },
    {
      cap: 'Coisas de Despachantes',
      dur: 13000,
      fala: 'Para despachantes, a assinatura Coisas de Despachantes: consultas de placa, código de segurança do CRV, Declaração de Residência, ASD do Rio, nota de serviços e assinatura digital de documentos, tudo com vencimento no dia 30.',
      html:
        '<div class="tv-card tv-assin">' +
          '<div class="tv-card-h">🧰 Coisas de Despachantes <em>assinatura · vence dia 30</em></div>' +
          '<ul>' +
            li('🔎', 'Consultas de placa', '.3s') +
            li('🔐', 'Código de Segurança CRV', '.7s') +
            li('🏠', 'Declaração de Residência DETRAN RJ', '1.1s') +
            li('📑', 'Gerar ASD RJ', '1.5s') +
            li('🧾', 'Nota de Prestação de Serviços', '1.9s') +
            li('✍️', 'Assinatura Digital de documentos', '2.3s') +
          '</ul>' +
        '</div>'
    },
    {
      cap: 'Comece agora',
      dur: 10000,
      fala: 'Sem mensalidade, você paga só pelo que usar. Crie sua conta grátis agora e faça sua primeira consulta em minutos.',
      html:
        '<div class="tv-intro">' +
          '<h2 class="tv-title">Pague só pelo que <b>usar</b></h2>' +
          '<div class="tv-pills">' +
            '<span style="--d:.3s">✅ Cadastro grátis</span>' +
            '<span style="--d:.6s">🔌 API para integração</span>' +
            '<span style="--d:.9s">🧾 Pós-pago para empresas</span>' +
          '</div>' +
          '<div class="tv-cta" style="--d:1.4s">' +
            '<a href="/cadastrar" class="tv-cta-main">Criar conta grátis →</a>' +
            '<a href="/entrar" class="tv-cta-alt">Já tenho conta</a>' +
          '</div>' +
        '</div>'
    }
  ];

  // ── Pedaços de markup ──────────────────────────────────────────────────
  function card(ic, nome, preco, cls) {
    return '<div class="tv-cc ' + cls + '"><span>' + ic + '</span><b>' + nome + '</b>' + (preco ? '<em>' + preco + '</em>' : '') + '</div>';
  }
  function campo(rot, val, i) {
    return '<div class="tv-campo"><label>' + rot + '</label><span style="--d:' + (0.6 + i * 0.5) + 's">' + val + '</span></div>';
  }
  function uf(sigla, d) { return '<div class="tv-uf" style="--d:' + d + '"><b>' + sigla + '</b><small>⚡ na hora</small></div>'; }
  function li(ic, t, d) { return '<li style="--d:' + d + '"><span>' + ic + '</span>' + t + '<i>✓</i></li>'; }
  function qr() {
    // QR decorativo (não é um código de verdade) — padrão fixo para não
    // mudar a cada abertura.
    var s = '', seed = 7;
    for (var i = 0; i < 81; i++) {
      seed = (seed * 31 + 11) % 97;
      var canto = (i % 9 < 3 && i < 27) || (i % 9 > 5 && i < 27) || (i % 9 < 3 && i > 53);
      s += '<i class="' + (canto || seed % 2 ? 'on' : '') + '"></i>';
    }
    return '<div class="tv-qr-grid">' + s + '</div>';
  }

  // ── CSS ────────────────────────────────────────────────────────────────
  var css = `
  :root{--tv-bg:#0b1220;--tv-bg2:#111a2e;--tv-card:rgba(255,255,255,.06);--tv-line:rgba(255,255,255,.12);
    --tv-txt:#e8eefc;--tv-mut:#93a3c4;--tv-acc:#f97316;--tv-acc2:#fb923c;--tv-ok:#22c55e;--tv-blue:#3b82f6}
  .tv-mini{position:fixed;left:16px;bottom:76px;z-index:1001;width:300px;border-radius:18px;overflow:hidden;
    background:var(--tv-bg);color:var(--tv-txt);box-shadow:0 18px 50px rgba(2,6,23,.45),0 0 0 1px var(--tv-line);
    cursor:pointer;font-family:inherit;transform:translateY(140%);transition:transform .7s cubic-bezier(.2,.9,.2,1.1)}
  .tv-mini.show{transform:none}
  .tv-mini::before{content:"";position:absolute;inset:-2px;border-radius:20px;padding:2px;
    background:conic-gradient(from var(--tv-ang,0deg),var(--tv-acc),transparent 30%,var(--tv-blue),transparent 70%,var(--tv-acc));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;
    animation:tvSpin 4s linear infinite;pointer-events:none}
  @property --tv-ang{syntax:'<angle>';initial-value:0deg;inherits:false}
  @keyframes tvSpin{to{--tv-ang:360deg}}
  .tv-mini-stage{position:relative;height:150px;overflow:hidden;background:radial-gradient(120% 90% at 20% 0%,#1d2b4f 0%,var(--tv-bg) 60%)}
  .tv-mini-stage .tv-screen{transform:scale(.36);transform-origin:0 0;width:278%;height:278%;pointer-events:none}
  .tv-mini-play{position:absolute;inset:0;display:grid;place-items:center;background:linear-gradient(180deg,transparent 30%,rgba(2,6,23,.75))}
  .tv-mini-play b{width:54px;height:54px;border-radius:50%;background:var(--tv-acc);display:grid;place-items:center;font-size:20px;
    box-shadow:0 0 0 0 rgba(249,115,22,.6);animation:tvPulse 2s infinite}
  .tv-mini-play b::after{content:"";margin-left:4px;border-style:solid;border-width:10px 0 10px 16px;border-color:transparent transparent transparent #fff}
  @keyframes tvPulse{70%{box-shadow:0 0 0 18px rgba(249,115,22,0)}100%{box-shadow:0 0 0 0 rgba(249,115,22,0)}}
  .tv-mini-foot{display:flex;align-items:center;gap:10px;padding:10px 14px}
  .tv-mini-foot strong{font-size:14px;line-height:1.2;display:block}
  .tv-mini-foot small{color:var(--tv-mut);font-size:12px}
  .tv-x{position:absolute;top:8px;right:8px;z-index:3;width:30px;height:30px;border-radius:50%;border:0;cursor:pointer;
    background:rgba(2,6,23,.7);color:#fff;font-size:16px;line-height:30px;backdrop-filter:blur(6px)}
  .tv-x:hover{background:#ef4444}
  .tv-badge{position:absolute;top:10px;left:10px;z-index:2;font-size:11px;font-weight:700;letter-spacing:.04em;
    background:rgba(2,6,23,.7);padding:4px 8px;border-radius:999px;backdrop-filter:blur(6px)}
  .tv-badge i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;margin-right:5px;animation:tvBlink 1.2s infinite}
  @keyframes tvBlink{50%{opacity:.25}}

  .tv-modal{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(2,6,23,.78);
    backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .35s}
  .tv-modal.open{opacity:1;pointer-events:auto}
  .tv-player{position:relative;width:min(1000px,100%);min-width:0;border-radius:22px;overflow:hidden;background:var(--tv-bg);color:var(--tv-txt);
    box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 0 1px var(--tv-line);transform:scale(.94);transition:transform .45s cubic-bezier(.2,.9,.2,1.1)}
  .tv-modal.open .tv-player{transform:none}
  .tv-stage{position:relative;aspect-ratio:16/9;overflow:hidden;background:radial-gradient(120% 90% at 15% 0%,#1d2b4f 0%,var(--tv-bg) 55%),var(--tv-bg)}
  .tv-stage::after{content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(40% 50% at 85% 100%,rgba(249,115,22,.18),transparent 70%)}
  .tv-orb{position:absolute;border-radius:50%;filter:blur(40px);opacity:.35;animation:tvFloat 12s ease-in-out infinite alternate}
  @keyframes tvFloat{to{transform:translate(40px,-30px) scale(1.15)}}
  .tv-screen{position:absolute;inset:0;display:grid;place-items:center;padding:4% 6% 13%;font-size:clamp(11px,1.55vw,16px)}
  .tv-screen>*{animation:tvIn .7s cubic-bezier(.2,.9,.2,1) both}
  @keyframes tvIn{from{opacity:0;transform:translateY(18px) scale(.98)}}
  .tv-caption{position:absolute;left:5%;right:5%;bottom:5%;z-index:2;text-align:center;font-size:clamp(12px,1.6vw,17px);line-height:1.45;
    background:rgba(2,6,23,.72);padding:.55em 1em;border-radius:12px;backdrop-filter:blur(6px)}
  .tv-caption mark{background:none;color:var(--tv-acc2)}
  .tv-controls{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--tv-bg2);border-top:1px solid var(--tv-line)}
  .tv-ctrl{border:0;background:var(--tv-card);color:var(--tv-txt);width:38px;height:38px;border-radius:10px;cursor:pointer;font-size:16px;flex:none}
  .tv-ctrl:hover{background:rgba(255,255,255,.14)}
  .tv-track{position:relative;flex:1;height:8px;border-radius:99px;background:rgba(255,255,255,.1);cursor:pointer;display:flex;gap:3px}
  .tv-seg{flex:1;position:relative;border-radius:99px;overflow:hidden;background:rgba(255,255,255,.08)}
  .tv-seg i{position:absolute;inset:0;width:0;background:linear-gradient(90deg,var(--tv-acc),var(--tv-acc2))}
  .tv-time{font-variant-numeric:tabular-nums;color:var(--tv-mut);font-size:13px;flex:none}
  .tv-chaps{display:flex;gap:8px;overflow-x:auto;padding:0 16px 14px;background:var(--tv-bg2);scrollbar-width:thin;scrollbar-color:#334155 transparent}
  .tv-chap{flex:none;border:1px solid var(--tv-line);background:transparent;color:var(--tv-mut);font-size:12.5px;padding:6px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}
  .tv-chap.on{background:var(--tv-acc);border-color:var(--tv-acc);color:#fff;font-weight:600}
  .tv-close{position:absolute;top:12px;right:12px;z-index:5;width:38px;height:38px;border-radius:50%;border:0;cursor:pointer;
    background:rgba(2,6,23,.65);color:#fff;font-size:18px;backdrop-filter:blur(6px)}
  .tv-close:hover{background:#ef4444}
  .tv-paused .tv-screen *,.tv-paused .tv-screen *::before,.tv-paused .tv-screen *::after{animation-play-state:paused!important;transition:none!important}

  /* ── elementos das cenas ── */
  .tv-screen [style*="--d"]{animation-delay:var(--d)}
  .tv-intro{text-align:center}
  .tv-logo{position:relative;width:5.2em;height:5.2em;margin:0 auto 1em;border-radius:1.4em;display:grid;place-items:center;font-size:1em;
    background:linear-gradient(135deg,var(--tv-acc),#ea580c);box-shadow:0 20px 50px rgba(249,115,22,.4);overflow:hidden;animation:tvIn .8s both,tvBob 3s ease-in-out infinite .8s}
  @keyframes tvBob{50%{transform:translateY(-6px)}}
  .tv-logo-ic{font-size:2.3em;line-height:1}
  .tv-scan{position:absolute;left:0;right:0;height:30%;top:-30%;background:linear-gradient(180deg,transparent,rgba(255,255,255,.45),transparent);animation:tvScan 2.2s ease-in-out infinite}
  @keyframes tvScan{to{top:110%}}
  .tv-title{font-size:2.3em;font-weight:800;letter-spacing:-.02em;margin:0}
  .tv-title b{background:linear-gradient(90deg,var(--tv-acc),#fbbf24);-webkit-background-clip:text;background-clip:text;color:transparent}
  .tv-sub{color:var(--tv-mut);margin:.5em 0 1.4em;font-size:1.1em}
  .tv-pills{display:flex;flex-wrap:wrap;gap:.6em;justify-content:center}
  .tv-pills span{background:var(--tv-card);border:1px solid var(--tv-line);padding:.5em 1em;border-radius:999px;animation:tvIn .6s both;animation-delay:var(--d)}
  .tv-split{display:flex;gap:4%;align-items:center;justify-content:center;width:100%}
  .tv-card{background:var(--tv-card);border:1px solid var(--tv-line);border-radius:1.1em;padding:1.1em 1.3em;backdrop-filter:blur(8px);min-width:13em}
  .tv-card-h{font-weight:700;margin-bottom:.8em;display:flex;justify-content:space-between;gap:1em;align-items:baseline}
  .tv-card-h em{font-style:normal;color:var(--tv-acc2);font-size:.85em;font-weight:600}
  .tv-muted{color:var(--tv-mut);font-size:.85em;margin-top:.6em}
  .tv-pop{animation:tvIn .7s both;animation-delay:var(--d,0s)}
  .tv-qr{position:relative;width:8em;height:8em;margin:0 auto;background:#fff;border-radius:.6em;padding:.5em}
  .tv-qr-grid{display:grid;grid-template-columns:repeat(9,1fr);gap:1px;width:100%;height:100%}
  .tv-qr-grid i{background:#fff}.tv-qr-grid i.on{background:#0b1220}
  .tv-qr-ok{position:absolute;inset:0;display:grid;place-items:center;background:rgba(34,197,94,.93);color:#fff;font-weight:800;font-size:1.3em;border-radius:.6em;
    opacity:0;animation:tvFade .4s forwards 3s}
  @keyframes tvFade{to{opacity:1}}
  .tv-saldo{font-size:2.6em;font-weight:800;color:var(--tv-ok);font-variant-numeric:tabular-nums}
  .tv-panel{width:100%;max-width:40em}
  .tv-search{background:#fff;color:#0b1220;border-radius:.8em;padding:.7em 1em;font-weight:600;display:flex;align-items:center;gap:.4em}
  .tv-caret{display:inline-block;width:2px;height:1.1em;background:var(--tv-acc);animation:tvBlink .8s infinite}
  .tv-chips{display:flex;gap:.5em;margin:.8em 0}
  .tv-chips>*{padding:.3em .8em;border-radius:999px;background:var(--tv-card);border:1px solid var(--tv-line);font-size:.85em}
  .tv-chips b{background:var(--tv-acc);border-color:var(--tv-acc)}
  .tv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.7em}
  .tv-cc{background:var(--tv-card);border:1px solid var(--tv-line);border-radius:.9em;padding:.8em;display:flex;flex-direction:column;gap:.2em;transition:all .5s}
  .tv-cc span{font-size:1.4em}.tv-cc em{font-style:normal;color:var(--tv-acc2);font-size:.85em}
  .tv-cc.fade{animation:tvDim .6s forwards 2.4s}
  @keyframes tvDim{to{opacity:.18;filter:grayscale(1);transform:scale(.96)}}
  .tv-cc.hit{animation:tvHit .6s forwards 2.4s}
  @keyframes tvHit{to{border-color:var(--tv-acc);box-shadow:0 0 0 2px rgba(249,115,22,.35),0 10px 30px rgba(249,115,22,.25)}}
  .tv-cc.hit:first-child{animation:tvHit .6s forwards 2.4s,tvPress .5s 4s}
  @keyframes tvPress{50%{transform:scale(.94)}}
  .tv-split-wide .tv-card{flex:1;max-width:24em}
  .tv-import{background:linear-gradient(90deg,var(--tv-blue),#6366f1);border-radius:.6em;padding:.5em .8em;text-align:center;font-weight:600;margin-bottom:.7em;animation:tvPress .5s .3s}
  .tv-campo{display:flex;justify-content:space-between;gap:1em;padding:.35em 0;border-bottom:1px dashed var(--tv-line);font-size:.92em}
  .tv-campo label{color:var(--tv-mut)}
  .tv-campo span{font-family:ui-monospace,monospace;color:#bfdbfe;opacity:0;animation:tvFill .5s forwards;animation-delay:var(--d)}
  @keyframes tvFill{from{opacity:0;transform:translateX(8px);color:var(--tv-ok)}to{opacity:1}}
  .tv-anexos{display:flex;flex-wrap:wrap;gap:.4em;margin-top:.7em}
  .tv-anexos span,.tv-step,.tv-btn,.tv-uf,.tv-bubble,.tv-cloud span,.tv-garantia,.tv-assin li,.tv-cta,.tv-pdf{opacity:0;animation:tvShow .6s forwards;animation-delay:var(--d)}
  /* tvIn só tem "from"; com opacity:0 no elemento o fim também seria 0. */
  @keyframes tvShow{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:none}}
  .tv-anexos span{font-size:.8em;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.4);padding:.25em .6em;border-radius:.5em}
  .tv-steps{display:flex;flex-direction:column;gap:.8em}
  .tv-step{padding:.6em .8em;border-radius:.7em;background:rgba(255,255,255,.05)}
  .tv-done{background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.5);font-weight:600}
  .tv-btn{background:var(--tv-acc);color:#fff;font-weight:700;text-align:center;padding:.7em;border-radius:.7em;margin-top:.6em}
  .tv-click{animation:tvShow .6s forwards,tvPress .45s;animation-delay:var(--d),calc(var(--d) + 1s)}
  .tv-bar{height:.6em;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden}
  .tv-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--tv-acc),var(--tv-ok));animation:tvGrow 4s cubic-bezier(.3,.6,.3,1) forwards;animation-delay:var(--d)}
  @keyframes tvGrow{70%{width:88%}to{width:100%}}
  .tv-placa{margin:.6em auto 0;width:10em;border:3px solid #0b1220;border-radius:.4em;background:#fff;color:#0b1220;text-align:center;overflow:hidden}
  .tv-placa small{display:block;background:#1e40af;color:#fff;font-size:.6em;font-weight:700;letter-spacing:.2em;padding:.15em}
  .tv-placa span{display:block;font:800 1.7em ui-monospace,monospace;letter-spacing:.08em;padding:.1em 0;min-height:1.3em}
  .tv-pdf{position:relative;width:9em;height:12em;background:#fff;border-radius:.5em;padding:1em;display:flex;flex-direction:column;gap:.5em;
    box-shadow:0 20px 50px rgba(0,0,0,.45);transform-origin:50% 100%}
  .tv-pdf-h{align-self:flex-start;background:#ef4444;color:#fff;font-weight:800;font-size:.75em;padding:.2em .5em;border-radius:.3em}
  .tv-pdf i{display:block;height:.45em;border-radius:99px;background:#cbd5e1}.tv-pdf i.s{width:60%}
  .tv-pdf-stamp{position:absolute;right:-.8em;bottom:1em;transform:rotate(-12deg);border:3px solid var(--tv-ok);color:var(--tv-ok);font-weight:800;padding:.2em .6em;border-radius:.4em;background:#fff}
  .tv-ufs{display:grid;grid-template-columns:repeat(2,6.5em);gap:.7em}
  .tv-uf{background:var(--tv-card);border:1px solid var(--tv-line);border-radius:1em;padding:.8em;text-align:center}
  .tv-uf b{display:block;font-size:1.8em}.tv-uf small{color:var(--tv-ok)}
  .tv-ufs-nota{grid-column:1/-1;text-align:center}
  .tv-phone{width:13em;height:19em;border-radius:1.8em;background:#0a1f18;border:.4em solid #1f2937;padding:.6em;display:flex;flex-direction:column;gap:.6em;
    box-shadow:0 25px 60px rgba(0,0,0,.5);animation:tvIn .7s both .3s}
  .tv-phone-top{background:#075e54;margin:-.6em -.6em 0;padding:.7em;border-radius:1.3em 1.3em 0 0;font-weight:700;font-size:.85em}
  .tv-bubble{align-self:flex-start;background:#1f2c34;padding:.55em .8em;border-radius:.2em .9em .9em .9em;font-size:.85em}
  .tv-file{background:#005c4b}
  .tv-cloud{display:flex;flex-wrap:wrap;gap:.7em;justify-content:center;max-width:42em}
  .tv-cloud span{background:var(--tv-card);border:1px solid var(--tv-line);padding:.6em 1.1em;border-radius:999px;font-size:1.05em}
  .tv-cloud span:nth-child(3n){border-color:rgba(249,115,22,.5)}
  .tv-cloud span:nth-child(4n){border-color:rgba(59,130,246,.5)}
  .tv-garantia{flex-basis:100%;text-align:center;margin-top:1em;padding:.8em;border-radius:.9em;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.45);font-weight:600}
  .tv-assin{width:100%;max-width:32em}
  .tv-assin ul{list-style:none;margin:0;padding:0;display:grid;gap:.5em}
  .tv-assin li{display:flex;align-items:center;gap:.7em;padding:.55em .8em;border-radius:.7em;background:rgba(255,255,255,.05)}
  .tv-assin li span{font-size:1.2em}.tv-assin li i{margin-left:auto;font-style:normal;color:var(--tv-ok);font-weight:800}
  .tv-cta{display:flex;gap:.8em;justify-content:center;margin-top:1.6em;flex-wrap:wrap}
  .tv-cta a{text-decoration:none;padding:.8em 1.5em;border-radius:.8em;font-weight:700}
  .tv-cta-main{background:var(--tv-acc);color:#fff;box-shadow:0 10px 30px rgba(249,115,22,.4);animation:tvPulse 2s infinite 2s}
  .tv-cta-alt{border:1px solid var(--tv-line);color:var(--tv-txt)}

  @media (max-width:640px){
    .tv-mini{left:12px;bottom:72px;width:210px}
    .tv-mini-stage{height:105px}
    .tv-mini-stage .tv-screen{transform:scale(.25);width:400%;height:400%}
    .tv-mini-foot{padding:8px 10px}.tv-mini-foot strong{font-size:12.5px}
    .tv-modal{padding:0}
    .tv-player{border-radius:0;width:100%}
    .tv-stage{aspect-ratio:auto;height:min(78vh,620px)}
    .tv-caption{font-size:11.5px;bottom:3%}
    .tv-split-wide .tv-campo:nth-of-type(n+3),.tv-split-wide .tv-anexos{display:none}
    .tv-split-wide{gap:.6em}
    .tv-screen{font-size:12px;padding:12% 5% 26%}
    .tv-split{flex-direction:column;gap:1em}
    .tv-grid{grid-template-columns:repeat(2,1fr)}
    .tv-ufs{grid-template-columns:repeat(4,1fr)}
    .tv-phone{height:12em}
    .tv-pdf{height:9em;width:7em}
  }
  @media (prefers-reduced-motion:reduce){
    .tv-mini::before,.tv-orb,.tv-logo,.tv-scan,.tv-mini-play b{animation:none!important}
  }`;

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Mini-player ────────────────────────────────────────────────────────
  var mini = document.createElement('div');
  mini.className = 'tv-mini';
  mini.setAttribute('role', 'button');
  mini.setAttribute('tabindex', '0');
  mini.setAttribute('aria-label', 'Assistir ao tour da plataforma');
  mini.innerHTML =
    '<button class="tv-x" type="button" aria-label="Fechar tour">✕</button>' +
    '<div class="tv-mini-stage"><span class="tv-badge"><i></i>TOUR</span><div class="tv-screen"></div>' +
      '<div class="tv-mini-play"><b></b></div></div>' +
    '<div class="tv-mini-foot"><div><strong>Como usar a plataforma</strong>' +
      '<small>ATPV-e RJ/MG, CRLV-e e mais · 1min45</small></div></div>';
  document.body.appendChild(mini);

  var miniScreen = mini.querySelector('.tv-screen');
  var miniIdx = 0, miniTimer = null;
  function girarMini() {
    // Prévia muda: só as cenas, sem legenda, em ciclo curto.
    miniScreen.innerHTML = CENAS[miniIdx].html;
    iniciarEfeitos(miniScreen);
    miniIdx = (miniIdx + 1) % CENAS.length;
    miniTimer = setTimeout(girarMini, 4200);
  }
  if (!reduzMovimento) girarMini(); else miniScreen.innerHTML = CENAS[0].html;
  setTimeout(function () { mini.classList.add('show'); }, 1800);

  mini.querySelector('.tv-x').addEventListener('click', function (ev) {
    ev.stopPropagation();
    fecharMini();
  });
  mini.addEventListener('click', abrir);
  mini.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(); } });

  function fecharMini() {
    try { localStorage.setItem(CHAVE_FECHADO, String(Date.now())); } catch (e) { /* ok */ }
    clearTimeout(miniTimer);
    mini.classList.remove('show');
    setTimeout(function () { mini.remove(); }, 800);
  }

  // ── Player grande ──────────────────────────────────────────────────────
  var modal = null, stage, screen, caption, btnPlay, btnVoz, timeEl, segs, chaps;
  var idx = 0, inicioCena = 0, decorrido = 0, tocando = false, raf = null, vozLigada = true, falaTerminou = true;
  var TOTAL = CENAS.reduce(function (s, c) { return s + c.dur; }, 0);

  function montarModal() {
    modal = document.createElement('div');
    modal.className = 'tv-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Tour da plataforma Despachantes Consultas');
    modal.innerHTML =
      '<div class="tv-player">' +
        '<button class="tv-close" type="button" aria-label="Fechar">✕</button>' +
        '<div class="tv-stage">' +
          '<span class="tv-orb" style="width:40%;height:50%;left:-10%;top:-10%;background:#3b82f6"></span>' +
          '<span class="tv-orb" style="width:35%;height:45%;right:-8%;bottom:-15%;background:#f97316;animation-delay:-6s"></span>' +
          '<div class="tv-screen"></div>' +
          '<div class="tv-caption" aria-live="polite"></div>' +
        '</div>' +
        '<div class="tv-controls">' +
          '<button class="tv-ctrl" data-a="prev" aria-label="Capítulo anterior">⏮</button>' +
          '<button class="tv-ctrl" data-a="play" aria-label="Pausar">⏸</button>' +
          '<button class="tv-ctrl" data-a="next" aria-label="Próximo capítulo">⏭</button>' +
          '<div class="tv-track">' + CENAS.map(function () { return '<div class="tv-seg"><i></i></div>'; }).join('') + '</div>' +
          '<span class="tv-time">0:00 / ' + mmss(TOTAL) + '</span>' +
          '<button class="tv-ctrl" data-a="voz" aria-label="Narração">🔊</button>' +
        '</div>' +
        '<div class="tv-chaps">' + CENAS.map(function (c, i) {
          return '<button class="tv-chap" data-i="' + i + '">' + (i + 1) + '. ' + c.cap + '</button>';
        }).join('') + '</div>' +
      '</div>';
    document.body.appendChild(modal);

    stage = modal.querySelector('.tv-stage');
    screen = modal.querySelector('.tv-screen');
    caption = modal.querySelector('.tv-caption');
    btnPlay = modal.querySelector('[data-a="play"]');
    btnVoz = modal.querySelector('[data-a="voz"]');
    timeEl = modal.querySelector('.tv-time');
    segs = modal.querySelectorAll('.tv-seg i');
    chaps = modal.querySelectorAll('.tv-chap');

    if (!('speechSynthesis' in window)) { vozLigada = false; btnVoz.style.display = 'none'; }

    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) return fechar();
      var a = ev.target.closest('[data-a]');
      if (a) {
        var acao = a.getAttribute('data-a');
        if (acao === 'play') return tocando ? pausar() : retomar();
        if (acao === 'prev') return irPara(Math.max(0, idx - 1));
        if (acao === 'next') return irPara(Math.min(CENAS.length - 1, idx + 1));
        if (acao === 'voz') {
          vozLigada = !vozLigada;
          btnVoz.textContent = vozLigada ? '🔊' : '🔇';
          if (!vozLigada) { speechSynthesis.cancel(); falaTerminou = true; }
          else if (tocando) falar(CENAS[idx].fala);
          return;
        }
      }
      var c = ev.target.closest('.tv-chap');
      if (c) return irPara(+c.getAttribute('data-i'));
      if (ev.target.closest('.tv-close')) return fechar();
      var trilha = ev.target.closest('.tv-track');
      if (trilha) {
        var r = trilha.getBoundingClientRect();
        irPara(Math.min(CENAS.length - 1, Math.floor((ev.clientX - r.left) / r.width * CENAS.length)));
      }
    });
    document.addEventListener('keydown', function (ev) {
      if (!modal.classList.contains('open')) return;
      if (ev.key === 'Escape') fechar();
      else if (ev.key === ' ') { ev.preventDefault(); tocando ? pausar() : retomar(); }
      else if (ev.key === 'ArrowRight') irPara(Math.min(CENAS.length - 1, idx + 1));
      else if (ev.key === 'ArrowLeft') irPara(Math.max(0, idx - 1));
    });
  }

  function abrir() {
    if (!modal) montarModal();
    clearTimeout(miniTimer);
    modal.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    irPara(0);
    modal.querySelector('.tv-close').focus();
  }

  function fechar() {
    pausar();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    modal.classList.remove('open');
    document.documentElement.style.overflow = '';
    if (mini.isConnected && !reduzMovimento) girarMini();
  }

  function irPara(i) {
    idx = i;
    decorrido = CENAS.slice(0, i).reduce(function (s, c) { return s + c.dur; }, 0);
    screen.innerHTML = CENAS[i].html;
    caption.textContent = CENAS[i].fala;
    iniciarEfeitos(screen);
    chaps.forEach(function (c, k) { c.classList.toggle('on', k === i); });
    if (chaps[i].scrollIntoView) chaps[i].scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    segs.forEach(function (s, k) { s.style.width = k < i ? '100%' : '0'; });
    inicioCena = performance.now();
    tocando = true;
    stage.classList.remove('tv-paused');
    btnPlay.textContent = '⏸';
    falar(CENAS[i].fala);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function tick(agora) {
    if (!tocando) return;
    var cena = CENAS[idx];
    var t = agora - inicioCena;
    var p = Math.min(1, t / cena.dur);
    segs[idx].style.width = (p * 100) + '%';
    timeEl.textContent = mmss(decorrido + Math.min(t, cena.dur)) + ' / ' + mmss(TOTAL);
    // A cena só vira quando o tempo acabou E a voz terminou a frase — voz
    // lenta no aparelho não pode ser cortada no meio.
    if (p >= 1 && (falaTerminou || !vozLigada)) {
      if (idx < CENAS.length - 1) return irPara(idx + 1);
      tocando = false;
      btnPlay.textContent = '↺';
      btnPlay.setAttribute('aria-label', 'Assistir de novo');
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function pausar() {
    if (!tocando) return;
    tocando = false;
    cancelAnimationFrame(raf);
    stage.classList.add('tv-paused');
    btnPlay.textContent = '▶';
    decorridoCena = performance.now() - inicioCena;
    if ('speechSynthesis' in window) speechSynthesis.pause();
  }
  var decorridoCena = 0;

  function retomar() {
    if (btnPlay.textContent === '↺') return irPara(0);
    tocando = true;
    stage.classList.remove('tv-paused');
    btnPlay.textContent = '⏸';
    inicioCena = performance.now() - decorridoCena;
    if ('speechSynthesis' in window) speechSynthesis.resume();
    raf = requestAnimationFrame(tick);
  }

  // ── Narração ───────────────────────────────────────────────────────────
  var vozPt = null;
  function escolherVoz() {
    var vs = speechSynthesis.getVoices();
    vozPt = vs.filter(function (v) { return /^pt(-|_)BR/i.test(v.lang); })
              .sort(function (a, b) { return pontua(b) - pontua(a); })[0] ||
            vs.filter(function (v) { return /^pt/i.test(v.lang); })[0] || null;
  }
  function pontua(v) { return (/natural|online|neural/i.test(v.name) ? 2 : 0) + (/google|microsoft/i.test(v.name) ? 1 : 0); }
  if ('speechSynthesis' in window) {
    escolherVoz();
    speechSynthesis.onvoiceschanged = escolherVoz;
  }

  function falar(texto) {
    if (!vozLigada || !('speechSynthesis' in window)) { falaTerminou = true; return; }
    speechSynthesis.cancel();
    if (!vozPt) { falaTerminou = true; return; } // sem voz em português: só legenda
    var u = new SpeechSynthesisUtterance(texto);
    u.voice = vozPt;
    u.lang = vozPt.lang;
    u.rate = 1.05;
    falaTerminou = false;
    u.onend = u.onerror = function () { falaTerminou = true; };
    speechSynthesis.speak(u);
  }

  // ── Efeitos que precisam de JS (digitação e contador) ──────────────────
  function iniciarEfeitos(raiz) {
    raiz.querySelectorAll('.tv-typing').forEach(function (el) {
      var txt = el.getAttribute('data-texto'), i = 0;
      el.textContent = '';
      (function passo() {
        if (!el.isConnected || i > txt.length) return;
        el.textContent = txt.slice(0, i++);
        setTimeout(passo, i === 1 ? 700 : 170);
      })();
    });
    raiz.querySelectorAll('[data-conta]').forEach(function (el) {
      var alvo = +el.getAttribute('data-conta'), t0 = null;
      setTimeout(function () {
        (function anima(ts) {
          if (!el.isConnected) return;
          t0 = t0 || ts;
          var p = Math.min(1, (ts - t0) / 1200), v = alvo * (1 - Math.pow(1 - p, 3));
          el.textContent = 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          if (p < 1) requestAnimationFrame(anima);
        })(performance.now());
      }, 3200);
    });
  }

  function mmss(ms) {
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
})();
