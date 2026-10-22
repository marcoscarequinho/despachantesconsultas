// ── Contrato de Arrendamento Veicular com IA — formulário em etapas ─────────
// Mesmo desenho do assets/contrato-social.js: o estado fica num objeto só
// (`av`); inputs de texto só gravam no objeto (sem redesenhar, para não perder
// o foco nem o clique no "Próximo"), select/checkbox redesenham. A placa
// preenche o veículo (POST /api/arrendamento-veicular/buscar-placa) e o
// CPF/CNPJ preenche cada parte (.../buscar-documento); o cliente confere tudo.
// A validação daqui é só para o cliente corrigir sem ida ao servidor — a que
// vale é a do arrendamento-veicular.js.
(function () {
  const PASSOS = ['Veículo', 'Arrendador', 'Arrendatário', 'Condições', 'Revisão'];
  const ESTADOS_CIVIS = [['', '—'], ['solteiro', 'Solteiro(a)'], ['casado', 'Casado(a)'], ['divorciado', 'Divorciado(a)'], ['viuvo', 'Viúvo(a)'], ['separado', 'Separado(a) judicialmente']];
  const CATEGORIAS = [['', '—'], ...['A', 'B', 'AB', 'C', 'D', 'E', 'AC', 'AD', 'AE'].map(c => [c, c])];
  const DIAS_SEMANA = [['1', 'Segunda-feira'], ['2', 'Terça-feira'], ['3', 'Quarta-feira'], ['4', 'Quinta-feira'], ['5', 'Sexta-feira'], ['6', 'Sábado'], ['0', 'Domingo']];
  const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

  let av = null;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dig = s => String(s ?? '').replace(/\D/g, '');
  const docLimpo = s => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const endVazio = () => ({ logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', cep: '' });
  const pessoaVazia = () => ({
    tipo: 'PF', nome: '', documento: '', genero: 'M', nacionalidade: 'brasileira', estadoCivil: '', profissao: '',
    rg: '', orgaoRg: '', cnh: '', cnhCategoria: '', telefone: '', email: '', endereco: endVazio(),
    representante: { nome: '', cpf: '', qualidade: '' }, representantes: [],
  });
  const hojeTxt = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
  function novoEstado() {
    return {
      passo: 1, buscaPlaca: null, buscaDoc: { arrendador: null, arrendatario: null },
      veiculo: { placa: '', renavam: '', chassi: '', marcaModelo: '', anoFabricacao: '', anoModelo: '', cor: '', combustivel: '', especie: '', tipo: '',
        municipio: '', uf: '', kmEntrega: '', proprietarioNome: '', proprietarioDocumento: '', restricaoFinanceira: '' },
      arrendador: pessoaVazia(), arrendatario: pessoaVazia(),
      condicoes: { inicio: hojeTxt(), prazoTipo: 'determinado', prazoMeses: '12', valor: '', periodicidade: 'mensal', diaPagamento: '10',
        formaPagamento: 'pix', dadosPagamento: '', caucao: '', kmLimite: '', valorKmExcedente: '', uso: 'particular', circulacao: 'uf',
        seguro: 'sem', franquia: '', manutencao: 'arrendatario', ipva: 'arrendador', multaRescisoria: '1', avisoPrevio: '30',
        toleranciaAtraso: '5', condicoesParticulares: '', foro: '' },
      cidadeAssinatura: '', ciente: false,
    };
  }

  // ── Dinheiro e documentos ─────────────────────────────────────────────────
  function centavos(s) {
    const t = String(s ?? '').trim().replace(/[R$\s]/g, '');
    if (!t) return NaN;
    const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }
  const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  function dataBR(s) {
    const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null;
  }
  function cpfOk(d) {
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = 11 - s % 11; return r >= 10 ? 0 : r; };
    return dv(9) === +d[9] && dv(10) === +d[10];
  }
  function cnpjOk(c) {
    if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(.)\1+$/.test(c)) return false;
    const dv = n => { let s = 0, p = 2; for (let i = n - 1; i >= 0; i--) { s += (c.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return dv(12) === +c[12] && dv(13) === +c[13];
  }
  const fmtDoc = d => d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d;

  function setPath(caminho, valor) {
    const k = caminho.split('.');
    let o = av;
    for (let i = 0; i < k.length - 1; i++) o = o[k[i]];
    o[k[k.length - 1]] = valor;
  }
  function getPath(caminho) { return caminho.split('.').reduce((o, k) => o?.[k], av); }

  // ── Componentes (data-av = caminho no estado; data-redraw = redesenha) ────
  const inp = (caminho, label, { ph = '', req = false, extra = '', ajuda = '' } = {}) => `
    <div>
      <label class="label">${label}${req ? ' <span class="text-red-500">*</span>' : ''}</label>
      <input type="text" class="input-field" data-av="${caminho}" value="${esc(getPath(caminho))}" placeholder="${esc(ph)}" ${extra}>
      ${ajuda ? `<div class="text-xs text-gray-500 mt-1">${ajuda}</div>` : ''}
    </div>`;
  const sel = (caminho, label, opcoes, { redraw = true, ajuda = '', req = false } = {}) => `
    <div>
      <label class="label">${label}${req ? ' <span class="text-red-500">*</span>' : ''}</label>
      <select class="input-field" data-av="${caminho}" ${redraw ? 'data-redraw="1"' : ''}>
        ${opcoes.map(([v, t]) => `<option value="${esc(v)}" ${String(getPath(caminho)) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      ${ajuda ? `<div class="text-xs text-gray-500 mt-1">${ajuda}</div>` : ''}
    </div>`;
  const chk = (caminho, texto) => `
    <label class="flex items-start gap-2 text-sm text-gray-700">
      <input type="checkbox" class="mt-1" data-av="${caminho}" ${getPath(caminho) ? 'checked' : ''}>
      <span>${texto}</span>
    </label>`;
  const blocoEndereco = (base, titulo) => `
    <div class="border border-gray-200 rounded-lg p-3 space-y-3">
      <div class="text-xs font-semibold text-gray-600">${titulo}</div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${inp(`${base}.cep`, 'CEP', { req: true, ph: '00000000', extra: `inputmode="numeric" maxlength="9" data-cep="${base}"` })}
        <div class="col-span-1 sm:col-span-2">${inp(`${base}.logradouro`, 'Logradouro', { req: true, ph: 'Rua, avenida…' })}</div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${inp(`${base}.numero`, 'Número', { req: true })}
        ${inp(`${base}.complemento`, 'Complemento', { ph: 'Apto, bloco…' })}
        ${inp(`${base}.bairro`, 'Bairro', { req: true })}
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2">${inp(`${base}.cidade`, 'Cidade', { req: true })}</div>
        ${sel(`${base}.uf`, 'UF', [['', '—'], ...UFS.map(u => [u, u])], { req: true, redraw: false })}
      </div>
    </div>`;
  const status = (id, b) => `<div id="${id}" class="text-xs ${b?.erro ? 'text-red-600' : b?.aviso ? 'text-amber-700' : 'text-green-700'}">${b ? esc(b.erro || b.ok) + (b.aviso ? ` ${esc(b.aviso)}` : '') : ''}</div>`;

  // ── Etapas ────────────────────────────────────────────────────────────────
  function passoVeiculo() {
    const v = av.veiculo;
    const restricao = v.restricaoFinanceira && !/NADA CONSTA|SEM RESTRI/i.test(v.restricaoFinanceira);
    return `
      <div class="bg-indigo-50 border border-indigo-200 rounded-lg p-3 space-y-2">
        <p class="text-xs text-indigo-800">Digite a placa e busque: preenchemos o veículo pela base do Detran e o proprietário vira o arrendador (você pode trocar). A busca é grátis.</p>
        <div class="flex gap-2 items-end">
          <div class="flex-1">${inp('veiculo.placa', 'Placa', { req: true, ph: 'ABC1D23', extra: 'maxlength="8" data-placa="1" style="text-transform:uppercase"' })}</div>
          <button type="button" data-acao="buscar-placa" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-2.5 rounded">🔎 Buscar veículo</button>
        </div>
        ${status('av-placa-status', av.buscaPlaca)}
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        ${inp('veiculo.marcaModelo', 'Marca/Modelo', { req: true, ph: 'VW/GOL 1.0' })}
        ${inp('veiculo.cor', 'Cor', { req: true })}
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        ${inp('veiculo.anoFabricacao', 'Ano fabricação', { req: true, extra: 'maxlength="4" inputmode="numeric"' })}
        ${inp('veiculo.anoModelo', 'Ano modelo', { req: true, extra: 'maxlength="4" inputmode="numeric"' })}
        ${inp('veiculo.renavam', 'Renavam', { req: true, extra: 'maxlength="11" inputmode="numeric"' })}
        ${inp('veiculo.kmEntrega', 'Km na entrega', { ph: 'opcional', extra: 'inputmode="numeric"' })}
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        ${inp('veiculo.chassi', 'Chassi', { req: true, extra: 'maxlength="17" style="text-transform:uppercase"' })}
        ${inp('veiculo.combustivel', 'Combustível')}
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        ${inp('veiculo.especie', 'Espécie', { ph: 'PASSAGEIRO' })}
        ${inp('veiculo.tipo', 'Tipo', { ph: 'AUTOMOVEL' })}
        ${inp('veiculo.municipio', 'Município de registro')}
        ${sel('veiculo.uf', 'UF de registro', [['', '—'], ...UFS.map(u => [u, u])], { redraw: false })}
      </div>
      ${v.proprietarioNome ? `<div class="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">Proprietário no Detran: <strong>${esc(v.proprietarioNome)}</strong>${v.proprietarioDocumento ? ` (${esc(fmtDoc(v.proprietarioDocumento))})` : ''}</div>` : ''}
      ${restricao ? `<div class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">⚠️ Restrição no veículo: <strong>${esc(v.restricaoFinanceira)}</strong>. Em veículo financiado, confira se o contrato do banco permite arrendar a terceiro. A restrição sai declarada no contrato.</div>` : ''}`;
  }

  function passoPessoa(papel) {
    const p = av[papel], b = papel;
    const titulo = papel === 'arrendador' ? 'ARRENDADOR (quem cede o veículo)' : 'ARRENDATÁRIO (quem vai usar o veículo)';
    const v = av.veiculo;
    const ehDono = v.proprietarioDocumento && docLimpo(p.documento) === v.proprietarioDocumento;
    return `
      <div class="font-semibold text-sm text-gray-800">${titulo}</div>
      ${sel(`${b}.tipo`, 'Pessoa', [['PF', 'Física (CPF)'], ['PJ', 'Jurídica (CNPJ)']])}
      <div class="bg-indigo-50 border border-indigo-200 rounded-lg p-3 space-y-2">
        <div class="flex gap-2 items-end">
          <div class="flex-1">${inp(`${b}.documento`, p.tipo === 'PJ' ? 'CNPJ' : 'CPF', { req: true, extra: 'maxlength="18"' })}</div>
          <button type="button" data-acao="buscar-doc" data-valor="${papel}" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-2.5 rounded">🔎 Buscar dados</button>
        </div>
        ${status(`av-doc-status-${papel}`, av.buscaDoc[papel])}
      </div>
      ${papel === 'arrendador' && v.proprietarioNome && docLimpo(p.documento) && !ehDono
        ? `<div class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">O arrendador não é o proprietário que consta no Detran (${esc(v.proprietarioNome)}). O contrato vai declarar que ele tem autorização do proprietário — guarde essa autorização por escrito.</div>` : ''}
      ${inp(`${b}.nome`, p.tipo === 'PJ' ? 'Razão social' : 'Nome completo', { req: true })}
      ${p.tipo === 'PF' ? `
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          ${sel(`${b}.genero`, 'Tratamento', [['M', 'Masculino'], ['F', 'Feminino']], { redraw: false })}
          ${inp(`${b}.nacionalidade`, 'Nacionalidade', { req: true })}
          ${sel(`${b}.estadoCivil`, 'Estado civil', ESTADOS_CIVIS, { req: true, redraw: false })}
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          ${inp(`${b}.profissao`, 'Profissão', { req: true, ph: papel === 'arrendatario' ? 'motorista' : 'empresário' })}
          ${inp(`${b}.rg`, 'RG (opcional)')}
          ${inp(`${b}.orgaoRg`, 'Órgão emissor', { ph: 'DETRAN/RJ' })}
        </div>
        ${papel === 'arrendatario' ? `
          <div class="grid grid-cols-2 gap-3">
            ${inp(`${b}.cnh`, 'Nº de registro da CNH', { req: true, extra: 'maxlength="11" inputmode="numeric"' })}
            ${sel(`${b}.cnhCategoria`, 'Categoria da CNH', CATEGORIAS, { req: true, redraw: false })}
          </div>` : ''}` : `
        <div class="border border-gray-200 rounded-lg p-3 space-y-3">
          <div class="text-xs font-semibold text-gray-600">Quem assina pela empresa</div>
          ${p.representantes.length ? `<div class="flex flex-wrap gap-1">${p.representantes.map((r, i) => `<button type="button" data-acao="usar-rep" data-valor="${papel}" data-i="${i}" class="text-xs border border-indigo-300 text-indigo-700 rounded px-2 py-1 hover:bg-indigo-50">${esc(r.nome)}</button>`).join('')}</div><div class="text-xs text-gray-500">Administradores na Receita — clique para usar. A Receita não informa o CPF completo: digite.</div>` : ''}
          <div class="grid sm:grid-cols-3 gap-3">
            ${inp(`${b}.representante.nome`, 'Nome', { req: true })}
            ${inp(`${b}.representante.cpf`, 'CPF', { req: true, extra: 'maxlength="14" inputmode="numeric"' })}
            ${inp(`${b}.representante.qualidade`, 'Cargo', { req: true, ph: 'sócio-administrador' })}
          </div>
        </div>`}
      <div class="grid sm:grid-cols-2 gap-3">
        ${inp(`${b}.telefone`, 'Telefone/WhatsApp (opcional)', { extra: 'inputmode="numeric" maxlength="15"', ajuda: 'Sai no contrato como canal de comunicação entre as partes.' })}
        ${inp(`${b}.email`, 'E-mail (opcional)')}
      </div>
      ${blocoEndereco(`${b}.endereco`, p.tipo === 'PJ' ? 'Sede' : 'Endereço residencial')}`;
  }

  function passoCondicoes() {
    const c = av.condicoes;
    const cidades = [];
    const addCidade = e => { if (e.cidade && e.uf && !cidades.some(([v]) => v === `${e.cidade}/${e.uf}`)) cidades.push([`${e.cidade}/${e.uf}`, `${e.cidade}/${e.uf}`]); };
    addCidade(av.arrendador.endereco); addCidade(av.arrendatario.endereco);
    if (!cidades.some(([v]) => v === c.foro)) c.foro = cidades[0]?.[0] || '';
    if (!av.cidadeAssinatura) av.cidadeAssinatura = av.arrendador.endereco.cidade;
    const per = { semanal: 'semana', quinzenal: 'quinzena', mensal: 'mês' }[c.periodicidade];
    return `
      <p class="text-xs text-gray-500">O texto de cada cláusula é fixo e segue o Código Civil — aqui você escolhe os valores e as opções.</p>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${inp('condicoes.inicio', 'Início', { req: true, ph: 'dd/mm/aaaa', extra: 'data-data="1" maxlength="10" inputmode="numeric"' })}
        ${sel('condicoes.prazoTipo', 'Prazo', [['determinado', 'Determinado (em meses)'], ['indeterminado', 'Indeterminado']])}
        ${c.prazoTipo === 'determinado' ? inp('condicoes.prazoMeses', 'Meses', { req: true, extra: 'maxlength="2" inputmode="numeric"' }) : inp('condicoes.avisoPrevio', 'Aviso prévio (dias)', { extra: 'maxlength="2" inputmode="numeric"' })}
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${sel('condicoes.periodicidade', 'Aluguel', [['mensal', 'Mensal'], ['quinzenal', 'Quinzenal'], ['semanal', 'Semanal']])}
        ${inp('condicoes.valor', `Valor por ${per} (R$)`, { req: true, ph: '2.500,00', extra: 'inputmode="decimal"' })}
        ${c.periodicidade === 'mensal'
          ? inp('condicoes.diaPagamento', 'Dia do pagamento', { req: true, extra: 'maxlength="2" inputmode="numeric"', ajuda: 'De 1 a 28.' })
          : sel('condicoes.diaPagamento', 'Pagamento até', DIAS_SEMANA, { redraw: false })}
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        ${sel('condicoes.formaPagamento', 'Forma de pagamento', [['pix', 'PIX'], ['transferencia', 'Transferência bancária'], ['boleto', 'Boleto'], ['dinheiro', 'Dinheiro (com recibo)']], { redraw: false })}
        ${inp('condicoes.dadosPagamento', 'Chave PIX / conta (opcional)', { ph: 'chave PIX: CPF do arrendador' })}
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${inp('condicoes.caucao', 'Caução (R$, opcional)', { ph: '0,00', extra: 'inputmode="decimal"' })}
        ${inp('condicoes.kmLimite', `Limite de km por ${per} (opcional)`, { ph: 'sem limite', extra: 'inputmode="numeric"' })}
        ${inp('condicoes.valorKmExcedente', 'R$ por km excedente', { ph: '0,50', extra: 'inputmode="decimal"' })}
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        ${sel('condicoes.uso', 'Uso do veículo', [['particular', 'Particular'], ['aplicativo', 'Transporte por aplicativo (Uber, 99…)'], ['entregas', 'Entregas'], ['comercial', 'Atividade profissional/comercial']], { redraw: false })}
        ${sel('condicoes.circulacao', 'Pode circular', [['uf', 'Só no estado de registro'], ['nacional', 'Em todo o Brasil']], { redraw: false })}
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${sel('condicoes.seguro', 'Seguro', [['sem', 'Sem seguro'], ['arrendador', 'Arrendador paga'], ['arrendatario', 'Arrendatário contrata']])}
        ${sel('condicoes.manutencao', 'Manutenção', [['arrendatario', 'Arrendatário paga'], ['arrendador', 'Arrendador paga']], { redraw: false })}
        ${sel('condicoes.ipva', 'IPVA e licenciamento', [['arrendador', 'Arrendador paga'], ['arrendatario', 'Arrendatário paga']], { redraw: false })}
      </div>
      ${c.seguro === 'arrendador' ? inp('condicoes.franquia', 'Franquia paga pelo arrendatário em sinistro (R$, opcional)', { ph: '0,00', extra: 'inputmode="decimal"' }) : ''}
      <div class="grid grid-cols-2 gap-3">
        ${inp('condicoes.toleranciaAtraso', 'Rescinde após atraso de (dias)', { extra: 'maxlength="2" inputmode="numeric"' })}
        ${c.prazoTipo === 'determinado' ? sel('condicoes.multaRescisoria', 'Multa por devolver antes do prazo', [['0', 'Sem multa (aviso de 7 dias)'], ['1', '1 mês de aluguel'], ['2', '2 meses de aluguel'], ['3', '3 meses de aluguel']], { redraw: false, ajuda: 'Reduzida na proporção do prazo já cumprido.' }) : '<div></div>'}
      </div>
      <div>
        <label class="label">Condições de uso combinadas (opcional) — a IA transforma em cláusulas</label>
        <textarea class="input-field" rows="3" maxlength="2000" data-av="condicoes.condicoesParticulares" placeholder="Ex.: o carro dorme na garagem do motorista; proibido fumar; não pode rodar em estrada de terra">${esc(c.condicoesParticulares)}</textarea>
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        ${sel('condicoes.foro', 'Foro', cidades.length ? cidades : [['', 'Preencha os endereços']], { redraw: false, ajuda: 'Cidade do arrendador ou do arrendatário.' })}
        ${inp('cidadeAssinatura', 'Cidade onde vai assinar', { req: true })}
      </div>`;
  }

  function passoRevisao() {
    const v = av.veiculo, c = av.condicoes;
    const lin = (k, x) => x ? `<div class="flex gap-2 text-sm"><span class="text-gray-500 w-32 flex-shrink-0">${k}</span><span class="text-gray-800">${x}</span></div>` : '';
    const per = { semanal: 'por semana', quinzenal: 'por quinzena', mensal: 'por mês' }[c.periodicidade];
    return `
      <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1">
        ${lin('Veículo', esc(`${v.marcaModelo} — ${v.placa} — ${v.anoFabricacao}/${v.anoModelo}`))}
        ${lin('Arrendador', esc(`${av.arrendador.nome} (${fmtDoc(docLimpo(av.arrendador.documento))})`))}
        ${lin('Arrendatário', esc(`${av.arrendatario.nome} (${fmtDoc(docLimpo(av.arrendatario.documento))})`))}
        ${lin('Prazo', c.prazoTipo === 'determinado' ? `${esc(c.prazoMeses)} meses a partir de ${esc(c.inicio)}` : `Indeterminado, a partir de ${esc(c.inicio)}`)}
        ${lin('Aluguel', `${brl(centavos(c.valor) || 0)} ${per}`)}
        ${centavos(c.caucao) > 0 ? lin('Caução', brl(centavos(c.caucao))) : ''}
        ${lin('Foro', esc(c.foro))}
      </div>
      <div class="text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded p-2">A IA vai redigir só as condições específicas de uso do veículo, a partir do uso escolhido e do que você escreveu. Todo o resto do texto é fixo. Sai com termo de vistoria para preencher na entrega. Leva cerca de 1 minuto.</div>
      ${chk('ciente', 'Conferi os dados. Entendo que o documento é um modelo para as partes conferirem e assinarem, e que não é consultoria jurídica.')}`;
  }

  // ── Desenho e eventos ─────────────────────────────────────────────────────
  function render() {
    const root = document.getElementById('av-root');
    if (!root) return;
    const ativo = document.activeElement?.closest?.('#av-root [data-av]');
    const foco = ativo && { av: ativo.dataset.av, pos: ativo.selectionStart };
    const corpo = [passoVeiculo, () => passoPessoa('arrendador'), () => passoPessoa('arrendatario'), passoCondicoes, passoRevisao][av.passo - 1]();
    root.innerHTML = `
      <div class="flex gap-1 mb-3 overflow-x-auto">
        ${PASSOS.map((t, i) => `<button type="button" data-acao="ir" data-valor="${i + 1}" ${i + 1 > av.passo ? 'disabled' : ''}
          class="flex-1 min-w-[78px] text-xs font-semibold py-1.5 rounded ${i + 1 === av.passo ? 'bg-indigo-600 text-white' : i + 1 < av.passo ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-400'}">${i + 1}. ${t}</button>`).join('')}
      </div>
      <div class="space-y-3">${corpo}</div>
      <div class="flex justify-between mt-4">
        ${av.passo > 1 ? '<button type="button" data-acao="voltar" class="text-sm text-gray-600 hover:text-gray-800 px-3 py-2">← Voltar</button>' : '<span></span>'}
        ${av.passo < PASSOS.length ? '<button type="button" data-acao="avancar" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2 rounded">Próximo →</button>' : ''}
      </div>`;
    // O botão de enviar do formulário genérico só aparece na revisão.
    document.getElementById('query-submit')?.classList.toggle('hidden', av.passo < PASSOS.length);
    if (foco) {
      const el = root.querySelector(`[data-av="${foco.av}"]`);
      if (el) { el.focus(); try { if (foco.pos != null) el.setSelectionRange(foco.pos, foco.pos); } catch { /* select/checkbox */ } }
    }
  }
  const topo = () => window.scrollTo({ top: document.getElementById('av-root').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });

  function valorDoInput(el) {
    if (el.type === 'checkbox') return el.checked;
    let v = el.value;
    if (el.dataset.data) {
      const d = v.replace(/\D/g, '').slice(0, 8);
      v = d.replace(/^(\d{2})(\d{1,2})?(\d{1,4})?$/, (_, a, b, c) => [a, b, c].filter(Boolean).join('/'));
      el.value = v;
    }
    if (el.dataset.cep !== undefined) { v = v.replace(/\D/g, '').slice(0, 8); el.value = v; }
    if (el.dataset.placa) { v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7); el.value = v; }
    return v;
  }

  // ViaCEP: logradouro, bairro e cidade com acento. `manter` preserva o que a
  // busca do CPF já trouxe quando o ViaCEP vem sem logradouro (CEP de cidade).
  async function buscarCep(base, cep, manter = false) {
    try {
      const r = await fetch(`/api/cep/${cep}`);
      const d = await r.json();
      if (!r.ok) return;
      const e = getPath(base);
      if (d.logradouro || !manter) e.logradouro = d.logradouro || e.logradouro;
      if (d.bairro) e.bairro = d.bairro;
      if (d.cidade_nome) e.cidade = d.cidade_nome;
      if (d.uf) e.uf = d.uf;
      render();
      if (!manter) document.querySelector(`[data-av="${base}.numero"]`)?.focus();
    } catch { /* o cliente preenche à mão */ }
  }

  async function buscarPlaca() {
    const placa = docLimpo(av.veiculo.placa);
    if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) { av.buscaPlaca = { erro: 'Placa inválida.' }; render(); return; }
    const st = document.getElementById('av-placa-status');
    if (st) { st.className = 'text-xs text-gray-500'; st.textContent = '⏳ Buscando o veículo no Detran (pode levar até 1 minuto)…'; }
    try {
      const r = await fetch('/api/arrendamento-veicular/buscar-placa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placa }) });
      const d = await r.json();
      if (!r.ok) { av.buscaPlaca = { erro: d.error || 'Não foi possível buscar.' }; render(); return; }
      const km = av.veiculo.kmEntrega;
      av.veiculo = { ...av.veiculo, ...d.veiculo, kmEntrega: km };
      // O proprietário entra como arrendador, se o passo 2 ainda está vazio.
      const ar = av.arrendador;
      let aviso = '';
      if (d.veiculo.proprietarioDocumento && !docLimpo(ar.documento)) {
        ar.documento = d.veiculo.proprietarioDocumento;
        ar.tipo = d.veiculo.proprietarioDocumento.length === 14 ? 'PJ' : 'PF';
        ar.nome = d.veiculo.proprietarioNome;
        aviso = 'O proprietário já foi colocado como arrendador — no próximo passo, busque os dados dele.';
      }
      av.buscaPlaca = { ok: `✓ ${d.veiculo.marcaModelo || placa} encontrado. Confira os dados abaixo.`, aviso };
      render();
    } catch {
      av.buscaPlaca = { erro: 'Erro de conexão. Tente de novo ou preencha à mão.' }; render();
    }
  }

  async function buscarDocumento(papel) {
    const p = av[papel];
    const doc = docLimpo(p.documento);
    if (p.tipo === 'PF' ? !cpfOk(doc) : !cnpjOk(doc)) { av.buscaDoc[papel] = { erro: `${p.tipo === 'PF' ? 'CPF' : 'CNPJ'} inválido.` }; render(); return; }
    const st = document.getElementById(`av-doc-status-${papel}`);
    if (st) { st.className = 'text-xs text-gray-500'; st.textContent = '⏳ Buscando…'; }
    try {
      const r = await fetch('/api/arrendamento-veicular/buscar-documento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documento: doc }) });
      const d = await r.json();
      if (!r.ok) { av.buscaDoc[papel] = { erro: d.error || 'Não foi possível buscar.' }; render(); return; }
      p.nome = d.nome || p.nome;
      if (d.tipo === 'PF') p.genero = d.genero;
      if (d.endereco) p.endereco = { ...endVazio(), ...d.endereco, cep: dig(d.endereco.cep) };
      if (d.tipo === 'PJ') {
        p.representantes = d.representantes || [];
        if (p.representantes.length === 1 && !p.representante.nome) p.representante = { ...p.representante, nome: p.representantes[0].nome, qualidade: p.representantes[0].qualidade };
      }
      const alertas = [];
      if (d.falecido) alertas.push('ATENÇÃO: a base indica CPF de pessoa falecida.');
      if (d.situacao && !/regular|ativa/i.test(d.situacao)) alertas.push(`Situação na Receita: ${d.situacao}.`);
      av.buscaDoc[papel] = { ok: `✓ ${d.nome}. Confira e complete os dados${d.endereco ? ' — o endereço é o último que consta na base' : ''}.`, aviso: alertas.join(' ') };
      render();
      if (p.endereco.cep.length === 8) buscarCep(`${papel}.endereco`, p.endereco.cep, true);
    } catch {
      av.buscaDoc[papel] = { erro: 'Erro de conexão. Tente de novo ou preencha à mão.' }; render();
    }
  }

  function aoDigitar(ev) {
    const el = ev.target.closest('[data-av]');
    if (!el) return;
    const v = valorDoInput(el);
    setPath(el.dataset.av, v);
    if (el.dataset.cep !== undefined && v.length === 8 && ev.type === 'input') buscarCep(el.dataset.cep, v);
    // Só select e checkbox redesenham no change (ver contrato-social.js).
    if (el.dataset.redraw && ev.type === 'change' && el.tagName === 'SELECT') {
      // Trocar de periodicidade troca o significado do "dia do pagamento".
      if (el.dataset.av === 'condicoes.periodicidade') av.condicoes.diaPagamento = v === 'mensal' ? '10' : '1';
      render();
    }
  }

  function aoClicar(ev) {
    const b = ev.target.closest('[data-acao]');
    if (!b) return;
    const acao = b.dataset.acao, val = b.dataset.valor;
    if (b.tagName === 'BUTTON') ev.preventDefault();
    document.getElementById('form-error')?.classList.add('hidden');
    if (acao === 'buscar-placa') buscarPlaca();
    else if (acao === 'buscar-doc') buscarDocumento(val);
    else if (acao === 'usar-rep') { const p = av[val], r = p.representantes[Number(b.dataset.i)]; p.representante = { ...p.representante, nome: r.nome, qualidade: r.qualidade }; render(); }
    else if (acao === 'ir') { av.passo = Number(val); render(); }
    else if (acao === 'voltar') { av.passo--; render(); topo(); }
    else if (acao === 'avancar') {
      const erro = validarPasso(av.passo);
      if (erro) { showFormError(erro); return; }
      av.passo++; render(); topo();
    }
  }

  // ── Validação por etapa ───────────────────────────────────────────────────
  function erroEndereco(e, quem) {
    if (dig(e.cep).length !== 8) return `CEP ${quem} inválido.`;
    if (!e.logradouro || !e.numero || !e.bairro || !e.cidade || !e.uf) return `Endereço ${quem} incompleto.`;
    return null;
  }
  function erroPessoa(papel) {
    const p = av[papel], quem = papel === 'arrendador' ? 'do arrendador' : 'do arrendatário';
    const d = docLimpo(p.documento);
    if (p.tipo === 'PF' ? !cpfOk(d) : !cnpjOk(d)) return `${p.tipo === 'PF' ? 'CPF' : 'CNPJ'} ${quem} inválido.`;
    if (p.nome.trim().length < 5) return `Informe o nome completo ${quem}.`;
    if (p.tipo === 'PF') {
      if (!p.nacionalidade.trim()) return `Informe a nacionalidade ${quem}.`;
      if (!p.estadoCivil) return `Informe o estado civil ${quem}.`;
      if (!p.profissao.trim()) return `Informe a profissão ${quem}.`;
      if (papel === 'arrendatario' && dig(p.cnh).length !== 11) return 'Informe o nº de registro da CNH do arrendatário (11 dígitos).';
      if (papel === 'arrendatario' && !p.cnhCategoria) return 'Informe a categoria da CNH do arrendatário.';
    } else {
      const r = p.representante;
      if (r.nome.trim().length < 5 || !cpfOk(dig(r.cpf)) || !r.qualidade.trim()) return `Preencha nome, CPF e cargo de quem assina pela empresa ${papel === 'arrendador' ? 'arrendadora' : 'arrendatária'}.`;
    }
    return erroEndereco(p.endereco, quem);
  }
  function validarPasso(n) {
    const v = av.veiculo, c = av.condicoes;
    if (n === 1) {
      if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(docLimpo(v.placa))) return 'Placa inválida.';
      if (v.marcaModelo.trim().length < 3) return 'Informe a marca/modelo.';
      if (!/^\d{4}$/.test(v.anoFabricacao) || !/^\d{4}$/.test(v.anoModelo)) return 'Informe os anos de fabricação e modelo.';
      if (dig(v.renavam).length < 9) return 'Renavam inválido.';
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(docLimpo(v.chassi))) return 'Chassi inválido (17 caracteres).';
      if (!v.cor.trim()) return 'Informe a cor.';
      return null;
    }
    if (n === 2) return erroPessoa('arrendador');
    if (n === 3) {
      const e = erroPessoa('arrendatario'); if (e) return e;
      if (docLimpo(av.arrendador.documento) === docLimpo(av.arrendatario.documento)) return 'Arrendador e arrendatário não podem ser a mesma pessoa.';
      return null;
    }
    if (n === 4) {
      if (!dataBR(c.inicio)) return 'Informe a data de início (dd/mm/aaaa).';
      if (c.prazoTipo === 'determinado' && !(+dig(c.prazoMeses) >= 1 && +dig(c.prazoMeses) <= 60)) return 'Prazo de 1 a 60 meses.';
      if (!(centavos(c.valor) >= 1000)) return 'Informe o valor do aluguel.';
      if (c.periodicidade === 'mensal' && !(+dig(c.diaPagamento) >= 1 && +dig(c.diaPagamento) <= 28)) return 'Dia do pagamento de 1 a 28.';
      if (dig(c.kmLimite) && !(centavos(c.valorKmExcedente) > 0)) return 'Informe o valor por km excedente.';
      if (!c.foro) return 'Escolha o foro.';
      if (!av.cidadeAssinatura.trim()) return 'Informe a cidade onde vai assinar.';
      return null;
    }
    return null;
  }

  // ── Interface com o painel ────────────────────────────────────────────────
  window.avIniciar = function () {
    av = novoEstado();
    const root = document.getElementById('av-root');
    if (!root) return;
    root.addEventListener('input', aoDigitar);
    root.addEventListener('change', aoDigitar);
    root.addEventListener('click', aoClicar);
    root.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
      ev.preventDefault();
      if (ev.target.dataset.placa) buscarPlaca();
    });
    render();
  };

  // Corpo do /api/query: dinheiro em centavos, números como número.
  window.avParams = function () {
    if (!av) return {};
    const c = av.condicoes;
    const pessoaOut = p => ({
      tipo: p.tipo, nome: p.nome, documento: docLimpo(p.documento), genero: p.genero, nacionalidade: p.nacionalidade,
      estadoCivil: p.estadoCivil, profissao: p.profissao, rg: p.rg, orgaoRg: p.orgaoRg, cnh: dig(p.cnh), cnhCategoria: p.cnhCategoria,
      telefone: dig(p.telefone), email: p.email, endereco: { ...p.endereco, cep: dig(p.endereco.cep) },
      representante: { ...p.representante, cpf: dig(p.representante.cpf) },
    });
    const inteiro = s => parseInt(dig(s), 10);
    return {
      veiculo: { ...av.veiculo, placa: docLimpo(av.veiculo.placa), chassi: docLimpo(av.veiculo.chassi), kmEntrega: dig(av.veiculo.kmEntrega) },
      arrendador: pessoaOut(av.arrendador), arrendatario: pessoaOut(av.arrendatario),
      condicoes: {
        inicio: c.inicio, prazoTipo: c.prazoTipo, prazoMeses: inteiro(c.prazoMeses) || 0,
        valorCentavos: centavos(c.valor), periodicidade: c.periodicidade, diaPagamento: inteiro(c.diaPagamento),
        formaPagamento: c.formaPagamento, dadosPagamento: c.dadosPagamento,
        caucaoCentavos: centavos(c.caucao) || 0, kmLimite: inteiro(c.kmLimite) || 0, valorKmExcedenteCentavos: centavos(c.valorKmExcedente) || 0,
        uso: c.uso, circulacao: c.circulacao, seguro: c.seguro, franquiaCentavos: centavos(c.franquia) || 0,
        manutencao: c.manutencao, ipva: c.ipva, multaRescisoria: inteiro(c.multaRescisoria), avisoPrevio: inteiro(c.avisoPrevio) || 30,
        toleranciaAtraso: inteiro(c.toleranciaAtraso) || 5, condicoesParticulares: c.condicoesParticulares, foro: c.foro,
      },
      cidadeAssinatura: av.cidadeAssinatura,
      ciente: av.ciente,
    };
  };

  window.avValidar = function (p) {
    for (let n = 1; n <= 4; n++) {
      const erro = validarPasso(n);
      if (erro) { av.passo = n; render(); return erro; }
    }
    if (!p.ciente) return 'Marque a confirmação de que conferiu os dados.';
    return null;
  };
})();
