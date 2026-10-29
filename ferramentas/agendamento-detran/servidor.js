// Tela local do agendamento: serve painel.html em http://localhost:3939,
// grava o veiculos.json e roda o agendar.js mostrando o andamento na tela.
// Só escuta em 127.0.0.1 — o veiculos.json tem CPF e renavam de clientes.
// Aberto pelo "Agendamento Detran.bat"; se já estiver rodando, só abre a tela.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const PORTA = 3939;
const URL = `http://localhost:${PORTA}/`;
const PASTA = __dirname;
const ARQ_DADOS = path.join(PASTA, 'veiculos.json');

const DADOS_VAZIO = {
  opcoes: { intervaloMinutos: 15, maxTentativas: 0, esperaCaptchaMinutos: 30, avisarWhatsApp: '' },
  veiculos: [],
};

let processo = null;
let linhas = [];        // andamento da execução atual (e da última)
let inicioLog = 0;      // índice da 1ª linha guardada, para o polling pedir "a partir de"
const MAX_LINHAS = 2000;

function addLinha(texto) {
  for (const l of String(texto).replace(/\x07/g, '').split(/\r?\n/)) {
    if (!l.trim()) continue;
    linhas.push(l);
  }
  if (linhas.length > MAX_LINHAS) {
    const sobra = linhas.length - MAX_LINHAS;
    linhas = linhas.slice(sobra);
    inicioLog += sobra;
  }
}

function lerDados() {
  if (!fs.existsSync(ARQ_DADOS)) return DADOS_VAZIO;
  return JSON.parse(fs.readFileSync(ARQ_DADOS, 'utf8'));
}

function responder(res, status, corpo, tipo = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { falha(e); } });
  });
}

function iniciar({ placa, teste }) {
  const args = [path.join(PASTA, 'agendar.js')];
  if (placa) args.push(String(placa).toUpperCase());
  if (teste) args.push('--teste');
  linhas = [];
  inicioLog = 0;
  addLinha(`=== ${teste ? 'TESTE' : 'AGENDAMENTO'} ${placa ? 'da placa ' + placa : 'de todos os veículos'} — ${new Date().toLocaleString('pt-BR')} ===`);
  processo = spawn(process.execPath, args, { cwd: PASTA, stdio: ['ignore', 'pipe', 'pipe'] });
  processo.stdout.on('data', addLinha);
  processo.stderr.on('data', addLinha);
  processo.on('exit', (code, sinal) => {
    addLinha(sinal ? '=== parado ===' : `=== fim (${code === 0 ? 'ok' : 'código ' + code}) ===`);
    processo = null;
  });
}

const servidor = http.createServer(async (req, res) => {
  // Só aceita a própria tela: um site aberto em outra aba não pode mandar
  // pedidos para cá (o navegador manda Origin nos POST/PUT de outro site).
  const origem = req.headers.origin;
  if (origem && origem !== URL.slice(0, -1) && origem !== `http://127.0.0.1:${PORTA}`) return responder(res, 403, { erro: 'origem recusada' });

  try {
    const u = new globalThis.URL(req.url, URL);
    if (req.method === 'GET' && u.pathname === '/') {
      return responder(res, 200, fs.readFileSync(path.join(PASTA, 'painel.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && u.pathname === '/api/dados') return responder(res, 200, lerDados());
    if (req.method === 'PUT' && u.pathname === '/api/dados') {
      if (processo) return responder(res, 409, { erro: 'Espere o agendamento em andamento terminar (ou pare) antes de salvar.' });
      const d = await lerCorpo(req);
      if (!d || !Array.isArray(d.veiculos) || typeof d.opcoes !== 'object') return responder(res, 400, { erro: 'dados inválidos' });
      fs.writeFileSync(ARQ_DADOS, JSON.stringify(d, null, 2));
      return responder(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/agendar') {
      if (processo) return responder(res, 409, { erro: 'Já tem um agendamento rodando.' });
      if (!fs.existsSync(ARQ_DADOS)) return responder(res, 400, { erro: 'Cadastre e salve ao menos um veículo.' });
      iniciar(await lerCorpo(req));
      return responder(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/parar') {
      if (processo) processo.kill();
      return responder(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/andamento') {
      const desde = Math.max(Number(u.searchParams.get('desde')) || 0, inicioLog);
      return responder(res, 200, { rodando: !!processo, inicio: inicioLog, proximo: inicioLog + linhas.length, linhas: linhas.slice(desde - inicioLog) });
    }
    responder(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    responder(res, 500, { erro: e.message });
  }
});

function abrirNavegador() {
  exec(`start "" "${URL}"`);
}

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Já aberto por um clique anterior: só mostra a tela.
    abrirNavegador();
    setTimeout(() => process.exit(0), 500);
  } else {
    console.error(e);
    process.exit(1);
  }
});

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`Agendamento Detran aberto em ${URL}`);
  console.log('Deixe esta janela aberta enquanto usa. Para encerrar, feche-a.');
  if (!process.argv.includes('--sem-navegador')) abrirNavegador();
});
