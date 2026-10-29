// Agendamento assistido no Detran RJ — controlador da fila (service worker).
//
// É o dono do estado do agendamento em andamento ("job", em chrome.storage):
// o detran.js, que roda nas páginas do Detran, só lê o estado e manda eventos
// para cá (log, captcha, sem vaga, fim do veículo). Um dono só evita que duas
// páginas gravem o estado ao mesmo tempo; os eventos são tratados em ordem.
//
// Sem vaga, a nova tentativa é um chrome.alarms: o service worker dorme
// entre uma tentativa e outra e o alarme o acorda, mesmo com o Chrome parado
// naquela aba. Cada tentativa nova pede o captcha de novo — quem marca é a
// pessoa; a extensão nunca tenta passar por ele.
'use strict';

const BASE = 'https://www5.detran.rj.gov.br/_agendamento.eletronico/renavam2/';
const SERVICOS = {
  propriedade: { nome: 'Transferência de Propriedade', menu: 'menu02.asp' },
  jurisdicao: { nome: 'Transferência de Jurisdição', menu: 'menu03.asp' },
  municipio: { nome: 'Troca de Município', menu: 'menu04.asp' },
};
const CHAVE_DADOS = 'agendDados';
const CHAVE_JOB = 'agendJob';
const ALARME = 'agendNovaTentativa';
const MAX_LOG = 800;
const PAGINA = 'agendamento.html';

const DADOS_VAZIO = { opcoes: { intervaloMinutos: 15, maxTentativas: 0 }, veiculos: [] };

let fila = Promise.resolve();
function emOrdem(fn) {
  const p = fila.then(fn, fn);
  fila = p.catch(() => {});
  return p;
}

async function lerJob() { return (await chrome.storage.local.get(CHAVE_JOB))[CHAVE_JOB] || null; }
async function gravarJob(job) { await chrome.storage.local.set({ [CHAVE_JOB]: job }); }
async function lerDados() {
  const d = (await chrome.storage.local.get(CHAVE_DADOS))[CHAVE_DADOS];
  return { ...DADOS_VAZIO, ...(d || {}), opcoes: { ...DADOS_VAZIO.opcoes, ...((d && d.opcoes) || {}) } };
}

const hora = () => new Date().toLocaleTimeString('pt-BR');
function addLog(job, msg) {
  job.log.push(`[${hora()}] ${msg}`);
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
}

function urlMenu(v) { return BASE + SERVICOS[v.servico].menu; }

async function veiculoDoJob(job) {
  const d = await lerDados();
  return d.veiculos.find((v) => v.id === job.fila[job.idx]) || null;
}

function notificar(id, titulo, mensagem, fixa) {
  chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/icon-128.png', title: titulo, message: mensagem,
    priority: 2, requireInteraction: !!fixa,
  });
}

function badge(texto, cor) {
  chrome.action.setBadgeText({ text: texto || '' });
  if (cor) chrome.action.setBadgeBackgroundColor({ color: cor });
}

// Abre o veículo atual numa aba NOVA: a aba do anterior fica como estava
// (comprovante, erro ou formulário do teste) para a pessoa ver.
async function abrirVeiculoAtual(job) {
  const v = await veiculoDoJob(job);
  if (!v) return terminar(job, 'veículo não encontrado na lista');
  job.etapa = 'inicio';
  job.passo = 0;
  job.localEscolhido = false;
  job.recusas = 0;
  addLog(job, `${v.placa} — ${SERVICOS[v.servico].nome}, tentativa ${job.tentativa}`);
  const aba = await chrome.tabs.create({ url: urlMenu(v), active: true });
  job.tabId = aba.id;
  await gravarJob(job);
}

async function terminar(job, motivo) {
  job.ativo = false;
  job.etapa = 'fim';
  addLog(job, `=== ${motivo} ===`);
  await chrome.alarms.clear(ALARME);
  badge('');
  await gravarJob(job);
}

async function proximoVeiculo(job) {
  job.idx++;
  job.tentativa = 1;
  if (job.idx >= job.fila.length) {
    const resumo = job.resultados.map((r) => `${r.placa}: ${r.resultado}`).join(' · ');
    notificar('agend-fim', 'Agendamento Detran: terminou', resumo || 'Nada a agendar.');
    return terminar(job, 'fim — ' + resumo);
  }
  await abrirVeiculoAtual(job);
}

const acoes = {
  async iniciar({ ids, teste }) {
    const atual = await lerJob();
    if (atual && atual.ativo) return { erro: 'Já tem um agendamento rodando. Pare antes de começar outro.' };
    if (!ids || !ids.length) return { erro: 'Nenhum veículo para agendar.' };
    const job = { ativo: true, teste: !!teste, fila: ids, idx: 0, tentativa: 1, resultados: [], log: [] };
    addLog(job, `=== ${teste ? 'TESTE' : 'AGENDAMENTO'} de ${ids.length} veículo(s) ===`);
    await chrome.alarms.clear(ALARME);
    await abrirVeiculoAtual(job);
    return { ok: true };
  },

  async parar() {
    const job = await lerJob();
    if (job && job.ativo) await terminar(job, 'parado');
    return { ok: true };
  },

  // O detran.js pergunta se a aba dele é a do agendamento e o que fazer.
  async estado(_, sender) {
    const job = await lerJob();
    if (!job || !job.ativo || !sender.tab || sender.tab.id !== job.tabId) return { meu: false };
    const dados = await lerDados();
    return { meu: true, job: { ...job, log: undefined }, veiculo: await veiculoDoJob(job), opcoes: dados.opcoes };
  },

  async atualizar({ patch, log }, sender) {
    const job = await lerJob();
    if (!job || !job.ativo || sender.tab.id !== job.tabId) return { ok: false };
    Object.assign(job, patch || {});
    if (log) addLog(job, log);
    await gravarJob(job);
    return { ok: true };
  },

  async captcha({ placa }, sender) {
    const job = await lerJob();
    if (!job || !job.ativo || sender.tab.id !== job.tabId) return { ok: false };
    job.etapa = 'captcha';
    addLog(job, `${placa} — >>> MARQUE O "NÃO SOU UM ROBÔ" NA ABA DO DETRAN <<<`);
    await gravarJob(job);
    badge('!', '#d97706');
    notificar('agend-captcha', 'Detran: marque o captcha', `Placa ${placa}: clique aqui e marque "Não sou um robô".`, true);
    return { ok: true };
  },

  async passoManual({ placa, motivo }, sender) {
    const job = await lerJob();
    if (!job || !job.ativo || sender.tab.id !== job.tabId) return { ok: false };
    addLog(job, `${placa} — ${motivo}: faça este passo na aba do Detran; a extensão continua na próxima tela.`);
    await gravarJob(job);
    badge('?', '#2563eb');
    notificar('agend-manual', 'Detran: faça este passo', `Placa ${placa}: ${motivo}.`, true);
    return { ok: true };
  },

  async semVaga({ placa }, sender) {
    const job = await lerJob();
    if (!job || !job.ativo || sender.tab.id !== job.tabId) return { ok: false };
    const { opcoes } = await lerDados();
    if (opcoes.maxTentativas && job.tentativa >= opcoes.maxTentativas) {
      addLog(job, `${placa} — sem vaga e chegou ao máximo de ${opcoes.maxTentativas} tentativa(s).`);
      job.resultados.push({ placa, resultado: 'sem vaga' });
      await proximoVeiculo(job);
      return { ok: true };
    }
    const min = Math.max(1, Number(opcoes.intervaloMinutos) || 15);
    job.etapa = 'aguardando';
    job.proximaEm = Date.now() + min * 60000;
    addLog(job, `${placa} — sem vaga. Nova tentativa às ${new Date(job.proximaEm).toLocaleTimeString('pt-BR')}.`);
    await gravarJob(job);
    badge('…', '#64748b');
    await chrome.alarms.create(ALARME, { when: job.proximaEm });
    return { ok: true };
  },

  async fimVeiculo({ placa, resultado, detalhe }, sender) {
    const job = await lerJob();
    if (!job || !job.ativo || sender.tab.id !== job.tabId) return { ok: false };
    if (detalhe) addLog(job, `${placa} — ${detalhe}`);
    const textos = { ok: 'AGENDADO', erro: 'não agendado', teste: 'teste' };
    job.resultados.push({ placa, resultado: textos[resultado] || resultado });
    if (resultado === 'ok') {
      addLog(job, `${placa} — AGENDADO! O comprovante ficou aberto na aba do Detran.`);
      notificar('agend-ok-' + placa, 'Detran: agendado!', `Placa ${placa} agendada. O comprovante está na aba do Detran.`, true);
      const dados = await lerDados();
      const v = dados.veiculos.find((x) => x.id === job.fila[job.idx]);
      if (v) {
        v.feito = new Date().toISOString();
        await chrome.storage.local.set({ [CHAVE_DADOS]: dados });
      }
    }
    badge('');
    await proximoVeiculo(job);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  const fn = acoes[msg && msg.tipo];
  if (!fn) return false;
  emOrdem(() => fn(msg, sender)).then(responder, (e) => responder({ erro: e.message }));
  return true; // resposta assíncrona
});

chrome.alarms.onAlarm.addListener((alarme) => {
  if (alarme.name !== ALARME) return;
  emOrdem(async () => {
    const job = await lerJob();
    if (!job || !job.ativo || job.etapa !== 'aguardando') return;
    job.tentativa++;
    await abrirVeiculoAtual(job);
  });
});

// Fechar a aba do agendamento é a forma natural de desistir: para tudo, em
// vez de deixar um alarme reabrindo o Detran sozinho daqui a 15 minutos.
// A exceção é a espera entre tentativas: aí a aba já cumpriu o papel dela.
chrome.tabs.onRemoved.addListener((tabId) => {
  emOrdem(async () => {
    const job = await lerJob();
    if (job && job.ativo && job.tabId === tabId && job.etapa !== 'aguardando') {
      await terminar(job, 'a aba do Detran foi fechada — agendamento parado');
    }
  });
});

chrome.notifications.onClicked.addListener((id) => {
  emOrdem(async () => {
    const job = await lerJob();
    if (id.startsWith('agend-fim')) {
      chrome.tabs.create({ url: chrome.runtime.getURL(PAGINA) });
    } else if (job && job.tabId != null) {
      try {
        const aba = await chrome.tabs.update(job.tabId, { active: true });
        await chrome.windows.update(aba.windowId, { focused: true });
      } catch (e) { /* aba já fechada */ }
    }
    chrome.notifications.clear(id);
  });
});
