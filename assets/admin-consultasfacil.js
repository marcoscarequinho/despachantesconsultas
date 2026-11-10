// Admin → Saldo Consultas Fácil (04/11/2026). A Consultas Fácil não tem rota
// de saldo, então o valor é ESTIMADO como o da DirectData: o saldo que o admin
// informa menos R$ 5,00 (fixo no servidor, CONSULTASFACIL_CUSTO_CONSULTA) × respostas com PDF desde então. O único
// dado de verdade que ela dá é o "Saldo insuficiente" — esse vira o aviso
// vermelho no topo. A regra mora no server.js (saldoConsultaFacil /
// registrarConsultaFacil); aqui é só a tela. Usa fmt, fmtDate e toast do admin.html.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const brl = n => String(Number(n).toFixed(2)).replace('.', ',');

  function montarSecao() {
    const sec = document.getElementById('section-consultasfacil');
    if (!sec || sec.dataset.pronta) return;
    sec.dataset.pronta = '1';
    sec.innerHTML = `
      <div>
        <h2 class="text-xl font-bold text-gray-800">Saldo Consultas Fácil (pré-pago)</h2>
        <p class="text-sm text-gray-500">
          Fornecedor da <strong>Reemissão da ATPVe Com Comunicação de Venda</strong> e do <strong>Numero ATPVe Brasil</strong>
          (1ª opção; a despbrasil é a reserva). A Consultas Fácil não tem rota para consultar o saldo, então o valor abaixo é
          <strong>estimado</strong>: o último saldo informado menos o custo de cada consulta que voltou com PDF desde então.
          Quando a API responde <em>"Saldo insuficiente"</em>, aparece o aviso vermelho e o WhatsApp do admin é avisado uma vez.
          Depois de recarregar, informe aqui o saldo do painel deles — isso rearma os avisos.
        </p>
      </div>

      <div id="cf-avisos" class="space-y-2"></div>

      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="stat-card border-l-blue-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Saldo estimado</div>
          <div id="cf-saldo" class="text-2xl font-bold text-gray-800">—</div>
          <div id="cf-saldo-base" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-amber-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Gasto hoje</div>
          <div id="cf-hoje" class="text-2xl font-bold text-gray-800">—</div>
          <div id="cf-hoje-n" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-purple-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Gasto no mês</div>
          <div id="cf-mes" class="text-2xl font-bold text-gray-800">—</div>
          <div id="cf-mes-n" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
        <div class="stat-card border-l-red-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Custo por consulta</div>
          <div id="cf-custo" class="text-2xl font-bold text-gray-800">—</div>
          <div id="cf-alerta" class="text-xs text-gray-400 mt-0.5"></div>
        </div>
      </div>

      <div class="card">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Saldo atual no painel deles (R$)</label>
            <input id="cf-input-saldo" type="text" inputmode="decimal" class="input-field w-44" placeholder="ex.: 300,00">
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Avisar abaixo de (R$)</label>
            <input id="cf-input-alerta" type="text" inputmode="decimal" class="input-field w-44" placeholder="ex.: 30,00">
          </div>
          <button id="cf-salvar" class="btn-primary">💾 Salvar</button>
          <button id="cf-atualizar" class="btn-secondary">🔄 Atualizar</button>
          <a href="https://www.consultasfacil.net" target="_blank" rel="noopener" class="text-sm text-blue-600 hover:underline ml-auto">Abrir Consultas Fácil ↗</a>
        </div>
      </div>

      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <div class="font-semibold text-gray-700">Últimas chamadas</div>
          <div class="text-xs text-gray-500">Só as que voltaram com PDF descontam do saldo.</div>
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
            <tbody id="cf-consumo-tbody" class="divide-y divide-gray-50"></tbody>
          </table>
        </div>
      </div>`;
    document.getElementById('cf-salvar').onclick = salvar;
    document.getElementById('cf-atualizar').onclick = () => window.loadConsultasFacil();
  }

  window.loadConsultasFacil = async function () {
    montarSecao();
    try {
      const r = await fetch('/api/admin/consultasfacil');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Erro ao carregar o saldo da Consultas Fácil.', 'error'); return; }
      const s = d.saldo;
      const baixo = s.saldoEstimado < s.alertaAbaixo;
      const el = document.getElementById('cf-saldo');
      el.textContent = fmt(s.saldoEstimado);
      el.className = `text-2xl font-bold ${(baixo || s.semSaldoEm) ? 'text-red-600' : 'text-gray-800'}`;
      document.getElementById('cf-saldo-base').textContent =
        `${fmt(s.saldoBase)} informado em ${fmtDate(s.baseEm)} − ${fmt(s.gastoDesdeBase)} em ${s.consultasDesdeBase} consulta(s)`;
      document.getElementById('cf-hoje').textContent = fmt(d.hoje);
      document.getElementById('cf-hoje-n').textContent = `${d.hojeConsultas} consulta(s) com PDF`;
      document.getElementById('cf-mes').textContent = fmt(d.mes);
      document.getElementById('cf-mes-n').textContent = `${d.mesConsultas} consulta(s) com PDF`;
      document.getElementById('cf-custo').textContent = fmt(s.custoConsulta);
      document.getElementById('cf-alerta').textContent =
        `fixo · alerta abaixo de ${fmt(s.alertaAbaixo)}${s.alertaEnviadoEm ? ` (aviso enviado em ${fmtDate(s.alertaEnviadoEm)})` : ''}`;
      // O alerta salvo fica escrito no campo (antes ele esvaziava depois de
      // salvar e parecia que não tinha gravado). Não mexe se o admin está digitando.
      const inAlerta = document.getElementById('cf-input-alerta');
      if (document.activeElement !== inAlerta) inAlerta.value = brl(s.alertaAbaixo);

      const avisos = [];
      if (s.semSaldoEm) avisos.push(['red', `A Consultas Fácil respondeu "Saldo insuficiente" em ${fmtDate(s.semSaldoEm)}. Enquanto não recarregar, a Reemissão da ATPVe e o Numero ATPVe Brasil vão só pela despbrasil. Recarregue e informe o saldo novo aqui.`]);
      if (!d.chaveConfigurada) avisos.push(['amber', 'CONSULTASFACIL_KEY não está configurada no servidor — as consultas vão falhar.']);
      if (baixo && !s.semSaldoEm) avisos.push(['amber', `Saldo estimado abaixo de ${fmt(s.alertaAbaixo)}. Recarregue e informe o saldo novo aqui.`]);
      const cor = { red: 'bg-red-50 border-red-200 text-red-800', amber: 'bg-amber-50 border-amber-200 text-amber-800' };
      document.getElementById('cf-avisos').innerHTML = avisos.map(([c, a]) =>
        `<div class="${cor[c]} border text-sm rounded-lg px-4 py-2">${c === 'red' ? '🚨' : '⚠️'} ${esc(a)}</div>`).join('');

      document.getElementById('cf-consumo-tbody').innerHTML = d.consumo.length ? d.consumo.map(c => {
        const semSaldo = /saldo insuficiente/i.test(c.resposta || '');
        const selo = c.pdf ? 'bg-green-100 text-green-700' : semSaldo ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600';
        const txt = c.pdf ? 'PDF' : `HTTP ${c.http_status} · ${c.resposta || '—'}`;
        return `<tr>
          <td class="px-4 py-2 text-gray-600 whitespace-nowrap">${fmtDate(c.created_at)}</td>
          <td class="px-4 py-2">${esc(c.origem || '—')}</td>
          <td class="px-4 py-2 font-mono">${esc(c.placa || '—')}</td>
          <td class="px-4 py-2"><span class="text-xs px-2 py-0.5 rounded-full ${selo}">${esc(txt.slice(0, 120))}</span></td>
          <td class="px-4 py-2 text-right font-medium">${c.custo ? fmt(c.custo) : '—'}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="5" class="px-4 py-6 text-center text-gray-400">Nenhuma chamada registrada ainda.</td></tr>';
    } catch { toast('Erro de conexão ao carregar o saldo da Consultas Fácil.', 'error'); }
  };

  async function salvar() {
    const v = id => document.getElementById(id).value.trim();
    // "1.250,00" e "30,00" (ponto de milhar só quando há vírgula) e também "30.00".
    const num = x => x ? (x.includes(',') ? x.replace(/\./g, '').replace(',', '.') : x) : undefined;
    const saldo = v('cf-input-saldo'), alertaAbaixo = v('cf-input-alerta');
    if (!saldo && !alertaAbaixo) { toast('Informe o saldo ou o valor do alerta.', 'error'); return; }
    try {
      const r = await fetch('/api/admin/consultasfacil/saldo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saldo: num(saldo), alertaAbaixo: num(alertaAbaixo) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Erro ao salvar.', 'error'); return; }
      document.getElementById('cf-input-saldo').value = '';
      toast(saldo ? 'Saldo da Consultas Fácil atualizado.' : 'Valor do alerta salvo.');
      window.loadConsultasFacil();
    } catch { toast('Erro de conexão.', 'error'); }
  }
})();
