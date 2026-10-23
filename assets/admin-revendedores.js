// Admin → Revendedores (23/10/2026). Cadastro só pelo admin, com a chave PIX
// do revendedor e a taxa de adesão opcional (que é toda do revendedor), e a
// tela de controle de cada um. A regra da comissão (20% sobre a recarga do
// usuário do revendedor, enviada na hora pelo Payouts do Mercado Pago) mora no
// server.js — aqui é só apresentação e as ações. Usa fmt, fmtDate, toast,
// openModal e closeModal do admin.html.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  let revendedores = [], pixTipos = {}, taxa = 20, envioAutomatico = true, detalheAtual = null;

  const STATUS_COMISSAO = {
    A_PAGAR:  '<span class="badge-amber">A pagar</span>',
    ENVIANDO: '<span class="badge-blue">Enviando PIX</span>',
    PAGA:     '<span class="badge-green">Paga</span>',
  };

  function montarSecao() {
    const sec = document.getElementById('section-revendedores');
    if (!sec || sec.dataset.pronta) return;
    sec.dataset.pronta = '1';
    sec.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-gray-800">Revendedores</h2>
          <p class="text-sm text-gray-500">
            Só o admin cadastra revendedor. O revendedor ganha <strong id="rv-taxa">20</strong>% de cada recarga
            (e de cada fatura pós-paga) dos usuários dele, enviados <strong>na hora</strong> por PIX para a chave cadastrada.
            Se o envio automático não sair, a comissão fica <em>a pagar</em> e você é avisado no WhatsApp.
            A adesão é você quem <strong>libera</strong> por revendedor (o valor é combinado entre vocês, fora do sistema) e é
            <strong>toda do revendedor</strong>: os usuários dele ficam bloqueados até ele receber e liberar o acesso.
          </p>
        </div>
        <button onclick="rvAbrirCadastro()" class="btn-primary whitespace-nowrap">➕ Novo revendedor</button>
      </div>
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="stat-card border-l-blue-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Revendedores</div>
          <div id="rv-total" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5"><span id="rv-clientes">0</span> usuários vinculados</div>
        </div>
        <div class="stat-card border-l-green-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Recargas dos usuários</div>
          <div id="rv-recargas" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5">base da comissão</div>
        </div>
        <div class="stat-card border-l-purple-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Comissão paga</div>
          <div id="rv-paga" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5">de <span id="rv-gerada">R$ 0,00</span> gerados</div>
        </div>
        <div class="stat-card border-l-red-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">A pagar</div>
          <div id="rv-apagar" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5"><span id="rv-enviando">R$ 0,00</span> em envio</div>
        </div>
      </div>
      <div id="rv-aviso-manual" class="hidden bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
        O envio automático está desligado (<code>COMISSAO_ENVIO_AUTOMATICO</code> no server.js): toda comissão fica a pagar.
      </div>
      <div class="card p-0 overflow-hidden">
        <div class="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-100">
          <input id="rv-busca" type="text" class="input-field flex-1 min-w-48" placeholder="Buscar por nome, e-mail ou CPF/CNPJ..." oninput="rvRender()">
          <button onclick="rvCarregar()" class="btn-secondary">🔄 Atualizar</button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 border-b border-gray-100">
              <tr>
                <th class="px-4 py-3 text-left font-semibold text-gray-600">Revendedor</th>
                <th class="px-4 py-3 text-left font-semibold text-gray-600 hidden lg:table-cell">Chave PIX</th>
                <th class="px-4 py-3 text-center font-semibold text-gray-600">Usuários</th>
                <th class="px-4 py-3 text-center font-semibold text-gray-600 hidden md:table-cell">Adesão</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-600 hidden md:table-cell">Recargas</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-600">Paga</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-600">A pagar</th>
                <th class="px-4 py-3 text-center font-semibold text-gray-600">Ações</th>
              </tr>
            </thead>
            <tbody id="rv-tbody" class="divide-y divide-gray-50">
              <tr><td colspan="8" class="px-4 py-8"><div class="space-y-2"><div class="skeleton"></div><div class="skeleton"></div></div></td></tr>
            </tbody>
          </table>
        </div>
      </div>`;

    const modais = document.createElement('div');
    modais.innerHTML = `
      <div id="modal-revendedor" class="modal-backdrop hidden">
        <div class="modal-box">
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h3 id="rv-form-titulo" class="font-bold text-gray-800">➕ Novo revendedor</h3>
            <button onclick="closeModal('modal-revendedor')" class="text-gray-400 hover:text-gray-600 text-xl font-bold">✕</button>
          </div>
          <form class="p-6 space-y-4" onsubmit="rvSalvar(event)">
            <input type="hidden" id="rv-id">
            <div id="rv-dados-conta" class="space-y-4">
              <div><label class="label">Nome completo *</label><input id="rv-nome" class="input-field" autocomplete="off"></div>
              <div class="grid grid-cols-2 gap-3">
                <div><label class="label">CPF ou CNPJ *</label><input id="rv-doc" class="input-field" inputmode="numeric" maxlength="18" autocomplete="off"></div>
                <div><label class="label">Telefone / WhatsApp *</label><input id="rv-fone" class="input-field" inputmode="numeric" maxlength="15" placeholder="(21) 90000-0000"></div>
              </div>
              <div><label class="label">E-mail (login) *</label><input id="rv-email" type="email" class="input-field" autocomplete="off"></div>
              <div><label class="label">Senha de acesso *</label><input id="rv-senha" type="text" class="input-field" minlength="8" autocomplete="new-password" placeholder="Mínimo 8 caracteres — envie ao revendedor"></div>
            </div>
            <div class="bg-green-50 border border-green-200 rounded-lg p-4 space-y-3">
              <div class="text-sm font-semibold text-green-800">💸 Chave PIX do revendedor (recebe os ${taxa}%)</div>
              <div class="grid grid-cols-3 gap-3">
                <div><label class="label">Tipo *</label><select id="rv-pix-tipo" class="input-field" onchange="rvDicaPix()"></select></div>
                <div class="col-span-2"><label class="label">Chave PIX *</label><input id="rv-pix-chave" class="input-field" autocomplete="off"></div>
              </div>
              <p id="rv-pix-dica" class="text-xs text-green-700"></p>
            </div>
            <div class="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
              <div class="text-sm font-semibold text-gray-700">Taxa de adesão</div>
              <p class="text-xs text-gray-500">O valor é combinado entre você e o revendedor, fora do sistema, e a taxa é toda dele. Liberada, cada usuário novo do revendedor fica bloqueado até ele receber a adesão e clicar em “Liberar acesso”.</p>
              <label class="flex items-center gap-2 text-sm"><input type="radio" name="rv-adesao" value="nao" checked> Não liberar adesão (usuários entram direto)</label>
              <label class="flex items-center gap-2 text-sm"><input type="radio" name="rv-adesao" value="sim"> Liberar cobrança de adesão para este revendedor</label>
            </div>
            <div><label class="label">Observação (só o admin vê)</label><textarea id="rv-obs" rows="2" class="input-field"></textarea></div>
            <div id="rv-ativo-box" class="hidden"><label class="flex items-center gap-2 text-sm"><input id="rv-ativo" type="checkbox"> Revendedor ativo (desativado não recebe comissão nem entra no painel)</label></div>
            <div id="rv-form-erro" class="hidden bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm"></div>
            <div class="flex gap-3 pt-2">
              <button id="rv-salvar-btn" type="submit" class="btn-primary flex-1 justify-center">Salvar</button>
              <button type="button" onclick="closeModal('modal-revendedor')" class="btn-ghost flex-1 justify-center">Cancelar</button>
            </div>
          </form>
        </div>
      </div>
      <div id="modal-revendedor-detalhe" class="modal-backdrop hidden">
        <div class="modal-box" style="max-width:980px">
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h3 id="rvd-titulo" class="font-bold text-gray-800">Revendedor</h3>
            <button onclick="closeModal('modal-revendedor-detalhe')" class="text-gray-400 hover:text-gray-600 text-xl font-bold">✕</button>
          </div>
          <div id="rvd-corpo" class="p-6 space-y-5"></div>
        </div>
      </div>`;
    document.body.appendChild(modais);
    document.getElementById('rv-doc').addEventListener('input', e => { e.target.value = mascaraDoc(e.target.value); });
    document.getElementById('rv-fone').addEventListener('input', e => { e.target.value = mascaraFone(e.target.value); });
  }

  function mascaraDoc(v) {
    const d = v.replace(/\D/g, '').slice(0, 14);
    if (d.length <= 11) return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  }
  function mascaraFone(v) {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 10) return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2');
    return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2');
  }

  window.rvCarregar = async function () {
    montarSecao();
    try {
      const r = await fetch('/api/admin/revendedores');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erro ao carregar.');
      revendedores = d.revendedores || [];
      pixTipos = d.pixTipos || {};
      taxa = d.taxa ?? 20;
      envioAutomatico = !!d.envioAutomatico;
      document.getElementById('rv-taxa').textContent = taxa;
      document.getElementById('rv-aviso-manual').classList.toggle('hidden', envioAutomatico);
      rvRender();
    } catch (e) { toast(e.message, 'error'); }
  };

  window.rvRender = function () {
    const soma = k => revendedores.reduce((s, r) => s + (r[k] || 0), 0);
    document.getElementById('rv-total').textContent = revendedores.length;
    document.getElementById('rv-clientes').textContent = soma('clientes');
    document.getElementById('rv-recargas').textContent = fmt(soma('recargas'));
    document.getElementById('rv-paga').textContent = fmt(soma('comissao_paga'));
    document.getElementById('rv-gerada').textContent = fmt(soma('comissao_gerada'));
    document.getElementById('rv-apagar').textContent = fmt(soma('comissao_a_pagar'));
    document.getElementById('rv-enviando').textContent = fmt(soma('comissao_enviando'));
    const q = (document.getElementById('rv-busca').value || '').toLowerCase().trim();
    const qd = q.replace(/\D/g, '');
    const lista = revendedores.filter(r => !q || (r.name || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q) || (qd && (r.cpf_cnpj || '').includes(qd)));
    const tbody = document.getElementById('rv-tbody');
    if (!lista.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-10 text-center text-gray-400">${revendedores.length ? 'Nenhum revendedor encontrado.' : 'Nenhum revendedor cadastrado. Use “➕ Novo revendedor”.'}</td></tr>`;
      return;
    }
    tbody.innerHTML = lista.map(r => `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3">
          <div class="font-medium text-gray-800">${esc(r.name)} ${r.active ? '' : '<span class="badge-red">Inativo</span>'}</div>
          <div class="text-xs text-gray-400">${esc(r.email)}</div>
          ${r.ultimo_erro ? `<div class="text-xs text-red-600 mt-0.5" title="${esc(r.ultimo_erro)}">⚠️ envio não saiu</div>` : ''}
        </td>
        <td class="px-4 py-3 hidden lg:table-cell text-xs">
          ${r.pix_chave ? `<div class="text-gray-500">${esc(r.pix_tipo_nome)}</div><div class="font-mono text-gray-700 break-all">${esc(r.pix_chave)}</div>${r.envio_automatico ? '' : '<div class="text-amber-600">envio manual</div>'}` : '<span class="badge-red">sem chave PIX</span>'}
        </td>
        <td class="px-4 py-3 text-center">${r.clientes}</td>
        <td class="px-4 py-3 text-center hidden md:table-cell text-xs">${r.cobra_adesao ? `<span class="badge-green">liberada</span><div class="text-gray-400">${r.adesoes_pagas} paga(s)${r.adesoes_pendentes ? ` · ${r.adesoes_pendentes} aguardando` : ''}</div>` : '<span class="text-gray-400">não liberada</span>'}</td>
        <td class="px-4 py-3 text-right hidden md:table-cell">${fmt(r.recargas)}</td>
        <td class="px-4 py-3 text-right text-green-700">${fmt(r.comissao_paga)}</td>
        <td class="px-4 py-3 text-right font-semibold ${r.comissao_a_pagar > 0 ? 'text-red-600' : 'text-gray-400'}">${fmt(r.comissao_a_pagar)}${r.comissao_enviando > 0 ? `<div class="text-xs font-normal text-blue-600">${fmt(r.comissao_enviando)} enviando</div>` : ''}</td>
        <td class="px-4 py-3 text-center whitespace-nowrap">
          <button onclick="rvAbrirDetalhe(${r.id})" class="action-btn bg-blue-100 text-blue-700 hover:bg-blue-200" title="Controle">📊</button>
          <button onclick="rvAbrirEdicao(${r.id})" class="action-btn bg-gray-100 text-gray-700 hover:bg-gray-200" title="Editar PIX / adesão">✏️</button>
        </td>
      </tr>`).join('');
  };

  function preencherTiposPix(sel) {
    const s = document.getElementById('rv-pix-tipo');
    s.innerHTML = '<option value="">Escolha…</option>' + Object.entries(pixTipos).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    s.value = sel || '';
    rvDicaPix();
  }

  window.rvDicaPix = function () {
    const t = document.getElementById('rv-pix-tipo').value;
    const ph = { cpf: '000.000.000-00', cnpj: '00.000.000/0000-00', email: 'email@exemplo.com', telefone: '(21) 90000-0000', aleatoria: '00000000-0000-0000-0000-000000000000' };
    document.getElementById('rv-pix-chave').placeholder = ph[t] || '';
    document.getElementById('rv-pix-dica').textContent = t === 'aleatoria'
      ? 'Atenção: o envio automático do Mercado Pago não aceita chave aleatória. Com ela, a comissão fica a pagar e você paga pelo banco.'
      : (envioAutomatico ? 'A comissão é enviada automaticamente para esta chave a cada recarga paga pelos usuários do revendedor.' : '');
  };

  function erroForm(msg) {
    const el = document.getElementById('rv-form-erro');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  window.rvAbrirCadastro = function () {
    montarSecao();
    document.getElementById('rv-form-titulo').textContent = '➕ Novo revendedor';
    document.getElementById('rv-id').value = '';
    document.getElementById('rv-dados-conta').classList.remove('hidden');
    document.getElementById('rv-ativo-box').classList.add('hidden');
    ['rv-nome', 'rv-doc', 'rv-fone', 'rv-email', 'rv-senha', 'rv-pix-chave', 'rv-obs'].forEach(id => { document.getElementById(id).value = ''; });
    document.querySelector('input[name="rv-adesao"][value="nao"]').checked = true;
    preencherTiposPix('');
    erroForm('');
    openModal('modal-revendedor');
  };

  window.rvAbrirEdicao = function (id) {
    const r = revendedores.find(x => x.id === id);
    if (!r) return;
    document.getElementById('rv-form-titulo').textContent = `✏️ ${r.name}`;
    document.getElementById('rv-id').value = r.id;
    document.getElementById('rv-dados-conta').classList.add('hidden');
    document.getElementById('rv-ativo-box').classList.remove('hidden');
    document.getElementById('rv-ativo').checked = !!r.active;
    preencherTiposPix(r.pix_tipo);
    document.getElementById('rv-pix-chave').value = r.pix_chave || '';
    document.querySelector(`input[name="rv-adesao"][value="${r.cobra_adesao ? 'sim' : 'nao'}"]`).checked = true;
    document.getElementById('rv-obs').value = r.observacao || '';
    erroForm('');
    openModal('modal-revendedor');
  };

  window.rvSalvar = async function (ev) {
    ev.preventDefault();
    const id = document.getElementById('rv-id').value;
    const v = k => document.getElementById(k).value;
    const corpo = {
      pix_tipo: v('rv-pix-tipo'), pix_chave: v('rv-pix-chave'),
      cobra_adesao: document.querySelector('input[name="rv-adesao"]:checked')?.value === 'sim',
      observacao: v('rv-obs'),
    };
    if (id) corpo.active = document.getElementById('rv-ativo').checked;
    else Object.assign(corpo, { name: v('rv-nome'), cpf_cnpj: v('rv-doc'), phone: v('rv-fone'), email: v('rv-email'), password: v('rv-senha') });
    const btn = document.getElementById('rv-salvar-btn');
    btn.disabled = true; erroForm('');
    try {
      const r = await fetch(id ? `/api/admin/revendedores/${id}` : '/api/admin/revendedores', {
        method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erro ao salvar.');
      closeModal('modal-revendedor');
      toast(id ? 'Revendedor atualizado.' : 'Revendedor cadastrado. Envie o e-mail e a senha para ele entrar em /entrar.');
      await rvCarregar();
      if (id && detalheAtual === parseInt(id, 10)) rvAbrirDetalhe(detalheAtual);
    } catch (e) { erroForm(e.message); } finally { btn.disabled = false; }
  };

  window.rvAbrirDetalhe = async function (id) {
    montarSecao();
    detalheAtual = id;
    const corpo = document.getElementById('rvd-corpo');
    corpo.innerHTML = '<div class="space-y-2"><div class="skeleton"></div><div class="skeleton"></div></div>';
    openModal('modal-revendedor-detalhe');
    try {
      const r = await fetch(`/api/admin/revendedores/${id}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erro ao carregar.');
      const rv = d.revendedor;
      document.getElementById('rvd-titulo').textContent = `📊 ${rv.name}`;
      const travado = d.comissoes.some(c => c.status === 'ENVIANDO' && !c.payout_id);
      const card = (t, v, cor, sub = '') => `<div class="stat-card ${cor}"><div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">${t}</div><div class="text-xl font-bold text-gray-800">${v}</div>${sub ? `<div class="text-xs text-gray-400 mt-0.5">${sub}</div>` : ''}</div>`;
      corpo.innerHTML = `
        <div class="grid sm:grid-cols-2 gap-4 text-sm">
          <div class="space-y-1">
            <div><span class="text-gray-500">E-mail:</span> ${esc(rv.email)}</div>
            <div><span class="text-gray-500">Telefone:</span> ${esc(rv.phone || '-')}</div>
            <div><span class="text-gray-500">Cadastro:</span> ${fmtDate(rv.created_at)} ${rv.active ? '<span class="badge-green">Ativo</span>' : '<span class="badge-red">Inativo</span>'}</div>
            ${rv.observacao ? `<div class="text-gray-500">Obs.: ${esc(rv.observacao)}</div>` : ''}
          </div>
          <div class="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
            <div class="text-xs text-green-700 font-semibold">Chave PIX (${esc(rv.pix_tipo_nome || '—')})</div>
            <div class="font-mono text-green-900 break-all">${esc(rv.pix_chave || 'não cadastrada')}</div>
            <div class="text-xs text-green-700 mt-1">${rv.envio_automatico ? `Envio automático de ${taxa}% a cada recarga.` : 'Envio manual (pague pelo banco e dê baixa abaixo).'}</div>
            <div class="text-xs text-gray-600 mt-1">Adesão: ${rv.cobra_adesao ? `liberada (do revendedor) — ${rv.adesoes_pagas} paga(s), ${rv.adesoes_pendentes} aguardando liberação` : 'não liberada'}</div>
            ${rv.slug ? `<div class="text-xs mt-1"><a class="text-blue-700 underline" target="_blank" rel="noopener" href="/r/${encodeURIComponent(rv.slug)}">Página do revendedor: /r/${esc(rv.slug)}</a></div>` : ''}
          </div>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          ${card('Usuários', rv.clientes, 'border-l-blue-500', `${rv.consultas} consultas · ${fmt(rv.faturamento_consultas)}`)}
          ${card('Recargas', fmt(rv.recargas), 'border-l-green-500', 'base da comissão')}
          ${card('Comissão paga', fmt(rv.comissao_paga), 'border-l-purple-500', `de ${fmt(rv.comissao_gerada)} gerados`)}
          ${card('A pagar', fmt(rv.comissao_a_pagar), 'border-l-red-500', rv.comissao_enviando > 0 ? `${fmt(rv.comissao_enviando)} enviando` : '')}
        </div>
        ${rv.ultimo_erro ? `<div class="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">⚠️ Último envio automático: ${esc(rv.ultimo_erro)}</div>` : ''}
        ${travado ? `<div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">Há comissão em envio sem resposta do Mercado Pago. Confira no extrato do Mercado Pago se o PIX saiu antes de pagar de novo. Se <strong>não</strong> saiu, use “Registrar pagamento manual” e marque a opção de incluir esse lote depois de pagar.</div>` : ''}
        <div class="flex flex-wrap gap-2">
          <button onclick="rvEnviarAgora(${rv.id})" class="btn-secondary" ${rv.comissao_a_pagar > 0 && rv.envio_automatico ? '' : 'disabled style="opacity:.5"'}>💸 Tentar envio automático agora</button>
          <button onclick="rvPagamentoManual(${rv.id}, ${travado})" class="btn-primary" ${rv.comissao_a_pagar > 0 || travado ? '' : 'disabled style="opacity:.5"'}>✅ Registrar pagamento manual</button>
          <button onclick="rvAbrirEdicao(${rv.id})" class="btn-ghost">✏️ Editar PIX / adesão</button>
        </div>

        <div>
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h4 class="font-semibold text-gray-800">Usuários do revendedor</h4>
            <form class="flex gap-2" onsubmit="rvVincular(event, ${rv.id})">
              <input id="rvd-vincular" class="input-field" style="width:260px" placeholder="E-mail ou CPF/CNPJ de conta existente">
              <button class="btn-secondary whitespace-nowrap">🔗 Vincular</button>
            </form>
          </div>
          <div class="overflow-x-auto border border-gray-100 rounded-lg">
            <table class="w-full text-sm">
              <thead class="bg-gray-50"><tr>
                <th class="px-3 py-2 text-left">Usuário</th><th class="px-3 py-2 text-right">Recargas</th>
                <th class="px-3 py-2 text-right">Comissão</th><th class="px-3 py-2 text-center">Consultas</th>
                <th class="px-3 py-2 text-right hidden md:table-cell">Faturamento</th>
                <th class="px-3 py-2 text-center">Adesão</th><th class="px-3 py-2"></th>
              </tr></thead>
              <tbody class="divide-y divide-gray-50">${d.clientes.length ? d.clientes.map(c => `
                <tr>
                  <td class="px-3 py-2"><div class="font-medium">${esc(c.name)} ${c.active ? '' : '<span class="badge-red">Bloqueado</span>'} ${c.pos_pago ? '<span class="badge-amber">Pós-pago</span>' : ''}</div><div class="text-xs text-gray-400">${esc(c.email)}</div></td>
                  <td class="px-3 py-2 text-right">${fmt(c.recargas)}</td>
                  <td class="px-3 py-2 text-right">${fmt(c.comissao)}</td>
                  <td class="px-3 py-2 text-center">${c.consultas}</td>
                  <td class="px-3 py-2 text-right hidden md:table-cell">${fmt(c.faturamento)}</td>
                  <td class="px-3 py-2 text-center text-xs">${c.adesao_paga_em ? `<span class="badge-green">paga ${fmtDate(c.adesao_paga_em)}</span>` : c.adesao_exigida ? `<button onclick="rvAdesao(${rv.id}, ${c.id}, true)" class="action-btn bg-amber-100 text-amber-800 hover:bg-amber-200">🔓 Liberar acesso</button>` : '<span class="text-gray-400">—</span>'}</td>
                  <td class="px-3 py-2 text-right"><button onclick="rvDesvincular(${rv.id}, ${c.id})" class="action-btn bg-red-50 text-red-600 hover:bg-red-100" title="Desvincular">✕</button></td>
                </tr>`).join('') : `<tr><td colspan="7" class="px-3 py-6 text-center text-gray-400">Nenhum usuário ainda. O revendedor cria os dele em “Meus Clientes”, ou vincule uma conta existente acima.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <div class="grid lg:grid-cols-2 gap-4">
          <div>
            <h4 class="font-semibold text-gray-800 mb-2">Comissões</h4>
            <div class="overflow-x-auto border border-gray-100 rounded-lg max-h-80 overflow-y-auto">
              <table class="w-full text-xs">
                <thead class="bg-gray-50"><tr><th class="px-3 py-2 text-left">Data</th><th class="px-3 py-2 text-left">Usuário</th><th class="px-3 py-2 text-right">Recarga</th><th class="px-3 py-2 text-right">${taxa}%</th><th class="px-3 py-2 text-center">Situação</th></tr></thead>
                <tbody class="divide-y divide-gray-50">${d.comissoes.length ? d.comissoes.map(c => `
                  <tr title="${esc(c.envio_erro || '')}">
                    <td class="px-3 py-2">${fmtDate(c.created_at)}</td>
                    <td class="px-3 py-2">${esc(c.client_name)}${c.origem === 'FATURA' ? ' <span class="text-gray-400">(fatura)</span>' : ''}</td>
                    <td class="px-3 py-2 text-right">${fmt(c.base)}</td>
                    <td class="px-3 py-2 text-right font-semibold">${fmt(c.amount)}</td>
                    <td class="px-3 py-2 text-center">${STATUS_COMISSAO[c.status] || esc(c.status)}${c.envio_erro && c.status !== 'PAGA' ? ' ⚠️' : ''}</td>
                  </tr>`).join('') : '<tr><td colspan="5" class="px-3 py-6 text-center text-gray-400">Nenhuma comissão ainda.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h4 class="font-semibold text-gray-800 mb-2">Pagamentos ao revendedor</h4>
            <div class="overflow-x-auto border border-gray-100 rounded-lg max-h-80 overflow-y-auto">
              <table class="w-full text-xs">
                <thead class="bg-gray-50"><tr><th class="px-3 py-2 text-left">Data</th><th class="px-3 py-2 text-right">Valor</th><th class="px-3 py-2 text-left">Como</th></tr></thead>
                <tbody class="divide-y divide-gray-50">${d.pagamentos.length ? d.pagamentos.map(p => `
                  <tr><td class="px-3 py-2">${fmtDate(p.created_at)}</td><td class="px-3 py-2 text-right font-semibold">${fmt(p.valor)}</td>
                  <td class="px-3 py-2">${p.origem === 'AUTOMATICO' ? '<span class="badge-green">PIX automático</span>' : '<span class="badge-gray">Manual</span>'} ${esc(p.observacao || '')}</td></tr>`).join('') : '<tr><td colspan="3" class="px-3 py-6 text-center text-gray-400">Nenhum pagamento ainda.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
    } catch (e) {
      corpo.innerHTML = `<div class="text-red-600 text-sm">${esc(e.message)}</div>`;
    }
  };

  async function acao(url, opts, ok) {
    try {
      const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erro.');
      if (ok) toast(typeof ok === 'function' ? ok(d) : ok);
      return d;
    } catch (e) { toast(e.message, 'error'); return null; }
  }
  async function recarregar(id) { await rvCarregar(); if (detalheAtual === id) rvAbrirDetalhe(id); }

  window.rvEnviarAgora = async function (id) {
    const d = await acao(`/api/admin/revendedores/${id}/enviar`, { method: 'POST' });
    if (d) toast(d.enviado ? `PIX de ${fmt(d.total)} enviado ao Mercado Pago.` : `Não enviado: ${d.motivo}`, d.enviado ? 'success' : 'error');
    recarregar(id);
  };

  window.rvPagamentoManual = async function (id, travado) {
    const r = revendedores.find(x => x.id === id);
    const valor = r ? fmt(r.comissao_a_pagar) : '';
    if (!confirm(`Confirmar que você já pagou ${valor} a ${r?.name || 'este revendedor'} pelo banco?\n\nTodas as comissões "a pagar" serão marcadas como pagas.`)) return;
    let incluirTravados = false;
    if (travado) incluirTravados = confirm('Incluir também o lote que ficou "enviando" sem resposta do Mercado Pago?\n\nSó confirme se você conferiu no Mercado Pago que esse PIX automático NÃO saiu.');
    const observacao = prompt('Observação do pagamento (opcional, ex.: id do PIX no banco):', '') || '';
    await acao(`/api/admin/revendedores/${id}/pagamento-manual`, { method: 'POST', body: JSON.stringify({ incluirTravados, observacao }) },
      d => `Baixa de ${fmt(d.valor)} registrada (${d.comissoes} comissões).`);
    recarregar(id);
  };

  window.rvVincular = async function (ev, id) {
    ev.preventDefault();
    const busca = document.getElementById('rvd-vincular').value;
    const d = await acao(`/api/admin/revendedores/${id}/clientes`, { method: 'POST', body: JSON.stringify({ busca }) }, d => `${d.cliente.name} vinculado.`);
    if (d) recarregar(id);
  };

  window.rvDesvincular = async function (id, uid) {
    if (!confirm('Desvincular este usuário do revendedor? As próximas recargas dele deixam de gerar comissão.')) return;
    const d = await acao(`/api/admin/revendedores/${id}/clientes/${uid}`, { method: 'DELETE' }, 'Usuário desvinculado.');
    if (d) recarregar(id);
  };

  window.rvAdesao = async function (id, uid, paga) {
    if (paga && !confirm('Liberar o acesso deste usuário (adesão recebida pelo revendedor)?')) return;
    const d = await acao(`/api/admin/revendedores/${id}/clientes/${uid}/adesao`, { method: 'PUT', body: JSON.stringify({ paga }) }, paga ? 'Acesso liberado.' : 'Adesão desmarcada.');
    if (d) recarregar(id);
  };
})();
