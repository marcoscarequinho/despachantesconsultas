/* Popup "Nova forma de pagamento" (23/11/2026) — usado no painel do cliente e no do parceiro.
   Injeta o HTML/CSS na página e abre até o cliente confirmar a leitura. Precisa do Tailwind da página. */
(function(){
  const html = `<div id="popup-pagamento" class="fixed inset-0 hidden" style="z-index:2147483000;background:rgba(7,10,30,.78);backdrop-filter:blur(6px);">
  <div class="w-full h-full overflow-y-auto flex items-start justify-center p-3 sm:p-4" style="-webkit-overflow-scrolling:touch;overscroll-behavior:contain;">
  <div class="pg-card relative w-full max-w-lg md:max-w-3xl rounded-3xl overflow-hidden shadow-2xl my-4 sm:my-6">
    <div class="pg-fundo absolute inset-0"></div>
    <div class="pg-brilho absolute -top-24 -left-16 w-64 h-64 rounded-full"></div>
    <div class="pg-brilho pg-brilho-2 absolute -bottom-24 -right-16 w-64 h-64 rounded-full"></div>
    <div class="pg-fita absolute top-0 left-0 w-full h-1.5"></div>
    <button onclick="fecharPopupPagamento(false)" aria-label="Fechar" class="absolute top-3 right-3 z-10 w-8 h-8 rounded-full text-white/70 hover:text-white hover:bg-white/10 text-lg leading-none">✕</button>

    <div class="relative p-5 sm:p-6 space-y-4 text-white">
      <div class="text-center">
        <div class="flex justify-center mb-3"><div class="pg-icone w-16 h-16 rounded-full flex items-center justify-center text-3xl">💸</div></div>
        <div class="inline-block text-[11px] font-black tracking-widest uppercase px-3 py-1 rounded-full pg-selo">🧪 Em fase de teste</div>
        <h2 class="text-2xl sm:text-3xl font-black leading-tight mt-2">Mais uma forma de pagar: <span class="pg-degrade">só esta consulta</span></h2>
        <div class="text-sm font-semibold mt-1" style="color:#c7d2fe;">Não saiu a consulta? <b class="text-white">O PIX volta para você.</b> Sem ligar, sem pedir.</div>
      </div>

      <div id="pg-pos-nota" class="hidden rounded-xl px-3 py-2 text-xs font-bold text-center" style="background:rgba(250,204,21,.2);color:#fde68a;">🧾 Sua conta é pós-paga: as consultas vão para a fatura. Este aviso é informativo, para você conhecer a novidade.</div>

      <!-- Contagem regressiva -->
      <div class="rounded-2xl p-3 text-center pg-vidro">
        <div class="text-[11px] font-bold uppercase tracking-wider" style="color:#fde047;">⏳ Vale para TODAS as consultas a partir de 15/12/2026</div>
        <div class="flex justify-center gap-2 mt-2">
          <div class="pg-tempo"><b id="pg-d">--</b><span>dias</span></div>
          <div class="pg-tempo"><b id="pg-h">--</b><span>horas</span></div>
          <div class="pg-tempo"><b id="pg-m">--</b><span>min</span></div>
          <div class="pg-tempo"><b id="pg-s">--</b><span>seg</span></div>
        </div>
        <div class="text-[11px] mt-2" style="color:#c7d2fe;">Antes disso, só estas duas já funcionam assim — <b class="text-white">salvo se o teste não for aprovado até o dia 15</b>.</div>
      </div>

      <div class="grid md:grid-cols-2 gap-4 items-start">
        <!-- Simulador -->
        <div class="rounded-2xl p-3 pg-vidro space-y-3">
          <div class="text-[11px] font-bold uppercase tracking-wider" style="color:#fde047;">🎮 Simule: escolha a consulta</div>
          <div class="grid grid-cols-2 gap-2">
            <button type="button" class="pg-chip pg-on" data-pg-svc="crlv" onclick="pgEscolherConsulta('crlv')">📄 CRLV-e Rio de Janeiro<br><b>R$ 20,00</b></button>
            <button type="button" class="pg-chip" data-pg-svc="cancel" onclick="pgEscolherConsulta('cancel')">🚫 Cancelamento de ATPV-e<br><b>R$ 130,00</b></button>
          </div>
          <div class="text-[11px] font-bold uppercase tracking-wider" style="color:#fde047;">E como você quer pagar?</div>
          <div class="space-y-1.5">
            <button type="button" class="pg-op" data-pg-op="saldo" onclick="pgEscolherForma('saldo')"><span>💰</span><div><b>Usar saldo</b><small>Desconta dos seus créditos</small></div></button>
            <button type="button" class="pg-op" data-pg-op="recarga" onclick="pgEscolherForma('recarga')"><span>🔋</span><div><b>Recarga PIX</b><small>Põe créditos para usar em qualquer consulta</small></div></button>
            <button type="button" class="pg-op pg-on pg-op-novo" data-pg-op="avulso" onclick="pgEscolherForma('avulso')"><span>🎯</span><div><b>Pague Apenas Esta Consulta <em>NOVO</em></b><small>QR Code só dessa consulta — não saiu, volta</small></div></button>
          </div>
        </div>

        <!-- Palco da simulação -->
        <div class="rounded-2xl p-3 pg-vidro">
          <div id="pg-palco" class="space-y-2" aria-live="polite"></div>
        </div>
      </div>

      <!-- Política -->
      <div class="rounded-2xl pg-vidro overflow-hidden">
        <button type="button" onclick="pgPolitica()" class="w-full flex items-center justify-between gap-2 px-4 py-3 text-left">
          <span class="text-sm font-extrabold">📄 Política de recarga e não estorno <span class="font-normal text-xs" style="color:#c7d2fe;">— leia com atenção</span></span>
          <span id="pg-seta" class="transition-transform">▾</span>
        </button>
        <div id="pg-politica" class="hidden px-4 pb-4 text-xs leading-relaxed space-y-2" style="color:#e0e7ff;">
          <p>Ao recarregar, você marca <b class="text-white">"Li e concordo com os Termos de Uso, inclusive com a política de recarga e não estorno em caso de indisponibilidade de APIs/órgãos oficiais"</b>. Marcar o X equivale a assinar: <b class="text-white">você concordou com tudo</b>, como em qualquer contrato digital.</p>
          <p>A recarga PIX coloca <b class="text-white">saldo para usar o Portal</b> em qualquer consulta, e não uma consulta específica — por isso <b class="text-white">não há estorno do saldo</b>. As exceções são raras: valor muito acima do pretendido por engano (devolvemos a diferença) e situações extremamente peculiares.</p>
          <p>Quer a garantia de reembolso em uma consulta só? Use <b class="text-white">"Pague Apenas Esta Consulta"</b>: se a consulta não for concluída, o valor volta para o PIX de origem.</p>
          <a href="/termos" target="_blank" rel="noopener" class="inline-block underline font-bold text-white">Ler os Termos de Uso completos →</a>
        </div>
      </div>

      <label class="flex items-start gap-2 text-xs cursor-pointer" style="color:#e0e7ff;">
        <input id="pg-ciente" type="checkbox" class="mt-0.5" onchange="document.getElementById('pg-ok').disabled=!this.checked">
        <span>Entendi que <b class="text-white">saldo de recarga não é estornável</b> e que o reembolso automático vale apenas em <b class="text-white">Pague Apenas Esta Consulta</b>.</span>
      </label>
      <div class="flex gap-3">
        <button id="pg-ok" disabled onclick="fecharPopupPagamento(true)" class="pg-cta flex-1 py-3 rounded-xl font-extrabold text-sm text-white transition-transform hover:scale-105 active:scale-95">✅ Li e entendi</button>
        <button onclick="fecharPopupPagamento(false)" class="px-4 py-3 rounded-xl font-semibold text-sm transition-transform hover:scale-105" style="background:rgba(255,255,255,.1);color:#cbd5e1;border:1px solid rgba(255,255,255,.18);">Depois</button>
      </div>
    </div>
  </div>
  </div>
</div>

<style>
#popup-pagamento .pg-card { animation: pgEntra .5s cubic-bezier(.175,.885,.32,1.275) both; }
#popup-pagamento .pg-fundo { background: linear-gradient(135deg,#0f172a,#312e81,#0e7490,#065f46,#312e81); background-size: 300% 300%; animation: pgFundo 14s ease infinite; }
#popup-pagamento .pg-brilho { background: radial-gradient(circle, rgba(99,102,241,.5), transparent 65%); animation: pgFlutua 7s ease-in-out infinite; pointer-events: none; }
#popup-pagamento .pg-brilho-2 { background: radial-gradient(circle, rgba(52,211,153,.35), transparent 65%); animation-delay: -3.5s; }
#popup-pagamento .pg-fita { background: linear-gradient(90deg,#6366f1,#22d3ee,#34d399,#fde047,#f97316,#6366f1); background-size: 200% 100%; animation: pgFita 3s linear infinite; }
#popup-pagamento .pg-icone { background: linear-gradient(135deg,#6366f1,#22d3ee); animation: pgPulso 1.8s ease-out infinite, pgBalanca 2.6s ease-in-out infinite; }
#popup-pagamento .pg-selo { color: #052e16; background: linear-gradient(90deg,#fde047,#facc15,#fde047); background-size: 200% 100%; animation: pgFita 2.5s linear infinite; }
#popup-pagamento .pg-degrade { background: linear-gradient(90deg,#67e8f9,#fde047,#86efac,#67e8f9); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: pgFita 3s linear infinite; }
#popup-pagamento .pg-vidro { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); }
#popup-pagamento .pg-tempo { min-width: 54px; padding: 6px 4px; border-radius: 12px; background: rgba(0,0,0,.3); }
#popup-pagamento .pg-tempo b { display: block; font-size: 22px; font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
#popup-pagamento .pg-tempo span { font-size: 10px; color: #a5b4fc; text-transform: uppercase; letter-spacing: .05em; }
#popup-pagamento .pg-chip { font-size: 11px; line-height: 1.3; color: #e0e7ff; background: rgba(255,255,255,.08); border: 1.5px solid rgba(255,255,255,.2); border-radius: 12px; padding: 7px 6px; transition: all .2s; }
#popup-pagamento .pg-chip b { color: #fde047; font-size: 13px; }
#popup-pagamento .pg-chip:hover, #popup-pagamento .pg-op:hover { transform: translateY(-2px); }
#popup-pagamento .pg-op { width: 100%; display: flex; align-items: center; gap: 10px; text-align: left; padding: 8px 10px; border-radius: 12px; background: rgba(255,255,255,.07); border: 1.5px solid rgba(255,255,255,.18); transition: all .2s; }
#popup-pagamento .pg-op > span { font-size: 20px; }
#popup-pagamento .pg-op b { display: block; font-size: 12.5px; color: #fff; }
#popup-pagamento .pg-op small { display: block; font-size: 10.5px; color: #c7d2fe; }
#popup-pagamento .pg-op em { font-style: normal; font-size: 9px; font-weight: 900; background: #4ade80; color: #052e16; border-radius: 999px; padding: 1px 6px; margin-left: 4px; }
#popup-pagamento .pg-on { background: rgba(99,102,241,.35); border-color: #a5b4fc; box-shadow: 0 0 0 3px rgba(165,180,252,.25); }
#popup-pagamento .pg-op-novo:not(.pg-on) { border-color: #4ade80; animation: pgBate 1.8s ease-in-out infinite; }
#popup-pagamento .pg-passo { opacity: 0; display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.35; color: #e0e7ff; background: rgba(0,0,0,.25); border-radius: 10px; padding: 7px 9px; animation: pgMsg .45s ease-out forwards; }
#popup-pagamento .pg-passo > span:first-child { font-size: 16px; }
#popup-pagamento .pg-passo b { color: #fff; }
#popup-pagamento .pg-qr { width: 78px; height: 78px; border-radius: 8px; background: #fff; padding: 5px; display: grid; grid-template-columns: repeat(9,1fr); gap: 1px; }
#popup-pagamento .pg-qr i { background: #0f172a; border-radius: 1px; }
#popup-pagamento .pg-qr i.b { background: transparent; }
#popup-pagamento .pg-res { display: flex; gap: 6px; }
#popup-pagamento .pg-res button { flex: 1; font-size: 11px; font-weight: 700; padding: 6px 4px; border-radius: 10px; color: #e0e7ff; background: rgba(255,255,255,.1); border: 1.5px solid rgba(255,255,255,.2); }
#popup-pagamento .pg-res button.pg-on { color: #fff; }
#popup-pagamento .pg-cta { background: linear-gradient(135deg,#6366f1,#0ea5e9); box-shadow: 0 6px 20px rgba(99,102,241,.5); }
#popup-pagamento .pg-cta:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; transform: none !important; }
#popup-pagamento .pg-aviso { font-size: 11.5px; line-height: 1.35; border-radius: 10px; padding: 7px 9px; font-weight: 700; }
@keyframes pgEntra { from { opacity: 0; transform: scale(.75) translateY(30px); } to { opacity: 1; transform: none; } }
@keyframes pgFundo { 0%,100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
@keyframes pgFita { from { background-position: 0% 0; } to { background-position: 200% 0; } }
@keyframes pgFlutua { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(18px,22px) scale(1.15); } }
@keyframes pgPulso { 0% { box-shadow: 0 0 0 0 rgba(99,102,241,.6); } 100% { box-shadow: 0 0 0 16px rgba(99,102,241,0); } }
@keyframes pgBalanca { 0%,100% { transform: rotate(0); } 20% { transform: rotate(-10deg); } 40% { transform: rotate(8deg); } 60% { transform: rotate(-4deg); } 80% { transform: rotate(0); } }
@keyframes pgBate { 0%,100% { transform: scale(1); } 50% { transform: scale(1.03); } }
@keyframes pgMsg { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  #popup-pagamento *, #popup-pagamento .pg-card { animation: none !important; }
  #popup-pagamento .pg-passo { opacity: 1; }
}
</style>

`;
  function montar(){ if(document.getElementById("popup-pagamento")) return; document.body.insertAdjacentHTML("beforeend", html); iniciar(); }
  function iniciar(){

// ── Popup "Nova forma de pagamento" ──────────────────────────────────────────
(function () {
  const INICIO_GERAL = Date.UTC(2026, 11, 15, 3, 0, 0); // 15/12/2026 00:00 em Brasília (UTC-3)
  const CHAVE = 'popupPagamentoLido_v1';
  const SVCS = { crlv: { nome: 'CRLV-e Rio de Janeiro', preco: 'R$ 20,00' }, cancel: { nome: 'Cancelamento de ATPV-e', preco: 'R$ 130,00' } };
  let svc = 'crlv', forma = 'avulso', resultado = 'ok', timer = null;

  const el = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');

  function tique() {
    let ms = Math.max(0, INICIO_GERAL - Date.now());
    const d = Math.floor(ms / 864e5); ms -= d * 864e5;
    const h = Math.floor(ms / 36e5); ms -= h * 36e5;
    const m = Math.floor(ms / 6e4); ms -= m * 6e4;
    const s = Math.floor(ms / 1e3);
    el('pg-d').textContent = d; el('pg-h').textContent = pad(h); el('pg-m').textContent = pad(m); el('pg-s').textContent = pad(s);
  }

  function qr() {
    // Desenho decorativo (não é QR de verdade): cantos fixos + miolo aleatório.
    let c = '';
    for (let i = 0; i < 81; i++) {
      const x = i % 9, y = Math.floor(i / 9);
      const canto = (x < 3 && y < 3) || (x > 5 && y < 3) || (x < 3 && y > 5);
      const vazio = canto ? (x % 2 === 1 && y % 2 === 1) : Math.random() <= 0.5;
      c += '<i class="' + (vazio ? 'b' : '') + '"></i>';
    }
    return '<div class="pg-qr">' + c + '</div>';
  }

  function palco() {
    const s = SVCS[svc];
    const p = (ic, t, i) => '<div class="pg-passo" style="animation-delay:' + (i * 0.25) + 's"><span>' + ic + '</span><div>' + t + '</div></div>';
    const amarelo = 'background:rgba(250,204,21,.18);color:#fde68a;';
    let h = '';
    if (forma === 'saldo') {
      h += p('1️⃣', 'Você clica em <b>Consultar</b> e escolhe <b>Usar saldo</b>.', 0);
      h += p('💰', 'Os <b>' + s.preco + '</b> saem dos seus créditos.', 1);
      h += p('📎', 'Recebe o PDF de <b>' + s.nome + '</b>.', 2);
      h += '<div class="pg-aviso" style="' + amarelo + '">⚠️ Saldo é para usar o Portal em qualquer consulta — não é estornável.</div>';
    } else if (forma === 'recarga') {
      h += p('1️⃣', 'Você faz uma <b>Recarga PIX</b> de qualquer valor.', 0);
      h += p('🔋', 'O valor vira <b>créditos</b> para qualquer consulta, na hora que quiser.', 1);
      h += p('📎', 'Usa <b>' + s.nome + '</b> (' + s.preco + ') e as outras que precisar.', 2);
      h += '<div class="pg-aviso" style="' + amarelo + '">⚠️ Recarga é saldo do Portal: <b>não há estorno</b>, salvo valor muito alto por engano.</div>';
    } else {
      h += p('1️⃣', 'Você informa a placa e escolhe <b>Pague Apenas Esta Consulta</b>.', 0);
      h += '<div class="pg-passo" style="animation-delay:.25s"><span>🔳</span><div>Aparece na hora o <b>QR Code e o copia e cola</b> de ' + s.preco + ' — só da ' + s.nome + '.<div class="mt-2">' + qr() + '</div></div></div>';
      h += p('⚡', 'Pagou? A consulta roda sozinha.', 2);
      h += '<div class="pg-res" role="group" aria-label="Resultado da consulta"><button type="button" class="' + (resultado === 'ok' ? 'pg-on' : '') + '" onclick="pgResultado(\'ok\')">✅ A consulta saiu</button><button type="button" class="' + (resultado === 'erro' ? 'pg-on' : '') + '" onclick="pgResultado(\'erro\')">❌ Não saiu</button></div>';
      if (resultado === 'ok') {
        h += p('📎', 'Você recebe o <b>PDF</b> na tela e no histórico. Pronto!', 3);
      } else {
        h += p('↩️', 'O PIX é <b>devolvido automaticamente</b> para a conta de quem pagou — <b>sem você pedir</b>.', 3);
        h += '<div class="pg-aviso" style="background:rgba(74,222,128,.2);color:#bbf7d0;">💚 Dinheiro de volta: ' + s.preco + ' no PIX de origem.</div>';
      }
    }
    el('pg-palco').innerHTML = h;
    document.querySelectorAll('#popup-pagamento [data-pg-svc]').forEach(b => b.classList.toggle('pg-on', b.dataset.pgSvc === svc));
    document.querySelectorAll('#popup-pagamento [data-pg-op]').forEach(b => b.classList.toggle('pg-on', b.dataset.pgOp === forma));
  }

  window.pgEscolherConsulta = k => { svc = k; palco(); };
  window.pgEscolherForma = k => { forma = k; if (k === 'avulso') resultado = 'ok'; palco(); };
  window.pgResultado = k => { resultado = k; palco(); };
  window.pgPolitica = () => {
    const aberto = el('pg-politica').classList.toggle('hidden') === false;
    el('pg-seta').style.transform = aberto ? 'rotate(180deg)' : '';
  };

  window.abrirPopupPagamento = function () {
    const m = el('popup-pagamento'); if (!m) return;
    m.classList.remove('hidden'); m.style.opacity = ''; m.style.transform = '';
    svc = 'crlv'; forma = 'avulso'; resultado = 'ok';
    el('pg-ciente').checked = false; el('pg-ok').disabled = true;
    palco(); tique(); clearInterval(timer); timer = setInterval(tique, 1000);
  };

  window.fecharPopupPagamento = function (lido) {
    const m = el('popup-pagamento'); if (!m) return;
    clearInterval(timer);
    m.style.transition = 'opacity .3s,transform .3s'; m.style.opacity = '0'; m.style.transform = 'scale(.95)';
    setTimeout(() => m.classList.add('hidden'), 300);
  };

  document.addEventListener('keydown', e => {
    const m = el('popup-pagamento');
    if (e.key === 'Escape' && m && !m.classList.contains('hidden')) fecharPopupPagamento(false);
  });

  // Abre TODA vez que o painel é acessado (pedido do dono, 23/11/2026). Vale também para pós-pago
  // (dono, 23/11/2026), com uma nota explicando que a conta dele vai para a fatura.
  // Abre na hora (sem esperar a rede); quem é pós-pago fecha em seguida.
  abrirPopupPagamento();
  fetch('/api/auth/me').then(r => r.json()).then(u => { if (u && u.pos_pago) el('pg-pos-nota').classList.remove('hidden'); }).catch(() => {});
})();

  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", montar); else montar();
})();
