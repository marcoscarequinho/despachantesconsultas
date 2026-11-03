// Ponte entre a página do site (www.despachantesconsultas.com.br/extensao-chrome)
// e a extensão: a página é o painel do http://localhost:3939
// (ferramentas/agendamento-detran/painel.html), e o assets/agendamento-web.js
// do site responde as /api dele por aqui — o background.js faz o papel do
// agendar.js. Numa página da internet não existe chrome.storage nem o
// background, então este content script roda só nessa página e repassa, por
// postMessage, o mínimo:
// ler a lista e o andamento, gravar a lista, e iniciar/parar. O job continua
// sendo do background.js (a página não grava agendJob), e a lista continua no
// chrome.storage deste navegador — nunca vai para o servidor.
'use strict';

const CHAVES = ['agendDados', 'agendJob'];
const ACOES = ['iniciar', 'parar'];

function postar(m) {
  window.postMessage({ deExtensao: true, ...m }, location.origin);
}

window.addEventListener('message', async (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data;
  if (!m || !m.paraExtensao) return;
  let resposta;
  try {
    if (m.op === 'ping') {
      resposta = { versao: chrome.runtime.getManifest().version };
    } else if (m.op === 'ler') {
      resposta = await chrome.storage.local.get((m.chaves || []).filter((k) => CHAVES.includes(k)));
    } else if (m.op === 'gravar') {
      if (!m.obj || !m.obj.agendDados) throw new Error('só a lista de veículos pode ser gravada');
      await chrome.storage.local.set({ agendDados: m.obj.agendDados });
      resposta = { ok: true };
    } else if (m.op === 'enviar') {
      if (!m.msg || !ACOES.includes(m.msg.tipo)) throw new Error('ação recusada');
      resposta = await chrome.runtime.sendMessage(m.msg);
    } else {
      throw new Error('operação desconhecida');
    }
  } catch (err) {
    resposta = { erro: err.message };
  }
  postar({ id: m.id, resposta });
});

chrome.storage.onChanged.addListener((mud, area) => {
  if (area !== 'local') return;
  const mudou = {};
  for (const k of CHAVES) if (mud[k]) mudou[k] = { newValue: mud[k].newValue };
  if (Object.keys(mudou).length) postar({ mudou });
});
