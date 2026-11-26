// Admin → ATPVe com Comunicação (26/11/2026). Pedidos agendados da "Reemissão
// da ATPVe Com Comunicação de Venda": o admin sobe o PDF "Número da ATPVe" e o
// servidor monta o documento e entrega (entregarAtpveAgendada no
// server.js). O cliente já pagou por PIX; sem entrega em 24 h o PIX é estornado. Usa fmt, fmtDate, toast e sectionTitles do admin.html.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const MAX = 3 * 1024 * 1024;
  const STATUS = {
    success:        ['Entregue',   'bg-green-100 text-green-700'],
    aguardando_pdf: ['Aguardando', 'bg-amber-100 text-amber-700'],
    cancelado:      ['Cancelado',  'bg-red-100 text-red-700'],
  };
  const enviando = new Set();   // pedidos sendo montados (a lista pode ser redesenhada no meio)
  let pedidos = [], prazoHoras = 24;

  if (typeof sectionTitles === 'object') sectionTitles['atpve-agendada'] = 'ATPVe com Comunicação de Venda';

  function montarSecao() {
    const sec = document.getElementById('section-atpve-agendada');
    if (!sec || sec.dataset.pronta) return;
    sec.dataset.pronta = '1';
    sec.innerHTML = `
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-gray-800">Reemissão da ATPVe Com Comunicação de Venda</h2>
          <p class="text-sm text-gray-500">Suba o PDF do <strong>Número da ATPVe</strong> (até 3 MB, com texto — foto não serve).
            O sistema monta o documento e entrega no Histórico e no WhatsApp (a montagem leva alguns minutos).
            O cliente já pagou por PIX: sem entrega em 24h, ou se você cancelar, o PIX é estornado e ele é avisado.</p>
        </div>
        <button id="agendada-atualizar" class="btn-secondary text-xs">🔄 Atualizar</button>
      </div>
      <div class="card p-0 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th class="px-4 py-2 text-left">Pedido</th>
                <th class="px-4 py-2 text-left">Cliente</th>
                <th class="px-4 py-2 text-left">Placa</th>
                <th class="px-4 py-2 text-right">Valor</th>
                <th class="px-4 py-2 text-left">Situação</th>
                <th class="px-4 py-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody id="agendada-tbody" class="divide-y divide-gray-50"></tbody>
          </table>
        </div>
      </div>
      <input id="agendada-arquivo" type="file" accept="application/pdf,.pdf" class="hidden">`;
    document.getElementById('agendada-atualizar').onclick = () => window.loadAtpveAgendada();
    document.getElementById('agendada-tbody').onclick = ev => {
      const b = ev.target.closest('button[data-acao]');
      if (!b) return;
      const id = Number(b.dataset.id);
      ({ enviar: escolherPdf, cancelar, reenviar }[b.dataset.acao])(id);
    };
  }

  function selo(n) {
    const el = document.getElementById('agendada-nav-badge');
    if (!el) return;
    el.textContent = n;
    el.classList.toggle('hidden', !n);
  }

  function linha(p) {
    const [txt, cls] = STATUS[p.status] || [p.status, 'bg-gray-100 text-gray-600'];
    const aberto = p.status === 'aguardando_pdf';
    const horas = (Date.now() - new Date(p.created_at).getTime()) / 3600000;
    const prazo = !aberto ? '' : horas > prazoHoras
      ? `<div class="text-xs font-semibold text-red-600">Atrasado (${Math.floor(horas)}h)</div>`
      : `<div class="text-xs text-gray-500">Faltam ${Math.ceil(prazoHoras - horas)}h</div>`;
    const estorno = p.estorno === 'DEVOLVIDO' ? '<div class="text-xs text-gray-500">PIX estornado</div>'
      : p.estorno === 'FALHOU' ? '<div class="text-xs font-semibold text-red-600">Estorno FALHOU — devolva pelo Mercado Pago</div>' : '';
    const botao = (acao, rotulo, extra) => `<button data-acao="${acao}" data-id="${p.id}" class="${extra} text-xs">${rotulo}</button>`;
    const acoes = aberto
      ? (enviando.has(p.id)
        ? '<span class="text-xs text-amber-700">⏳ Montando o documento…</span>'
        : botao('enviar', '📤 Enviar PDF do número', 'btn-primary') + ' ' + botao('cancelar', 'Cancelar e estornar', 'btn-secondary'))
      : p.tem_pdf
        ? `<a href="/api/admin/queries/${p.id}/pdf" target="_blank" class="btn-secondary text-xs">📄 Abrir</a> ${botao('reenviar', 'Reenviar WhatsApp', 'btn-secondary')}`
        : '—';
    return `<tr>
      <td class="px-4 py-2 text-gray-600 whitespace-nowrap"><span class="font-mono">#${p.id}</span><div class="text-xs text-gray-400">${fmtDate(p.created_at)}</div></td>
      <td class="px-4 py-2">${esc(p.cliente || p.email || '—')}<div class="text-xs text-gray-400">${esc(p.phone || 'sem telefone')}</div></td>
      <td class="px-4 py-2 font-mono">${esc(p.placa || '—')}</td>
      <td class="px-4 py-2 text-right whitespace-nowrap">${fmt(p.valor)}</td>
      <td class="px-4 py-2"><span class="text-xs px-2 py-0.5 rounded-full ${cls}">${esc(txt)}</span>${prazo}${estorno}</td>
      <td class="px-4 py-2 text-right whitespace-nowrap">${acoes}</td>
    </tr>`;
  }

  function desenhar() {
    const tbody = document.getElementById('agendada-tbody');
    if (!tbody) return;
    tbody.innerHTML = pedidos.length ? pedidos.map(linha).join('')
      : '<tr><td colspan="6" class="px-4 py-6 text-center text-gray-400">Nenhum pedido.</td></tr>';
  }

  async function buscar() {
    const r = await fetch('/api/admin/atpve-agendada');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Erro ao carregar os pedidos.');
    pedidos = d.pedidos;
    prazoHoras = d.prazoHoras;
    selo(pedidos.filter(p => p.status === 'aguardando_pdf').length);
  }

  window.loadAtpveAgendada = async function () {
    montarSecao();
    try { await buscar(); desenhar(); }
    catch (e) { toast(e.message || 'Erro de conexão.', 'error'); }
  };

  async function post(url, corpo) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    const d = await r.json().catch(() => ({ error: `O servidor não respondeu (HTTP ${r.status}). Atualize a lista antes de tentar de novo.` }));
    return { ok: r.ok, d };
  }

  function escolherPdf(id) {
    const input = document.getElementById('agendada-arquivo');
    input.value = '';
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return;
      if (f.size > MAX) return toast('PDF grande demais (máximo 3 MB).', 'error');
      const p = pedidos.find(x => x.id === id);
      if (!confirm(`Montar e entregar o documento da placa ${p?.placa} com o arquivo "${f.name}"?\nPago por PIX: ${fmt(p?.valor)}.`)) return;
      const leitor = new FileReader();
      leitor.onload = () => enviar(id, leitor.result, false);
      leitor.readAsDataURL(f);
    };
    input.click();
  }

  async function enviar(id, pdfBase64, semConferirPlaca) {
    enviando.add(id);
    desenhar();
    let repetir = false;
    try {
      const { ok, d } = await post(`/api/admin/atpve-agendada/${id}/entregar`, { pdfBase64, semConferirPlaca });
      if (ok) toast(`Pedido #${id} entregue${d.whatsapp ? ' e enviado no WhatsApp' : ' (sem WhatsApp — está no Histórico)'}.`, 'success');
      else if (d.code === 'PLACA_NAO_CONFERIDA') repetir = confirm(`${d.error}\n\nConfira o arquivo. Entregar assim mesmo?`);
      else alert(`Pedido #${id}: ${d.error || 'Erro ao entregar.'}`);
    } catch {
      alert(`Pedido #${id}: erro de conexão. Atualize a lista antes de tentar de novo.`);
    }
    enviando.delete(id);
    if (repetir) return enviar(id, pdfBase64, true);
    window.loadAtpveAgendada();
  }

  async function cancelar(id) {
    if (!confirm(`Cancelar o pedido #${id}? O PIX é estornado e o cliente recebe o aviso de que o Número da ATPVe não está disponível.`)) return;
    const { ok, d } = await post(`/api/admin/atpve-agendada/${id}/cancelar`);
    if (!ok) toast(d.error || 'Erro ao cancelar.', 'error');
    else if (d.estorno === 'FALHOU') alert(`Pedido #${id} cancelado, mas o estorno do PIX FALHOU. Devolva pelo Mercado Pago.`);
    else toast(d.estorno === 'DEVOLVIDO' ? 'Pedido cancelado e PIX estornado.' : 'Pedido cancelado.', 'success');
    window.loadAtpveAgendada();
  }

  async function reenviar(id) {
    const { ok, d } = await post(`/api/admin/atpve-agendada/${id}/reenviar-whatsapp`);
    toast(ok ? `Reenviado para ${d.phone}.` : (d.error || 'Erro ao reenviar.'), ok ? 'success' : 'error');
  }

  // Selo do menu já na abertura do admin e de minuto em minuto: o prazo é curto.
  const atualizarSelo = () => buscar().then(() => {
    const sec = document.getElementById('section-atpve-agendada');
    if (sec && !sec.classList.contains('hidden') && !enviando.size) desenhar();
  }).catch(() => {});
  atualizarSelo();
  setInterval(atualizarSelo, 60000);
})();
