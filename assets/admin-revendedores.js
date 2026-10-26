// Admin → Parceiros (antigos revendedores; a Parceria substituiu os 20% da
// recarga e a adesão em 25/10/2026). Cadastro só pelo admin, com a chave PIX
// do parceiro, e a tela de controle de cada um: clientes, ganhos, as consultas
// da página dele com o custo de cada uma (onde o admin dá desconto) e o
// domínio próprio. A regra do ganho (preço do parceiro − custo, enviado por
// PIX pelo Payouts do Mercado Pago) mora no server.js — aqui é só
// apresentação e as ações. Usa fmt, fmtDate, toast, openModal e closeModal do
// admin.html.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  let revendedores = [], pixTipos = {}, envioAutomatico = true, detalheAtual = null, consultasAtual = [];
  let dominioAtual = null, foneAtual = null, dominioPixPoll = null, dominioPixPendente = null;

  const STATUS_COMISSAO = {
    A_PAGAR:  '<span class="badge-amber">A pagar</span>',
    ENVIANDO: '<span class="badge-blue">Enviando PIX</span>',
    PAGA:     '<span class="badge-green">Paga</span>',
  };
  const DOMINIO_STATUS = {
    AGUARDANDO_PAGAMENTO: '<span class="badge-gray">aguardando pagamento</span>',
    CONFIGURANDO: '<span class="badge-amber">pago — configurar</span>',
    ATIVO: '<span class="badge-green">ativo</span>',
    CANCELADO: '<span class="badge-red">cancelado</span>',
  };
  const ORIGEM = { CONSULTA: '', ESTORNO: ' <span class="text-red-500">(estorno)</span>', RECARGA: ' <span class="text-gray-400">(recarga, modelo antigo)</span>', FATURA: ' <span class="text-gray-400">(fatura, modelo antigo)</span>' };
  const vencido = d => d && d.valido_ate && new Date(d.valido_ate).getTime() <= Date.now();

  function montarSecao() {
    const sec = document.getElementById('section-revendedores');
    if (!sec || sec.dataset.pronta) return;
    sec.dataset.pronta = '1';
    sec.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-gray-800">Parceiros</h2>
          <p class="text-sm text-gray-500">
            Só o admin cadastra parceiro. Cada parceiro tem o próprio painel, escolhe as consultas da página dele e o
            <strong>preço que o cliente dele paga</strong> (nunca abaixo do custo). O ganho dele é a diferença entre esse preço e o
            custo, enviado <strong>na hora</strong> por PIX para a chave cadastrada. O custo é o preço do site — ou o
            <strong>desconto</strong> que você der a ele em cada consulta (📊 → Consultas e custos). Domínio próprio: anuidade de
            R$ 200,00 (domínio + taxa de administração do serviço) paga pelo parceiro; você configura e marca como ativo aqui.
          </p>
        </div>
        <button onclick="rvAbrirCadastro()" class="btn-primary whitespace-nowrap">➕ Novo parceiro</button>
      </div>
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="stat-card border-l-blue-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Parceiros</div>
          <div id="rv-total" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5"><span id="rv-clientes">0</span> usuários vinculados</div>
        </div>
        <div class="stat-card border-l-green-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Consultas dos clientes</div>
          <div id="rv-faturamento" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5"><span id="rv-consultas">0</span> consultas</div>
        </div>
        <div class="stat-card border-l-purple-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Ganhos pagos</div>
          <div id="rv-paga" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5">de <span id="rv-gerada">R$ 0,00</span> gerados</div>
        </div>
        <div class="stat-card border-l-red-500">
          <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">A pagar</div>
          <div id="rv-apagar" class="text-2xl font-bold text-gray-800">—</div>
          <div class="text-xs text-gray-400 mt-0.5"><span id="rv-enviando">R$ 0,00</span> em envio · <span id="rv-dom-pend">0</span> domínio(s) a configurar</div>
        </div>
      </div>
      <div id="rv-aviso-manual" class="hidden bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
        O envio automático está desligado (<code>COMISSAO_ENVIO_AUTOMATICO</code> no server.js): todo ganho fica a pagar.
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
                <th class="px-4 py-3 text-left font-semibold text-gray-600">Parceiro</th>
                <th class="px-4 py-3 text-left font-semibold text-gray-600 hidden lg:table-cell">Chave PIX</th>
                <th class="px-4 py-3 text-center font-semibold text-gray-600">Usuários</th>
                <th class="px-4 py-3 text-center font-semibold text-gray-600 hidden md:table-cell">Página</th>
                <th class="px-4 py-3 text-center font-semibold text-gray-600 hidden md:table-cell">Domínio</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-600">Pago</th>
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
            <h3 id="rv-form-titulo" class="font-bold text-gray-800">➕ Novo parceiro</h3>
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
              <div><label class="label">Senha de acesso *</label><input id="rv-senha" type="text" class="input-field" minlength="8" autocomplete="new-password" placeholder="Mínimo 8 caracteres — envie ao parceiro"></div>
            </div>
            <div class="bg-green-50 border border-green-200 rounded-lg p-4 space-y-3">
              <div class="text-sm font-semibold text-green-800">💸 Chave PIX do parceiro (recebe os ganhos)</div>
              <div class="grid grid-cols-3 gap-3">
                <div><label class="label">Tipo *</label><select id="rv-pix-tipo" class="input-field" onchange="rvDicaPix()"></select></div>
                <div class="col-span-2"><label class="label">Chave PIX *</label><input id="rv-pix-chave" class="input-field" autocomplete="off"></div>
              </div>
              <p id="rv-pix-dica" class="text-xs text-green-700"></p>
            </div>
            <div id="rv-pagina-box" class="hidden bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
              <div class="flex items-center justify-between gap-2">
                <div class="text-sm font-semibold text-blue-900">🌐 Página (home) do parceiro</div>
                <a id="rv-pg-abrir" href="#" target="_blank" rel="noopener" class="text-xs text-blue-700 underline">Abrir página ↗</a>
              </div>
              <p class="text-xs text-blue-800">Só texto (sem HTML). Em branco usa o texto padrão. É a mesma página que o parceiro edita em “Minha Página”.</p>
              <div><label class="label">Título</label><input id="rv-pg-titulo" maxlength="80" class="input-field"></div>
              <div><label class="label">Subtítulo</label><input id="rv-pg-subtitulo" maxlength="160" class="input-field"></div>
              <div><label class="label">Apresentação</label><textarea id="rv-pg-texto" maxlength="2000" rows="4" class="input-field"></textarea></div>
              <div class="grid grid-cols-2 gap-3">
                <div><label class="label">WhatsApp da página</label><input id="rv-pg-whatsapp" maxlength="15" inputmode="numeric" placeholder="(21) 90000-0000" class="input-field"></div>
                <div><label class="label">Cor</label><input id="rv-pg-cor" type="color" value="#1e3a8a" class="h-10 w-20 border border-gray-300 rounded-lg"></div>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <div class="label">Logo</div>
                  <img id="rv-pg-logo-prev" alt="" class="hidden h-16 w-16 object-contain border rounded-lg mb-1 bg-white">
                  <input type="file" accept="image/png,image/jpeg,image/webp" onchange="rvImagemPagina('logo', this)" class="text-xs w-full min-w-0">
                  <button type="button" onclick="rvRemoverImagemPagina('logo')" class="text-xs text-red-600 block mt-1">Remover logo</button>
                </div>
                <div>
                  <div class="label">Imagem do topo (banner)</div>
                  <img id="rv-pg-banner-prev" alt="" class="hidden h-16 w-full object-cover border rounded-lg mb-1">
                  <input type="file" accept="image/png,image/jpeg,image/webp" onchange="rvImagemPagina('banner', this)" class="text-xs w-full min-w-0">
                  <button type="button" onclick="rvRemoverImagemPagina('banner')" class="text-xs text-red-600 block mt-1">Remover imagem</button>
                </div>
              </div>
              <p class="text-xs text-blue-800">Imagens: PNG, JPG ou WebP até 800 KB — são salvas na hora em que você escolhe o arquivo. Os textos e a cor são salvos no botão Salvar.</p>
            </div>
            <div><label class="label">Observação (só o admin vê)</label><textarea id="rv-obs" rows="2" class="input-field"></textarea></div>
            <div id="rv-ativo-box" class="hidden"><label class="flex items-center gap-2 text-sm"><input id="rv-ativo" type="checkbox"> Parceiro ativo (desativado não recebe ganho, não entra no painel e os clientes dele voltam ao preço do site)</label></div>
            <div id="rv-form-erro" class="hidden bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm"></div>
            <div class="flex gap-3 pt-2">
              <button id="rv-salvar-btn" type="submit" class="btn-primary flex-1 justify-center">Salvar</button>
              <button type="button" onclick="closeModal('modal-revendedor')" class="btn-ghost flex-1 justify-center">Cancelar</button>
            </div>
          </form>
        </div>
      </div>
      <div id="modal-revendedor-detalhe" class="modal-backdrop hidden">
        <div class="modal-box" style="max-width:1040px">
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h3 id="rvd-titulo" class="font-bold text-gray-800">Parceiro</h3>
            <button onclick="closeModal('modal-revendedor-detalhe')" class="text-gray-400 hover:text-gray-600 text-xl font-bold">✕</button>
          </div>
          <div id="rvd-corpo" class="p-6 space-y-5"></div>
        </div>
      </div>
      <div id="modal-dominio-pix-admin" class="modal-backdrop hidden">
        <div class="modal-box" style="max-width:460px">
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h3 class="font-bold text-gray-800">💳 Domínio próprio — R$ 200,00</h3>
            <button onclick="rvFecharDominioPix()" class="text-gray-400 hover:text-gray-600 text-xl font-bold">✕</button>
          </div>
          <div id="rvdp-corpo" class="p-6 space-y-4 text-sm text-gray-700"></div>
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
  const precoTela = v => (v == null ? '' : Number(v).toFixed(2).replace('.', ','));

  window.rvCarregar = async function () {
    montarSecao();
    try {
      const r = await fetch('/api/admin/revendedores');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erro ao carregar.');
      revendedores = d.revendedores || [];
      pixTipos = d.pixTipos || {};
      envioAutomatico = !!d.envioAutomatico;
      document.getElementById('rv-aviso-manual').classList.toggle('hidden', envioAutomatico);
      rvRender();
    } catch (e) { toast(e.message, 'error'); }
  };

  function celulaDominio(r) {
    if (!r.dominio_status) return '<span class="text-gray-400">—</span>';
    const venc = r.dominio_status === 'ATIVO' && vencido({ valido_ate: r.dominio_valido_ate });
    return `${DOMINIO_STATUS[r.dominio_status] || esc(r.dominio_status)}${venc ? ' <span class="badge-red">vencido</span>' : ''}
      ${r.dominio ? `<div class="font-mono text-gray-600">${esc(r.dominio)}</div>` : ''}
      ${r.dominio_status === 'CONFIGURANDO' && r.dominio_prazo ? `<div class="text-amber-700">até ${new Date(r.dominio_prazo).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</div>` : ''}`;
  }

  window.rvRender = function () {
    const soma = k => revendedores.reduce((s, r) => s + (r[k] || 0), 0);
    document.getElementById('rv-total').textContent = revendedores.length;
    document.getElementById('rv-clientes').textContent = soma('clientes');
    document.getElementById('rv-faturamento').textContent = fmt(soma('faturamento_consultas'));
    document.getElementById('rv-consultas').textContent = soma('consultas');
    document.getElementById('rv-paga').textContent = fmt(soma('comissao_paga'));
    document.getElementById('rv-gerada').textContent = fmt(soma('comissao_gerada'));
    document.getElementById('rv-apagar').textContent = fmt(soma('comissao_a_pagar'));
    document.getElementById('rv-enviando').textContent = fmt(soma('comissao_enviando'));
    document.getElementById('rv-dom-pend').textContent = revendedores.filter(r => r.dominio_status === 'CONFIGURANDO').length;
    const q = (document.getElementById('rv-busca').value || '').toLowerCase().trim();
    const qd = q.replace(/\D/g, '');
    const lista = revendedores.filter(r => !q || (r.name || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q) || (qd && (r.cpf_cnpj || '').includes(qd)));
    const tbody = document.getElementById('rv-tbody');
    if (!lista.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-10 text-center text-gray-400">${revendedores.length ? 'Nenhum parceiro encontrado.' : 'Nenhum parceiro cadastrado. Use “➕ Novo parceiro”.'}</td></tr>`;
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
        <td class="px-4 py-3 text-center hidden md:table-cell text-xs">${r.consultas_na_pagina} consulta(s)${r.descontos ? `<div class="text-green-700">${r.descontos} com desconto</div>` : ''}</td>
        <td class="px-4 py-3 text-center hidden md:table-cell text-xs">${celulaDominio(r)}</td>
        <td class="px-4 py-3 text-right text-green-700">${fmt(r.comissao_paga)}</td>
        <td class="px-4 py-3 text-right font-semibold ${r.comissao_a_pagar > 0 ? 'text-red-600' : 'text-gray-400'}">${fmt(r.comissao_a_pagar)}${r.comissao_enviando > 0 ? `<div class="text-xs font-normal text-blue-600">${fmt(r.comissao_enviando)} enviando</div>` : ''}</td>
        <td class="px-4 py-3 text-center whitespace-nowrap">
          <button onclick="rvAbrirDetalhe(${r.id})" class="action-btn bg-blue-100 text-blue-700 hover:bg-blue-200" title="Controle, custos e domínio">📊</button>
          <button onclick="rvAbrirEdicao(${r.id})" class="action-btn bg-gray-100 text-gray-700 hover:bg-gray-200" title="Editar PIX e página">✏️</button>
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
      ? 'Atenção: o envio automático do Mercado Pago não aceita chave aleatória. Com ela, o ganho fica a pagar e você paga pelo banco.'
      : (envioAutomatico ? 'O ganho é enviado automaticamente para esta chave a cada consulta dos clientes do parceiro.' : '');
  };

  function erroForm(msg) {
    const el = document.getElementById('rv-form-erro');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  window.rvAbrirCadastro = function () {
    montarSecao();
    document.getElementById('rv-form-titulo').textContent = '➕ Novo parceiro';
    document.getElementById('rv-id').value = '';
    document.getElementById('rv-dados-conta').classList.remove('hidden');
    document.getElementById('rv-ativo-box').classList.add('hidden');
    document.getElementById('rv-pagina-box').classList.add('hidden');
    ['rv-nome', 'rv-doc', 'rv-fone', 'rv-email', 'rv-senha', 'rv-pix-chave', 'rv-obs'].forEach(id => { document.getElementById(id).value = ''; });
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
    document.getElementById('rv-obs').value = r.observacao || '';
    document.getElementById('rv-pagina-box').classList.remove('hidden');
    erroForm('');
    openModal('modal-revendedor');
    carregarPaginaEdicao(r.id);
  };

  // Página (home) do parceiro, editada pelo admin no mesmo ✏️.
  const campoPg = k => document.getElementById(`rv-pg-${k}`);
  async function carregarPaginaEdicao(id, soImagens) {
    try {
      const r = await fetch(`/api/admin/revendedores/${id}/pagina`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erro ao carregar a página.');
      if (!soImagens) {
        const p = d.pagina || {};
        ['titulo', 'subtitulo', 'texto', 'whatsapp'].forEach(k => { campoPg(k).value = p[k] || ''; });
        campoPg('cor').value = p.cor || '#1e3a8a';
      }
      document.getElementById('rv-pg-abrir').href = d.slug ? `/r/${encodeURIComponent(d.slug)}` : '#';
      for (const t of ['logo', 'banner']) {
        const img = campoPg(`${t}-prev`);
        if (d[t]) { img.src = d[t]; img.classList.remove('hidden'); } else img.classList.add('hidden');
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  window.rvImagemPagina = async function (tipo, input) {
    const id = document.getElementById('rv-id').value;
    const f = input.files && input.files[0];
    input.value = '';
    if (!f || !id) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { toast('Use PNG, JPG ou WebP.', 'error'); return; }
    if (f.size > 800 * 1024) { toast('Imagem muito grande (máximo 800 KB).', 'error'); return; }
    const base64 = await new Promise((ok, erro) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = erro; fr.readAsDataURL(f); });
    const d = await acao(`/api/admin/revendedores/${id}/pagina/imagem/${tipo}`, { method: 'POST', body: JSON.stringify({ base64 }) }, 'Imagem salva.');
    if (d) carregarPaginaEdicao(id, true);
  };

  window.rvRemoverImagemPagina = async function (tipo) {
    const id = document.getElementById('rv-id').value;
    if (!id || !confirm('Remover esta imagem da página do parceiro?')) return;
    const d = await acao(`/api/admin/revendedores/${id}/pagina/imagem/${tipo}`, { method: 'DELETE' }, 'Imagem removida.');
    if (d) carregarPaginaEdicao(id, true);
  };

  window.rvSalvar = async function (ev) {
    ev.preventDefault();
    const id = document.getElementById('rv-id').value;
    const v = k => document.getElementById(k).value;
    const corpo = { pix_tipo: v('rv-pix-tipo'), pix_chave: v('rv-pix-chave'), observacao: v('rv-obs') };
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
      if (id) {
        const pg = {};
        ['titulo', 'subtitulo', 'texto', 'whatsapp', 'cor'].forEach(k => { pg[k] = campoPg(k).value; });
        const rp = await fetch(`/api/admin/revendedores/${id}/pagina`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pg) });
        const dp = await rp.json();
        if (!rp.ok) throw new Error(dp.error || 'Erro ao salvar a página.');
      }
      closeModal('modal-revendedor');
      toast(id ? 'Parceiro atualizado.' : 'Parceiro cadastrado. Envie o e-mail e a senha para ele entrar em /entrar.');
      await rvCarregar();
      if (id && detalheAtual === parseInt(id, 10)) rvAbrirDetalhe(detalheAtual);
    } catch (e) { erroForm(e.message); } finally { btn.disabled = false; }
  };

  function blocoDominio(rv, dom) {
    dominioAtual = dom || null; foneAtual = rv.phone || null;
    const st = dom ? dom.status : null;
    const opcoes = dom && dom.opcoes && dom.opcoes.length
      ? `<ol class="list-decimal pl-5 font-mono text-xs text-gray-700">${dom.opcoes.map(o => `<li>${esc(o)}</li>`).join('')}</ol>` : '<span class="text-xs text-gray-400">nenhuma opção enviada</span>';
    const dataInput = dom && dom.valido_ate ? new Date(dom.valido_ate).toISOString().slice(0, 10) : '';
    return `
      <div class="border border-gray-200 rounded-lg p-4 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="font-semibold text-gray-800">🔗 Domínio próprio ${st ? DOMINIO_STATUS[st] || esc(st) : '<span class="text-xs text-gray-400 font-normal">não pediu</span>'} ${dom && dom.vencido ? '<span class="badge-red">anuidade vencida</span>' : ''}</h4>
          <div class="text-xs text-gray-500">
            ${dom && dom.pago_em ? `Pago em ${fmtDate(dom.pago_em)}` : ''}
            ${dom && dom.valido_ate ? ` · válido até <strong>${fmtDate(dom.valido_ate)}</strong>` : ''}
            ${st === 'CONFIGURANDO' && dom.prazo_ate ? ` · <span class="text-amber-700 font-semibold">ativar até ${new Date(dom.prazo_ate).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>` : ''}
          </div>
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <div><div class="text-xs text-gray-500 mb-1">Opções do parceiro (ordem de preferência)</div>${opcoes}</div>
          <form class="space-y-2" onsubmit="rvSalvarDominio(event, ${rv.id})">
            <div class="text-xs text-gray-500 space-y-1">
              <p>1. Confira no <a href="https://registro.br/" target="_blank" rel="noopener" class="text-blue-700 underline">registro.br</a> qual das opções está <strong>disponível</strong> (é só pesquisar o nome — a consulta não registra nada).</p>
              <p>2. Registre o domínio, deixe o DNS no ClouDNS (registro A <span class="font-mono">@ → 76.76.21.21</span> e CNAME <span class="font-mono">www → cname.vercel-dns.com</span>). O domínio → parceiro é pelo banco, como no WordPress multisite.</p>
              <p>3. Depois que o domínio apontar, informe-o aqui e marque como <strong>Ativo</strong>: o domínio (e o www) é adicionado sozinho no projeto da Vercel, que gera o HTTPS, e a raiz dele passa a abrir a página do parceiro.</p>
            </div>
            <input id="rvd-dom-nome" class="input-field font-mono" placeholder="dominio.com.br" value="${esc((dom && dom.dominio) || (dom && dom.opcoes && dom.opcoes[0]) || '')}">
            <div class="grid grid-cols-2 gap-2">
              <select id="rvd-dom-status" class="input-field">
                ${['CONFIGURANDO', 'ATIVO', 'AGUARDANDO_PAGAMENTO', 'CANCELADO'].map(s => `<option value="${s}" ${s === (st === 'ATIVO' ? 'ATIVO' : st === 'CANCELADO' ? 'CANCELADO' : st === 'AGUARDANDO_PAGAMENTO' ? 'AGUARDANDO_PAGAMENTO' : 'CONFIGURANDO') ? 'selected' : ''}>${{ CONFIGURANDO: 'Pago — em configuração', ATIVO: 'Ativo', AGUARDANDO_PAGAMENTO: 'Aguardando pagamento', CANCELADO: 'Cancelado' }[s]}</option>`).join('')}
              </select>
              <input id="rvd-dom-validade" type="date" class="input-field" value="${dataInput}" title="Válido até (em branco = 12 meses a partir de agora ao liberar)">
            </div>
            <input id="rvd-dom-obs" class="input-field" placeholder="Observação (opcional)" value="${esc((dom && dom.observacao) || '')}">
            <button class="btn-primary">💾 Salvar domínio</button>
          </form>
        </div>
      </div>`;
  }

  function blocoConsultas(rv) {
    return `
      <div class="border border-gray-200 rounded-lg">
        <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
          <h4 class="font-semibold text-gray-800">🏷️ Consultas e custos do parceiro</h4>
          <div class="flex gap-2">
            <input id="rvd-cons-busca" class="input-field" style="width:220px" placeholder="Buscar consulta..." oninput="rvRenderConsultas(${rv.id})">
            <select id="rvd-cons-filtro" class="input-field" style="width:auto" onchange="rvRenderConsultas(${rv.id})">
              <option value="todas">Todas</option><option value="pagina">Na página dele</option><option value="desconto">Com desconto</option>
            </select>
          </div>
        </div>
        <p class="px-4 pt-3 text-xs text-gray-500">O <strong>custo</strong> é o que o parceiro paga por consulta (e o mínimo que ele pode cobrar). Digite um valor menor que o do site para dar desconto a ele numa consulta; apague o valor e salve para voltar ao preço do site. O desconto vale também para as consultas que ele mesmo fizer.</p>
        <div id="rvd-consultas" class="max-h-96 overflow-y-auto"></div>
      </div>`;
  }

  window.rvRenderConsultas = function (id) {
    const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const q = sem(document.getElementById('rvd-cons-busca').value).trim();
    const f = document.getElementById('rvd-cons-filtro').value;
    const lista = consultasAtual.filter(s =>
      (!q || q.split(/\s+/).every(p => sem(`${s.name} ${s.group}`).includes(p))) &&
      (f === 'todas' || (f === 'pagina' && s.na_pagina) || (f === 'desconto' && s.desconto)));
    document.getElementById('rvd-consultas').innerHTML = lista.length ? `
      <table class="w-full text-xs">
        <thead class="bg-gray-50 sticky top-0"><tr>
          <th class="px-3 py-2 text-left">Consulta</th><th class="px-3 py-2 text-right">Site</th>
          <th class="px-3 py-2 text-right">Custo do parceiro</th><th class="px-3 py-2 text-right">Preço dele</th><th class="px-3 py-2 text-right">Ganho dele</th>
        </tr></thead>
        <tbody class="divide-y divide-gray-50">${lista.map(s => `
          <tr class="${s.na_pagina ? 'bg-green-50/50' : ''}">
            <td class="px-3 py-2"><div class="font-medium text-gray-800">${esc(s.icon || '')} ${esc(s.name)}</div><div class="text-gray-400">${esc(s.group)}</div></td>
            <td class="px-3 py-2 text-right">${fmt(s.catalogo)}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap">
              <input id="rvd-custo-${esc(s.id)}" inputmode="decimal" class="w-20 px-2 py-1 border ${s.desconto ? 'border-green-400 bg-green-50' : 'border-gray-300'} rounded text-right" value="${s.desconto ? precoTela(s.custo) : ''}" placeholder="${precoTela(s.catalogo)}">
              <button onclick="rvSalvarCusto(${id}, '${esc(s.id)}')" class="action-btn bg-blue-100 text-blue-700 hover:bg-blue-200" title="Salvar custo">💾</button>
            </td>
            <td class="px-3 py-2 text-right">${s.na_pagina ? fmt(s.preco) : '<span class="text-gray-400">fora da página</span>'}</td>
            <td class="px-3 py-2 text-right font-semibold ${s.na_pagina ? 'text-green-700' : 'text-gray-300'}">${s.na_pagina ? fmt(Math.max(0, s.venda - s.custo)) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="px-4 py-6 text-center text-gray-400 text-sm">Nenhuma consulta.</div>';
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
      consultasAtual = d.consultas || [];
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
            ${rv.slug ? `<div class="text-xs mt-1"><a class="text-blue-700 underline" target="_blank" rel="noopener" href="/r/${encodeURIComponent(rv.slug)}">Página do parceiro: /r/${esc(rv.slug)}</a></div>` : ''}
          </div>
          <div class="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
            <div class="text-xs text-green-700 font-semibold">Chave PIX (${esc(rv.pix_tipo_nome || '—')})</div>
            <div class="font-mono text-green-900 break-all">${esc(rv.pix_chave || 'não cadastrada')}</div>
            <div class="text-xs text-green-700 mt-1">${rv.envio_automatico ? 'Envio automático do ganho a cada consulta.' : 'Envio manual (pague pelo banco e dê baixa abaixo).'}</div>
          </div>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          ${card('Usuários', rv.clientes, 'border-l-blue-500', `${rv.consultas} consultas · ${fmt(rv.faturamento_consultas)}`)}
          ${card('Na página', rv.consultas_na_pagina, 'border-l-green-500', `${rv.descontos} consulta(s) com desconto`)}
          ${card('Ganhos pagos', fmt(rv.comissao_paga), 'border-l-purple-500', `de ${fmt(rv.comissao_gerada)} gerados`)}
          ${card('A pagar', fmt(rv.comissao_a_pagar), 'border-l-red-500', rv.comissao_enviando > 0 ? `${fmt(rv.comissao_enviando)} enviando` : '')}
        </div>
        ${rv.ultimo_erro ? `<div class="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">⚠️ Último envio automático: ${esc(rv.ultimo_erro)}</div>` : ''}
        ${travado ? `<div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">Há ganho em envio sem resposta do Mercado Pago. Confira no extrato do Mercado Pago se o PIX saiu antes de pagar de novo. Se <strong>não</strong> saiu, use “Registrar pagamento manual” e marque a opção de incluir esse lote depois de pagar.</div>` : ''}
        <div class="flex flex-wrap gap-2">
          <button onclick="rvEnviarAgora(${rv.id})" class="btn-secondary" ${rv.comissao_a_pagar > 0 && rv.envio_automatico ? '' : 'disabled style="opacity:.5"'}>💸 Tentar envio automático agora</button>
          <button onclick="rvPagamentoManual(${rv.id}, ${travado})" class="btn-primary" ${rv.comissao_a_pagar > 0 || travado ? '' : 'disabled style="opacity:.5"'}>✅ Registrar pagamento manual</button>
          <button onclick="rvAbrirEdicao(${rv.id})" class="btn-ghost">✏️ Editar PIX e página</button>
        </div>

        ${blocoDominio(rv, d.dominio)}
        ${blocoConsultas(rv)}

        <div>
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h4 class="font-semibold text-gray-800">Usuários do parceiro</h4>
            <form class="flex gap-2" onsubmit="rvVincular(event, ${rv.id})">
              <input id="rvd-vincular" class="input-field" style="width:260px" placeholder="E-mail ou CPF/CNPJ de conta existente">
              <button class="btn-secondary whitespace-nowrap">🔗 Vincular</button>
            </form>
          </div>
          <div class="overflow-x-auto border border-gray-100 rounded-lg">
            <table class="w-full text-sm">
              <thead class="bg-gray-50"><tr>
                <th class="px-3 py-2 text-left">Usuário</th><th class="px-3 py-2 text-center">Consultas</th>
                <th class="px-3 py-2 text-right hidden md:table-cell">Faturamento</th>
                <th class="px-3 py-2 text-right">Ganho do parceiro</th><th class="px-3 py-2"></th>
              </tr></thead>
              <tbody class="divide-y divide-gray-50">${d.clientes.length ? d.clientes.map(c => `
                <tr>
                  <td class="px-3 py-2"><div class="font-medium">${esc(c.name)} ${c.active ? '' : '<span class="badge-red">Bloqueado</span>'} ${c.pos_pago ? '<span class="badge-amber">Pós-pago</span>' : ''}</div><div class="text-xs text-gray-400">${esc(c.email)}</div></td>
                  <td class="px-3 py-2 text-center">${c.consultas}</td>
                  <td class="px-3 py-2 text-right hidden md:table-cell">${fmt(c.faturamento)}</td>
                  <td class="px-3 py-2 text-right">${fmt(c.comissao)}</td>
                  <td class="px-3 py-2 text-right"><button onclick="rvDesvincular(${rv.id}, ${c.id})" class="action-btn bg-red-50 text-red-600 hover:bg-red-100" title="Desvincular">✕</button></td>
                </tr>`).join('') : `<tr><td colspan="5" class="px-3 py-6 text-center text-gray-400">Nenhum usuário ainda. O parceiro cria os dele em “Meus Clientes”, ou vincule uma conta existente acima.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <div class="grid lg:grid-cols-2 gap-4">
          <div>
            <h4 class="font-semibold text-gray-800 mb-2">Ganhos</h4>
            <div class="overflow-x-auto border border-gray-100 rounded-lg max-h-80 overflow-y-auto">
              <table class="w-full text-xs">
                <thead class="bg-gray-50"><tr><th class="px-3 py-2 text-left">Data</th><th class="px-3 py-2 text-left">Usuário / consulta</th><th class="px-3 py-2 text-right">Venda</th><th class="px-3 py-2 text-right">Ganho</th><th class="px-3 py-2 text-center">Situação</th></tr></thead>
                <tbody class="divide-y divide-gray-50">${d.comissoes.length ? d.comissoes.map(c => `
                  <tr title="${esc(c.envio_erro || '')}">
                    <td class="px-3 py-2">${fmtDate(c.created_at)}</td>
                    <td class="px-3 py-2">${esc(c.client_name)}${ORIGEM[c.origem] || ''}<div class="text-gray-400">${esc(c.service_name || '')}</div></td>
                    <td class="px-3 py-2 text-right">${fmt(c.base)}${c.custo != null ? `<div class="text-gray-400">custo ${fmt(c.custo)}</div>` : ''}</td>
                    <td class="px-3 py-2 text-right font-semibold ${c.amount < 0 ? 'text-red-600' : ''}">${fmt(c.amount)}</td>
                    <td class="px-3 py-2 text-center">${STATUS_COMISSAO[c.status] || esc(c.status)}${c.envio_erro && c.status !== 'PAGA' ? ' ⚠️' : ''}</td>
                  </tr>`).join('') : '<tr><td colspan="5" class="px-3 py-6 text-center text-gray-400">Nenhum ganho ainda.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h4 class="font-semibold text-gray-800 mb-2">Pagamentos ao parceiro</h4>
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
      rvRenderConsultas(rv.id);
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

  window.rvSalvarCusto = async function (id, serviceId) {
    const v = document.getElementById(`rvd-custo-${serviceId}`).value.trim();
    const custo = v === '' ? null : v.replace(/\./g, '').replace(',', '.');
    const d = await acao(`/api/admin/revendedores/${id}/custos/${encodeURIComponent(serviceId)}`, { method: 'PUT', body: JSON.stringify({ custo }) },
      d => d.desconto ? `Custo do parceiro: ${fmt(d.custo)}.` : 'Desconto removido — volta ao preço do site.');
    if (!d) return;
    const s = consultasAtual.find(x => x.id === serviceId);
    if (s) {
      s.custo = d.custo; s.desconto = d.desconto;
      if (s.na_pagina) s.venda = Math.max(s.preco, s.custo);
      if (s.na_pagina && s.preco < s.custo) toast(`Atenção: o preço do parceiro (${fmt(s.preco)}) ficou abaixo do custo — o cliente dele paga o custo e o parceiro não ganha nesta consulta.`, 'error');
    }
    rvRenderConsultas(id);
  };

  // "Salvar domínio" de quem ainda não pagou a anuidade (sem pedido, aguardando
  // pagamento, cancelado ou vencido) abre antes o PIX de R$ 200,00 em nome do
  // parceiro (pedido do dono, 26/10/2026). Cancelar ou voltar para "aguardando"
  // não cobra nada, e "pago por fora" salva sem PIX, como antes.
  const anuidadePaga = d => d && (d.status === 'CONFIGURANDO' || d.status === 'ATIVO') && !vencido(d);

  window.rvSalvarDominio = async function (ev, id) {
    ev.preventDefault();
    const status = document.getElementById('rvd-dom-status').value;
    const dados = {
      status, dominio: document.getElementById('rvd-dom-nome').value,
      valido_ate: document.getElementById('rvd-dom-validade').value || null, observacao: document.getElementById('rvd-dom-obs').value,
    };
    if ((status === 'CONFIGURANDO' || status === 'ATIVO') && !anuidadePaga(dominioAtual)) { abrirPixAdmin(id, dados); return; }
    await gravarDominio(id, dados);
  };

  async function gravarDominio(id, dados) {
    if (dados.status === 'ATIVO' && !confirm(`Confirmar que ${dados.dominio} já está com o DNS no ClouDNS? Ele é adicionado ao projeto da Vercel agora, a raiz passa a abrir a página do parceiro e ele é avisado no WhatsApp.`)) return;
    const d = await acao(`/api/admin/revendedores/${id}/dominio`, { method: 'PUT', body: JSON.stringify(dados) });
    if (!d) return;
    const v = d.vercel;
    if (!v) toast('Domínio salvo.');
    else if (!v.ok) toast(`Domínio ativado no banco, mas ${v.motivo}`, 'error');
    else if (v.pendente && v.pendente.length) alert(`Domínio ativado e adicionado na Vercel.\n\nAinda falta:\n- ${v.pendente.join('\n- ')}\n\nO HTTPS sai sozinho depois que o DNS apontar.`);
    else toast('Domínio ativado e adicionado na Vercel — DNS conferido.');
    recarregar(id);
  }

  function abrirPixAdmin(id, dados) {
    dominioPixPendente = { id, dados };
    clearInterval(dominioPixPoll);
    const temFone = !!foneAtual;
    document.getElementById('rvdp-corpo').innerHTML = `
      <p>Este parceiro ainda não pagou a anuidade do domínio próprio: <strong>R$ 200,00 por 12 meses</strong>, que inclui a
        <strong>taxa de registro do domínio e o serviço de configuração</strong> (DNS e HTTPS).</p>
      <p class="text-xs text-gray-500">Domínio: <span class="font-mono">${esc(dados.dominio || '—')}</span></p>
      <label class="flex items-center gap-2 text-sm"><input id="rvdp-whats" type="checkbox" ${temFone ? 'checked' : 'disabled'}> Enviar o PIX para o WhatsApp do parceiro${temFone ? '' : ' (sem WhatsApp no cadastro)'}</label>
      <button id="rvdp-gerar" onclick="rvGerarDominioPix()" class="btn-primary w-full justify-center">Gerar PIX de R$ 200,00</button>
      <div id="rvdp-pix"></div>
      <button onclick="rvSalvarSemPix()" class="btn-ghost w-full justify-center text-xs">Já pagou por fora — salvar sem PIX</button>`;
    openModal('modal-dominio-pix-admin');
  }

  window.rvGerarDominioPix = async function () {
    const { id, dados } = dominioPixPendente || {};
    if (!id) return;
    const btn = document.getElementById('rvdp-gerar');
    btn.disabled = true;
    const d = await acao(`/api/admin/revendedores/${id}/dominio/pix`, {
      method: 'POST', body: JSON.stringify({ dominio: dados.dominio, whatsapp: document.getElementById('rvdp-whats').checked }),
    });
    if (!d) { btn.disabled = false; return; }
    btn.classList.add('hidden');
    document.getElementById('rvdp-pix').innerHTML = `
      <div class="flex justify-center"><img alt="QR Code PIX" class="w-56 h-56 border rounded-lg" src="data:image/png;base64,${esc(d.qrCode || '')}"></div>
      <div class="text-xs text-gray-500 mt-3 mb-1">PIX copia e cola</div>
      <textarea id="rvdp-copia" readonly rows="3" class="input-field font-mono text-xs">${esc(d.pixCopiaECola || '')}</textarea>
      <button onclick="navigator.clipboard.writeText(document.getElementById('rvdp-copia').value).then(() => toast('Código PIX copiado.'))" class="btn-secondary w-full justify-center mt-2">📋 Copiar código PIX</button>
      ${d.whatsapp ? '<p class="text-xs text-green-700 mt-2">✅ Enviado para o WhatsApp do parceiro.</p>' : ''}
      <div id="rvdp-situacao" class="text-center text-sm text-amber-700 font-semibold mt-3">⏳ Aguardando o pagamento… o domínio é salvo assim que confirmar.</div>`;
    const inicio = Date.now();
    dominioPixPoll = setInterval(async () => {
      if (Date.now() - inicio > 30 * 60 * 1000) { clearInterval(dominioPixPoll); return; }
      try {
        const r = await fetch(`/api/admin/revendedores/${id}/dominio/pix/${encodeURIComponent(d.paymentId)}`);
        const s = await r.json();
        if (!s.credited) return;
        clearInterval(dominioPixPoll);
        document.getElementById('rvdp-situacao').className = 'text-center text-sm text-green-700 font-semibold mt-3';
        document.getElementById('rvdp-situacao').textContent = '✅ Pagamento confirmado!';
        closeModal('modal-dominio-pix-admin');
        dominioPixPendente = null;
        await gravarDominio(id, dados);
      } catch { /* tenta de novo na próxima volta */ }
    }, 5000);
  };

  window.rvSalvarSemPix = async function () {
    const { id, dados } = dominioPixPendente || {};
    if (!id || !confirm('Salvar sem cobrar? Use só se o parceiro já pagou os R$ 200,00 por fora.')) return;
    window.rvFecharDominioPix();
    await gravarDominio(id, dados);
  };

  window.rvFecharDominioPix = function () {
    clearInterval(dominioPixPoll);
    dominioPixPendente = null;
    closeModal('modal-dominio-pix-admin');
  };

  window.rvEnviarAgora = async function (id) {
    const d = await acao(`/api/admin/revendedores/${id}/enviar`, { method: 'POST' });
    if (d) toast(d.enviado ? `PIX de ${fmt(d.total)} enviado ao Mercado Pago.` : `Não enviado: ${d.motivo}`, d.enviado ? 'success' : 'error');
    recarregar(id);
  };

  window.rvPagamentoManual = async function (id, travado) {
    const r = revendedores.find(x => x.id === id);
    const valor = r ? fmt(r.comissao_a_pagar) : '';
    if (!confirm(`Confirmar que você já pagou ${valor} a ${r?.name || 'este parceiro'} pelo banco?\n\nTodos os ganhos "a pagar" serão marcados como pagos.`)) return;
    let incluirTravados = false;
    if (travado) incluirTravados = confirm('Incluir também o lote que ficou "enviando" sem resposta do Mercado Pago?\n\nSó confirme se você conferiu no Mercado Pago que esse PIX automático NÃO saiu.');
    const observacao = prompt('Observação do pagamento (opcional, ex.: id do PIX no banco):', '') || '';
    await acao(`/api/admin/revendedores/${id}/pagamento-manual`, { method: 'POST', body: JSON.stringify({ incluirTravados, observacao }) },
      d => `Baixa de ${fmt(d.valor)} registrada (${d.comissoes} lançamentos).`);
    recarregar(id);
  };

  window.rvVincular = async function (ev, id) {
    ev.preventDefault();
    const busca = document.getElementById('rvd-vincular').value;
    const d = await acao(`/api/admin/revendedores/${id}/clientes`, { method: 'POST', body: JSON.stringify({ busca }) }, d => `${d.cliente.name} vinculado.`);
    if (d) recarregar(id);
  };

  window.rvDesvincular = async function (id, uid) {
    if (!confirm('Desvincular este usuário do parceiro? Ele volta a pagar o preço do site e as próximas consultas dele deixam de gerar ganho.')) return;
    const d = await acao(`/api/admin/revendedores/${id}/clientes/${uid}`, { method: 'DELETE' }, 'Usuário desvinculado.');
    if (d) recarregar(id);
  };
})();
