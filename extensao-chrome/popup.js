// Popup da extensão: mostra quem está logado e o saldo (ou a fatura, no
// pós-pago) e abre o painel. Não guarda token nem senha: usa o mesmo cookie
// auth_token do site — com a host permission do manifest, o Chrome manda o
// cookie nas chamadas da extensão. Quem saiu do site sai da extensão junto.
'use strict';

const SITE = 'https://www.despachantesconsultas.com.br';

const $ = (id) => document.getElementById(id);
const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso) => {
  // Vencimento vem como timestamp; mostra só o dia no fuso do Brasil.
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

function mostrar(secao) {
  ['logado', 'deslogado', 'erro'].forEach((id) => { $(id).hidden = id !== secao; });
}

async function api(caminho) {
  const r = await fetch(SITE + caminho, { credentials: 'include', cache: 'no-store' });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function carregar() {
  let me;
  try {
    me = await api('/api/auth/me');
  } catch (e) {
    $('saudacao').textContent = 'Sem conexão';
    return mostrar('erro');
  }
  if (!me) {
    $('saudacao').textContent = 'Você não está logado';
    return mostrar('deslogado');
  }

  const primeiroNome = String(me.name || '').trim().split(/\s+/)[0] || 'cliente';
  $('saudacao').textContent = 'Olá, ' + primeiroNome;

  if (me.pos_pago) {
    await mostrarFatura();
  } else {
    $('rotulo').textContent = 'Saldo disponível';
    $('valor').textContent = fmtBRL(me.credits);
  }
  mostrar('logado');
}

// Pós-pago não tem saldo, tem fatura: mesmo rótulo e cor âmbar do painel,
// e a recarga some (o servidor recusa recarga de pós-pago).
async function mostrarFatura() {
  $('cartao').classList.add('fatura');
  $('rotulo').textContent = 'Fatura em aberto';
  const btn = $('btn-recarga');
  btn.textContent = '🧾 Conta Pós-paga';
  btn.dataset.abrir = '/painel';

  let pp = null;
  try { pp = await api('/api/pos-pago/resumo'); } catch (e) { /* mostra sem detalhe */ }
  if (!pp || !pp.posPago) { $('valor').textContent = '—'; return; }

  $('valor').textContent = fmtBRL(pp.emAberto);
  const partes = [];
  if (pp.fatura && pp.fatura.vencimento) partes.push('Vence em ' + fmtData(pp.fatura.vencimento));
  // devido = ciclo atual + faturas fechadas ainda sem baixa.
  if (pp.devido > pp.emAberto) partes.push('Total devido: ' + fmtBRL(pp.devido));
  if (pp.bloqueado) {
    $('cartao').classList.add('bloqueado');
    partes.unshift('Consultas bloqueadas por fatura vencida');
  }
  $('detalhe').textContent = partes.join(' · ');
}

// Todo botão/link com data-abrir vira uma aba do site. Se já existe uma aba
// do site aberta, reaproveita em vez de empilhar abas iguais.
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-abrir]');
  if (!el) return;
  ev.preventDefault();
  const url = SITE + el.dataset.abrir;
  try {
    const [aba] = await chrome.tabs.query({ url: SITE + '/*' });
    if (aba) {
      await chrome.tabs.update(aba.id, { url, active: true });
      await chrome.windows.update(aba.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (e) {
    chrome.tabs.create({ url });
  }
  window.close();
});

carregar();
