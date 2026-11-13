// Admin → Saldo Placa Fácil (13/11/2026). Fornecedor da "Consulta Código
// Segurança CRV v2 (PDF)" (placa-fcil-pro.base44.app). Mesmo desenho da tela
// da Consultas Fácil: saldo ESTIMADO = o que o admin informa menos o custo de
// cada consulta com sucesso desde então. O custo vem do "valor_cobrado" da
// resposta deles; consulta com sucesso registrada sem custo vira aviso, porque
// aí o saldo estimado não desce. A regra mora no server.js (saldoPlacaFacil /
// registrarPlacaFacil); aqui é só a tela. Usa fmt, fmtDate e toast do admin.html.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const brl = n => String(Number(n).toFixed(2)).replace('.', ',');

  function montarSecao() {
    const sec = document.getElementById('section-placafacil');
    if (!sec || sec.dataset.pronta) return;
    sec.dataset.pronta = '1';
    sec.innerHTML = `
      <div>
        <h2 class="text-xl font-bold text-gray-800">Saldo Placa Fácil (pré-pago)</h2>
        <p class="text-sm text-gray-500">
          Fornecedor da <strong>Consulta Código Segurança CRV v2 (PDF)</strong>. O valor abaixo é <strong>estimado</strong>:
          o último saldo informado menos o custo de cada consulta que saiu desde então. Quando a API recusa por falta de saldo,
          aparece o aviso vermelho e o WhatsApp do admin é avisado uma vez. Depois de recarregar, informe aqui o saldo do
          painel deles — isso rearma os avisos.
        </p>
      </div>

      <div id="pf-avisos" class="space-y-2"></div>

      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="stat-card border-l-blue-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Saldo estimado</div>
          <div id="pf-saldo" class="text-2xl font-bold text-gray-800">—</div>
          <div id="pf-saldo-base" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-amber-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Gasto hoje</div>
          <div id="pf-hoje" class="text-2xl font-bold text-gray-800">—</div>
          <div id="pf-hoje-n" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-purple-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Gasto no mês</div>
          <div id="pf-mes" class="text-2xl font-bold text-gray-800">—</div>
          <div id="pf-mes-n" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-red-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Custo por consulta</div>
          <div id="pf-custo" class="text-2xl font-bold text-gray-800">—</div>
          <div id="pf-alerta" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
      </div>

      <div class="card">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Saldo atual no painel deles (R$)</label>
            <input id="pf-input-saldo" type="text" inputmode="decimal" class="input-field w-44" placeholder="ex.: 300,00">
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Avisar abaixo de (R$)</label>
            <input id="pf-input-alerta" type="text" inputmode="decimal" class="input-field w-44" placeholder="ex.: 30,00">
          </div>
          <button id="pf-salvar" class="btn-primary">💾 Salvar</button>
          <button id="pf-atualizar" class="btn-secondary">🔄 Atualizar</button>
          <a href="https://placa-fcil-pro.base44.app" target="_blank" rel="noopener" class="text-sm text-blue-600 hover:underline ml-auto">Abrir Placa Fácil ↗</a>
        </div>
      </div>

      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <div class="font-semibold text-gray-700">Últimas chamadas</div>
          <div class="text-xs text-gray-500">Só as que saíram descontam do saldo.</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th class="px-4 py-2 text-left">Quando</th>
                <th class="px-4 py-2 text-left">Origem</th>
                <th class="px-4 py-2 text-left">Placa</th>
                <th class="px-4 py-2 text-left">Resposta</th>
                <th class="px-4 py-2 text-right">Custo</th>
              </tr>
            </thead>
            <tbody id="pf-consumo-tbody" class="divide-y divide-gray-50"></tbody>
          </table>
        </div>
      </div>`;
    document.getElementById('pf-salvar').onclick = salvar;
    document.getElementById('pf-atualizar').onclick = () => window.loadPlacaFacil();
  }

  window.loadPlacaFacil = async function () {
    montarSecao();
    try {
      const r = await fetch('/api/admin/placafacil');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Erro ao carregar o saldo da Placa Fácil.', 'error'); return; }
      const s = d.saldo;
      const baixo = s.saldoEstimado < s.alertaAbaixo;
      const el = document.getElementById('pf-saldo');
      el.textContent = fmt(s.saldoEstimado);
      el.className = `text-2xl font-bold ${(baixo || s.semSaldoEm) ? 'text-red-600' : 'text-gray-800'}`;
      document.getElementById('pf-saldo-base').textContent =
        `${fmt(s.saldoBase)} informado em ${fmtDate(s.baseEm)} − ${fmt(s.gastoDesdeBase)} em ${s.consultasDesdeBase} consulta(s)`;
      document.getElementById('pf-hoje').textContent = fmt(d.hoje);
      document.getElementById('pf-hoje-n').textContent = `${d.hojeConsultas} consulta(s)`;
      document.getElementById('pf-mes').textContent = fmt(d.mes);
      document.getElementById('pf-mes-n').textContent = `${d.mesConsultas} consulta(s)`;
      // O custo de verdade é o que a API diz em cada resposta: mostra o da última que saiu.
      const ultima = d.consumo.find(c => c.sucesso && c.custo);
      document.getElementById('pf-custo').textContent = ultima ? fmt(ultima.custo) : (s.custoConsulta ? fmt(s.custoConsulta) : '—');
      document.getElementById('pf-alerta').textContent =
        `${ultima ? 'da última consulta' : 'ainda sem consulta'} · alerta abaixo de ${fmt(s.alertaAbaixo)}${s.alertaEnviadoEm ? ` (aviso enviado em ${fmtDate(s.alertaEnviadoEm)})` : ''}`;
      const inAlerta = document.getElementById('pf-input-alerta');
      if (document.activeElement !== inAlerta) inAlerta.value = brl(s.alertaAbaixo);

      const avisos = [];
      if (s.semSaldoEm) avisos.push(['red', `A Placa Fácil recusou uma consulta por falta de saldo em ${fmtDate(s.semSaldoEm)}. Enquanto não recarregar, a Consulta Código Segurança CRV v2 não sai. Recarregue e informe o saldo novo aqui.`]);
      if (!d.chaveConfigurada) avisos.push(['amber', 'PLACAFACIL_KEY não está configurada no servidor — as consultas vão falhar.']);
      if (s.consultasSemCusto && !s.custoConsulta) avisos.push(['amber', `${s.consultasSemCusto} consulta(s) saíram sem a API informar o valor cobrado — elas não foram descontadas do saldo estimado. Confira o saldo no painel deles e informe aqui.`]);
      if (baixo && !s.semSaldoEm) avisos.push(['amber', `Saldo estimado abaixo de ${fmt(s.alertaAbaixo)}. Recarregue e informe o saldo novo aqui.`]);
      const cor = { red: 'bg-red-50 border-red-200 text-red-800', amber: 'bg-amber-50 border-amber-200 text-amber-800' };
      document.getElementById('pf-avisos').innerHTML = avisos.map(([c, a]) =>
        `<div class="${cor[c]} border text-sm rounded-lg px-4 py-2">${c === 'red' ? '🚨' : '⚠️'} ${esc(a)}</div>`).join('');

      document.getElementById('pf-consumo-tbody').innerHTML = d.consumo.length ? d.consumo.map(c => {
        const semSaldo = /saldo/i.test(c.resposta || '');
        const selo = c.sucesso ? 'bg-green-100 text-green-700' : semSaldo ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600';
        const txt = c.sucesso ? 'Saiu' : `HTTP ${c.http_status} · ${c.resposta || '—'}`;
        return `<tr>
          <td class="px-4 py-2 text-gray-600 whitespace-nowrap">${fmtDate(c.created_at)}</td>
          <td class="px-4 py-2">${esc(c.origem || '—')}</td>
          <td class="px-4 py-2 font-mono">${esc(c.placa || '—')}</td>
          <td class="px-4 py-2"><span class="text-xs px-2 py-0.5 rounded-full ${selo}">${esc(txt.slice(0, 120))}</span></td>
          <td class="px-4 py-2 text-right font-medium">${c.custo ? fmt(c.custo) : '—'}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="5" class="px-4 py-6 text-center text-gray-400">Nenhuma chamada registrada ainda.</td></tr>';
    } catch { toast('Erro de conexão ao carregar o saldo da Placa Fácil.', 'error'); }
  };

  async function salvar() {
    const v = id => document.getElementById(id).value.trim();
    // "1.250,00" e "30,00" (ponto de milhar só quando há vírgula) e também "30.00".
    const num = x => x ? (x.includes(',') ? x.replace(/\./g, '').replace(',', '.') : x) : undefined;
    const saldo = v('pf-input-saldo'), alertaAbaixo = v('pf-input-alerta');
    if (!saldo && !alertaAbaixo) { toast('Informe o saldo ou o valor do alerta.', 'error'); return; }
    try {
      const r = await fetch('/api/admin/placafacil/saldo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saldo: num(saldo), alertaAbaixo: num(alertaAbaixo) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Erro ao salvar.', 'error'); return; }
      document.getElementById('pf-input-saldo').value = '';
      toast(saldo ? 'Saldo da Placa Fácil atualizado.' : 'Valor do alerta salvo.');
      window.loadPlacaFacil();
    } catch { toast('Erro de conexão.', 'error'); }
  }
})();
