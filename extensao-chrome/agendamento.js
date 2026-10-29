// Tela de veículos do agendamento assistido no Detran RJ. Guarda a lista em
// chrome.storage.local (só neste Chrome) e pede ao background.js para rodar;
// o andamento vem do log do job, que o background grava no mesmo storage.
// Sem HTML inline com handler: a CSP do MV3 não deixa, tudo é data-acao.
'use strict';

const CHAVE_DADOS = 'agendDados';
const CHAVE_JOB = 'agendJob';

const SERVICOS = {
  propriedade: { nome: 'Transferência de Propriedade', opcoes: ['Transferência de Propriedade', 'Com inclusão de gravame (comprado financiado)', 'Com baixa de gravame (vendedor quitou)'] },
  jurisdicao: { nome: 'Transferência de Jurisdição', opcoes: ['Transferência de Jurisdição', 'Com baixa de gravame (proprietário quitou)', 'Com transferência de propriedade', 'Com transf. de propriedade e inclusão de gravame', 'Com transf. de propriedade e baixa de gravame'] },
  municipio: { nome: 'Troca de Município', opcoes: ['Troca de Município', 'Com baixa de gravame (proprietário quitou)', 'Com transferência de propriedade', 'Com transf. de propriedade e baixa de gravame', 'Com transf. de propriedade e inclusão de gravame'] },
};
const TIPOS = [['4', 'Outros'], ['1', 'Ônibus'], ['2', 'Táxi'], ['3', 'Carga']];
const REGIOES = [['01', 'Região Metropolitana'], ['02', 'Interior']];
const CATEGORIAS = [['01', 'Particular'], ['02', 'Aluguel'], ['03', 'Oficial'], ['04', 'Experiência'], ['05', 'Aprendizagem'], ['06', 'Fabricante']];
const SOLICITANTES = [['00', 'Proprietário'], ['03', 'Despachante'], ['01', 'Procurador Advogado'], ['02', 'Procurador Comum'], ['10', 'Ascendente ou Descendente'], ['11', 'Cônjuge do Proprietário'], ['05', 'Representante de Órgão Oficial'], ['06', 'ACB'], ['07', 'Touring Club'], ['08', 'Sindicato dos Taxistas'], ['09', 'Centro Benef. de Motoristas']];
const UFS = 'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RN RO RR RS SC SE SP TO'.split(' ');

const $ = (id) => document.getElementById(id);
let dados = { opcoes: { intervaloMinutos: 15, maxTentativas: 0 }, veiculos: [] };
let job = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// ---------- formulário ----------

function opcoesHtml(lista, valor) {
  return lista.map(([v, t]) => `<option value="${esc(v)}"${String(valor) === v ? ' selected' : ''}>${esc(t)}</option>`).join('');
}
function campo(i, nome, rotulo, extra = '', dica = '') {
  const v = dados.veiculos[i][nome] ?? '';
  return `<div><label>${rotulo}</label><input data-i="${i}" data-c="${nome}" value="${esc(v)}" ${extra}>${dica ? `<div class="dica">${dica}</div>` : ''}</div>`;
}
function escolha(i, nome, rotulo, lista, padrao) {
  const v = dados.veiculos[i][nome] ?? padrao;
  return `<div><label>${rotulo}</label><select data-i="${i}" data-c="${nome}" data-redesenha="1">${opcoesHtml(lista, v)}</select></div>`;
}

function htmlVeiculo(v, i) {
  const s = SERVICOS[v.servico] || SERVICOS.propriedade;
  const docRot = v.servico === 'municipio' ? 'CPF/CNPJ do proprietário atual' : v.servico === 'propriedade' ? 'CPF/CNPJ do novo proprietário' : 'CPF/CNPJ do proprietário';
  const cepRot = v.servico === 'propriedade' ? 'CEP do novo proprietário' : 'CEP de destino';
  let especificos = '';
  if (v.servico === 'propriedade') {
    especificos = campo(i, 'dataVenda', 'Data da venda', 'placeholder="dd/mm/aaaa" maxlength="10"')
      + campo(i, 'duda', 'Nº do DUDA pago', 'inputmode="numeric"', 'Pago no CPF/CNPJ do comprador')
      + escolha(i, 'categoria', 'Categoria pretendida', CATEGORIAS, '01');
  } else if (v.servico === 'jurisdicao') {
    especificos = escolha(i, 'ufOrigem', 'UF de origem', UFS.map((u) => [u, u]), 'SP')
      + campo(i, 'crv', 'Nº do CRV', 'inputmode="numeric"')
      + campo(i, 'chassi', 'Chassi', 'maxlength="17"', 'Só para placa antiga');
  } else {
    especificos = campo(i, 'chassi', 'Chassi', 'maxlength="17"', 'Só para placa antiga');
  }
  const despachante = String(v.solicitante ?? '00') === '03'
    ? campo(i, 'matriculaDespachante', 'Matrícula do despachante', 'inputmode="numeric" maxlength="5"')
      + escolha(i, 'tipoDespachante', 'Despachante', [['0', 'Público'], ['1', 'Documentalista']], '0')
    : '';
  const botoes = v.feito
    ? `<button data-acao="reabrir" data-i="${i}">Agendar de novo</button>`
    : `<button data-acao="testar" data-i="${i}">Testar</button><button class="verde" data-acao="agendar" data-i="${i}">Agendar</button>`;
  return `<div class="veiculo${v.feito ? ' feito' : ''}">
    <div class="topo-veic">
      <strong>${esc(v.placa || 'Novo veículo')} · ${esc(s.nome)}</strong>
      ${v.feito ? `<span class="selo">✓ agendado em ${esc(new Date(v.feito).toLocaleString('pt-BR'))}</span>` : ''}
      <div class="barra">${botoes}<button class="perigo" data-acao="remover" data-i="${i}">Remover</button></div>
    </div>
    <div class="grade">
      ${escolha(i, 'servico', 'Serviço', Object.entries(SERVICOS).map(([k, x]) => [k, x.nome]), 'propriedade')}
      <div class="largo"><label>Opção do serviço</label><select data-i="${i}" data-c="opcao">${opcoesHtml(s.opcoes.map((t, n) => [String(n + 1), t]), v.opcao ?? 1)}</select></div>
      ${campo(i, 'placa', 'Placa', 'maxlength="7" style="text-transform:uppercase"')}
      ${campo(i, 'renavam', 'Renavam', 'inputmode="numeric" maxlength="11"')}
      ${campo(i, 'cpfCnpj', docRot, 'inputmode="numeric" maxlength="14"', 'Só números')}
      ${campo(i, 'cep', cepRot, 'inputmode="numeric" maxlength="8"')}
      ${escolha(i, 'regiao', 'Região', REGIOES, '01')}
      ${escolha(i, 'tipo', 'Tipo de veículo', TIPOS, '4')}
      ${especificos}
      ${escolha(i, 'solicitante', 'Quem vai à unidade', SOLICITANTES, '00')}
      ${despachante}
      <div class="secao">Onde agendar</div>
      ${campo(i, 'cidade', 'Cidade', 'placeholder="ex.: Niterói"')}
      ${campo(i, 'posto', 'Posto', 'placeholder="ex.: Icaraí"', 'Opcional: parte do nome do posto como aparece no site')}
    </div>
  </div>`;
}

function desenhar() {
  $('lista').innerHTML = dados.veiculos.length
    ? dados.veiculos.map(htmlVeiculo).join('')
    : '<p class="vazio">Nenhum veículo cadastrado. Clique em "+ Novo veículo".</p>';
  $('o-intervaloMinutos').value = dados.opcoes.intervaloMinutos ?? 15;
  $('o-maxTentativas').value = dados.opcoes.maxTentativas ?? 0;
}

let timerSalvar = null;
function salvarDepois() {
  clearTimeout(timerSalvar);
  timerSalvar = setTimeout(salvar, 300);
}
async function salvar() {
  clearTimeout(timerSalvar);
  await chrome.storage.local.set({ [CHAVE_DADOS]: dados });
}

function mostrarMsg(texto, cor) {
  $('msg').textContent = texto || '';
  $('msg').style.color = cor || 'var(--cinza)';
}

// Mesmas regras do formulário do Detran: placa, renavam, CPF/CNPJ, CEP, DUDA e
// data da venda. Conferir aqui poupa uma tentativa (e um captcha) perdida.
function validar(v) {
  const erros = [];
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(String(v.placa || '').toUpperCase())) erros.push('placa inválida');
  if (!/^\d{9,11}$/.test(soDigitos(v.renavam))) erros.push('renavam inválido');
  const doc = soDigitos(v.cpfCnpj);
  if (doc.length !== 11 && doc.length !== 14) erros.push('CPF/CNPJ deve ter 11 ou 14 dígitos');
  if (!/^\d{8}$/.test(soDigitos(v.cep))) erros.push('CEP inválido');
  if (v.servico === 'propriedade') {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(v.dataVenda || '')) erros.push('data da venda no formato dd/mm/aaaa');
    if (!soDigitos(v.duda)) erros.push('informe o DUDA');
  }
  if (String(v.solicitante) === '03' && !soDigitos(v.matriculaDespachante)) erros.push('informe a matrícula do despachante');
  if (!v.cidade && !v.posto) erros.push('informe a cidade e/ou o posto');
  return erros;
}

async function rodar(indices, teste) {
  if (job && job.ativo) return mostrarMsg('Já tem um agendamento rodando.', 'var(--vermelho)');
  await salvar();
  const lista = indices.map((i) => dados.veiculos[i]).filter((v) => v && !v.feito);
  if (!lista.length) return mostrarMsg('Nenhum veículo pendente para agendar.', 'var(--vermelho)');
  const problemas = lista.map((v) => [v, validar(v)]).filter(([, e]) => e.length);
  if (problemas.length) {
    return mostrarMsg(problemas.map(([v, e]) => `${v.placa || 'Sem placa'}: ${e.join('; ')}`).join(' · '), 'var(--vermelho)');
  }
  const r = await chrome.runtime.sendMessage({ tipo: 'iniciar', ids: lista.map((v) => v.id), teste });
  if (r && r.erro) return mostrarMsg(r.erro, 'var(--vermelho)');
  mostrarMsg(teste ? 'Testando… a aba do Detran foi aberta.' : 'Agendando… acompanhe abaixo.', 'var(--azul)');
}

// ---------- eventos ----------

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'o-intervaloMinutos' || el.id === 'o-maxTentativas') {
    dados.opcoes[el.id.slice(2)] = Number(el.value);
    return salvarDepois();
  }
  if (el.dataset.c == null) return;
  const v = dados.veiculos[el.dataset.i];
  let valor = el.value;
  if (el.dataset.c === 'placa') valor = valor.toUpperCase();
  if (el.dataset.c === 'opcao' || el.dataset.c === 'tipoDespachante') valor = Number(valor);
  v[el.dataset.c] = valor;
  salvarDepois();
});

// Só select redesenha: redesenhar no meio da digitação tiraria o foco.
document.addEventListener('change', (e) => {
  if (!e.target.dataset.redesenha) return;
  if (e.target.dataset.c === 'servico') dados.veiculos[e.target.dataset.i].opcao = 1;
  desenhar();
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-acao]');
  if (!el) return;
  const i = el.dataset.i == null ? null : Number(el.dataset.i);
  switch (el.dataset.acao) {
    case 'novo': {
      dados.veiculos.push({ id: crypto.randomUUID(), servico: 'propriedade', opcao: 1, placa: '', renavam: '', cpfCnpj: '', cep: '', regiao: '01', tipo: '4', categoria: '01', solicitante: '00', cidade: '', posto: '' });
      await salvar();
      desenhar();
      const cards = document.querySelectorAll('.veiculo');
      cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }
    case 'remover':
      if (!confirm(`Remover ${dados.veiculos[i].placa || 'este veículo'}?`)) return;
      dados.veiculos.splice(i, 1);
      await salvar();
      desenhar();
      break;
    case 'reabrir':
      delete dados.veiculos[i].feito;
      await salvar();
      desenhar();
      break;
    case 'testar': return rodar([i], true);
    case 'agendar': return rodar([i], false);
    case 'testar-todos': return rodar(dados.veiculos.map((_, n) => n), true);
    case 'agendar-todos': return rodar(dados.veiculos.map((_, n) => n), false);
    case 'parar':
      await chrome.runtime.sendMessage({ tipo: 'parar' });
      break;
  }
});

// ---------- andamento ----------

function classeLinha(l) {
  if (/MARQUE O/.test(l)) return 'marque';
  if (/AGENDADO/.test(l)) return 'ok';
  if (/falhou|recusou|inválid|erro|fechada/i.test(l)) return 'erro';
  return '';
}

function bipar() {
  try {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + t); g.gain.setValueAtTime(0, ctx.currentTime + t + 0.2);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.25);
    });
  } catch (e) { /* sem áudio */ }
}

let etapaAnterior = null;
function desenharJob() {
  const ativo = !!(job && job.ativo);
  const log = $('log');
  const noFim = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  log.replaceChildren(...((job && job.log) || []).map((l) => {
    const d = document.createElement('div');
    d.textContent = l;
    const c = classeLinha(l);
    if (c) d.className = c;
    return d;
  }));
  if (noFim) log.scrollTop = log.scrollHeight;

  const etapa = ativo ? job.etapa : null;
  $('alerta').hidden = etapa !== 'captcha';
  if (etapa === 'captcha' && etapaAnterior !== 'captcha') bipar();
  etapaAnterior = etapa;
  $('estado').textContent = !ativo ? 'parado'
    : etapa === 'aguardando' ? `aguardando nova tentativa às ${new Date(job.proximaEm).toLocaleTimeString('pt-BR')}`
    : '● rodando';
  $('btn-parar').disabled = !ativo;
  $('btn-todos').disabled = ativo;
}

chrome.storage.onChanged.addListener((mud, area) => {
  if (area !== 'local') return;
  if (mud[CHAVE_JOB]) {
    const eraAtivo = job && job.ativo;
    job = mud[CHAVE_JOB].newValue || null;
    desenharJob();
    if (eraAtivo && !(job && job.ativo)) mostrarMsg('');
  }
  // O background marca "agendado" no veículo: recarrega sem perder o que
  // está sendo digitado (só redesenha se a mudança não veio daqui).
  if (mud[CHAVE_DADOS] && JSON.stringify(mud[CHAVE_DADOS].newValue) !== JSON.stringify(dados)) {
    dados = mud[CHAVE_DADOS].newValue || dados;
    desenhar();
  }
});

(async () => {
  const st = await chrome.storage.local.get([CHAVE_DADOS, CHAVE_JOB]);
  if (st[CHAVE_DADOS]) dados = { ...dados, ...st[CHAVE_DADOS], opcoes: { ...dados.opcoes, ...(st[CHAVE_DADOS].opcoes || {}) } };
  job = st[CHAVE_JOB] || null;
  desenhar();
  desenharJob();
})();
