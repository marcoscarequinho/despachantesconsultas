// ── Contrato Social LTDA com IA — formulário em etapas (painel-usuario.html) ──
// O formulário guarda tudo num objeto (`cs`) em vez de ler campo a campo no
// envio: a lista de sócios é repetível e cada card muda de forma conforme o
// tipo (PF/PJ), o papel e a idade. Os inputs de texto só gravam no objeto (sem
// redesenhar, para não perder o foco); o que muda a forma do card redesenha.
// A validação daqui é só para o cliente corrigir sem ida ao servidor — a que
// vale é a do contrato-social.js.
(function () {
  const PASSOS = ['Tipo', 'Empresa', 'Sócios', 'Cláusulas', 'Revisão'];
  const ESTADOS_CIVIS = [['', '—'], ['solteiro', 'Solteiro(a)'], ['casado', 'Casado(a)'], ['divorciado', 'Divorciado(a)'], ['viuvo', 'Viúvo(a)'], ['separado', 'Separado(a) judicialmente']];
  const REGIMES = [['', '—'], ['comunhao_parcial', 'Comunhão parcial de bens'], ['comunhao_universal', 'Comunhão universal de bens'], ['separacao_total', 'Separação total (convencional)'], ['separacao_obrigatoria', 'Separação obrigatória'], ['participacao_aquestos', 'Participação final nos aquestos']];
  const ALTERACOES = [['nome', 'Nome empresarial'], ['endereco', 'Endereço da sede'], ['objeto', 'Objeto social / atividades'], ['capital', 'Aumento do capital'], ['socios', 'Entrada ou saída de sócios / cessão de quotas'], ['administracao', 'Administração'], ['clausulas', 'Outras cláusulas (só consolidar)']];
  const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

  let cs = null;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dig = s => String(s ?? '').replace(/\D/g, '');
  const docLimpo = s => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const endVazio = () => ({ logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', cep: '' });
  const repVazio = () => ({ nome: '', cpf: '', genero: 'M', nacionalidade: 'brasileira', estadoCivil: '', profissao: '', qualidade: '', endereco: '' });
  const pessoaVazia = (papel = 'socio') => ({
    papel, tipo: 'PF', nome: '', documento: '', genero: 'M', nacionalidade: 'brasileira', estadoCivil: '', regimeBens: '',
    uniaoEstavel: false, conjugeSocio: false, profissao: '', nascimento: '', emancipado: false, rg: '', orgaoRg: '',
    endereco: endVazio(), quotas: '', quotasAnteriores: '', administrador: papel === 'socio', ingressante: false,
    representante: repVazio(), papelReceita: '',
  });
  function novoEstado() {
    return {
      passo: 1, modo: 'constituicao', natureza: 'empresaria', buscado: null,
      empresa: { nome: '', usarCnpjComoNome: false, cnpj: '', nire: '', numeroAlteracao: '', inicioAtividades: '', endereco: endVazio(),
        cnaes: [], descricaoAtividades: '', capital: '', valorQuota: '1,00', integralizacao: 'ato', prazoIntegralizacao: '' },
      pessoas: [pessoaVazia()], cessoes: [], alteracoes: [],
      anterior: { nome: '', capital: '', endereco: endVazio() },
      clausulas: { administracao: 'isolada', proLabore: 'sim', lucros: 'proporcional', sucessao: 'herdeiros', cessao: 'preferencia', exclusaoJustaCausa: false, regencia: 'simples', foro: '' },
      cidadeAssinatura: '', ciente: false,
    };
  }

  // ── Dinheiro e datas ──────────────────────────────────────────────────────
  // "10.000,50" → 1000050 centavos; vazio/ruim → NaN.
  function centavos(s) {
    const t = String(s ?? '').trim().replace(/[R$\s]/g, '');
    if (!t) return NaN;
    const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }
  const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const centParaTxt = c => c > 0 ? (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  function dataBR(s) {
    const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null;
  }
  function idade(s) {
    const d = dataBR(s); if (!d) return null;
    const h = new Date(); let a = h.getFullYear() - d.getFullYear();
    if (h.getMonth() < d.getMonth() || (h.getMonth() === d.getMonth() && h.getDate() < d.getDate())) a--;
    return a;
  }
  const menor = p => p.tipo === 'PF' && !p.emancipado && idade(p.nascimento) !== null && idade(p.nascimento) < 18;
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
  const fmtCnae = c => c.length === 7 ? `${c.slice(0, 4)}-${c.slice(4, 5)}/${c.slice(5)}` : c;
  const socios = () => cs.pessoas.filter(p => p.papel === 'socio');
  // Sócio menor ou PJ não administra (o checkbox some, mas o valor ficaria).
  const ehAdministrador = p => p.papel === 'admin' || (p.papel === 'socio' && p.administrador && p.tipo === 'PF' && !menor(p));
  const totalQuotas = () => socios().reduce((t, p) => t + (parseInt(dig(p.quotas), 10) || 0), 0);
  const quotasDoCapital = () => { const c = centavos(cs.empresa.capital), v = centavos(cs.empresa.valorQuota); return c > 0 && v > 0 && c % v === 0 ? c / v : null; };

  // ── Acesso por caminho ("empresa.endereco.cep", "pessoas.2.nome") ─────────
  function setPath(caminho, valor) {
    const k = caminho.split('.');
    let o = cs;
    for (let i = 0; i < k.length - 1; i++) o = o[k[i]];
    o[k[k.length - 1]] = valor;
  }
  function getPath(caminho) { return caminho.split('.').reduce((o, k) => o?.[k], cs); }

  // ── Componentes ───────────────────────────────────────────────────────────
  // data-cs = caminho no estado; data-redraw = redesenha ao mudar.
  const inp = (caminho, label, { ph = '', req = false, extra = '', redraw = false, tipo = 'text', ajuda = '' } = {}) => `
    <div>
      <label class="label">${label}${req ? ' <span class="text-red-500">*</span>' : ''}</label>
      <input type="${tipo}" class="input-field" data-cs="${caminho}" ${redraw ? 'data-redraw="1"' : ''} value="${esc(getPath(caminho))}" placeholder="${esc(ph)}" ${extra}>
      ${ajuda ? `<div class="text-xs text-gray-500 mt-1">${ajuda}</div>` : ''}
    </div>`;
  const sel = (caminho, label, opcoes, { redraw = true, ajuda = '', req = false } = {}) => `
    <div>
      <label class="label">${label}${req ? ' <span class="text-red-500">*</span>' : ''}</label>
      <select class="input-field" data-cs="${caminho}" ${redraw ? 'data-redraw="1"' : ''}>
        ${opcoes.map(([v, t]) => `<option value="${esc(v)}" ${String(getPath(caminho)) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      ${ajuda ? `<div class="text-xs text-gray-500 mt-1">${ajuda}</div>` : ''}
    </div>`;
  const chk = (caminho, texto, { redraw = true } = {}) => `
    <label class="flex items-start gap-2 text-sm text-gray-700">
      <input type="checkbox" class="mt-1" data-cs="${caminho}" ${redraw ? 'data-redraw="1"' : ''} ${getPath(caminho) ? 'checked' : ''}>
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
        ${inp(`${base}.complemento`, 'Complemento', { ph: 'Sala, apto…' })}
        ${inp(`${base}.bairro`, 'Bairro', { req: true })}
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2">${inp(`${base}.cidade`, 'Cidade', { req: true, redraw: false })}</div>
        ${sel(`${base}.uf`, 'UF', [['', '—'], ...UFS.map(u => [u, u])], { req: true, redraw: false })}
      </div>
    </div>`;

  // ── Etapas ────────────────────────────────────────────────────────────────
  function passoTipo() {
    const b = cs.buscado;
    const card = (modo, icone, titulo, texto) => `
      <button type="button" data-acao="modo" data-valor="${modo}"
        class="text-left border-2 rounded-xl p-4 transition-all ${cs.modo === modo ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300'}">
        <div class="text-2xl mb-1">${icone}</div>
        <div class="font-bold text-gray-800 text-sm">${titulo}</div>
        <div class="text-xs text-gray-600 mt-1">${texto}</div>
      </button>`;
    return `
      <div class="grid sm:grid-cols-2 gap-3">
        ${card('constituicao', '🆕', 'Constituição', 'Empresa nova: contrato social (ou ato constitutivo, se for um sócio só). Começa em branco.')}
        ${card('alteracao', '✏️', 'Alteração e consolidação', 'Empresa que já existe: muda o que for preciso e consolida o contrato. O CNPJ preenche os dados.')}
      </div>
      ${cs.modo === 'alteracao' ? `
        <div class="bg-indigo-50 border border-indigo-200 rounded-lg p-3 space-y-2">
          <p class="text-xs text-indigo-800">Informe o CNPJ e busque na Receita: preenchemos nome, endereço, CNAEs, capital e o quadro de sócios. A Receita não informa o CPF completo dos sócios nem as quotas — esses você completa. A busca é grátis (até 10 por dia).</p>
          <div class="flex gap-2 items-end">
            <div class="flex-1">${inp('empresa.cnpj', 'CNPJ da empresa', { req: true, ph: '00.000.000/0001-00', extra: 'maxlength="18"' })}</div>
            <button type="button" data-acao="buscar-cnpj" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-2.5 rounded">🔎 Buscar na Receita</button>
          </div>
          <div id="cs-busca-status" class="text-xs ${b?.erro ? 'text-red-600' : 'text-green-700'}">${b ? esc(b.erro || b.ok) : ''}</div>
        </div>` : ''}
      ${sel('natureza', 'Tipo de sociedade', [['empresaria', 'Sociedade empresária limitada — registro na Junta Comercial'], ['simples', 'Sociedade simples limitada — registro em Cartório (RCPJ)']],
        { ajuda: 'Na dúvida, é empresária: comércio, indústria e a maioria dos serviços. Simples é a de profissão intelectual (ex.: sociedade de médicos, engenheiros).' })}`;
  }

  function passoEmpresa() {
    const e = cs.empresa, alt = cs.modo === 'alteracao';
    const qc = quotasDoCapital();
    const cnaes = e.cnaes.map((c, i) => `
      <div class="flex items-start gap-2 border border-gray-200 rounded p-2">
        <label class="flex items-center gap-1 text-xs text-gray-600 pt-0.5 whitespace-nowrap" title="Atividade principal">
          <input type="radio" name="cs-cnae-principal" data-acao="cnae-principal" data-i="${i}" ${c.principal ? 'checked' : ''}> principal
        </label>
        <div class="flex-1 text-xs"><span class="font-mono font-semibold">${fmtCnae(c.codigo)}</span> — ${esc(c.descricao || '…')}</div>
        <button type="button" data-acao="cnae-remover" data-i="${i}" class="text-red-500 text-xs">✕</button>
      </div>`).join('');
    const marcadas = new Set(cs.alteracoes);
    return `
      ${alt ? `
        <div class="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2">
          <div class="text-sm font-semibold text-amber-900">O que está sendo alterado? <span class="text-red-500">*</span></div>
          <div class="grid sm:grid-cols-2 gap-1">${ALTERACOES.map(([v, t]) => `
            <label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-acao="alteracao" data-valor="${v}" ${marcadas.has(v) ? 'checked' : ''}> ${t}</label>`).join('')}</div>
          <p class="text-xs text-amber-800">Abaixo, preencha a empresa <strong>como fica depois</strong> da alteração. Redução de capital não é feita aqui.</p>
          ${marcadas.has('nome') ? inp('anterior.nome', 'Nome empresarial anterior', { req: true }) : ''}
          ${marcadas.has('capital') ? inp('anterior.capital', 'Capital social anterior (R$)', { req: true, ph: '10.000,00', extra: 'inputmode="decimal"' }) : ''}
          ${marcadas.has('endereco') ? blocoEndereco('anterior.endereco', 'Endereço anterior da sede') : ''}
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          ${inp('empresa.nire', 'NIRE (opcional)', { ph: 'Nº na Junta' })}
          ${inp('empresa.numeroAlteracao', 'Nº desta alteração', { ph: 'Ex.: 3', extra: 'inputmode="numeric" maxlength="3"', ajuda: 'Sai como "3ª Alteração".' })}
          ${inp('empresa.inicioAtividades', 'Início das atividades', { ph: 'dd/mm/aaaa', extra: 'data-data="1" maxlength="10" inputmode="numeric"' })}
        </div>` : ''}
      ${!alt ? chk('empresa.usarCnpjComoNome', 'Usar o número do CNPJ como nome empresarial (sem precisar inventar um nome)') : ''}
      ${e.usarCnpjComoNome && !alt ? '' : inp('empresa.nome', 'Nome empresarial', { req: true, ph: 'EXEMPLO COMÉRCIO DE PEÇAS LTDA', ajuda: 'Termina com LTDA ou LIMITADA.' })}
      ${blocoEndereco('empresa.endereco', 'Endereço da sede')}

      <div class="border border-gray-200 rounded-lg p-3 space-y-2">
        <div class="text-xs font-semibold text-gray-600">Atividades (CNAE) — a IA redige o objeto social a partir delas</div>
        ${cnaes || '<div class="text-xs text-gray-400">Nenhum CNAE ainda.</div>'}
        <div class="flex gap-2 items-end">
          <div class="flex-1"><label class="label flex items-center justify-between gap-2">Código CNAE <a href="https://cnae.ibge.gov.br/?option=com_cnae&view=atividades&Itemid=6160&tipo=cnae&chave=Consultoria&versao_classe=7.0.0&versao_subclasse=10.1.0" target="_blank" rel="noopener" class="text-xs font-normal text-indigo-600 hover:underline">🔎 Buscar CNAE no IBGE</a></label><input id="cs-cnae-novo" class="input-field" placeholder="4520-0/01" maxlength="10" inputmode="numeric"></div>
          <button type="button" data-acao="cnae-add" class="bg-gray-700 hover:bg-gray-800 text-white text-xs font-semibold px-3 py-2.5 rounded">+ Adicionar</button>
        </div>
        <div id="cs-cnae-status" class="text-xs text-gray-500"></div>
        <div>
          <label class="label">Descreva as atividades com suas palavras (opcional)</label>
          <textarea class="input-field" rows="3" maxlength="2000" data-cs="empresa.descricaoAtividades" placeholder="Ex.: venda de peças para carros e oficina mecânica">${esc(e.descricaoAtividades)}</textarea>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        ${inp('empresa.capital', 'Capital social (R$)', { req: true, ph: '10.000,00', extra: 'inputmode="decimal" data-capital="1"' })}
        ${inp('empresa.valorQuota', 'Valor de cada quota (R$)', { req: true, ph: '1,00', extra: 'inputmode="decimal" data-capital="1"' })}
      </div>
      <div id="cs-quotas-info" class="text-xs ${qc ? 'text-gray-600' : 'text-amber-700'}">${qc ? `= ${qc.toLocaleString('pt-BR')} quotas de ${brl(centavos(e.valorQuota))}` : 'O capital precisa se dividir em quotas inteiras.'}</div>
      ${sel('empresa.integralizacao', 'Integralização do capital (em dinheiro)', [['ato', alt ? 'Já integralizado / integralizado neste ato' : 'Integralizado agora, na assinatura'], ['prazo', 'A integralizar até uma data']])}
      ${e.integralizacao === 'prazo' ? inp('empresa.prazoIntegralizacao', 'Integralizar até', { req: true, ph: 'dd/mm/aaaa', extra: 'data-data="1" maxlength="10" inputmode="numeric"' }) : ''}
      <p class="text-xs text-gray-500">Integralização em bens (imóvel, veículo) precisa de avaliação e não é feita por este serviço.</p>`;
  }

  function cardPessoa(p, i) {
    const alt = cs.modo === 'alteracao';
    const b = `pessoas.${i}`;
    const ehMenor = menor(p);
    const precisaRep = p.tipo === 'PJ' || ehMenor;
    const papeis = [['socio', 'Sócio(a)'], ['admin', 'Administrador(a) não sócio(a)']];
    if (alt) papeis.push(['retirante', 'Sócio(a) que está saindo']);
    const titulo = p.papel === 'admin' ? 'Administrador(a) não sócio(a)' : p.papel === 'retirante' ? 'Sócio(a) que sai' : 'Sócio(a)';
    const tq = totalQuotas();
    const q = parseInt(dig(p.quotas), 10) || 0;
    return `
      <div class="border-2 ${p.papel === 'retirante' ? 'border-red-200' : p.papel === 'admin' ? 'border-sky-200' : 'border-gray-200'} rounded-xl p-3 space-y-3">
        <div class="flex items-center justify-between">
          <div class="font-semibold text-sm text-gray-800">${i + 1}. ${titulo}${p.nome ? ` — ${esc(p.nome)}` : ''}</div>
          ${cs.pessoas.length > 1 ? `<button type="button" data-acao="pessoa-remover" data-i="${i}" class="text-red-500 text-xs font-semibold">Remover</button>` : ''}
        </div>
        ${p.papelReceita ? `<div class="text-xs text-indigo-700">Na Receita: ${esc(p.papelReceita)}</div>` : ''}
        <div class="grid grid-cols-2 gap-3">
          ${sel(`${b}.papel`, 'Papel', papeis)}
          ${p.papel === 'admin' ? '<div></div>' : sel(`${b}.tipo`, 'Pessoa', [['PF', 'Física (CPF)'], ['PJ', 'Jurídica (CNPJ)']])}
        </div>
        <div class="grid sm:grid-cols-2 gap-3">
          ${inp(`${b}.nome`, p.tipo === 'PJ' ? 'Razão social' : 'Nome completo', { req: true })}
          ${inp(`${b}.documento`, p.tipo === 'PJ' ? 'CNPJ' : 'CPF', { req: true, extra: `maxlength="18" data-doc="1"`, ajuda: p.papelReceita && p.tipo === 'PF' ? 'A Receita não informa o CPF completo: digite.' : '' })}
        </div>
        ${p.tipo === 'PF' ? `
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            ${sel(`${b}.genero`, 'Tratamento', [['M', 'Masculino'], ['F', 'Feminino']], { redraw: false })}
            ${inp(`${b}.nacionalidade`, 'Nacionalidade', { req: true, ph: 'brasileira' })}
            ${inp(`${b}.nascimento`, 'Nascimento', { req: true, ph: 'dd/mm/aaaa', extra: 'data-data="1" data-nasc="1" maxlength="10" inputmode="numeric"' })}
          </div>
          <div class="grid grid-cols-2 gap-3">
            ${sel(`${b}.estadoCivil`, 'Estado civil', ESTADOS_CIVIS, { req: true })}
            ${p.estadoCivil === 'casado' ? sel(`${b}.regimeBens`, 'Regime de bens', REGIMES, { req: true }) : inp(`${b}.profissao`, 'Profissão', { req: true, ph: 'empresário' })}
          </div>
          ${p.estadoCivil === 'casado' ? inp(`${b}.profissao`, 'Profissão', { req: true, ph: 'empresário' }) : ''}
          <div class="grid grid-cols-2 gap-3">
            ${inp(`${b}.rg`, 'RG (opcional)')}
            ${inp(`${b}.orgaoRg`, 'Órgão emissor', { ph: 'DETRAN/RJ' })}
          </div>
          <div class="flex flex-wrap gap-x-5 gap-y-1">
            ${p.estadoCivil !== 'casado' ? chk(`${b}.uniaoEstavel`, 'Vive em união estável', { redraw: false }) : ''}
            ${p.estadoCivil === 'casado' && p.papel === 'socio' && socios().length > 1 ? chk(`${b}.conjugeSocio`, 'É casado(a) com outro sócio desta empresa', { redraw: false }) : ''}
            ${idade(p.nascimento) !== null && idade(p.nascimento) < 18 ? chk(`${b}.emancipado`, 'É emancipado(a)') : ''}
          </div>` : ''}
        ${blocoEndereco(`${b}.endereco`, p.tipo === 'PJ' ? 'Sede' : 'Endereço residencial')}
        ${p.papel === 'socio' ? `
          <div class="grid grid-cols-2 gap-3 items-end">
            ${inp(`${b}.quotas`, 'Quotas', { req: true, ph: '5000', extra: 'inputmode="numeric" data-quotas="1"' })}
            <div class="text-xs text-gray-600 pb-2" data-pct="${i}">${tq && q ? `${(q * 100 / tq).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% das quotas informadas` : ''}</div>
          </div>
          <div class="flex flex-wrap gap-x-5 gap-y-1">
            ${p.tipo === 'PF' && !ehMenor ? chk(`${b}.administrador`, 'É administrador(a)', { redraw: false }) : ''}
            ${alt ? chk(`${b}.ingressante`, 'Está entrando na sociedade agora', { redraw: false }) : ''}
          </div>` : ''}
        ${p.papel === 'retirante' ? inp(`${b}.quotasAnteriores`, 'Quotas que tinha', { req: true, extra: 'inputmode="numeric"', ajuda: 'Todas precisam ser cedidas na seção "Cessões de quotas".' }) : ''}
        ${ehMenor ? `<div class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">Menor de idade: entra ${idade(p.nascimento) >= 16 ? 'assistido(a)' : 'representado(a)'} pelo pai, mãe ou tutor(a), não pode ser administrador(a) e o capital tem de estar integralizado (Código Civil, art. 974, § 3º).</div>` : ''}
        ${precisaRep ? `
          <div class="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
            <div class="text-xs font-semibold text-gray-600">${p.tipo === 'PJ' ? 'Quem representa a empresa (assina por ela)' : idade(p.nascimento) >= 16 ? 'Quem assiste o(a) menor' : 'Quem representa o(a) menor'}</div>
            <div class="grid sm:grid-cols-2 gap-3">
              ${inp(`${b}.representante.nome`, 'Nome completo', { req: true })}
              ${inp(`${b}.representante.cpf`, 'CPF', { req: true, extra: 'maxlength="14" data-doc="1"' })}
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
              ${p.tipo === 'PJ' ? inp(`${b}.representante.qualidade`, 'Cargo', { req: true, ph: 'administrador' }) : sel(`${b}.representante.qualidade`, 'É', [['', '—'], ['pai', 'Pai'], ['mae', 'Mãe'], ['tutor', 'Tutor(a)']], { redraw: false, req: true })}
              ${sel(`${b}.representante.genero`, 'Tratamento', [['M', 'Masculino'], ['F', 'Feminino']], { redraw: false })}
              ${sel(`${b}.representante.estadoCivil`, 'Estado civil', ESTADOS_CIVIS, { redraw: false, req: true })}
            </div>
            <div class="grid sm:grid-cols-2 gap-3">
              ${inp(`${b}.representante.profissao`, 'Profissão', { req: true })}
              ${inp(`${b}.representante.endereco`, 'Endereço (opcional)', { ph: 'Rua, nº, bairro, cidade/UF, CEP' })}
            </div>
          </div>` : ''}
      </div>`;
  }

  function passoSocios() {
    const alt = cs.modo === 'alteracao';
    const qc = quotasDoCapital();
    const tq = totalQuotas();
    const bate = qc && tq === qc;
    const opcoesPessoa = filtro => cs.pessoas.map((p, i) => [p, i]).filter(([p]) => filtro(p)).map(([p, i]) => [String(i), `${i + 1}. ${p.nome || '(sem nome)'}`]);
    return `
      <div class="text-xs ${bate ? 'text-green-700 bg-green-50 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-200'} border rounded p-2" id="cs-soma">
        ${somaTxt()}
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" data-acao="dividir" class="text-xs border border-gray-300 rounded px-2 py-1 hover:bg-gray-50">Dividir as quotas igualmente</button>
      </div>
      ${cs.pessoas.map(cardPessoa).join('')}
      <div class="flex flex-wrap gap-2">
        <button type="button" data-acao="pessoa-add" data-valor="socio" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-2 rounded">+ Adicionar sócio</button>
        <button type="button" data-acao="pessoa-add" data-valor="admin" class="border border-sky-400 text-sky-700 text-xs font-semibold px-3 py-2 rounded hover:bg-sky-50">+ Administrador não sócio</button>
        ${alt ? `<button type="button" data-acao="pessoa-add" data-valor="retirante" class="border border-red-300 text-red-600 text-xs font-semibold px-3 py-2 rounded hover:bg-red-50">+ Sócio que está saindo</button>` : ''}
      </div>
      ${alt ? `
        <div class="border border-gray-200 rounded-lg p-3 space-y-2">
          <div class="text-sm font-semibold text-gray-700">Cessões de quotas</div>
          <p class="text-xs text-gray-500">Quem sai precisa ceder todas as quotas que tinha. Também serve para a venda de quotas entre sócios.</p>
          ${cs.cessoes.map((c, k) => `
            <div class="grid grid-cols-7 gap-2 items-end">
              <div class="col-span-3">${sel(`cessoes.${k}.cedente`, 'Quem cede', [['', '—'], ...opcoesPessoa(p => p.papel !== 'admin')], { redraw: false })}</div>
              <div class="col-span-2">${sel(`cessoes.${k}.cessionario`, 'Para', [['', '—'], ...opcoesPessoa(p => p.papel === 'socio')], { redraw: false })}</div>
              <div>${inp(`cessoes.${k}.quotas`, 'Quotas', { extra: 'inputmode="numeric"' })}</div>
              <button type="button" data-acao="cessao-remover" data-i="${k}" class="text-red-500 text-xs pb-3">✕</button>
            </div>`).join('')}
          <button type="button" data-acao="cessao-add" class="text-xs border border-gray-300 rounded px-2 py-1 hover:bg-gray-50">+ Cessão</button>
        </div>` : ''}`;
  }
  function somaTxt() {
    const qc = quotasDoCapital(), tq = totalQuotas();
    if (!qc) return 'Defina o capital e o valor da quota na etapa Empresa.';
    if (tq === qc) return `✓ ${tq.toLocaleString('pt-BR')} quotas distribuídas = capital de ${brl(centavos(cs.empresa.capital))}.`;
    return `Soma das quotas dos sócios: ${tq.toLocaleString('pt-BR')} de ${qc.toLocaleString('pt-BR')} (${tq > qc ? 'sobram ' + (tq - qc).toLocaleString('pt-BR') : 'faltam ' + (qc - tq).toLocaleString('pt-BR')}).`;
  }

  function passoClausulas() {
    const n = socios().length;
    const admins = cs.pessoas.filter(ehAdministrador).length;
    const cidades = [];
    const addCidade = e => { if (e.cidade && e.uf && !cidades.some(([v]) => v === `${e.cidade}/${e.uf}`)) cidades.push([`${e.cidade}/${e.uf}`, `${e.cidade}/${e.uf}`]); };
    addCidade(cs.empresa.endereco); cs.pessoas.forEach(p => addCidade(p.endereco));
    if (!cs.clausulas.foro || !cidades.some(([v]) => v === cs.clausulas.foro)) cs.clausulas.foro = cidades[0]?.[0] || '';
    if (!cs.cidadeAssinatura) cs.cidadeAssinatura = cs.empresa.endereco.cidade;
    return `
      <p class="text-xs text-gray-500">Uma opção por cláusula. O texto de cada uma é fixo e segue o Código Civil — a IA não mexe nelas.</p>
      ${admins > 1 ? sel('clausulas.administracao', 'Administração', [['isolada', 'Cada administrador assina sozinho (isoladamente)'], ['conjunta', 'Sempre dois administradores juntos (em conjunto)']], { redraw: false }) : ''}
      ${sel('clausulas.proLabore', 'Pró-labore', [['sim', 'Administradores recebem retirada mensal (pró-labore)'], ['nao', 'Sem pró-labore']], { redraw: false })}
      ${n > 1 ? sel('clausulas.lucros', 'Distribuição de lucros', [['proporcional', 'Na proporção das quotas'], ['deliberacao', 'Pode ser desproporcional, por deliberação da maioria do capital']], { redraw: false }) : ''}
      ${n > 1 ? sel('clausulas.cessao', 'Venda de quotas a terceiros', [['preferencia', 'Depende dos demais sócios, com direito de preferência'], ['legal', 'Regra do Código Civil (livre, salvo oposição de mais de 1/4 do capital)']], { redraw: false }) : ''}
      ${n > 1 ? sel('clausulas.sucessao', 'Falecimento de sócio', [['herdeiros', 'Herdeiros entram na sociedade'], ['liquidacao', 'A quota é liquidada e paga aos herdeiros'], ['remanescentes', 'Os sócios que ficam decidem']], { redraw: false }) : '<div class="text-xs text-gray-500">Falecimento do sócio único: a sociedade continua com os herdeiros.</div>'}
      ${n > 1 ? chk('clausulas.exclusaoJustaCausa', 'Permitir excluir sócio por justa causa (Código Civil, art. 1.085)', { redraw: false }) : ''}
      ${sel('clausulas.regencia', 'Nas omissões do contrato', [['simples', 'Normas da sociedade simples (padrão)'], ['sa', 'Normas da sociedade anônima']], { redraw: false })}
      ${sel('clausulas.foro', 'Foro', cidades.length ? cidades : [['', 'Preencha os endereços']], { redraw: false, ajuda: 'Só a cidade da sede ou do domicílio de um sócio (o foro precisa ter ligação com as partes).' })}
      ${inp('cidadeAssinatura', 'Cidade onde vai assinar', { req: true })}`;
  }

  function passoRevisao() {
    const e = cs.empresa;
    const lin = (k, v) => v ? `<div class="flex gap-2 text-sm"><span class="text-gray-500 w-36 flex-shrink-0">${k}</span><span class="text-gray-800">${v}</span></div>` : '';
    const ss = socios();
    const unip = ss.length === 1;
    return `
      <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1">
        ${lin('Documento', cs.modo === 'alteracao' ? `Alteração e consolidação${unip ? ' do ato constitutivo' : ''}` : unip ? 'Ato constitutivo de limitada unipessoal' : 'Contrato social de constituição')}
        ${lin('Empresa', esc(e.usarCnpjComoNome ? '(número do CNPJ) LTDA' : e.nome))}
        ${lin('Sede', esc([e.endereco.logradouro, e.endereco.numero, e.endereco.bairro, `${e.endereco.cidade}/${e.endereco.uf}`].filter(Boolean).join(', ')))}
        ${lin('Capital', `${brl(centavos(e.capital))} em ${(quotasDoCapital() || 0).toLocaleString('pt-BR')} quotas`)}
        ${lin('CNAEs', e.cnaes.map(c => fmtCnae(c.codigo) + (c.principal ? ' (principal)' : '')).join(', ') || '—')}
        ${cs.modo === 'alteracao' ? lin('Alterações', cs.alteracoes.map(a => ALTERACOES.find(x => x[0] === a)?.[1]).join('; ')) : ''}
      </div>
      <div class="space-y-1">
        ${cs.pessoas.map(p => `<div class="text-sm border-b border-gray-100 py-1"><strong>${esc(p.nome || '(sem nome)')}</strong> — ${p.papel === 'admin' ? 'administrador(a) não sócio(a)' : p.papel === 'retirante' ? 'sai da sociedade' : `${(parseInt(dig(p.quotas), 10) || 0).toLocaleString('pt-BR')} quotas${p.administrador ? ', administrador(a)' : ''}${p.ingressante ? ', ingressante' : ''}`}</div>`).join('')}
      </div>
      <div class="text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded p-2">A IA vai redigir só o objeto social (as atividades), a partir dos CNAEs e da sua descrição. Todo o resto do texto é fixo. Leva cerca de 1 minuto.</div>
      ${chk('ciente', 'Conferi os dados. Entendo que o documento é um modelo para os sócios conferirem, assinarem e registrarem, e que o órgão de registro pode pedir ajustes.', { redraw: false })}`;
  }

  // ── Desenho e eventos ─────────────────────────────────────────────────────
  function render() {
    const root = document.getElementById('cs-root');
    if (!root) return;
    // Administrador não sócio é sempre pessoa física (CC, art. 997, VI).
    cs.pessoas.forEach(p => { if (p.papel === 'admin') p.tipo = 'PF'; });
    // Redesenho no meio da digitação (ex.: a data de nascimento revelou um
    // menor) devolve o foco e o cursor ao mesmo campo.
    const ativo = document.activeElement?.closest?.('#cs-root [data-cs]');
    const foco = ativo && { cs: ativo.dataset.cs, pos: ativo.selectionStart };
    const corpo = [passoTipo, passoEmpresa, passoSocios, passoClausulas, passoRevisao][cs.passo - 1]();
    root.innerHTML = `
      <div class="flex gap-1 mb-3 overflow-x-auto">
        ${PASSOS.map((t, i) => `<button type="button" data-acao="ir" data-valor="${i + 1}" ${i + 1 > cs.passo ? 'disabled' : ''}
          class="flex-1 min-w-[70px] text-xs font-semibold py-1.5 rounded ${i + 1 === cs.passo ? 'bg-indigo-600 text-white' : i + 1 < cs.passo ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-400'}">${i + 1}. ${t}</button>`).join('')}
      </div>
      <div class="space-y-3">${corpo}</div>
      <div class="flex justify-between mt-4">
        ${cs.passo > 1 ? '<button type="button" data-acao="voltar" class="text-sm text-gray-600 hover:text-gray-800 px-3 py-2">← Voltar</button>' : '<span></span>'}
        ${cs.passo < PASSOS.length ? '<button type="button" data-acao="avancar" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2 rounded">Próximo →</button>' : ''}
      </div>`;
    // O botão de enviar do formulário genérico só aparece na revisão.
    document.getElementById('query-submit')?.classList.toggle('hidden', cs.passo < PASSOS.length);
    if (foco) {
      const el = root.querySelector(`[data-cs="${foco.cs}"]`);
      if (el) { el.focus(); try { if (foco.pos != null) el.setSelectionRange(foco.pos, foco.pos); } catch { /* select/checkbox */ } }
    }
  }

  function valorDoInput(el) {
    if (el.type === 'checkbox') return el.checked;
    let v = el.value;
    if (el.dataset.data) {
      const d = v.replace(/\D/g, '').slice(0, 8);
      v = d.replace(/^(\d{2})(\d{1,2})?(\d{1,4})?$/, (_, a, b, c) => [a, b, c].filter(Boolean).join('/'));
      el.value = v;
    }
    if (el.dataset.cep !== undefined) { v = v.replace(/\D/g, '').slice(0, 8); el.value = v; }
    if (el.dataset.quotas) { v = v.replace(/\D/g, ''); el.value = v; }
    return v;
  }

  async function buscarCep(base, cep) {
    try {
      const r = await fetch(`/api/cep/${cep}`);
      const d = await r.json();
      if (!r.ok) return;
      const e = getPath(base);
      if (d.logradouro) e.logradouro = d.logradouro;
      if (d.bairro) e.bairro = d.bairro;
      if (d.cidade_nome) e.cidade = d.cidade_nome;
      if (d.uf) e.uf = d.uf;
      render();
      document.querySelector(`[data-cs="${base}.numero"]`)?.focus();
    } catch { /* o cliente preenche à mão */ }
  }

  async function buscarCnpj() {
    const cnpj = docLimpo(cs.empresa.cnpj);
    if (!cnpjOk(cnpj)) { cs.buscado = { erro: 'CNPJ inválido.' }; render(); return; }
    const st = document.getElementById('cs-busca-status');
    if (st) { st.className = 'text-xs text-gray-500'; st.textContent = '⏳ Buscando na Receita…'; }
    try {
      const r = await fetch('/api/contrato-social/buscar-cnpj', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cnpj }) });
      const d = await r.json();
      if (!r.ok) { cs.buscado = { erro: d.error || 'Não foi possível buscar.' }; render(); return; }
      const e = cs.empresa;
      e.cnpj = d.cnpj; e.nome = d.nome; e.inicioAtividades = d.inicioAtividades || '';
      e.endereco = { ...endVazio(), ...d.endereco, cep: dig(d.endereco.cep) };
      e.cnaes = d.cnaes.map(c => ({ codigo: c.codigo, descricao: c.descricao, principal: c.principal }));
      e.capital = centParaTxt(d.capitalCentavos);
      cs.anterior = { nome: d.nome, capital: centParaTxt(d.capitalCentavos), endereco: { ...e.endereco } };
      if (d.natureza) cs.natureza = d.natureza;
      const pessoas = d.pessoas.filter(p => !p.exterior).map(p => ({ ...pessoaVazia(p.papel), nome: p.nome, tipo: p.tipo, documento: p.documento, administrador: p.administrador && p.tipo === 'PF', papelReceita: p.papelReceita }));
      if (pessoas.length) cs.pessoas = pessoas;
      const exterior = d.pessoas.filter(p => p.exterior).length;
      cs.buscado = {
        ok: `✓ ${d.nome} — ${d.situacao}. ${d.pessoas.length} pessoa(s) no quadro da Receita.`
          + (d.ehLimitada ? '' : ` ATENÇÃO: a natureza jurídica é "${d.naturezaTexto}", não é sociedade limitada — este serviço é só para LTDA.`)
          + (exterior ? ` ${exterior} sócio(s) domiciliado(s) no exterior não foram trazidos: esse caso não é feito aqui.` : '')
          + (d.capitalCentavos ? '' : ' A Receita não informou o capital: digite na próxima etapa.'),
      };
      render();
    } catch {
      cs.buscado = { erro: 'Erro de conexão. Tente de novo ou preencha à mão.' }; render();
    }
  }

  async function adicionarCnae() {
    const el = document.getElementById('cs-cnae-novo');
    const st = document.getElementById('cs-cnae-status');
    const codigo = dig(el?.value);
    if (codigo.length !== 7) { st.className = 'text-xs text-red-600'; st.textContent = 'Use os 7 dígitos da subclasse (ex.: 4520-0/01).'; return; }
    if (cs.empresa.cnaes.some(c => c.codigo === codigo)) { st.className = 'text-xs text-amber-700'; st.textContent = 'Esse CNAE já está na lista.'; return; }
    st.className = 'text-xs text-gray-500'; st.textContent = '⏳ Conferindo no IBGE…';
    try {
      const r = await fetch(`/api/contrato-social/cnae/${codigo}`);
      const d = await r.json();
      if (!r.ok) { st.className = 'text-xs text-red-600'; st.textContent = d.error; return; }
      cs.empresa.cnaes.push({ codigo, descricao: d.descricao, principal: !cs.empresa.cnaes.length });
      render();
    } catch { st.className = 'text-xs text-red-600'; st.textContent = 'Erro de conexão.'; }
  }

  function aoDigitar(ev) {
    const el = ev.target.closest('[data-cs]');
    if (!el) return;
    const caminho = el.dataset.cs;
    // Campo de nascimento: o card muda de forma quando a pessoa é menor
    // (representante, emancipação) — redesenha só quando isso vira.
    const eraMenor = el.dataset.nasc ? menorOuQuase(getPath(caminho.replace(/\.nascimento$/, ''))) : null;
    const v = valorDoInput(el);
    setPath(caminho, v);
    if (el.dataset.nasc && ev.type === 'input' && menorOuQuase(getPath(caminho.replace(/\.nascimento$/, ''))) !== eraMenor) { render(); return; }
    if (el.dataset.capital) {
      const info = document.getElementById('cs-quotas-info');
      const qc = quotasDoCapital();
      if (info) {
        info.className = `text-xs ${qc ? 'text-gray-600' : 'text-amber-700'}`;
        info.textContent = qc ? `= ${qc.toLocaleString('pt-BR')} quotas de ${brl(centavos(cs.empresa.valorQuota))}` : 'O capital precisa se dividir em quotas inteiras.';
      }
    }
    if (el.dataset.cep !== undefined && v.length === 8 && ev.type === 'input') buscarCep(el.dataset.cep, v);
    if (el.dataset.quotas) {
      const s = document.getElementById('cs-soma'); if (s) s.textContent = somaTxt();
      const tq = totalQuotas();
      cs.pessoas.forEach((p, i) => {
        const alvo = document.querySelector(`[data-pct="${i}"]`);
        const q = parseInt(dig(p.quotas), 10) || 0;
        if (alvo) alvo.textContent = tq && q ? `${(q * 100 / tq).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% das quotas informadas` : '';
      });
    }
    // Só select e checkbox redesenham no change: texto redesenhando no blur
    // recriaria o botão que o cliente acabou de clicar, e o clique se perderia.
    if (el.dataset.redraw && ev.type === 'change' && (el.tagName === 'SELECT' || el.type === 'checkbox')) render();
  }
  // "menor" | "16-17" | "adulto" — muda o card quando muda de faixa.
  function menorOuQuase(p) {
    if (!p || p.tipo !== 'PF') return 'n/a';
    const a = idade(p.nascimento);
    return a === null ? 'n/a' : a >= 18 ? 'adulto' : a >= 16 ? '16-17' : 'menor';
  }

  function aoClicar(ev) {
    const b = ev.target.closest('[data-acao]');
    if (!b) return;
    const acao = b.dataset.acao, i = Number(b.dataset.i), val = b.dataset.valor;
    if (b.tagName === 'BUTTON') ev.preventDefault();
    document.getElementById('form-error')?.classList.add('hidden');
    if (acao === 'modo') { cs.modo = val; if (val === 'constituicao') { cs.pessoas = cs.pessoas.filter(p => p.papel !== 'retirante'); if (!cs.pessoas.length) cs.pessoas = [pessoaVazia()]; cs.cessoes = []; } render(); }
    else if (acao === 'buscar-cnpj') buscarCnpj();
    else if (acao === 'cnae-add') adicionarCnae();
    else if (acao === 'cnae-remover') { const era = cs.empresa.cnaes[i].principal; cs.empresa.cnaes.splice(i, 1); if (era && cs.empresa.cnaes[0]) cs.empresa.cnaes[0].principal = true; render(); }
    else if (acao === 'cnae-principal') { cs.empresa.cnaes.forEach((c, k) => { c.principal = k === i; }); }
    else if (acao === 'alteracao') { const s = new Set(cs.alteracoes); b.checked ? s.add(val) : s.delete(val); cs.alteracoes = ALTERACOES.map(a => a[0]).filter(a => s.has(a)); render(); }
    else if (acao === 'pessoa-add') { cs.pessoas.push(pessoaVazia(val)); render(); document.querySelectorAll('#cs-root [data-acao="pessoa-remover"]').length && document.querySelector(`[data-cs="pessoas.${cs.pessoas.length - 1}.nome"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else if (acao === 'pessoa-remover') {
      cs.pessoas.splice(i, 1);
      // Cessão que apontava para quem saiu perde a referência; as outras
      // precisam do índice corrigido.
      cs.cessoes = cs.cessoes.filter(c => +c.cedente !== i && +c.cessionario !== i)
        .map(c => ({ ...c, cedente: c.cedente === '' ? '' : String(+c.cedente > i ? +c.cedente - 1 : +c.cedente), cessionario: c.cessionario === '' ? '' : String(+c.cessionario > i ? +c.cessionario - 1 : +c.cessionario) }));
      render();
    }
    else if (acao === 'cessao-add') { cs.cessoes.push({ cedente: '', cessionario: '', quotas: '' }); render(); }
    else if (acao === 'cessao-remover') { cs.cessoes.splice(i, 1); render(); }
    else if (acao === 'dividir') {
      const qc = quotasDoCapital(), ss = socios();
      if (!qc || !ss.length) { showFormError('Defina o capital e o valor da quota na etapa Empresa.'); return; }
      const base = Math.floor(qc / ss.length);
      ss.forEach((p, k) => { p.quotas = String(base + (k < qc - base * ss.length ? 1 : 0)); });
      render();
    }
    else if (acao === 'ir') { cs.passo = Number(val); render(); }
    else if (acao === 'voltar') { cs.passo--; render(); window.scrollTo({ top: document.getElementById('cs-root').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' }); }
    else if (acao === 'avancar') {
      const erro = validarPasso(cs.passo);
      if (erro) { showFormError(erro); return; }
      cs.passo++; render();
      window.scrollTo({ top: document.getElementById('cs-root').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
    }
  }

  // ── Validação por etapa ───────────────────────────────────────────────────
  function erroEndereco(e, quem) {
    if (dig(e.cep).length !== 8) return `CEP de ${quem} inválido.`;
    if (!e.logradouro || !e.numero || !e.bairro || !e.cidade || !e.uf) return `Endereço de ${quem} incompleto.`;
    return null;
  }
  function validarPasso(n) {
    const e = cs.empresa, alt = cs.modo === 'alteracao';
    if (n === 1) {
      if (alt && !cnpjOk(docLimpo(e.cnpj))) return 'Informe um CNPJ válido.';
      return null;
    }
    if (n === 2) {
      if (alt && !cs.alteracoes.length) return 'Marque o que está sendo alterado.';
      if (!e.usarCnpjComoNome || alt) {
        if (e.nome.trim().length < 4) return 'Informe o nome empresarial.';
        if (!/\b(LTDA\.?|LIMITADA)$/i.test(e.nome.trim())) return 'O nome empresarial termina com LTDA ou LIMITADA.';
      }
      const ee = erroEndereco(e.endereco, 'sede'); if (ee) return ee;
      if (!e.cnaes.length && e.descricaoAtividades.trim().length < 10) return 'Adicione os CNAEs ou descreva as atividades.';
      if (!(centavos(e.capital) > 0)) return 'Informe o capital social.';
      if (!quotasDoCapital()) return 'O capital precisa se dividir em quotas inteiras: ajuste o valor da quota.';
      if (e.integralizacao === 'prazo' && !(dataBR(e.prazoIntegralizacao) > new Date())) return 'Informe uma data futura para a integralização.';
      if (alt && cs.alteracoes.includes('nome') && !cs.anterior.nome.trim()) return 'Informe o nome anterior.';
      if (alt && cs.alteracoes.includes('capital') && !(centavos(cs.anterior.capital) < centavos(e.capital))) return 'O capital novo precisa ser maior que o anterior (só aumento).';
      if (alt && cs.alteracoes.includes('endereco')) { const ea = erroEndereco(cs.anterior.endereco, 'sede anterior'); if (ea) return ea; }
      return null;
    }
    if (n === 3) {
      if (!socios().length) return 'Informe ao menos um sócio.';
      for (const [i, p] of cs.pessoas.entries()) {
        const quem = p.nome || `pessoa ${i + 1}`;
        if (p.nome.trim().length < 5) return `Informe o nome completo da pessoa ${i + 1}.`;
        const d = docLimpo(p.documento);
        if (p.tipo === 'PF' ? !cpfOk(d) : !cnpjOk(d)) return `${p.tipo === 'PF' ? 'CPF' : 'CNPJ'} de ${quem} inválido.`;
        if (p.tipo === 'PF') {
          if (!p.nacionalidade.trim()) return `Informe a nacionalidade de ${quem}.`;
          if (!dataBR(p.nascimento)) return `Informe a data de nascimento de ${quem}.`;
          if (!p.estadoCivil) return `Informe o estado civil de ${quem}.`;
          if (p.estadoCivil === 'casado' && !p.regimeBens) return `Informe o regime de bens de ${quem}.`;
          if (!p.profissao.trim()) return `Informe a profissão de ${quem}.`;
        }
        const ee = erroEndereco(p.endereco, quem); if (ee) return ee;
        if (p.tipo === 'PJ' || menor(p)) {
          const r = p.representante;
          if (r.nome.trim().length < 5 || !cpfOk(dig(r.cpf))) return `Preencha nome e CPF de quem ${p.tipo === 'PJ' ? 'representa' : 'assiste/representa'} ${quem}.`;
          if (!r.qualidade || !r.estadoCivil || !r.profissao.trim()) return `Complete os dados do representante de ${quem}.`;
        }
        if (p.papel === 'socio' && !(parseInt(dig(p.quotas), 10) > 0)) return `Informe as quotas de ${quem}.`;
        if (p.papel === 'retirante' && !(parseInt(dig(p.quotasAnteriores), 10) > 0)) return `Informe quantas quotas ${quem} tinha.`;
      }
      const docs = cs.pessoas.map(p => docLimpo(p.documento));
      if (new Set(docs).size !== docs.length) return 'Há CPF/CNPJ repetido entre as pessoas.';
      if (totalQuotas() !== quotasDoCapital()) return somaTxt();
      if (!cs.pessoas.some(ehAdministrador)) return 'Marque ao menos um administrador.';
      return null;
    }
    if (n === 4) {
      if (!cs.clausulas.foro) return 'Escolha o foro.';
      if (!cs.cidadeAssinatura.trim()) return 'Informe a cidade onde vai assinar.';
      return null;
    }
    return null;
  }

  // ── Interface com o painel ────────────────────────────────────────────────
  window.csIniciar = function () {
    cs = novoEstado();
    const root = document.getElementById('cs-root');
    if (!root) return;
    root.addEventListener('input', aoDigitar);
    root.addEventListener('change', aoDigitar);
    root.addEventListener('click', aoClicar);
    root.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); if (ev.target.id === 'cs-cnae-novo') adicionarCnae(); } });
    render();
  };

  // Corpo do /api/query. Dinheiro vai em centavos e índices como número —
  // o servidor normaliza de novo, mas não adivinha formato.
  window.csParams = function () {
    if (!cs) return {};
    const e = cs.empresa;
    const pessoaOut = p => ({
      ...p, documento: docLimpo(p.documento), quotas: parseInt(dig(p.quotas), 10) || 0,
      quotasAnteriores: parseInt(dig(p.quotasAnteriores), 10) || 0, endereco: { ...p.endereco, cep: dig(p.endereco.cep) },
      representante: { ...p.representante, cpf: dig(p.representante.cpf) },
      administrador: ehAdministrador(p) && p.papel === 'socio',
    });
    return {
      modo: cs.modo, natureza: cs.natureza,
      empresa: {
        nome: e.nome, usarCnpjComoNome: e.usarCnpjComoNome, cnpj: docLimpo(e.cnpj), nire: e.nire,
        numeroAlteracao: parseInt(dig(e.numeroAlteracao), 10) || 0, inicioAtividades: e.inicioAtividades,
        endereco: { ...e.endereco, cep: dig(e.endereco.cep) },
        cnaes: e.cnaes.map(c => ({ codigo: c.codigo, principal: !!c.principal })),
        descricaoAtividades: e.descricaoAtividades,
        capitalCentavos: centavos(e.capital), valorQuotaCentavos: centavos(e.valorQuota),
        integralizacao: e.integralizacao, prazoIntegralizacao: e.prazoIntegralizacao,
      },
      pessoas: cs.pessoas.map(pessoaOut),
      cessoes: cs.cessoes.map(c => ({ cedente: c.cedente === '' ? -1 : +c.cedente, cessionario: c.cessionario === '' ? -1 : +c.cessionario, quotas: parseInt(dig(c.quotas), 10) || 0 })),
      alteracoes: cs.modo === 'alteracao' ? cs.alteracoes : [],
      anterior: { nome: cs.anterior.nome, capitalCentavos: centavos(cs.anterior.capital), endereco: { ...cs.anterior.endereco, cep: dig(cs.anterior.endereco.cep) } },
      clausulas: cs.clausulas,
      cidadeAssinatura: cs.cidadeAssinatura,
      ciente: cs.ciente,
    };
  };

  window.csValidar = function (p) {
    for (let n = 1; n <= 4; n++) {
      const erro = validarPasso(n);
      if (erro) { cs.passo = n; render(); return erro; }
    }
    if (!p.ciente) return 'Marque a confirmação de que conferiu os dados.';
    return null;
  };
})();
