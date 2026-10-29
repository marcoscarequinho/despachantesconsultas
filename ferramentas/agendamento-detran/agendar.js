// Agendamento assistido no Detran RJ (Agendamento de Veículo).
//
// Roda no computador de quem agenda, com o Chrome instalado. O script abre o
// site, escolhe o serviço, preenche a identificação e PARA no reCAPTCHA: quem
// marca o "Não sou um robô" é a pessoa sentada na frente do computador. Depois
// disso ele tenta escolher a cidade/posto informados e o primeiro dia e horário
// livres. Sem vaga, espera o intervalo e tenta de novo — e cada tentativa nova
// pede o captcha de novo, com aviso sonoro e (opcional) no WhatsApp.
//
// O site é ASP antigo e não tem API: as telas depois do captcha (posto, data,
// horário) não puderam ser vistas sem um agendamento de verdade (29/10/2026),
// então a escolha nelas é por texto. Página que o script não entende vira
// pausa: a pessoa faz aquele passo no navegador e o script segue dali.
//
// Uso:  node agendar.js            (todos os veículos de veiculos.json)
//       node agendar.js ABC1D23    (só essa placa)
//       node agendar.js --teste    (só preenche e mostra os campos, não envia)

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const BASE = 'https://www5.detran.rj.gov.br/_agendamento.eletronico/renavam2/';

// Menu de cada serviço (é o iframe das páginas de detran.rj.gov.br) e a função
// da própria página que manda para o formulário de identificação.
const SERVICOS = {
  propriedade: { nome: 'Transferência de Propriedade', menu: 'menu02.asp', continuar: 'finalizarAgendamento' },
  jurisdicao: { nome: 'Transferência de Jurisdição', menu: 'menu03.asp', continuar: 'finalizar' },
  municipio: { nome: 'Troca de Município', menu: 'menu04.asp', continuar: 'finalizar' },
};

const PASTA = __dirname;
const REGISTROS = path.join(PASTA, 'registros');
const CONFIG = lerJson(path.join(PASTA, 'veiculos.json'));
const OPCOES = {
  intervaloMinutos: 15,      // espera entre uma tentativa sem vaga e a próxima
  maxTentativas: 0,          // 0 = até conseguir
  esperaCaptchaMinutos: 30,  // quanto tempo o script espera alguém marcar o captcha
  avisarWhatsApp: '',        // número que recebe "marque o captcha" e "agendado"
  ...(CONFIG.opcoes || {}),
};

// Textos que o Detran usa para "não tem horário" e "deu certo". Por não termos
// visto as telas finais, ficam aqui em cima para acertar sem mexer no resto.
const SEM_VAGA = /nao ha (vagas?|horarios?|datas?)|sem (vagas?|horarios?) disponive|nenhum(a)? (vaga|horario|data) disponive|esgotad|indisponive/;
const CONCLUIDO = /agendamento (realizado|efetuado|confirmado) com sucesso|comprovante de agendamento|numero do agendamento|seu agendamento foi/;
const BOTAO_AVANCAR = /^(continuar|enviar|avancar|proximo|confirmar|concluir|agendar|ok)$/;

function lerJson(arquivo) {
  if (!fs.existsSync(arquivo)) {
    console.error(`Não achei ${path.basename(arquivo)}. Copie veiculos.exemplo.json para veiculos.json e preencha.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
}

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }

function mascarar(doc) {
  const d = soDigitos(doc);
  return d.length > 5 ? d.slice(0, 3) + '*'.repeat(d.length - 5) + d.slice(-2) : d;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const agora = () => new Date().toLocaleTimeString('pt-BR');
function log(v, msg) { console.log(`[${agora()}] ${v ? v.placa + ' — ' : ''}${msg}`); }

function bip(vezes = 3) {
  for (let i = 0; i < vezes; i++) process.stdout.write('\x07');
}

// Z-API com as mesmas variáveis do .env do site (ZAPI_*), se existirem.
function lerEnvSite() {
  const env = {};
  const arq = path.join(PASTA, '..', '..', '.env');
  if (!fs.existsSync(arq)) return env;
  for (const linha of fs.readFileSync(arq, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const ENV = { ...lerEnvSite(), ...process.env };

async function avisar(msg) {
  const numero = soDigitos(OPCOES.avisarWhatsApp);
  if (!numero || !ENV.ZAPI_INSTANCE_ID || !ENV.ZAPI_TOKEN) return;
  const phone = numero.length <= 11 ? '55' + numero : numero;
  try {
    await fetch(`https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_TOKEN}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ENV.ZAPI_CLIENT_TOKEN ? { 'Client-Token': ENV.ZAPI_CLIENT_TOKEN } : {}) },
      body: JSON.stringify({ phone, message: msg }),
    });
  } catch (e) {
    console.log('  (aviso no WhatsApp não saiu: ' + e.message + ')');
  }
}

function perguntar(texto) {
  // Rodando pela tela (servidor.js) não há teclado: responde "não".
  if (!process.stdin.isTTY) { console.log(texto + 'não (sem teclado)'); return Promise.resolve(''); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(texto, (resp) => { rl.close(); r(resp.trim()); }));
}

function validar(v) {
  const erros = [];
  if (!SERVICOS[v.servico]) erros.push(`servico deve ser ${Object.keys(SERVICOS).join(', ')}`);
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(String(v.placa || '').toUpperCase())) erros.push('placa inválida');
  if (!/^\d{9,11}$/.test(soDigitos(v.renavam))) erros.push('renavam inválido');
  const doc = soDigitos(v.cpfCnpj);
  if (doc.length !== 11 && doc.length !== 14) erros.push('cpfCnpj deve ter 11 ou 14 dígitos');
  if (!/^\d{8}$/.test(soDigitos(v.cep))) erros.push('cep inválido');
  if (v.servico === 'propriedade') {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(v.dataVenda || '')) erros.push('dataVenda no formato dd/mm/aaaa');
  }
  if (v.servico === 'jurisdicao' && !v.ufOrigem) erros.push('ufOrigem é obrigatória na Transferência de Jurisdição');
  if (String(v.solicitante) === '03' && !v.matriculaDespachante) erros.push('matriculaDespachante é obrigatória quando quem vai é o despachante');
  if (!v.posto && !v.cidade) erros.push('informe cidade e/ou posto');
  return erros;
}

// ---------- telas ----------

async function abrirIdentificacao(page, v) {
  const s = SERVICOS[v.servico];
  await page.goto(BASE + s.menu, { waitUntil: 'domcontentloaded' });
  const opcao = String(v.opcao || 1);
  const ok = await page.evaluate(({ opcao, fn }) => {
    const r = document.querySelector(`input[name=parte1][value="${opcao}"]`);
    if (!r || typeof window[fn] !== 'function') return false;
    r.checked = true;
    window[fn]();
    return true;
  }, { opcao, fn: s.continuar });
  if (!ok) throw new Error(`a tela de opções de ${s.nome} mudou (opção ${opcao} ou botão Continuar não encontrados)`);
  try {
    await page.waitForSelector('form[name=Form1] input[name=placa]', { timeout: 60000 });
  } catch {
    const reg = await registrar(page, v, 'sem-identificacao');
    const txt = (await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`o Detran não abriu a tela de identificação (registrada como ${reg}): ${txt || 'página em branco'}`);
  }
}

async function preencherIdentificacao(page, v) {
  const doc = soDigitos(v.cpfCnpj);
  const campos = {
    placa: String(v.placa).toUpperCase(),
    renavam: soDigitos(v.renavam),
    chassi: v.chassi || '',
    crv: v.crv || '',
    data_venda: v.dataVenda || '',
    duda: soDigitos(v.duda),
    cpf: doc,
    CEP: soDigitos(v.cep),
    cep: soDigitos(v.cep),
    despachante: v.matriculaDespachante || '',
  };
  const selects = {
    tipo: String(v.tipo || '4'),
    RegiaoRenavam: String(v.regiao || '01'),
    categoria: String(v.categoria || '01'),
    solicitante: String(v.solicitante || '00'),
    uf: v.ufOrigem || '',
  };
  await page.evaluate(({ campos, selects, tipoDoc, tipoDesp }) => {
    const f = document.forms.Form1;
    const radio = f.querySelector(`input[name=cpfcnpj][value=${tipoDoc}]`);
    if (radio) radio.click();
    for (const [nome, valor] of Object.entries(selects)) {
      const el = f.elements[nome];
      if (el && valor) { el.value = valor; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    if (typeof window.tipoUsuario === 'function') window.tipoUsuario(f.solicitante.value);
    for (const [nome, valor] of Object.entries(campos)) {
      const el = f.elements[nome];
      if (el && el.type !== 'hidden' && valor) el.value = valor;
    }
    if (tipoDesp !== '') {
      const td = f.querySelector(`input[name=TipoDespachante][value="${tipoDesp}"]`);
      if (td) td.click();
    }
  }, { campos, selects, tipoDoc: doc.length === 14 ? 'cnpj' : 'cpf', tipoDesp: v.tipoDespachante == null ? '' : String(v.tipoDespachante) });
}

// Espera alguém marcar o captcha e então envia o formulário.
async function esperarCaptchaEEnviar(page, v) {
  log(v, '>>> MARQUE O "NÃO SOU UM ROBÔ" NA JANELA DO CHROME <<<');
  bip();
  await page.bringToFront();
  await page.locator('.g-recaptcha').scrollIntoViewIfNeeded().catch(() => {});
  await avisar(`Agendamento Detran: marque o captcha da placa ${v.placa} (${SERVICOS[v.servico].nome}).`);
  await page.waitForFunction(
    () => window.grecaptcha && window.grecaptcha.getResponse && window.grecaptcha.getResponse() !== '',
    null,
    { timeout: OPCOES.esperaCaptchaMinutos * 60000, polling: 1000 },
  );
  log(v, 'captcha marcado, enviando');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}),
    page.locator('form[name=Form1] input[type=submit]').click(),
  ]);
}

async function textoDaPagina(page) {
  return semAcento(await page.evaluate(() => document.body ? document.body.innerText : ''));
}

let contadorRegistro = 0;
async function registrar(page, v, etapa) {
  fs.mkdirSync(REGISTROS, { recursive: true });
  const nome = `${v.placa}-${new Date().toISOString().replace(/[:.]/g, '-')}-${++contadorRegistro}-${etapa}`;
  await page.screenshot({ path: path.join(REGISTROS, nome + '.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(REGISTROS, nome + '.html'), await page.content().catch(() => ''));
  return nome;
}

// Escolhe numa página o item (option, radio, link ou botão) cujo texto contém
// um dos termos. Devolve o texto escolhido ou null.
async function escolherPorTexto(page, termos) {
  return page.evaluate((termos) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const ts = termos.map(norm).filter(Boolean);
    if (!ts.length) return null;
    const bate = (txt) => ts.some((t) => norm(txt).includes(t));
    for (const sel of document.querySelectorAll('select')) {
      const op = [...sel.options].find((o) => o.value && !o.disabled && bate(o.text));
      if (op) { sel.value = op.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return op.text; }
    }
    for (const r of document.querySelectorAll('input[type=radio]')) {
      const txt = (r.labels && r.labels[0] ? r.labels[0].innerText : '') || (r.parentElement ? r.parentElement.innerText : '') || r.value;
      if (!r.disabled && bate(txt)) { r.click(); return txt.trim(); }
    }
    for (const a of document.querySelectorAll('a, button, input[type=button], input[type=submit]')) {
      const txt = a.innerText || a.value || '';
      if (txt && bate(txt) && !/voltar|imprimir|sair/i.test(txt)) { a.click(); return txt.trim(); }
    }
    return null;
  }, termos);
}

// Data/turno/horário: o primeiro disponível.
async function escolherPrimeiro(page) {
  return page.evaluate(() => {
    for (const sel of document.querySelectorAll('select')) {
      const op = [...sel.options].find((o) => o.value && !o.disabled && !/selecione/i.test(o.text));
      if (op && sel.value !== op.value && !sel.value) { sel.value = op.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return op.text; }
    }
    const radios = [...document.querySelectorAll('input[type=radio]')].filter((r) => !r.disabled);
    if (radios.length && !radios.some((r) => r.checked)) {
      radios[0].click();
      return (radios[0].parentElement ? radios[0].parentElement.innerText : radios[0].value).trim();
    }
    return null;
  });
}

async function clicarAvancar(page) {
  const clicou = await page.evaluate((fonte) => {
    const re = new RegExp(fonte);
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const el = [...document.querySelectorAll('input[type=submit], input[type=button], button, a')]
      .find((b) => re.test(norm(b.value || b.innerText)));
    if (!el) return false;
    el.click();
    return true;
  }, BOTAO_AVANCAR.source);
  if (clicou) await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  return clicou;
}

// Espera a pessoa fazer um passo à mão: segue quando a página muda.
async function esperarPassoManual(page, v, motivo) {
  log(v, `${motivo} — faça este passo no Chrome; o script continua quando a página mudar.`);
  bip(2);
  await avisar(`Agendamento Detran ${v.placa}: ${motivo}. Faça este passo no navegador.`);
  const antes = await page.evaluate(() => location.href + '|' + document.body.innerText.length);
  await page.waitForFunction((antes) => location.href + '|' + document.body.innerText.length !== antes, antes, { timeout: 0, polling: 1500 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// Telas depois do captcha. Devolve 'ok', 'sem_vaga' ou 'erro'.
async function etapasDoAgendamento(page, v) {
  const termosLocal = [v.posto, v.cidade].filter(Boolean);
  let localEscolhido = false;
  for (let passo = 1; passo <= 12; passo++) {
    await esperar(1500);
    const txt = await textoDaPagina(page);
    const reg = await registrar(page, v, 'passo' + passo);

    if (CONCLUIDO.test(txt)) {
      const pdf = path.join(REGISTROS, `${v.placa}-AGENDADO.pdf`);
      await page.pdf({ path: pdf }).catch(() => {});
      log(v, `AGENDADO! Comprovante salvo em registros (${reg}.png${fs.existsSync(pdf) ? ' e ' + path.basename(pdf) : ''}).`);
      return 'ok';
    }
    if (SEM_VAGA.test(txt)) {
      log(v, 'sem vaga nesta tentativa.');
      return 'sem_vaga';
    }

    // Erros de validação do Detran (placa, DUDA, CPF...) não melhoram tentando
    // de novo: para o veículo e mostra a mensagem.
    const erro = txt.match(/(atencao|erro|invalid[oa]|nao (foi )?(encontrad|localizad|confere))[^\n]{0,160}/);

    if (!localEscolhido && termosLocal.length) {
      // Cidade e posto podem estar na mesma tela ou em telas seguidas. Se a
      // escolha já for um link (a página muda sozinha), não clica em mais nada.
      const urlAntes = page.url();
      const cidade = v.cidade ? await escolherPorTexto(page, [v.cidade]) : null;
      if (cidade) { log(v, 'cidade: ' + cidade); await esperar(1500); }
      const posto = v.posto && page.url() === urlAntes ? await escolherPorTexto(page, [v.posto]) : null;
      if (posto) log(v, 'posto: ' + posto);
      if (posto || (cidade && !v.posto)) localEscolhido = true;
      if (cidade || posto) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await esperar(1000);
        if (page.url() === urlAntes) await clicarAvancar(page);
        continue;
      }
    }

    if (localEscolhido) {
      const item = await escolherPrimeiro(page);
      if (item) {
        log(v, 'escolhido: ' + item.replace(/\s+/g, ' ').slice(0, 80));
        await esperar(800);
        if (await clicarAvancar(page)) continue;
      } else if (await clicarAvancar(page)) {
        continue;
      }
    }

    if (erro && passo === 1) {
      log(v, 'o Detran recusou os dados: ' + erro[0]);
      return 'erro';
    }
    await esperarPassoManual(page, v, `não reconheci esta tela (registrada como ${reg})`);
  }
  log(v, 'muitas telas sem chegar ao fim; parando este veículo.');
  return 'erro';
}

async function agendarVeiculo(context, v) {
  const s = SERVICOS[v.servico];
  log(v, `${s.nome}, documento ${mascarar(v.cpfCnpj)}, local: ${[v.cidade, v.posto].filter(Boolean).join(' / ')}`);
  for (let tentativa = 1; !OPCOES.maxTentativas || tentativa <= OPCOES.maxTentativas; tentativa++) {
    const page = await context.newPage();
    page.on('dialog', async (d) => { log(v, 'aviso do site: ' + d.message()); await d.accept().catch(() => {}); });
    try {
      log(v, `tentativa ${tentativa}`);
      await abrirIdentificacao(page, v);
      await preencherIdentificacao(page, v);
      if (MODO_TESTE) {
        const valores = await page.evaluate(() => [...document.forms.Form1.elements]
          .filter((e) => e.name && e.type !== 'hidden' && e.type !== 'submit' && e.type !== 'reset' && (e.type !== 'radio' || e.checked))
          .map((e) => `${e.name}=${e.value}`));
        log(v, 'TESTE, nada enviado. Campos preenchidos:\n    ' + valores.join('\n    '));
        await registrar(page, v, 'teste');
        return true;
      }
      await esperarCaptchaEEnviar(page, v);
      const r = await etapasDoAgendamento(page, v);
      if (r === 'ok') {
        await avisar(`Agendamento Detran: placa ${v.placa} AGENDADA (${s.nome}). Comprovante na pasta registros.`);
        return true;
      }
      if (r === 'erro') {
        const resp = await perguntar('  Tentar de novo este veículo? (s/N) ');
        if (!/^s/i.test(resp)) return false;
      }
    } catch (e) {
      log(v, 'falhou: ' + e.message);
    } finally {
      await page.close().catch(() => {});
    }
    log(v, `nova tentativa em ${OPCOES.intervaloMinutos} min (Ctrl+C para parar).`);
    await esperar(OPCOES.intervaloMinutos * 60000);
  }
  return false;
}

const MODO_TESTE = process.argv.includes('--teste');

async function main() {
  const filtro = (process.argv.slice(2).find((a) => !a.startsWith('--')) || '').toUpperCase();
  const veiculos = (CONFIG.veiculos || []).filter((v) => !v.feito && (!filtro || String(v.placa).toUpperCase() === filtro));
  if (!veiculos.length) { console.log('Nenhum veículo para agendar em veiculos.json.'); return; }

  let invalido = false;
  for (const v of veiculos) {
    const erros = validar(v);
    if (erros.length) { invalido = true; console.log(`${v.placa || '(sem placa)'}: ${erros.join('; ')}`); }
  }
  if (invalido) process.exit(1);

  // Perfil próprio e persistente no Chrome instalado: o reCAPTCHA desconfia
  // menos de um navegador "de verdade" que já foi usado do que de um limpo.
  const context = await chromium.launchPersistentContext(path.join(PASTA, 'perfil-chrome'), {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });

  const resultado = [];
  for (const v of veiculos) {
    const ok = await agendarVeiculo(context, v);
    resultado.push(`${v.placa}: ${MODO_TESTE ? 'teste' : ok ? 'AGENDADO' : 'não agendado'}`);
    if (ok && !MODO_TESTE) {
      v.feito = new Date().toISOString();
      fs.writeFileSync(path.join(PASTA, 'veiculos.json'), JSON.stringify(CONFIG, null, 2));
    }
  }
  console.log('\nResumo:\n  ' + resultado.join('\n  '));
  await context.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
