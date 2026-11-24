// Admin → Saldo CRDD (24/11/2026). Fornecedor do ATPVe Rio v2 (portal do
// CRDD-RJ, acessado por login e senha). Diferente da Consultas Fácil e da Placa
// Fácil, aqui o saldo NÃO é estimado: o portal mostra o saldo pré-pago no
// cabeçalho e o servidor lê esse valor a cada abertura da tela, a cada pedido e
// no cron de 15 em 15 minutos (conferirSaldoCrdd no server.js). O custo de
// R$ 26,90 por ATPV-e entregue serve para o controle de lucro. Usa fmt, fmtDate
// e toast do admin.html.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const brl = n => String(Number(n).toFixed(2)).replace('.', ',');
  const STATUS = {
    success:        ['Entregue',   'bg-green-100 text-green-700'],
    aguardando_pdf: ['Aguardando', 'bg-amber-100 text-amber-700'],
    cancelado:      ['Recusado',   'bg-red-100 text-red-700'],
  };

  function montarSecao() {
    const sec = document.getElementById('section-crdd');
    if (!sec || sec.dataset.pronta) return;
    sec.dataset.pronta = '1';
    sec.innerHTML = `
      <div>
        <h2 class="text-xl font-bold text-gray-800">Saldo CRDD (ATPVe Rio v2)</h2>
        <p class="text-sm text-gray-500">
          O saldo abaixo é o <strong>valor real</strong> do portal, lido agora. Cada ATPVe Rio v2 entregue custa
          <strong id="crdd-custo-un">R$ 26,90</strong> e o cliente paga <strong id="crdd-preco">R$ 46,00</strong>.
          Abaixo do valor de alerta o WhatsApp do admin é avisado uma vez; com o saldo menor que o custo, o serviço
          recusa o pedido sem cobrar o cliente.
        </p>
      </div>

      <div id="crdd-avisos" class="space-y-2"></div>

      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="stat-card border-l-blue-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Saldo no portal</div>
          <div id="crdd-saldo" class="text-2xl font-bold text-gray-800">—</div>
          <div id="crdd-saldo-sub" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-amber-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Hoje</div>
          <div id="crdd-hoje" class="text-2xl font-bold text-gray-800">—</div>
          <div id="crdd-hoje-sub" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-purple-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">No mês</div>
          <div id="crdd-mes" class="text-2xl font-bold text-gray-800">—</div>
          <div id="crdd-mes-sub" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-red-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Pedidos em andamento</div>
          <div id="crdd-pend" class="text-2xl font-bold text-gray-800">—</div>
          <div id="crdd-pend-sub" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
      </div>

      <div class="card">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Avisar abaixo de (R$)</label>
            <input id="crdd-input-alerta" type="text" inputmode="decimal" class="input-field w-44" placeholder="ex.: 200,00">
          </div>
          <button id="crdd-salvar" class="btn-primary">💾 Salvar alerta</button>
          <button id="crdd-atualizar" class="btn-secondary">🔄 Atualizar</button>
          <a href="https://portal.crddrj.com.br/carteira/relSaldo" target="_blank" rel="noopener" class="text-sm text-blue-600 hover:underline ml-auto">Abrir o saldo no portal ↗</a>
        </div>
      </div>

      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <div class="font-semibold text-gray-700">Últimos pedidos</div>
          <div class="text-xs text-gray-500">Só os entregues contam como custo. Recusado e aguardando não são cobrados do cliente.</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th class="px-4 py-2 text-left">Pedido</th>
                <th class="px-4 py-2 text-left">Quando</th>
                <th class="px-4 py-2 text-left">Cliente</th>
                <th class="px-4 py-2 text-left">Placa</th>
                <th class="px-4 py-2 text-left">Situação</th>
                <th class="px-4 py-2 text-right">Cobrado</th>
                <th class="px-4 py-2 text-right">Custo</th>
              </tr>
            </thead>
            <tbody id="crdd-tbody" class="divide-y divide-gray-50"></tbody>
          </table>
        </div>
      </div>`;
    document.getElementById('crdd-salvar').onclick = salvar;
    document.getElementById('crdd-atualizar').onclick = () => window.loadCrdd();
  }

  window.loadCrdd = async function () {
    montarSecao();
    try {
      const r = await fetch('/api/admin/crdd');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Erro ao carregar o saldo do CRDD.', 'error'); return; }
      const baixo = d.saldo != null && d.saldo < d.alertaAbaixo;
      const semCusto = d.saldo != null && d.saldo < d.custoUnitario;
      document.getElementById('crdd-custo-un').textContent = fmt(d.custoUnitario);
      document.getElementById('crdd-preco').textContent = fmt(d.preco);
      const el = document.getElementById('crdd-saldo');
      el.textContent = d.saldo != null ? fmt(d.saldo) : '—';
      el.className = `text-2xl font-bold ${(baixo || semCusto) ? 'text-red-600' : 'text-gray-800'}`;
      document.getElementById('crdd-saldo-sub').textContent = d.saldo != null
        ? `lido ${d.erroLeitura ? 'por último ' : ''}em ${fmtDate(d.lidoEm)} · dá para ~${Math.max(0, Math.floor(d.saldo / d.custoUnitario))} ATPV-e`
        : 'sem leitura';
      const linha = x => `${x.n} entregue(s)`;
      const lucro = x => x.receita - x.custo;
      document.getElementById('crdd-hoje').textContent = fmt(lucro(d.hoje));
      document.getElementById('crdd-hoje-sub').textContent = `lucro · ${linha(d.hoje)} · custo ${fmt(d.hoje.custo)}`;
      document.getElementById('crdd-mes').textContent = fmt(lucro(d.mes));
      document.getElementById('crdd-mes-sub').textContent = `lucro · ${linha(d.mes)} · custo ${fmt(d.mes.custo)}`;
      document.getElementById('crdd-pend').textContent = d.pendentes;
      document.getElementById('crdd-pend-sub').textContent = `${d.recusadosMes} recusado(s) no mês`;
      const inAlerta = document.getElementById('crdd-input-alerta');
      if (document.activeElement !== inAlerta) inAlerta.value = brl(d.alertaAbaixo);

      const avisos = [];
      if (!d.credenciais) avisos.push(['red', 'CRDD_EMAIL / CRDD_SENHA não estão configurados no servidor — o ATPVe Rio v2 não consegue entrar no portal.']);
      else if (d.erroLeitura) avisos.push(['red', `Não consegui ler o saldo agora: ${d.erroLeitura}`]);
      if (semCusto) avisos.push(['red', `Saldo menor que o custo de um ATPV-e (${fmt(d.custoUnitario)}): o serviço está recusando pedidos, sem cobrar o cliente. Recarregue no portal.`]);
      else if (baixo) avisos.push(['amber', `Saldo abaixo de ${fmt(d.alertaAbaixo)}${d.alertaEnviadoEm ? ` (aviso enviado em ${fmtDate(d.alertaEnviadoEm)})` : ''}. Recarregue no portal.`]);
      const cor = { red: 'bg-red-50 border-red-200 text-red-800', amber: 'bg-amber-50 border-amber-200 text-amber-800' };
      document.getElementById('crdd-avisos').innerHTML = avisos.map(([c, a]) =>
        `<div class="${cor[c]} border text-sm rounded-lg px-4 py-2">${c === 'red' ? '🚨' : '⚠️'} ${esc(a)}</div>`).join('');

      document.getElementById('crdd-tbody').innerHTML = d.pedidos.length ? d.pedidos.map(p => {
        const [txt, selo] = STATUS[p.status] || [p.status, 'bg-gray-100 text-gray-600'];
        const entregue = p.status === 'success';
        return `<tr>
          <td class="px-4 py-2 font-mono text-gray-600">#${p.id}${p.crdd ? ` <span class="text-xs text-gray-400">(portal ${esc(p.crdd)})</span>` : ''}</td>
          <td class="px-4 py-2 text-gray-600 whitespace-nowrap">${fmtDate(p.created_at)}</td>
          <td class="px-4 py-2">${esc(p.cliente || p.email || '—')}</td>
          <td class="px-4 py-2 font-mono">${esc(p.placa || '—')}</td>
          <td class="px-4 py-2"><span class="text-xs px-2 py-0.5 rounded-full ${selo}" title="${esc(p.motivo || '')}">${esc(txt)}</span></td>
          <td class="px-4 py-2 text-right">${entregue ? fmt(p.amount) : '—'}</td>
          <td class="px-4 py-2 text-right font-medium">${entregue ? fmt(d.custoUnitario) : '—'}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="7" class="px-4 py-6 text-center text-gray-400">Nenhum pedido ainda.</td></tr>';
    } catch { toast('Erro de conexão ao carregar o saldo do CRDD.', 'error'); }
  };

  async function salvar() {
    const v = document.getElementById('crdd-input-alerta').value.trim();
    const num = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
    if (!num) { toast('Informe o valor do alerta.', 'error'); return; }
    try {
      const r = await fetch('/api/admin/crdd/alerta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertaAbaixo: num }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Erro ao salvar.', 'error'); return; }
      toast('Alerta salvo.', 'success');
      window.loadCrdd();
    } catch { toast('Erro de conexão ao salvar.', 'error'); }
  }
})();
