require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const pdfParse = require('pdf-parse');
const { PDFDocument: PDFLibDocument, StandardFonts: PDFLibStandardFonts, rgb } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-inseguro';
const MARKUP = 1.40;
// Grupos do catálogo que são gratuitos para o usuário: preço sempre R$ 0,00,
// independentemente do basePrice e de qualquer preço fixo cadastrado em
// user_service_prices (ver catalogPrice/getUserServicePrice). Hoje só a aba
// "Coisas de Despachantes" — são documentos que o próprio despachante emite,
// sem custo de API upstream, oferecidos como cortesia da plataforma.
const FREE_SERVICE_GROUPS = ['Para os Despachantes'];
const isFreeService = s => FREE_SERVICE_GROUPS.includes(s.group);
// ── Assinatura "Consulta placas" ─────────────────────────────────────────────
// Os serviços do grupo acima continuam sem debitar crédito, mas deixaram de ser
// abertos: só ficam liberados para quem tem assinatura ativa. O modelo é
// pré-pago e NÃO renova sozinho — cada período exige um novo PIX
// (ver POST /api/assinatura/pix e o cron /api/cron/assinaturas-expirar).
//
// Desde 22/09/2026 o período não é mais "30 dias contados do pagamento": ele
// vence sempre no dia 30, como a fatura do pós-pago, e por isso o preço e as
// cotas são pró-rata (ver cicloAssinatura, mais abaixo). Os dois valores aqui
// passaram a ser a REFERÊNCIA do mês cheio — R$ 30,00 por 30 dias é o que dá
// R$ 1,00 por dia —, não o que é cobrado em toda compra.
const ASSINATURA_PLACAS_PRICE = 30.00;
const ASSINATURA_PLACAS_DIAS  = 30;
// Cota de consultas de placa por período. Só a "Veicular Completa"
// consome cota — os três documentos do grupo não custam nada upstream, então
// são ilimitados para o assinante. A cota existe porque cada consulta de placa
// custa basePrice na Datacube: 50 consultas é o teto que mantém o plano
// previsível (ver ASSINATURA_PLACAS_SERVICE_ID).
const ASSINATURA_PLACAS_COTA  = 50;
const ASSINATURA_PLACAS_SERVICE_ID = 'assinatura-consulta-placas';
// Código de Segurança CRV incluído na mesma assinatura, com cota PRÓPRIA e
// menor: a consulta custa bem mais na Vistocar que a de placa, então ela não
// divide as 50 do plano — tem teto separado, contado em queries_used_crv.
const ASSINATURA_CRV_COTA = 5;
const ASSINATURA_CRV_SERVICE_ID = 'assinatura-codigo-seguranca-crv';
// Assinatura Digital (Assinafy) — terceira cota própria, pela mesma razão da do
// CRV: cada envio custa na Assinafy, então não pode dividir as 50 de placa.
// Teto de 5 por período, que ao custo de hoje (R$ 5,00 o envio) é o que cabe
// dentro dos R$ 30,00 do plano sem virar prejuízo.
const ASSINATURA_DIGITAL_COTA = 5;
const ASSINATURA_DIGITAL_SERVICE_ID = 'assinatura-digital';
// Verificar CRLV + Data CRV — quarta cota própria. Mesma razão das duas acima:
// cada consulta custa na despbrasil (R$ 1,90), então não pode dividir as 50 de
// placa. Teto de 5 por período, definido pelo dono junto com o serviço.
const ASSINATURA_VERIFICAR_CRLV_COTA = 5;
const ASSINATURA_VERIFICAR_CRLV_SERVICE_ID = 'assinatura-verificar-crlv-data-crv';
// Serviços que exigem assinatura ativa (todo o grupo "Para os Despachantes").
const ASSINATURA_SERVICE_IDS = [
  ASSINATURA_PLACAS_SERVICE_ID,
  ASSINATURA_CRV_SERVICE_ID,
  ASSINATURA_DIGITAL_SERVICE_ID,
  ASSINATURA_VERIFICAR_CRLV_SERVICE_ID,
  'declaracao-residencia-detran-rj',
  'nota-prestacao-servicos-despachante',
  'gerar-asd',
];
// Não há carência: a assinatura vale para todos os usuários, antigos e novos.
// Sem assinatura vigente, nenhum serviço do grupo roda — inclusive para quem já
// emitia os três documentos quando eram abertos.
// ── Pós-pago (fatura mensal) ─────────────────────────────────────────────────
// Cliente pós-pago consulta sem saldo: cada consulta entra na fatura do ciclo
// em vez de sair de users.credits (ver debitarConsulta). O vencimento é SEMPRE
// dia 30 — quando o admin liga o pós-pago no meio do mês, o primeiro ciclo é
// mais curto (pro rata natural: a fatura é o que foi consumido até o dia 30, e
// só isso). Mês com menos de 30 dias vence no último dia (fevereiro).
const POS_PAGO_DIA_VENCIMENTO = 30;
// Dias de tolerância depois do vencimento antes de bloquear novas consultas.
// Sem bloqueio nenhum o pós-pago vira crédito sem teto; bloquear no minuto
// seguinte ao vencimento derrubaria o cliente que paga no dia. Três dias é o
// meio-termo — mude aqui, é o único lugar.
const POS_PAGO_CARENCIA_DIAS = 3;
// Preço de tabela de um serviço do catálogo: basePrice + markup (ou basePrice
// puro quando noMarkup), e 0 quando o serviço está num grupo gratuito.
const catalogPrice = s =>
  isFreeService(s) ? 0 : parseFloat((s.basePrice * (s.noMarkup ? 1 : MARKUP)).toFixed(2));
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '')
  .split('').filter(c => c.charCodeAt(0) <= 127).join('').trim();
// Chave PÚBLICA do Mercado Pago: vai para o navegador (é ela que o Checkout
// Bricks usa para tokenizar o cartão). Sem ela o site fica só com PIX — ver
// GET /api/pagamento/config. O mesmo filtro de caracteres do access token
// evita que um espaço invisível colado do painel do MP quebre o header.
const MP_PUBLIC_KEY = (process.env.MP_PUBLIC_KEY || '')
  .split('').filter(c => c.charCodeAt(0) <= 127).join('').trim();
const MP_BASE = 'https://api.mercadopago.com';
const AUTOCRLV_KEY    = process.env.AUTOCRLV_KEY    || '';
const PORTAL_DESP_KEY = process.env.PORTAL_DESP_KEY || '';
const PORTAL_BASE_URL = 'https://portaldespachantes.online';
// CRLV-e do portaldespachantes.online que devolvem o PDF na hora e cujo id NÃO
// começa com "consultar-crlv-" — a regra de envio do PDF por WhatsApp usa esse
// prefixo, então estes precisam ser nomeados (ver PORTAL_PLACA_MAP).
const CRLV_PORTAL_PDF_SVCS = new Set([
  'crlv-rj-reemissao-2', 'crlv-pe-instantaneo', 'crlv-ce-instantaneo',
]);
// CRLV-e Agendado: POST /api/crlv-agendado/solicitar → pedido_id; GET
// /api/crlv-agendado/:id → status; GET .../:id/pdf. Todos no portal.
//
// O prefixo PORTAL- é histórico: quando o agendado existia em dois hosts, o
// pedido_id vinha como número simples nos dois e o "Ver Status" recebe só esse
// número digitado pelo cliente — sem marca não dava para saber a quem
// perguntar. Continua sendo aceito e removido antes de consultar, porque há
// pedidos gravados com ele (mesma convenção do "AUTOCRLV-", ver
// checkCrlvAgendadoStatus).
const PORTAL_PEDIDO_PREFIX = 'PORTAL-';
// "Solicitar" do CRLV-e Agendado. O "Ver Status" é outro fluxo e fica de fora.
const isAgendadoSolicitar = id =>
  id.startsWith('crlv-agendado-') && id !== 'crlv-agendado-status';
const DATACUBE_API_URL = 'https://api.consultasdeveiculos.com';
const DATACUBE_TOKEN   = process.env.DATACUBE_TOKEN || '';
const INFOSIMPLES_API_URL = 'https://api.infosimples.com/api/v2/consultas';
const INFOSIMPLES_TOKEN   = process.env.INFOSIMPLES_TOKEN || '';
const INFOSIMPLES_MARKUP  = 1.70;
const ZAPI_INSTANCE_ID   = process.env.ZAPI_INSTANCE_ID   || '';
const ZAPI_TOKEN         = process.env.ZAPI_TOKEN         || '';
const ZAPI_CLIENT_TOKEN  = process.env.ZAPI_CLIENT_TOKEN  || '';
const WEBHOOK_BASE_URL   = (process.env.WEBHOOK_BASE_URL  || '').replace(/\/$/, '');
const ADMIN_PHONE        = process.env.ADMIN_PHONE        || '';
// API consultasfacil.net (CRLV Rio Reemissão v2) — auth por header chaveAcesso
// (fixo); resposta é o PDF pronto em bytes (Content-Type: application/pdf).
const CONSULTASFACIL_BASE_URL = 'https://www.consultasfacil.net';
const CONSULTASFACIL_KEY      = process.env.CONSULTASFACIL_KEY || '';
// API despbrasil.com.br — auth por header chaveAcesso (fixo); resposta traz a URL
// do PDF pronto em "arquivo_url" (buscamos o arquivo no processCatalogQuery, ver
// DESPBRASIL_SVCS). Mapeia serviceId para o "servico" da despbrasil (campo "extra"
// opcional acrescenta dados ao payload além da placa).
const DESPBRASIL_BASE_URL = 'https://despbrasil.com.br/functions/apiConsulta';
const DESPBRASIL_KEY      = process.env.DESPBRASIL_KEY || '';
const DESPBRASIL_SVCS = {
  // SEM serviço no catálogo desde 10/09/2026 (a rota deles vive fora do ar).
  // A entrada fica porque fetchCodigoSegurancaPdfDespbrasil ainda a lê para
  // montar o fallback do consultar-Numero-ATPVE, quando a Vistocar falha.
  'security-code-vistocar':     { servico: 'codigo_seguranca', extra: { versao: 'v1' } },
  // Consulta Código Segurança CRV (PDF) do catálogo (grupo CRV). Mesmo serviço
  // da entrada acima, mas na versão v2 — que é a que responde hoje (conferida
  // contra a API real em 21/09/2026). A entrada 'security-code-vistocar' segue
  // aqui só por causa do fallback do consultar-Numero-ATPVE, que a lê direto.
  'codigo-seguranca-crv':       { servico: 'codigo_seguranca', extra: { versao: 'v2' } },
  // Número do CRV Digital: volta a vir SÓ da despbrasil em 25/09/2026, pelo
  // "consulta_generica" com o produto em nome_servico (conferido contra a API
  // real: placa TTT7A54, R$ 7,50, PDF com o número do CRV). De 15/09 a
  // 25/09/2026 o principal foi a Vistocar (apiclient/security-code-crv) com a
  // despbrasil de reserva — mas a rota da Vistocar recusou TODA placa o tempo
  // todo ("Placa não localizada no fornecedor Nobre") e quem entregava era
  // sempre a reserva. O id NÃO pode estar também no VISTOCAR_ENDPOINTS: nos
  // dois mapas, a requisição sairia com a chaveAcesso da despbrasil (o else-if
  // dela vem antes) e a resposta passaria pelo tratamento errado.
  //
  // A doc deles tem um "Número do CRV Digital V2" (placa + renavam, R$ 6,50),
  // mas em 25/09/2026 ele respondia "Serviço não encontrado ... a ApiConfig
  // precisa estar ATIVA" na nossa chave — por isso não entrou no catálogo.
  'numero-crv-digital': { servico: 'consulta_generica', extra: { nome_servico: 'Número do CRV Digital' } },
  'verificar-crlv':    { servico: 'verificar_crlv' },
  // Mesmo serviço da linha acima, id próprio: o "Verificar CRLV + Data CRV" do
  // grupo CRV monta um relatório diferente do mesmo JSON (ver
  // buildVerificarCrlvDataCrvPdfBuffer) e tem preço próprio.
  'verificar-crlv-data-crv': { servico: 'verificar_crlv' },
  'consulta-renavam':  { servico: 'consulta_renavam' },
  'consultar-Numero-ATPVE': { servico: 'numero_atpve' },
};

// ── Assinafy (assinafy.com.br) — assinatura digital de documentos ────────────
// Header X-Api-Key, envelope { status, message, data } em todas as respostas.
// A chave é um segredo de workspace COM ACESSO TOTAL e este repositório é
// PÚBLICO: ela só pode existir em variável de ambiente, nunca no código.
// O accountId é o id do workspace (My Account → Workspaces); vem do ambiente
// junto da chave porque as duas coisas andam em par — trocar de conta é trocar
// as duas.
const ASSINAFY_BASE_URL   = 'https://api.assinafy.com.br/v1';
const ASSINAFY_API_KEY    = process.env.ASSINAFY_API_KEY    || '';
const ASSINAFY_ACCOUNT_ID = process.env.ASSINAFY_ACCOUNT_ID || '';

// HeyGen: só o vídeo de apresentação (apresentadora + roteiro do tour da home),
// baixado pelo admin. Mesma regra da Assinafy: chave em variável de ambiente,
// nunca no código — o repositório é público.
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY || '';

// Ciclo de vida do documento na Assinafy (GET /v1/documents/statuses):
// uploading → uploaded → metadata_processing → metadata_ready → pending_signature
// → certificating → certificated. Só "certificated" tem documento assinado para
// baixar; "rejected_by_signer"/"rejected_by_user"/"expired"/"failed" encerram sem
// assinatura.
const ASSINAFY_STATUS_PRONTO   = 'certificated';
const ASSINAFY_STATUS_ENCERRADO = new Set(['rejected_by_signer', 'rejected_by_user', 'expired', 'failed']);

// Toda resposta vem embrulhada em { status, message, data } — inclusive os erros,
// que trazem a explicação em "message". Desembrulha aqui para o resto do código
// lidar só com o payload, e levanta erro com a mensagem deles quando falha.
async function assinafyReq(caminho, { method = 'GET', json, form } = {}) {
  if (!ASSINAFY_API_KEY || !ASSINAFY_ACCOUNT_ID)
    throw new Error('Assinatura Digital não configurada no servidor (ASSINAFY_API_KEY/ASSINAFY_ACCOUNT_ID).');
  const headers = { 'X-Api-Key': ASSINAFY_API_KEY };
  // form-data monta o próprio Content-Type com o boundary — definir o header na
  // mão aqui quebraria o upload.
  if (json) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${ASSINAFY_BASE_URL}${caminho}`, {
    method,
    headers,
    body: form || (json ? JSON.stringify(json) : undefined),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || (data.status && data.status >= 400)) {
    const msg = data?.message || `HTTP ${r.status}`;
    throw new Error(`Assinafy ${caminho}: ${msg}`);
  }
  return data.data;
}

// O PDF recém-enviado passa por metadata_processing antes de aceitar pedido de
// assinatura. Espera o documento ficar pronto em vez de disparar o assignment
// cedo demais e tomar erro — são poucos segundos na prática.
async function aguardarDocumentoPronto(documentId, tentativas = 12) {
  for (let i = 0; i < tentativas; i++) {
    const doc = await assinafyReq(`/documents/${encodeURIComponent(documentId)}`);
    const status = doc?.status || doc?.document?.status;
    if (status && !['uploading', 'uploaded', 'metadata_processing'].includes(status)) return status;
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// Fluxo completo do "Quick Start" da doc: sobe o PDF, cria o signatário e pede a
// assinatura. Método "virtual" = o signatário só confirma, sem campos para
// preencher (o "collect" exigiria posicionar campos no PDF, que o painel não tem
// como fazer). Devolve { documentId, signerId, assignmentId }.
// O signatário é ÚNICO por e-mail na conta: criar um que já existe devolve "Um
// signatário com este e-mail já existe". Como o mesmo comprador volta em vários
// documentos, reaproveitar é o caso comum, não a exceção — procura primeiro e só
// cria se não achar. A busca da Assinafy filtra por full_name OU email.
async function acharOuCriarSignatarioAssinafy({ nome, email, whatsapp }) {
  const procurar = async (termo) => {
    const lista = await assinafyReq(
      `/accounts/${ASSINAFY_ACCOUNT_ID}/signers?search=${encodeURIComponent(termo)}&per-page=100`);
    return Array.isArray(lista) ? lista : (lista?.data || []);
  };

  if (email) {
    const achados = await procurar(email).catch(() => []);
    const igual = achados.find(s => String(s.email || '').toLowerCase() === email);
    if (igual?.id) return igual.id;
  } else if (whatsapp) {
    // Sem e-mail só dá para procurar pelo nome, então o número tem que bater
    // exatamente — homônimo com outro WhatsApp não pode virar o mesmo cadastro.
    const achados = await procurar(nome).catch(() => []);
    const soDigitos = s => String(s || '').replace(/\D/g, '');
    const igual = achados.find(s => soDigitos(s.whatsapp_phone_number) === soDigitos(whatsapp));
    if (igual?.id) return igual.id;
  }

  const corpo = { full_name: nome };
  if (email)    corpo.email = email;
  if (whatsapp) corpo.whatsapp_phone_number = whatsapp;
  try {
    const signer = await assinafyReq(`/accounts/${ASSINAFY_ACCOUNT_ID}/signers`, { method: 'POST', json: corpo });
    const id = signer?.id || signer?.signer?.id;
    if (id) return id;
    throw new Error('Assinafy não devolveu o id do signatário.');
  } catch (e) {
    // Corrida ou cadastro antigo com nome diferente: se a recusa foi por já
    // existir, a busca por e-mail resolve.
    if (email && /já existe/i.test(e.message)) {
      const achados = await procurar(email).catch(() => []);
      const igual = achados.find(s => String(s.email || '').toLowerCase() === email);
      if (igual?.id) return igual.id;
    }
    throw e;
  }
}

async function enviarParaAssinaturaAssinafy({ pdfBuffer, nomeArquivo, nome, email, whatsapp }) {
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), nomeArquivo);
  const doc = await assinafyReq(`/accounts/${ASSINAFY_ACCOUNT_ID}/documents`, { method: 'POST', form });
  const documentId = doc?.id || doc?.document?.id;
  if (!documentId) throw new Error('Assinafy não devolveu o id do documento enviado.');

  try {
    const signerId = await acharOuCriarSignatarioAssinafy({ nome, email, whatsapp });

    await aguardarDocumentoPronto(documentId);

    // UM canal por signatário, não uma lista: mandar Email+Whatsapp junto é
    // recusado com "Apenas um método de notificação é permitido por signatário"
    // (a doc diz que aceita combinação; a API em produção, não). E-mail tem
    // preferência quando existe — é o canal que sempre funciona e não custa
    // extra; o WhatsApp, que exige plano pago, só entra quando é o único jeito
    // de avisar a pessoa. A verificação acompanha o mesmo canal.
    const canal = email ? 'Email' : 'Whatsapp';
    const assignment = await assinafyReq(`/documents/${encodeURIComponent(documentId)}/assignments`, {
      method: 'POST',
      json: {
        method: 'virtual',
        signers: [{ id: signerId, verification_method: canal, notification_methods: [canal] }],
      },
    });

    return { documentId, signerId, assignmentId: assignment?.id || null, canal };
  } catch (e) {
    // O PDF já subiu antes da falha. Sem isso ele fica órfão na conta da
    // Assinafy, ocupando lugar num documento que ninguém vai assinar.
    await assinafyReq(`/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' })
      .catch(err => console.error(`[assinatura-digital] não consegui apagar o documento órfão ${documentId}:`, err.message));
    throw e;
  }
}

// Busca o documento assinado quando ele estiver pronto. Devolve
// { pronto, encerrado, status, pdf } — pdf só vem com status certificated.
async function buscarDocumentoAssinadoAssinafy(documentId) {
  const doc = await assinafyReq(`/documents/${encodeURIComponent(documentId)}`);
  const status = doc?.status || doc?.document?.status || null;
  if (status !== ASSINAFY_STATUS_PRONTO)
    return { pronto: false, encerrado: ASSINAFY_STATUS_ENCERRADO.has(status), status, pdf: null };

  // O artefato "certificated" é o PDF assinado com a página de certificado.
  // Este download NÃO passa pelo assinafyReq: a resposta é o arquivo, não o
  // envelope JSON.
  const r = await fetch(`${ASSINAFY_BASE_URL}/documents/${encodeURIComponent(documentId)}/download/certificated`, {
    headers: { 'X-Api-Key': ASSINAFY_API_KEY },
  });
  if (!r.ok) return { pronto: false, encerrado: false, status, pdf: null };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.slice(0, 4).toString() !== '%PDF') {
    console.error(`[assinatura-digital] download de ${documentId} não veio como PDF.`);
    return { pronto: false, encerrado: false, status, pdf: null };
  }
  return { pronto: true, encerrado: false, status, pdf: buf };
}

// API Vistocar (vistocarconsulta.com.br) — login JWT (VISTOCAR_LOGIN/VISTOCAR_PASSWORD)
// + POST em apiclient/<endpoint> com Bearer, corpo { plate: "ABC1D23" } (campo em
// inglês, não "placa"). Devolvem JSON com PDF pronto em base64, menos os assíncronos
// (VISTOCAR_ASYNC_SVCS) e o débitos-cod-barra, que manda a lista de débitos em JSON.
const VISTOCAR_BASE_URL = 'https://vistocarconsulta.com.br/api/v1';
const VISTOCAR_LOGIN    = process.env.VISTOCAR_LOGIN    || '';
const VISTOCAR_PASSWORD = process.env.VISTOCAR_PASSWORD || '';

// Caminhos que atendem a notificação da Vistocar. O cadastrado na conta deles é
// o primeiro (com /api), e é o que registrarWebhookVistocar continua mandando;
// o segundo existe porque o endereço circula também sem o /api, e uma
// notificação que bate no caminho errado vira 404 — perda silenciosa de
// documento, já que a entrega passaria a depender só da varredura do cron.
// Os dois precisam estar aqui E no express.json (rawBody da assinatura).
const VISTOCAR_WEBHOOK_PATHS = ['/api/webhooks/vistocar', '/webhooks/vistocar'];
const VISTOCAR_ENDPOINTS = {
  'security-code-vistocar-2': 'security-code',
  // A rota security-code-crv (apesar do nome, a do NÚMERO do CRV) atendeu o
  // 'numero-crv-digital' de 15/09 a 25/09/2026 e recusou toda placa nesse
  // período; o serviço voltou para a despbrasil (ver DESPBRASIL_SVCS).
  'vistocar-debitos-cod-barra': 'debitos-cod-barra',
  'atpve-vistocar-rj': 'atpve-rj',
  'atpve-vistocar-mg': 'atpve-mg',
};

// ── Nome dos arquivos que vêm da Vistocar ────────────────────────────────────
// Todo PDF entregue por eles sai como "mcdespachadoria-<consulta>-<placa>.pdf".
// Antes o nome era o id interno do serviço ("security-code-vistocar-2-ABC1D23"),
// que não diz nada para o cliente que salva o documento no celular. Os nomes
// longos são abreviados na mão, um por serviço: o WhatsApp corta o nome do
// arquivo na bolha, e "codigo-de-seguranca-do-crv" já estouraria sozinho.
// Serviço fora deste mapa devolve null e mantém o nome que já tinha.
const VISTOCAR_ARQUIVO_NOMES = {
  'security-code-vistocar-2':        'cod-seguranca-crv',
  'assinatura-codigo-seguranca-crv': 'cod-seguranca-crv',
  // Hoje vem da despbrasil, mas mantém o nome que o cliente já conhece.
  'numero-crv-digital':              'numero-crv',
  'vistocar-debitos-cod-barra':      'debitos',
  'atpve-vistocar-rj':               'atpve-rj',
  'atpve-vistocar-mg':               'atpve-mg',
};
const MC_ARQUIVO_PREFIXO = 'mcdespachadoria';
function nomeArquivoVistocar(serviceId, sufixo) {
  const curto = VISTOCAR_ARQUIVO_NOMES[serviceId];
  if (!curto) return null;
  const fim = String(sufixo ?? '').replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
  return `${MC_ARQUIVO_PREFIXO}-${curto}${fim ? '-' + fim : ''}.pdf`;
}

// ATPV-e (Intenção de Venda) pela Vistocar — o único grupo do VISTOCAR_ENDPOINTS
// que NÃO manda { plate }: o corpo é o cadastro inteiro da venda (vendedor,
// comprador, veículo e três arquivos em base64), montado em montarCorpoAtpveVistocar.
// Vale para os dois estados; trocar de UF é só acrescentar a rota acima e o
// serviço no SERVICES, porque o contrato é idêntico (conferido em 15/09/2026
// contra atpve-rj e atpve-mg: a mesma lista de campos obrigatórios nos dois).
const VISTOCAR_ATPVE_SVCS = new Set(['atpve-vistocar-rj', 'atpve-vistocar-mg']);

// Serviços Vistocar ASSÍNCRONOS: o POST não devolve documento nenhum, só REGISTRA
// a consulta (devolve movementId + "CONSULTA PENDENTE") e o PDF chega depois em
// POST /api/webhooks/vistocar. Por isso não passam pelo tratamento de resposta com
// pdfBase64 dos demais e só são cobrados na entrega (ver finalizePendingQuery).
//
// O CE, que usava esse fluxo, passou para o CRLV-e Agendado do
// portaldespachantes.online; quem ocupa a lista hoje é o ATPV-e RJ/MG. O webhook
// e a entrega continuam de pé também para os pedidos antigos do CE em
// vistocar_pending, e habilitar outra UF continua sendo: rota em
// VISTOCAR_ENDPOINTS + serviço em SERVICES + id aqui.
const VISTOCAR_ASYNC_SVCS = new Set([...VISTOCAR_ATPVE_SVCS]);

// Cache do token JWT da Vistocar em memória do processo — o login devolve um token
// válido por 40 min (doc da Vistocar), então evitamos logar a cada consulta. Renova
// sozinho quando faltam menos de 2 min (margem de segurança), contando os 40 min a
// partir do login local em vez de parsear o campo "expiresIn" da resposta.
let vistocarToken = null;
let vistocarTokenExpiresAt = 0;
async function getVistocarToken() {
  if (vistocarToken && Date.now() < vistocarTokenExpiresAt) return vistocarToken;
  const r = await fetch(`${VISTOCAR_BASE_URL}/auth/apiclient/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: VISTOCAR_LOGIN, password: VISTOCAR_PASSWORD }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.data?.token) {
    throw new Error(data?.message || `Falha no login Vistocar (HTTP ${r.status}).`);
  }
  vistocarToken = data.data.token;
  vistocarTokenExpiresAt = Date.now() + 38 * 60 * 1000;
  return vistocarToken;
}

// ── ATPV-e Vistocar: montagem e validação do corpo ───────────────────────────
// A rota de ATPV-e aceita placa "XXXXXXX" e base64 "xx" sem reclamar: ela só
// para na PRIMEIRA checagem que falha e, quando tudo passa, REGISTRA o cadastro
// (e cobra o fornecedor). Por isso a validação daqui é mais dura que o normal —
// pedido malformado tem que morrer aqui, não lá. A ordem das checagens da API,
// levantada campo a campo em 15/09/2026, é: UF de emissão do CRV → UF/cidade da
// venda → documentos → endereço do comprador → anos → renavam.

const ATPVE_UFS_VALIDAS = new Set(['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']);

// Limite por arquivo enviado (CRLV-e e os dois comprovantes). 8 MB por anexo dá
// folga para PDF escaneado e ainda cabe nos 50mb do express.json com os três
// juntos, já contando o inchaço de 33% do base64.
const ATPVE_ANEXO_MAX_BYTES = 8 * 1024 * 1024;

// Aceita tanto data URL ("data:application/pdf;base64,JVBER...") quanto base64
// puro: o painel manda puro, mas um integrador desavisado manda a data URL
// inteira e o arquivo chegaria corrompido do outro lado, sem erro visível.
function limparAnexoBase64(valor) {
  return String(valor || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
}

function validarAnexoAtpve(valor, rotulo) {
  const b64 = limparAnexoBase64(valor);
  if (!b64) return { erro: `Anexe o ${rotulo}.` };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length < 100)
    return { erro: `O ${rotulo} não é um arquivo válido. Selecione o arquivo novamente.` };
  if (Math.floor(b64.length * 3 / 4) > ATPVE_ANEXO_MAX_BYTES)
    return { erro: `O ${rotulo} passa de 8 MB. Reduza o arquivo e tente de novo.` };
  return { b64 };
}

// DD/MM/AAAA (como o painel digita) ou AAAA-MM-DD já pronto → AAAA-MM-DD, que é
// o formato que a Vistocar devolve no eco do cadastro.
function dataBrParaIso(valor) {
  const s = String(valor || '').trim();
  let d, m, a;
  const br = s.match(/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (br)       { [, d, m, a] = br; }
  else if (iso) { [, a, m, d] = iso; }
  else return null;
  const dt = new Date(`${a}-${m}-${d}T12:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.getUTCDate() !== Number(d) || dt.getUTCMonth() + 1 !== Number(m))
    return null;
  return `${a}-${m}-${d}`;
}

// "10.000,00", "10000.00" e 10000 viram 10000. Havendo vírgula, ela é a decimal
// e os pontos são de milhar (é assim que o campo é digitado em português). Sem
// vírgula o ponto é ambíguo: "10000.50" é decimal, mas "1.234" é milhar — o
// desempate é o formato de milhar inteiro (grupos exatos de 3 dígitos), porque
// tratar "1.234" como um real e vinte e três seria errar o valor da venda.
function valorVendaParaNumero(valor) {
  let s = String(valor ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// Troca os três anexos em base64 por uma marca curta, para o pedido caber em
// queries.params e na mensagem do admin sem carregar os megabytes do arquivo.
const ATPVE_CAMPOS_ANEXO = ['crlvePdfBase64', 'comprovanteEnderecoVendedor', 'comprovanteEnderecoComprador'];
function paramsSemAnexosAtpve(params) {
  const limpo = { ...(params || {}) };
  for (const campo of ATPVE_CAMPOS_ANEXO) {
    if (!limpo[campo]) continue;
    const kb = Math.round(limparAnexoBase64(limpo[campo]).length * 3 / 4 / 1024);
    limpo[campo] = `[arquivo enviado — ${kb} KB]`;
  }
  return limpo;
}

// Devolve { body } ou { erro } — nunca as duas coisas. O tipo de pessoa é
// deduzido do documento (11 dígitos = F, 14 = J), como no "venda" da comunicação
// de venda: o cliente não escolhe pessoa física/jurídica numa aba à parte.
function montarCorpoAtpveVistocar(service, params) {
  const p = params || {};
  const txt   = v => String(v ?? '').trim();
  const dig   = v => txt(v).replace(/\D/g, '');
  const uf    = v => txt(v).toUpperCase().slice(0, 2);
  const ufCrv = (service.uf || '').toUpperCase();

  const placa = txt(p.placa).toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa))
    return { erro: 'Placa inválida. Informe no formato ABC1D23 ou ABC1234.' };

  const renavam = dig(p.renavam);
  if (renavam.length < 9 || renavam.length > 11)
    return { erro: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' };

  const anoFabricacao = dig(p.anoFabricacao);
  const anoModelo     = dig(p.anoModelo);
  if (!/^\d{4}$/.test(anoFabricacao)) return { erro: 'Ano de fabricação inválido. Informe os 4 dígitos.' };
  if (!/^\d{4}$/.test(anoModelo))     return { erro: 'Ano do modelo inválido. Informe os 4 dígitos.' };

  const dataVenda = dataBrParaIso(p.dataVenda);
  if (!dataVenda) return { erro: 'Data da venda inválida. Use o formato DD/MM/AAAA.' };
  const valorVenda = valorVendaParaNumero(p.valorVenda);
  if (valorVenda === null) return { erro: 'Valor da venda inválido. Informe um valor maior que zero.' };

  const ufVenda = uf(p.ufVenda) || ufCrv;
  if (!ATPVE_UFS_VALIDAS.has(ufVenda)) return { erro: 'UF do local da venda inválida.' };
  const cidadeVenda = txt(p.cidadeVenda);
  if (!cidadeVenda) return { erro: 'Informe a cidade do local da venda.' };

  const documentoVendedor  = dig(p.documentoVendedor);
  const documentoComprador = dig(p.documentoComprador);
  if (documentoVendedor.length !== 11 && documentoVendedor.length !== 14)
    return { erro: 'CPF/CNPJ do vendedor inválido. Informe 11 dígitos (CPF) ou 14 (CNPJ).' };
  if (documentoComprador.length !== 11 && documentoComprador.length !== 14)
    return { erro: 'CPF/CNPJ do comprador inválido. Informe 11 dígitos (CPF) ou 14 (CNPJ).' };
  const nomeVendedor  = txt(p.nomeVendedor);
  const nomeComprador = txt(p.nomeComprador);
  if (nomeVendedor.length  < 3) return { erro: 'Informe o nome (ou razão social) do vendedor.' };
  if (nomeComprador.length < 3) return { erro: 'Informe o nome (ou razão social) do comprador.' };

  const cepComprador = dig(p.cepComprador);
  if (cepComprador.length !== 8) return { erro: 'CEP do comprador inválido. Informe os 8 dígitos.' };
  const logradouroComprador = txt(p.logradouroComprador);
  const numeroComprador     = txt(p.numeroComprador);
  const bairroComprador     = txt(p.bairroComprador);
  const cidadeComprador     = txt(p.cidadeComprador);
  const ufComprador         = uf(p.ufComprador);
  if (!logradouroComprador) return { erro: 'Informe o logradouro do comprador.' };
  if (!numeroComprador)     return { erro: 'Informe o número do endereço do comprador (se não houver, informe S/N).' };
  if (!bairroComprador)     return { erro: 'Informe o bairro do comprador.' };
  if (!cidadeComprador)     return { erro: 'Informe a cidade do comprador.' };
  if (!ATPVE_UFS_VALIDAS.has(ufComprador)) return { erro: 'UF do comprador inválida.' };

  const crlve       = validarAnexoAtpve(p.crlvePdfBase64, 'CRLV-e em PDF');
  if (crlve.erro) return { erro: crlve.erro };
  const compVend    = validarAnexoAtpve(p.comprovanteEnderecoVendedor, 'comprovante de endereço do vendedor');
  if (compVend.erro) return { erro: compVend.erro };
  const compCompr   = validarAnexoAtpve(p.comprovanteEnderecoComprador, 'comprovante de endereço do comprador');
  if (compCompr.erro) return { erro: compCompr.erro };

  // Campos do CRV impresso: a API aceita sem eles, e nem todo veículo tem CRV em
  // papel (CRV digital), então ficam opcionais — só vão quando preenchidos.
  const dataEmissaoCrv = p.dataEmissaoCrv ? dataBrParaIso(p.dataEmissaoCrv) : null;
  if (p.dataEmissaoCrv && !dataEmissaoCrv)
    return { erro: 'Data de emissão do CRV inválida. Use o formato DD/MM/AAAA.' };

  const body = {
    placa, renavam, dataVenda, valorVenda,
    cidadeVenda, ufVenda, ufEmissaoCrv: ufCrv,
    anoFabricacao, anoModelo,
    tipoPessoaVendedor:  documentoVendedor.length === 14 ? 'J' : 'F',
    documentoVendedor, nomeVendedor,
    tipoPessoaComprador: documentoComprador.length === 14 ? 'J' : 'F',
    documentoComprador, nomeComprador,
    cepComprador, logradouroComprador, numeroComprador, bairroComprador,
    cidadeComprador, ufComprador,
    crlvePdfBase64: crlve.b64,
    comprovanteEnderecoVendedor: compVend.b64,
    comprovanteEnderecoComprador: compCompr.b64,
  };
  const opcionais = {
    complementoComprador: txt(p.complementoComprador),
    emailVendedor: txt(p.emailVendedor),
    emailComprador: txt(p.emailComprador),
    chassi: txt(p.chassi).toUpperCase(),
    kilometragem: dig(p.kilometragem),
    numeroCrv: dig(p.numeroCrv),
    codigoSegurancaCrv: dig(p.codigoSegurancaCrv),
    numeroViaCrv: dig(p.numeroViaCrv),
    dataEmissaoCrv,
  };
  for (const [k, v] of Object.entries(opcionais)) if (v) body[k] = v;
  return { body };
}

// Prefixa o DDI 55 (Brasil) quando ausente. Não dá pra decidir isso olhando só
// se os dígitos "começam com 55" — DDD 55 (Santa Maria/RS) é válido e colide
// com o próprio DDI, o que fazia o número de usuários dessa região sair sem o
// DDI (ex.: "(55) 21995-6964" virava "55219956964", 11 dígitos, um número
// inexistente na Z-API — o WhatsApp nunca era enviado, sem erro visível).
// Números completos com DDI têm 12 (fixo) ou 13 (celular) dígitos; sem DDI,
// telefones brasileiros têm no máximo 11 (DDD + celular de 9 dígitos) — por
// isso o corte é pelo tamanho, não pelo prefixo.
function formatWhatsAppPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 12 ? digits : `55${digits}`;
}

async function sendWhatsApp(phone, message) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !phone) return false;
  const formatted = formatWhatsAppPhone(phone);
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {}),
        },
        body: JSON.stringify({ phone: formatted, message }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Z-API erro [${formatted}]:`, JSON.stringify(d)); return false; }
    console.log(`✅ WhatsApp enviado para ${formatted}`);
    return true;
  } catch (err) {
    console.error('Erro ao enviar WhatsApp:', err.message);
    return false;
  }
}

async function notifyAdminNewQuery(user, service, price, params) {
  if (!ADMIN_PHONE) return;
  const placa = (params?.placa || '').toUpperCase();
  const msg = [
    `🔔 *Nova consulta na plataforma*`,
    ``,
    `🧾 *Serviço:* ${service.name}`,
    `👤 *Cliente:* ${user.name || '-'}`,
    ...(user.email ? [`✉️ *E-mail:* ${user.email}`] : []),
    ...(placa ? [`🔤 *Placa:* ${placa}`] : []),
    `💰 *Valor:* R$ ${price.toFixed(2).replace('.', ',')}`,
  ].join('\n');
  await sendWhatsApp(ADMIN_PHONE, msg).catch(() => {});
}

async function sendWhatsAppPdf(phone, pdfBuffer, fileName, caption) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !phone) return false;
  const formatted = formatWhatsAppPhone(phone);
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-document/pdf`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {}),
        },
        body: JSON.stringify({
          phone: formatted,
          document: `data:application/pdf;base64,${pdfBuffer.toString('base64')}`,
          fileName,
          caption,
        }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Z-API PDF erro [${formatted}]:`, JSON.stringify(d)); return false; }
    console.log(`✅ WhatsApp PDF enviado para ${formatted}`);
    return true;
  } catch (err) {
    console.error('Erro ao enviar WhatsApp PDF:', err.message);
    return false;
  }
}

async function sendWhatsAppImage(phone, base64Png, caption) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !phone) return false;
  const formatted = formatWhatsAppPhone(phone);
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-image`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {}),
        },
        body: JSON.stringify({
          phone: formatted,
          image: `data:image/png;base64,${base64Png}`,
          caption,
        }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Z-API imagem erro [${formatted}]:`, JSON.stringify(d)); return false; }
    console.log(`✅ WhatsApp imagem enviada para ${formatted}`);
    return true;
  } catch (err) {
    console.error('Erro ao enviar WhatsApp imagem:', err.message);
    return false;
  }
}

async function mpReq(method, endpoint, body = null, extraHeaders = {}) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${MP_BASE}${endpoint}`, opts);
  const data = await r.json();
  if (!r.ok) {
    const msg = data.message || data.error || data.cause?.[0]?.description || 'Erro Mercado Pago';
    // Status e código do gateway viajam no próprio Error para quem chama poder
    // distinguir "credencial recusada" de "payload inválido" sem reparsear a
    // string da mensagem (ver isMpCredencialErro / mpErroAmigavel).
    const err = new Error(msg);
    err.mpStatus   = r.status;
    err.mpCode     = data.code || data.error || '';
    err.mpEndpoint = endpoint;
    throw err;
  }
  return data;
}

// Estorno total do PIX pago no Mercado Pago — usado quando o pagamento de um
// pedido avulso (public_orders) foi aprovado mas a consulta em si falhou
// depois (upstream fora do ar, dado inválido etc.): o cliente não deve ficar
// cobrado por uma consulta que não recebeu. Idempotency-Key evita duplicar o
// estorno em caso de retry de rede.
async function mpRefundPayment(paymentId) {
  await mpReq('POST', `/v1/payments/${paymentId}/refunds`, {}, { 'X-Idempotency-Key': `refund-${paymentId}` });
}

// ── Falha de credencial do Mercado Pago ──────────────────────────────────────
// Quando a conta/aplicação perde autorização para criar pagamentos, o gateway
// responde 401/403 com um texto em inglês do próprio PolicyAgent ("At least one
// policy returned UNAUTHORIZED.", code PA_UNAUTHORIZED_RESULT_FROM_POLICIES).
// Esse texto vazava direto para a tela do cliente, que não entende a mensagem e
// ainda fica achando que errou algum dado. Aqui ele vira um aviso em pt-BR e o
// admin é notificado, porque nesse estado NENHUMA cobrança nova é gerada.
const MP_CREDENCIAL_MSG =
  'Pagamento via PIX temporariamente indisponível: o gateway recusou a geração '
  + 'da cobrança. Nossa equipe já foi avisada — tente novamente em alguns '
  + 'minutos ou fale com o suporte.';

function isMpCredencialErro(err) {
  if (err?.mpStatus === 401 || err?.mpStatus === 403) return true;
  const txt = `${err?.mpCode || ''} ${err?.message || ''}`;
  return /PA_UNAUTHORIZED_RESULT_FROM_POLICIES|policy returned UNAUTHORIZED/i.test(txt);
}

function mpErroAmigavel(err, fallback) {
  if (isMpCredencialErro(err)) return MP_CREDENCIAL_MSG;
  return err?.message || fallback;
}

// Throttle do alerta: uma credencial recusada derruba todas as cobranças de uma
// vez, então sem janela um pico de tentativas viraria dezenas de mensagens no
// WhatsApp. A janela vive em memória — na Vercel isso limita a um alerta por
// hora por instância, o que já basta para não virar spam.
let ultimoAlertaMpCredencial = 0;
const ALERTA_MP_INTERVALO_MS = 60 * 60 * 1000;

async function alertAdminPixFalha(err, contexto) {
  if (!isMpCredencialErro(err) || !ADMIN_PHONE) return;
  const agora = Date.now();
  if (agora - ultimoAlertaMpCredencial < ALERTA_MP_INTERVALO_MS) return;
  ultimoAlertaMpCredencial = agora;
  const msg = [
    '🚨 *PIX fora do ar — credencial do Mercado Pago recusada*',
    '',
    `📍 *Origem:* ${contexto}`,
    `🔢 *HTTP:* ${err.mpStatus || '-'}`,
    `🏷️ *Código:* ${err.mpCode || '-'}`,
    `💬 *Mensagem:* ${err.message}`,
    '',
    'Nenhuma cobrança nova está sendo gerada. Confira pendências cadastrais e '
      + 'as credenciais da aplicação no painel do Mercado Pago.',
  ].join('\n');
  await sendWhatsApp(ADMIN_PHONE, msg).catch(() => {});
}

const SERVICES = [
  // ── Consultas Básicas ──
  { id:'base-estadual',          name:'Base Estadual',              group:'Consultas Básicas', basePrice:7.00,   inputType:'placa',       icon:'🚗' },
  { id:'base-nacional',          name:'Base Nacional',              group:'Consultas Básicas', basePrice:7.00,   inputType:'placa',       icon:'🗺️' },
  { id:'consulta-cautelar',      name:'Consulta Cautelar VIP GOLD', group:'Consultas Básicas', basePrice:19.99,  inputType:'placa',       icon:'🔍' },
  { id:'consultar-autovistoria', name:'Auto Quilometragem',         group:'Consultas Básicas', basePrice:7.50,   inputType:'placa',       icon:'⚡' },
  { id:'consultar-placa-v2',     name:'Proprietário Atual (v2)',    group:'Consultas Básicas', basePrice:7.50,   inputType:'placa',       icon:'🔍' },
  { id:'consultar-placa-fipe',   name:'Consulta FIPE',              group:'Consultas Básicas', basePrice:0.00,   inputType:'placa',       icon:'💰' },
  { id:'consultar-foto-leilao',  name:'Foto Leilão',                group:'Consultas Básicas', basePrice:10.00,  inputType:'placa',       icon:'📸' },
  { id:'consultar-chassi-v2',    name:'Consulta Chassi',            group:'Consultas Básicas', basePrice:7.50,   inputType:'chassi',      icon:'🔑' },
  // API Datacube (form-urlencoded) — valor fixo de R$3,00, ver bloco dc-decodificar-motor em /api/query.
  { id:'dc-decodificar-motor',   name:'Decodificação de Motor',     group:'Consultas Básicas', basePrice:3.00,   noMarkup:true, inputType:'motor', icon:'🔧', dcPath:'/veiculos/decodificar-motor' },
  // API despbrasil.com.br (serviço "verificar_crlv") — ver DESPBRASIL_SVCS.
  { id:'verificar-crlv',         name:'Verificar CRLV e Último Licenciamento', group:'Consultas Básicas', basePrice:3.00, noMarkup:true, inputType:'placa', icon:'📑' },
  // API despbrasil.com.br (serviço "consulta_renavam") — ver DESPBRASIL_SVCS.
  { id:'consulta-renavam',       name:'Consulta RENAVAM',                     group:'Consultas Básicas', basePrice:3.00, noMarkup:true, inputType:'placa', icon:'🧾' },
  // ── Débitos e Documentação ──
  { id:'consulta-debitos-portal',          name:'Consulta de Débitos',          group:'Débitos e Documentação', basePrice:1.0714, inputType:'placa',       icon:'💳' },
  { id:'consultar-licenciamento',         name:'Licenciamento + BIN',          group:'Débitos e Documentação', basePrice:10.00, inputType:'placa',        icon:'📋' },
  { id:'consultar-gravame',               name:'Consulta Gravame',             group:'Débitos e Documentação', basePrice:7.50,  inputType:'placa',        icon:'🏦' },
  { id:'consultar-historico-proprietario',name:'Histórico de Proprietários',   group:'Débitos e Documentação', basePrice:9.99,  inputType:'placa',        icon:'👥' },
  { id:'renajud',                         name:'RENAJUD',                      group:'Débitos e Documentação', basePrice:9.50,  inputType:'placa',        icon:'⚖️' },
  { id:'consultar-atpve',                 name:'Reemissão ATPV-e (Chassi)',    group:'Débitos e Documentação', basePrice:13.50, inputType:'chassi',        icon:'📄' },
  { id:'consultar-atpve-v1',             name:'Reemissão ATPV-e (Placa)',     group:'Débitos e Documentação', basePrice:13.50, inputType:'placa_renavam', icon:'📄' },
  // Preço reajustado (era R$25,00 base / R$35,00 final, depois R$99,00): a
  // consulta encadeia mais TRÊS consultas pagas (Proprietário Atual v2 via
  // portal, Consulta 3 Código Segurança CRV via Vistocar e Consulta Comunicado
  // via portal) pra completar os campos que a despbrasil não retorna ou
  // retorna errado — ver runNumeroAtpveSupplementaryQueries. Preço fixo
  // (noMarkup) cobrindo o custo das 4 consultas + margem.
  { id:'consultar-Numero-ATPVE',          name:'Reemissão da ATPVe Com Comunicação de Venda', group:'Débitos e Documentação', basePrice:120.00, noMarkup:true, inputType:'placa', icon:'🔢',
    // noteStyle:'danger' — o aviso vira termo de aceite (fundo/texto vermelho no
    // painel), porque a limitação do QR Code precisa ser lida antes de consultar.
    slowNote:'ATENÇÃO, ao inserir a placa você concorda com os termos: "Devido ao formato como esta ATPVe é gerada, o QR Code não faz leitura — todas as demais informações deste documento são reais. Fica a seu critério."',
    noteStyle:'danger',
    modeloUrl:'/assets/modelo-atpve.pdf' },
  { id:'consultar-comunicado',            name:'Consulta Comunicado',          group:'Débitos e Documentação', basePrice:7.50,  inputType:'placa_renavam',icon:'📝' },
  // API Datacube (form-urlencoded) — movido da Opção 2 (grupo Cadastros) para valor
  // fixo de R$5,00, noMarkup:true. O PDF é montado a partir do JSON retornado (ver
  // buildLocalizacaoCpfPdfBuffer).
  { id:'dc-cadastro-localizacao-cpf',     name:'Localização CPF',              group:'Débitos e Documentação', basePrice:5.00, noMarkup:true, inputType:'dc_cpf', icon:'📍', dcPath:'/pessoas/localizacao' },
  // Localização CPF V3 — também movida da Opção 2 (grupo Cadastros), mesmo relatório
  // em PDF da Localização CPF acima (buildLocalizacaoCpfPdfBuffer), valor fixo R$8,00.
  { id:'dc-cadastro-localizacao-v3',      name:'Localização CPF V3',           group:'Débitos e Documentação', basePrice:8.00, noMarkup:true, inputType:'dc_cpf', icon:'📍', dcPath:'/pessoas/localizacao_v3' },
  // CNH Consulta Nacional - Completa V3 — API Datacube (POST form-urlencoded
  // com auth_token + cpf, doc de 10/09/2026). Diferente das dc-cnh-<uf>, que
  // pedem dados extras por estado, esta resolve só com o CPF — por isso usa o
  // inputType 'dc_cpf' e o case de mesmo nome no switch da CNH. Resposta JSON
  // (status + result), sem PDF. Valor fixo de R$ 12,00 (noMarkup).
  { id:'dc-cnh-nacional-v3',              name:'CNH Consulta Nacional - Completa V3', group:'Débitos e Documentação', basePrice:12.00, noMarkup:true, inputType:'dc_cpf', icon:'🪪', dcPath:'/cnh/nacional_completa_v3' },
  // API Vistocar (vistocarconsulta.com.br) — auth JWT (ver VISTOCAR_ENDPOINTS);
  // devolve um relatório JSON com a
  // lista de débitos (multas, IPVA etc.) já com código de barras/linha digitável do
  // boleto pronto para pagamento, sem PDF pronto — montado a partir do JSON por
  // buildDebitosCodBarraPdfBuffer. Valor fixo (noMarkup) definido pelo usuário.
  //
  // O aviso é termo de aceite (noteStyle 'danger'), não observação: débito que o
  // órgão ainda não colocou em cobrança (statusPagamento 'notice', "aviso de
  // cobrança") vem SEM linha digitável e SEM código de barras, e a consulta é
  // cobrada assim mesmo — decisão do cliente. Sem esse texto antes do envio, o
  // relatório sem código de pagamento parece consulta quebrada (ver o aviso
  // equivalente dentro do PDF, em buildDebitosCodBarraPdfBuffer).
  { id:'vistocar-debitos-cod-barra',      name:'Débitos + Código de Barras',    group:'Débitos e Documentação', basePrice:8.00, noMarkup:true, inputType:'placa', icon:'💳',
    noteStyle:'danger',
    slowNote:'Só sai para pagamento de Multas. A linha digitável e o código de barras só existem depois que o órgão abre a cobrança do débito: multa que ainda está em "aviso de cobrança" vem sem código de pagamento, e a consulta é cobrada mesmo assim. Ao continuar, você concorda com essa condição.' },
  // ── Procurações e Contratos ──
  // Gerar Contrato de Aluguel — mesmo padrão em duas etapas da Declaração de
  // Residência acima: o front busca o nome do Locatário e do Locador via
  // Localização CPF V3 (POST /api/contrato-aluguel/localizar, sem custo, uma
  // chamada por parte), o usuário confere/edita, e só ao clicar "Gerar
  // Contrato" esse serviço é submetido normalmente por /api/query (ver bloco
  // serviceId === 'contrato-aluguel' em processCatalogQuery) — o contrato em
  // si é montado do zero (não é overlay de PDF oficial, ver
  // buildContratoAluguelPdfBuffer), com o modelo padrão de Locação de Imóvel
  // Urbano (Lei nº 8.245/91). Preço fixo cobrindo as 2 consultas de
  // Localização CPF V3 usadas para pré-preencher o formulário.
  { id:'contrato-aluguel', name:'Gerar Contrato de Aluguel', group:'Procurações e Contratos', basePrice:16.00, noMarkup:true, inputType:'contrato_aluguel', icon:'📜' },
  // Gerar Procuração Veicular — mesmo padrão em duas etapas acima, mas com uma
  // particularidade: a Placa + Proprietário Atual (Datacube, mesmo endpoint da
  // aba "Opção 2 Nova Consulta", ver dc-proprietario-atual em SERVICES_V2)
  // pré-preenche o OUTORGANTE (nome, CPF/CNPJ e endereço vêm junto do
  // proprietário atual do veículo — endereço com fallback pra Veicular
  // Completa/Vistocar quando ausente) e os dados do veículo, enquanto o
  // CPF/CNPJ digitado + Localização CPF V3 pré-preenche o OUTORGADO (quem vai
  // representar o OUTORGANTE) — ver POST /api/procuracao-veicular/localizar-placa
  // e /localizar-cpf (ambos sem custo, 3 endpoints upstream no total) e
  // buildProcuracaoVeicularPdfBuffer (modelo padrão de procuração, sem
  // overlay de PDF oficial). Preço fixo cobrindo os 3 endpoints usados.
  { id:'procuracao-veicular', name:'Gerar Procuração Veicular', group:'Procurações e Contratos', basePrice:22.00, noMarkup:true, inputType:'procuracao_veicular', icon:'🖊️' },
  // ── Para os Despachantes ──────────────────────────────────────────────────
  // Grupo exclusivo da aba "Coisas de Despachantes" do painel (ver
  // section-despachantes em painel-usuario.html): documentos que o próprio
  // despachante emite para o cliente dele, não consultas veiculares. Fica fora
  // do grid de categorias da aba "Acesse Aqui Para as Principais Consultas".
  //
  // Todo o grupo é GRATUITO (ver FREE_SERVICE_GROUPS/catalogPrice): basePrice 0,
  // nada é debitado e nem preço fixo cadastrado no admin cobra. Os basePrice
  // antigos ficam registrados nos comentários de cada item caso volte a cobrar.
  //
  // A ORDEM DESTE GRUPO IMPORTA: o painel lista os serviços na ordem do
  // catálogo (ver buildDespachantesList), e a "Veicular Completa" vem
  // primeiro de propósito — é ela que libera os três documentos abaixo.
  //
  // Veicular Completa — consulta de placa exclusiva da aba, servida
  // pelo MESMO endpoint Datacube da "Proprietário Atual" da Opção 2
  // (/veiculos/proprietario-atual) e pelo mesmo builder de PDF. É um serviço
  // separado de propósito: a "dc-proprietario-atual" continua exatamente como
  // está (crédito por consulta, aba Opção 2), enquanto esta aqui não debita
  // crédito nenhum — é paga pela assinatura mensal e consome cota
  // (ver ASSINATURA_PLACAS_COTA e o bloco deste serviceId em processCatalogQuery).
  // slowNote + modeloUrl: o painel mostra o aviso com um link para o PDF de
  // exemplo (assets/modelo-consulta-placas.pdf), para o despachante ver o que
  // recebe antes de assinar. O mesmo link aparece no popup da assinatura.
  // O nome exibido é "Veicular Completa" — o id e o nome do plano continuam
  // "assinatura-consulta-placas" de propósito: mexer no id quebraria o histórico
  // já gravado em queries/transactions e a coluna subscriptions.plan.
  { id:'assinatura-consulta-placas', name:'Veicular Completa', group:'Para os Despachantes', basePrice:0, noMarkup:true, inputType:'placa', icon:'🔎',
    slowNote:'Consulta de proprietário atual pela placa, com retorno em PDF no padrão MC Despachadoria. Incluída na Assinatura Coisas de Despachantes.',
    modeloUrl:'/assets/modelo-consulta-placas.pdf', modeloLabel:'Veja modelo da consulta' },
  // Código de Segurança CRV incluído na assinatura — mesmo desenho do item acima:
  // usa a MESMA API do "Consulta 3 Código Segurança CRV (PDF)" pago (Vistocar
  // security-code, ver VISTOCAR_ENDPOINTS), mas como serviço separado, para o
  // security-code-vistocar-2 seguir intocado no grupo CRV (crédito por consulta,
  // aba Nova Consulta). Não debita crédito: quem paga é a assinatura, e o custo
  // do período é limitado pela cota própria (ver ASSINATURA_CRV_COTA e o bloco
  // deste serviceId em processCatalogQuery).
  { id:'assinatura-codigo-seguranca-crv', name:'Consulta 3 Código Segurança CRV (PDF)', group:'Para os Despachantes', basePrice:0, noMarkup:true, inputType:'placa', icon:'🔐',
    slowNote:`Código de segurança do CRV em PDF. Incluído na Assinatura Coisas de Despachantes, com cota própria de ${ASSINATURA_CRV_COTA} consultas por período.` },
  // Gerar Declaração de Residência DETRAN RJ — fluxo em duas etapas, fora do padrão
  // padrão "chama upstream e cobra" dos demais serviços: primeiro o front busca dados
  // via Localização CPF V3 pra pré-preencher um formulário editável (POST
  // /api/declaracao-residencia/localizar, sem custo), o usuário confere/edita e só
  // ao clicar "Gerar Declaração" esse serviço é submetido normalmente por /api/query
  // (ver isDeclaracaoResidencia em processCatalogQuery) — os campos do form já vêm
  // prontos nos params, sem nova chamada upstream, e o PDF é sobreposto no template
  // oficial (ver buildDeclaracaoResidenciaPdfBuffer).
  // Gratuito (antes R$ 8,00).
  { id:'declaracao-residencia-detran-rj', name:'Gerar Declaração de Residência DETRAN RJ', group:'Para os Despachantes', basePrice:0, noMarkup:true, inputType:'declaracao_residencia', icon:'🏠' },
  // Gerar Nota de Prestação de Serviços Para Despachantes Rio — mesmo padrão dos
  // itens acima: o usuário digita livremente a Matrícula (CRDD-UF), os dados
  // do Prestador (despachante) e do Tomador (cliente), e a Discriminação dos
  // Serviços Prestados (texto livre com itens/valores/total, reproduzido como
  // veio — sem parsear nem calcular), e só ao clicar "Gerar Nota" esse serviço
  // é submetido normalmente por /api/query (ver bloco serviceId ===
  // 'nota-prestacao-servicos-despachante' em processCatalogQuery) — a nota é
  // montada do zero no padrão de Nota de Serviços Eletrônica de despachante,
  // sem overlay de PDF oficial (ver buildNotaPrestacaoServicosPdfBuffer).
  // Gratuito (antes R$ 1,00).
  { id:'nota-prestacao-servicos-despachante', name:'Nota de Prestação de Serviços Para Despachantes Rio', group:'Para os Despachantes', basePrice:0, noMarkup:true, inputType:'nota_prestacao_servicos', icon:'🧾' },
  // Gerar ASD RJ (Anotação de Serviço Documental) — reproduz o formulário
  // oficial em papel do CRDD-RJ (ver ASD_FAIXAS/buildAsdPdfBuffer), identificando
  // o serviço contratado, o profissional responsável e o beneficiário. Mesmo
  // padrão em duas etapas da Procuração Veicular e usa exatamente os mesmos 3
  // endpoints de pré-preenchimento (sem custo, sem nova chamada upstream no
  // /api/query): Localização CPF V3 para o Profissional e para o Beneficiário
  // (POST /api/procuracao-veicular/localizar-cpf, uma chamada por parte) e
  // Proprietário Atual para os dados do veículo a partir da placa (POST
  // /api/procuracao-veicular/localizar-placa). As duas digitalizações da
  // carteirinha (frente/verso) chegam como data URL nos params e ocupam a metade
  // de baixo da mesma folha, no espaço que o formulário reserva para elas.
  // Gratuito (antes R$ 9,50).
  { id:'gerar-asd', name:'Gerar ASD RJ', group:'Para os Despachantes', basePrice:0, noMarkup:true, inputType:'asd', icon:'📑' },
  // Assinatura Digital (Assinafy) — o único do grupo que NÃO gera documento: ele
  // manda um PDF que o cliente já tem para alguém assinar. Serve para qualquer
  // PDF, inclusive os que a própria aba gera (Declaração de Residência, ASD,
  // Nota de Prestação de Serviços) — é o fecho natural deles.
  // Gratuito como o resto do grupo, mas com cota própria: diferente da
  // Declaração e da ASD, cada envio custa dinheiro na Assinafy
  // (ver ASSINATURA_DIGITAL_COTA).
  { id:'assinatura-digital', name:'Assinatura Digital', group:'Para os Despachantes', basePrice:0, noMarkup:true, inputType:'assinatura_digital', icon:'✍️' },
  // Verificar CRLV + Data CRV incluído na assinatura — mesmo desenho do Código
  // de Segurança CRV acima: usa a MESMA API do serviço pago do grupo CRV
  // (despbrasil verificar_crlv), mas como serviço separado, para o
  // verificar-crlv-data-crv seguir cobrando crédito na aba Nova Consulta.
  // Não debita nada: quem paga é a assinatura, com cota própria
  // (ver ASSINATURA_VERIFICAR_CRLV_COTA e o bloco deste serviceId em
  // processCatalogQuery).
  { id:'assinatura-verificar-crlv-data-crv', name:'Verificar CRLV + Data CRV', group:'Para os Despachantes', basePrice:0, noMarkup:true, inputType:'placa', icon:'📅',
    slowNote:`Situação do CRLV, último licenciamento e a data de emissão do CRV, em PDF. Incluído na Assinatura Coisas de Despachantes, com cota própria de ${ASSINATURA_VERIFICAR_CRLV_COTA} consultas por período.` },
  // ── CRLV-e Rio de Janeiro (destaque no topo da Nova Consulta) ──
  // Saem da API portaldespachantes.online (consultar-crlv-rj e -rj2, ver
  // PORTAL_PLACA_MAP): mesmo contrato — POST { placa }, header chaveAcesso e o
  // PDF pronto em bytes na resposta. O -rj3 (Agendado) chegou a existir aqui e
  // foi removido do catálogo; religá-lo é uma linha em PORTAL_PLACA_MAP.
  { id:'consultar-crlv-rj', name:'CRLV-e Rio de Janeiro', group:'CRLV-e Rio de Janeiro', basePrice:20.00, noMarkup:true, inputType:'placa', icon:'📄', uf:'rj' },
  { id:'crlv-rj-reemissao-2', name:'CRLV 2 Rio Reemissão', group:'CRLV-e Rio de Janeiro', basePrice:55.00, noMarkup:true, inputType:'placa', icon:'📄', uf:'rj' },
  // Backup da CRLV 2 Rio Reemissão (acima): quando a API estiver fora do ar, o cliente
  // usa esta em vez de esperar. Fonte alternativa via API consultasfacil.net (ver
  // CONSULTASFACIL_BASE_URL), devolve o PDF pronto na hora — não é mais fila manual.
  { id:'crlv-rio-reemissao-v2', name:'CRLV Rio Reemissão v2', group:'CRLV-e Rio de Janeiro', basePrice:65.00, noMarkup:true, inputType:'placa', icon:'📄', uf:'rj' },
  // ── CRLV-e Digital (instantâneo) ──
  { id:'consultar-crlv-ac', name:'CRLV-e Acre (AC)',               group:'CRLV-e Digital', basePrice:20.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ap', name:'CRLV-e Amapá (AP)',              group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  // Único CRLV-e Digital com rota mapeada à mão em PORTAL_PLACA_MAP em vez do
  // caminho padrão (POST /consultar-crlv-ba com { placa }, PDF pronto em bytes
  // — doc "Documentação de Integração — 1 endpoint", 26/08/2026). Só placa: o
  // renavam e o CPF que o fornecedor anterior exigia saíram, e com eles o
  // problema do proprietário pessoa jurídica (aquela rota tinha um campo "cpf"
  // só e recusava CNPJ). No meio do caminho passou pela Vistocar
  // (apiclient/crlv-ba), que respondia "Erro interno. Saldo estornado." em toda
  // chamada — inclusive sem placa nenhuma —, então nunca chegou a emitir.
  // Preço fixo (noMarkup) definido pelo cliente, como no PE e no CE do portal.
  { id:'consultar-crlv-ba', name:'CRLV-e Bahia (BA)',              group:'CRLV-e Digital', basePrice:30.00, noMarkup:true, inputType:'placa', icon:'📄', uf:'ba' },
  // Hoje a ÚNICA opção de CE no catálogo: o agendado foi removido e ficou só a
  // emissão na hora do portal (POST /consultar-crlv-ce com { placa }, PDF pronto
  // em bytes — doc "Documentação de Integração — 1 endpoint", 24/08/2026, ver
  // PORTAL_PLACA_MAP). Antes dele o CE passou pela Vistocar (apiclient/crlv-ce,
  // assíncrono por webhook) e pelo CRLV-e Agendado do portal.
  { id:'crlv-ce-instantaneo', name:'CRLV-e Emissão Instantânea Ceará (CE)', group:'CRLV-e Digital', basePrice:32.50, noMarkup:true, inputType:'placa', icon:'⚡', uf:'ce' },
  { id:'consultar-crlv-go', name:'CRLV-e Goiás (GO)',              group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ma', name:'CRLV-e Maranhão (MA)',           group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-mg', name:'CRLV-e Minas Gerais (MG)',       group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ms', name:'CRLV-e Mato Grosso do Sul (MS)',group:'CRLV-e Digital', basePrice:15.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-mt', name:'CRLV-e Mato Grosso (MT)',        group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  // Hoje a ÚNICA opção de PE no catálogo: substituiu de vez o antigo "CRLV-e
  // Agendado Pernambuco (PE)", que foi removido. Saiu da Vistocar e hoje é o
  // portaldespachantes.online (POST /consultar-crlv-pe com { placa }, PDF pronto
  // em bytes — ver PORTAL_PLACA_MAP). Só placa: não pede renavam/CPF como os
  // demais CRLV-e Digital. Preço fixo (noMarkup) definido pelo cliente.
  { id:'crlv-pe-instantaneo', name:'CRLV-e Emissão Instantânea Pernambuco (PE)', group:'CRLV-e Digital', basePrice:35.00, noMarkup:true, inputType:'placa', icon:'⚡', uf:'pe' },
  { id:'consultar-crlv-pi', name:'CRLV-e Piauí (PI)',              group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-pr', name:'CRLV-e Paraná (PR)',             group:'CRLV-e Digital', basePrice:15.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ro', name:'CRLV-e Rondônia (RO)',           group:'CRLV-e Digital', basePrice:20.00, inputType:'placa_renavam_cpf', icon:'📄' },
  // API Datacube (assíncrona, ver bloco dc-crlve-rs-v2 em /api/query) — só placa.
  { id:'dc-crlve-rs-v2',    name:'CRLV-e Rio Grande do Sul V2 (RS)', group:'CRLV-e Digital', basePrice:162.00, noMarkup:true, inputType:'placa', icon:'📄', dcPath:'/veiculos/documentos-crlve-rs-v2',
    slowNote:'Emissão assíncrona no Detran-RS: a consulta pode levar alguns minutos — mantenha a página aberta até o download do PDF.' },
  { id:'consultar-crlv-se', name:'CRLV-e Sergipe (SE)',            group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-sp', name:'CRLV-e São Paulo (SP)',          group:'CRLV-e Digital', basePrice:15.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-to', name:'CRLV-e Tocantins (TO)',          group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  // ── CRLV-e Agendado (assíncrono) ──
  { id:'crlv-agendado-al', name:'CRLV-e Agendado Alagoas (AL)',            group:'CRLV-e Agendado', basePrice:28.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'al' },
  // CE saiu do agendado — hoje só o CRLV-e Ceará via Vistocar (crlv-ce, acima).
  { id:'crlv-agendado-df', name:'CRLV-e Agendado Distrito Federal (DF)',   group:'CRLV-e Agendado', basePrice:38.50,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'df' },
  { id:'crlv-agendado-es', name:'CRLV-e Agendado Espírito Santo (ES)',     group:'CRLV-e Agendado', basePrice:20.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'es' },
  { id:'crlv-agendado-pb', name:'CRLV-e Agendado Paraíba (PB)',            group:'CRLV-e Agendado', basePrice:35.00,  inputType:'crlv_agendado_cpf',   icon:'⏳', uf:'pb' },
  // PE saiu do agendado — hoje só a emissão instantânea via Vistocar
  // (crlv-pe-instantaneo, acima).
  { id:'crlv-agendado-pr', name:'CRLV-e Agendado Paraná (PR)',             group:'CRLV-e Agendado', basePrice:15.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'pr' },
  { id:'crlv-agendado-rn', name:'CRLV-e Agendado Rio Grande do Norte (RN)',group:'CRLV-e Agendado', basePrice:55.00,  inputType:'crlv_agendado_cpf',   icon:'⏳', uf:'rn' },
  { id:'crlv-agendado-sc', name:'CRLV-e Agendado Santa Catarina (SC)',     group:'CRLV-e Agendado', basePrice:60.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'sc' },
  { id:'crlv-agendado-status', name:'CRLV Agendado — Ver Status',          group:'CRLV-e Agendado', basePrice:0.00,   inputType:'pedido_id_get',       icon:'🔄' },
  // ── CRV ──
  { id:'valida-crv',         name:'Valida CRV',                 group:'CRV', basePrice:0.00,  inputType:'valida_crv', icon:'✅' },
  // API despbrasil (serviço "codigo_seguranca", versão v2 — ver DESPBRASIL_SVCS).
  // Este serviço já esteve no catálogo como "Consulta 2 Código Segurança CRV
  // (PDF)" e saiu em 10/09/2026, quando a rota deles respondia "Não foi possível
  // consultar o código de segurança no momento" para qualquer placa, em v1 e v2.
  // Voltou em 21/09/2026, com a v2 conferida contra a API real (placa DDB2H98):
  // devolve o cartão da CDT com camada de texto, a R$ 4,00 de custo.
  // R$ 8,50 FIXO (noMarkup) por decisão do dono — não é custo mais markup.
  { id:'codigo-seguranca-crv', name:'Consulta Código Segurança CRV (PDF)', group:'CRV', basePrice:8.50, noMarkup:true, inputType:'placa', icon:'🔐' },
  // API Vistocar (vistocarconsulta.com.br) — segunda fonte para Código de Segurança
  // CRV, resposta em JSON com PDF pronto em base64 (ver VISTOCAR_ENDPOINTS).
  { id:'security-code-vistocar-2', name:'Consulta 3 Código Segurança CRV (PDF)', group:'CRV', basePrice:8.10, noMarkup:true, inputType:'placa', icon:'🔐' },
  // API despbrasil (serviço "verificar_crlv", o MESMO do "Verificar CRLV e
  // Último Licenciamento" do grupo Consultas Básicas — ver DESPBRASIL_SVCS).
  // Id separado de propósito: aquele serviço segue intocado a R$ 3,00, e este
  // entrega outro relatório do mesmo JSON, com a data de emissão do CRV e os
  // indicadores em destaque (buildVerificarCrlvDataCrvPdfBuffer).
  // R$ 5,00 FIXO (noMarkup) por decisão do dono — custo de R$ 1,90 na despbrasil.
  { id:'verificar-crlv-data-crv', name:'Verificar CRLV + Data CRV', group:'CRV', basePrice:5.00, noMarkup:true, inputType:'placa', icon:'📅' },
  // API despbrasil ("consulta_generica" — ver DESPBRASIL_SVCS). Passou pela
  // Vistocar de 15/09 a 25/09/2026, sem que a rota dela entregasse uma placa.
  //
  // R$ 14,00 FIXO (noMarkup), segurado por decisão do dono — não é o custo
  // mais markup. Custo real na despbrasil: R$ 7,50.
  { id:'numero-crv-digital', name:'Número do CRV Digital', group:'CRV', basePrice:14.00, noMarkup:true, inputType:'placa', icon:'🔢' },
  // ── Análise de Crédito ──
  { id:'consultar-spc', name:'Consulta SPC/Crédito', group:'Análise de Crédito', basePrice:15.00, inputType:'cpfcnpj', icon:'📊' },
  // ── Óbito ──
  { id:'consultar-placa-obito', name:'Consulta Óbito Placa', group:'Óbito', basePrice:5.00, inputType:'placa', icon:'⚰️' },
  // ── Comunicação de Venda ──
  { id:'inserir-comunicacao-venda',   name:'Inserir Comunicação Venda',     group:'Comunicação Venda', basePrice:23.50, inputType:'venda',          icon:'📝' },
  { id:'cancelar-comunicacao-venda',  name:'Cancelar Comunicação Venda',    group:'Comunicação Venda', basePrice:8.00,  inputType:'cancelar_venda', icon:'❌' },
  { id:'venda-transmitir',            name:'Transmitir Comunicação Venda',  group:'Comunicação Venda', basePrice:5.00,  inputType:'id_only',        icon:'📤' },
  { id:'com-venda-desbloquear',       name:'Desbloquear Comunicação Venda', group:'Comunicação Venda', basePrice:5.00,  inputType:'placa',          icon:'🔓' },
  { id:'com-venda-por-id',            name:'Consultar Comunicação por ID',  group:'Comunicação Venda', basePrice:3.00,  inputType:'id_get',         icon:'🔍' },
  { id:'motivos-cancelamento',        name:'Motivos de Cancelamento',       group:'Comunicação Venda', basePrice:3.00,  inputType:'protocolo_get',  icon:'📋' },
  // ── Débitos por Estado (API Datacube — api.consultasdeveiculos.com) ──────────
  // Valor fixo de R$3,00 por consulta (noMarkup:true). A API retorna JSON (não
  // PDF pronto); o servidor monta o PDF do relatório a partir do JSON antes de
  // entregar ao cliente (ver buildDebitoPdfBuffer).
  { id:'dc-debito-ac',    name:'Débitos - Acre',                   group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/ac' },
  { id:'dc-debito-al',    name:'Débitos - Alagoas',                group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/al' },
  { id:'dc-debito-ap',    name:'Débitos - Amapá',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/ap' },
  { id:'dc-debito-am',    name:'Débitos - Amazonas',               group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/am' },
  { id:'dc-debito-ce',    name:'Débitos - Ceará',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/ce' },
  { id:'dc-debito-df',    name:'Débitos - Distrito Federal',       group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/df' },
  { id:'dc-debito-es',    name:'Débitos - Espírito Santo',         group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/es' },
  { id:'dc-debito-go',    name:'Débitos - Goiás',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/go' },
  { id:'dc-debito-ma',    name:'Débitos - Maranhão',               group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/ma' },
  { id:'dc-debito-mt',    name:'Débitos - Mato Grosso',            group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/mt' },
  { id:'dc-debito-ms',    name:'Débitos - Mato Grosso do Sul',     group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/ms' },
  { id:'dc-debito-mg',    name:'Débitos - Minas Gerais',           group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/mg-simples' },
  { id:'dc-debito-pa',    name:'Débitos - Pará',                   group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/pa' },
  { id:'dc-debito-pb',    name:'Débitos - Paraíba',                group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/pb' },
  { id:'dc-debito-pr',    name:'Débitos - Paraná',                 group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_renavam',icon:'🏛️', dcPath:'/debitos/pr' },
  { id:'dc-debito-pi',    name:'Débitos - Piauí',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/pi' },
  { id:'dc-debito-rj',    name:'Débitos - Rio de Janeiro',         group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/rj' },
  { id:'dc-debito-rn',    name:'Débitos - Rio Grande do Norte',    group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/rn' },
  { id:'dc-debito-rs',    name:'Débitos - Rio Grande do Sul',      group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/rs-v2' },
  { id:'dc-debito-ro',    name:'Débitos - Rondônia',               group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/ro' },
  { id:'dc-debito-rr',    name:'Débitos - Roraima',                group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/rr' },
  { id:'dc-debito-sc',    name:'Débitos - Santa Catarina',         group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_chassi', icon:'🏛️', dcPath:'/debitos/sc' },
  { id:'dc-debito-sc-v2', name:'Débitos - Santa Catarina V2',      group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/sc-v2' },
  { id:'dc-debito-sp',    name:'Débitos - São Paulo',              group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'placa_renavam', icon:'🏛️', dcPath:'/debitos/sp' },
  { id:'dc-debito-to',    name:'Débitos - Tocantins',              group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'debito_doc',    icon:'🏛️', dcPath:'/debitos/to' },
  // ── Dívida Ativa (API Datacube — api.consultasdeveiculos.com) ────────────────
  // Valor fixo de R$3,00 por consulta (noMarkup:true). Mesmo fluxo Datacube form-
  // urlencoded dos Débitos por Estado acima; o PDF é montado a partir do JSON
  // retornado (ver buildDividaAtivaPdfBuffer).
  { id:'dc-dividaativa-sp', name:'Dívida Ativa - São Paulo',        group:'Divida Ativa', basePrice:3.00, noMarkup:true, inputType:'debito_renavam', icon:'⚖️', dcPath:'/dividaativa/sp' },
  { id:'dc-dividaativa-df', name:'Dívida Ativa - Distrito Federal', group:'Divida Ativa', basePrice:3.00, noMarkup:true, inputType:'placa_renavam',  icon:'⚖️', dcPath:'/dividaativa/df' },
  { id:'dc-dividaativa-rj', name:'Dívida Ativa - Rio de Janeiro',   group:'Divida Ativa', basePrice:3.00, noMarkup:true, inputType:'debito_renavam', icon:'⚖️', dcPath:'/dividaativa/rj' },
  // ── CNH (API Datacube — api.consultasdeveiculos.com) ─────────────────────────
  // Valor fixo de R$4,00 por consulta (noMarkup:true). Mesmo fluxo Datacube form-
  // urlencoded acima; o PDF é montado a partir do JSON retornado (ver
  // buildCnhPdfBuffer) — campos de "Dados da Consulta" variam por UF.
  { id:'dc-cnh-ac', name:'CNH - Acre',                 group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_nome_cpf',       icon:'🪪', dcPath:'/cnh/ac-completa' },
  { id:'dc-cnh-al', name:'CNH - Alagoas',               group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_al',             icon:'🪪', dcPath:'/cnh/al-completa' },
  { id:'dc-cnh-ce', name:'CNH - Ceará',                 group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_formulario', icon:'🪪', dcPath:'/cnh/ce-completa' },
  { id:'dc-cnh-go', name:'CNH - Goiás',                 group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_only',           icon:'🪪', dcPath:'/cnh/go-completa' },
  { id:'dc-cnh-ma', name:'CNH - Maranhão',              group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_cnh',        icon:'🪪', dcPath:'/cnh/ma-completa' },
  { id:'dc-cnh-mt', name:'CNH - Mato Grosso',           group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_renach',     icon:'🪪', dcPath:'/cnh/mt-completa' },
  { id:'dc-cnh-ms', name:'CNH - Mato Grosso do Sul',    group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_cnh',        icon:'🪪', dcPath:'/cnh/ms-completa' },
  { id:'dc-cnh-pa', name:'CNH - Pará',                  group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_cnh',        icon:'🪪', dcPath:'/cnh/pa-completa' },
  { id:'dc-cnh-pr', name:'CNH - Paraná',                group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_pr',             icon:'🪪', dcPath:'/cnh/pr-completa' },
  { id:'dc-cnh-rj', name:'CNH - Rio de Janeiro',        group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_cnh',        icon:'🪪', dcPath:'/cnh/rj-completa' },
  { id:'dc-cnh-rn', name:'CNH - Rio Grande do Norte',   group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_cnh',        icon:'🪪', dcPath:'/cnh/rn-completa' },
  { id:'dc-cnh-se', name:'CNH - Sergipe',               group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_se',             icon:'🪪', dcPath:'/cnh/se-completa' },
  { id:'dc-cnh-to', name:'CNH - Tocantins',             group:'CNH', basePrice:4.00, noMarkup:true, inputType:'cnh_cpf_nascimento', icon:'🪪', dcPath:'/cnh/to-completa' },
  // ── Veículos por Documento (API Datacube — api.consultasdeveiculos.com) ──────
  // Movido da Opção 2 (grupo Documentos) para o grupo Consulta Completa, valor
  // fixo de R$14,00 (noMarkup:true). Mesmo fluxo Datacube form-urlencoded acima;
  // o PDF é montado a partir do JSON retornado (ver buildVeiculosDocPdfBuffer),
  // no mesmo padrão visual do relatório de Débitos por Estado.
  { id:'dc-veiculos-doc', name:'Veículos por Documento (CPF/CNPJ)', group:'Consulta Completa', basePrice:14.00, noMarkup:true, inputType:'veiculos_documento', icon:'🚗', dcPath:'/pessoas/veiculos' },
  // ── Roubo e Furto (API Datacube — api.consultasdeveiculos.com) ───────────────
  // Movido da Opção 2 (grupo Documentos) para o grupo Consulta Completa, valor
  // fixo de R$25,00 (noMarkup:true). Mesmo fluxo Datacube form-urlencoded acima;
  // o PDF é montado a partir do JSON retornado (ver buildRouboFurtoPdfBuffer),
  // no mesmo padrão visual do relatório de Débitos por Estado.
  { id:'dc-roubo-furto', name:'Roubo e Furto', group:'Consulta Completa', basePrice:25.00, noMarkup:true, inputType:'placa', icon:'🚗', dcPath:'/veiculos/roubo_furto' },
  // ── Histórico de Proprietários (API Datacube — api.consultasdeveiculos.com) ──
  // Movido da Opção 2 (grupo Documentos) para o grupo Consulta Completa, valor
  // fixo de R$15,00 (noMarkup:true). Mesmo fluxo Datacube form-urlencoded acima;
  // o PDF é montado a partir do JSON retornado (ver
  // buildHistoricoProprietarioPdfBuffer), no mesmo padrão visual do relatório de
  // Débitos por Estado.
  { id:'dc-historico-proprietario', name:'Histórico de Proprietários', group:'Consulta Completa', basePrice:15.00, noMarkup:true, inputType:'placa', icon:'🚗', dcPath:'/veiculos/historico-proprietario' },
  // ── Histórico de Gravames (API Datacube — api.consultasdeveiculos.com) ───────
  // Movido da Opção 2 (grupo Documentos) para o grupo Consulta Completa, valor
  // fixo de R$8,00 (noMarkup:true). Mesmo fluxo Datacube form-urlencoded acima;
  // o PDF é montado a partir do JSON retornado (ver
  // buildHistoricoGravamesPdfBuffer), no mesmo padrão visual do relatório de
  // Débitos por Estado.
  { id:'dc-historico-gravames', name:'Histórico de Gravames', group:'Consulta Completa', basePrice:8.00, noMarkup:true, inputType:'chassi', icon:'🚗', dcPath:'/veiculos/historico_gravames' },
  // ── Leilão (API Datacube — api.consultasdeveiculos.com) ──────────────────────
  // Movido da Opção 2 (grupo Documentos) para o grupo Consulta Completa, valor
  // fixo de R$30,00 (noMarkup:true). Mesmo fluxo Datacube form-urlencoded acima;
  // o PDF é montado a partir do JSON retornado (ver buildLeilaoPdfBuffer), no
  // mesmo padrão visual do relatório de Débitos por Estado.
  { id:'dc-leilao', name:'Leilão', group:'Consulta Completa', basePrice:30.00, noMarkup:true, inputType:'placa', icon:'🚗', dcPath:'/veiculos/leilao' },
  // ── Veículo 0km (API Datacube — api.consultasdeveiculos.com) ─────────────────
  // Movido da Opção 2 (grupo Documentos) para o grupo Consulta Completa, valor
  // fixo de R$12,00 (noMarkup:true). Mesmo fluxo Datacube form-urlencoded acima;
  // o PDF é montado a partir do JSON retornado (ver buildConsulta0kmPdfBuffer),
  // no mesmo padrão visual do relatório de Débitos por Estado.
  { id:'dc-consulta-0km', name:'Veículo 0km', group:'Consulta Completa', basePrice:12.00, noMarkup:true, inputType:'chassi', icon:'🚗', dcPath:'/veiculos/consulta-0km' },
  // ── Base Estadual (BIN) (API Datacube — api.consultasdeveiculos.com) ─────────
  // Movido da Opção 2 (grupo Documentos) para o grupo Consulta Completa, valor
  // fixo de R$9,90 (noMarkup:true). Mesmo fluxo Datacube form-urlencoded acima;
  // o PDF é montado a partir do JSON retornado (ver buildBinEstadualPdfBuffer),
  // no mesmo padrão visual do relatório de Débitos por Estado.
  { id:'dc-bin-estadual', name:'Base Estadual (BIN)', group:'Consulta Completa', basePrice:9.90, noMarkup:true, inputType:'placa', icon:'🚗', dcPath:'/veiculos/bin-estadual' },
  // ── Número CRV (Apenas antigos) — processamento manual (entrega via upload no admin) ──
  // slowNote: mesmo aviso de prazo que antes aparecia num popup global, agora exibido
  // só ao selecionar uma consulta deste grupo (ver form-slow-note em painel-usuario.html).
  { id:'crv-antigo-rio', name:'Consulta CRV antigo Rio', group:'Número CRV (Apenas antigos)', basePrice:500.00, inputType:'placa', icon:'📁', uf:'rj', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-ce', name:'Consulta CRV antigo CE', group:'Número CRV (Apenas antigos)', basePrice:55.00,  inputType:'placa', icon:'📁', uf:'ce', slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-ba', name:'Consulta CRV antigo BA', group:'Número CRV (Apenas antigos)', basePrice:199.99, inputType:'placa', icon:'📁', uf:'ba', slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-sp', name:'Consulta CRV antigo SP', group:'Número CRV (Apenas antigos)', basePrice:139.99, inputType:'placa', icon:'📁', uf:'sp', slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-rn', name:'Consulta CRV antigo RN', group:'Número CRV (Apenas antigos)', basePrice:150.00, inputType:'placa', icon:'📁', uf:'rn', slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-pe', name:'Consulta CRV antigo PE', group:'Número CRV (Apenas antigos)', basePrice:100.00, inputType:'placa', icon:'📁', uf:'pe', slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-pb', name:'Consulta CRV antigo PB', group:'Número CRV (Apenas antigos)', basePrice:79.99,  inputType:'placa', icon:'📁', uf:'pb', slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-mg', name:'Consulta CRV antigo MG', group:'Número CRV (Apenas antigos)', basePrice:169.99, inputType:'placa', icon:'📁', uf:'mg', slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-es', name:'Consulta CRV antigo ES', group:'Número CRV (Apenas antigos)', basePrice:450.00, inputType:'placa', icon:'📁', uf:'es', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-al', name:'Consulta CRV antigo AL', group:'Número CRV (Apenas antigos)', basePrice:420.00, inputType:'placa', icon:'📁', uf:'al', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-am', name:'Consulta CRV antigo AM', group:'Número CRV (Apenas antigos)', basePrice:462.00, inputType:'placa', icon:'📁', uf:'am', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-df', name:'Consulta CRV antigo DF', group:'Número CRV (Apenas antigos)', basePrice:392.00, inputType:'placa', icon:'📁', uf:'df', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-go', name:'Consulta CRV antigo GO', group:'Número CRV (Apenas antigos)', basePrice:532.00, inputType:'placa', icon:'📁', uf:'go', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-ms', name:'Consulta CRV antigo MS', group:'Número CRV (Apenas antigos)', basePrice:532.00, inputType:'placa', icon:'📁', uf:'ms', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-mt', name:'Consulta CRV antigo MT', group:'Número CRV (Apenas antigos)', basePrice:532.00, inputType:'placa', icon:'📁', uf:'mt', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-pa', name:'Consulta CRV antigo PA', group:'Número CRV (Apenas antigos)', basePrice:392.00, inputType:'placa', icon:'📁', uf:'pa', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-pr', name:'Consulta CRV antigo PR', group:'Número CRV (Apenas antigos)', basePrice:392.00, inputType:'placa', icon:'📁', uf:'pr', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-ro', name:'Consulta CRV antigo RO', group:'Número CRV (Apenas antigos)', basePrice:406.00, inputType:'placa', icon:'📁', uf:'ro', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-rr', name:'Consulta CRV antigo RR', group:'Número CRV (Apenas antigos)', basePrice:490.00, inputType:'placa', icon:'📁', uf:'rr', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-se', name:'Consulta CRV antigo SE', group:'Número CRV (Apenas antigos)', basePrice:448.00, inputType:'placa', icon:'📁', uf:'se', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-to', name:'Consulta CRV antigo TO', group:'Número CRV (Apenas antigos)', basePrice:350.00, inputType:'placa', icon:'📁', uf:'to', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  { id:'crv-antigo-sc', name:'Consulta CRV antigo SC', group:'Número CRV (Apenas antigos)', basePrice:600.00, inputType:'placa', icon:'📁', uf:'sc', noMarkup:true, slowNote:'Atenção: esta consulta pode levar de 3 a 5 dias para a entrega do documento.' },
  // ── Intenção de Venda (ATPVE) — API Vistocar ────────────────────────────────
  // Voltaram em 15/09/2026, depois de a emissão pela Chekaki sair do catálogo em
  // 10/09/2026 (commit fa5ae61): agora quem emite é a Vistocar, em rota por
  // estado (VISTOCAR_ENDPOINTS → apiclient/atpve-rj e apiclient/atpve-mg).
  // Preço fechado de R$ 70,00 nos dois (noMarkup:true).
  //
  // São ASSÍNCRONOS (VISTOCAR_ASYNC_SVCS): o POST só devolve o protocolo do
  // cadastro e o documento chega depois pelo webhook — por isso o cliente NÃO é
  // cobrado no envio, só quando o ATPV-e é entregue (finalizePendingQuery), e o
  // painel acompanha a emissão pela barra de progresso
  // (GET /api/queries/:id/atpve-status).
  { id:'atpve-vistocar-rj', name:'Intenção de Venda / ATPV-e RJ', group:'Intenção de Venda (ATPVE)', basePrice:70.00, noMarkup:true, inputType:'atpve_vistocar', icon:'📝', uf:'rj' },
  { id:'atpve-vistocar-mg', name:'Intenção de Venda / ATPV-e MG', group:'Intenção de Venda (ATPVE)', basePrice:70.00, noMarkup:true, inputType:'atpve_vistocar', icon:'📝', uf:'mg' },
];

// Serviços desta categoria não retornam resultado na hora: o pedido fica
// pendente até o super admin subir o PDF manualmente (ver /api/admin/manual-queries).
const MANUAL_UPLOAD_GROUP = 'Número CRV (Apenas antigos)';
// Os serviços deste grupo não falam com fornecedor nenhum: processCatalogQuery
// debita, grava o pedido como 'pendente' e retorna — o documento é entregue
// depois, por upload do admin (ver /api/admin/manual-queries). Por isso a troca
// de fornecedor não os afeta.
const MANUAL_SERVICE_IDS  = SERVICES.filter(s => s.group === MANUAL_UPLOAD_GROUP).map(s => s.id);

// ── SERVICES_V2 — API Datacube (api.consultasdeveiculos.com) ──────────────────
// Catálogo completamente separado do SERVICES/autocrlv/portal acima. Preços em
// basePrice são o custo cobrado pela Datacube na faixa "De 0 - 10.000" da tabela
// de valores; o preço final ao cliente aplica o mesmo MARKUP (40%) do restante
// do sistema, exceto quando noMarkup:true. Exposto no painel na aba "Opção 2 Nova
// Consulta" (rota /api/query-v2).
const SERVICES_V2 = [
  { id:'dc-agregados',              name:'Agregados',                               group:'Documentos', basePrice:0.380,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/agregados' },
  { id:'dc-agregados-v2',           name:'Agregados V2',                            group:'Documentos', basePrice:0.380,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/agregados_v2' },
  { id:'dc-bin-nacional',           name:'BIN Nacional',                            group:'Documentos', basePrice:2.214,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/bin-nacional' },
  { id:'dc-bin-nacional-v2',        name:'BIN Nacional V2',                         group:'Documentos', basePrice:2.214,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/bin-nacional-v2' },
  { id:'dc-base-nacional-v2',       name:'Base Nacional V2',                        group:'Documentos', basePrice:2.203,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/base-nacional-v2' },
  { id:'dc-informacao-basica',      name:'Informação Básica',                       group:'Documentos', basePrice:0.359,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/informacao-basica' },
  { id:'dc-informacao-basica-v2',   name:'Informação Básica V2',                    group:'Documentos', basePrice:0.391,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/informacao-basica-v2' },
  { id:'dc-proprietario-ano-lic',   name:'Proprietário / Ano Último Licenciamento', group:'Documentos', basePrice:1.006,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/proprietario-ano-licenciamento' },
  // Entregue como relatório PDF no padrão da casa, não como JSON cru — o PDF é
  // montado por buildProprietarioAtualPdfBuffer (ver V2_PDF_BUILDERS).
  { id:'dc-proprietario-atual',     name:'Proprietário Atual',                      group:'Documentos', basePrice:1.266,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/proprietario-atual' },
  { id:'dc-informacao-simples-v2',  name:'Informação Simples V2',                   group:'Documentos', basePrice:1.563,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/informacao-simples-v2' },
  { id:'dc-infracoes-v3',           name:'Infrações V3',                            group:'Documentos', basePrice:3.891,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/infracoes-v3' },
  { id:'dc-renainf',                name:'Renainf',                                 group:'Documentos', basePrice:3.594,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renainf' },
  { id:'dc-informacao-por-renavam', name:'Informações por Renavam',                 group:'Documentos', basePrice:0.375,  inputType:'dc_renavam',    icon:'🚗', dcPath:'/veiculos/informacao-por-renavam' },
  { id:'dc-decodificar-chassi',     name:'Decodificação de Chassi',                 group:'Documentos', basePrice:0.359,  inputType:'dc_chassi',     icon:'🚗', dcPath:'/veiculos/decodificar-chassi' },
  { id:'dc-cronotacografo',         name:'Cronotacógrafo',                          group:'Documentos', basePrice:0.738,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/cronotacografo' },
  { id:'dc-gravames-v2',            name:'Gravames V2',                             group:'Documentos', basePrice:3.594,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/gravames-v2' },
  { id:'dc-gravames-v3',            name:'Gravames V3',                             group:'Documentos', basePrice:3.091,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/gravames-v3' },
  { id:'dc-uf-placa',               name:'UF da Placa',                             group:'Documentos', basePrice:0.281,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/uf-placa' },
  { id:'dc-marcas',                 name:'Marcas',                                  group:'Documentos', basePrice:0.230,  inputType:'dc_tipo',       icon:'🚗', dcPath:'/veiculos/marcas' },
  { id:'dc-modelos',                name:'Modelos',                                 group:'Documentos', basePrice:0.230,  inputType:'dc_tipo_marca', icon:'🚗', dcPath:'/veiculos/modelos' },
  { id:'dc-recall',                 name:'Recall',                                  group:'Documentos', basePrice:0.391,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/recall' },
  { id:'dc-renavam',                name:'Renavam',                                 group:'Documentos', basePrice:0.853,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renavam' },
  { id:'dc-renavam-v2',             name:'Renavam V2',                              group:'Documentos', basePrice:0.234,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renavam-v2' },
  { id:'dc-indicio-roubo-furto',    name:'Indício de Roubo e Furto',                group:'Documentos', basePrice:0.375,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/indicio-roubo-furto' },
  { id:'dc-sinistro',               name:'Indício de Sinistro',                     group:'Documentos', basePrice:0.947,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/sinistro' },
  { id:'dc-historico-fipe',         name:'Histórico FIPE',                          group:'Documentos', basePrice:0.234,  inputType:'dc_fipe',       icon:'🚗', dcPath:'/veiculos/historico-fipe' },
  { id:'dc-renajud-v3',             name:'Renajud V3',                              group:'Documentos', basePrice:3.047,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renajud-v3' },
  { id:'dc-renajud-v4',             name:'Renajud V4',                              group:'Documentos', basePrice:2.791,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renajud-v4' },
  { id:'dc-csv',                    name:'Certificado de Segurança Veicular (CSV)', group:'Documentos', basePrice:4.314,  inputType:'dc_csv',        icon:'🚗', dcPath:'/veiculos/csv' },
  { id:'dc-veiculos-doc-v2',        name:'Veículos por Documento V2',               group:'Documentos', basePrice:8.984,  inputType:'dc_documento',  icon:'🚗', dcPath:'/pessoas/veiculos_v2' },
  { id:'dc-veiculos-doc-v3',        name:'Veículos por Documento V3',               group:'Documentos', basePrice:8.984,  inputType:'dc_documento',  icon:'🚗', dcPath:'/pessoas/veiculos_v3' },
  { id:'dc-roubo-furto-simples',    name:'Roubo e Furto Simples',                   group:'Documentos', basePrice:6.250,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/roubo_furto_simples' },

  // ── Consultar Crédito — preços com o mesmo MARKUP (40%) do resto do sistema ──
  { id:'dc-credito-completa-pf',    name:'Crédito Completa PF',    group:'Consultar Crédito', basePrice:36.281, inputType:'dc_cpf',       icon:'💳', dcPath:'/credito/credito-completa-pf' },
  { id:'dc-credito-completa-pj',    name:'Crédito Completa PJ',    group:'Consultar Crédito', basePrice:36.281, inputType:'dc_cnpj',      icon:'💳', dcPath:'/credito/credito-completa-pj' },
  { id:'dc-restricao-score-pf',     name:'Restrição Score PF',     group:'Consultar Crédito', basePrice:33.594, inputType:'dc_cpf',       icon:'💳', dcPath:'/credito/restricao-score-pf' },
  { id:'dc-restricao-score-pj',     name:'Restrição Score PJ',     group:'Consultar Crédito', basePrice:33.594, inputType:'dc_cnpj',      icon:'💳', dcPath:'/credito/restricao-score-pj' },
  { id:'dc-localizacao-score',      name:'Localização Score',      group:'Consultar Crédito', basePrice:8.594,  inputType:'dc_documento', icon:'💳', dcPath:'/credito/localizacao-score' },
  { id:'dc-endividamento-bancario', name:'Endividamento Bancário', group:'Consultar Crédito', basePrice:7.031,  inputType:'dc_documento', icon:'💳', dcPath:'/credito/endividamento-bancario' },

  // ── Cadastros — preços com o mesmo MARKUP (40%) do resto do sistema ─────────
  { id:'dc-cadastro-empresas-cpf',    name:'Empresas do CPF',           group:'Cadastros', basePrice:0.313, inputType:'dc_cpf',      icon:'🗂️', dcPath:'/pessoas/empresas' },
  { id:'dc-cadastro-nome-cpf',        name:'Nome do CPF',               group:'Cadastros', basePrice:0.234, inputType:'dc_cpf',      icon:'🗂️', dcPath:'/pessoas/nome' },
  { id:'dc-cadastro-dados-cpf',       name:'Dados Cadastrais do CPF',   group:'Cadastros', basePrice:1.380, inputType:'dc_cpf',      icon:'🗂️', dcPath:'/pessoas/cadastro' },
  // "Localização CPF" (dc-cadastro-localizacao-cpf) e "Localização CPF V3"
  // (dc-cadastro-localizacao-v3) foram movidas para Nova Consulta / Débitos e
  // Documentação, ver SERVICES acima.
  { id:'dc-cadastro-telefone',        name:'Pessoas por Telefone',      group:'Cadastros', basePrice:0.706, inputType:'dc_telefone', icon:'🗂️', dcPath:'/pessoas/telefone' },
  { id:'dc-cadastro-cnpj',            name:'Dados do CNPJ',             group:'Cadastros', basePrice:0.234, inputType:'dc_cnpj',     icon:'🗂️', dcPath:'/empresas/informacoes' },
  { id:'dc-cadastro-municipios-serpro',name:'Municípios - Código Serpro',group:'Cadastros', basePrice:0.391, inputType:'dc_uf',       icon:'🗂️', dcPath:'/demografia/municipios-serpro' },
  { id:'dc-cadastro-municipios-ibge', name:'Municípios - Código IBGE',  group:'Cadastros', basePrice:0.391, inputType:'dc_uf',       icon:'🗂️', dcPath:'/demografia/municipios-ibge' },
  { id:'dc-cadastro-qrcode',          name:'Decodificar Documento (QRCode)', group:'Cadastros', basePrice:0.308, inputType:'dc_qrcode', icon:'🗂️', dcPath:'/documentos/decodificar' },

  // ── Orgãos — preços com o mesmo MARKUP (40%) do resto do sistema ────────────
  { id:'dc-orgaos-sintegra',        name:'SINTEGRA - Nacional',            group:'Orgãos', basePrice:0.391, inputType:'dc_sintegra',           icon:'🏢', dcPath:'/orgaos/sintegra' },
  { id:'dc-orgaos-nfe',             name:'Consulta NFe',                   group:'Orgãos', basePrice:0.391, inputType:'dc_nfe',                icon:'🏢', dcPath:'/orgaos/nfe' },
  { id:'dc-orgaos-suframa',         name:'SUFRAMA - Nacional',             group:'Orgãos', basePrice:0.378, inputType:'dc_cnpj',               icon:'🏢', dcPath:'/orgaos/suframa' },
  { id:'dc-orgaos-situacao-cpf',    name:'Situação do CPF na Receita Federal', group:'Orgãos', basePrice:0.383, inputType:'dc_cnh_cpf_nascimento', icon:'🏢', dcPath:'/pessoas/situacao' },
  { id:'dc-orgaos-situacao-cnpj',   name:'Situação do CNPJ na Receita Federal', group:'Orgãos', basePrice:0.391, inputType:'dc_cnpj',           icon:'🏢', dcPath:'/empresas/situacao' },
  { id:'dc-orgaos-mandados-cnj',    name:'Mandados de Prisão (CNJ)',       group:'Orgãos', basePrice:0.382, inputType:'dc_cpf',                icon:'🏢', dcPath:'/orgaos/mandados_cnj' },

  // ── Comunicação de Venda saiu da Opção 2 em 18/09/2026 ───────────────────────
  // O grupo inteiro (emissão pela Datacube em /veiculos/comunicado_venda_v2 e o
  // cancelamento em /veiculos/cancelar_comunicado_venda_v2) foi retirado do
  // catálogo por decisão do dono. Sem entrada aqui o serviço some da aba e
  // /api/query-v2 recusa o id, que é o que basta para não ser mais vendido.
  // Os formulários do painel (dc_comunicado_venda, dc_cancelar_comunicado_venda)
  // e os case do processCatalogQueryV2 ficaram de pé de propósito: voltar a
  // oferecer é repor estas duas linhas, sem mexer em mais nada.

  // ── CRLVe — em teste, visível apenas para admin (ver adminOnly em /api/services-v2 e /api/query-v2) ──
  // Endpoint assíncrono na Datacube: se a resposta ainda não trouxer o PDF pronto
  // (tarefa em processamento), o pedido não pode ser acompanhado por aqui — só no
  // histórico do próprio painel da Datacube (login do admin na Datacube, não do cliente).
  { id:'dc-crlve-rj-flash', name:'CRLV-e RJ Flash', group:'CRLVe', basePrice:20.000, inputType:'dc_placa', icon:'⚡', dcPath:'/veiculos/documentos-crlve-rj-flash', adminOnly:true, returnsPdf:true,
    slowNote:'Este endpoint é assíncrono: se a resposta não vier com o PDF pronto, acompanhe o status (Processando/Concluído/Negado) no histórico da Datacube.', noteUrl:'https://painel.consultasdeveiculos.com/historico' },
];

// ── SERVICES_V3 — API Infosimples (api.infosimples.com) ───────────────────────
// Catálogo gerado a partir do OpenAPI da Infosimples cruzado com a tabela de
// preços (866 consultas, tag "Consultas" — os 22 endpoints de OCR/leitura de
// imagem, tag "Imagens", ficaram de fora por não terem preço divulgado na
// página de preços). basePrice = custo real pago à Infosimples (tier atual
// R$0,30/consulta + adicional por consulta, quando houver); o preço final ao
// cliente aplica INFOSIMPLES_MARKUP (70%). Exposto no painel na aba
// "Infosimples Nova Consulta" (rota /api/query-v3). Catálogo isolado de
// SERVICES/SERVICES_V2 — nunca toca em MANUAL_SERVICE_IDS nem nas integrações
// portal/autocrlv/Datacube.
const SERVICES_V3 = require('./data/infosimples-services.json');

// Conexão com o banco Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Inicializar tabelas ──────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      cpf_cnpj      VARCHAR(20)  UNIQUE NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      phone         VARCHAR(20),
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(20)  DEFAULT 'user' CHECK (role IN ('user','reseller','admin')),
      credits       NUMERIC(10,2) DEFAULT 0.00,
      affiliate_code VARCHAR(12) UNIQUE,
      referred_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      active        BOOLEAN DEFAULT true
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type        VARCHAR(20) NOT NULL CHECK (type IN ('deposit','debit','commission','refund')),
      amount      NUMERIC(10,2) NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commissions (
      id             SERIAL PRIMARY KEY,
      reseller_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      client_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      amount         NUMERIC(10,2) NOT NULL,
      rate           NUMERIC(5,2)  DEFAULT 10.00,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS queries (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
      service_id     VARCHAR(100) NOT NULL,
      service_name   VARCHAR(255) NOT NULL,
      params         TEXT,
      status         VARCHAR(20)  DEFAULT 'success',
      amount         NUMERIC(10,2),
      transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      result_type    VARCHAR(10)  DEFAULT 'json',
      created_at     TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(100);`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);`);
  await pool.query(`ALTER TABLE queries ADD COLUMN IF NOT EXISTS whatsapp_sent_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE queries ADD COLUMN IF NOT EXISTS result_data TEXT;`);
  await pool.query(`ALTER TABLE crlv_agendado_pending ADD COLUMN IF NOT EXISTS query_id INTEGER REFERENCES queries(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE crlv_agendado_pending ADD COLUMN IF NOT EXISTS amount NUMERIC(10,2);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_cache (
      id         SERIAL PRIMARY KEY,
      query_id   INTEGER REFERENCES queries(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token      VARCHAR(64) UNIQUE NOT NULL,
      pdf_data   TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Registro permanente das ASDs emitidas — NÃO pode virar pdf_cache (que expira
  // em 7 dias): é o livro do despachante, consultado pela página pública
  // /verificar-asd/:codigo. Cada usuário tem sua própria cadeia sequencial
  // (seq 1, 2, 3...) em que chain_hash encadeia o registro anterior, então
  // alterar uma ASD antiga invalida todas as posteriores daquele despachante.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asd_registros (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
      query_id       INTEGER REFERENCES queries(id) ON DELETE SET NULL,
      seq            INTEGER NOT NULL,
      codigo         VARCHAR(32) UNIQUE NOT NULL,
      doc_hash       CHAR(64) NOT NULL,
      prev_hash      CHAR(64) NOT NULL,
      chain_hash     CHAR(64) NOT NULL,
      servico        VARCHAR(255),
      uf             CHAR(2),
      prof_nome      VARCHAR(255),
      prof_doc       VARCHAR(14),
      prof_matricula VARCHAR(50),
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asd_registros_user_seq ON asd_registros(user_id, seq);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pix_payments (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      gateway_id VARCHAR(100) UNIQUE NOT NULL,
      value      NUMERIC(10,2) NOT NULL,
      status     VARCHAR(20) DEFAULT 'PENDING',
      credited   BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pix_payments' AND column_name='asaas_id') THEN
        ALTER TABLE pix_payments RENAME COLUMN asaas_id TO gateway_id;
      END IF;
    END $$;
  `);
  // Para que serve o PIX: 'RECARGA' credita saldo (comportamento histórico, por
  // isso é o default de toda linha antiga) e 'ASSINATURA' ativa/estende a
  // Assinatura Coisas de Despachantes sem mexer no saldo. Ver creditPixPaymentIfApproved.
  await pool.query(`
    ALTER TABLE pix_payments ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'RECARGA'
  `);
  // Meio de pagamento e valor efetivamente cobrado. "value" continua sendo o
  // valor LÍQUIDO (o que o cliente recebe em crédito, ou o preço da assinatura)
  // — é ele que creditPixPaymentIfApproved soma no saldo. No cartão de débito o
  // cobrado é 5% maior (ver CARTAO_ACRESCIMO) e fica em charged_value, para
  // conferência e conciliação com o extrato do Mercado Pago.
  await pool.query(`ALTER TABLE pix_payments ADD COLUMN IF NOT EXISTS method VARCHAR(10) NOT NULL DEFAULT 'PIX'`);
  await pool.query(`ALTER TABLE pix_payments ADD COLUMN IF NOT EXISTS charged_value NUMERIC(10,2)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      plan         VARCHAR(50) NOT NULL DEFAULT 'assinatura-consulta-placas',
      status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL,
      queries_used INTEGER NOT NULL DEFAULT 0,
      gateway_id   VARCHAR(100),
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Cada pagamento gera UMA linha (um período), então o histórico de renovações
  // fica auditável e a cota é por período, não acumulada. A busca quente é
  // sempre "assinatura vigente deste usuário".
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_vigencia
      ON subscriptions (user_id, expires_at DESC)
  `);
  // Um pagamento PIX não pode ativar dois períodos (webhook + polling + cron
  // chegando juntos) — mesma proteção do "credited" em pix_payments. Índice
  // total, não parcial: o ON CONFLICT (gateway_id) do INSERT só casa com um
  // índice sem predicado, e no Postgres NULLs são distintos entre si, então
  // eventuais cortesias lançadas à mão (gateway_id nulo) continuam permitidas.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_gateway_id
      ON subscriptions (gateway_id)
  `);
  // Avisos de vencimento por WhatsApp (5 dias antes e no dia). Marcados no
  // próprio período para o cron nunca mandar a mesma mensagem duas vezes —
  // ele roda todo dia e sem isso repetiria o aviso a cada execução.
  await pool.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS aviso_5d_em  TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS aviso_venc_em TIMESTAMPTZ
  `);
  // Liberação manual pelo admin (ver POST /api/admin/users/:id/assinatura):
  // origem separa o que foi pago do que foi cortesia, e expires_at passa a
  // aceitar NULL, que significa "sem data limite". Toda comparação de vigência
  // trata NULL como vigente (ver getAssinaturaVigente); o cron de expiração e
  // os avisos de vencimento ignoram NULL naturalmente, porque comparação com
  // NULL nunca é verdadeira.
  await pool.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS origem VARCHAR(20) NOT NULL DEFAULT 'PIX'
  `);
  await pool.query(`ALTER TABLE subscriptions ALTER COLUMN expires_at DROP NOT NULL`);
  // Cota de consultas de placa do período. NULL = ilimitada (usada nas
  // cortesias em que o admin não quer teto). Períodos pagos nascem com
  // ASSINATURA_PLACAS_COTA; as linhas antigas recebem o mesmo valor.
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cota INTEGER`);
  await pool.query(
    `UPDATE subscriptions SET cota=$1 WHERE cota IS NULL AND origem='PIX'`,
    [ASSINATURA_PLACAS_COTA]
  );
  // Cota separada do Código de Segurança CRV (ver ASSINATURA_CRV_COTA). Mesma
  // convenção da cota de placas: NULL = ilimitada, e os períodos pagos que já
  // estavam correndo quando o serviço entrou também recebem o teto — o benefício
  // vale de imediato para quem já é assinante, sem esperar renovar.
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cota_crv INTEGER`);
  await pool.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS queries_used_crv INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(
    `UPDATE subscriptions SET cota_crv=$1 WHERE cota_crv IS NULL AND origem='PIX'`,
    [ASSINATURA_CRV_COTA]
  );
  // Cota da Assinatura Digital — mesma mecânica da do CRV (coluna própria +
  // backfill nas assinaturas por PIX já vigentes), para o serviço novo valer de
  // imediato para quem já assina, sem esperar renovar o período.
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cota_assinatura INTEGER`);
  await pool.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS queries_used_assinatura INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(
    `UPDATE subscriptions SET cota_assinatura=$1 WHERE cota_assinatura IS NULL AND origem='PIX'`,
    [ASSINATURA_DIGITAL_COTA]
  );
  // Cota do Verificar CRLV + Data CRV — mesma mecânica das duas acima (coluna
  // própria + backfill nas assinaturas por PIX já vigentes), para o serviço
  // novo valer de imediato para quem já assina, sem esperar renovar.
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cota_verificar_crlv INTEGER`);
  await pool.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS queries_used_verificar_crlv INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(
    `UPDATE subscriptions SET cota_verificar_crlv=$1 WHERE cota_verificar_crlv IS NULL AND origem='PIX'`,
    [ASSINATURA_VERIFICAR_CRLV_COTA]
  );
  // Período que o cliente comprou na Assinatura Coisas de Despachantes. Fica no
  // pagamento porque o preço é pró-rata: o QR mostra o valor de N dias até o dia
  // 30, e a baixa (que pode acontecer horas depois) tem que abrir exatamente o
  // período que foi cobrado, e não recalcular e entregar outro. Pagamento antigo
  // tem as duas colunas NULL e cai no comportamento anterior (30 dias corridos,
  // cotas cheias).
  await pool.query(`ALTER TABLE pix_payments ADD COLUMN IF NOT EXISTS periodo_fim TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE pix_payments ADD COLUMN IF NOT EXISTS periodo_dias INTEGER`);
  // Pedidos de assinatura em andamento: a Assinafy devolve o documento assinado
  // só depois que o signatário assina — pode ser em minutos ou dias. Guardamos o
  // id do documento para buscar o resultado depois (cron/painel), do mesmo jeito
  // que vistocar_pending faz com o movementId.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assinafy_pending (
      id           SERIAL PRIMARY KEY,
      document_id  VARCHAR(100) UNIQUE NOT NULL,
      query_id     INTEGER REFERENCES queries(id) ON DELETE CASCADE,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      phone        VARCHAR(20),
      nome_arquivo VARCHAR(255),
      signatario   VARCHAR(255),
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assinafy_pending_query ON assinafy_pending(query_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_inbox (
      id           SERIAL PRIMARY KEY,
      phone        VARCHAR(30),
      sender_name  VARCHAR(255),
      message      TEXT,
      message_type VARCHAR(30) DEFAULT 'text',
      message_id   VARCHAR(100) UNIQUE,
      raw          JSONB,
      read         BOOLEAN DEFAULT false,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      code_hash  VARCHAR(255) NOT NULL,
      attempts   INTEGER DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crlv_agendado_notifications (
      pedido_id  VARCHAR(100) PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crlv_agendado_pending (
      pedido_id  VARCHAR(100) PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      phone      VARCHAR(20),
      service_id VARCHAR(100),
      uf         VARCHAR(5),
      placa      VARCHAR(20),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // CRLV-e Ceará (Vistocar, assíncrono): guarda o pedido registrado até o webhook
  // avisar que o documento saiu. movement_id é o identificador que a Vistocar
  // devolve no registro e repete na notificação — é por ele que o webhook
  // encontra de quem é o pedido.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vistocar_pending (
      movement_id VARCHAR(100) PRIMARY KEY,
      query_id    INTEGER REFERENCES queries(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      phone       VARCHAR(20),
      service_id  VARCHAR(100),
      placa       VARCHAR(20),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Toda notificação recebida da Vistocar fica gravada aqui, processada ou não —
  // serve de trilha para conferir entregas e diagnosticar problemas. event_id é
  // UNIQUE porque a Vistocar reenvia o mesmo evento (mesmo eventId) até receber
  // 2xx: o ON CONFLICT descarta o reenvio em vez de processar duas vezes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vistocar_webhooks (
      id          SERIAL PRIMARY KEY,
      event_id    VARCHAR(100) UNIQUE,
      movement_id VARCHAR(100),
      evento      VARCHAR(60),
      payload     TEXT,
      processed   BOOLEAN DEFAULT FALSE,
      erro        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // O ATPV-e tem DOIS identificadores e eles não se substituem: movement_id é o
  // número interno da consulta na Vistocar (o que a notificação repete) e
  // protocolo é o UUID do ATPV-e no Detran, o único aceito pelas rotas de
  // registro, alteração, exclusão e situação. A tabela nasceu só com o
  // movement_id, de quando o fluxo era o CRLV-e do Ceará — que não tem protocolo.
  // registrado_em marca o momento em que o registro foi efetivado (PUT): nulo
  // quer dizer "cadastrado, esperando o cliente registrar".
  await pool.query(`ALTER TABLE vistocar_pending ADD COLUMN IF NOT EXISTS protocolo VARCHAR(100);`);
  await pool.query(`ALTER TABLE vistocar_pending ADD COLUMN IF NOT EXISTS registrado_em TIMESTAMPTZ;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vistocar_webhooks_movement ON vistocar_webhooks(movement_id);`);
  // A tabela nasceu sem event_id/evento (primeira versão, antes da documentação
  // do webhook) — CREATE TABLE IF NOT EXISTS não acrescenta coluna em tabela que
  // já existe, então as duas entram por ALTER.
  await pool.query(`ALTER TABLE vistocar_webhooks ADD COLUMN IF NOT EXISTS event_id VARCHAR(100);`);
  await pool.query(`ALTER TABLE vistocar_webhooks ADD COLUMN IF NOT EXISTS evento VARCHAR(60);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vistocar_webhooks_event ON vistocar_webhooks(event_id);`);
  // Cadastro do nosso endpoint na Vistocar: a chaveSeguranca que valida a
  // assinatura das notificações fica aqui, não em variável de ambiente — o
  // cadastro é feito pela própria API (ver registrarWebhookVistocar).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vistocar_webhook_config (
      id             SERIAL PRIMARY KEY,
      webhook_id     VARCHAR(50),
      url            TEXT,
      chave_seguranca TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Contador de disparos por canal do broadcast: e ele que faz as campanhas
  // alternarem (ver proximaCampanhaBroadcast). Uma linha por canal.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcast_campanha_state (
      canal      VARCHAR(20) PRIMARY KEY,
      disparos   INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Quando cada disparo de cadencia longa saiu pela ultima vez. Cron diario +
  // esta marca = "de N em N dias" de verdade: o cron da Vercel so sabe dizer
  // "dia 1, 6, 11..." do mes, que emenda 6 dias na virada.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcast_agenda (
      canal        VARCHAR(20) PRIMARY KEY,
      ultimo_envio TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS query_messages (
      id         SERIAL PRIMARY KEY,
      query_id   INTEGER REFERENCES queries(id) ON DELETE CASCADE,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      key_hash     VARCHAR(64) UNIQUE NOT NULL,
      key_prefix   VARCHAR(12) NOT NULL,
      label        VARCHAR(100),
      active       BOOLEAN DEFAULT true,
      last_used_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_orders (
      id          SERIAL PRIMARY KEY,
      token       VARCHAR(64) UNIQUE NOT NULL,
      service_id  VARCHAR(100) NOT NULL,
      params      TEXT NOT NULL,
      amount      NUMERIC(10,2) NOT NULL,
      gateway_id  VARCHAR(100) UNIQUE,
      status      VARCHAR(20) DEFAULT 'PENDING',
      error_msg   TEXT,
      result_data TEXT,
      contact     VARCHAR(200),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE public_orders ADD COLUMN IF NOT EXISTS access_code VARCHAR(20);`);
  await pool.query(`ALTER TABLE public_orders ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20);`);
  // "amount" segue sendo o preço do serviço; no cartão de débito o cobrado é 5%
  // maior e fica em charged_amount (ver CARTAO_ACRESCIMO).
  await pool.query(`ALTER TABLE public_orders ADD COLUMN IF NOT EXISTS method VARCHAR(10) NOT NULL DEFAULT 'PIX';`);
  await pool.query(`ALTER TABLE public_orders ADD COLUMN IF NOT EXISTS charged_amount NUMERIC(10,2);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_access_codes (
      id           SERIAL PRIMARY KEY,
      code         VARCHAR(20) UNIQUE NOT NULL,
      label        VARCHAR(100) NOT NULL,
      active       BOOLEAN DEFAULT true,
      uses         INTEGER DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_general_queries (
      id                SERIAL PRIMARY KEY,
      api_key_id        INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
      service_id        VARCHAR(100) NOT NULL,
      params            TEXT,
      result_data       TEXT,
      charge_phone      VARCHAR(20),
      charge_gateway_id VARCHAR(100),
      charge_status     VARCHAR(20) DEFAULT 'NONE',
      charge_sent_at    TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_service_prices (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service_id  VARCHAR(100) NOT NULL,
      price       NUMERIC(10,2) NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, service_id)
    );
  `);
  // ── Pós-pago ───────────────────────────────────────────────────────────────
  // Marca no usuário + fatura por ciclo. O saldo (users.credits) NÃO é usado no
  // pós-pago: fica parado em zero e o consumo vai para a fatura aberta, para o
  // cliente nunca pagar duas vezes a mesma consulta (uma no saldo, outra na
  // fatura). Teto NULL = sem limite de consumo no ciclo.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pos_pago BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pos_pago_limite NUMERIC(10,2)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pos_pago_desde TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faturas (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status         VARCHAR(20) NOT NULL DEFAULT 'ABERTA'
                     CHECK (status IN ('ABERTA','FECHADA','PAGA','CANCELADA')),
      valor          NUMERIC(10,2) NOT NULL DEFAULT 0.00,
      periodo_inicio TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      vencimento     TIMESTAMPTZ NOT NULL,
      fechada_em     TIMESTAMPTZ,
      paga_em        TIMESTAMPTZ,
      gateway_id     VARCHAR(100),
      origem_baixa   VARCHAR(20),
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Uma fatura aberta por cliente é invariante do desenho todo: é nela que
  // debitarConsulta soma, e é ela que a virada de ciclo fecha. O índice parcial
  // faz o banco recusar uma segunda, em vez de o dinheiro se dividir em duas
  // faturas sem ninguém perceber.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_faturas_uma_aberta
      ON faturas (user_id) WHERE status='ABERTA'
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturas_user ON faturas (user_id, created_at DESC)`);
  // Mensagens do admin para UM cliente, lidas no painel logado (ver "Mensagens
  // ao cliente" nas rotas). Existe porque o WhatsApp do cadastro às vezes está
  // errado e aí não sobra canal nenhum para um assunto urgente. lida_em é do
  // DESTINATÁRIO: na mensagem do admin, quando o cliente leu; na resposta do
  // cliente, quando o admin abriu a conversa.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mensagens_usuario (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      autor      VARCHAR(10) NOT NULL CHECK (autor IN ('admin','usuario')),
      texto      TEXT NOT NULL,
      lida_em    TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensagens_usuario_user ON mensagens_usuario (user_id, created_at)`);
  // Comunicado = a mesma mensagem para todos os clientes de uma vez. Vira uma
  // linha de mensagens_usuario por cliente (cada um tem o seu aviso, o seu
  // "lida em" e pode responder), marcada com comunicado_id para a caixa de
  // entrada do admin não se encher de centenas de conversas sem resposta.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comunicados (
      id         SERIAL PRIMARY KEY,
      texto      TEXT NOT NULL,
      total      INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE mensagens_usuario ADD COLUMN IF NOT EXISTS comunicado_id INTEGER REFERENCES comunicados(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensagens_usuario_comunicado ON mensagens_usuario (comunicado_id) WHERE comunicado_id IS NOT NULL`);
  console.log('✅ Tabelas prontas');
}

// No serverless o initDB() é disparado solto no cold start (ver o final do
// arquivo): se a conexão cair justo nesse momento, a instância continua
// servindo requisições com as tabelas faltando — e mesmo quando dá certo, uma
// requisição pode chegar antes de ele terminar. Quem depende de tabela recente
// (as rotas da ASD e as do CRLV-e CE/Vistocar) espera por aqui em vez de estourar
// com "relation does not exist"; se a tentativa anterior falhou, a próxima
// chamada tenta de novo.
let dbReadyPromise = null;
function ensureDbReady() {
  if (!dbReadyPromise) {
    dbReadyPromise = initDB().catch((err) => { dbReadyPromise = null; throw err; });
  }
  return dbReadyPromise;
}

// ── Middlewares ──────────────────────────────────────────────────────────────
// Limite elevado para acomodar requisições com documentos em base64 (fotos de
// RG/CNH tiradas do celular somam bem mais que 1 PDF).
// verify: a assinatura do webhook da Vistocar é calculada sobre o corpo BRUTO
// (bytes recebidos, antes do parse), então guardamos o buffer só nessa rota —
// manter a cópia em todas encareceria as requisições grandes. São os DOIS
// caminhos de VISTOCAR_WEBHOOK_PATHS: sem o rawBody a assinatura não confere e
// a notificação seria descartada como falsa.
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    const url = req.originalUrl || '';
    if (VISTOCAR_WEBHOOK_PATHS.some(p => url.startsWith(p))) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
// A página avulsa não pode sair pelo servidor de estáticos (isso pularia a
// validação do código de acesso) — redireciona para a rota controlada, que
// exige ?codigo=XXXXXX ativo. Registrado ANTES do express.static de propósito.
app.get('/consulta-avulsa.html', (req, res) => {
  const qs = req.originalUrl.split('?')[1];
  res.redirect('/consulta-avulsa' + (qs ? '?' + qs : ''));
});
// express.static ignora dotfiles por padrão (é isso que impede o .env de vazar
// via HTTP) — abre uma exceção só pra essa subpasta, exigida pelo Android pra
// verificar o Digital Asset Links do app TWA (assetlinks.json).
app.use('/.well-known', express.static(path.join(__dirname, '.well-known'), { dotfiles: 'allow', etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));
app.use(express.static(path.join(__dirname), { etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

// ── Helpers ──────────────────────────────────────────────────────────────────
const cleanDoc = (v) => v.replace(/[\.\-\/]/g, '').trim();

// Validação de dígitos verificadores de CPF (algoritmo oficial da Receita Federal).
function isValidCPF(cpf) {
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * (10 - i);
  let dv1 = 11 - (sum % 11);
  if (dv1 >= 10) dv1 = 0;
  if (dv1 !== parseInt(d[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i], 10) * (11 - i);
  let dv2 = 11 - (sum % 11);
  if (dv2 >= 10) dv2 = 0;
  return dv2 === parseInt(d[10], 10);
}

// Validação de dígitos verificadores de CNPJ (algoritmo oficial da Receita Federal).
function isValidCNPJ(cnpj) {
  const d = cnpj.replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calcDv = (base) => {
    const weights = base.length === 12
      ? [5,4,3,2,9,8,7,6,5,4,3,2]
      : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const sum = base.split('').reduce((acc, digit, i) => acc + parseInt(digit, 10) * weights[i], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  if (calcDv(d.slice(0, 12)) !== parseInt(d[12], 10)) return false;
  return calcDv(d.slice(0, 13)) === parseInt(d[13], 10);
}

// CPF (11 dígitos) ou CNPJ (14 dígitos) válido conforme dígito verificador.
function isValidDoc(doc) {
  const d = (doc || '').replace(/\D/g, '');
  if (d.length === 11) return isValidCPF(d);
  if (d.length === 14) return isValidCNPJ(d);
  return false;
}

// Telefone BR: DDD (11-99) + fixo (8 dígitos) ou celular (9 dígitos).
function isValidPhoneBR(phone) {
  const d = (phone || '').replace(/\D/g, '');
  if (d.length !== 10 && d.length !== 11) return false;
  const ddd = parseInt(d.slice(0, 2), 10);
  return ddd >= 11 && ddd <= 99;
}

function generateAffiliateCode(name) {
  const base = name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${base}${rand}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket?.remoteAddress || '').trim();
}

const BONUS_INDICACAO = 10.00;

// ── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token =
    req.cookies.auth_token ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function requireReseller(req, res, next) {
  if (req.user.role !== 'reseller' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Acesso restrito a revendedores.' });
  next();
}

const SUPER_ADMIN_EMAILS = ['contato@mygmail.com.br', 'contato@mcdetranrj.com'];

// Não existe coluna/valor de "role" para admin — o admin é definido pelo e-mail
// (SUPER_ADMIN_EMAILS). Usado tanto pelo middleware requireSuperAdmin quanto por
// checagens pontuais (ex.: serviços adminOnly em SERVICES_V2).
async function isSuperAdmin(userId) {
  try {
    const r = await pool.query('SELECT email FROM users WHERE id=$1', [userId]);
    return r.rows.length > 0 && SUPER_ADMIN_EMAILS.includes(r.rows[0].email);
  } catch {
    return false;
  }
}

async function requireSuperAdmin(req, res, next) {
  try {
    if (!(await isSuperAdmin(req.user.id)))
      return res.status(403).json({ error: 'Acesso restrito ao super administrador.' });
    next();
  } catch {
    res.status(500).json({ error: 'Erro interno.' });
  }
}

// ── Autenticação por chave de API (clientes externos) ─────────────────────────
// Só o SHA-256 da chave fica no banco — o valor completo ("mcd_..." + 48 hex) é
// exibido uma única vez na criação, então vazamento do banco não expõe chaves.
const hashApiKey = k => crypto.createHash('sha256').update(k).digest('hex');

// Dois tipos de chave: vinculada a um usuário (pré-paga, debita os créditos da
// conta) ou GERAL (user_id NULL, pós-paga) — a consulta roda sem debitar
// ninguém e fica registrada em api_general_queries para o admin cobrar depois
// por WhatsApp na página Cobranças API.
async function requireApiKey(req, res, next) {
  const raw = (req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
  if (!raw || !raw.startsWith('mcd_'))
    return res.status(401).json({ error: 'Chave de API ausente. Envie no header X-API-Key ou Authorization: Bearer mcd_...' });
  try {
    const r = await pool.query(
      `SELECT k.id AS key_id, k.label, u.id AS user_id, u.active, u.name, u.email
         FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
        WHERE k.key_hash=$1 AND k.active=true`,
      [hashApiKey(raw)]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Chave de API inválida ou revogada.' });
    const row = r.rows[0];
    if (row.user_id && !row.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    req.apiKey  = { id: row.key_id, label: row.label, general: !row.user_id };
    req.apiUser = row.user_id ? { id: row.user_id, name: row.name, email: row.email } : null;
    pool.query('UPDATE api_keys SET last_used_at=NOW() WHERE id=$1', [row.key_id]).catch(() => {});
    next();
  } catch (e) {
    console.error('Erro em requireApiKey:', e.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, cpf_cnpj, email, phone, password, role, referral_code } = req.body;

  if (!name || !cpf_cnpj || !email || !phone || !password)
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });

  if (password.length < 8)
    return res.status(400).json({ error: 'A senha deve ter ao menos 8 caracteres.' });

  if (!isValidDoc(cpf_cnpj))
    return res.status(400).json({ error: 'CPF ou CNPJ inválido.' });

  if (!isValidPhoneBR(phone))
    return res.status(400).json({ error: 'Telefone inválido. Informe com DDD, ex.: (21) 90000-0000.' });

  const doc = cleanDoc(cpf_cnpj);
  const mail = email.toLowerCase().trim();

  try {
    const dup = await pool.query(
      'SELECT id FROM users WHERE email=$1 OR cpf_cnpj=$2',
      [mail, doc]
    );
    if (dup.rows.length > 0)
      return res.status(409).json({ error: 'E-mail ou CPF/CNPJ já cadastrado.' });

    const newIP = getClientIP(req);

    // Resolver código de afiliado + verificar IP
    let referredBy = null;
    let referrerIP = null;
    if (referral_code) {
      const ref = await pool.query(
        'SELECT id, ip_address FROM users WHERE affiliate_code=$1',
        [referral_code.toUpperCase()]
      );
      if (ref.rows.length > 0) {
        referredBy = ref.rows[0].id;
        referrerIP = ref.rows[0].ip_address;
      }
    }

    const hash = await bcrypt.hash(password, 12);
    const affCode = generateAffiliateCode(name);
    const userRole = role === 'reseller' ? 'reseller' : 'user';

    const r = await pool.query(
      `INSERT INTO users (name, cpf_cnpj, email, phone, password_hash, role, affiliate_code, referred_by, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, name, email, role`,
      [name.trim(), doc, mail, phone?.trim() || null, hash, userRole, affCode, referredBy, newIP || null]
    );

    const user = r.rows[0];

    // Creditar R$ 10,00 ao novo usuário (indicado) se IPs forem diferentes
    if (referredBy && newIP && referrerIP !== newIP) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE users SET credits = credits + $1 WHERE id=$2',
          [BONUS_INDICACAO, user.id]
        );
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, description)
           VALUES ($1,'deposit',$2,$3)`,
          [user.id, BONUS_INDICACAO, `Bônus de boas-vindas por indicação`]
        );
        await client.query('COMMIT');
        console.log(`✅ Bônus R$${BONUS_INDICACAO} creditado ao novo usuário ${user.id} por ser indicado de ${referredBy}`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Erro ao creditar bônus indicação:', e.message);
      } finally {
        client.release();
      }
    } else if (referredBy && newIP && referrerIP === newIP) {
      console.log(`⚠️ Bônus bloqueado: mesmo IP (${newIP}) do indicante ${referredBy}`);
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 3600 * 1000,
      sameSite: 'lax',
    });
    res.json({ success: true, user });
  } catch (err) {
    console.error('Erro no cadastro:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password)
    return res.status(400).json({ error: 'Preencha e-mail/CPF/CNPJ e senha.' });

  const id = identifier.trim();
  const isEmail = id.includes('@');
  const lookup = isEmail ? id.toLowerCase() : cleanDoc(id);
  const field = isEmail ? 'email' : 'cpf_cnpj';

  try {
    const r = await pool.query(
      `SELECT * FROM users WHERE ${field}=$1`,
      [lookup]
    );
    if (r.rows.length === 0)
      return res.status(401).json({ error: 'Credenciais inválidas.' });

    const user = r.rows[0];
    if (!user.active)
      return res.status(403).json({ error: 'Conta bloqueada. Contate o suporte.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(401).json({ error: 'Credenciais inválidas.' });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 3600 * 1000,
      sameSite: 'lax',
    });
    res.json({
      success: true,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('Erro no login:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { identifier } = req.body;
  if (!identifier)
    return res.status(400).json({ error: 'Informe seu e-mail ou CPF/CNPJ.' });

  const id = identifier.trim();
  const isEmail = id.includes('@');
  const lookup = isEmail ? id.toLowerCase() : cleanDoc(id);
  const field = isEmail ? 'email' : 'cpf_cnpj';

  const genericMsg = 'Se os dados informados estiverem corretos, enviaremos um código de verificação via WhatsApp para o número cadastrado na conta.';

  try {
    const r = await pool.query(`SELECT id, phone FROM users WHERE ${field}=$1 AND active=true`, [lookup]);
    if (r.rows.length > 0 && r.rows[0].phone) {
      const user = r.rows[0];
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await pool.query('DELETE FROM password_resets WHERE user_id=$1', [user.id]);
      await pool.query(
        `INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1,$2,$3)`,
        [user.id, codeHash, expiresAt]
      );

      const msg = [
        `🔐 *Redefinição de senha*`,
        ``,
        `Seu código de verificação é: *${code}*`,
        ``,
        `Válido por 10 minutos. Se você não solicitou, ignore esta mensagem.`,
      ].join('\n');
      await sendWhatsApp(user.phone, msg).catch(() => {});
    }
    // Resposta sempre genérica para não revelar quais contas existem
    res.json({ success: true, message: genericMsg });
  } catch (err) {
    console.error('Erro no forgot-password:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { identifier, code, new_password } = req.body;
  if (!identifier || !code || !new_password)
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  if (new_password.length < 8)
    return res.status(400).json({ error: 'A senha deve ter ao menos 8 caracteres.' });

  const id = identifier.trim();
  const isEmail = id.includes('@');
  const lookup = isEmail ? id.toLowerCase() : cleanDoc(id);
  const field = isEmail ? 'email' : 'cpf_cnpj';

  try {
    const ur = await pool.query(`SELECT id FROM users WHERE ${field}=$1`, [lookup]);
    if (ur.rows.length === 0)
      return res.status(400).json({ error: 'Código inválido ou expirado.' });
    const userId = ur.rows[0].id;

    const pr = await pool.query(
      'SELECT id, code_hash, expires_at, attempts FROM password_resets WHERE user_id=$1',
      [userId]
    );
    if (pr.rows.length === 0)
      return res.status(400).json({ error: 'Código inválido ou expirado.' });
    const reset = pr.rows[0];

    if (new Date(reset.expires_at) < new Date() || reset.attempts >= 5) {
      await pool.query('DELETE FROM password_resets WHERE id=$1', [reset.id]);
      return res.status(400).json({ error: 'Código inválido ou expirado.' });
    }

    const match = await bcrypt.compare(code, reset.code_hash);
    if (!match) {
      await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id=$1', [reset.id]);
      return res.status(400).json({ error: 'Código inválido ou expirado.' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
    await pool.query('DELETE FROM password_resets WHERE id=$1', [reset.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Erro no reset-password:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, email, phone, role, credits, affiliate_code, cpf_cnpj, pos_pago FROM users WHERE id=$1',
      [req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/affiliate/stats ──────────────────────────────────────────────────
app.get('/api/affiliate/stats', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [codeRow, totalRow, activeRow, commRow] = await Promise.all([
      pool.query('SELECT affiliate_code FROM users WHERE id=$1', [uid]),
      pool.query('SELECT COUNT(*) FROM users WHERE referred_by=$1', [uid]),
      pool.query('SELECT COUNT(*) FROM users WHERE referred_by=$1 AND active=true', [uid]),
      pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM commissions WHERE reseller_id=$1', [uid]),
    ]);
    res.json({
      affiliate_code:   codeRow.rows[0].affiliate_code,
      total_referrals:  parseInt(totalRow.rows[0].count),
      active_referrals: parseInt(activeRow.rows[0].count),
      total_commissions: parseFloat(commRow.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/reseller/stats ───────────────────────────────────────────────────
app.get('/api/reseller/stats', requireAuth, requireReseller, async (req, res) => {
  try {
    const rid = req.user.id;
    const [userRow, totalRow, activeRow, monthRow, allTimeRow] = await Promise.all([
      pool.query('SELECT credits, affiliate_code FROM users WHERE id=$1', [rid]),
      pool.query('SELECT COUNT(*) FROM users WHERE referred_by=$1', [rid]),
      pool.query('SELECT COUNT(*) FROM users WHERE referred_by=$1 AND active=true', [rid]),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM commissions
                  WHERE reseller_id=$1 AND created_at >= date_trunc('month', NOW())`, [rid]),
      pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM commissions WHERE reseller_id=$1', [rid]),
    ]);
    res.json({
      credits:           parseFloat(userRow.rows[0].credits),
      affiliate_code:    userRow.rows[0].affiliate_code,
      total_clients:     parseInt(totalRow.rows[0].count),
      active_clients:    parseInt(activeRow.rows[0].count),
      month_commissions: parseFloat(monthRow.rows[0].total),
      total_commissions: parseFloat(allTimeRow.rows[0].total),
    });
  } catch (err) {
    console.error('Erro em stats:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/reseller/clients ─────────────────────────────────────────────────
app.get('/api/reseller/clients', requireAuth, requireReseller, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, email, cpf_cnpj, phone, credits, active, created_at
       FROM users WHERE referred_by=$1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ clients: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── POST /api/reseller/clients — revendedor cria cliente diretamente ─────────
app.post('/api/reseller/clients', requireAuth, requireReseller, async (req, res) => {
  const { name, cpf_cnpj, email, phone, password } = req.body;

  if (!name || !cpf_cnpj || !email || !phone || !password)
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'A senha deve ter ao menos 8 caracteres.' });
  if (!isValidDoc(cpf_cnpj))
    return res.status(400).json({ error: 'CPF ou CNPJ inválido.' });
  if (!isValidPhoneBR(phone))
    return res.status(400).json({ error: 'Telefone inválido. Informe com DDD, ex.: (21) 90000-0000.' });

  const doc  = cleanDoc(cpf_cnpj);
  const mail = email.toLowerCase().trim();

  try {
    const dup = await pool.query(
      'SELECT id FROM users WHERE email=$1 OR cpf_cnpj=$2',
      [mail, doc]
    );
    if (dup.rows.length > 0)
      return res.status(409).json({ error: 'E-mail ou CPF/CNPJ já cadastrado.' });

    const hash    = await bcrypt.hash(password, 12);
    const affCode = generateAffiliateCode(name);

    const r = await pool.query(
      `INSERT INTO users (name, cpf_cnpj, email, phone, password_hash, role, affiliate_code, referred_by)
       VALUES ($1,$2,$3,$4,$5,'user',$6,$7)
       RETURNING id, name, email, phone, cpf_cnpj, credits, active, created_at`,
      [name.trim(), doc, mail, phone?.trim() || null, hash, affCode, req.user.id]
    );
    res.json({ success: true, client: r.rows[0] });
  } catch (err) {
    console.error('Erro ao criar cliente:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── PUT /api/reseller/clients/:id/toggle ──────────────────────────────────────
app.put('/api/reseller/clients/:id/toggle', requireAuth, requireReseller, async (req, res) => {
  try {
    const c = await pool.query(
      'SELECT id, active FROM users WHERE id=$1 AND referred_by=$2',
      [req.params.id, req.user.id]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const newActive = !c.rows[0].active;
    await pool.query('UPDATE users SET active=$1 WHERE id=$2', [newActive, req.params.id]);
    res.json({ success: true, active: newActive });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/reseller/commissions ─────────────────────────────────────────────
app.get('/api/reseller/commissions', requireAuth, requireReseller, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.amount, c.rate, c.created_at,
              u.name AS client_name,
              COALESCE(t.amount, 0) AS deposit_amount
       FROM commissions c
       JOIN users u ON u.id = c.client_id
       LEFT JOIN transactions t ON t.id = c.transaction_id
       WHERE c.reseller_id=$1
       ORDER BY c.created_at DESC LIMIT 200`,
      [req.user.id]
    );
    res.json({ commissions: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/auth/me (extended) ───────────────────────────────────────────────
// ── PUT /api/profile ──────────────────────────────────────────────────────────
app.put('/api/profile', requireAuth, async (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    const r = await pool.query(
      'UPDATE users SET name=$1, phone=$2 WHERE id=$3 RETURNING id, name, email, phone, role',
      [name.trim(), phone?.trim() || null, req.user.id]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/services ─────────────────────────────────────────────────────────
app.get('/api/services', requireAuth, async (req, res) => {
  try {
    const overridesR = await pool.query(
      'SELECT service_id, price FROM user_service_prices WHERE user_id=$1', [req.user.id]
    );
    const overrides = {};
    overridesR.rows.forEach(row => { overrides[row.service_id] = parseFloat(row.price); });
    res.json({
      services: SERVICES.map(s => ({
        ...s,
        // Serviço de grupo gratuito ignora o preço fixo por usuário (catalogPrice
        // devolve 0) — é a mesma regra aplicada na cobrança em getUserServicePrice.
        price: isFreeService(s) ? 0 : (overrides[s.id] ?? catalogPrice(s)),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/asd-logos (menu de logos do cabeçalho da ASD) ────────────────────
// Lista servida pelo servidor para o painel não precisar repetir o catálogo:
// acrescentar um conselho estadual é mexer só em ASD_LOGOS.
app.get('/api/asd-logos', requireAuth, (req, res) => {
  res.json({
    padrao: ASD_LOGO_PADRAO,
    logos: Object.entries(ASD_LOGOS).map(([id, l]) => ({ id, label: l.label })),
  });
});

// ── GET /api/services/public (sem auth — homepage) ────────────────────────────
app.get('/api/services/public', (req, res) => {
  res.json({
    services: SERVICES.map(s => ({
      id:    s.id,
      name:  s.name,
      group: s.group,
      icon:  s.icon,
      price: catalogPrice(s),
    })),
  });
});

// ── GET /api/services-v2 (catálogo Datacube — aba "Opção 2 Nova Consulta") ────
app.get('/api/services-v2', requireAuth, async (req, res) => {
  const admin = await isSuperAdmin(req.user.id);
  res.json({
    services: SERVICES_V2
      .filter(s => !s.adminOnly || admin)
      .map(s => ({
        ...s,
        price: parseFloat((s.basePrice * (s.noMarkup ? 1 : MARKUP)).toFixed(2)),
      })),
  });
});

// ── GET /api/services-v3 (catálogo Infosimples — aba "Infosimples Nova Consulta") ──
app.get('/api/services-v3', requireAuth, (req, res) => {
  res.json({
    services: SERVICES_V3.map(s => ({
      ...s,
      price: parseFloat((s.basePrice * INFOSIMPLES_MARKUP).toFixed(2)),
    })),
  });
});

// ── GET /api/user/stats ───────────────────────────────────────────────────────
app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const [userRow, monthRow, totalRow, countRow] = await Promise.all([
      pool.query('SELECT credits FROM users WHERE id=$1', [req.user.id]),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM queries
         WHERE user_id=$1 AND created_at >= date_trunc('month', NOW())`,
        [req.user.id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM queries WHERE user_id=$1`,
        [req.user.id]
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM queries WHERE user_id=$1`,
        [req.user.id]
      ),
    ]);
    // Cliente pós-pago não tem saldo — o card "Saldo" da Visão Geral vira
    // "Fatura em aberto" e o menu troca a Recarga PIX pela Conta Pós-paga. Quem
    // é pré-pago recebe pos_pago:false e a tela não muda em nada.
    const pp = await resumoPosPago(req.user.id);
    res.json({
      credits:       parseFloat(userRow.rows[0].credits),
      month_spent:   parseFloat(monthRow.rows[0].total),
      total_spent:   parseFloat(totalRow.rows[0].total),
      total_queries: parseInt(countRow.rows[0].total),
      pos_pago:      !!pp.posPago,
      fatura_aberto: pp.posPago ? pp.emAberto : null,
      fatura_devido: pp.posPago ? pp.devido : null,
      fatura_vence:  pp.posPago && pp.fatura ? pp.fatura.vencimento : null,
      fatura_vencida: pp.posPago ? pp.bloqueado : false,
    });
  } catch (err) {
    console.error('Erro em user/stats:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/queries ──────────────────────────────────────────────────────────
app.get('/api/queries', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT q.id, q.service_id, q.service_name, q.params, q.status, q.amount,
              q.result_type, q.created_at,
              -- Há consulta que fica 'aguardando_pdf' já cobrada: o status não
              -- diz se houve débito, o transaction_id sim.
              (q.transaction_id IS NOT NULL) AS cobrada,
              CASE WHEN q.service_id = 'inserir-comunicacao-venda'
                   THEN q.result_data ELSE NULL END AS comunicacao_venda_meta,
              pc.token      AS pdf_token,
              pc.expires_at AS pdf_expires
       FROM queries q
       LEFT JOIN pdf_cache pc
         ON pc.query_id = q.id
        AND pc.user_id  = q.user_id
        AND pc.expires_at > NOW()
       WHERE q.user_id=$1
       ORDER BY q.created_at DESC LIMIT 100`,
      [req.user.id]
    );

    // Sincroniza silenciosamente comunicações de venda que já têm um
    // "comunicacao_id" vinculado com o status atual no portal — cobre dois
    // casos de ação feita direto no site do portal (fora dos botões deste
    // painel), que sem isso ficariam com o status errado para sempre:
    // 1) transmitida direto lá ("Importado" preso mesmo já "comunicado");
    // 2) cancelada direto lá pelo Portal deles ("Comunicado" preso mesmo já
    //    "cancelado" — é por isso que não basta parar de checar depois que
    //    _transmitido vira true). Best effort: uma falha aqui nunca deve
    //    quebrar a listagem.
    for (const row of r.rows) {
      if (row.service_id !== 'inserir-comunicacao-venda' || !row.comunicacao_venda_meta) continue;
      let meta = {};
      try { meta = JSON.parse(row.comunicacao_venda_meta); } catch {}
      if (meta._cancelado || !meta.comunicacao_id) continue;
      try {
        const sync = await correlateComunicacaoVenda(meta.comunicacao_id);
        if (!sync) continue;

        let merged = null;
        if (!meta._transmitido && sync.status === 'comunicado') {
          merged = { ...meta, ...sync, _transmitido: true };
        } else if (meta._transmitido && sync.status === 'cancelado') {
          merged = { ...meta, ...sync, _cancelado: true };
        }
        if (!merged) continue;

        await pool.query('UPDATE queries SET result_data=$1 WHERE id=$2', [JSON.stringify(merged), row.id]);
        row.comunicacao_venda_meta = JSON.stringify(merged);

        const params = JSON.parse(row.params || '{}');
        const cached = await cacheComunicacaoVendaPdf(row.id, req.user.id, params, merged);
        row.result_type = 'pdf';
        row.pdf_token   = cached.token;
        row.pdf_expires = cached.expiresAt;
      } catch (e) {
        console.error(`Erro ao sincronizar comunicação de venda [query ${row.id}]:`, e.message);
      }
    }

    res.json({ queries: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/queries/:id/result ────────────────────────────────────────────────
// Reexibe o JSON de uma consulta já paga sem refazer a chamada à API upstream
// (que cobraria créditos de novo). Consultas feitas antes deste recurso existir
// não têm result_data salvo — retorna 404 nesse caso.
app.get('/api/queries/:id/result', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT service_name, amount, created_at, result_data FROM queries
       WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Consulta não encontrada.' });
    const row = r.rows[0];
    if (!row.result_data) return res.status(404).json({ error: 'Resultado não disponível para esta consulta.', service_name: row.service_name });
    res.json({
      service_name: row.service_name,
      amount: row.amount,
      created_at: row.created_at,
      result: JSON.parse(row.result_data),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});


// ── GET /api/pdf/:token ───────────────────────────────────────────────────────
app.get('/api/pdf/:token', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.pdf_data, q.service_id, q.params
         FROM pdf_cache c LEFT JOIN queries q ON q.id = c.query_id
        WHERE c.token=$1 AND c.user_id=$2 AND c.expires_at > NOW()`,
      [req.params.token, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'PDF não encontrado ou expirado.' });
    const buf = Buffer.from(r.rows[0].pdf_data, 'base64');
    let placaCache = '';
    try { placaCache = (JSON.parse(r.rows[0].params || '{}').placa || '').toUpperCase(); } catch {}
    const nomeArquivo = nomeArquivoVistocar(r.rows[0].service_id, placaCache)
      || `consulta-${req.params.token.slice(0,8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}"`);
    return res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Algumas APIs upstream (ex.: portaldespachantes.online) aninham o motivo real do erro em
// `details.details.msg` em vez de expor no nível raiz — desce a cadeia de
// `details` para achar a mensagem mais específica disponível.
function extractApiErrorMsg(data) {
  let msg = data?.error || data?.message || data?.msg || data?.erro || data?.mensagem;
  let current = data;
  while (current?.details && typeof current.details === 'object') {
    current = current.details;
    msg = current?.msg || current?.message || current?.error || current?.erro || current?.mensagem || msg;
  }
  return msg || JSON.stringify(data);
}

// ── Geração de PDF — Débitos por Estado (Datacube retorna JSON, não PDF pronto) ──
// Reproduz o layout do relatório que a própria Datacube gera (barras de seção em
// azul, tabela de campos com bordas, "Nada consta" para campos vazios), trocando
// a logo/marca deles pela da MC Despachadoria. O formato varia por estado (ex.:
// RJ tem campos de multa diferentes de SC/SP), então cada registro é desenhado
// como uma grade genérica de todos os campos retornados, na ordem em que vêm.
function fmtMoneyBRL(v) {
  const n = Number(v);
  return 'R$ ' + (Number.isFinite(n) ? n : 0).toFixed(2).replace('.', ',');
}

function humanizeKey(k) {
  return String(k)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function maskPlacaDisplay(p) {
  const c = (p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 7 ? `${c.slice(0, 3)}-${c.slice(3)}` : (p || '-');
}

function maskDocDisplay(d) {
  const digits = (d || '').replace(/\D/g, '');
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d || '-';
}

function pdfContentBox(doc) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  return { left, width };
}

// Evita barras/títulos "órfãos" no fim da página — força quebra antes se não
// houver espaço para a barra e pelo menos uma linha de conteúdo.
function pdfEnsureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) doc.addPage();
}

// Barra de seção principal (ex.: "MULTAS", "VEÍCULO") — fundo azul cheio, texto
// branco centralizado, no mesmo espírito do relatório da Datacube.
function pdfBar(doc, text, opts = {}) {
  const { bg = '#1e40af', color = '#ffffff', size = 10.5, align = 'center' } = opts;
  pdfEnsureSpace(doc, 30);
  const { left, width } = pdfContentBox(doc);
  const barY = doc.y;
  const barH = 22;
  doc.rect(left, barY, width, barH).fill(bg);
  doc.fillColor(color).font('Helvetica-Bold').fontSize(size)
    .text(text, left + 10, barY + 6, { width: width - 20, align });
  doc.y = barY + barH + 8;
  doc.fillColor('#111827').font('Helvetica').fontSize(10);
}

// Barra menor usada para identificar cada registro dentro de uma lista
// (ex.: "Multas - 1", "Licenciamentos - 2").
function pdfSubBar(doc, text) {
  pdfEnsureSpace(doc, 24);
  const { left, width } = pdfContentBox(doc);
  const barY = doc.y;
  const barH = 18;
  doc.rect(left, barY, width, barH).fill('#dbeafe');
  doc.fillColor('#1e40af').font('Helvetica-Bold').fontSize(9.5)
    .text(text, left + 8, barY + 4, { width: width - 16 });
  doc.y = barY + barH + 4;
  doc.fillColor('#111827').font('Helvetica').fontSize(10);
}

function pdfEmptyNotice(doc, text = 'Nenhum registro encontrado.') {
  doc.fillColor('#9ca3af').fontSize(9.5).font('Helvetica-Oblique').text(text);
  doc.fillColor('#111827').font('Helvetica').fontSize(10);
  doc.moveDown(0.4);
}

function pdfNoteLine(doc, text) {
  doc.fillColor('#6b7280').fontSize(9.5).text(text);
  doc.fillColor('#111827').fontSize(10);
  doc.moveDown(0.4);
}

// Cabeçalho padrão (marca MC Despachadoria + título) usado por todos os relatórios
// PDF gerados a partir de JSON da Datacube.
function pdfReportHeader(doc, title, now) {
  doc.fontSize(18).fillColor('#1e40af').font('Helvetica-Bold')
    .text('MC Despachadoria Consultas', { align: 'center' });
  doc.fontSize(8.5).fillColor('#6b7280').font('Helvetica')
    .text(`Gerado em ${now.toLocaleString('pt-BR')}`, { align: 'center' });
  doc.moveDown(0.6);
  doc.fontSize(15).fillColor('#111827').font('Helvetica-Bold')
    .text(title, { align: 'center' });
  doc.moveDown(0.7);
  doc.fillColor('#111827').font('Helvetica').fontSize(10);
}

// Rodapé padrão (data da consulta + aviso de confidencialidade/responsabilidade).
function pdfReportFooter(doc, now) {
  const { left, width } = pdfContentBox(doc);
  pdfEnsureSpace(doc, 90);
  pdfBar(doc, `Data da consulta: ${now.toLocaleString('pt-BR')}`, { bg: '#dbeafe', color: '#1e40af', size: 9.5 });
  doc.fontSize(7.5).fillColor('#374151').font('Helvetica-Bold').text('* Importante', left, doc.y, { width });
  doc.font('Helvetica').fillColor('#6b7280')
    .text('As informações aqui contidas são de caráter estritamente confidencial. Nosso sistema disponibiliza tais informações apenas para análise, não tendo nenhuma responsabilidade ou ingerência pelas inclusões errôneas nos bancos de dados, pois tais inserções são realizadas pelos orgãos responsáveis. Desta forma, o REQUERENTE assume toda e qualquer responsabilidade sobre a utilização das informações.', left, doc.y, { width });
}

// Tabela de 2 colunas com bordas (rótulo em negrito + valor abaixo, célula com
// contorno) — usada tanto para "Dados do Veículo" quanto para os campos de cada
// registro de multa/IPVA/licenciamento/dívida ativa.
function pdfFieldGrid(doc, pairs) {
  if (!pairs.length) return;
  const { left, width } = pdfContentBox(doc);
  const colWidth = width / 2;
  const padX = 8, padTop = 6, padBottom = 6, labelGap = 2;
  const labelSize = 8.5, valueSize = 9;

  for (let i = 0; i < pairs.length; i += 2) {
    const [l1, v1] = pairs[i];
    const p2 = pairs[i + 1];
    const innerWidth = colWidth - padX * 2;

    doc.font('Helvetica-Bold').fontSize(labelSize);
    const labelH1 = doc.heightOfString(l1 + ':', { width: innerWidth });
    doc.font('Helvetica').fontSize(valueSize);
    const valueH1 = doc.heightOfString(String(v1), { width: innerWidth });
    let cellH1 = labelH1 + labelGap + valueH1;

    let cellH2 = 0;
    if (p2) {
      doc.font('Helvetica-Bold').fontSize(labelSize);
      const labelH2 = doc.heightOfString(p2[0] + ':', { width: innerWidth });
      doc.font('Helvetica').fontSize(valueSize);
      const valueH2 = doc.heightOfString(String(p2[1]), { width: innerWidth });
      cellH2 = labelH2 + labelGap + valueH2;
    }

    const rowH = Math.max(cellH1, cellH2) + padTop + padBottom;
    pdfEnsureSpace(doc, rowH + 2);
    const rowY = doc.y;

    doc.strokeColor('#e5e7eb').lineWidth(0.75).rect(left, rowY, width, rowH).stroke();
    if (p2) doc.moveTo(left + colWidth, rowY).lineTo(left + colWidth, rowY + rowH).stroke();

    doc.font('Helvetica-Bold').fontSize(labelSize).fillColor('#111827')
      .text(l1 + ':', left + padX, rowY + padTop, { width: innerWidth });
    doc.font('Helvetica').fontSize(valueSize).fillColor('#374151')
      .text(String(v1), left + padX, doc.y + labelGap, { width: innerWidth });

    if (p2) {
      doc.font('Helvetica-Bold').fontSize(labelSize).fillColor('#111827')
        .text(p2[0] + ':', left + colWidth + padX, rowY + padTop, { width: innerWidth });
      doc.font('Helvetica').fontSize(valueSize).fillColor('#374151')
        .text(String(p2[1]), left + colWidth + padX, doc.y + labelGap, { width: innerWidth });
    }

    doc.y = rowY + rowH;
    doc.fillColor('#111827').font('Helvetica').fontSize(10);
  }
}

// Converte um registro (multa/IPVA/licenciamento/...) em pares [rótulo, valor],
// preenchendo campos vazios com "Nada consta" — igual ao relatório da Datacube,
// em vez de simplesmente omitir o campo.
function itemToPairs(item) {
  return Object.entries(item || {})
    .filter(([, v]) => typeof v !== 'object')
    .map(([k, v]) => [humanizeKey(k), (v === null || v === undefined || v === '') ? 'Nada consta' : String(v)]);
}

function pdfDebtSection(doc, items, groupLabel) {
  if (!Array.isArray(items) || items.length === 0) { pdfEmptyNotice(doc); return; }
  items.forEach((item, idx) => {
    pdfSubBar(doc, `${groupLabel} - ${idx + 1}`);
    pdfFieldGrid(doc, itemToPairs(item));
    doc.moveDown(0.35);
  });
}

// Renderiza um objeto de resposta genérico da Datacube por completo, ao contrário
// de "itemToPairs(data)" sozinho — que descarta silenciosamente qualquer campo
// aninhado (ex.: um sub-objeto "veiculo" ou uma lista de "restrições"), fazendo o
// relatório sair sem as informações do veículo quando a API aninha os dados sob
// uma chave em vez de devolver tudo no nível raiz.
function pdfRenderGenericObject(doc, data) {
  if (!data || typeof data !== 'object') {
    pdfEmptyNotice(doc, 'Nenhum dado retornado para essa consulta.');
    return;
  }
  const scalarPairs = itemToPairs(data);
  if (scalarPairs.length) pdfFieldGrid(doc, scalarPairs);

  const nestedEntries = Object.entries(data).filter(([, v]) => v && typeof v === 'object');
  if (!nestedEntries.length) {
    if (!scalarPairs.length) pdfEmptyNotice(doc, 'Nenhum dado retornado para essa consulta.');
    return;
  }

  nestedEntries.forEach(([key, value]) => {
    if (scalarPairs.length) doc.moveDown(0.3);
    pdfSubBar(doc, humanizeKey(key));
    if (Array.isArray(value)) {
      if (!value.length) { pdfEmptyNotice(doc); return; }
      if (typeof value[0] === 'object') pdfDebtSection(doc, value, humanizeKey(key));
      else pdfFieldGrid(doc, value.map((v, i) => [String(i + 1), String(v)]));
    } else {
      const pairs = itemToPairs(value);
      if (pairs.length) pdfFieldGrid(doc, pairs);
      else pdfEmptyNotice(doc);
    }
  });
}

function pickNum(item, keys) {
  for (const k of keys) if (typeof item?.[k] === 'number') return item[k];
  return undefined;
}

function sumNumField(items, keys) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((acc, it) => acc + (pickNum(it, keys) || 0), 0);
}

function computeTotalDebitos(data) {
  let total = 0;
  total += sumNumField(data?.ipvas, ['valor']);
  total += sumNumField(data?.multas, ['valor']);
  total += sumNumField(data?.licenciamentos, ['valor']);
  total += sumNumField(data?.dpvats, ['valor']);
  const da = data?.dividaativa;
  if (Array.isArray(da)) {
    total += sumNumField(da, ['total', 'valor', 'debitos']);
  } else if (da && typeof da === 'object') {
    total += typeof da.total === 'number' ? da.total : sumNumField(da.debitos, ['valor']);
  }
  return total;
}

function buildDebitoPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const { left, width } = pdfContentBox(doc);
      const now = new Date();

      const ufName = (service.name || '').replace(/^Débitos\s*-\s*/i, '');
      pdfReportHeader(doc, `DÉBITOS - ${ufName.toUpperCase()}`, now);

      // Dados da consulta (o que foi enviado nesta consulta)
      pdfBar(doc, 'DADOS DA CONSULTA');
      const consultaPairs = [
        ['Placa', maskPlacaDisplay(params?.placa)],
        ['Renavam', params?.renavam || '-'],
      ];
      if (params?.documento) consultaPairs.push(['Documento', maskDocDisplay(params.documento)]);
      if (params?.chassi) consultaPairs.push(['Chassi', params.chassi]);
      pdfFieldGrid(doc, consultaPairs);
      doc.moveDown(0.4);

      // Veículo
      pdfBar(doc, 'VEÍCULO');
      const veicPairs = itemToPairs(data?.veiculo);
      if (veicPairs.length) pdfFieldGrid(doc, veicPairs);
      else pdfEmptyNotice(doc, 'Sem dados adicionais do veículo.');
      doc.moveDown(0.4);

      // Resumo — total estimado de débitos (destaque em laranja, cor de alerta da marca)
      const total = computeTotalDebitos(data);
      pdfEnsureSpace(doc, 36);
      const boxY = doc.y;
      const boxH = 28;
      doc.rect(left, boxY, width, boxH).fill('#f97316');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5)
        .text('TOTAL ESTIMADO DE DÉBITOS', left + 12, boxY + 9);
      doc.fontSize(13).text(fmtMoneyBRL(total), left, boxY + 7, { width: width - 12, align: 'right' });
      doc.y = boxY + boxH + 4;
      doc.fillColor('#9ca3af').fontSize(7).font('Helvetica-Oblique')
        .text('Soma dos valores encontrados nesta consulta — pode não refletir juros, descontos ou acréscimos legais atualizados.', left, doc.y, { width });
      doc.fillColor('#111827').font('Helvetica').fontSize(10);
      doc.moveDown(0.4);

      // Multas, Dpvats, Dívida Ativa, Ipvas, Licenciamentos — mesma ordem do JSON
      // retornado pela Datacube (e do relatório oficial deles).
      pdfBar(doc, 'MULTAS');
      pdfDebtSection(doc, data?.multas, 'Multas');

      pdfBar(doc, 'DPVATS');
      if (data?.dpvats_obs) pdfNoteLine(doc, `Indisponível: ${data.dpvats_obs}`);
      else pdfDebtSection(doc, data?.dpvats, 'Dpvats');

      pdfBar(doc, 'DÍVIDA ATIVA');
      const dividaAtiva = data?.dividaativa;
      if (Array.isArray(dividaAtiva)) {
        pdfDebtSection(doc, dividaAtiva, 'Dívida Ativa');
      } else if (dividaAtiva && typeof dividaAtiva === 'object' && Object.keys(dividaAtiva).length) {
        pdfDebtSection(doc, dividaAtiva.debitos, 'Dívida Ativa');
      } else {
        pdfEmptyNotice(doc);
      }

      pdfBar(doc, 'IPVAS');
      pdfDebtSection(doc, data?.ipvas, 'Ipvas');

      pdfBar(doc, 'LICENCIAMENTOS');
      pdfDebtSection(doc, data?.licenciamentos, 'Licenciamentos');

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Dívida Ativa (Datacube retorna JSON, não PDF pronto) ──────
function buildDividaAtivaPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const { left, width } = pdfContentBox(doc);
      const now = new Date();

      const ufName = (service.name || '').replace(/^Dívida Ativa\s*-\s*/i, '');
      pdfReportHeader(doc, `DÍVIDA ATIVA - ${ufName.toUpperCase()}`, now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      const consultaPairs = [];
      if (params?.placa) consultaPairs.push(['Placa', maskPlacaDisplay(params.placa)]);
      consultaPairs.push(['Renavam', params?.renavam || '-']);
      pdfFieldGrid(doc, consultaPairs);
      doc.moveDown(0.4);

      const items = Array.isArray(data) ? data : (Array.isArray(data?.debitos) ? data.debitos : null);
      const total = Array.isArray(items)
        ? sumNumField(items, ['total', 'valor', 'debitos'])
        : (typeof data?.total === 'number' ? data.total : 0);

      pdfEnsureSpace(doc, 36);
      const boxY = doc.y;
      const boxH = 28;
      doc.rect(left, boxY, width, boxH).fill('#f97316');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5)
        .text('TOTAL ESTIMADO DE DÍVIDA ATIVA', left + 12, boxY + 9);
      doc.fontSize(13).text(fmtMoneyBRL(total), left, boxY + 7, { width: width - 12, align: 'right' });
      doc.y = boxY + boxH + 4;
      doc.fillColor('#9ca3af').fontSize(7).font('Helvetica-Oblique')
        .text('Soma dos valores encontrados nesta consulta — pode não refletir juros, descontos ou acréscimos legais atualizados.', left, doc.y, { width });
      doc.fillColor('#111827').font('Helvetica').fontSize(10);
      doc.moveDown(0.4);

      pdfBar(doc, 'DÉBITOS');
      if (Array.isArray(items)) {
        pdfDebtSection(doc, items, 'Débito');
      } else {
        const pairs = itemToPairs(data);
        if (pairs.length) pdfFieldGrid(doc, pairs);
        else pdfEmptyNotice(doc, 'Nenhum débito de dívida ativa encontrado.');
      }
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Decodificação de Motor (Datacube retorna JSON, não PDF pronto) ──
function buildMotorPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'DECODIFICAÇÃO DE MOTOR', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Motor', params?.motor || '-']]);
      doc.moveDown(0.4);

      pdfBar(doc, 'RESULTADO');
      const pairs = itemToPairs(data);
      if (pairs.length) pdfFieldGrid(doc, pairs);
      else pdfEmptyNotice(doc, 'Nenhum dado retornado para esse motor.');
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Localização CPF (Datacube retorna JSON, não PDF pronto) ───
// Usa o renderizador genérico porque a resposta pode trazer o endereço direto no
// objeto raiz ou aninhado (ex.: lista de endereços), variando conforme o CPF.
function buildLocalizacaoCpfPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'LOCALIZAÇÃO CPF', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['CPF', maskDocDisplay(params?.cpf)]]);
      doc.moveDown(0.4);

      pdfBar(doc, 'RESULTADO');
      pdfRenderGenericObject(doc, data);
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Heurística de mapeamento — Localização CPF V3 → formulário da Declaração de
// Residência (usada em POST /api/declaracao-residencia/localizar pra pré-preencher
// o formulário). O retorno da Datacube não tem um contrato de nomes de campo
// documentado (varia por CPF/registro), então tentamos vários apelidos por chave,
// normalizados (minúsculo, sem acento/pontuação) — o formulário fica editável de
// qualquer forma, então o pior caso é o campo ficar em branco pro usuário
// preencher à mão, nunca um valor errado silencioso.
function pickAlias(obj, aliases) {
  if (!obj || typeof obj !== 'object') return '';
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = aliases.map(norm);
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (wanted.includes(norm(k))) return String(v).trim();
  }
  return '';
}

// "historicos.enderecos"/"nomes"/... vêm como listas — pega o primeiro registro
// (mais recente, conforme a própria Datacube ordena o histórico).
function firstRecord(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const item = list[0];
  if (item === null || item === undefined) return null;
  return typeof item === 'object' ? item : { valor: item };
}

// Usada em POST /api/contrato-aluguel/localizar — só precisa do nome (Locador
// ou Locatário), diferente da Declaração de Residência que pré-preenche o
// endereço inteiro do requerente.
function extractNomeFromLocalizacaoV3(localizacaoData) {
  const nomeRec = firstRecord(localizacaoData?.nomes);
  return pickAlias(nomeRec, ['nome', 'nome_completo', 'valor']);
}

// Mesma heurística de pickAlias, mas descendo em objetos/arrays aninhados —
// necessária para o retorno de "Proprietário Atual" (dc-proprietario-atual,
// mesmo endpoint Datacube da aba "Opção 2 Nova Consulta"), cujo formato
// (proprietário + dados do veículo em subobjetos) também não é documentado.
// Usada em POST /api/procuracao-veicular/localizar-placa — o formulário fica
// editável, então o pior caso é o campo ficar em branco.
function deepFindAlias(obj, aliases, depth = 3) {
  if (!obj || typeof obj !== 'object' || depth < 0) return '';
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindAlias(item, aliases, depth - 1);
      if (found) return found;
    }
    return '';
  }
  const direct = pickAlias(obj, aliases);
  if (direct) return direct;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = deepFindAlias(v, aliases, depth - 1);
      if (found) return found;
    }
  }
  return '';
}

function extractProprietarioAtualFields(data) {
  // Schema real confirmado em produção (placa KPU4A03): {..., marca, modelo,
  // proprietario_documento, proprietario_nome, ...} — marca/modelo vêm em
  // campos separados (não "marca_modelo"), e os apelidos de nome/documento
  // do proprietário usam a ordem "proprietario_X", não "X_proprietario".
  const marca = deepFindAlias(data, ['marca']);
  const modelo = deepFindAlias(data, ['modelo', 'descricao_modelo']);
  return {
    nome:          deepFindAlias(data, ['proprietario_nome', 'nome_proprietario', 'nome', 'proprietario', 'nome_completo']),
    cpfCnpj:       deepFindAlias(data, ['proprietario_documento', 'documento_proprietario', 'cpf_cnpj', 'cpfcnpj', 'cpf', 'cnpj', 'documento']),
    logradouro:    deepFindAlias(data, ['logradouro', 'endereco', 'rua']),
    numero:        deepFindAlias(data, ['numero', 'numero_endereco', 'num']),
    complemento:   deepFindAlias(data, ['complemento']),
    bairro:        deepFindAlias(data, ['bairro']),
    cidade:        deepFindAlias(data, ['cidade', 'municipio']),
    uf:            deepFindAlias(data, ['uf', 'estado']),
    cep:           deepFindAlias(data, ['cep']),
    marcaModelo:   [marca, modelo].filter(Boolean).join('/') || deepFindAlias(data, ['marca_modelo', 'marcamodelo', 'marca_modelo_versao']),
    chassi:        deepFindAlias(data, ['chassi']),
    renavam:       deepFindAlias(data, ['renavam']),
    cor:           deepFindAlias(data, ['cor', 'cor_veiculo']),
    anoFabricacao: deepFindAlias(data, ['ano_fabricacao', 'anofabricacao', 'ano_fab']),
    anoModelo:     deepFindAlias(data, ['ano_modelo', 'anomodelo', 'ano_mod']),
    // Campos que só a ASD RJ usa: o formulário oficial do CRDD-RJ tem uma
    // célula para cada um. Os apelidos cobrem as variações vistas entre a
    // Proprietário Atual (Datacube) e a consulta completa da Vistocar — campo
    // ausente vira célula em branco, que o despachante preenche à mão.
    especie:       deepFindAlias(data, ['especie', 'especie_veiculo', 'descricao_especie']),
    capacidade:    deepFindAlias(data, ['capacidade', 'capacidade_carga', 'capacidade_passageiros', 'lotacao']),
    procedencia:   deepFindAlias(data, ['procedencia', 'nacionalidade', 'origem']),
    categoria:     deepFindAlias(data, ['categoria', 'categoria_veiculo', 'descricao_categoria']),
    tipo:          deepFindAlias(data, ['tipo_veiculo', 'tipo', 'descricao_tipo']),
    potencia:      deepFindAlias(data, ['potencia', 'potencia_motor', 'cilindradas', 'cilindrada']),
    combustivel:   deepFindAlias(data, ['combustivel', 'tipo_combustivel', 'descricao_combustivel']),
    municipio:     deepFindAlias(data, ['municipio', 'cidade', 'municipio_veiculo']),
  };
}

// Junta os componentes de endereço (de Proprietário Atual ou, em fallback, da
// consulta completa da Vistocar) numa única linha de texto pronta para o parágrafo da
// procuração — mais simples e robusto do que expor 7 campos separados no
// formulário para um dado que é só impresso numa frase.
function composeEndereco({ logradouro, numero, complemento, bairro, cidade, uf, cep }) {
  const parts = [];
  if (logradouro) parts.push(logradouro + (numero ? `, ${numero}` : ''));
  if (complemento) parts.push(complemento);
  if (bairro) parts.push(bairro);
  if (cidade || uf) parts.push([cidade, uf].filter(Boolean).join('/'));
  if (cep) parts.push(`CEP ${cep}`);
  return parts.join(', ');
}

function extractDeclaracaoResidenciaFields(localizacaoData) {
  const nomeRec  = firstRecord(localizacaoData?.nomes);
  const endRec   = firstRecord(localizacaoData?.enderecos);
  const telRec   = firstRecord(localizacaoData?.telefones);
  const celRec   = firstRecord(localizacaoData?.celulares);
  const emailRec = firstRecord(localizacaoData?.emails);

  return {
    nome:        pickAlias(nomeRec, ['nome', 'nome_completo', 'valor']),
    logradouro:  pickAlias(endRec, ['logradouro', 'endereco', 'rua']),
    numero:      pickAlias(endRec, ['numero', 'numero_endereco', 'num']),
    complemento: pickAlias(endRec, ['complemento']),
    bairro:      pickAlias(endRec, ['bairro']),
    cidade:      pickAlias(endRec, ['cidade', 'municipio']),
    uf:          pickAlias(endRec, ['uf', 'estado']),
    cep:         pickAlias(endRec, ['cep']),
    telefone:    pickAlias(telRec, ['telefone', 'numero', 'valor']),
    celular:     pickAlias(celRec, ['celular', 'telefone', 'numero', 'valor']),
    email:       pickAlias(emailRec, ['email', 'valor']),
  };
}

// ── Geração de PDF — Declaração de Residência DETRAN RJ, sobrepondo os dados do
// formulário (já preenchido/editado pelo usuário) no PDF oficial "DETRAN - Nº
// 0034 - rev. 07" (ver assets/declaracao-residencia-detran-rj-template.pdf).
// Mesma técnica do buildNumeroAtpvePdfBuffer (usar o PDF real como base em vez de
// remontar o layout do zero), mas aqui as coordenadas já vêm direto no sistema do
// pdf-lib (origem no canto inferior esquerdo) — medidas com pdfjs/getTextContent
// no PDF de referência, sem precisar do passo de conversão top→bottom do ATPVe.
const DECLARACAO_RESIDENCIA_TEMPLATE_PATH = path.join(__dirname, 'assets', 'declaracao-residencia-detran-rj-template.pdf');

// Brasão do CRDD-RJ, usado no cabeçalho da Nota de Prestação de Serviços Para
// Despachantes RJ e da ASD RJ. Substituiu o brasão nacional (CRDD BR) nos dois
// documentos a pedido do cliente — assets/crdd-br-logo.png continua no repo,
// mas não é mais usado por nenhum serviço.
const CRDD_RJ_LOGO_PATH = path.join(__dirname, 'assets', 'crdd-rj-logo.png');

// Logos disponíveis no cabeçalho da ASD. Hoje só o CRDD-RJ: o serviço é a
// "Gerar ASD RJ" e reproduz o formulário oficial do conselho do Rio, então não
// há o que escolher — o painel esconde o menu enquanto houver uma opção só (ver
// preencherLogosAsd). Para acrescentar um estado: solte o PNG em assets/ e
// adicione uma linha aqui; o menu volta sozinho, sem mexer no front-end.
const ASD_LOGOS = {
  rj: { label: 'CRDD-RJ — Rio de Janeiro',  path: path.join(__dirname, 'assets', 'crdd-rj-logo.png') },
};
const ASD_LOGO_PADRAO = 'rj';
function asdLogoPath(id) {
  return (ASD_LOGOS[String(id || '').toLowerCase()] || ASD_LOGOS[ASD_LOGO_PADRAO]).path;
}
const MESES_EXTENSO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function drawDeclaracaoValue(page, font, text, { x, y, maxX, size = 9, minSize = 6 }) {
  const value = (text ?? '').toString().trim();
  if (!value) return;
  const maxW = maxX - x;
  let fSize = size;
  let display = value;
  while (font.widthOfTextAtSize(display, fSize) > maxW && fSize > minSize) fSize -= 0.5;
  if (font.widthOfTextAtSize(display, fSize) > maxW) {
    while (display.length > 1 && font.widthOfTextAtSize(display + '…', fSize) > maxW) display = display.slice(0, -1);
    display = display + '…';
  }
  page.drawText(display, { x, y, size: fSize, font, color: rgb(0.067, 0.094, 0.153) });
}

async function buildDeclaracaoResidenciaPdfBuffer(params) {
  const templateBytes = await fs.promises.readFile(DECLARACAO_RESIDENCIA_TEMPLATE_PATH);
  const pdfDoc = await PDFLibDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(PDFLibStandardFonts.Helvetica);

  const V = (text, opts) => drawDeclaracaoValue(page, font, text, opts);

  V(params.nome,                { x: 104, y: 722.14, maxX: 520 });
  V(params.nomeSocial,          { x: 134, y: 704.62, maxX: 520 });
  V(params.documentoIdentidade, { x: 196, y: 687.10, maxX: 335 });
  V(params.orgaoExpedidor,      { x: 429, y: 687.10, maxX: 520 });
  V(maskDocDisplay(params.cpf), { x: 95,  y: 669.58, maxX: 250 });
  V(params.nacionalidade,       { x: 142, y: 652.06, maxX: 335 });
  V(params.naturalidade,        { x: 411, y: 652.06, maxX: 520 });

  // Telefone/Celular: o rótulo do template já traz um placeholder "(          )"
  // fixo, mas ele faz parte do mesmo texto de "Telefone:"/"Celular:" (sem posição
  // isolada pra apagar só o meio sem arriscar cortar o rótulo) — por isso o valor
  // entra depois do rótulo inteiro, em vez de tentar encaixar dentro dos parênteses.
  V(params.telefone, { x: 156, y: 634.54, maxX: 335 });
  V(params.celular,  { x: 423, y: 634.54, maxX: 520 });

  V(params.email,       { x: 109, y: 617.02, maxX: 520 });
  V(params.endereco,    { x: 120, y: 577.87, maxX: 520 });
  V(params.numero,      { x: 86,  y: 560.35, maxX: 140 });
  V(params.complemento, { x: 217, y: 560.35, maxX: 388 });
  V(params.cep,         { x: 419, y: 560.35, maxX: 520 });
  V(params.uf,          { x: 90,  y: 542.83, maxX: 140 });
  V(params.cidade,      { x: 185, y: 542.83, maxX: 367 });
  V(params.bairro,      { x: 408, y: 542.83, maxX: 520 });

  // "Rio de Janeiro ___ de ______________ de ____" — data da assinatura, sempre a
  // data de geração da declaração. Apaga todos os traços de uma vez (do fim de
  // "Rio de Janeiro " até o fim da linha) e escreve a data inteira num texto só —
  // mais simples e robusto do que tentar encaixar dia/mês/ano nos espaços exatos
  // dos "de" estáticos do template.
  const now = new Date();
  const dataPorExtenso = `${String(now.getDate()).padStart(2, '0')} de ${MESES_EXTENSO[now.getMonth()]} de ${now.getFullYear()}`;
  page.drawRectangle({ x: 236, y: 437, width: 225, height: 12, color: rgb(1, 1, 1) });
  V(dataPorExtenso, { x: 239, y: 439.97, maxX: 459 });

  return Buffer.from(await pdfDoc.save());
}

// ── Geração de PDF — Gerar Contrato de Aluguel. Diferente dos relatórios acima
// (que sobrepõem dados num PDF/template oficial já pronto), aqui não existe
// documento oficial — o contrato é montado do zero com pdfkit, seguindo o
// modelo padrão de Contrato de Locação de Imóvel Urbano previsto na Lei nº
// 8.245/91 (Lei do Inquilinato), com pequenas variações de texto entre
// Residencial e Comercial (destinação do imóvel na Cláusula 1ª e ressalva do
// direito à ação renovatória — art. 51 — na Cláusula 2ª, exclusiva do
// comercial).
function formatDateBr(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}

function formatDateExtenso(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso || '';
  return `${m[3]} de ${MESES_EXTENSO[parseInt(m[2], 10) - 1]} de ${m[1]}`;
}

// x/width sempre explícitos (não confiar no cursor implícito do pdfkit): um
// pdfFieldGrid antes destas chamadas termina com .text(str, x, y, {width})
// nas duas colunas, o que desloca doc.x para a coluna direita — sem x/width
// aqui, o próximo parágrafo herdaria essa posição e saíria estreito/deslocado.
function pdfContractTitle(doc, text) {
  const { left, width } = pdfContentBox(doc);
  doc.font('Helvetica-Bold').fontSize(9.5).text(text, left, doc.y, { width, align: 'left' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9.5);
}

function pdfContractParagraph(doc, text) {
  const { left, width } = pdfContentBox(doc);
  doc.font('Helvetica').fontSize(9.5).text(text, left, doc.y, { width, align: 'justify', lineGap: 1.5 });
  doc.moveDown(0.6);
}

function pdfContractSignatureBlock(doc, y, side, title, lines) {
  const { left, width } = pdfContentBox(doc);
  const colW = width / 2 - 10;
  const x = side === 'right' ? left + width - colW : left;
  doc.moveTo(x, y).lineTo(x + colW, y).stroke();
  doc.fontSize(9).font('Helvetica-Bold').text(title, x, y + 4, { width: colW, align: 'center' });
  doc.font('Helvetica');
  lines.forEach((line, i) => doc.text(line, x, y + 16 + i * 12, { width: colW, align: 'center' }));
}

function buildContratoAluguelPdfBuffer(params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 55 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const isComercial = params.tipo === 'comercial';
      const destinacao = isComercial ? 'comerciais' : 'residenciais';
      const now = new Date();

      doc.font('Helvetica-Bold').fontSize(14)
        .text(`CONTRATO DE LOCAÇÃO ${isComercial ? 'COMERCIAL (NÃO RESIDENCIAL)' : 'RESIDENCIAL'} DE IMÓVEL URBANO`, { align: 'center' });
      doc.moveDown(1);

      pdfContractParagraph(doc,
        `Pelo presente instrumento particular de Contrato de Locação, de um lado ${params.locadorNome}, ` +
        `inscrito(a) no CPF/CNPJ sob o nº ${maskDocDisplay(params.locadorCpfCnpj)}, doravante denominado(a) simplesmente LOCADOR(A), ` +
        `e de outro lado ${params.locatarioNome}, inscrito(a) no CPF/CNPJ sob o nº ${maskDocDisplay(params.locatarioCpfCnpj)}, ` +
        `doravante denominado(a) simplesmente LOCATÁRIO(A), têm entre si justo e contratado o presente Contrato de Locação de Imóvel ` +
        `${isComercial ? 'para Fins Não Residenciais' : 'Residencial'}, que se regerá pela Lei nº 8.245, de 18 de outubro de 1991 ` +
        `(Lei do Inquilinato), e pelas cláusulas e condições a seguir estabelecidas:`);

      pdfContractTitle(doc, 'CLÁUSULA 1ª – DO OBJETO');
      pdfContractParagraph(doc,
        `O LOCADOR dá em locação ao LOCATÁRIO, que aceita, o imóvel situado à ${params.enderecoLocacao}, destinado exclusivamente ` +
        `para fins ${destinacao}, não podendo o LOCATÁRIO alterar essa destinação sem prévia anuência escrita do LOCADOR.`);

      pdfContractTitle(doc, 'CLÁUSULA 2ª – DO PRAZO');
      pdfContractParagraph(doc,
        `A presente locação vigorará pelo prazo determinado, com início em ${formatDateBr(params.dataInicio)} e término em ` +
        `${formatDateBr(params.dataFim)}, findo o qual, se o LOCATÁRIO permanecer no imóvel sem oposição do LOCADOR, a locação ` +
        `prorrogar-se-á por prazo indeterminado, nos termos da legislação vigente.` +
        (isComercial ? ` Fica ressalvado ao LOCATÁRIO o direito à ação renovatória, nos termos do art. 51 da Lei nº 8.245/91, ` +
          `caso preenchidos os requisitos legais para tanto.` : ''));

      pdfContractTitle(doc, 'CLÁUSULA 3ª – DO ALUGUEL E FORMA DE PAGAMENTO');
      pdfContractParagraph(doc,
        `O aluguel mensal ajustado entre as partes é de ${fmtMoneyBRL(params.valorAluguel)}, a ser pago pelo LOCATÁRIO até o dia ` +
        `5 (cinco) de cada mês, relativo ao mês vencido, mediante depósito ou transferência bancária em conta indicada pelo ` +
        `LOCADOR, sob pena de multa moratória de 10% (dez por cento) sobre o valor em atraso, juros de mora de 1% (um por cento) ` +
        `ao mês e correção monetária pelo índice pactuado na Cláusula 4ª.`);

      pdfContractTitle(doc, 'CLÁUSULA 4ª – DO REAJUSTE');
      pdfContractParagraph(doc,
        `O valor do aluguel será reajustado anualmente, ou na menor periodicidade admitida em lei, com base na variação ` +
        `acumulada do IGP-M/FGV (Índice Geral de Preços do Mercado) ou outro índice oficial que venha a substituí-lo.`);

      pdfContractTitle(doc, 'CLÁUSULA 5ª – DAS OBRIGAÇÕES DO LOCATÁRIO');
      pdfContractParagraph(doc,
        `O LOCATÁRIO se obriga a: a) pagar pontualmente o aluguel e os encargos da locação; b) usar o imóvel de acordo com sua ` +
        `destinação, tratando-o com o mesmo cuidado como se fosse seu; c) não sublocar, ceder, emprestar ou transferir total ou ` +
        `parcialmente o imóvel sem prévia autorização escrita do LOCADOR; d) restituir o imóvel, finda a locação, no estado em ` +
        `que o recebeu, salvo o desgaste natural pelo uso regular; e) permitir a vistoria do imóvel pelo LOCADOR, mediante prévio ` +
        `aviso; f) pagar as despesas de consumo (água, luz, gás) e, quando houver, as despesas condominiais ordinárias; g) ` +
        `comunicar imediatamente ao LOCADOR o surgimento de qualquer dano ou defeito cuja reparação a este incumba.`);

      pdfContractTitle(doc, 'CLÁUSULA 6ª – DAS OBRIGAÇÕES DO LOCADOR');
      pdfContractParagraph(doc,
        `O LOCADOR se obriga a: a) entregar o imóvel em condições de uso para os fins a que se destina; b) garantir ao ` +
        `LOCATÁRIO o uso pacífico do imóvel durante todo o prazo da locação; c) responder pelos vícios ou defeitos anteriores à ` +
        `locação; d) pagar os tributos, taxas e demais encargos que incidam ou venham a incidir sobre o imóvel, salvo disposição ` +
        `em contrário estabelecida entre as partes.`);

      pdfContractTitle(doc, 'CLÁUSULA 7ª – DAS BENFEITORIAS');
      pdfContractParagraph(doc,
        `As benfeitorias necessárias introduzidas pelo LOCATÁRIO serão indenizáveis, ainda que não autorizadas, assegurado o ` +
        `direito de retenção. As benfeitorias úteis somente serão indenizáveis se previamente autorizadas por escrito pelo ` +
        `LOCADOR. As benfeitorias voluptuárias não serão indenizáveis, podendo ser levantadas pelo LOCATÁRIO ao término da ` +
        `locação, desde que sua retirada não afete a estrutura ou substância do imóvel.`);

      pdfContractTitle(doc, 'CLÁUSULA 8ª – DA RESCISÃO E MULTA');
      pdfContractParagraph(doc,
        `O descumprimento de qualquer cláusula deste contrato, bem como a rescisão antecipada e imotivada por qualquer das ` +
        `partes, sujeitará o infrator ao pagamento de multa equivalente a 3 (três) aluguéis vigentes à época, calculada ` +
        `proporcionalmente ao período restante do contrato, nos termos do art. 4º da Lei nº 8.245/91, sem prejuízo das perdas e ` +
        `danos cabíveis.`);

      pdfContractTitle(doc, 'CLÁUSULA 9ª – DA GARANTIA');
      pdfContractParagraph(doc,
        `As partes poderão, de comum acordo e em instrumento apartado, convencionar uma das modalidades de garantia ` +
        `locatícia previstas no art. 37 da Lei nº 8.245/91 (caução, fiança, seguro-fiança ou cessão fiduciária de quotas de ` +
        `fundo de investimento), não tendo sido pactuada nenhuma garantia específica neste instrumento.`);

      pdfContractTitle(doc, 'CLÁUSULA 10ª – DO FORO');
      pdfContractParagraph(doc,
        `Fica eleito o foro da comarca de situação do imóvel para dirimir quaisquer dúvidas ou litígios oriundos do presente ` +
        `contrato, com renúncia expressa a qualquer outro, por mais privilegiado que seja.`);

      pdfContractParagraph(doc,
        `E, por estarem assim justos e contratados, firmam o presente instrumento em 2 (duas) vias de igual teor e forma, na ` +
        `presença das testemunhas abaixo.`);

      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(9.5)
        .text(`Local, ${formatDateExtenso(now.toISOString().slice(0, 10))}.`, { align: 'center' });

      pdfEnsureSpace(doc, 150);
      doc.moveDown(3);
      const y1 = doc.y;
      pdfContractSignatureBlock(doc, y1, 'left', 'LOCADOR(A)',
        [params.locadorNome, `CPF/CNPJ: ${maskDocDisplay(params.locadorCpfCnpj)}`]);
      pdfContractSignatureBlock(doc, y1, 'right', 'LOCATÁRIO(A)',
        [params.locatarioNome, `CPF/CNPJ: ${maskDocDisplay(params.locatarioCpfCnpj)}`]);

      doc.y = y1 + 60;
      pdfEnsureSpace(doc, 60);
      doc.moveDown(2);
      const y2 = doc.y;
      pdfContractSignatureBlock(doc, y2, 'left', 'TESTEMUNHA 1', ['CPF: ______________________']);
      pdfContractSignatureBlock(doc, y2, 'right', 'TESTEMUNHA 2', ['CPF: ______________________']);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Gerar Procuração Veicular. Mesma técnica do contrato de
// aluguel acima (documento montado do zero com pdfkit, sem PDF/template
// oficial), modelo padrão de procuração particular para atos perante o
// DETRAN e demais órgãos de trânsito. Só o OUTORGANTE assina (procuração
// particular é ato unilateral) — o OUTORGADO só precisa estar qualificado no
// texto.
function buildProcuracaoVeicularPdfBuffer(params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 55 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const now = new Date();

      doc.font('Helvetica-Bold').fontSize(16).text('PROCURAÇÃO', { align: 'center' });
      doc.moveDown(1);

      pdfContractParagraph(doc,
        `Pelo presente instrumento particular de procuração, eu, ${params.outorganteNome}, portador(a) do CPF/CNPJ sob o nº ` +
        `${maskDocDisplay(params.outorganteCpfCnpj)}` +
        (params.outorganteEndereco ? `, residente e domiciliado(a) em ${params.outorganteEndereco},` : ',') +
        ` nomeio e constituo como meu(minha) bastante procurador(a) ${params.outorgadoNome}, portador(a) do CPF/CNPJ sob o nº ` +
        `${maskDocDisplay(params.outorgadoCpfCnpj)}, a quem confiro os poderes descritos neste instrumento para que, em meu ` +
        `nome, junto ao Departamento de Trânsito (DETRAN), aos demais órgãos do Sistema Nacional de Trânsito e a quaisquer ` +
        `terceiros que se fizerem necessários, pratique os atos relativos ao veículo abaixo identificado:`);

      const veiculoPairs = [
        ['Placa', maskPlacaDisplay(params.placa)],
        ['Marca/Modelo', params.marcaModelo],
        ['Chassi', params.chassi],
        ['RENAVAM', params.renavam],
        ['Cor', params.cor],
        ['Ano Fabricação/Modelo', (params.anoFabricacao || params.anoModelo) ? `${params.anoFabricacao || '-'}/${params.anoModelo || '-'}` : ''],
      ].filter(([, v]) => v);
      if (veiculoPairs.length) { pdfFieldGrid(doc, veiculoPairs); doc.moveDown(0.6); }

      pdfContractTitle(doc, 'PODERES');
      pdfContractParagraph(doc,
        `Assinar requerimentos, formulários e demais documentos necessários; solicitar e retirar o Certificado de Registro de ` +
        `Veículo (CRV) e o Certificado de Registro e Licenciamento de Veículo (CRLV); requerer transferência de propriedade, ` +
        `licenciamento anual, alteração de características, inclusão ou baixa de gravame/alienação fiduciária, segunda via de ` +
        `documentos e placas; efetuar o pagamento de taxas, tributos e multas; representar o(a) OUTORGANTE perante o DETRAN, ` +
        `demais órgãos de trânsito, seguradoras e instituições financeiras no que for necessário à regularização do veículo; ` +
        `bem como praticar todos os demais atos necessários ao fiel cumprimento deste mandato, dando tudo por bom, firme e ` +
        `valioso.`);

      pdfContractTitle(doc, 'VALIDADE');
      pdfContractParagraph(doc,
        `Esta procuração é outorgada pelo prazo de 12 (doze) meses, contados desta data, podendo ser revogada a qualquer ` +
        `tempo pelo(a) OUTORGANTE, mediante comunicação escrita.`);

      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(9.5)
        .text(`Local, ${formatDateExtenso(now.toISOString().slice(0, 10))}.`, { align: 'center' });

      pdfEnsureSpace(doc, 150);
      doc.moveDown(3);
      const y1 = doc.y;
      const { left, width } = pdfContentBox(doc);
      doc.moveTo(left + width / 2 - 110, y1).lineTo(left + width / 2 + 110, y1).stroke();
      doc.fontSize(9).font('Helvetica-Bold').text('OUTORGANTE', left, y1 + 4, { width, align: 'center' });
      doc.font('Helvetica').text(params.outorganteNome, left, y1 + 16, { width, align: 'center' });
      doc.text(`CPF/CNPJ: ${maskDocDisplay(params.outorganteCpfCnpj)}`, left, y1 + 28, { width, align: 'center' });

      doc.y = y1 + 60;
      pdfEnsureSpace(doc, 60);
      doc.moveDown(2);
      const y2 = doc.y;
      pdfContractSignatureBlock(doc, y2, 'left', 'TESTEMUNHA 1', ['CPF: ______________________']);
      pdfContractSignatureBlock(doc, y2, 'right', 'TESTEMUNHA 2', ['CPF: ______________________']);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Gerar Nota de Prestação de Serviços Para Despachantes Rio.
// Mesma técnica dos dois anteriores (documento montado do zero com pdfkit,
// sem PDF/template oficial), no padrão de uma Nota de Serviços Eletrônica
// emitida por despachante documentalista — documento meramente declaratório
// (não é nota fiscal, sem cálculo de ISSQN). A discriminação dos serviços
// (itens e valores unitários) é texto livre digitado pelo despachante e
// reproduzido como veio, sem tentar parsear/somar itens — só o Valor Total
// vem como campo numérico separado, destacado em barra própria (equivalente
// ao "VALOR TOTAL BRUTO DA NOTA" do modelo de referência).
function buildNotaPrestacaoServicosPdfBuffer(params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 55 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const now = new Date();
      const { left, width } = pdfContentBox(doc);

      const headerY = doc.y;
      const logoW = 95;
      let logoH = 0;
      try {
        const img = doc.openImage(CRDD_RJ_LOGO_PATH);
        logoH = logoW * (img.height / img.width);
        doc.image(img, left, headerY, { width: logoW });
      } catch (e) {
        console.warn('[nota-prestacao-servicos] logo CRDD-RJ não encontrado:', e.message);
      }

      const titleX = left + logoW + 12;
      const titleWidth = width - logoW - 12;
      doc.font('Helvetica-Bold').fontSize(15)
        .text('NOTA DE PRESTAÇÃO DE SERVIÇOS', titleX, headerY + 6, { width: titleWidth, align: 'center' });
      // O brasão do cabeçalho é o do CRDD-RJ, então a nota precisa dizer na cara
      // que é o modelo dos despachantes do Rio — não vale para outro estado.
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151')
        .text('DESPACHANTES DOCUMENTALISTAS DO RIO DE JANEIRO — CRDD/RJ', titleX, doc.y + 2, { width: titleWidth, align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor('#6b7280')
        .text(`Emitida em ${now.toLocaleString('pt-BR')}`, titleX, doc.y + 2, { width: titleWidth, align: 'center' });
      doc.fillColor('#111827').fontSize(10);

      doc.y = Math.max(doc.y, headerY + logoH) + 10;

      pdfBar(doc, 'PRESTADOR DE SERVIÇOS');
      pdfFieldGrid(doc, [
        ['Nome / Razão Social', params.prestadorNome],
        ['Matrícula (CRDD-UF)', params.matriculaCrdd],
        ['CPF/CNPJ', maskDocDisplay(params.prestadorCpfCnpj)],
      ]);
      doc.moveDown(0.6);

      pdfBar(doc, 'TOMADOR DE SERVIÇOS (CLIENTE)');
      pdfFieldGrid(doc, [
        ['Nome / Razão Social', params.tomadorNome],
        ['CPF/CNPJ', maskDocDisplay(params.tomadorCpfCnpj)],
      ]);
      doc.moveDown(0.6);

      pdfBar(doc, 'DISCRIMINAÇÃO DOS SERVIÇOS PRESTADOS');
      pdfEnsureSpace(doc, 40);
      doc.font('Helvetica').fontSize(9.5).fillColor('#111827')
        .text(params.discriminacaoServicos, left, doc.y, { width, align: 'left', lineGap: 2 });
      doc.moveDown(1);

      pdfEnsureSpace(doc, 30);
      pdfBar(doc, `VALOR TOTAL DOS SERVIÇOS: ${fmtMoneyBRL(params.valorTotal)}`, { bg: '#1e40af', color: '#ffffff', size: 11 });
      doc.moveDown(0.4);

      pdfEnsureSpace(doc, 60);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151').text('OBSERVAÇÕES:', left, doc.y, { width });
      doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(
        '- Documento meramente declaratório, sem valor de nota fiscal; o prestador é responsável cível e criminal pelo ' +
        'conteúdo aqui declarado.\n' +
        '- Eventuais valores referentes a taxas e despesas de órgãos públicos, quando incluídos na discriminação acima, ' +
        'representam meros reembolsos de despesas efetuadas em nome e por conta do tomador do serviço.',
        left, doc.y, { width, lineGap: 1.5 }
      );
      doc.fillColor('#111827').fontSize(10);

      pdfEnsureSpace(doc, 70);
      doc.moveDown(2.5);
      const y1 = doc.y;
      doc.moveTo(left + width / 2 - 110, y1).lineTo(left + width / 2 + 110, y1).stroke();
      doc.fontSize(9).font('Helvetica-Bold').text(params.prestadorNome, left, y1 + 4, { width, align: 'center' });
      doc.font('Helvetica').text(
        `Despachante Documentalista${params.matriculaCrdd ? ' - Matrícula ' + params.matriculaCrdd : ''}`,
        left, y1 + 16, { width, align: 'center' }
      );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Digitalizações da carteirinha da ASD — o front manda as duas fotos já
// redimensionadas como data URL (image/jpeg ou image/png). Aceita só esses dois
// formatos porque são os únicos que o pdfkit embute, e limita o tamanho pra não
// estourar o corpo da requisição nem o pdf_cache. Devolve null quando o valor
// não é uma imagem válida — o anexo é opcional, então o PDF sai sem ele.
const ASD_CARTEIRINHA_MAX_BYTES = 4 * 1024 * 1024;
function decodeAsdCarteirinha(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || '').trim());
  if (!m) return null;
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length || buf.length > ASD_CARTEIRINHA_MAX_BYTES) return null;
  return buf;
}

// ── Cadeia de hashes da ASD ───────────────────────────────────────────────────
// Cada despachante tem um livro sequencial próprio: o chain_hash de cada ASD
// encadeia o da anterior, então adulterar uma ASD antiga invalida todas as
// seguintes daquele profissional (mesma propriedade de uma blockchain, sem
// depender de rede externa, taxa ou chave privada). Não é assinatura digital
// no sentido da Lei 14.063/2020 — é prova de integridade e de data.
const ASD_BASE_URL = WEBHOOK_BASE_URL || 'https://despachantesconsultas.com.br';
const ASD_CHAIN_GENESIS = '0'.repeat(64);
const ASD_CHAIN_LOCK_NS = 8123; // namespace do pg_advisory_xact_lock

// O hash é dos DADOS, não dos bytes do PDF: o próprio código de verificação é
// impresso dentro do PDF (referência circular) e a data de geração mudaria o
// hash a cada reemissão. Normaliza espaços/caixa para que a mesma ASD digitada
// com espaçamento diferente produza o mesmo hash, e cobre as digitalizações
// pelo SHA-256 da imagem — trocar a carteirinha muda o hash.
function asdCanonicalPayload(p) {
  const norm = v => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  const imgHash = d => {
    const buf = decodeAsdCarteirinha(d);
    return buf ? crypto.createHash('sha256').update(buf).digest('hex') : '';
  };
  return JSON.stringify([
    ['servico',     norm(p.servico)],
    ['uf',          norm(p.uf)],
    ['contratante', norm(p.contratante)],
    ['profissional', norm(p.profissionalNome), String(p.profissionalCpfCnpj || ''), norm(p.profissionalMatricula)],
    ['beneficiario', norm(p.beneficiarioNome), String(p.beneficiarioCpfCnpj || '')],
    ['veiculo',     norm(p.placa), norm(p.marcaModelo), norm(p.chassi), norm(p.renavam),
                    norm(p.cor), norm(p.anoFabricacao), norm(p.anoModelo)],
    ['descricao',   norm(p.descricaoDocumental)],
    ['carteirinha', imgHash(p.carteirinhaFrente), imgHash(p.carteirinhaVerso)],
  ]);
}

function asdDocHash(p) {
  return crypto.createHash('sha256').update(asdCanonicalPayload(p), 'utf8').digest('hex');
}

// Insere o próximo elo da cadeia do despachante. O advisory lock serializa por
// usuário: sem ele, duas ASDs emitidas ao mesmo tempo leriam o mesmo prev_hash
// e a cadeia bifurcaria (dois elos apontando para o mesmo anterior).
async function registrarAsdNaCadeia({ userId, docHash, servico, uf, profNome, profDoc, profMatricula }) {
  await ensureDbReady(); // asd_registros é tabela nova — ver comentário em ensureDbReady
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ASD_CHAIN_LOCK_NS, userId]);

    const last = await client.query(
      'SELECT seq, chain_hash FROM asd_registros WHERE user_id=$1 ORDER BY seq DESC LIMIT 1',
      [userId]
    );
    const seq = (last.rows[0]?.seq || 0) + 1;
    const prevHash = last.rows[0]?.chain_hash || ASD_CHAIN_GENESIS;
    const createdAt = new Date();
    const chainHash = crypto.createHash('sha256')
      .update(`${prevHash}|${docHash}|${userId}|${seq}|${createdAt.toISOString()}`, 'utf8')
      .digest('hex');
    // Código derivado do chain_hash: já é único por construção (o chain_hash
    // inclui seq + timestamp), sem precisar sortear e tentar de novo.
    const codigo = `ASD-${createdAt.getFullYear()}-${chainHash.slice(0, 8).toUpperCase()}`;

    const ins = await client.query(
      `INSERT INTO asd_registros
         (user_id, seq, codigo, doc_hash, prev_hash, chain_hash, servico, uf, prof_nome, prof_doc, prof_matricula, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [userId, seq, codigo, docHash, prevHash, chainHash, servico, uf, profNome, profDoc, profMatricula, createdAt]
    );
    await client.query('COMMIT');
    return { id: ins.rows[0].id, seq, codigo, docHash, prevHash, chainHash, createdAt };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// QR do rodapé da ASD, apontando para a página pública de verificação. Mesmo
// bwip-js já usado no código de barras do boleto (JS puro, roda na Vercel).
async function generateAsdQrPng(url) {
  try {
    return await bwipjs.toBuffer({ bcid: 'qrcode', text: url, scale: 3, eclevel: 'M', padding: 1 });
  } catch (e) {
    console.error('[gerar-asd] erro ao gerar QR de verificação:', e.message);
    return null;
  }
}

// ── Geração de PDF — Gerar ASD RJ (Anotação de Serviço Documental) ───────────
// Ao contrário da Procuração Veicular e da Nota de Prestação de Serviços, que
// são documentos montados livremente, esta REPRODUZ o formulário oficial em
// papel do CRDD-RJ: mesma grade de células, mesmas tarjas de seção, tudo em
// preto e branco. Os dados chegam prontos do formulário do painel (Profissional
// e Beneficiário pré-preenchidos via Localização CPF V3, veículo via
// Proprietário Atual), já conferidos pelo usuário; célula sem dado sai em
// branco, para completar à mão depois de imprimir. As digitalizações da
// carteirinha entram na metade de baixo da MESMA folha, frente e verso lado a
// lado, no espaço que o formulário reserva para elas.
// ── ASD RJ: medidas do formulário oficial do CRDD-RJ ─────────────────────────
// O cliente pediu a ASD idêntica ao formulário em papel do conselho, em preto e
// branco. Para não desenhar "de olho", as coordenadas abaixo foram MEDIDAS no
// modelo escaneado (1240x1753 px = A4 a 150 dpi), varrendo a imagem em busca das
// linhas da tabela. Tudo aqui está em pixels DO MODELO e vira ponto por asdPx()
// — mexer num número é sair do modelo oficial.
const ASD_MODELO_LARGURA = 1240;
const asdPx = v => v * (595.28 / ASD_MODELO_LARGURA);
const ASD_TABELA = { x0: 40, x1: 1199 };

// Cada faixa é uma linha da tabela: `cols` são as divisórias verticais internas
// (também medidas) e `barra` marca as tarjas pretas de seção.
const ASD_FAIXAS = [
  { y0: 182,  y1: 253,  cols: [899] },
  { y0: 253,  y1: 314,  cols: [214, 1124] },
  { y0: 314,  y1: 374,  cols: [761] },
  { y0: 374,  y1: 406,  barra: 'PROFISSIONAL' },
  { y0: 406,  y1: 480,  cols: [723, 919] },
  { y0: 480,  y1: 554,  cols: [723, 880, 1126] },
  { y0: 554,  y1: 586,  barra: 'BENEFICIÁRIO DO SERVIÇO' },
  { y0: 586,  y1: 652,  cols: [723, 958, 1126] },
  { y0: 652,  y1: 717,  cols: [236, 297, 722, 919] },
  { y0: 717,  y1: 780,  cols: [196, 493, 549] },
  { y0: 780,  y1: 844,  cols: [302, 437] },
  { y0: 844,  y1: 907,  cols: [881] },
  { y0: 907,  y1: 939,  barra: 'DESCRIÇÃO DOCUMENTAL' },
  { y0: 939,  y1: 999,  cols: [197, 377, 551, 704, 783, 1069] },
  { y0: 999,  y1: 1056, cols: [] },                    // DUDAS Nº (traços curtos)
  { y0: 1056, y1: 1117, cols: [510, 627, 782, 940, 1067] },
  { y0: 1117, y1: 1177, cols: [281, 510, 735, 965] },
  { y0: 1177, y1: 1303, cols: [622] },
  { y0: 1303, y1: 1331, barra: 'CARTEIRINHA DO DESPACHANTE', centro: true },
];

// Células do formulário oficial além das que o painel sempre exige. Os campos do
// veículo chegam da busca por placa; os de pessoa/serviço o despachante preenche
// (ou deixa em branco para completar à mão no papel). Uma lista só, usada tanto
// no hash da cadeia quanto no desenho do PDF, para os dois nunca divergirem.
const ASD_CAMPOS_OPCIONAIS = [
  'codigoServico', 'contratanteCpfCnpj',
  'profissionalEndereco', 'profissionalCep', 'profissionalMunicipio',
  'beneficiarioIdentidade', 'beneficiarioOrgao', 'beneficiarioDataExpedicao',
  'beneficiarioUfIdentidade', 'beneficiarioEndereco', 'beneficiarioComplemento',
  'beneficiarioBairro', 'beneficiarioCep', 'beneficiarioMunicipio', 'beneficiarioUf',
  'restricao', 'proprietarioAnterior', 'proprietarioAnteriorCpfCnpj',
  'crvNotaFiscal', 'dataCrv', 'ufCrv', 'remarcado',
  'marcaModelo', 'chassi', 'renavam', 'cor', 'anoFabricacao', 'anoModelo',
  'especie', 'capacidade', 'procedencia', 'categoria', 'tipo', 'potencia',
  'combustivel', 'municipio',
];

function buildAsdPdfBuffer(params) {
  return new Promise((resolve, reject) => {
    try {
      // margin 0: a folha inteira é posicionada por coordenada absoluta medida
      // no modelo — não há fluxo de texto para uma margem controlar.
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const now = new Date();
      const P = asdPx;
      const T = ASD_TABELA;
      const larguraTabela = T.x1 - T.x0;
      doc.fillColor('#000000').strokeColor('#000000').lineWidth(0.8);

      // ── Cabeçalho ─────────────────────────────────────────────────────────
      try {
        doc.image(asdLogoPath(params.logo), P(43), P(14), { fit: [P(187), P(168)] });
      } catch (e) {
        console.warn('[gerar-asd] logo não encontrado:', e.message);
      }
      // Corpos resolvidos para bater com a LARGURA medida de cada linha no
      // modelo (ex.: o título ocupa 576 px lá, o que dá 8.6pt aqui) e postos na
      // coordenada x medida — assim não há centralização a adivinhar.
      doc.font('Helvetica-Bold').fontSize(8.6)
        .text('CONSELHO REGIONAL DOS DESPACHANTES DOCUMENTALISTAS', P(246), P(42), { lineBreak: false })
        .text('DO ESTADO DO RIO DE JANEIRO', P(377), P(69), { lineBreak: false });
      doc.font('Helvetica').fontSize(10.75)
        .text('ASD - Anotação de serviços documental', P(287), P(104), { lineBreak: false });
      // Instrução do formulário em papel: o selo do conselho é colado à mão.
      doc.font('Helvetica-Bold').fontSize(8.25)
        .text('COLE AQUI O SELO', P(992), P(82), { lineBreak: false });

      // ── Grade ─────────────────────────────────────────────────────────────
      ASD_FAIXAS.forEach(f => {
        if (f.barra) {
          doc.rect(P(T.x0), P(f.y0), P(larguraTabela), P(f.y1 - f.y0)).fill('#000000');
          const recuo = f.centro ? 0 : 12;
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10.5)
            .text(f.barra, P(T.x0 + recuo), P(f.y0 + 8),
              { width: P(larguraTabela - recuo), align: f.centro ? 'center' : 'left', lineBreak: false });
          doc.fillColor('#000000');
          return;
        }
        doc.rect(P(T.x0), P(f.y0), P(larguraTabela), P(f.y1 - f.y0)).stroke();
        (f.cols || []).forEach(x => doc.moveTo(P(x), P(f.y0)).lineTo(P(x), P(f.y1)).stroke());
      });

      // Célula do formulário: rótulo miúdo no alto e o valor preenchido logo
      // abaixo, como no impresso. O valor encolhe até 5.5pt em vez de quebrar
      // linha — nome de proprietário e marca/modelo estouram a célula com
      // frequência, e o formulário não tem altura sobrando para uma 2ª linha.
      const celula = (x0, y0, x1, rotulo, valor, opts = {}) => {
        const larg = x1 - x0 - 12;
        if (rotulo) {
          doc.font('Helvetica').fontSize(opts.rotuloSize || 7.5).fillColor('#000000')
            .text(rotulo, P(x0 + 6), P(y0 + 6), { width: P(larg), align: opts.align || 'left', lineBreak: false });
        }
        const v = (valor ?? '').toString().trim();
        if (!v) return;
        doc.font(opts.negrito ? 'Helvetica-Bold' : 'Helvetica');
        let size = opts.valorSize || 9;
        while (size > 5.5 && doc.fontSize(size).widthOfString(v) > P(larg)) size -= 0.25;
        doc.fontSize(size).fillColor('#000000')
          .text(v, P(x0 + 6), P(y0 + (opts.valorY ?? 26)), { width: P(larg), align: opts.align || 'left', lineBreak: false });
      };

      const d = (s) => (s ?? '').toString().trim();

      // ── Identificação do serviço ──────────────────────────────────────────
      celula(40, 182, 899, 'Natureza Documental',
        'Departamento Estadual de Trânsito do Rio de Janeiro - DETRAN/RJ', { valorSize: 11, valorY: 32 });
      // Nº ASD é numerado pelo próprio conselho no papel — sai em branco.
      celula(899, 182, 1199, 'Nº ASD', 'Para uso Exclusivo do CRDD',
        { align: 'center', valorSize: 8, valorY: 36 });

      celula(40,   253, 214,  'Código do Serviço', params.codigoServico);
      celula(214,  253, 1124, 'Serviço',           params.servico);
      celula(1124, 253, 1199, 'UF',                params.uf, { align: 'center' });

      celula(40,  314, 761,  'Nome do Contratante', params.contratante);
      celula(761, 314, 1199, 'CPF/CNPJ',            d(params.contratanteCpfCnpj) ? maskDocDisplay(params.contratanteCpfCnpj) : '');

      // ── Profissional ──────────────────────────────────────────────────────
      celula(40,  406, 723,  'Nome',                  params.profissionalNome);
      celula(723, 406, 919,  'Registro Profissional', params.profissionalMatricula);
      // Fixos do formulário do CRDD-RJ: a ASD do Rio é sempre DETRAN/RJ.
      celula(919, 406, 1199, 'Esfera Administrativa', 'DETRAN',
        { align: 'center', negrito: true, valorSize: 12, valorY: 34 });

      celula(40,   480, 723,  'Endereço',  params.profissionalEndereco);
      celula(723,  480, 880,  'CEP',       params.profissionalCep);
      celula(880,  480, 1126, 'Município', params.profissionalMunicipio);
      celula(1126, 480, 1199, 'UF', 'RJ',
        { align: 'center', negrito: true, valorSize: 12, valorY: 34 });

      // ── Beneficiário do serviço ───────────────────────────────────────────
      celula(40,   586, 723,  'Proprietário Atual', params.beneficiarioNome);
      celula(723,  586, 958,  'CPF/CNPJ',           d(params.beneficiarioCpfCnpj) ? maskDocDisplay(params.beneficiarioCpfCnpj) : '');
      celula(958,  586, 1126, 'Identidade',         params.beneficiarioIdentidade);
      celula(1126, 586, 1199, 'Órgão',              params.beneficiarioOrgao, { align: 'center' });

      celula(40,  652, 236,  'Data da Expedição', params.beneficiarioDataExpedicao);
      celula(236, 652, 297,  'UF',                params.beneficiarioUfIdentidade, { align: 'center' });
      celula(297, 652, 722,  'Endereço',          params.beneficiarioEndereco);
      celula(722, 652, 919,  'Complemento',       params.beneficiarioComplemento);
      celula(919, 652, 1199, 'Bairro',            params.beneficiarioBairro);

      celula(40,  717, 196,  'CEP',       params.beneficiarioCep);
      celula(196, 717, 493,  'Município', params.beneficiarioMunicipio);
      celula(493, 717, 549,  'UF',        params.beneficiarioUf, { align: 'center' });
      celula(549, 717, 1199, 'Restrição', params.restricao);

      // "Observação" do formulário: o rótulo mora na 1ª célula, mas o texto vai
      // na 3ª (a larga) — é a única com espaço para o que o despachante escreve
      // na Descrição Documental do painel.
      celula(40,  780, 302,  'Observação', '');
      celula(302, 780, 437,  '', '');
      if (d(params.descricaoDocumental)) {
        doc.font('Helvetica').fontSize(8).fillColor('#000000')
          .text(d(params.descricaoDocumental), P(443), P(786),
            { width: P(1199 - 437 - 12), height: P(52), ellipsis: true, lineGap: 1 });
      }

      celula(40,  844, 881,  'Nome do Proprietário Anterior', params.proprietarioAnterior);
      celula(881, 844, 1199, 'CPF/CNPJ', d(params.proprietarioAnteriorCpfCnpj) ? maskDocDisplay(params.proprietarioAnteriorCpfCnpj) : '');

      // ── Descrição documental ──────────────────────────────────────────────
      celula(40,   939, 197,  'Placa',             params.placa ? maskPlacaDisplay(params.placa) : '');
      celula(197,  939, 377,  'RENAVAM',           params.renavam);
      celula(377,  939, 551,  'CRV / Nota Fiscal', params.crvNotaFiscal);
      celula(551,  939, 704,  'Data',              params.dataCrv);
      celula(704,  939, 783,  'UF',                params.ufCrv, { align: 'center' });
      celula(783,  939, 1069, 'Chassi',            params.chassi);
      celula(1069, 939, 1199, 'Remarcado',         params.remarcado, { align: 'center' });

      // DUDAS: 5 campos separados por traços curtos, como no impresso.
      doc.font('Helvetica').fontSize(7.5).fillColor('#000000')
        .text('DUDAS Nº', P(46), P(1005), { lineBreak: false });
      [76, 280, 319, 511, 550, 735, 769, 1028].forEach(x =>
        doc.moveTo(P(x), P(1018)).lineTo(P(x), P(1054)).stroke());
      const dudas = Array.isArray(params.dudas) ? params.dudas : [];
      [[50, 0], [292, 1], [523, 2], [747, 3], [1040, 4]].forEach(([x, i]) => {
        doc.font('Helvetica').fontSize(8.5).fillColor('#000000')
          .text(String(i + 1), P(x), P(1030), { lineBreak: false });
        if (d(dudas[i])) {
          doc.fontSize(8).text(d(dudas[i]), P(x + 32), P(1030), { width: P(150), lineBreak: false });
        }
      });

      celula(40,   1056, 510,  'Marca/Modelo',   params.marcaModelo, { valorY: 24 });
      celula(510,  1056, 627,  'Ano Modelo',     params.anoModelo,     { valorY: 24 });
      celula(627,  1056, 782,  'Ano Fabricação', params.anoFabricacao, { valorY: 24 });
      celula(782,  1056, 940,  'Espécie',        params.especie,       { valorY: 24 });
      celula(940,  1056, 1067, 'Capacidade',     params.capacidade,    { valorY: 24 });
      celula(1067, 1056, 1199, 'Procedência',    params.procedencia,   { valorY: 24 });

      celula(40,  1117, 281,  'Categoria',   params.categoria,   { valorY: 24 });
      celula(281, 1117, 510,  'Tipo',        params.tipo,        { valorY: 24 });
      celula(510, 1117, 735,  'Potência',    params.potencia,    { valorY: 24 });
      celula(735, 1117, 965,  'Cor',         params.cor,         { valorY: 24 });
      celula(965, 1117, 1199, 'Combustível', params.combustivel, { valorY: 24 });

      // ── Rodapé do formulário: local, data e assinatura ────────────────────
      doc.font('Helvetica').fontSize(7.5).fillColor('#000000')
        .text('Município', P(53), P(1183), { lineBreak: false })
        .text('UF',        P(252), P(1183), { lineBreak: false })
        .text('Data',      P(331), P(1183), { lineBreak: false })
        .text('Assinatura do Profissional', P(628), P(1183), { lineBreak: false });
      doc.fontSize(9)
        .text(d(params.municipio), P(53), P(1205), { width: P(190), lineBreak: false })
        .text(d(params.uf),        P(252), P(1205), { width: P(70),  lineBreak: false })
        .text(now.toLocaleDateString('pt-BR'), P(331), P(1205), { width: P(200), lineBreak: false });
      doc.moveTo(P(700), P(1290)).lineTo(P(1125), P(1290)).stroke();
      doc.font('Helvetica').fontSize(7.5)
        .text(d(params.profissionalNome), P(700), P(1294), { width: P(425), align: 'center', lineBreak: false });

      // ── QR de verificação, no lugar que o modelo reserva para ele ─────────
      // Verificação numa faixa fina logo abaixo da tarja, e o QR numa coluna
      // estreita à esquerda: empilhado sobre as carteirinhas, como estava, o
      // bloco comia ~100 px de altura e era ele que limitava o tamanho delas.
      // Assim a metade de baixo da folha fica quase toda para as digitalizações.
      const v = params.verificacao;
      const QR_COL = { x: 40, larg: 100 };
      if (v) {
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#000000')
          .text(v.codigo, P(T.x0), P(1338), { width: P(larguraTabela), lineBreak: false });
        doc.font('Helvetica').fontSize(6)
          .text(`ASD nº ${v.seq} deste profissional  ·  SHA-256: ${v.docHash.slice(0, 32)}…  ·  Confira em ${v.urlCurta}`,
            P(T.x0), P(1338), { width: P(larguraTabela), align: 'right', lineBreak: false });
        if (params.qrPng) {
          try { doc.image(params.qrPng, P(QR_COL.x), P(1500), { fit: [P(QR_COL.larg), P(QR_COL.larg)] }); }
          catch (e) { console.warn('[gerar-asd] falha ao embutir QR:', e.message); }
        }
      }

      // ── Carteirinha do despachante: frente e verso lado a lado ────────────
      // O modelo reserva a metade de baixo da folha para isso ("frente de um
      // lado e verso do outro"), então elas ficam na MESMA página, sem moldura
      // nem legenda — o formulário oficial não tem nenhuma das duas coisas.
      const frente = decodeAsdCarteirinha(params.carteirinhaFrente);
      const verso  = decodeAsdCarteirinha(params.carteirinhaVerso);
      const scans = [frente, verso].filter(Boolean);
      if (scans.length) {
        // As duas o maior possível e encostadas: quem limita é a ALTURA que
        // sobra (o bloco do QR fica acima), então cada digitalização é escalada
        // por ela e o par vai centralizado com um vão pequeno no meio. Um `fit`
        // em caixas largas, como antes, centralizava cada uma na sua caixa e
        // abria um vão enorme entre elas.
        // A faixa vai da linha de verificação até quase o pé da folha, e começa
        // depois da coluna do QR — é todo o espaço que sobra na metade de baixo.
        const areaY = 1360, areaH = 380, vao = 16;
        const esquerda = v ? QR_COL.x + QR_COL.larg + 15 : ASD_TABELA.x0;
        const larguraUtil = ASD_TABELA.x1 - esquerda;
        const imgs = scans.map(b => {
          try { return doc.openImage(b); }
          catch (e) { console.warn('[gerar-asd] falha ao ler digitalização da carteirinha:', e.message); return null; }
        }).filter(Boolean);
        if (imgs.length) {
          let alt = areaH;
          let largs = imgs.map(i => alt * (i.width / i.height));
          const total = () => largs.reduce((a, b) => a + b, 0) + vao * (imgs.length - 1);
          // Digitalização muito deitada estouraria a largura da folha.
          if (total() > larguraUtil) {
            const k = larguraUtil / total();
            alt *= k;
            largs = largs.map(w => w * k);
          }
          let x = esquerda + (larguraUtil - total()) / 2;
          imgs.forEach((img, i) => {
            try {
              doc.image(img, P(x), P(areaY + (areaH - alt) / 2), { width: P(largs[i]), height: P(alt) });
            } catch (e) {
              console.warn('[gerar-asd] falha ao embutir digitalização da carteirinha:', e.message);
            }
            x += largs[i] + vao;
          });
        }
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Verificar CRLV e Último Licenciamento (despbrasil devolve
// os dados em "dados", sem um arquivo pronto útil para esse serviço) ──────────
function buildVerificarCrlvPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'VERIFICAR CRLV E ÚLTIMO LICENCIAMENTO', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      pdfBar(doc, 'RESULTADO');
      const pairs = itemToPairs(data);
      if (pairs.length) pdfFieldGrid(doc, pairs);
      else pdfEmptyNotice(doc, 'Nenhum dado retornado para essa placa.');
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Verificar CRLV + Data CRV ───────────────────────────────
// Mesmo endpoint do "Verificar CRLV e Último Licenciamento" (despbrasil
// verificar_crlv), relatório diferente: as datas que dão nome ao serviço saem
// em bloco próprio no topo e os "indicadores" viram uma seção legível. Os
// indicadores NÃO aparecem no relatório do serviço antigo porque itemToPairs
// descarta campo aninhado de propósito — aqui eles são o segundo motivo da
// consulta, então são desenhados um a um.
// A despbrasil nem sempre manda as datas (veículo velho sem licenciamento volta
// só com os dados do veículo, conferido com a API real em 22/09/2026): a linha
// sai com "Nada consta" em vez de sumir, senão o relatório do serviço que
// promete a data do CRV ficaria sem dizer que a base não tem essa data.
const VERIFICAR_CRLV_DATAS = [
  ['dataEmissaoCrv',         'Data de emissão do CRV'],
  ['dataEmissaoCRLV',        'Data de emissão do CRLV'],
  ['anoUltimoLicenciamento', 'Último licenciamento'],
];
const VERIFICAR_CRLV_INDICADORES = {
  multa_renainf:     'Multa RENAINF',
  roubo_furto:       'Roubo/Furto',
  leilao:            'Leilão',
  renajud:           'RENAJUD',
  comunicacao_venda: 'Comunicação de Venda',
  alarme:            'Alarme',
  restricao_rfb:     'Restrição RFB',
  pendencia_emissao: 'Pendência de emissão',
};
// Data ISO da despbrasil ("2025-03-15") em dd/mm/aaaa. Sem passar por Date de
// propósito: "2025-03-15" é lido como UTC e, no fuso do Brasil, voltaria 14/03.
function dataBRSimples(v) {
  const t = String(v ?? '').trim();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : t;
}

function buildVerificarCrlvDataCrvPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();
      const dados = data || {};

      pdfReportHeader(doc, 'VERIFICAR CRLV + DATA CRV', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      pdfBar(doc, 'DATAS DO DOCUMENTO');
      pdfFieldGrid(doc, VERIFICAR_CRLV_DATAS.map(([chave, rotulo]) => {
        const v = dados[chave];
        return [rotulo, (v === null || v === undefined || v === '') ? 'Nada consta' : dataBRSimples(v)];
      }));
      doc.moveDown(0.4);

      pdfBar(doc, 'DADOS DO VEÍCULO');
      const jaMostrados = new Set(VERIFICAR_CRLV_DATAS.map(([chave]) => chave));
      const veiculo = Object.fromEntries(
        Object.entries(dados).filter(([k]) => !jaMostrados.has(k))
      );
      const pares = itemToPairs(veiculo);
      if (pares.length) pdfFieldGrid(doc, pares);
      else pdfEmptyNotice(doc, 'Nenhum dado retornado para essa placa.');
      doc.moveDown(0.4);

      // Indicadores só saem quando a base os manda: desenhar "Não" em tudo
      // quando a consulta não trouxe o bloco seria afirmar que está limpo.
      const ind = dados.indicadores;
      if (ind && typeof ind === 'object' && Object.keys(ind).length) {
        pdfBar(doc, 'INDICADORES');
        pdfFieldGrid(doc, Object.entries(ind).map(([k, v]) => [
          VERIFICAR_CRLV_INDICADORES[k] || humanizeKey(k),
          typeof v === 'boolean' ? (v ? 'Sim' : 'Não')
            : (v === null || v === undefined || v === '') ? 'Nada consta' : String(v),
        ]));
        doc.moveDown(0.4);
      }

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Consulta RENAVAM (despbrasil devolve os dados em "dados",
// sem um arquivo pronto útil para esse serviço) ────────────────────────────────
function buildConsultaRenavamPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'CONSULTA RENAVAM', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      pdfBar(doc, 'RESULTADO');
      const pairs = itemToPairs(data);
      if (pairs.length) pdfFieldGrid(doc, pairs);
      else pdfEmptyNotice(doc, 'Nenhum dado retornado para essa placa.');
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Extração de campos — "Número ATPV-E" (despbrasil só devolve o PDF pronto em
// arquivo_url, sem JSON estruturado; extraímos o texto desse PDF — sempre no
// formato "Rótulo: valor", um por linha — para remontar o documento no layout
// oficial do ATPVe digital, ver buildNumeroAtpvePdfBuffer). Chave normalizada
// (minúscula, sem acento/espaço) para casar com os nomes usados abaixo.
// Usa pdf-parse@1.1.1 (não a v2) de propósito: a v2 empacota um pdf.js que
// instancia `new DOMMatrix` no topo do módulo pra suportar renderização, e
// trava com "DOMMatrix is not defined" ao ser importado no runtime Node da
// Vercel (sem @napi-rs/canvas disponível) — derrubando o servidor inteiro. A
// v1.1.1 usa um pdf.js antigo, só de texto, sem essa dependência.
// ── Campo sem dado nos relatórios de terceiro ────────────────────────────────
// O portal (e às vezes a despbrasil) escreve um TRAVESSÃO onde não tem o dado:
// a PUG6I42, por exemplo, volta do consultar-placa-v2 com "DATA DO CRV: —".
// Sem tratar, esse "—" é um valor como outro qualquer — ele passava na
// conferência de ATPVE_CAMPOS_OBRIGATORIOS, ia impresso na célula "DATA EMISSÃO
// DO CRV" do ATPVe e, pior, sobrescrevia a data boa que a outra fonte já tinha
// trazido. Placeholder é ausência de dado, então ele some já na extração: assim
// a outra fonte preenche, e se nenhuma tiver o campo o pedido é recusado sem
// cobrar em vez de sair com um traço no documento.
const PLACEHOLDER_SEM_DADO = /^(?:[-–—.\s]*|n\/?a|nao informado|não informado|sem informacao|sem informação)$/i;
const semDadoUtil = v => PLACEHOLDER_SEM_DADO.test(String(v ?? '').trim());

async function extractAtpveFieldsFromPdf(pdfBuf) {
  const { text } = await pdfParse(pdfBuf);
  const fields = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const m = line.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ /]*?):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');
    if (semDadoUtil(m[2])) continue;
    fields[key] = m[2].trim();
  }
  return repairAtpveAccents(fields, pdfBuf);
}

// ── Acentos perdidos na extração ────────────────────────────────────────────
// O pdf.js do pdf-parse depende do ToUnicode da fonte do PDF de origem: quando
// ele não cobre um glifo, a letra volta como "?" (ou U+FFFD) — foi o que fez
// "RUA SÃO JOSE" virar "RUA S?O JOSE" no endereço do comprador do ATPVe. O
// texto CRU do content stream (WinAnsi/latin1) costuma ter o byte certo, então
// tentamos recuperar a letra por lá.
//
// A troca só acontece quando o candidato cru tem o MESMO comprimento e é
// idêntico ao valor extraído fora das posições estragadas, e a letra reposta é
// latina acentuada. Ou seja: o documento nunca ganha um dado que não estava no
// PDF de origem — se o "?" já veio assim da despbrasil, nada muda (e o aviso no
// log diz exatamente isso).
const CARACTERE_PERDIDO = /[?\uFFFD]/;
const LETRA_ACENTUADA = /[\u00C0-\u00FF]/;
const semAcento = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

// Recupera as letras perdidas de "valor" usando "modelo" como gabarito: o
// resultado é o valor ORIGINAL com troca apenas nas posições estragadas. Exige
// mesmo comprimento e texto idêntico fora dessas posições, comparando sem
// acento e sem caixa — assim "RUA S?O JOSE" aceita o gabarito "Rua São José" e
// vira "RUA SÃO JOSE" (só o "?" virou "Ã"; o "JOSE" continua como o Detran
// mandou). Devolve null quando o gabarito é outro texto.
function restaurarLetrasPerdidas(valor, modelo) {
  if (!modelo || modelo.length !== valor.length) return null;
  const vRaso = semAcento(valor);
  const mRaso = semAcento(modelo);
  const saida = [...valor];
  let trocou = false;
  for (let i = 0; i < valor.length; i++) {
    if (CARACTERE_PERDIDO.test(valor[i])) {
      if (!LETRA_ACENTUADA.test(modelo[i])) return null;
      // O dado do Detran vem todo em maiúscula; o gabarito do CEP, não.
      saida[i] = /[a-z]/.test(valor) ? modelo[i] : modelo[i].toUpperCase();
      trocou = true;
      continue;
    }
    if (vRaso[i] !== mRaso[i]) return null;
  }
  return trocou ? saida.join('') : null;
}

// ── Acentos perdidos na extração ────────────────────────────────────────────
// O pdf.js do pdf-parse depende do ToUnicode da fonte do PDF de origem: quando
// ele não cobre um glifo, a letra volta como "?" (ou U+FFFD) — foi o que fez
// "RUA SÃO JOSE" virar "RUA S?O JOSE" no endereço do comprador do ATPVe.
//
// Duas fontes para recuperar a letra, nessa ordem:
//  1. o texto CRU do content stream (WinAnsi/latin1), que não passa pelo
//     ToUnicode — de graça, serve para qualquer campo;
//  2. o CEP do comprador nos Correios (ViaCEP), que é a fonte oficial do nome
//     do logradouro e do bairro. Na consulta da placa MTX6H99 o texto cru
//     também já vinha sem a letra, então só o CEP resolve.
//
// Nos dois casos a troca acontece SÓ nas posições estragadas e só quando o
// resto do texto bate letra por letra (ver restaurarLetrasPerdidas): o
// documento não pode ganhar um logradouro diferente do que o Detran mandou.
async function repairAtpveAccents(fields, pdfBuf) {
  const quebrados = Object.keys(fields).filter(k => CARACTERE_PERDIDO.test(fields[k]));
  if (!quebrados.length) return fields;

  let candidatos = [];
  try { candidatos = extractRawPdfStrings(pdfBuf); }
  catch (e) { console.error('[atpve] falha ao ler o texto cru do PDF:', e.message); }

  const pendentes = [];
  for (const key of quebrados) {
    const corrigido = candidatos.map(c => restaurarLetrasPerdidas(fields[key], c)).find(Boolean);
    if (corrigido) fields[key] = corrigido;
    else pendentes.push(key);
  }
  if (!pendentes.length) return fields;

  // Só logradouro e bairro têm gabarito no CEP; nome de pessoa, não.
  const porCep = { nomelogradourocomprador: 'logradouro', bairroimovelcomprador: 'bairro' };
  const alvosCep = pendentes.filter(k => porCep[k]);
  if (alvosCep.length && fields.cepimovelcomprador) {
    const end = await consultarCep(fields.cepimovelcomprador);
    for (const key of alvosCep) {
      const corrigido = restaurarLetrasPerdidas(fields[key], end?.[porCep[key]]);
      if (corrigido) {
        fields[key] = corrigido;
        pendentes.splice(pendentes.indexOf(key), 1);
      }
    }
  }

  for (const key of pendentes) {
    console.error(`[atpve] não consegui recuperar o acento do campo "${key}" (valor: ${fields[key]}).`);
  }
  return fields;
}

// Logradouro e bairro oficiais de um CEP (ViaCEP, público e sem chave). Melhor
// esforço: qualquer falha devolve null e o valor fica como veio, porque isso
// aqui nunca pode derrubar uma consulta de R$ 120,00 já paga.
async function consultarCep(cep) {
  const limpo = String(cep || '').replace(/\D/g, '');
  if (limpo.length !== 8) return null;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${limpo}/json/`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.erro ? null : d;
  } catch (e) {
    console.error('[atpve] ViaCEP indisponível:', e.message);
    return null;
  }
}

// Strings de texto (Tj/TJ) de todos os content streams do PDF, com e sem
// compressão, lidas como latin1 — que é a codificação das fontes padrão.
function extractRawPdfStrings(pdfBuf) {
  const saida = [];
  let i = 0;
  while (true) {
    const s = pdfBuf.indexOf('stream', i);
    if (s < 0) break;
    let ini = s + 6;
    if (pdfBuf[ini] === 13) ini++;
    if (pdfBuf[ini] === 10) ini++;
    const fim = pdfBuf.indexOf('endstream', ini);
    if (fim < 0) break;
    i = fim + 9;

    const bruto = pdfBuf.slice(ini, fim);
    let conteudo = null;
    try { conteudo = zlib.inflateSync(bruto).toString('latin1'); }
    catch { conteudo = bruto.toString('latin1'); }
    if (!conteudo.includes('Tj') && !conteudo.includes('TJ')) continue;

    for (const bloco of conteudo.matchAll(/BT([\s\S]*?)ET/g)) {
      const partes = [];
      for (const m of bloco[1].matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>/g)) {
        partes.push(m[1] !== undefined
          ? m[1].replace(/\\([()\\])/g, '$1')
          : Buffer.from(m[2].replace(/\s/g, ''), 'hex').toString('latin1'));
      }
      const linha = partes.join('').trim();
      if (!linha) continue;
      saida.push(linha);
      // O PDF da despbrasil escreve "Rótulo: valor" numa linha só — o valor
      // sozinho também entra como candidato.
      const m = linha.match(/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ /]*?:\s*(.+)$/);
      if (m) saida.push(m[1].trim());
    }
  }
  return saida;
}

// ── Extração de campos — "Proprietário Atual (v2)" (portal devolve um PDF
// pronto, mas em formato "Rótulo:" numa linha e o valor sozinho na linha
// seguinte, diferente do formato "Rótulo: valor" da despbrasil acima). Usada
// para completar ano de fabricação/modelo, marca/modelo, cor, data do CRV e
// nome/município/UF do vendedor no layout do ATPVe — ver
// runNumeroAtpveSupplementaryQueries (a CAT é fixa, ver ATPVE_CAT_SEM_CATEGORIA).
async function extractLinePairFieldsFromPdf(pdfBuf) {
  const { text } = await pdfParse(pdfBuf);
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const fields = {};
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].endsWith(':')) continue;
    const key = lines[i].slice(0, -1).trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');
    // Travessão é campo em branco, não valor — ver semDadoUtil.
    if (key && !semDadoUtil(lines[i + 1])) fields[key] = lines[i + 1];
  }
  return fields;
}

// ── Extração de campos — cartão do Código de Segurança CRV (Vistocar/despbrasil).
// O PDF é o cartão oficial da Carteira Digital de Trânsito (SENATRAN): os
// campos ficam desenhados em posições absolutas (sem "Rótulo: valor" em
// sequência), então o texto extraído sai com renavam+placa+anos colados numa
// linha só (Vistocar) ou com renavam e código em linhas seguidas, as duas com
// 11 dígitos (despbrasil). Como já sabemos renavam/placa por outras fontes,
// identificamos o código de segurança (9-12 dígitos, diferente do renavam) e a
// marca/modelo (linha com "/") por padrão, em vez de tentar separar a linha
// colada. A comparação com o renavam ignora zeros à esquerda: um desencontro de
// formatação aqui faria o renavam ser copiado no lugar do código.
function extractVistocarSecurityFields(text, knownRenavam) {
  const semZeros = (v) => String(v || '').replace(/\D/g, '').replace(/^0+/, '');
  const renavam = semZeros(knownRenavam);
  const fields = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!fields.codigosegurancacrv && /^\d{9,12}$/.test(line) && semZeros(line) !== renavam) {
      fields.codigosegurancacrv = line;
    } else if (!fields.marcamodeloversao && /^[A-Za-z0-9]+\/[A-Za-z0-9 ]+$/.test(line)) {
      fields.marcamodeloversao = line;
    }
  }
  return fields;
}

// O template usado é sempre o SEM selos (atpve-template-pre-selos-backup.pdf):
// os selos gov.br das Consultas Avulsas passaram a ser desenhados em tempo de
// geração a partir de assets/atpve-selo-govbr.png (ver bloco withSelos em
// buildNumeroAtpvePdfBuffer). O antigo atpve-template.pdf, que trazia os selos
// "em branco" embutidos no fundo, tinha perdido os contornos das caixas de
// valor (nome/CPF/data) — a "borda" do selo real é justamente a caixa branca
// recortada contra a textura cinza pontilhada, e qualquer retângulo branco de
// apagar/sobrepor engolia esse recorte.
const ATPVE_TEMPLATE_SEM_SELOS_PATH = path.join(__dirname, 'assets', 'atpve-template-pre-selos-backup.pdf');
const ATPVE_SELO_GOVBR_PATH = path.join(__dirname, 'assets', 'atpve-selo-govbr.png');

// Escreve um valor sobre o template do ATPVe: apaga a área com um retângulo
// (branco por padrão, ou "bg" pra casar com caixas preenchidas como "Valor
// declarado na venda") e desenha o texto novo por cima. Coordenadas (x/top/
// bottom/maxX) medidas diretamente no PDF de referência (pdfplumber), origem
// no topo da página — convertidas aqui pra o sistema do pdf-lib (origem
// embaixo). Encolhe a fonte (até um mínimo) e trunca com "…" como último
// recurso pra caber na largura da célula, igual ao padrão dos outros
// relatórios do sistema.
// As fontes padrão do pdf-lib (Courier/Helvetica) escrevem em WinAnsi, que
// cobre todo o português — mas pdf-lib LANÇA erro em qualquer caractere fora
// dessa tabela, e o texto aqui vem de PDF de terceiro (nome e endereço
// digitados por quem cadastrou a intenção de venda). Um caractere exótico
// derrubava a geração inteira com HTTP 500 numa consulta de R$ 120,00: agora ele
// perde o acento e, se nem assim couber, é descartado — o resto do documento
// sai normal. Acento de português não passa por aqui (é WinAnsi de verdade).
const WINANSI_ESPECIAIS = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const cabeNoWinAnsi = ch => {
  const cp = ch.codePointAt(0);
  return (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF) || WINANSI_ESPECIAIS.has(ch);
};
function toWinAnsiSafe(texto) {
  return [...String(texto)].map(ch => {
    if (cabeNoWinAnsi(ch)) return ch;
    const semAcento = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return [...semAcento].every(cabeNoWinAnsi) ? semAcento : '';
  }).join('');
}

function pdfOverlayValue(page, pageH, font, text, { x, top, bottom, maxX, size = 10, bg = null, align = 'left', minSize = 6, overlay = false }) {
  const value = toWinAnsiSafe((text ?? '').toString().trim());
  // overlay: true — escreve o texto sem apagar nada por baixo. Usado nos selos
  // gov.br, cujas caixas de valor já nascem em branco na própria imagem do selo
  // (assets/atpve-selo-govbr.png); um retângulo branco aqui cobriria o contorno
  // da caixa contra a textura pontilhada — era exatamente o defeito antigo de
  // "bordas do selo sumindo".
  if (!overlay) {
    const rectY = pageH - bottom - 1;
    const rectH = (bottom - top) + 2;
    page.drawRectangle({
      x: x - 1, y: rectY, width: (maxX - x) + 2, height: rectH,
      color: bg ? rgb(bg[0], bg[1], bg[2]) : rgb(1, 1, 1),
    });
  }
  if (!value) return;

  const maxW = maxX - x;
  let fSize = size;
  let display = value;
  while (font.widthOfTextAtSize(display, fSize) > maxW && fSize > minSize) fSize -= 0.5;
  if (font.widthOfTextAtSize(display, fSize) > maxW) {
    while (display.length > 1 && font.widthOfTextAtSize(display + '…', fSize) > maxW) {
      display = display.slice(0, -1);
    }
    display = display + '…';
  }

  const baseline = pageH - bottom + 2;
  const textW = font.widthOfTextAtSize(display, fSize);
  const drawX = align === 'right' ? (maxX - textW)
    : align === 'center' ? x + (maxX - x - textW) / 2
    : x;
  page.drawText(display, { x: drawX, y: baseline, size: fSize, font, color: rgb(0.067, 0.094, 0.153) });
}

// ── Geração de PDF — Número ATPV-E, sobrepondo os dados desta consulta no
// próprio PDF de referência do documento oficial "Autorização para
// Transferência de Propriedade de Veículo - Digital" (DENATRAN) — ver
// assets/atpve-template-pre-selos-backup.pdf. Usar o PDF real como base (em vez de remontar o
// layout do zero com pdfkit) garante que tamanho/posição do QR code, das
// caixas, das linhas de assinatura e das fontes fiquem idênticos ao
// documento oficial — só o texto dinâmico é sobrescrito, nas coordenadas
// exatas medidas no PDF de referência (pdfplumber). Campos que a despbrasil
// não retorna (ano fabricação/modelo, marca/modelo/versão, cor, código
// de segurança do CRV, data de emissão do CRV, nome/UF do vendedor) vêm da
// consulta complementar Proprietário Atual (v2) / Consulta 3 Código
// Segurança CRV, já mescladas em "fields" antes de chegar aqui — ver
// runNumeroAtpveSupplementaryQueries. LOCAL usa o município/UF do comprador
// (mesma fonte da despbrasil, sem consulta extra). Os selos gov.br de
// "AUTENTICAÇÃO DAS ASSINATURAS" (withSelos) só valem pra Consultas Avulsas —
// ver runPublicAtpveComunicacaoVenda; a consulta logada (serviceId
// 'consultar-Numero-ATPVE' em /api/query) não os usa.
const ATPVE_CAT_SEM_CATEGORIA = '***';

async function buildNumeroAtpvePdfBuffer(service, fields, params, { withSelos = false } = {}) {
  const placaRaw = (params?.placa || fields.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const templateBytes = await fs.promises.readFile(ATPVE_TEMPLATE_SEM_SELOS_PATH);
  const pdfDoc = await PDFLibDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const pageH = page.getHeight();
  const courier = await pdfDoc.embedFont(PDFLibStandardFonts.CourierBold);
  const helv = await pdfDoc.embedFont(PDFLibStandardFonts.HelveticaBold);

  const V = (text, opts) => pdfOverlayValue(page, pageH, courier, text, opts);

  // Coluna esquerda — veículo / ATPVe
  V(fields.renavam, { x: 14.5, top: 104.7, bottom: 114.7, maxX: 143 });
  V(placaRaw, { x: 14.5, top: 139.7, bottom: 149.7, maxX: 143 });
  V(fields.anofabricacao, { x: 14.5, top: 177.7, bottom: 187.7, maxX: 76 });
  V(fields.anomodelo, { x: 86.2, top: 177.7, bottom: 187.7, maxX: 143 });
  V(fields.marcamodeloversao, { x: 14.5, top: 216.7, bottom: 226.7, maxX: 276 });
  // CAT é fixo: o ATPVe não atribui categoria ao veículo, então a célula sai
  // com "***" em vez da Categoria do CRLV (que vinha como "PARTICULAR" da
  // consulta Proprietário Atual e não é o que o documento oficial mostra).
  V(ATPVE_CAT_SEM_CATEGORIA, { x: 14.5, top: 251.7, bottom: 261.7, maxX: 276 });
  V(fields.cor, { x: 14.5, top: 286.7, bottom: 296.7, maxX: 132 });
  V(fields.chassi, { x: 138.5, top: 286.7, bottom: 296.7, maxX: 276 });
  V(fields.numerocrv, { x: 14.5, top: 326.7, bottom: 336.7, maxX: 132 });
  V(fields.codigosegurancacrv, { x: 138.5, top: 326.7, bottom: 336.7, maxX: 276 });
  V(fields.numeroatpve, { x: 14.5, top: 366.7, bottom: 376.7, maxX: 132 });
  V(fields.datacrv, { x: 138.5, top: 366.7, bottom: 376.7, maxX: 276 });
  V(fields.hodometro, { x: 14.5, top: 399.7, bottom: 409.7, maxX: 276 });

  // Coluna esquerda — comprador
  V(fields.nomecomprador, { x: 14.5, top: 460.7, bottom: 470.7, maxX: 276 });
  V(maskDocDisplay(fields.documentocomprador), { x: 14.5, top: 497.7, bottom: 507.7, maxX: 123 });
  V(fields.emailcomprador, { x: 128.5, top: 494.7, bottom: 504.7, maxX: 276 });
  V(fields.municipiocomprador, { x: 14.5, top: 534.7, bottom: 544.7, maxX: 227 });
  V(fields.ufcomprador, { x: 233.5, top: 534.7, bottom: 544.7, maxX: 276 });
  const endereco = [fields.nomelogradourocomprador, fields.numeroimovelcomprador].filter(Boolean).join(', ');
  const bairroCep = [fields.bairroimovelcomprador, fields.cepimovelcomprador ? `CEP: ${fields.cepimovelcomprador}` : null]
    .filter(Boolean).join(' - ');
  V(endereco, { x: 14.5, top: 568.7, bottom: 578.7, maxX: 276 });
  V(bairroCep, { x: 14.5, top: 577.7, bottom: 587.7, maxX: 276 });

  // Coluna direita — vendedor + condições da venda
  // Layout 2.1 (SENATRAN): a linha do nome do vendedor ficou ~4,6pt mais baixa
  // dentro da célula em relação ao layout 2.0 (DENATRAN) — medido no PDF de
  // referência oficial mais recente.
  V(fields.nomevendedor, { x: 318, top: 84.7, bottom: 94.7, maxX: 575 });
  V(maskDocDisplay(fields.documentovendedor), { x: 320, top: 121.7, bottom: 131.7, maxX: 429 });
  V(fields.emailvendedor, { x: 434, top: 118.7, bottom: 128.7, maxX: 575 });
  V(fields.municipiovendedor, { x: 320, top: 156.7, bottom: 166.7, maxX: 534 });
  V(fields.ufvendedor, { x: 540, top: 156.7, bottom: 166.7, maxX: 575 });
  // Caixa cinza (0.8,0.8,0.8) no original — mantém a mesma cor de fundo ao sobrescrever.
  V(fields.valorvenda, { x: 415, top: 200.2, bottom: 210.2, maxX: 573, bg: [0.8, 0.8, 0.8] });
  // LOCAL = município/UF do comprador (mesma fonte da despbrasil, sem consulta extra).
  // O retângulo de "apagar" do V() cobre a linha impressa do template nesses dois
  // campos (ela fica dentro da faixa top/bottom da célula) — sem redesenhá-la depois
  // o valor fica "flutuando" solto, em vez de escrito sobre o traço, como no oficial.
  // Coordenadas da linha medidas no PDF de referência (pdfplumber, mesma origem dos V()).
  const local = [fields.municipiocomprador, fields.ufcomprador].filter(Boolean).join(' - ');
  V(local, { x: 347.2, top: 271.9, bottom: 281.9, maxX: 573 });
  page.drawLine({ start: { x: 337.096, y: pageH - 281.255 }, end: { x: 573.364, y: pageH - 281.255 }, thickness: 0.71, color: rgb(0, 0, 0) });
  // Layout 2.1: a linha de "DATA DECLARADA DA VENDA" ficou rente ao rótulo
  // (sem o respiro que tinha no layout 2.0) — mesma lógica, coordenadas novas.
  // A data impressa é a que o VENDEDOR COMUNICOU AO DETRAN (Consulta
  // Comunicado, ver fetchComunicadoDataVenda). O que a despbrasil chama de
  // "data declarada da venda" é o dia em que a ATPVe foi GERADA — as duas só
  // coincidem quando o documento saiu no mesmo dia da comunicação, e foi por
  // isso que placa com comunicação antiga (ex.: venda em 27/01/2022, ATPVe
  // gerada em 19/03/2022) saía com a data errada. A da ATPVe fica de reserva
  // para a placa sem comunicação registrada, onde ela é a única que existe.
  const dataVenda = fields.datavendacomunicada
    || (fields.datahoraregistrointencaovenda ? fields.datahoraregistrointencaovenda.split(' ')[0] : null);
  V(dataVenda, { x: 403.9, top: 298.8, bottom: 308.8, maxX: 573 });
  page.drawLine({ start: { x: 390.189, y: pageH - 308.184 }, end: { x: 573.194, y: pageH - 308.184 }, thickness: 1.02, color: rgb(0, 0, 0) });

  // "DETRAN - UF": origem de onde o veículo foi emplacado (não a UF da
  // intenção de venda) — fonte Helvetica pequena, casando com o rótulo estático.
  pdfOverlayValue(page, pageH, helv, fields.ufemplacamento || fields.ufvendedor || fields.ufintencaovenda,
    { x: 42.5, top: 50.8, bottom: 56.9, maxX: 60, size: 6.1 });

  // "MENSAGENS SENATRAN" fica EM BRANCO de propósito, como no documento
  // oficial: nada é impresso nessa caixa. O status e a data/hora do registro da
  // intenção de venda saíam aqui (e, por um momento, a espécie e o tipo do
  // veículo) — o cliente pediu a caixa limpa, então nenhum desses dados entra
  // no PDF. Não é falta de dado: é o layout do documento.

  // "AUTENTICAÇÃO DAS ASSINATURAS" — dois selos gov.br, com o mesmo nome/CPF/
  // data usados nas caixas de identificação acima. Só pra Consultas Avulsas
  // (withSelos); na consulta logada a área fica em branco. O selo inteiro é a
  // imagem assets/atpve-selo-govbr.png (recortada do modelo de referência do
  // usuário, com os valores de exemplo apagados mas as caixas brancas de valor
  // e a textura pontilhada intactas), desenhada aqui em tempo de geração —
  // nada de retângulo branco ou textura sintética por cima: as "bordas" do
  // selo real são o recorte das caixas brancas contra a textura, e qualquer
  // apagão por cima engolia esse contorno. Os 3 campos são escritos com
  // overlay: true (texto puro, sem apagar), em coordenadas derivadas dos
  // pixels medidos na própria imagem (273×151 px) vezes a escala de exibição.
  // Posição/tamanho dos selos na página medidos no modelo de referência
  // (ATPV-1.png, 1240 px ↔ 595,28 pt): vendedor x≈331..429, comprador
  // x≈460..561, topo y≈678. Data usa o mesmo valor de "data declarada da
  // venda" (a despbrasil não devolve timestamp de assinatura separado). Nome
  // e CPF/CNPJ usam minSize baixo pra encolher em vez de truncar (CNPJ
  // formatado tem 18 caracteres; em Courier, minSize 4 cabe na caixa).
  if (withSelos) {
    const seloImg = await pdfDoc.embedPng(await fs.promises.readFile(ATPVE_SELO_GOVBR_PATH));
    const SELO_W = 100;                    // pt — largura do selo no modelo
    const SELO_H = SELO_W * 151 / 273;     // mantém a proporção da imagem
    const s = SELO_W / 273;                // pt por pixel da imagem
    // Tamanho da fonte calibrado pelos textos de exemplo do modelo (~7 px de
    // altura de maiúscula ≈ 4.3pt nesta escala); CPF/CNPJ e data usam o MESMO
    // tamanho (4) pra não destoar um do outro (com tamanhos independentes a
    // data, mais curta, não encolhia e saía maior que o CPF, estourando o topo
    // da caixa). Os dois são centralizados dentro das caixas brancas
    // (align: 'center', x/maxX = interior da caixa medido na imagem); os "+2"
    // nos bottoms compensam o deslocamento fixo de +2pt do baseline em
    // pdfOverlayValue, pra o texto assentar centralizado na vertical.
    const drawSelo = (imgX, imgTop, nome, doc, data) => {
      page.drawImage(seloImg, { x: imgX, y: pageH - imgTop - SELO_H, width: SELO_W, height: SELO_H });
      V(nome, { x: imgX + 13 * s, top: imgTop + 69 * s, bottom: imgTop + 79 * s + 2, maxX: imgX + 263 * s, size: 4.5, minSize: 3, overlay: true });
      V(doc,  { x: imgX + 8 * s,   top: imgTop + 117 * s, bottom: imgTop + 124.5 * s + 2, maxX: imgX + 131 * s, size: 4, minSize: 3, align: 'center', overlay: true });
      V(data, { x: imgX + 143 * s, top: imgTop + 117 * s, bottom: imgTop + 124.5 * s + 2, maxX: imgX + 266 * s, size: 4, minSize: 3, align: 'center', overlay: true });
    };
    drawSelo(330, 678, fields.nomevendedor, maskDocDisplay(fields.documentovendedor), dataVenda);
    drawSelo(460, 678, fields.nomecomprador, maskDocDisplay(fields.documentocomprador), dataVenda);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ── Código de Segurança CRV para o ATPVe: Vistocar primeiro, despbrasil se o
// PDF vier rasterizado ────────────────────────────────────────────────────────
// As duas APIs devolvem o MESMO cartão da CDT, mas a Vistocar passou a alternar
// entre dois arquivos: o PDF nativo do SENATRAN (Producer "Renavam", ~120 KB,
// com camada de texto) e uma versão RASTERIZADA (Producer "TCPDF", ~420 KB, uma
// única imagem de página inteira e nenhum texto extraível). Na versão
// rasterizada não há o que ler: o código de segurança saía em branco no ATPVe
// mesmo com a consulta feita e paga na Vistocar — e repetir a chamada não
// adianta, a mesma placa devolve o raster de novo. Por isso, quando o PDF da
// Vistocar não rende o código, buscamos o mesmo documento na despbrasil
// (serviço "codigo_seguranca"), que só entrega o formato com texto. A segunda
// chamada só acontece nesse caso. Atenção: essa rota da despbrasil está fora
// do ar desde 10/09/2026, então hoje o fallback não salva nada — quando o PDF
// da Vistocar vier rasterizado, o campo sai vazio.
async function fetchCodigoSegurancaPdfVistocar(placa) {
  const r = await fetch(`${VISTOCAR_BASE_URL}/apiclient/security-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getVistocarToken()}` },
    body: JSON.stringify({ plate: placa }),
  });
  const parsed = await r.json();
  const ok = r.ok && parsed?.response?.success === true && parsed?.response?.paid === true && parsed?.response?.pdfBase64;
  if (!ok) {
    console.error(`[consultar-Numero-ATPVE] Código Segurança CRV (Vistocar) sem PDF válido: ${parsed?.message || parsed?.response?.msg || 'resposta inesperada'}`);
    return null;
  }
  return Buffer.from(parsed.response.pdfBase64, 'base64');
}

async function fetchCodigoSegurancaPdfDespbrasil(placa) {
  const r = await fetch(DESPBRASIL_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', chaveAcesso: DESPBRASIL_KEY },
    body: JSON.stringify({ servico: DESPBRASIL_SVCS['security-code-vistocar'].servico, placa }),
  });
  const parsed = await r.json().catch(() => null);
  if (!r.ok || !parsed?.sucesso || !parsed?.arquivo_url) {
    console.error(`[consultar-Numero-ATPVE] Código Segurança CRV (despbrasil) sem PDF válido: ${JSON.stringify(parsed)}`);
    return null;
  }
  const pdfRes = await fetch(parsed.arquivo_url);
  if (!pdfRes.ok) {
    console.error(`[consultar-Numero-ATPVE] falha ao baixar o PDF do Código Segurança CRV (despbrasil): HTTP ${pdfRes.status}`);
    return null;
  }
  return Buffer.from(await pdfRes.arrayBuffer());
}

async function fetchCodigoSegurancaCrvFields(placa, knownRenavam) {
  const fontes = [
    ['Vistocar', fetchCodigoSegurancaPdfVistocar],
    ['despbrasil', fetchCodigoSegurancaPdfDespbrasil],
  ];
  for (const [fonte, buscarPdf] of fontes) {
    try {
      const buf = await buscarPdf(placa);
      if (!buf) continue;
      const { text } = await pdfParse(buf);
      const f = extractVistocarSecurityFields(text, knownRenavam);
      if (f.codigosegurancacrv) return f;
      console.error(`[consultar-Numero-ATPVE] PDF do Código Segurança CRV da ${fonte} sem código legível (provável PDF rasterizado, sem camada de texto).`);
    } catch (e) {
      console.error(`[consultar-Numero-ATPVE] erro na consulta de Código Segurança CRV via ${fonte}:`, e.message);
    }
  }
  return {};
}

// ── Consultas complementares da "Número ATPV-E" — Proprietário Atual (v2) via
// portal (consultar-placa-v2), Código Segurança CRV via Vistocar/despbrasil
// (ver fetchCodigoSegurancaCrvFields) e Consulta Comunicado via portal (ver
// fetchComunicadoDataVenda), para completar os campos que a despbrasil não
// retorna ou retorna errado (o preço de R$120 já reflete o custo das 4
// consultas encadeadas, ver SERVICES/consultar-Numero-ATPVE).
//
// A Proprietário Atual (v2) é tentada DUAS vezes e a falha passou a registrar o
// corpo devolvido pelo portal: antes o log tinha só o status HTTP, e quando
// ela falhava o ATPVe saía assim mesmo, com sete células em branco (nome/
// município/UF do vendedor, ano de fabricação, ano do modelo, cor e data do
// CRV) — documento inútil pro despachante, mas cobrado. Quem decide entregar ou
// recusar é a conferência de atpveCamposFaltando, nos dois chamadores.
async function fetchProprietarioAtualV2Fields(placa) {
  const r = await fetch(`${PORTAL_BASE_URL}/consultar-placa-v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', chaveAcesso: PORTAL_DESP_KEY },
    body: JSON.stringify({ placa }),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`HTTP ${r.status} — resposta: ${buf.toString('utf8').slice(0, 300)}`);
  }
  return extractLinePairFieldsFromPdf(buf);
}

// ── Data real da venda — "Consulta Comunicado" (portal) ─────────────────────
// A despbrasil devolve, em "Data declarada da venda", a data de GERAÇÃO da
// ATPVe; quem guarda a data que o vendedor comunicou ao Detran é a Consulta
// Comunicado (POST /consultar-comunicado, placa + renavam), o mesmo serviço
// avulso do catálogo. Ela responde um PDF pronto no formato "Rótulo:" numa
// linha e o valor na seguinte — igual ao Proprietário Atual, por isso reusa o
// extractLinePairFieldsFromPdf.
//
// Devolve { consultado, dataVenda }, e a diferença entre os dois casos de
// dataVenda nula importa:
//   • consultado:true  → a API respondeu e a placa não tem comunicação de venda
//                        registrada; aí a data da ATPVe é a única que existe e
//                        vira a impressa (ver buildNumeroAtpvePdfBuffer).
//   • consultado:false → a API não respondeu. Como não dá para saber se a data
//                        da ATPVe é a comunicada, o pedido é recusado sem cobrar
//                        (ver atpveCamposFaltando), em vez de repetir o defeito
//                        que esta consulta veio corrigir.
const COMUNICADO_DATA_VENDA_KEYS = ['datadavenda', 'datavenda'];
const DATA_BR_RE = /\b(\d{2}\/\d{2}\/\d{4})\b/;

async function fetchComunicadoDataVendaUmaVez(placa, renavam) {
  const r = await fetch(`${PORTAL_BASE_URL}/consultar-comunicado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', chaveAcesso: PORTAL_DESP_KEY },
    body: JSON.stringify({ placa, renavam }),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`HTTP ${r.status} — resposta: ${buf.toString('utf8').slice(0, 300)}`);
  // Sucesso vem sempre como PDF. Corpo em JSON aqui é erro de negócio (placa
  // sem comunicação, dado divergente): a consulta foi feita, só não há data.
  if (buf.slice(0, 4).toString('latin1') !== '%PDF') {
    console.error(`[consultar-Numero-ATPVE] Consulta Comunicado sem PDF (placa ${placa}): ${buf.toString('utf8').slice(0, 300)}`);
    return { consultado: true, dataVenda: null };
  }
  const f = await extractLinePairFieldsFromPdf(buf);
  for (const chave of COMUNICADO_DATA_VENDA_KEYS) {
    const m = DATA_BR_RE.exec(String(f[chave] || ''));
    if (m) return { consultado: true, dataVenda: m[1] };
  }
  // PDF legível e sem data da venda: é o relatório de comunicação não localizada.
  return { consultado: true, dataVenda: null };
}

// Duas tentativas, mesma régua da Proprietário Atual (v2): falha isolada da
// portal é comum e custa só uma segunda chamada.
async function fetchComunicadoDataVenda(placa, renavam) {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      return await fetchComunicadoDataVendaUmaVez(placa, renavam);
    } catch (e) {
      console.error(`[consultar-Numero-ATPVE] Consulta Comunicado falhou na tentativa ${tentativa}/2 (placa ${placa}):`, e.message);
    }
  }
  return { consultado: false, dataVenda: null };
}

async function runNumeroAtpveSupplementaryQueries(placa, knownRenavam) {
  const merged = {};

  let prop = null;
  for (let tentativa = 1; tentativa <= 2 && !prop; tentativa++) {
    try {
      prop = await fetchProprietarioAtualV2Fields(placa);
    } catch (e) {
      console.error(`[consultar-Numero-ATPVE] Proprietário Atual (v2) falhou na tentativa ${tentativa}/2 (placa ${placa}):`, e.message);
    }
  }
  if (prop) {
    if (prop.anodefabricacao) merged.anofabricacao = prop.anodefabricacao;
    if (prop.anodomodelo) merged.anomodelo = prop.anodomodelo;
    if (prop.marcamodelo) merged.marcamodeloversao = prop.marcamodelo;
    if (prop.cor) merged.cor = prop.cor;
    // Espécie, Tipo e Categoria não são lidos: o formulário do ATPVe não tem
    // célula para os dois primeiros e a CAT é fixa (ver ATPVE_CAT_SEM_CATEGORIA).
    if (prop.datadocrv) merged.datacrv = prop.datadocrv;
    if (prop.nomedoproprietario) merged.nomevendedor = prop.nomedoproprietario;
    // "DADOS DO EMPLACAMENTO" (município/UF de registro do veículo) — usado
    // tanto pro domicílio exibido do vendedor quanto pro "DETRAN - UF" do
    // cabeçalho, que deve refletir a origem de onde o veículo foi
    // emplacado, não a UF da intenção de venda.
    if (prop.municipio) { merged.municipiovendedor = prop.municipio; merged.municipioemplacamento = prop.municipio; }
    if (prop.ufjurisdicao) { merged.ufvendedor = prop.ufjurisdicao; merged.ufemplacamento = prop.ufjurisdicao; }
  }

  const f = await fetchCodigoSegurancaCrvFields(placa, knownRenavam);
  if (f.codigosegurancacrv) merged.codigosegurancacrv = f.codigosegurancacrv;
  if (f.marcamodeloversao && !merged.marcamodeloversao) merged.marcamodeloversao = f.marcamodeloversao;

  // Data que o vendedor comunicou ao Detran. Sem renavam não há o que
  // consultar — e renavam em branco já derruba o pedido na conferência de
  // ATPVE_CAMPOS_OBRIGATORIOS, antes de qualquer débito.
  if (knownRenavam) {
    const comunicado = await fetchComunicadoDataVenda(placa, knownRenavam);
    if (comunicado.dataVenda) merged.datavendacomunicada = comunicado.dataVenda;
    else if (!comunicado.consultado) merged._comunicadoIndisponivel = true;
  }

  return merged;
}

// Células do ATPVe que não podem sair em branco: sem qualquer uma delas o
// documento não serve pro despachante. A montagem do PDF sempre tolerou campo
// vazio (célula em branco) porque as consultas complementares eram "melhor
// esforço" — o resultado prático era o cliente pagar e receber um ATPVe com o
// vendedor e os dados do veículo em branco quando uma das upstreams falhava.
// Agora a falta é conferida antes do débito: o pedido é recusado com a lista do
// que faltou (e o admin avisado), em vez de entregar meio documento. Hodômetro
// e e-mails ficam de fora de propósito — saem em branco no oficial também.
// Todas as chaves da lista são as MESMAS usadas em buildNumeroAtpvePdfBuffer.
const ATPVE_CAMPOS_OBRIGATORIOS = [
  ['renavam',                       'Código Renavam'],
  ['chassi',                        'Chassi'],
  ['marcamodeloversao',             'Marca/Modelo/Versão'],
  ['anofabricacao',                 'Ano de fabricação'],
  ['anomodelo',                     'Ano do modelo'],
  ['cor',                           'Cor predominante'],
  ['numerocrv',                     'Número do CRV'],
  ['codigosegurancacrv',            'Código de segurança do CRV'],
  ['datacrv',                       'Data de emissão do CRV'],
  ['numeroatpve',                   'Número ATPVe'],
  ['nomevendedor',                  'Nome do vendedor'],
  ['documentovendedor',             'CPF/CNPJ do vendedor'],
  ['municipiovendedor',             'Município do vendedor'],
  ['ufvendedor',                    'UF do vendedor'],
  ['nomecomprador',                 'Nome do comprador'],
  ['documentocomprador',            'CPF/CNPJ do comprador'],
  ['municipiocomprador',            'Município do comprador'],
  ['ufcomprador',                   'UF do comprador'],
  ['valorvenda',                    'Valor declarado na venda'],
  ['datahoraregistrointencaovenda', 'Data declarada da venda'],
];

function atpveCamposFaltando(fields) {
  const faltando = ATPVE_CAMPOS_OBRIGATORIOS
    .filter(([chave]) => !String(fields?.[chave] ?? '').trim())
    .map(([, rotulo]) => rotulo);
  // A Consulta Comunicado fora do ar não deixa campo em branco — deixa a célula
  // com a data de geração da ATPVe, que pode não ser a data da venda. Entregar
  // assim é vender o defeito, então entra na lista e o pedido é recusado sem
  // cobrar (ver fetchComunicadoDataVenda).
  if (fields?._comunicadoIndisponivel) faltando.push('Data da venda comunicada ao Detran');
  return faltando;
}

// Aviso ao admin quando o ATPVe é recusado por falta de dado: a causa é sempre
// uma upstream fora do ar (portal, Vistocar ou despbrasil), e sem esse aviso a
// única forma de descobrir era o cliente reclamar do documento em branco.
async function avisarAdminAtpveIncompleto(placa, faltando, origem) {
  if (!ADMIN_PHONE) return;
  const msg = [
    `⚠️ *ATPVe não emitido — dados incompletos*`,
    ``,
    `🔤 *Placa:* ${placa}`,
    `🧾 *Origem:* ${origem}`,
    `❌ *Campos em branco:* ${faltando.join(', ')}`,
    ``,
    `O pedido foi recusado sem cobrar. Confira o saldo e o status das APIs (portal consultar-placa-v2, Vistocar/despbrasil código de segurança).`,
  ].join('\n');
  await sendWhatsApp(ADMIN_PHONE, msg).catch(() => {});
}

// Busca o PDF da despbrasil e extrai os campos — separado em função própria pra
// poder tentar de novo (ver runPublicAtpveComunicacaoVenda): a despbrasil parece
// gerar o PDF na hora a cada chamada, e às vezes devolve um arquivo malformado
// que trava o parser (pdf.js) com erro tipo "Invalid number" — uma nova geração
// (nova chamada) costuma vir íntegra.
async function fetchAndExtractAtpveFromDespbrasil(placa) {
  const r = await fetch(DESPBRASIL_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', chaveAcesso: DESPBRASIL_KEY },
    body: JSON.stringify({ servico: DESPBRASIL_SVCS['consultar-Numero-ATPVE'].servico, placa }),
  });
  const parsed = await r.json().catch(() => null);
  if (!r.ok || !parsed?.sucesso || !parsed?.arquivo_url) {
    console.error(`[atpve-comunicacao-venda avulsa] resposta inesperada da despbrasil: ${JSON.stringify(parsed)}`);
    throw new Error('Não encontramos o número do ATPV-E para essa placa no momento.');
  }

  const pdfRes = await fetch(parsed.arquivo_url);
  if (!pdfRes.ok) throw new Error('Falha ao obter o PDF gerado pela API.');
  const sourcePdfBuf = Buffer.from(await pdfRes.arrayBuffer());

  return extractAtpveFieldsFromPdf(sourcePdfBuf);
}

// ── "Reemissão da ATPVe Com Comunicação de Venda" — versão avulsa (consulta-avulsa,
// pública/sem cadastro). Pipeline despbrasil → extractAtpveFieldsFromPdf →
// runNumeroAtpveSupplementaryQueries → buildNumeroAtpvePdfBuffer — idêntico ao
// usado na versão logada (ver /api/query, serviceId 'consultar-Numero-ATPVE'),
// inclusive a mesma extractAtpveFieldsFromPdf (o PDF bruto da despbrasil é sempre
// "Rótulo: valor" por linha; uma tentativa anterior de reescrever essa extração
// partiu de uma leitura errada — analisou nosso próprio PDF renderizado achando
// que era o bruto da despbrasil — e foi revertida). Só a placa é informada pelo
// cliente, sem edição manual dos demais campos.
async function runPublicAtpveComunicacaoVenda(params) {
  const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');

  let fields;
  try {
    fields = await fetchAndExtractAtpveFromDespbrasil(placa);
  } catch (e) {
    console.error(`[atpve-comunicacao-venda avulsa] 1ª tentativa falhou (${e.message}) — tentando de novo.`);
    try {
      fields = await fetchAndExtractAtpveFromDespbrasil(placa);
    } catch (e2) {
      console.error(`[atpve-comunicacao-venda avulsa] 2ª tentativa também falhou:`, e2.stack || e2.message);
      throw new Error('Não foi possível gerar o documento para essa placa no momento. Tente novamente em alguns minutos ou fale com o suporte.');
    }
  }

  Object.assign(fields, await runNumeroAtpveSupplementaryQueries(placa, fields.renavam));

  // Mesma regra do painel: documento com célula obrigatória em branco não é
  // entregue (aqui o erro vira estorno automático do PIX, ver
  // failPublicOrderAndRefund no chamador).
  const faltando = atpveCamposFaltando(fields);
  if (faltando.length) {
    console.error(`[atpve-comunicacao-venda avulsa] ${placa}: campos obrigatórios em branco (${faltando.join(', ')}).`);
    await avisarAdminAtpveIncompleto(placa, faltando, 'Consulta avulsa (ATPVe com Comunicação de Venda)');
    throw new Error(`Não foi possível reunir todos os dados do veículo para essa placa (faltou: ${faltando.join(', ')}). Tente novamente em alguns minutos ou fale com o suporte.`);
  }

  const service = SERVICES.find(s => s.id === 'consultar-Numero-ATPVE');
  return buildNumeroAtpvePdfBuffer(service, fields, { placa }, { withSelos: true });
}

// ── Geração de PDF — CNH (Datacube retorna JSON, não PDF pronto) ───────────────
function buildCnhPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      const ufName = (service.name || '').replace(/^CNH\s*-\s*/i, '');
      pdfReportHeader(doc, `CNH - ${ufName.toUpperCase()}`, now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      const fieldLabels = {
        nome: 'Nome', cpf: 'CPF', cnh: 'Número da CNH', renach: 'RENACH',
        formulario: 'Formulário', registro: 'Registro',
        data_nascimento: 'Data de Nascimento', data_validade_cnh: 'Validade da CNH',
        cod_municipio_nascimento: 'Cód. Município de Nascimento', uf_nascimento: 'UF de Nascimento',
      };
      const consultaPairs = Object.entries(fieldLabels)
        .filter(([k]) => params?.[k])
        .map(([k, label]) => [label, params[k]]);
      if (consultaPairs.length) pdfFieldGrid(doc, consultaPairs);
      else pdfEmptyNotice(doc, 'Nenhum dado informado.');
      doc.moveDown(0.4);

      pdfBar(doc, 'RESULTADO');
      const pairs = itemToPairs(data);
      if (pairs.length) pdfFieldGrid(doc, pairs);
      else pdfEmptyNotice(doc, 'Nenhum dado retornado para essa consulta.');
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Veículos por Documento (Datacube retorna JSON, não PDF pronto) ──
function buildVeiculosDocPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'VEÍCULOS POR DOCUMENTO', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Documento', maskDocDisplay(params?.documento)]]);
      doc.moveDown(0.4);

      const items = Array.isArray(data) ? data
        : Array.isArray(data?.veiculos) ? data.veiculos
        : Array.isArray(data?.result)   ? data.result
        : null;

      pdfBar(doc, 'VEÍCULOS ENCONTRADOS');
      if (Array.isArray(items)) {
        pdfDebtSection(doc, items, 'Veículo');
      } else {
        pdfRenderGenericObject(doc, data);
      }
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Roubo e Furto (Datacube retorna JSON, não PDF pronto) ─────
function buildRouboFurtoPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'ROUBO E FURTO', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      const items = Array.isArray(data) ? data
        : Array.isArray(data?.ocorrencias) ? data.ocorrencias
        : null;

      pdfBar(doc, 'RESULTADO');
      if (Array.isArray(items)) {
        pdfDebtSection(doc, items, 'Ocorrência');
      } else {
        pdfRenderGenericObject(doc, data);
      }
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Histórico de Proprietários (Datacube retorna JSON, não PDF pronto) ──
function buildHistoricoProprietarioPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'HISTÓRICO DE PROPRIETÁRIOS', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      const items = Array.isArray(data) ? data
        : Array.isArray(data?.proprietarios) ? data.proprietarios
        : Array.isArray(data?.historico)     ? data.historico
        : null;

      pdfBar(doc, 'PROPRIETÁRIOS');
      if (Array.isArray(items)) {
        pdfDebtSection(doc, items, 'Proprietário');
      } else {
        pdfRenderGenericObject(doc, data);
      }
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Proprietário Atual (Datacube retorna JSON, não PDF pronto) ──
// Diferente dos demais relatórios da "Opção 2" (que só despejam o objeto cru),
// aqui os campos principais já têm um extrator testado em produção
// (extractProprietarioAtualFields, o mesmo usado pela Procuração Veicular e pela
// Gerar ASD): o relatório abre com Proprietário e Veículo normalizados e só
// depois despeja a resposta completa, para nenhum campo devolvido pela Datacube
// se perder — o schema varia entre placas e o extrator cobre só os conhecidos.
function buildProprietarioAtualPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      const f = extractProprietarioAtualFields(data);
      const endereco = composeEndereco(f);
      const ouNada = v => (v && String(v).trim()) ? String(v).trim() : 'Nada consta';

      pdfReportHeader(doc, 'PROPRIETÁRIO ATUAL', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      pdfBar(doc, 'PROPRIETÁRIO');
      pdfFieldGrid(doc, [
        ['Nome',     ouNada(f.nome)],
        ['CPF/CNPJ', f.cpfCnpj ? maskDocDisplay(f.cpfCnpj) : 'Nada consta'],
        ['Endereço', ouNada(endereco)],
      ]);
      doc.moveDown(0.4);

      pdfBar(doc, 'VEÍCULO');
      pdfFieldGrid(doc, [
        ['Marca/Modelo',      ouNada(f.marcaModelo)],
        ['Chassi',            ouNada(f.chassi)],
        ['Renavam',           ouNada(f.renavam)],
        ['Cor',               ouNada(f.cor)],
        ['Ano de Fabricação', ouNada(f.anoFabricacao)],
        ['Ano do Modelo',     ouNada(f.anoModelo)],
      ]);
      doc.moveDown(0.4);

      pdfBar(doc, 'RETORNO COMPLETO DA CONSULTA');
      pdfRenderGenericObject(doc, data);
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Serviços da "Opção 2 Nova Consulta" cuja upstream devolve JSON mas que o
// usuário recebe como relatório PDF no padrão da casa. Não confundir com a flag
// returnsPdf do catálogo: aquela é para quando a PRÓPRIA Datacube manda o PDF
// pronto em base64 (ver findAndStripBase64Pdf); aqui o PDF é montado por nós a
// partir do JSON, como já acontece no /api/query. Ver uso em /api/query-v2.
const V2_PDF_BUILDERS = {
  'dc-proprietario-atual': buildProprietarioAtualPdfBuffer,
};

// ── Geração de PDF — Histórico de Gravames (Datacube retorna JSON, não PDF pronto) ──
function buildHistoricoGravamesPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'HISTÓRICO DE GRAVAMES', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Chassi', params?.chassi || '-']]);
      doc.moveDown(0.4);

      const items = Array.isArray(data) ? data
        : Array.isArray(data?.gravames)  ? data.gravames
        : Array.isArray(data?.historico) ? data.historico
        : null;

      pdfBar(doc, 'GRAVAMES');
      if (Array.isArray(items)) {
        pdfDebtSection(doc, items, 'Gravame');
      } else {
        pdfRenderGenericObject(doc, data);
      }
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Leilão (Datacube retorna JSON, não PDF pronto) ────────────
function buildLeilaoPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'LEILÃO', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      const items = Array.isArray(data) ? data
        : Array.isArray(data?.leiloes) ? data.leiloes
        : Array.isArray(data?.result)  ? data.result
        : null;

      pdfBar(doc, 'RESULTADO');
      if (Array.isArray(items)) {
        pdfDebtSection(doc, items, 'Leilão');
      } else {
        pdfRenderGenericObject(doc, data);
      }
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Veículo 0km (Datacube retorna JSON, não PDF pronto) ───────
function buildConsulta0kmPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'VEÍCULO 0KM', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Chassi', params?.chassi || '-']]);
      doc.moveDown(0.4);

      pdfBar(doc, 'RESULTADO');
      pdfRenderGenericObject(doc, data);
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Base Estadual / BIN (Datacube retorna JSON, não PDF pronto) ──
function buildBinEstadualPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();

      pdfReportHeader(doc, 'BASE ESTADUAL (BIN)', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      pdfBar(doc, 'RESULTADO');
      pdfRenderGenericObject(doc, data);
      doc.moveDown(0.4);

      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Rótulos amigáveis para o campo "statusPagamento" da Vistocar (débitos-cod-barra) —
// só documentados os valores vistos em produção até agora; qualquer outro valor cai
// no fallback (o próprio texto retornado pela API).
const DEBITOS_COD_BARRA_STATUS_LABELS = {
  opened: 'Em aberto',
  notice: 'Aviso de cobrança',
  paid: 'Pago',
};

// Gera a imagem do código de barras do boleto (padrão Interleaved 2 of 5, usado nos
// boletos bancários brasileiros) a partir da linha de pagamento — o "codigoBarra" de
// 44 dígitos da Vistocar é o valor numérico puro (sem os dígitos verificadores extras
// da "linhaDigitavel", que é só a formatação para digitação manual). bwip-js roda em
// JS puro (sem canvas nativo), compatível com a function serverless da Vercel.
async function generateBoletoBarcodePng(codigoBarra) {
  const digits = String(codigoBarra || '').replace(/\D/g, '');
  if (digits.length !== 44) return null;
  try {
    return await bwipjs.toBuffer({
      bcid: 'interleaved2of5',
      text: digits,
      scale: 3,
      height: 12,
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0,
    });
  } catch (e) {
    console.error('Erro ao gerar código de barras do boleto:', e.message);
    return null;
  }
}

// A Vistocar manda dataVencimento em ISO ("2026-10-05"); o relatório é pt-BR.
// Qualquer outro formato passa direto, para não estragar o que já vier pronto.
function fmtVencimentoBR(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (v || '-');
}

// ── Geração de PDF — Débitos + Código de Barras (API Vistocar retorna JSON com a
// lista de débitos já com código de barras/linha digitável do boleto, não PDF pronto) ──
async function buildDebitosCodBarraPdfBuffer(service, data, params) {
  const registros = Array.isArray(data?.registros) ? data.registros : [];
  const barcodePngs = await Promise.all(registros.map(r => generateBoletoBarcodePng(r.codigoBarra)));
  // Débito só tem boleto quando o órgão já o emitiu: enquanto a multa está apenas
  // em aviso de cobrança (statusPagamento 'notice'), a Vistocar devolve o registro
  // completo mas com codigoBarra/linhaDigitavel vazios. Isso é comum e não é falha
  // da consulta — o relatório precisa explicar, senão o campo sai como um "-" mudo
  // e parece que a geração do código de barras quebrou.
  const temBoleto = (r, idx) => !!(r.linhaDigitavel || barcodePngs[idx]);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const { left, width } = pdfContentBox(doc);
      const now = new Date();

      pdfReportHeader(doc, 'DÉBITOS + CÓDIGO DE BARRAS', now);

      pdfBar(doc, 'DADOS DA CONSULTA');
      pdfFieldGrid(doc, [['Placa', maskPlacaDisplay(params?.placa)]]);
      doc.moveDown(0.4);

      const total = registros.reduce((acc, r) => acc + (Number(r.valor) || 0), 0);
      pdfEnsureSpace(doc, 36);
      const boxY = doc.y;
      const boxH = 28;
      doc.rect(left, boxY, width, boxH).fill('#f97316');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5)
        .text('TOTAL ESTIMADO DE DÉBITOS', left + 12, boxY + 9);
      doc.fontSize(13).text(fmtMoneyBRL(total), left, boxY + 7, { width: width - 12, align: 'right' });
      doc.y = boxY + boxH + 4;
      doc.fillColor('#111827').font('Helvetica').fontSize(10);
      doc.moveDown(0.4);

      // Aviso no topo quando NENHUM débito tem boleto: é a situação que mais gera
      // dúvida ("a consulta não gerou código de barras"), então precisa aparecer
      // antes da lista, não só no rodapé de cada débito.
      if (registros.length && !registros.some(temBoleto)) {
        pdfEnsureSpace(doc, 50);
        const avisoY = doc.y;
        const avisoH = 40;
        doc.rect(left, avisoY, width, avisoH).fill('#fef3c7');
        doc.fillColor('#92400e').font('Helvetica-Bold').fontSize(9)
          .text('SEM LINHA DIGITÁVEL E SEM CÓDIGO DE BARRAS', left + 10, avisoY + 6, { width: width - 20 });
        doc.font('Helvetica').fontSize(8)
          .text('O órgão ainda não abriu a cobrança destes débitos — eles constam apenas como aviso de cobrança. '
            + 'Enquanto isso não existe linha digitável nem código de barras para pagamento. '
            + 'Consulte novamente mais perto do vencimento, quando o boleto for disponibilizado.',
            left + 10, avisoY + 19, { width: width - 20 });
        doc.y = avisoY + avisoH + 6;
        doc.fillColor('#111827').font('Helvetica').fontSize(10);
      }

      pdfBar(doc, 'DÉBITOS');
      if (!registros.length) {
        pdfEmptyNotice(doc, 'Nenhum débito encontrado para esta placa.');
      } else {
        registros.forEach((r, idx) => {
          pdfSubBar(doc, `Débito ${idx + 1}`);
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827')
            .text('Descrição:', left, doc.y, { width });
          doc.font('Helvetica').fontSize(9.5).fillColor('#374151')
            .text(r.descricao || 'Sem descrição', left, doc.y, { width });
          doc.fillColor('#111827').font('Helvetica').fontSize(10);
          doc.moveDown(0.3);

          const vencimento = fmtVencimentoBR(r.dataVencimento);
          pdfFieldGrid(doc, [
            ['Valor', fmtMoneyBRL(r.valor)],
            ['Vencimento', vencimento],
            ['Situação', DEBITOS_COD_BARRA_STATUS_LABELS[r.statusPagamento] || r.statusPagamento || '-'],
          ]);
          doc.moveDown(0.25);

          // Linha digitável (texto, para digitar manualmente) + código de barras
          // (imagem, para leitura por app do banco) — mesmo layout de um boleto real.
          const barcodePng = barcodePngs[idx];
          if (temBoleto(r, idx)) {
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827')
              .text('Linha Digitável (pagamento):', left, doc.y, { width });
            doc.font('Helvetica').fontSize(9.5).fillColor('#374151')
              .text(r.linhaDigitavel || '-', left, doc.y, { width });
            doc.fillColor('#111827').font('Helvetica').fontSize(10);
            doc.moveDown(0.3);

            if (barcodePng) {
              const barcodeW = Math.min(width * 0.65, 260);
              pdfEnsureSpace(doc, 55);
              doc.image(barcodePng, left, doc.y, { width: barcodeW });
              doc.y += 42;
            }
          } else {
            // Sem boleto emitido: diz o motivo em vez de imprimir "-" e nenhuma
            // imagem, que é o que fazia a consulta parecer quebrada.
            const motivo = r.statusPagamento === 'notice'
              ? `O órgão ainda não abriu a cobrança deste débito — ele consta apenas como aviso de cobrança`
                + `${vencimento && vencimento !== '-' ? `, com vencimento em ${vencimento}` : ''}. `
                + `Por isso não existe linha digitável nem código de barras para pagamento: os dois só são `
                + `gerados quando o débito entra em cobrança.`
              : 'O órgão não disponibilizou linha digitável nem código de barras para este débito.';
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#b45309')
              .text('Sem linha digitável e sem código de barras:', left, doc.y, { width });
            doc.font('Helvetica').fontSize(9).fillColor('#92400e')
              .text(motivo, left, doc.y, { width });
            doc.fillColor('#111827').font('Helvetica').fontSize(10);
            doc.moveDown(0.3);
          }

          const detalhes = Array.isArray(r.detalhes) ? r.detalhes : [];
          if (detalhes.length) {
            doc.moveDown(0.2);
            pdfFieldGrid(doc, detalhes.map(d => [d.chave, d.valor]));
          }
          doc.moveDown(0.35);
        });
      }

      pdfReportFooter(doc, now);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Geração de PDF — Inserir Comunicação Venda (API retorna JSON, não PDF pronto) ──
function buildComunicacaoVendaPdfBuffer(service, data, params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const now = new Date();
      const cancelada = !!data?._cancelado;

      pdfReportHeader(doc, 'COMUNICAÇÃO DE VENDA', now);

      if (cancelada) {
        pdfBar(doc, 'COMUNICAÇÃO DE VENDA CANCELADA', { bg: '#dc2626' });
        doc.moveDown(0.2);
      }

      pdfBar(doc, 'DADOS DA CONSULTA');
      const veic = params?.veiculo  || {};
      const v    = params?.vendedor || {};
      const c    = params?.comprador || {};
      const vda  = params?.venda    || {};
      pdfFieldGrid(doc, [
        ['Placa', maskPlacaDisplay(veic.placa)],
        ['Renavam', veic.renavam || '-'],
        ['Vendedor', v.nome || '-'],
        ['CPF/CNPJ do Vendedor', maskDocDisplay(v.cpf || v.cnpj)],
        ['Comprador', c.nome || '-'],
        ['CPF/CNPJ do Comprador', maskDocDisplay(c.cpf || c.cnpj)],
        ['Data da Venda', vda.data || '-'],
        ['Valor da Venda', vda.valor ? String(vda.valor) : '-'],
      ]);
      doc.moveDown(0.4);

      // Sem seção "RESULTADO" com a resposta bruta do portal: o campo de situação
      // dela (ex.: "importado") ficaria congelado no momento da inserção e seria
      // enganoso depois. A única situação refletida aqui é o cancelamento (acima),
      // porque cacheComunicacaoVendaPdf regera este PDF quando isso acontece — o
      // resto continua mostrado dinamicamente em "Meus Comunicados de Venda" (ver
      // renderMeusComunicadosVenda em painel-usuario.html).
      pdfReportFooter(doc, now);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Pós-pago: ciclo, fatura e débito ─────────────────────────────────────────
// Desenho em uma frase: o cliente pós-pago não tem saldo, tem fatura. Cada
// consulta soma em faturas.valor da fatura ABERTA (uma por cliente, garantida
// por índice) e users.credits nem é tocado — é isso que evita cobrar a mesma
// consulta duas vezes, no saldo e na fatura.
//
// O vencimento é sempre dia 30 (POS_PAGO_DIA_VENCIMENTO). A "pro rata" do
// primeiro ciclo é automática porque a fatura é consumo, não mensalidade: quem
// entra dia 12 paga no dia 30 o que consumiu de 12 a 30, e só.
//
// Não há cron para virar o ciclo: a virada é preguiçosa (garantirCicloPosPago),
// disparada por quem toca a conta — a consulta, a tela de fatura do cliente e a
// lista do admin. Idempotente, então rodar duas vezes junto não cria dois
// ciclos (o índice parcial de fatura aberta é a última linha de defesa).

// Brasília é UTC-3 o ano inteiro (sem horário de verão desde 2019) e o servidor
// roda em UTC na Vercel — sem esse deslocamento, "dia 30 às 23:59" viraria dia
// 30 às 20:59 para o cliente, e a virada aconteceria com o dia ainda correndo.
const TZ_BR_OFFSET_MS = 3 * 60 * 60 * 1000;

// Último instante do dia 30 (ou do último dia do mês, quando ele tem menos de
// 30 dias) seguinte a "apartirDe". Ligar o pós-pago NO dia 30 joga o vencimento
// para o mês seguinte: fatura que nasce e vence no mesmo dia não dá ao cliente
// nenhum dia de uso.
function proximoVencimentoPosPago(apartirDe = new Date()) {
  const base = new Date(apartirDe.getTime() - TZ_BR_OFFSET_MS);
  let ano = base.getUTCFullYear();
  let mes = base.getUTCMonth();
  const diaDoMes = (a, m) =>
    Math.min(POS_PAGO_DIA_VENCIMENTO, new Date(Date.UTC(a, m + 1, 0)).getUTCDate());
  let dia = diaDoMes(ano, mes);
  if (base.getUTCDate() >= dia) {
    mes += 1;
    if (mes > 11) { mes = 0; ano += 1; }
    dia = diaDoMes(ano, mes);
  }
  return new Date(Date.UTC(ano, mes, dia, 23, 59, 59) + TZ_BR_OFFSET_MS);
}

// ── Ciclo da Assinatura Coisas de Despachantes ───────────────────────────────
// Desde 22/09/2026 a assinatura deixou de ser "30 dias contados do pagamento" e
// passou a acompanhar o calendário: todo período termina no dia 30, o MESMO
// vencimento do pós-pago (proximoVencimentoPosPago), para quem tem as duas
// coisas pagar tudo no mesmo dia.
//
// A consequência é que o primeiro período — e o de quem renova no meio do mês —
// é PARCIAL, e por isso o preço é pró-rata: R$ 1,00 por dia
// (ASSINATURA_PLACAS_PRICE / ASSINATURA_PLACAS_DIAS). Cobrar o mês inteiro por
// oito dias de uso seria vender o que não se entrega.
//
// As cotas do período acompanham o preço pela mesma razão, e por uma a mais:
// cada consulta de placa custa dinheiro na Datacube, então um período de três
// dias com as 50 consultas cheias sairia por R$ 3,00 e daria prejuízo. Quem
// paga um terço do mês leva um terço da cota, arredondando para cima e nunca
// menos de 1 — período pago sem nenhuma consulta não é período.
//
// O início NÃO é sempre "agora": quem renova antes de vencer continua começando
// o período novo no fim do atual (não perde os dias que faltavam). O que mudou
// é onde o período termina.
function cicloAssinatura(inicio = new Date()) {
  const fim = proximoVencimentoPosPago(inicio);
  const dias = Math.max(1, Math.ceil((fim.getTime() - inicio.getTime()) / 86400000));
  return { inicio, fim, dias };
}

function fmtDataCicloBR(d) {
  const t = new Date(new Date(d).getTime() - TZ_BR_OFFSET_MS);
  const dia = String(t.getUTCDate()).padStart(2, '0');
  const mes = String(t.getUTCMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${t.getUTCFullYear()}`;
}

// Preço do período, limitado ao valor cheio do plano: o ciclo pode ter 31 dias
// (mês cheio + a sobra do dia 30), e ninguém paga mais que a mensalidade.
function precoAssinaturaProRata(dias) {
  const bruto = (ASSINATURA_PLACAS_PRICE / ASSINATURA_PLACAS_DIAS) * dias;
  return Math.round(Math.min(ASSINATURA_PLACAS_PRICE, bruto) * 100) / 100;
}

function cotaProRata(cotaCheia, dias) {
  if (dias >= ASSINATURA_PLACAS_DIAS) return cotaCheia;
  return Math.max(1, Math.ceil((cotaCheia * dias) / ASSINATURA_PLACAS_DIAS));
}

// As quatro cotas do período, já proporcionais aos dias comprados.
function cotasAssinaturaProRata(dias) {
  return {
    placas:        cotaProRata(ASSINATURA_PLACAS_COTA, dias),
    crv:           cotaProRata(ASSINATURA_CRV_COTA, dias),
    assinatura:    cotaProRata(ASSINATURA_DIGITAL_COTA, dias),
    verificarCrlv: cotaProRata(ASSINATURA_VERIFICAR_CRLV_COTA, dias),
  };
}

// Início do próximo período do cliente: agora, ou o fim do período vigente
// quando ele renova antes de vencer. Assinatura sem data limite (cortesia do
// admin) não tem "próximo período" — quem chama trata o null.
async function proximoCicloAssinatura(userId) {
  const r = await pool.query(
    `SELECT MAX(expires_at) AS fim FROM subscriptions
      WHERE user_id=$1 AND expires_at > NOW()`,
    [userId]
  );
  const fimAtual = r.rows[0]?.fim ? new Date(r.rows[0].fim) : null;
  const inicio = fimAtual && fimAtual > new Date() ? fimAtual : new Date();
  return cicloAssinatura(inicio);
}

// Abre a fatura do ciclo corrente se não houver nenhuma. O ON CONFLICT casa com
// idx_faturas_uma_aberta: duas consultas simultâneas do mesmo cliente não abrem
// duas faturas.
async function garantirFaturaAberta(userId, inicio = new Date()) {
  const existente = await pool.query(
    `SELECT * FROM faturas WHERE user_id=$1 AND status='ABERTA'`, [userId]
  );
  if (existente.rows.length) return existente.rows[0];
  await pool.query(
    `INSERT INTO faturas (user_id, periodo_inicio, vencimento)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [userId, inicio, proximoVencimentoPosPago(inicio)]
  );
  const r = await pool.query(
    `SELECT * FROM faturas WHERE user_id=$1 AND status='ABERTA'`, [userId]
  );
  return r.rows[0] || null;
}

// Virada de ciclo: passado o vencimento, a fatura aberta é fechada (valor
// congelado) e a do ciclo seguinte é aberta começando no próprio vencimento.
// Fatura fechada com valor zero já nasce quitada — não faz sentido cobrar R$ 0
// nem bloquear o cliente por ela.
async function garantirCicloPosPago(userId) {
  let aberta = await garantirFaturaAberta(userId);
  // Conta parada por meses (ninguém consultou, ninguém abriu a tela) tem mais
  // de um ciclo atrasado: o laço vira um de cada vez até chegar no ciclo de
  // hoje. O teto de 60 é só para uma data maluca no banco não travar a rota.
  for (let i = 0; aberta && new Date(aberta.vencimento) <= new Date() && i < 60; i++) {
    // Ciclo sem consumo nasce quitado: não há o que cobrar nem por que
    // bloquear o cliente. Os três campos vêm calculados daqui em vez de um
    // CASE sobre o mesmo parâmetro — o Postgres recusa deduzir dois tipos para
    // o mesmo $n ("inconsistent types deduced for parameter").
    const zerada = parseFloat(aberta.valor) <= 0;
    await pool.query(
      `UPDATE faturas SET status=$2, fechada_em=NOW(), paga_em=$3, origem_baixa=$4
         WHERE id=$1 AND status='ABERTA'`,
      [aberta.id, zerada ? 'PAGA' : 'FECHADA', zerada ? new Date() : null, zerada ? 'SEM_CONSUMO' : null]
    );
    aberta = await garantirFaturaAberta(userId, new Date(aberta.vencimento));
  }
  return aberta;
}

// Situação financeira do pós-pago, num lugar só — usada pelo porteiro da
// consulta, pela tela do cliente e pela lista do admin.
async function resumoPosPago(userId) {
  const ur = await pool.query(
    'SELECT pos_pago, pos_pago_limite, pos_pago_desde FROM users WHERE id=$1', [userId]
  );
  const u = ur.rows[0];
  if (!u || !u.pos_pago) return { posPago: false };

  const aberta = await garantirCicloPosPago(userId);
  const pend = await pool.query(
    `SELECT id, valor, vencimento, fechada_em FROM faturas
      WHERE user_id=$1 AND status='FECHADA' ORDER BY vencimento ASC`, [userId]
  );
  const vencidas = pend.rows.filter(f =>
    new Date(f.vencimento).getTime() + POS_PAGO_CARENCIA_DIAS * 86400000 < Date.now()
  );
  const limite = u.pos_pago_limite === null ? null : parseFloat(u.pos_pago_limite);
  const emAberto = aberta ? parseFloat(aberta.valor) : 0;
  const fechadoEmAberto = pend.rows.reduce((s, f) => s + parseFloat(f.valor), 0);
  return {
    posPago: true,
    desde: u.pos_pago_desde,
    limite,
    fatura: aberta,
    emAberto,
    fechadas: pend.rows,
    fechadoEmAberto,
    devido: parseFloat((emAberto + fechadoEmAberto).toFixed(2)),
    vencidas,
    bloqueado: vencidas.length > 0,
  };
}

// Porteiro do pagamento da consulta, nos dois modelos. Devolve null quando pode
// seguir, ou { status, body } pronto para o res. O pré-pago segue exatamente
// como sempre foi (saldo < preço barra); o pós-pago não tem saldo a conferir —
// o que barra é fatura vencida além da carência e o teto do ciclo.
async function bloqueioPagamentoConsulta(userId, user, price) {
  if (!user.pos_pago) {
    if (parseFloat(user.credits) < price) {
      return { status: 400, body: {
        error: `Saldo insuficiente. Necessário: R$ ${price.toFixed(2).replace('.', ',')}`,
      } };
    }
    return null;
  }
  const resumo = await resumoPosPago(userId);
  if (resumo.bloqueado) {
    const venc = new Date(resumo.vencidas[0].vencimento).toLocaleDateString('pt-BR');
    return { status: 402, body: {
      code: 'FATURA_VENCIDA',
      error: `Sua fatura venceu em ${venc} e ainda consta em aberto. Pague em "Conta Pós-paga" para voltar a consultar.`,
    } };
  }
  if (resumo.limite !== null && resumo.emAberto + price > resumo.limite) {
    return { status: 402, body: {
      code: 'LIMITE_POS_PAGO',
      error: `Esta consulta passa do seu limite de R$ ${resumo.limite.toFixed(2).replace('.', ',')} por ciclo (já usados R$ ${resumo.emAberto.toFixed(2).replace('.', ',')}). Pague a fatura em aberto ou fale com o suporte para ampliar o limite.`,
    } };
  }
  return null;
}

// Recarga de crédito no pós-pago é dinheiro parado: o consumo desse cliente vai
// todo para a fatura e NUNCA sai de users.credits (ver debitarConsulta). Por
// isso o painel troca a "Recarga PIX" pela "Conta Pós-paga" e as rotas de
// recarga recusam — quem depositasse pagaria duas vezes, uma no crédito que não
// se gasta e outra na fatura do dia 30.
const RECARGA_POS_PAGO_MSG =
  'Sua conta é pós-paga: as consultas entram na fatura com vencimento dia 30, não em créditos. ' +
  'Recarregar deixaria o dinheiro parado — pague a fatura em "Conta Pós-paga", no painel.';

// Débito de uma consulta. Ponto ÚNICO: todo lugar que cobrava com
// "UPDATE users SET credits = credits - ..." passa por aqui, senão o pós-pago
// consumiria saldo que ele não tem e a fatura sairia zerada.
async function debitarConsulta(userId, amount) {
  const valor = parseFloat(amount);
  if (!(valor > 0)) return;
  const ur = await pool.query('SELECT pos_pago FROM users WHERE id=$1', [userId]);
  if (!ur.rows[0]?.pos_pago) {
    await pool.query('UPDATE users SET credits = credits - $1 WHERE id=$2', [valor, userId]);
    return;
  }
  const fatura = await garantirCicloPosPago(userId);
  if (!fatura) {
    // Não deveria acontecer (garantirFaturaAberta cria a fatura), mas ficar sem
    // cobrar é pior que cobrar do saldo: o consumo não pode evaporar.
    console.error(`[pos-pago] usuário ${userId} sem fatura aberta — débito de R$ ${valor} foi para o saldo.`);
    await pool.query('UPDATE users SET credits = credits - $1 WHERE id=$2', [valor, userId]);
    return;
  }
  await pool.query('UPDATE faturas SET valor = valor + $1 WHERE id=$2', [valor, fatura.id]);
}

// Estorno de uma consulta — o espelho do débito. No pós-pago devolve para a
// fatura (nunca abaixo de zero, para um estorno de consulta de ciclo anterior
// não virar crédito na fatura nova).
async function estornarConsulta(userId, amount) {
  const valor = parseFloat(amount);
  if (!(valor > 0)) return;
  const ur = await pool.query('SELECT pos_pago FROM users WHERE id=$1', [userId]);
  if (!ur.rows[0]?.pos_pago) {
    await pool.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [valor, userId]);
    return;
  }
  const fatura = await garantirCicloPosPago(userId);
  if (!fatura) {
    await pool.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [valor, userId]);
    return;
  }
  await pool.query(
    'UPDATE faturas SET valor = GREATEST(0, valor - $1) WHERE id=$2', [valor, fatura.id]
  );
}

// Fecha a fatura aberta ANTES do vencimento para gerar a cobrança: congela o
// valor, para o PIX não ficar defasado se o cliente consultar mais enquanto o
// QR está na tela, e já abre o ciclo seguinte. O vencimento original é mantido
// — pagar adiantado não muda o dia 30.
async function fecharFaturaParaCobranca(userId) {
  const aberta = await garantirCicloPosPago(userId);
  if (!aberta || parseFloat(aberta.valor) <= 0) return null;
  const upd = await pool.query(
    `UPDATE faturas SET status='FECHADA', fechada_em=NOW()
      WHERE id=$1 AND status='ABERTA' RETURNING *`,
    [aberta.id]
  );
  await garantirFaturaAberta(userId, new Date());
  return upd.rows[0] || null;
}

// Fecha uma consulta assíncrona cujo documento acabou de chegar: tira do
// 'aguardando_pdf' e debita se ainda não tiver sido cobrada. Claim atômico —
// dois caminhos concorrentes (cron e clique do usuário, webhook duplicado) não
// fecham nem cobram o mesmo pedido duas vezes. Quem já tem transaction_id foi
// cobrado antes (é o caso do ATPV-e, cobrado no cadastro) e só muda de status.
// Devolve true quando a consulta foi fechada NESTA chamada (estava
// 'aguardando_pdf' e virou 'success') e false quando já estava fechada antes —
// é o que deixa o chamador distinguir "concluiu agora" de "pedido antigo sendo
// mexido de novo na tela".
async function finalizePendingQuery(queryId, userId, descricao) {
  const claimed = await pool.query(
    `UPDATE queries SET status='success' WHERE id=$1 AND status='aguardando_pdf'
     RETURNING amount, transaction_id`,
    [queryId]
  );
  if (!claimed.rows.length) return false;
  // Já cobrada no cadastro (ATPV-e): fechou agora, mas não há débito a fazer.
  if (claimed.rows[0].transaction_id) return true;
  const amount = parseFloat(claimed.rows[0].amount);
  await debitarConsulta(userId, amount);
  const txRow = await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
    [userId, amount, descricao]
  );
  await pool.query('UPDATE queries SET transaction_id=$1 WHERE id=$2', [txRow.rows[0].id, queryId]);
  return true;
}

// Consulta o status atual de uma comunicação de venda no portal (GET
// /api/comunicado-venda/:id — testado direto: o "id" válido para essa rota (e
// para /comunicacao-venda/transmitir/:id) é o "comunicacao_id" de NÍVEL RAIZ do
// JSON devolvido no Inserir, não o comunicacao_id aninhado em "data" — este
// último é de outro sistema interno do portal e devolve 404 aqui). Usado para
// sincronizar o status de comunicações já transmitidas fora do painel (ex.:
// direto no site do portal) e para conferir a situação antes do Cancelar.
async function correlateComunicacaoVenda(comunicacaoId) {
  try {
    const r = await fetch(`${PORTAL_BASE_URL}/api/comunicado-venda/${comunicacaoId}`, {
      headers: { 'chaveAcesso': PORTAL_DESP_KEY },
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) return null;
    return data;
  } catch (e) {
    console.error(`Erro ao consultar comunicação de venda ${comunicacaoId}:`, e.message);
    return null;
  }
}

// Gera (se ainda não houver cache válido) o comprovante em PDF de uma
// comunicação de venda já transmitida/comunicada e cacheia por 7 dias — usado
// tanto pelo botão "Transmitir" quanto pela sincronização automática em
// GET /api/queries. Retorna {token, expiresAt} do cache (novo ou existente).
// Passar meta com _cancelado:true força a regeração do PDF (mesmo token, mesmo
// se já houver cache válido) para o comprovante passar a mostrar "CANCELADA" —
// ver POST /api/queries/:id/comunicacao-venda-cancelar.
async function cacheComunicacaoVendaPdf(queryId, userId, params, meta = null) {
  const cancelada = !!meta?._cancelado;
  const existing = await pool.query(
    `SELECT token, expires_at FROM pdf_cache WHERE query_id=$1 AND expires_at > NOW()`, [queryId]
  );
  if (existing.rows.length && !cancelada) {
    return { token: existing.rows[0].token, expiresAt: existing.rows[0].expires_at };
  }

  const service = SERVICES.find(s => s.id === 'inserir-comunicacao-venda');
  const pdfBuf = await buildComunicacaoVendaPdfBuffer(service, meta, params);

  if (existing.rows.length) {
    await pool.query(`UPDATE pdf_cache SET pdf_data=$1 WHERE query_id=$2`, [pdfBuf.toString('base64'), queryId]);
    return { token: existing.rows[0].token, expiresAt: existing.rows[0].expires_at };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await pool.query(
    `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [queryId, userId, token, pdfBuf.toString('base64'), expiresAt]
  );
  await pool.query(`UPDATE queries SET result_type='pdf' WHERE id=$1`, [queryId]);
  return { token, expiresAt };
}

// Monta e valida o payload de Comunicação de Venda a partir dos params do
// formulário — extraído para função reutilizável entre o Inserir (POST
// /comunicacao-venda) e o Alterar (POST /comunicacao-venda/salvar/:id, mesmo
// formato de corpo exigido pelo portal). Retorna { body } ou { error }.
function buildComunicacaoVendaBody(params) {
  const v    = params?.vendedor  || {};
  const c    = params?.comprador || {};
  const end  = c.endereco        || {};
  const vda  = params?.venda     || {};
  const veic = params?.veiculo   || {};
  const crv  = veic.crv          || {};

  // Regras abaixo replicadas do próprio formulário do PORTAL (montarPayloadDoFormulario
  // / coletarErrosPayload em portaldespachantes.online/comunicacao-venda), inspecionado após o
  // upstream rejeitar payloads estruturalmente corretos — a documentação da API não
  // cobre normalizações (padding) nem alguns campos exigidos.
  const placa    = (veic.placa   || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const renavam  = (veic.renavam || '').replace(/\D/g, '').padStart(11, '0');
  // Aceita CPF (11 dígitos, pessoa física) ou CNPJ (14 dígitos, pessoa jurídica) —
  // confirmado no formulário real: chave computada 'cpf'/'cnpj' conforme tipo_pessoa.
  const vDoc     = (v.cpf || v.cnpj || '').replace(/\D/g, '');
  const cDoc     = (c.cpf || c.cnpj || '').replace(/\D/g, '');
  const cep      = (end.cep || '').replace(/\D/g, '');
  const numeroResidencia = (end.numero || '').replace(/\D/g, '');
  const codigoSeguranca  = (crv.codigo_seguranca || '').replace(/\D/g, '');
  const numeroCrvRaw = (crv.numero || '').replace(/\D/g, '');
  const numeroCrv = (numeroCrvRaw.length >= 9 && numeroCrvRaw.length <= 12) ? numeroCrvRaw.padStart(12, '0') : numeroCrvRaw;
  const numeroVia       = parseInt(crv.numero_via, 10);
  const cidadeComprador = parseInt(end.cidade, 10);
  // Não documentados em nenhum exemplo da API, mas exigidos pelo validador
  // upstream — confirmado via log de erro real: campos "veiculo.ano_fabricacao"
  // e "veiculo.ano_modelo" listados em details.campos de um HTTP 422.
  const anoFabricacao = parseInt(veic.ano_fabricacao, 10);
  const anoModelo      = parseInt(veic.ano_modelo, 10);
  const valorStr = String(vda.valor ?? '').trim();
  const valor    = valorStr.includes(',')
    ? parseFloat(valorStr.replace(/\./g, '').replace(',', '.'))
    : parseFloat(valorStr);

  if (placa.length !== 7)                        return { error: 'Placa do veículo inválida. Deve ter 7 caracteres (sem hífen).' };
  if (renavam.length !== 11)                      return { error: 'Renavam inválido. Deve ter até 11 dígitos.' };
  if (!Number.isInteger(anoFabricacao) || anoFabricacao < 1950) return { error: 'Ano de fabricação do veículo inválido.' };
  if (!Number.isInteger(anoModelo) || anoModelo < 1950)          return { error: 'Ano do modelo do veículo inválido.' };
  if (vDoc.length !== 11 && vDoc.length !== 14)   return { error: 'CPF/CNPJ do vendedor inválido. Informe 11 dígitos (CPF) ou 14 dígitos (CNPJ).' };
  if (cDoc.length !== 11 && cDoc.length !== 14)   return { error: 'CPF/CNPJ do comprador inválido. Informe 11 dígitos (CPF) ou 14 dígitos (CNPJ).' };
  if (!v.nome?.trim())                            return { error: 'Informe o nome do vendedor.' };
  if (!c.nome?.trim())                            return { error: 'Informe o nome do comprador.' };
  if (cep.length !== 8)                            return { error: 'CEP inválido. Deve ter 8 dígitos.' };
  if (!numeroResidencia || numeroResidencia.length > 6) return { error: 'Número do endereço do comprador inválido. Use só dígitos (máx. 6).' };
  if (Number.isNaN(cidadeComprador) || cidadeComprador <= 0) return { error: 'Código IBGE da cidade do comprador inválido.' };
  if (Number.isNaN(valor) || valor <= 0)          return { error: 'Valor da venda inválido.' };
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(vda.data || '')) return { error: 'Data da venda inválida. Use o formato DD/MM/AAAA.' };
  if (!Number.isInteger(numeroVia) || numeroVia < 1) return { error: 'Número da via do CRV inválido.' };
  if (numeroCrvRaw.length < 9 || numeroCrvRaw.length > 12) return { error: 'Número do CRV deve ter de 9 a 12 dígitos.' };
  if (codigoSeguranca.length !== 11)              return { error: 'Código de segurança do CRV deve ter 11 dígitos.' };
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(crv.data_emissao || '')) return { error: 'Data de emissão do CRV inválida. Use o formato DD/MM/AAAA.' };

  const vendedorPayload = vDoc.length === 14
    ? { tipo_pessoa: 'J', cnpj: vDoc, nome: v.nome.trim().toUpperCase() }
    : { tipo_pessoa: 'F', cpf: vDoc, nome: v.nome.trim().toUpperCase() };
  const compradorPayload = cDoc.length === 14
    ? { tipo_pessoa: 'J', cnpj: cDoc, nome: c.nome.trim().toUpperCase() }
    : { tipo_pessoa: 'F', cpf: cDoc, nome: c.nome.trim().toUpperCase() };

  // O ViaCEP às vezes devolve bairro/logradouro com parênteses (ex.: "Paracatu
  // (Morro Grande)"); removemos e uppercase para bater com o formulário real.
  const sanitizeAddr = s => (s || '').replace(/[()]/g, ' ').replace(/\s{2,}/g, ' ').trim().toUpperCase();

  const body = {
    vendedor: vendedorPayload,
    comprador: {
      ...compradorPayload,
      endereco: {
        cep, logradouro: sanitizeAddr(end.logradouro), numero: numeroResidencia,
        bairro: sanitizeAddr(end.bairro), complemento: sanitizeAddr(end.complemento),
        cidade: cidadeComprador,
      },
    },
    venda: {
      cidade: cidadeComprador, data: vda.data, valor,
      comprador_solicitante: 'S',
    },
    veiculo: {
      placa, renavam,
      ano_fabricacao: anoFabricacao, ano_modelo: anoModelo,
      crv: {
        numero: numeroCrv, codigo_seguranca: codigoSeguranca,
        numero_via: numeroVia, data_emissao: crv.data_emissao,
        uf_emissao: (crv.uf_emissao || '').trim().toUpperCase(),
      },
    },
  };
  return { body };
}

// Botão "Alterar" de "Meus Comunicados de Venda" — corrige uma comunicação
// ainda "importada" (não transmitida) direto no portal (POST
// /comunicacao-venda/salvar/:id, mesmo "comunicacao_id" usado no Transmitir),
// sem precisar abrir o site do portal manualmente. Reenvia o payload
// completo (a portal substitui o registro inteiro) e, em caso de sucesso,
// atualiza os params salvos localmente para refletir a correção no painel.
// Sem custo adicional — mesma lógica do Transmitir.
app.post('/api/queries/:id/comunicacao-venda-alterar', requireAuth, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT id, service_id, result_data FROM queries WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!qr.rows.length || qr.rows[0].service_id !== 'inserir-comunicacao-venda')
      return res.status(404).json({ error: 'Comunicação de venda não encontrada.' });

    let meta = {};
    try { meta = JSON.parse(qr.rows[0].result_data || '{}'); } catch {}
    if (meta._transmitido) return res.status(400).json({ error: 'Esta comunicação já foi transmitida e não pode mais ser alterada por aqui.' });
    if (meta._cancelado) return res.status(400).json({ error: 'Esta comunicação foi cancelada.' });
    const comunicacaoId = meta.comunicacao_id;
    if (!comunicacaoId)
      return res.status(400).json({ error: 'Esta comunicação ainda não tem um identificador do portal vinculado. Tente novamente em alguns instantes.' });

    const built = buildComunicacaoVendaBody(req.body || {});
    if (built.error) return res.status(400).json({ error: built.error });

    const upRes = await fetch(`${PORTAL_BASE_URL}/comunicacao-venda/salvar/${comunicacaoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY },
      body: JSON.stringify(built.body),
    });
    const upData = await upRes.json().catch(() => null);
    if (!upRes.ok) {
      const errMsg = upData?.error || upData?.erro || `Erro HTTP ${upRes.status}.`;
      return res.status(upRes.status).json({ error: errMsg });
    }

    await pool.query('UPDATE queries SET params=$1 WHERE id=$2', [JSON.stringify(req.body || {}), qr.rows[0].id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao alterar comunicação de venda:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Botão "Transmitir" de "Meus Comunicados de Venda" — finaliza no portal uma
// comunicação já inserida (situação inicial "importado" → "comunicado"; sem
// transmitir, a comunicação de venda não é considerada concluída). Usa o
// "comunicacao_id" salvo em result_data no momento do Inserir Comunicação
// Venda (ver resultData em /api/query). Sem custo adicional: a cobrança já
// ocorreu no Inserir.
app.post('/api/queries/:id/comunicacao-venda-transmitir', requireAuth, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT id, service_id, result_data, params FROM queries WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!qr.rows.length || qr.rows[0].service_id !== 'inserir-comunicacao-venda')
      return res.status(404).json({ error: 'Comunicação de venda não encontrada.' });

    let meta = {};
    try { meta = JSON.parse(qr.rows[0].result_data || '{}'); } catch {}
    const comunicacaoId = meta.comunicacao_id;
    if (!comunicacaoId)
      return res.status(400).json({ error: 'Esta comunicação ainda não tem um identificador do portal vinculado. Tente novamente em alguns instantes.' });

    const upRes = await fetch(`${PORTAL_BASE_URL}/comunicacao-venda/transmitir/${comunicacaoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY },
      body: JSON.stringify({}),
    });
    const upData = await upRes.json().catch(() => null);

    if (!upRes.ok) {
      const errMsg = upData?.error || upData?.erro || `Erro HTTP ${upRes.status}.`;
      return res.status(upRes.status).json({ error: errMsg });
    }

    // O nome do campo de situação na resposta do portal não é documentado/estável
    // o suficiente para o painel confiar nele para esconder o botão "Transmitir" —
    // marca um flag próprio, garantido, para não permitir transmitir de novo.
    const merged = { ...meta, ...(upData || {}), _transmitido: true };
    await pool.query('UPDATE queries SET result_data=$1 WHERE id=$2', [JSON.stringify(merged), qr.rows[0].id]);

    // Só agora (comunicação já "comunicada" no portal) gera o comprovante em PDF
    // e cacheia por 7 dias — antes da transmissão o botão "PDF" fica indisponível
    // em "Meus Comunicados de Venda" (ver renderMeusComunicadosVenda).
    try {
      let params = {};
      try { params = JSON.parse(qr.rows[0].params || '{}'); } catch {}
      await cacheComunicacaoVendaPdf(qr.rows[0].id, req.user.id, params);
    } catch (e) {
      console.error('Erro ao gerar/cachear PDF da comunicação de venda transmitida:', e.message);
    }

    res.json({ success: true, result: merged });
  } catch (err) {
    console.error('Erro ao transmitir comunicação de venda:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// GET /api/queries/:id/comunicacao-venda-motivos — busca no portal os motivos
// de cancelamento disponíveis para uma comunicação já transmitida (mesma
// tarifa do serviço avulso "Motivos de Cancelamento" no catálogo). Usado para
// popular a escolha antes de confirmar o Cancelar em "Meus Comunicados de Venda".
app.get('/api/queries/:id/comunicacao-venda-motivos', requireAuth, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT result_data FROM queries WHERE id=$1 AND user_id=$2 AND service_id='inserir-comunicacao-venda'`,
      [req.params.id, req.user.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Comunicação de venda não encontrada.' });

    let meta = {};
    try { meta = JSON.parse(qr.rows[0].result_data || '{}'); } catch {}
    if (!meta._transmitido) return res.status(400).json({ error: 'Esta comunicação ainda não foi transmitida.' });
    if (meta._cancelado) return res.status(400).json({ error: 'Esta comunicação já foi cancelada.' });
    const protocolo = meta.protocolo;
    if (!protocolo) return res.status(400).json({ error: 'Protocolo não encontrado para esta comunicação.' });

    const svc = SERVICES.find(s => s.id === 'motivos-cancelamento');
    const price = await getUserServicePrice(req.user.id, svc);
    const ur = await pool.query('SELECT id, credits, active, pos_pago, pos_pago_limite FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    const bloqueio = await bloqueioPagamentoConsulta(user.id, user, price);
    if (bloqueio) return res.status(bloqueio.status).json(bloqueio.body);

    const upRes = await fetch(`${PORTAL_BASE_URL}/motivos-cancelamento/${protocolo}`, {
      headers: { 'chaveAcesso': PORTAL_DESP_KEY },
    });
    const upData = await upRes.json().catch(() => null);
    if (!upRes.ok || !Array.isArray(upData?.motivos))
      return res.status(502).json({ error: upData?.error || 'Erro ao buscar motivos de cancelamento.' });

    await debitarConsulta(req.user.id, price);
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3)`,
      [req.user.id, price, 'Consulta: Motivos de Cancelamento']
    );
    res.json({ success: true, motivos: upData.motivos, charged: price });
  } catch (err) {
    console.error('Erro ao buscar motivos de cancelamento:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// POST /api/queries/:id/comunicacao-venda-cancelar — cancela no portal uma
// comunicação já transmitida (mesma tarifa do serviço avulso "Cancelar
// Comunicação Venda" no catálogo). Ação irreversível no portal.
app.post('/api/queries/:id/comunicacao-venda-cancelar', requireAuth, async (req, res) => {
  try {
    const idMotivo = parseInt(req.body?.id_motivo_cancelamento, 10);
    if (!Number.isInteger(idMotivo) || idMotivo <= 0)
      return res.status(400).json({ error: 'Informe o motivo do cancelamento.' });

    const qr = await pool.query(
      `SELECT result_data, params FROM queries WHERE id=$1 AND user_id=$2 AND service_id='inserir-comunicacao-venda'`,
      [req.params.id, req.user.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Comunicação de venda não encontrada.' });

    let meta = {};
    try { meta = JSON.parse(qr.rows[0].result_data || '{}'); } catch {}
    if (!meta._transmitido) return res.status(400).json({ error: 'Esta comunicação ainda não foi transmitida.' });
    if (meta._cancelado) return res.status(400).json({ error: 'Esta comunicação já foi cancelada.' });
    const comunicacaoId = meta.comunicacao_id;
    const protocolo = meta.protocolo;
    if (!comunicacaoId || !protocolo)
      return res.status(400).json({ error: 'Identificador ou protocolo da comunicação não encontrado.' });

    const svc = SERVICES.find(s => s.id === 'cancelar-comunicacao-venda');
    const price = await getUserServicePrice(req.user.id, svc);
    const ur = await pool.query('SELECT id, credits, active, pos_pago, pos_pago_limite FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    const bloqueio = await bloqueioPagamentoConsulta(user.id, user, price);
    if (bloqueio) return res.status(bloqueio.status).json(bloqueio.body);

    const upRes = await fetch(`${PORTAL_BASE_URL}/cancelar-comunicacao-venda`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY },
      body: JSON.stringify({ id: comunicacaoId, protocolo, id_motivo_cancelamento: idMotivo }),
    });
    const upData = await upRes.json().catch(() => null);

    // Bug visto em produção: a portal confirmava o cancelamento (ação irreversível
    // lá, cobrança já efetuada aqui) mas o painel continuava mostrando "Comunicado"
    // pra sempre. Em vez de confiar cegamente em upRes.ok, reconfere o status real
    // no portal sempre que a resposta local não vier "ok" — algumas vezes o
    // cancelamento é aceito lá mesmo com uma resposta de erro aqui.
    let confirmedCancelado = upRes.ok;
    let statusData = upData;
    if (!confirmedCancelado) {
      const check = await correlateComunicacaoVenda(comunicacaoId).catch(() => null);
      if (check?.status === 'cancelado') { confirmedCancelado = true; statusData = check; }
    }
    if (!confirmedCancelado) {
      const errMsg = upData?.error || upData?.erro || `Erro HTTP ${upRes.status}.`;
      return res.status(upRes.status).json({ error: errMsg });
    }

    // Grava o status ANTES de cobrar: se a cobrança falhar depois, o pior cenário
    // é não cobrar a tarifa — nunca mais deixar a tarifa cobrada com o status do
    // painel desatualizado (era exatamente essa a ordem que causava o bug acima).
    const merged = { ...meta, ...(statusData || {}), _cancelado: true };
    await pool.query('UPDATE queries SET result_data=$1 WHERE id=$2', [JSON.stringify(merged), qr.rows[0].id]);

    // Regera o comprovante em PDF já cacheado (mesmo token) pra passar a mostrar
    // "CANCELADA" — best effort: uma falha aqui não deve impedir o cancelamento,
    // que já está confirmado e gravado acima.
    try {
      let params = {};
      try { params = JSON.parse(qr.rows[0].params || '{}'); } catch {}
      await cacheComunicacaoVendaPdf(qr.rows[0].id, req.user.id, params, merged);
    } catch (e) {
      console.error(`Erro ao regerar PDF cancelado da comunicação de venda [query ${qr.rows[0].id}]:`, e.message);
    }

    await debitarConsulta(req.user.id, price);
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3)`,
      [req.user.id, price, 'Consulta: Cancelar Comunicação Venda']
    );
    res.json({ success: true, result: merged });
  } catch (err) {
    console.error('Erro ao cancelar comunicação de venda:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Preço efetivo de um serviço do catálogo "Nova Consulta" para um usuário
// específico: usa o valor fixo cadastrado em user_service_prices quando existe
// (ver rotas /api/admin/users/:id/service-prices), senão cai no cálculo padrão
// (basePrice + markup, ou basePrice puro quando noMarkup).
async function getUserServicePrice(userId, service) {
  // Grupo gratuito (ver FREE_SERVICE_GROUPS) nunca cobra — nem por preço fixo
  // cadastrado antes de o grupo virar cortesia.
  if (isFreeService(service)) return 0;
  const r = await pool.query(
    'SELECT price FROM user_service_prices WHERE user_id=$1 AND service_id=$2',
    [userId, service.id]
  );
  if (r.rows.length) return parseFloat(r.rows[0].price);
  return catalogPrice(service);
}

// Estorna os créditos de uma consulta que foi cobrada mas nunca entregou o
// resultado (ex.: PDF assíncrono do CRLV-e Agendado que nunca ficou pronto
// dentro do prazo). Idempotente:
// o guard "status <> 'estornado'" no UPDATE garante que só credita de volta
// uma vez mesmo se o cron rodar em cima da mesma query mais de uma vez.
async function refundQuery(queryId, userId, amount, reason) {
  if (!queryId || !userId || !(amount > 0)) return false;
  const marked = await pool.query(
    `UPDATE queries SET status='estornado' WHERE id=$1 AND status <> 'estornado' RETURNING id`,
    [queryId]
  );
  if (!marked.rows.length) return false;
  await estornarConsulta(userId, amount);
  await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'refund',$2,$3)`,
    [userId, amount, `Estorno: ${reason}`]
  );
  return true;
}

// Núcleo do catálogo "Nova Consulta" — extraído para função reutilizável (em
// vez de ler req.user.id/req.body direto) para poder ser chamado tanto pelo
// painel (cookie JWT, ver app.post('/api/query') abaixo) quanto pela API
// externa de chave (ver app.post('/api/v1/:serviceId')), debitando sempre o
// userId explícito recebido — no painel é req.user.id, na API é o dono da
// chave (req.apiUser.id).
// ── Assinatura Coisas de Despachantes — vigência e cota ──────────────────────
// Assinatura vigente = período pago que ainda não venceu. A vigência NUNCA é
// decidida pelo campo "status" (o cron só o atualiza de tempos em tempos, e
// entre duas execuções ele fica desatualizado) — a verdade é sempre expires_at.
// expires_at NULL = liberação sem data limite (cortesia do admin), por isso
// entra no filtro e vem primeiro na ordenação: se o usuário tiver as duas
// coisas, a indefinida é a que vale.
async function getAssinaturaVigente(userId) {
  const r = await pool.query(
    `SELECT id, expires_at, queries_used, cota, queries_used_crv, cota_crv,
            queries_used_assinatura, cota_assinatura,
            queries_used_verificar_crlv, cota_verificar_crlv, origem FROM subscriptions
     WHERE user_id=$1 AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at DESC NULLS FIRST LIMIT 1`,
    [userId]
  );
  return r.rows[0] || null;
}

// Porteiro dos serviços do grupo "Para os Despachantes". Devolve o motivo do
// bloqueio junto com o code, para o painel abrir o popup certo (assinar x cota
// esgotada) em vez de mostrar um erro genérico.
async function assinaturaGateDespachantes(userId, serviceId) {
  if (!ASSINATURA_SERVICE_IDS.includes(serviceId)) return { ok: true, assinatura: null };

  // A cota da Assinatura Digital entra na mesma leitura de assinatura vigente
  // abaixo; a checagem dela fica logo depois das outras duas.
  const assinatura = await getAssinaturaVigente(userId);
  if (!assinatura) {
    return {
      ok: false,
      code: 'ASSINATURA_NECESSARIA',
      error: 'Esta consulta só está liberada como Gratuita, se você tem assinatura: "Assinatura Coisas de Despachantes", clique no botão assinar e pague com pix.',
    };
  }

  // cota NULL = ilimitada (liberação manual do admin sem teto).
  if (serviceId === ASSINATURA_PLACAS_SERVICE_ID &&
      assinatura.cota !== null && assinatura.queries_used >= assinatura.cota) {
    return {
      ok: false,
      code: 'COTA_ESGOTADA',
      error: `Você já usou as ${assinatura.cota} consultas de placa deste período da assinatura. A cota é renovada ao pagar um novo período.`,
    };
  }
  // Cota do Código de Segurança CRV é independente da de placas — esgotar uma
  // não bloqueia a outra.
  if (serviceId === ASSINATURA_CRV_SERVICE_ID &&
      assinatura.cota_crv !== null && assinatura.queries_used_crv >= assinatura.cota_crv) {
    return {
      ok: false,
      code: 'COTA_ESGOTADA',
      error: `Você já usou as ${assinatura.cota_crv} consultas de Código de Segurança CRV deste período da assinatura. A cota é renovada ao pagar um novo período.`,
    };
  }
  // Cota da Assinatura Digital, também independente das outras duas.
  if (serviceId === ASSINATURA_DIGITAL_SERVICE_ID &&
      assinatura.cota_assinatura !== null && assinatura.queries_used_assinatura >= assinatura.cota_assinatura) {
    return {
      ok: false,
      code: 'COTA_ESGOTADA',
      error: `Você já usou os ${assinatura.cota_assinatura} envios de Assinatura Digital deste período da assinatura. A cota é renovada ao pagar um novo período.`,
    };
  }
  // Cota do Verificar CRLV + Data CRV, independente das outras três.
  if (serviceId === ASSINATURA_VERIFICAR_CRLV_SERVICE_ID &&
      assinatura.cota_verificar_crlv !== null &&
      assinatura.queries_used_verificar_crlv >= assinatura.cota_verificar_crlv) {
    return {
      ok: false,
      code: 'COTA_ESGOTADA',
      error: `Você já usou as ${assinatura.cota_verificar_crlv} consultas de Verificar CRLV + Data CRV deste período da assinatura. A cota é renovada ao pagar um novo período.`,
    };
  }
  return { ok: true, assinatura };
}

async function processCatalogQuery(userId, serviceId, params, res) {
  if (!serviceId) return res.status(400).json({ error: 'Serviço não informado.' });

  const service = SERVICES.find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });

  // Serviço temporariamente suspenso (ver flag "unavailable" no catálogo) — bloqueia
  // antes de qualquer débito ou chamada à API upstream. Cobre tanto o catálogo normal
  // quanto a API externa (ambos passam por processCatalogQuery).
  if (service.unavailable)
    return res.status(400).json({ error: service.slowNote || 'Consulta temporariamente indisponível.' });

  const price = await getUserServicePrice(userId, service);

  try {
    const ur = await pool.query(
      'SELECT id, credits, active, phone, name, email, pos_pago, pos_pago_limite FROM users WHERE id=$1', [userId]
    );
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    const bloqueio = await bloqueioPagamentoConsulta(user.id, user, price);
    if (bloqueio) return res.status(bloqueio.status).json(bloqueio.body);

    // ── Paywall da aba "Coisas de Despachantes" ──
    // Estes serviços não debitam crédito, mas exigem assinatura vigente. A
    // checagem vem aqui, antes de qualquer chamada upstream, para nenhum
    // serviço do grupo rodar de graça. O "code" volta para o painel abrir o
    // popup certo (assinar x cota esgotada).
    const gate = await assinaturaGateDespachantes(userId, serviceId);
    if (!gate.ok) return res.status(402).json({ error: gate.error, code: gate.code });

    // ── Assinatura Digital (Assinafy) ─────────────────────────────────────────
    // Não gera documento nem consulta nada: manda um PDF que o cliente já tem
    // para alguém assinar. Sai do fluxo comum porque são três chamadas
    // encadeadas (documento → signatário → pedido de assinatura) e porque o
    // resultado — o PDF assinado — só existe depois que o signatário assina.
    if (serviceId === ASSINATURA_DIGITAL_SERVICE_ID) {
      const nome     = String(params?.nome || '').trim();
      const email    = String(params?.email || '').trim().toLowerCase();
      const whatsRaw = String(params?.whatsapp || '').replace(/\D/g, '');
      const nomeArquivo = String(params?.nomeArquivo || '').trim() || 'documento.pdf';

      if (nome.length < 3)
        return res.status(400).json({ error: 'Informe o nome completo de quem vai assinar.' });
      if (!email && !whatsRaw)
        return res.status(400).json({ error: 'Informe o e-mail ou o WhatsApp de quem vai assinar — é por onde o pedido de assinatura chega.' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
        return res.status(400).json({ error: 'E-mail do signatário inválido.' });
      // A Assinafy espera E.164; o painel manda só os dígitos brasileiros.
      let whatsapp = '';
      if (whatsRaw) {
        if (whatsRaw.length < 10 || whatsRaw.length > 13)
          return res.status(400).json({ error: 'WhatsApp do signatário inválido. Informe DDD + número (ex.: 22999951574).' });
        whatsapp = '+' + (whatsRaw.length >= 12 ? whatsRaw : `55${whatsRaw}`);
      }

      const b64 = String(params?.arquivoBase64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (!b64) return res.status(400).json({ error: 'Anexe o PDF que será assinado.' });
      if (Math.floor(b64.length * 3 / 4) > 10 * 1024 * 1024)
        return res.status(400).json({ error: 'O PDF passa de 10 MB. Reduza o arquivo e tente de novo.' });
      let pdfBuffer;
      try { pdfBuffer = Buffer.from(b64, 'base64'); } catch { pdfBuffer = null; }
      if (!pdfBuffer || pdfBuffer.slice(0, 4).toString() !== '%PDF')
        return res.status(400).json({ error: 'O arquivo anexado não é um PDF válido. Selecione o arquivo novamente.' });

      let envio;
      try {
        envio = await enviarParaAssinaturaAssinafy({ pdfBuffer, nomeArquivo, nome, email, whatsapp });
      } catch (e) {
        // Nada de cota consumida: o pedido não chegou a ser criado.
        console.error(`[${serviceId}] falha ao enviar para assinatura:`, e.message);
        return res.status(422).json({ error: 'Não foi possível enviar o documento para assinatura agora. Nada foi descontado da sua cota. Tente de novo em instantes ou fale com o suporte.' });
      }

      // Cota consumida só com o pedido criado, e de forma atômica (o WHERE
      // impede dois envios simultâneos de furarem o teto do período).
      const cota = await pool.query(
        `UPDATE subscriptions SET queries_used_assinatura = queries_used_assinatura + 1
         WHERE id=$1 AND (cota_assinatura IS NULL OR queries_used_assinatura < cota_assinatura)
         RETURNING queries_used_assinatura`,
        [gate.assinatura.id]
      );
      if (!cota.rows.length)
        return res.status(402).json({
          error: `Você já usou os ${gate.assinatura.cota_assinatura} envios de Assinatura Digital deste período da assinatura.`,
          code: 'COTA_ESGOTADA',
        });

      // amount 0 e sem transaction_id: quem paga este envio é a assinatura.
      // 'aguardando_pdf' é o mesmo status dos assíncronos — o painel já sabe
      // mostrar que o documento ainda não chegou.
      const destino = email || `WhatsApp ${whatsRaw}`;
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, result_type, result_data)
         VALUES ($1,$2,$3,$4,'aguardando_pdf',0,'pdf',$5) RETURNING id`,
        [userId, serviceId, service.name,
         JSON.stringify({ nomeArquivo, signatario: nome, destino }),
         JSON.stringify({ documentId: envio.documentId, signatario: nome, destino, nomeArquivo })]
      );
      await pool.query(
        `INSERT INTO assinafy_pending (document_id, query_id, user_id, phone, nome_arquivo, signatario)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (document_id) DO NOTHING`,
        [envio.documentId, qRow.rows[0].id, userId, user.phone || null, nomeArquivo, nome]
      );

      return res.json({
        success: true,
        pending: true,
        queryId: qRow.rows[0].id,
        result: {
          status: `Documento enviado para assinatura! ${nome} vai receber o pedido em ${destino}. Assim que o documento for assinado, ele aparece aqui no seu histórico e chega no seu WhatsApp.`,
          documento: nomeArquivo,
          signatario: nome,
          enviado_para: destino,
          protocolo: envio.documentId,
        },
        charged: 0,
      });
    }

    // ── Serviços manuais (upload de arquivo pelo super admin — resultado não vem na hora) ──
    if (MANUAL_SERVICE_IDS.includes(serviceId)) {
      await debitarConsulta(userId, price);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [userId, price, `Consulta: ${service.name}`]
      );
      await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'pendente',$5,$6,'pdf') RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id]
      );

      await notifyAdminNewQuery(user, service, price, params);
      return res.json({
        success: true,
        pending: true,
        result: { status: 'Pedido registrado! Nossa equipe vai localizar o documento e o PDF ficará disponível para download aqui no seu painel.' },
        charged: price,
      });
    }

    // ── Gerar Declaração de Residência DETRAN RJ — não chama nenhuma API upstream
    // aqui: os campos já chegam prontos do formulário (pré-preenchido via POST
    // /api/declaracao-residencia/localizar e conferido/editado pelo usuário), então
    // só validamos, sobrepomos no template oficial e cobramos — sem round-trip
    // extra à Datacube nesta etapa (ver buildDeclaracaoResidenciaPdfBuffer).
    if (serviceId === 'declaracao-residencia-detran-rj') {
      const nome = (params?.nome || '').trim();
      const cpfDigits = (params?.cpf || '').replace(/\D/g, '');
      const endereco = (params?.endereco || '').trim();
      const cepDigits = (params?.cep || '').replace(/\D/g, '');
      const uf = (params?.uf || '').trim();
      const cidade = (params?.cidade || '').trim();
      if (!nome) return res.status(400).json({ error: 'Informe o nome.' });
      if (cpfDigits.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
      if (!endereco) return res.status(400).json({ error: 'Informe o endereço.' });
      if (cepDigits.length !== 8) return res.status(400).json({ error: 'CEP inválido. Deve ter 8 dígitos.' });
      if (!uf) return res.status(400).json({ error: 'Informe a UF.' });
      if (!cidade) return res.status(400).json({ error: 'Informe a cidade.' });

      let pdfBuf;
      try {
        pdfBuf = await buildDeclaracaoResidenciaPdfBuffer({
          ...params,
          cpf: cpfDigits,
          cep: cepDigits.replace(/(\d{5})(\d{3})/, '$1-$2'),
        });
      } catch (e) {
        console.error('[declaracao-residencia-detran-rj] erro ao gerar PDF:', e.message);
        return res.status(500).json({ error: 'Erro ao gerar a declaração.' });
      }

      await debitarConsulta(userId, price);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [userId, price, `Consulta: ${service.name}`]
      );
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'success',$5,$6,'pdf') RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      await notifyAdminNewQuery(user, service, price, params);

      if (user.phone) {
        const caption = `✅ *${service.name} pronta!*\n👤 ${nome}\n🪪 CPF: ${maskDocDisplay(cpfDigits)}\n\nDocumento gerado pela MC Despachadoria.`;
        await sendWhatsAppPdf(user.phone, pdfBuf, `declaracao-residencia-${cpfDigits}.pdf`, caption).catch(() => {});
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="declaracao-residencia-${Date.now()}.pdf"`);
      return res.send(pdfBuf);
    }

    // ── Gerar Contrato de Aluguel — mesmo padrão da Declaração de Residência
    // acima: os nomes de Locador/Locatário já chegam prontos do formulário
    // (pré-preenchidos via POST /api/contrato-aluguel/localizar e conferidos/
    // editados pelo usuário), então só validamos, montamos o contrato do zero
    // (ver buildContratoAluguelPdfBuffer) e cobramos.
    if (serviceId === 'contrato-aluguel') {
      const tipo = (params?.tipo || '').trim();
      const locadorNome = (params?.locadorNome || '').trim();
      const locadorCpfCnpj = (params?.locadorCpfCnpj || '').replace(/\D/g, '');
      const locatarioNome = (params?.locatarioNome || '').trim();
      const locatarioCpfCnpj = (params?.locatarioCpfCnpj || '').replace(/\D/g, '');
      const enderecoLocacao = (params?.enderecoLocacao || '').trim();
      const dataInicio = (params?.dataInicio || '').trim();
      const dataFim = (params?.dataFim || '').trim();
      const valorAluguel = parseFloat(String(params?.valorAluguel || '').replace(',', '.'));

      if (tipo !== 'residencial' && tipo !== 'comercial')
        return res.status(400).json({ error: 'Selecione o tipo de contrato (Residencial ou Comercial).' });
      if (!locadorNome) return res.status(400).json({ error: 'Informe o nome do Locador.' });
      if (locadorCpfCnpj.length !== 11 && locadorCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Locador inválido.' });
      if (!locatarioNome) return res.status(400).json({ error: 'Informe o nome do Locatário.' });
      if (locatarioCpfCnpj.length !== 11 && locatarioCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Locatário inválido.' });
      if (!enderecoLocacao) return res.status(400).json({ error: 'Informe o endereço do imóvel locado.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicio)) return res.status(400).json({ error: 'Data de início inválida.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataFim)) return res.status(400).json({ error: 'Data de término inválida.' });
      if (dataFim <= dataInicio) return res.status(400).json({ error: 'A data de término deve ser posterior à data de início.' });
      if (!(valorAluguel > 0)) return res.status(400).json({ error: 'Informe um valor de aluguel válido.' });

      let pdfBuf;
      try {
        pdfBuf = await buildContratoAluguelPdfBuffer({
          tipo, locadorNome, locadorCpfCnpj, locatarioNome, locatarioCpfCnpj,
          enderecoLocacao, dataInicio, dataFim, valorAluguel,
        });
      } catch (e) {
        console.error('[contrato-aluguel] erro ao gerar PDF:', e.message);
        return res.status(500).json({ error: 'Erro ao gerar o contrato.' });
      }

      await debitarConsulta(userId, price);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [userId, price, `Consulta: ${service.name}`]
      );
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'success',$5,$6,'pdf') RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      await notifyAdminNewQuery(user, service, price, params);

      if (user.phone) {
        const caption = `✅ *${service.name} pronto!*\n🏠 Locatário: ${locatarioNome}\n🧾 Locador: ${locadorNome}\n\nDocumento gerado pela MC Despachadoria.`;
        await sendWhatsAppPdf(user.phone, pdfBuf, `contrato-aluguel-${Date.now()}.pdf`, caption).catch(() => {});
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="contrato-aluguel-${Date.now()}.pdf"`);
      return res.send(pdfBuf);
    }

    // ── Gerar Procuração Veicular — mesmo padrão acima: os campos já chegam
    // prontos do formulário (Outorgante e dados do veículo pré-preenchidos via
    // POST /api/procuracao-veicular/localizar-placa, Outorgado via
    // /localizar-cpf, todos conferidos/editados pelo usuário), então só
    // validamos, montamos a procuração do zero (ver
    // buildProcuracaoVeicularPdfBuffer) e cobramos.
    if (serviceId === 'procuracao-veicular') {
      const outorganteNome = (params?.outorganteNome || '').trim();
      const outorganteCpfCnpj = (params?.outorganteCpfCnpj || '').replace(/\D/g, '');
      const outorganteEndereco = (params?.outorganteEndereco || '').trim();
      const outorgadoNome = (params?.outorgadoNome || '').trim();
      const outorgadoCpfCnpj = (params?.outorgadoCpfCnpj || '').replace(/\D/g, '');
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      const marcaModelo = (params?.marcaModelo || '').trim();
      const chassi = (params?.chassi || '').trim();
      const renavam = (params?.renavam || '').trim();
      const cor = (params?.cor || '').trim();
      const anoFabricacao = (params?.anoFabricacao || '').trim();
      const anoModelo = (params?.anoModelo || '').trim();

      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      if (!outorganteNome) return res.status(400).json({ error: 'Informe o nome do Outorgante.' });
      if (outorganteCpfCnpj.length !== 11 && outorganteCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Outorgante inválido.' });
      if (outorgadoCpfCnpj.length !== 11 && outorgadoCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Outorgado inválido.' });
      if (!outorgadoNome) return res.status(400).json({ error: 'Informe o nome do Outorgado.' });

      let pdfBuf;
      try {
        pdfBuf = await buildProcuracaoVeicularPdfBuffer({
          outorganteNome, outorganteCpfCnpj, outorganteEndereco, outorgadoNome, outorgadoCpfCnpj,
          placa, marcaModelo, chassi, renavam, cor, anoFabricacao, anoModelo,
        });
      } catch (e) {
        console.error('[procuracao-veicular] erro ao gerar PDF:', e.message);
        return res.status(500).json({ error: 'Erro ao gerar a procuração.' });
      }

      await debitarConsulta(userId, price);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [userId, price, `Consulta: ${service.name}`]
      );
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'success',$5,$6,'pdf') RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      await notifyAdminNewQuery(user, service, price, params);

      if (user.phone) {
        const caption = `✅ *${service.name} pronta!*\n🖊️ Outorgante: ${outorganteNome}\n🚗 Placa: ${maskPlacaDisplay(placa)}\n\nDocumento gerado pela MC Despachadoria.`;
        await sendWhatsAppPdf(user.phone, pdfBuf, `procuracao-veicular-${Date.now()}.pdf`, caption).catch(() => {});
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="procuracao-veicular-${Date.now()}.pdf"`);
      return res.send(pdfBuf);
    }

    if (serviceId === 'nota-prestacao-servicos-despachante') {
      const matriculaCrdd = (params?.matriculaCrdd || '').trim();
      const prestadorCpfCnpj = (params?.prestadorCpfCnpj || '').replace(/\D/g, '');
      const prestadorNome = (params?.prestadorNome || '').trim();
      const tomadorCpfCnpj = (params?.tomadorCpfCnpj || '').replace(/\D/g, '');
      const tomadorNome = (params?.tomadorNome || '').trim();
      const discriminacaoServicos = (params?.discriminacaoServicos || '').trim();
      const valorTotal = parseFloat(String(params?.valorTotal || '').replace(',', '.'));

      if (!matriculaCrdd) return res.status(400).json({ error: 'Informe a Matrícula do Despachante (CRDD-UF).' });
      if (prestadorCpfCnpj.length !== 11 && prestadorCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Prestador inválido.' });
      if (!prestadorNome) return res.status(400).json({ error: 'Informe o nome do Prestador de Serviços.' });
      if (tomadorCpfCnpj.length !== 11 && tomadorCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Tomador de Serviços inválido.' });
      if (!tomadorNome) return res.status(400).json({ error: 'Informe o nome do Tomador de Serviços (Cliente).' });
      if (!discriminacaoServicos) return res.status(400).json({ error: 'Informe a discriminação dos serviços prestados.' });
      if (!(valorTotal > 0)) return res.status(400).json({ error: 'Informe um valor total válido.' });

      let pdfBuf;
      try {
        pdfBuf = await buildNotaPrestacaoServicosPdfBuffer({
          matriculaCrdd, prestadorCpfCnpj, prestadorNome, tomadorCpfCnpj, tomadorNome,
          discriminacaoServicos, valorTotal,
        });
      } catch (e) {
        console.error('[nota-prestacao-servicos-despachante] erro ao gerar PDF:', e.message);
        return res.status(500).json({ error: 'Erro ao gerar a nota de prestação de serviços.' });
      }

      await debitarConsulta(userId, price);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [userId, price, `Consulta: ${service.name}`]
      );
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'success',$5,$6,'pdf') RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      await notifyAdminNewQuery(user, service, price, params);

      if (user.phone) {
        const caption = `✅ *${service.name} pronta!*\n🧾 Prestador: ${prestadorNome}\n👤 Tomador: ${tomadorNome}\n💰 Total: ${fmtMoneyBRL(valorTotal)}\n\nDocumento gerado pela MC Despachadoria.`;
        await sendWhatsAppPdf(user.phone, pdfBuf, `nota-prestacao-servicos-${Date.now()}.pdf`, caption).catch(() => {});
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="nota-prestacao-servicos-${Date.now()}.pdf"`);
      return res.send(pdfBuf);
    }

    // ── Gerar ASD (Anotação de Serviço Documental) — mesmo padrão da Procuração
    // Veicular: os campos já chegam prontos do formulário (Profissional e
    // Beneficiário pré-preenchidos via /api/procuracao-veicular/localizar-cpf,
    // Descrição Documental via /localizar-placa, tudo conferido/editado pelo
    // usuário), então só validamos, montamos a ASD do zero (ver
    // buildAsdPdfBuffer) e cobramos. A placa e o anexo da carteirinha são
    // opcionais — nem todo serviço documental é veicular.
    if (serviceId === 'gerar-asd') {
      const servico = (params?.servico || '').trim();
      const uf = (params?.uf || '').trim().toUpperCase();
      const contratante = (params?.contratante || '').trim();
      const profissionalNome = (params?.profissionalNome || '').trim();
      const profissionalCpfCnpj = (params?.profissionalCpfCnpj || '').replace(/\D/g, '');
      const profissionalMatricula = (params?.profissionalMatricula || '').trim();
      const beneficiarioNome = (params?.beneficiarioNome || '').trim();
      const beneficiarioCpfCnpj = (params?.beneficiarioCpfCnpj || '').replace(/\D/g, '');
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      const descricaoDocumental = (params?.descricaoDocumental || '').trim();
      // Demais células do formulário (ver ASD_CAMPOS_OPCIONAIS): todas opcionais,
      // saem em branco quando não vierem — é o comportamento pedido, o papel é
      // completado à mão.
      const asdOpcionais = Object.fromEntries(
        ASD_CAMPOS_OPCIONAIS.map(k => [k, (params?.[k] ?? '').toString().trim()])
      );
      asdOpcionais.dudas = Array.isArray(params?.dudas)
        ? params.dudas.slice(0, 5).map(x => (x ?? '').toString().trim())
        : [];
      // Logo do cabeçalho (menu suspenso do formulário). Vazio = padrão, para
      // pedidos antigos e integrações que não mandam o campo continuarem valendo.
      const logo = (params?.logo || '').trim().toLowerCase() || ASD_LOGO_PADRAO;
      if (!ASD_LOGOS[logo])
        return res.status(400).json({ error: 'Logo da ASD inválido. Escolha uma das opções do menu.' });

      if (!servico) return res.status(400).json({ error: 'Informe o serviço prestado.' });
      if (uf.length !== 2) return res.status(400).json({ error: 'Informe a UF (2 letras).' });
      if (!contratante) return res.status(400).json({ error: 'Informe o nome do Contratante.' });
      if (!profissionalNome) return res.status(400).json({ error: 'Informe o nome do Profissional.' });
      if (profissionalCpfCnpj.length !== 11 && profissionalCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Profissional inválido.' });
      if (!beneficiarioNome) return res.status(400).json({ error: 'Informe o nome do Beneficiário do Serviço.' });
      if (beneficiarioCpfCnpj.length !== 11 && beneficiarioCpfCnpj.length !== 14)
        return res.status(400).json({ error: 'CPF/CNPJ do Beneficiário do Serviço inválido.' });
      if (placa && placa.length !== 7)
        return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23 ou deixe em branco.' });

      // Registra na cadeia ANTES de cobrar: se a gravação do elo falhar, o
      // cliente não paga por uma ASD que não seria verificável. O código e o
      // hash saem impressos no PDF, então o registro precisa vir primeiro.
      const asdCampos = {
        servico, uf, contratante,
        profissionalNome, profissionalCpfCnpj, profissionalMatricula,
        beneficiarioNome, beneficiarioCpfCnpj,
        placa,
        ...asdOpcionais,
        descricaoDocumental,
        carteirinhaFrente: params?.carteirinhaFrente,
        carteirinhaVerso: params?.carteirinhaVerso,
      };
      let registro;
      try {
        registro = await registrarAsdNaCadeia({
          userId, docHash: asdDocHash(asdCampos), servico, uf,
          profNome: profissionalNome, profDoc: profissionalCpfCnpj, profMatricula: profissionalMatricula,
        });
      } catch (e) {
        console.error('[gerar-asd] erro ao registrar na cadeia:', e.message);
        return res.status(500).json({ error: 'Erro ao registrar a ASD. Nenhum crédito foi debitado.' });
      }

      const verificacao = {
        codigo: registro.codigo,
        docHash: registro.docHash,
        seq: registro.seq,
        url: `${ASD_BASE_URL}/verificar-asd/${registro.codigo}`,
        urlCurta: `${ASD_BASE_URL.replace(/^https?:\/\//, '')}/verificar-asd`,
      };
      const qrPng = await generateAsdQrPng(verificacao.url);

      let pdfBuf;
      try {
        pdfBuf = await buildAsdPdfBuffer({
          servico, uf, contratante,
          profissionalNome, profissionalCpfCnpj, profissionalMatricula,
          profissionalTelefone: (params?.profissionalTelefone || '').trim(),
          profissionalEmail: (params?.profissionalEmail || '').trim(),
          beneficiarioNome, beneficiarioCpfCnpj,
          beneficiarioTelefone: (params?.beneficiarioTelefone || '').trim(),
          beneficiarioEmail: (params?.beneficiarioEmail || '').trim(),
          verificacao, qrPng, logo,
          placa,
          ...asdOpcionais,
          descricaoDocumental,
          carteirinhaFrente: params?.carteirinhaFrente,
          carteirinhaVerso: params?.carteirinhaVerso,
        });
      } catch (e) {
        console.error('[gerar-asd] erro ao gerar PDF:', e.message);
        return res.status(500).json({ error: 'Erro ao gerar a ASD.' });
      }

      // As digitalizações da carteirinha são data URLs de alguns MB — guardar
      // isso em queries.params encheria a tabela (e o histórico devolveria o
      // base64 inteiro pro painel). O PDF já está no pdf_cache, então aqui só
      // fica o registro de que houve anexo.
      const paramsToStore = {
        ...(params || {}),
        carteirinhaFrente: params?.carteirinhaFrente ? '[digitalização anexada]' : undefined,
        carteirinhaVerso:  params?.carteirinhaVerso  ? '[digitalização anexada]' : undefined,
      };

      await debitarConsulta(userId, price);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [userId, price, `Consulta: ${service.name}`]
      );
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'success',$5,$6,'pdf') RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(paramsToStore), price, txRow.rows[0].id]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      // Amarra o elo da cadeia à consulta cobrada (o elo é gravado antes, para
      // não cobrar por uma ASD que não seria verificável — ver acima).
      await pool.query('UPDATE asd_registros SET query_id=$1 WHERE id=$2', [qRow.rows[0].id, registro.id])
        .catch(e => console.error('[gerar-asd] erro ao vincular query_id ao registro:', e.message));

      await notifyAdminNewQuery(user, service, price, { placa });

      if (user.phone) {
        const caption = `✅ *${service.name} pronta!*\n📑 Serviço: ${servico}\n👤 Beneficiário: ${beneficiarioNome}` +
          (placa ? `\n🚗 Placa: ${maskPlacaDisplay(placa)}` : '') +
          `\n🔐 Código de verificação: ${registro.codigo}\n${verificacao.url}` +
          `\n\nDocumento gerado pela MC Despachadoria.`;
        await sendWhatsAppPdf(user.phone, pdfBuf, `asd-${Date.now()}.pdf`, caption).catch(() => {});
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="asd-${Date.now()}.pdf"`);
      return res.send(pdfBuf);
    }

    // ── Assinatura Coisas de Despachantes ──
    // Mesma fonte da "Proprietário Atual" da Opção 2 (Datacube
    // /veiculos/proprietario-atual) e o mesmo builder de PDF, mas serviço à
    // parte de propósito: a dc-proprietario-atual segue intocada (cobra crédito
    // por consulta, na aba Opção 2) e esta aqui não debita nada — quem paga é a
    // assinatura, e o custo do período é limitado pela cota.
    if (serviceId === ASSINATURA_PLACAS_SERVICE_ID) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length !== 7)
        return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });

      let dcData;
      try {
        const dcRes = await fetch(`${DATACUBE_API_URL}/veiculos/proprietario-atual`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ auth_token: DATACUBE_TOKEN, placa }).toString(),
        });
        const parsed = await dcRes.json().catch(() => null);
        if (!dcRes.ok || !parsed || parsed.status === false) {
          const msg = parsed ? extractApiErrorMsg(parsed) : `Erro HTTP ${dcRes.status}.`;
          console.error(`[${serviceId}] erro na Datacube: ${msg}`);
          return res.status(502).json({ error: msg });
        }
        dcData = parsed.result ?? parsed;
      } catch (e) {
        console.error(`[${serviceId}] falha ao consultar a Datacube:`, e.message);
        return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
      }

      const temDados = dcData && (Array.isArray(dcData) ? dcData.length > 0 : Object.keys(dcData).length > 0);
      if (!temDados)
        return res.status(422).json({ error: 'Nenhum dado encontrado para essa placa. Nada foi descontado da sua cota.' });

      let pdfBuf;
      try {
        pdfBuf = await buildProprietarioAtualPdfBuffer(service, dcData, { placa });
      } catch (e) {
        console.error(`[${serviceId}] erro ao gerar PDF:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF da consulta. Nada foi descontado da sua cota.' });
      }

      // A cota só é consumida agora, com o PDF em mãos (mesma regra de nunca
      // cobrar consulta sem resultado), e de forma atômica: o WHERE
      // queries_used < cota faz o próprio Postgres barrar duas consultas
      // simultâneas que tentem furar o teto do período.
      // cota IS NULL = ilimitada: nesse caso o contador sobe só para relatório.
      const cota = await pool.query(
        `UPDATE subscriptions SET queries_used = queries_used + 1
         WHERE id=$1 AND (cota IS NULL OR queries_used < cota) RETURNING queries_used`,
        [gate.assinatura.id]
      );
      if (!cota.rows.length)
        return res.status(402).json({
          error: `Você já usou as ${gate.assinatura.cota} consultas de placa deste período da assinatura.`,
          code: 'COTA_ESGOTADA',
        });

      // amount 0 e sem transaction_id: não há débito de crédito, o pagamento
      // desta consulta é a assinatura. O histórico continua listando a consulta
      // e o PDF normalmente.
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, result_type, result_data)
         VALUES ($1,$2,$3,$4,'success',0,'pdf',$5) RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify({ placa }), JSON.stringify(dcData)]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="proprietario-atual-${placa}.pdf"`);
      return res.send(pdfBuf);
    }

    // ── Código de Segurança CRV incluído na assinatura ──
    // Mesma API do "Consulta 3 Código Segurança CRV (PDF)" pago (Vistocar
    // security-code, JSON com o PDF pronto em base64), mas serviço à parte: o
    // security-code-vistocar-2 segue cobrando crédito na aba Nova Consulta e
    // este aqui não debita nada — quem paga é a assinatura, com cota própria
    // (ASSINATURA_CRV_COTA), separada da cota de placas.
    if (serviceId === ASSINATURA_CRV_SERVICE_ID) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length !== 7)
        return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });

      let parsed;
      try {
        const vRes = await fetch(`${VISTOCAR_BASE_URL}/apiclient/${VISTOCAR_ENDPOINTS['security-code-vistocar-2']}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getVistocarToken()}` },
          body: JSON.stringify({ plate: placa }),
        });
        parsed = await vRes.json().catch(() => null);
        if (!vRes.ok) {
          const msg = parsed ? extractApiErrorMsg(parsed) : `Erro HTTP ${vRes.status}.`;
          console.error(`[${serviceId}] erro na Vistocar: ${msg}`);
          return res.status(502).json({ error: msg });
        }
      } catch (e) {
        console.error(`[${serviceId}] falha ao consultar a Vistocar:`, e.message);
        return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
      }

      // Mesmo envelope conferido no fluxo pago: status/message na raiz e o
      // resultado em "response" (success + paid + pdfBase64).
      const ok = parsed?.status === 200 && parsed?.response?.success === true
        && parsed?.response?.paid === true && parsed?.response?.pdfBase64;
      if (!ok) {
        const errMsg = parsed?.message || parsed?.response?.msg
          || 'Nenhum resultado encontrado para essa consulta. Nada foi descontado da sua cota.';
        console.error(`[${serviceId}] resposta inesperada da Vistocar: ${JSON.stringify(parsed)}`);
        return res.status(422).json({ error: errMsg });
      }
      const pdfBuf = Buffer.from(parsed.response.pdfBase64, 'base64');

      // Cota só é consumida com o PDF em mãos, e de forma atômica (o WHERE
      // impede duas consultas simultâneas de furarem o teto do período).
      const cota = await pool.query(
        `UPDATE subscriptions SET queries_used_crv = queries_used_crv + 1
         WHERE id=$1 AND (cota_crv IS NULL OR queries_used_crv < cota_crv) RETURNING queries_used_crv`,
        [gate.assinatura.id]
      );
      if (!cota.rows.length)
        return res.status(402).json({
          error: `Você já usou as ${gate.assinatura.cota_crv} consultas de Código de Segurança CRV deste período da assinatura.`,
          code: 'COTA_ESGOTADA',
        });

      // amount 0 e sem transaction_id: quem paga esta consulta é a assinatura.
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, result_type, result_data)
         VALUES ($1,$2,$3,$4,'success',0,'pdf','{}') RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify({ placa })]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivoVistocar(serviceId, placa)}"`);
      return res.send(pdfBuf);
    }

    // ── Verificar CRLV + Data CRV incluído na assinatura ──
    // Mesma API do serviço pago do grupo CRV (despbrasil verificar_crlv, JSON
    // com os dados em "dados"), mas serviço à parte: o verificar-crlv-data-crv
    // segue cobrando crédito na aba Nova Consulta e este aqui não debita nada —
    // quem paga é a assinatura, com cota própria (ASSINATURA_VERIFICAR_CRLV_COTA),
    // separada das de placa, CRV e Assinatura Digital.
    if (serviceId === ASSINATURA_VERIFICAR_CRLV_SERVICE_ID) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length !== 7)
        return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });

      let parsed;
      try {
        const dRes = await fetch(DESPBRASIL_BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'chaveAcesso': DESPBRASIL_KEY },
          body: JSON.stringify({ servico: DESPBRASIL_SVCS['verificar-crlv-data-crv'].servico, placa }),
        });
        parsed = await dRes.json().catch(() => null);
        if (!dRes.ok) {
          const msg = parsed ? extractApiErrorMsg(parsed) : `Erro HTTP ${dRes.status}.`;
          console.error(`[${serviceId}] erro na despbrasil: ${msg}`);
          return res.status(422).json({ error: `${msg} Nada foi descontado da sua cota.` });
        }
      } catch (e) {
        console.error(`[${serviceId}] falha ao consultar a despbrasil:`, e.message);
        return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
      }

      if (!parsed?.sucesso || !parsed?.dados) {
        const errMsg = parsed?.erro || parsed?.mensagem || parsed?.message
          || 'Nenhum resultado encontrado para essa placa. Nada foi descontado da sua cota.';
        console.error(`[${serviceId}] resposta inesperada da despbrasil: ${JSON.stringify(parsed)}`);
        return res.status(422).json({ error: errMsg });
      }

      let pdfBuf;
      try {
        pdfBuf = await buildVerificarCrlvDataCrvPdfBuffer(service, parsed.dados, { placa });
      } catch (e) {
        console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório. Nada foi descontado da sua cota.' });
      }

      // Cota só é consumida com o PDF em mãos, e de forma atômica (o WHERE
      // impede duas consultas simultâneas de furarem o teto do período).
      const cota = await pool.query(
        `UPDATE subscriptions SET queries_used_verificar_crlv = queries_used_verificar_crlv + 1
         WHERE id=$1 AND (cota_verificar_crlv IS NULL OR queries_used_verificar_crlv < cota_verificar_crlv)
         RETURNING queries_used_verificar_crlv`,
        [gate.assinatura.id]
      );
      if (!cota.rows.length)
        return res.status(402).json({
          error: `Você já usou as ${gate.assinatura.cota_verificar_crlv} consultas de Verificar CRLV + Data CRV deste período da assinatura.`,
          code: 'COTA_ESGOTADA',
        });

      // amount 0 e sem transaction_id: quem paga esta consulta é a assinatura.
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, result_type, result_data)
         VALUES ($1,$2,$3,$4,'success',0,'pdf',$5) RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify({ placa }), JSON.stringify(parsed.dados)]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBuf.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="verificar-crlv-data-crv-${placa}.pdf"`);
      return res.send(pdfBuf);
    }

    // ── CRLV-e Rio Grande do Sul V2 — API Datacube ASSÍNCRONA: o POST inicial em
    // /veiculos/documentos-crlve-rs-v2 só cria uma tarefa (devolve status:false,
    // msg "Tarefa criada com sucesso!" e um request_uid — status:false aqui NÃO é
    // erro, por isso este serviço não passa pelo fluxo Datacube genérico, que
    // trataria como falha). O documento sai depois via POST {api}/api/get-task
    // (auth_token + request_uid), que devolve status:true com result.pdf_base64
    // quando pronto. Faz o polling dentro da própria request (maxDuration de 800s
    // da function comporta; ver slowNote no catálogo) e só cobra com o PDF em
    // mãos. Atenção: o resultado do get-task só pode ser visualizado UMA vez (a
    // partir daí apenas /api/recovery-task reexpõe) — então o PDF é gravado em
    // pdf_cache imediatamente, antes de responder ao cliente.
    if (serviceId === 'dc-crlve-rs-v2') {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length !== 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });

      let createRes, createData;
      try {
        createRes = await fetch(`${DATACUBE_API_URL}${service.dcPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ auth_token: DATACUBE_TOKEN, placa }).toString(),
        });
        createData = await createRes.json().catch(() => null);
      } catch (e) {
        console.error(`[${serviceId}] erro ao criar tarefa na Datacube:`, e.message);
        return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
      }

      // Cobre também o caso de a API responder síncrona (documento já no corpo).
      let rsResult = createData?.status === true ? (createData.result ?? createData) : null;
      const requestUid = createData?.request_uid;
      if (!rsResult && (!createRes.ok || !requestUid)) {
        const errMsg = createData ? extractApiErrorMsg(createData) : `Erro HTTP ${createRes.status}.`;
        console.error(`[${serviceId}] erro Datacube ao criar tarefa (HTTP ${createRes.status}): ${errMsg}`);
        return res.status(422).json({ error: errMsg });
      }

      // Polling do get-task: a doc não distingue "processando" de "falhou" no
      // status (ambos vêm status:false, muda só a msg) — então insiste até o
      // limite e loga cada msg distinta pra diagnóstico.
      const POLL_INTERVAL_MS = 5000;
      const POLL_MAX_MS = 5 * 60 * 1000;
      const pollStart = Date.now();
      let lastMsg = null;
      while (!rsResult) {
        if (Date.now() - pollStart > POLL_MAX_MS) {
          console.error(`[${serviceId}] tarefa ${requestUid} não ficou pronta em ${POLL_MAX_MS / 1000}s (última msg: ${lastMsg}).`);
          return res.status(504).json({ error: 'O Detran-RS demorou para emitir o documento e a consulta não foi cobrada. Tente novamente em alguns minutos.' });
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        try {
          const pollRes = await fetch(`${DATACUBE_API_URL}/api/get-task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ auth_token: DATACUBE_TOKEN, request_uid: requestUid }).toString(),
          });
          const pollData = await pollRes.json().catch(() => null);
          if (pollData?.status === true) {
            rsResult = pollData.result ?? pollData;
          } else if (pollData?.msg && pollData.msg !== lastMsg) {
            lastMsg = pollData.msg;
            console.log(`[${serviceId}] tarefa ${requestUid} pendente: ${lastMsg}`);
          }
        } catch (e) {
          console.error(`[${serviceId}] erro no polling do get-task (tentando de novo):`, e.message);
        }
      }

      const pdfBase64 = rsResult?.pdf_base64;
      if (!pdfBase64) {
        console.error(`[${serviceId}] tarefa concluída sem pdf_base64: ${JSON.stringify(rsResult).slice(0, 500)}`);
        return res.status(422).json({ error: 'A API não retornou o documento. A consulta não foi cobrada — tente novamente.' });
      }
      const pdfBuf = Buffer.from(pdfBase64, 'base64');

      await debitarConsulta(userId, price);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [userId, price, `Consulta: ${service.name}`]
      );
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type, result_data)
         VALUES ($1,$2,$3,$4,'success',$5,$6,'pdf',$7) RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id,
         JSON.stringify({ ano_exercicio: rsResult.ano_exercicio ?? null, request_uid: requestUid ?? null })]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, pdfBase64, expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));

      await notifyAdminNewQuery(user, service, price, params);

      if (user.phone) {
        const caption = `✅ *CRLV-e RS pronto!*\n🔤 Placa: ${placa}\n\nDocumento gerado pela MC Despachadoria.`;
        await sendWhatsAppPdf(user.phone, pdfBuf, `CRLV-e-RS-${placa}.pdf`, caption).catch(() => {});
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="CRLV-e-RS-${placa}.pdf"`);
      return res.send(pdfBuf);
    }

    // Build URL and method
    let apiUrl = `${PORTAL_BASE_URL}/${serviceId}`;
    let method = 'POST';
    let body = params || {};

    // CRLV Agendado: solicitar. A entrada é placa OU CPF conforme a UF (ver
    // inputType de cada crlv-agendado-<uf>), por isso não há validação de placa
    // aqui — quem recusa entrada inválida é a upstream.
    if (isAgendadoSolicitar(serviceId)) {
      const svcDef = SERVICES.find(s => s.id === serviceId);
      apiUrl = `${PORTAL_BASE_URL}/api/crlv-agendado/solicitar`;
      body = { ...params, uf: svcDef?.uf || params.uf };
    }
    // CRLV Agendado: verificar status
    if (serviceId === 'crlv-agendado-status' && params?.pedido_id) {
      const pid = String(params.pedido_id).trim();
      if (pid.startsWith('AUTOCRLV-')) {
        const code = pid.slice('AUTOCRLV-'.length);
        apiUrl = `https://autocrlv.com.br/cliente/api_integracao_crlv_agendado_status.php?code=${encodeURIComponent(code)}`;
      } else if (pid.startsWith(PORTAL_PEDIDO_PREFIX)) {
        // Pedido do portal (hoje o CE): o prefixo é nosso, a API só conhece o número.
        apiUrl = `${PORTAL_BASE_URL}/api/crlv-agendado/${pid.slice(PORTAL_PEDIDO_PREFIX.length)}`;
      } else {
        apiUrl = `${PORTAL_BASE_URL}/api/crlv-agendado/${pid}`;
      }
      method = 'GET'; body = null;
    }
    // Comunicado venda por ID (GET)
    if (serviceId === 'com-venda-por-id' && params?.id) {
      apiUrl = `${PORTAL_BASE_URL}/api/comunicado-venda/${params.id}`;
      method = 'GET'; body = null;
    }
    // Comunicado venda desbloquear
    if (serviceId === 'com-venda-desbloquear') {
      apiUrl = `${PORTAL_BASE_URL}/api/comunicado-venda/desbloquear`;
    }
    // Transmitir comunicação de venda
    if (serviceId === 'venda-transmitir' && params?.id) {
      apiUrl = `${PORTAL_BASE_URL}/comunicacao-venda/transmitir/${params.id}`;
      body = {};
    }
    // Motivos cancelamento
    if (serviceId === 'motivos-cancelamento' && params?.protocolo) {
      apiUrl = `${PORTAL_BASE_URL}/motivos-cancelamento/${params.protocolo}`;
      method = 'GET'; body = null;
    }
    // Inserir comunicação de venda — a API exige id/numero_via/cidade/valor como número
    // JSON (não string) e rejeita com erro genérico ("Dados incompletos.") quando o tipo
    // não bate, então validamos e convertemos aqui antes de repassar (ver
    // buildComunicacaoVendaBody, compartilhada com o Alterar).
    if (serviceId === 'inserir-comunicacao-venda') {
      const built = buildComunicacaoVendaBody(params);
      if (built.error) return res.status(400).json({ error: built.error });
      body = built.body;
      // DEBUG temporário — remover após diagnosticar o erro "Campos obrigatórios
      // ausentes ou inválidos." reportado pela API upstream (CPFs mascarados).
      const maskDoc = p => ({ ...p, ...(p.cpf ? { cpf: p.cpf.replace(/\d(?=\d{4})/g, '*') } : { cnpj: p.cnpj.replace(/\d(?=\d{4})/g, '*') }) });
      console.log('[inserir-comunicacao-venda] payload:', JSON.stringify({
        ...body,
        vendedor:  maskDoc(body.vendedor),
        comprador: maskDoc(body.comprador),
      }));
    }
    // Cancelar comunicação de venda — a API exige id e id_motivo_cancelamento como número
    if (serviceId === 'cancelar-comunicacao-venda') {
      const id        = parseInt(params?.id, 10);
      const idMotivo  = parseInt(params?.id_motivo_cancelamento, 10);
      const protocolo = (params?.protocolo || '').trim();
      if (!Number.isInteger(id) || id <= 0)           return res.status(400).json({ error: 'ID da comunicação inválido.' });
      if (!protocolo)                                 return res.status(400).json({ error: 'Informe o protocolo.' });
      if (!Number.isInteger(idMotivo) || idMotivo <= 0) return res.status(400).json({ error: 'Informe o motivo do cancelamento.' });
      body = { id, protocolo, id_motivo_cancelamento: idMotivo };
    }
    // Serviços migrados para portaldespachantes.online (placa only)
    const PORTAL_PLACA_MAP = {
      'consulta-debitos-portal':  'consultar-debito-api',
      'base-estadual':            'base-estadual',
      'base-nacional':            'base-nacional',
      'consultar-gravame':        'consultar-gravame',
      'consultar-licenciamento':  'consultar-licenciamento',
      'consultar-placa-obito':    'consultar-placa-obito',
      // CRLV-e do Rio (doc "Documentação de Integração — 3 endpoints",
      // 24/08/2026): o rj2 substituiu a fonte Vistocar (apiclient/crlv-rj). O
      // rj3 é o Agendado, que saiu do catálogo.
      'consultar-crlv-rj':        'consultar-crlv-rj',
      'crlv-rj-reemissao-2':      'consultar-crlv-rj2',
      // CRLV-e de Pernambuco (doc de 2 endpoints), que era da Vistocar
      // (apiclient/crlv-pe), e o do Ceará (doc de 1 endpoint).
      'crlv-pe-instantaneo':      'consultar-crlv-pe',
      'crlv-ce-instantaneo':      'consultar-crlv-ce',
      // CRLV-e da Bahia (doc de 1 endpoint, 26/08/2026). Único id daqui que já
      // começa com "consultar-crlv-", então o PDF sai no WhatsApp pela regra do
      // prefixo — não pode entrar em CRLV_PORTAL_PDF_SVCS, senão vai duas vezes.
      'consultar-crlv-ba':        'consultar-crlv-ba',
    };
    if (PORTAL_PLACA_MAP[serviceId]) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `${PORTAL_BASE_URL}/${PORTAL_PLACA_MAP[serviceId]}`;
      method = 'POST';
      body   = { placa };
    }
    // CRLV Rio Reemissão v2 — API consultasfacil.net (auth por header chaveAcesso
    // fixo, ver fetchHeaders abaixo). Resposta é o PDF pronto em bytes (isRealPdf
    // cuida do resto do fluxo, mesmo padrão dos demais serviços em PDF direto).
    if (serviceId === 'crlv-rio-reemissao-v2') {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length !== 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `${CONSULTASFACIL_BASE_URL}/consultar-crlv-rj2`;
      method = 'POST';
      body   = { placa };
    }
    // Serviços via API despbrasil.com.br (auth por header chaveAcesso fixo, ver
    // fetchHeaders abaixo). Resposta é JSON com a URL do PDF pronto em "arquivo_url".
    if (DESPBRASIL_SVCS[serviceId]) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length !== 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = DESPBRASIL_BASE_URL;
      method = 'POST';
      body   = { servico: DESPBRASIL_SVCS[serviceId].servico, placa, ...(DESPBRASIL_SVCS[serviceId].extra || {}) };
    }
    // ATPV-e por chassi via portal — mesmo endpoint de consultar-atpve-v1
    // (aceita chassi OU placa+renavam, nunca os dois juntos no corpo).
    if (serviceId === 'consultar-atpve') {
      const chassi = (params?.chassi || '').toUpperCase().replace(/\s/g, '');
      if (chassi.length !== 17)
        return res.status(400).json({ error: 'Chassi deve ter exatamente 17 caracteres.' });
      body = { chassi };
    }
    // ATPV-e por placa + renavam via portal (volta do despbrasil pra API antiga —
    // PORTAL_BASE_URL/consultar-atpve, mesmo endpoint de antes do commit 9305042).
    if (serviceId === 'consultar-atpve-v1') {
      const placa   = (params?.placa   || '').toUpperCase().replace(/\s|-/g, '');
      const renavam = (params?.renavam || '').replace(/\D/g, '');
      if (placa.length < 7)
        return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      if (renavam.length < 9 || renavam.length > 11)
        return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
      apiUrl = `${PORTAL_BASE_URL}/consultar-atpve`;
      body = { placa, renavam };
    }
    // Serviço via API Vistocar (auth JWT em getVistocarToken, ver header
    // Authorization abaixo). Resposta é JSON com PDF pronto em base64.
    if (VISTOCAR_ENDPOINTS[serviceId]) {
      apiUrl = `${VISTOCAR_BASE_URL}/apiclient/${VISTOCAR_ENDPOINTS[serviceId]}`;
      method = 'POST';
      if (VISTOCAR_ATPVE_SVCS.has(serviceId)) {
        // ATPV-e: corpo próprio (o cadastro inteiro da venda), não { plate }.
        const montado = montarCorpoAtpveVistocar(service, params);
        if (montado.erro) return res.status(400).json({ error: montado.erro });
        body = montado.body;
        // Com o corpo montado, os anexos já cumpriram o papel deles. Daqui para
        // baixo `params` ainda é gravado em queries.params e vai na mensagem do
        // admin — e megabytes de base64 nos dois lugares não servem para nada.
        params = paramsSemAnexosAtpve(params);
      } else {
        const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
        if (placa.length !== 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        body = { plate: placa };
      }
    }
    // Débitos por Estado / Dívida Ativa — API Datacube (form-urlencoded, retorna JSON que vira PDF)
    const isDcDebito = serviceId.startsWith('dc-debito-');
    const isDcDividaAtiva = serviceId.startsWith('dc-dividaativa-');
    if (isDcDebito || isDcDividaAtiva) {
      const placa   = (params?.placa   || '').toUpperCase().replace(/[\s-]/g, '');
      const renavam = (params?.renavam || '').replace(/\D/g, '');
      if (service.inputType !== 'debito_renavam' && placa.length < 7)
        return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      if (renavam.length < 9 || renavam.length > 11)
        return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
      const form = new URLSearchParams({ auth_token: DATACUBE_TOKEN, renavam });
      if (service.inputType !== 'debito_renavam') form.set('placa', placa);
      if (service.inputType === 'debito_doc') {
        const documento = (params?.documento || '').replace(/\D/g, '');
        if (documento.length !== 11 && documento.length !== 14)
          return res.status(400).json({ error: 'Documento inválido. Informe CPF ou CNPJ.' });
        form.set('documento', documento);
      }
      if (service.inputType === 'debito_chassi') {
        const chassi = (params?.chassi || '').toUpperCase().replace(/\s/g, '');
        if (chassi.length !== 17) return res.status(400).json({ error: 'Chassi deve ter exatamente 17 caracteres.' });
        form.set('chassi', chassi);
      }
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = form;
    }

    // Decodificação de Motor — API Datacube (form-urlencoded, retorna JSON simples)
    if (serviceId === 'dc-decodificar-motor') {
      const motor = (params?.motor || '').toUpperCase().replace(/\s/g, '');
      if (!motor) return res.status(400).json({ error: 'Informe o número do motor.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, motor });
    }

    // Localização CPF (e V3) — API Datacube (form-urlencoded; movidas da Opção 2 para
    // valor fixo de R$5,00, noMarkup:true). O PDF é montado a partir do JSON retornado
    // (ver buildLocalizacaoCpfPdfBuffer). Só muda o dcPath entre as duas versões.
    const isDcLocalizacaoCpf = serviceId === 'dc-cadastro-localizacao-cpf' || serviceId === 'dc-cadastro-localizacao-v3';
    if (isDcLocalizacaoCpf) {
      const cpf = (params?.cpf || '').replace(/\D/g, '');
      if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, cpf });
    }

    // CNH — API Datacube (form-urlencoded, retorna JSON genérico — sem PDF, cada UF
    // tem um formato de retorno próprio e não vale a pena montar um relatório único)
    const isDcCnh = serviceId.startsWith('dc-cnh-');
    if (isDcCnh) {
      const form = new URLSearchParams({ auth_token: DATACUBE_TOKEN });
      switch (service.inputType) {
        case 'cnh_nome_cpf': {
          const nome = (params?.nome || '').trim();
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          form.set('nome', nome);
          form.set('cpf', cpf);
          break;
        }
        case 'cnh_al': {
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          const data_nascimento = (params?.data_nascimento || '').trim();
          const cod_municipio_nascimento = (params?.cod_municipio_nascimento || '').trim();
          const uf_nascimento = (params?.uf_nascimento || '').trim();
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          if (!data_nascimento) return res.status(400).json({ error: 'Data de nascimento é obrigatória.' });
          if (!cod_municipio_nascimento) return res.status(400).json({ error: 'Código do município de nascimento é obrigatório.' });
          if (!uf_nascimento) return res.status(400).json({ error: 'UF de nascimento é obrigatória.' });
          form.set('cpf', cpf);
          form.set('data_nascimento', data_nascimento);
          form.set('cod_municipio_nascimento', cod_municipio_nascimento);
          form.set('uf_nascimento', uf_nascimento);
          break;
        }
        case 'cnh_cpf_formulario': {
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          const formulario = (params?.formulario || '').trim();
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          if (!formulario) return res.status(400).json({ error: 'Número do formulário é obrigatório.' });
          form.set('cpf', cpf);
          form.set('formulario', formulario);
          break;
        }
        case 'cnh_only': {
          const cnh = (params?.cnh || '').trim();
          if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
          form.set('cnh', cnh);
          break;
        }
        case 'cnh_cpf_cnh': {
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          const cnh = (params?.cnh || '').trim();
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
          form.set('cpf', cpf);
          form.set('cnh', cnh);
          break;
        }
        case 'cnh_cpf_renach': {
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          const renach = (params?.renach || '').trim();
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          if (!renach) return res.status(400).json({ error: 'Número do RENACH é obrigatório.' });
          form.set('cpf', cpf);
          form.set('renach', renach);
          break;
        }
        case 'cnh_pr': {
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          const cnh = (params?.cnh || '').trim();
          const data_validade_cnh = (params?.data_validade_cnh || '').trim();
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
          if (!data_validade_cnh) return res.status(400).json({ error: 'Data de validade da CNH é obrigatória.' });
          form.set('cpf', cpf);
          form.set('cnh', cnh);
          form.set('data_validade_cnh', data_validade_cnh);
          break;
        }
        case 'cnh_se': {
          const cnh = (params?.cnh || '').trim();
          const registro = (params?.registro || '').trim();
          const data_nascimento = (params?.data_nascimento || '').trim();
          if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
          if (!registro) return res.status(400).json({ error: 'Registro é obrigatório.' });
          if (!data_nascimento) return res.status(400).json({ error: 'Data de nascimento é obrigatória.' });
          form.set('cnh', cnh);
          form.set('registro', registro);
          form.set('data_nascimento', data_nascimento);
          break;
        }
        case 'cnh_cpf_nascimento': {
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          const data_nascimento = (params?.data_nascimento || '').trim();
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          if (!data_nascimento) return res.status(400).json({ error: 'Data de nascimento é obrigatória.' });
          form.set('cpf', cpf);
          form.set('data_nascimento', data_nascimento);
          break;
        }
        // Só CPF (Consulta Nacional - Completa V3). Reaproveita o inputType
        // 'dc_cpf' que o painel já sabe desenhar e ler, em vez de criar um
        // tipo novo só para isto.
        case 'dc_cpf': {
          const cpf = (params?.cpf || '').replace(/\D/g, '');
          if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
          form.set('cpf', cpf);
          break;
        }
        default:
          return res.status(400).json({ error: 'Tipo de entrada não suportado.' });
      }
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = form;
    }

    // Veículos por Documento — API Datacube (form-urlencoded; movido da Opção 2 para
    // valor fixo de R$14,00, noMarkup:true). O PDF é montado a partir do JSON
    // retornado (ver buildVeiculosDocPdfBuffer).
    const isDcVeiculosDoc = serviceId === 'dc-veiculos-doc';
    if (isDcVeiculosDoc) {
      const documento = (params?.documento || '').replace(/\D/g, '');
      if (documento.length !== 11 && documento.length !== 14)
        return res.status(400).json({ error: 'Documento inválido. Informe CPF (11 dígitos) ou CNPJ (14 dígitos).' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, documento });
    }

    // Roubo e Furto — API Datacube (form-urlencoded; movido da Opção 2 para valor
    // fixo de R$25,00, noMarkup:true). O PDF é montado a partir do JSON retornado
    // (ver buildRouboFurtoPdfBuffer).
    const isDcRouboFurto = serviceId === 'dc-roubo-furto';
    if (isDcRouboFurto) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, placa });
    }

    // Histórico de Proprietários — API Datacube (form-urlencoded; movido da Opção 2
    // para valor fixo de R$15,00, noMarkup:true). O PDF é montado a partir do JSON
    // retornado (ver buildHistoricoProprietarioPdfBuffer).
    const isDcHistoricoProprietario = serviceId === 'dc-historico-proprietario';
    if (isDcHistoricoProprietario) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, placa });
    }

    // Histórico de Gravames — API Datacube (form-urlencoded; movido da Opção 2
    // para valor fixo de R$8,00, noMarkup:true). O PDF é montado a partir do JSON
    // retornado (ver buildHistoricoGravamesPdfBuffer).
    const isDcHistoricoGravames = serviceId === 'dc-historico-gravames';
    if (isDcHistoricoGravames) {
      const chassi = (params?.chassi || '').toUpperCase().replace(/\s/g, '');
      if (chassi.length !== 17) return res.status(400).json({ error: 'Chassi deve ter exatamente 17 caracteres.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, chassi });
    }

    // Leilão — API Datacube (form-urlencoded; movido da Opção 2 para valor fixo
    // de R$30,00, noMarkup:true). O PDF é montado a partir do JSON retornado (ver
    // buildLeilaoPdfBuffer).
    const isDcLeilao = serviceId === 'dc-leilao';
    if (isDcLeilao) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, placa });
    }

    // Veículo 0km — API Datacube (form-urlencoded; movido da Opção 2 para valor
    // fixo de R$12,00, noMarkup:true). O PDF é montado a partir do JSON retornado
    // (ver buildConsulta0kmPdfBuffer).
    const isDcConsulta0km = serviceId === 'dc-consulta-0km';
    if (isDcConsulta0km) {
      const chassi = (params?.chassi || '').toUpperCase().replace(/\s/g, '');
      if (chassi.length !== 17) return res.status(400).json({ error: 'Chassi deve ter exatamente 17 caracteres.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, chassi });
    }

    // Base Estadual (BIN) — API Datacube (form-urlencoded; movido da Opção 2 para
    // valor fixo de R$9,90, noMarkup:true). O PDF é montado a partir do JSON
    // retornado (ver buildBinEstadualPdfBuffer).
    const isDcBinEstadual = serviceId === 'dc-bin-estadual';
    if (isDcBinEstadual) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `${DATACUBE_API_URL}${service.dcPath}`;
      method = 'POST';
      body   = new URLSearchParams({ auth_token: DATACUBE_TOKEN, placa });
    }

    const isDatacubeForm = isDcDebito || isDcDividaAtiva || isDcCnh || isDcVeiculosDoc || isDcRouboFurto || isDcHistoricoProprietario || isDcHistoricoGravames || isDcLeilao || isDcConsulta0km || isDcBinEstadual || isDcLocalizacaoCpf || serviceId === 'dc-decodificar-motor';

    let fetchHeaders;
    if (isDatacubeForm) {
      fetchHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
    } else if (apiUrl.startsWith('https://autocrlv.com.br/cliente/api_integracao_crlv_agendado')) {
      fetchHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTOCRLV_KEY}` };
    } else if (apiUrl.startsWith(PORTAL_BASE_URL)) {
      // Cobre os três casos do portal: consulta com PDF na hora (PORTAL_PLACA_MAP),
      // o solicitar do agendado e o "Ver Status" de um pedido PORTAL-.
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY };
    } else if (DESPBRASIL_SVCS[serviceId]) {
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': DESPBRASIL_KEY };
    } else if (serviceId === 'crlv-rio-reemissao-v2') {
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': CONSULTASFACIL_KEY };
    } else if (VISTOCAR_ENDPOINTS[serviceId]) {
      fetchHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getVistocarToken()}` };
    } else {
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY };
    }
    const fetchOpts = { method, headers: fetchHeaders };
    if (isDatacubeForm) {
      fetchOpts.body = body.toString();
    } else if (body !== null) {
      fetchOpts.body = JSON.stringify(body);
    }
    const apiRes = await fetch(apiUrl, fetchOpts);
    const ct = apiRes.headers.get('content-type') || '';

    if (!apiRes.ok) {
      let errMsg = 'Erro na API.';
      try {
        if (ct.includes('application/json') || ct.includes('text/')) {
          const errData = await apiRes.json().catch(() => null)
            || { error: await apiRes.text().catch(() => 'Sem resposta') };
          errMsg = extractApiErrorMsg(errData);
          // DEBUG temporário — corpo bruto do erro upstream, para achar campos
          // dentro de "details" que a mensagem extraída resume/oculta.
          if (serviceId === 'inserir-comunicacao-venda') {
            console.log(`[${serviceId}] raw error body:`, JSON.stringify(errData));
          }
        } else {
          errMsg = `HTTP ${apiRes.status}`;
        }
      } catch {}
      console.error(`Erro API [${serviceId}] HTTP ${apiRes.status}: ${errMsg}`);
      // Reemissão por Chassi/Placa (portal) e Número ATPV-E (despbrasil): na
      // prática todo erro aqui significa que não há documento disponível para
      // essa placa/chassi — a mensagem crua da upstream soa como erro de
      // sistema, então troca por algo mais claro (o erro original já foi logado).
      if (serviceId === 'consultar-atpve' || serviceId === 'consultar-atpve-v1') {
        errMsg = 'Não encontramos ATPV-e disponível para reemissão nessa placa no momento. É possível que essa ATPV-e tenha comunicação de venda ou tenha sido gerada pelo app eCNH — nesses casos a segunda via não sai por aqui. Tente a consulta "Reemissão da ATPVe Com Comunicação de Venda".';
      } else if (serviceId === 'consultar-Numero-ATPVE') {
        errMsg = 'Não encontramos o número do ATPV-E para essa placa no momento. Tente novamente mais tarde ou fale com o suporte.';
      }
      return res.status(apiRes.status).json({ error: errMsg });
    }

    // Lê o corpo uma única vez.
    const bodyBuffer = Buffer.from(await apiRes.arrayBuffer());
    let   bodyStr    = bodyBuffer.toString('utf8');
    const isRealPdf  = bodyBuffer.slice(0, 4).toString() === '%PDF';

    // Serviços Datacube (form-urlencoded): a API retorna HTTP 200 mesmo em erro de
    // negócio (ex.: "Motor não encontrado"), sinalizando falha via status:false — não
    // pelos campos genéricos success/erro que o restante do sistema já reconhece.
    let dcDebitoPdfBuf = null;
    let dcMotorPdfBuf = null;
    if (isDatacubeForm) {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (!parsed || parsed.status === false) {
        const errMsg = parsed ? extractApiErrorMsg(parsed) : 'Resposta inválida da API.';
        console.error(`[${serviceId}] erro Datacube: ${errMsg}`);
        return res.status(422).json({ error: errMsg });
      }
      if (isDcDebito) {
        // Débitos por Estado: monta o PDF do relatório a partir do JSON — a API não
        // devolve PDF pronto.
        try {
          dcDebitoPdfBuf = await buildDebitoPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcDividaAtiva) {
        // Dívida Ativa: mesmo princípio, mas a API devolve só os débitos de dívida
        // ativa (sem multas/ipvas/licenciamentos), por isso usa um builder próprio.
        try {
          dcDebitoPdfBuf = await buildDividaAtivaPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (serviceId === 'dc-decodificar-motor') {
        try {
          dcMotorPdfBuf = await buildMotorPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcCnh) {
        // CNH: monta o PDF do relatório a partir do JSON — cada UF tem campos
        // próprios, então o corpo do relatório é genérico (mesmo padrão visual do
        // relatório de Débitos por Estado).
        try {
          dcDebitoPdfBuf = await buildCnhPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcVeiculosDoc) {
        // Veículos por Documento: monta o PDF do relatório a partir do JSON, no
        // mesmo padrão visual do relatório de Débitos por Estado.
        try {
          dcDebitoPdfBuf = await buildVeiculosDocPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcRouboFurto) {
        // Roubo e Furto: monta o PDF do relatório a partir do JSON, no mesmo
        // padrão visual do relatório de Débitos por Estado.
        try {
          dcDebitoPdfBuf = await buildRouboFurtoPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcHistoricoProprietario) {
        // Histórico de Proprietários: monta o PDF do relatório a partir do JSON,
        // no mesmo padrão visual do relatório de Débitos por Estado.
        try {
          dcDebitoPdfBuf = await buildHistoricoProprietarioPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcHistoricoGravames) {
        // Histórico de Gravames: monta o PDF do relatório a partir do JSON, no
        // mesmo padrão visual do relatório de Débitos por Estado.
        try {
          dcDebitoPdfBuf = await buildHistoricoGravamesPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcLeilao) {
        // Leilão: monta o PDF do relatório a partir do JSON, no mesmo padrão
        // visual do relatório de Débitos por Estado.
        try {
          dcDebitoPdfBuf = await buildLeilaoPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcConsulta0km) {
        // Veículo 0km: monta o PDF do relatório a partir do JSON, no mesmo
        // padrão visual do relatório de Débitos por Estado.
        try {
          dcDebitoPdfBuf = await buildConsulta0kmPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcBinEstadual) {
        // Base Estadual (BIN): monta o PDF do relatório a partir do JSON, no
        // mesmo padrão visual do relatório de Débitos por Estado.
        try {
          dcDebitoPdfBuf = await buildBinEstadualPdfBuffer(service, parsed.result ?? parsed, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else if (isDcLocalizacaoCpf) {
        // Localização CPF: monta o PDF do relatório a partir do JSON, no mesmo
        // padrão visual do relatório de Débitos por Estado.
        // A v3 (dc-cadastro-localizacao-v3) devolve "result" como array com um único
        // objeto { historicos: {nomes, enderecos, emails, telefones, celulares},
        // participacao_empresas } (ver documentação Datacube) — sem desembrulhar, o
        // renderizador genérico tratava o índice "0" como campo e o relatório saía
        // vazio ("0"); e sem subir os campos de "historicos" pra raiz, cada um deles
        // (sendo listas) também seria descartado por só ter 1 nível de recursão.
        try {
          const localizacaoResult = parsed.result ?? parsed;
          let localizacaoData = Array.isArray(localizacaoResult) ? (localizacaoResult[0] ?? {}) : localizacaoResult;
          if (localizacaoData?.historicos && typeof localizacaoData.historicos === 'object') {
            localizacaoData = { ...localizacaoData.historicos, participacao_empresas: localizacaoData.participacao_empresas };
          }
          dcDebitoPdfBuf = await buildLocalizacaoCpfPdfBuffer(service, localizacaoData, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      }
    }

    // serviços que retornam JSON com pdf_base64
    const PDF_BASE64_SVCS = ['consulta-debitos-portal'];
    let base64PdfBuf = null;
    // CRLV-e CE: identificador do registro na Vistocar, preenchido no tratamento
    // de resposta abaixo e usado depois para criar a pendência do webhook.
    let vistocarMovementId = null;
    // ATPV-e: o protocolo do cadastro (um UUID), que é COISA DIFERENTE do
    // movementId (numérico, interno da Vistocar). Só com ele dá para registrar,
    // alterar, excluir ou consultar a situação do ATPV-e — ver os helpers do
    // ciclo de vida perto de entregarResultadoVistocar.
    let vistocarProtocolo = null;
    // Serviço da lista de assíncronos que, nesta chamada, voltou com o documento
    // pronto — segue pelo caminho normal de PDF em vez de virar pendência.
    let vistocarEntregaImediata = false;
    if (PDF_BASE64_SVCS.includes(serviceId)) {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (parsed?.pdf_base64) {
        base64PdfBuf = Buffer.from(parsed.pdf_base64, 'base64');
      } else if (!isRealPdf) {
        const errMsg = parsed ? extractApiErrorMsg(parsed) : 'PDF não retornado pela API.';
        console.error(`[${serviceId}] sem pdf_base64: ${errMsg}`);
        return res.status(422).json({ error: errMsg });
      }
    }

    // Serviços despbrasil.com.br — resposta traz "arquivo_url" com o PDF pronto
    // (não base64), então baixamos aqui para poder cachear/enviar no mesmo fluxo
    // dos demais serviços em PDF. Exceção: "verificar-crlv" e "consulta-renavam"
    // montam o próprio PDF a partir do JSON em "dados" (mesmo padrão visual do
    // relatório de Débitos por Estado), em vez de usar o arquivo pronto da despbrasil.
    let despbrasilJsonPdfBuf = null;
    if (serviceId === 'verificar-crlv') {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (!parsed?.sucesso || !parsed?.dados) {
        const errMsg = parsed?.erro || parsed?.mensagem || parsed?.message || 'Nenhum resultado encontrado para essa consulta.';
        console.error(`[${serviceId}] resposta inesperada da despbrasil: ${JSON.stringify(parsed)}`);
        return res.status(422).json({ error: errMsg });
      }
      try {
        despbrasilJsonPdfBuf = await buildVerificarCrlvPdfBuffer(service, parsed.dados, params);
      } catch (e) {
        console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
      }
    } else if (serviceId === 'verificar-crlv-data-crv') {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (!parsed?.sucesso || !parsed?.dados) {
        const errMsg = parsed?.erro || parsed?.mensagem || parsed?.message || 'Nenhum resultado encontrado para essa consulta.';
        console.error(`[${serviceId}] resposta inesperada da despbrasil: ${JSON.stringify(parsed)}`);
        return res.status(422).json({ error: errMsg });
      }
      try {
        despbrasilJsonPdfBuf = await buildVerificarCrlvDataCrvPdfBuffer(service, parsed.dados, params);
      } catch (e) {
        console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
      }
    } else if (serviceId === 'consulta-renavam') {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (!parsed?.sucesso || !parsed?.dados) {
        const errMsg = parsed?.erro || parsed?.mensagem || parsed?.message || 'Nenhum resultado encontrado para essa consulta.';
        console.error(`[${serviceId}] resposta inesperada da despbrasil: ${JSON.stringify(parsed)}`);
        return res.status(422).json({ error: errMsg });
      }
      try {
        despbrasilJsonPdfBuf = await buildConsultaRenavamPdfBuffer(service, parsed.dados, params);
      } catch (e) {
        console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
      }
    } else if (serviceId === 'consultar-Numero-ATPVE') {
      // A despbrasil não retorna JSON estruturado pra esse serviço — só o PDF
      // pronto em "arquivo_url". Baixamos, extraímos o texto (extractAtpveFieldsFromPdf)
      // e remontamos no layout oficial do ATPVe digital (buildNumeroAtpvePdfBuffer)
      // em vez de repassar o PDF genérico da despbrasil.
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (!parsed?.sucesso || !parsed?.arquivo_url) {
        const errMsg = parsed?.erro || parsed?.mensagem || parsed?.message || 'PDF não retornado pela API.';
        console.error(`[${serviceId}] resposta inesperada da despbrasil: ${JSON.stringify(parsed)}`);
        return res.status(422).json({ error: errMsg });
      }
      try {
        const pdfRes = await fetch(parsed.arquivo_url);
        if (!pdfRes.ok) {
          console.error(`[${serviceId}] falha ao baixar arquivo_url: HTTP ${pdfRes.status}`);
          return res.status(422).json({ error: 'Falha ao obter o PDF gerado pela API.' });
        }
        const sourcePdfBuf = Buffer.from(await pdfRes.arrayBuffer());
        const placaUpper = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
        // A despbrasil gera o PDF na hora a cada chamada e às vezes devolve um
        // arquivo malformado, que trava o pdf.js ("bad XRef entry", "Invalid
        // number") e derrubava a consulta inteira com HTTP 500. Uma nova
        // geração costuma vir íntegra, então pedimos outra — a mesma reação
        // que a avulsa já tinha (ver runPublicAtpveComunicacaoVenda). Duas
        // leituras ilegíveis viram recusa explicada, sempre antes do débito.
        let fields;
        try {
          fields = await extractAtpveFieldsFromPdf(sourcePdfBuf);
        } catch (e) {
          console.error(`[${serviceId}] PDF da despbrasil ilegível (${e.message}) — pedindo outra geração.`);
          try {
            fields = await fetchAndExtractAtpveFromDespbrasil(placaUpper);
          } catch (e2) {
            console.error(`[${serviceId}] 2ª geração da despbrasil também veio ilegível:`, e2.message);
            return res.status(422).json({
              error: 'A base devolveu um documento ilegível para essa placa agora. Nenhum crédito foi debitado — tente novamente em alguns minutos ou fale com o suporte.',
            });
          }
        }
        // Completa ano fabricação/modelo, marca/modelo, cor, código de
        // segurança do CRV, dados do vendedor e a data da venda comunicada com
        // três consultas extras (Proprietário Atual v2 + Consulta 3 Código
        // Segurança CRV + Consulta Comunicado) — preço já reajustado pra cobrir
        // as 4 consultas encadeadas (ver catálogo).
        Object.assign(fields, await runNumeroAtpveSupplementaryQueries(placaUpper, fields.renavam));
        // Nenhuma célula obrigatória pode sair em branco — ver ATPVE_CAMPOS_OBRIGATORIOS.
        // A recusa aqui acontece antes do débito (o desconto de créditos só vem
        // depois deste bloco), então ninguém paga por documento incompleto.
        const faltando = atpveCamposFaltando(fields);
        if (faltando.length) {
          console.error(`[${serviceId}] ${placaUpper}: campos obrigatórios em branco (${faltando.join(', ')}) — consulta recusada sem débito.`);
          await avisarAdminAtpveIncompleto(placaUpper, faltando, 'Painel (Número ATPV-E)');
          return res.status(422).json({
            error: `Não foi possível reunir todos os dados do veículo para essa placa (faltou: ${faltando.join(', ')}). Nenhum crédito foi debitado — tente novamente em alguns minutos ou fale com o suporte.`,
          });
        }
        despbrasilJsonPdfBuf = await buildNumeroAtpvePdfBuffer(service, fields, params);
      } catch (e) {
        console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
      }
    } else if (DESPBRASIL_SVCS[serviceId]) {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (parsed?.sucesso && parsed?.arquivo_url) {
        const pdfRes = await fetch(parsed.arquivo_url);
        if (!pdfRes.ok) {
          console.error(`[${serviceId}] falha ao baixar arquivo_url: HTTP ${pdfRes.status}`);
          return res.status(422).json({ error: 'Falha ao obter o PDF gerado pela API.' });
        }
        base64PdfBuf = Buffer.from(await pdfRes.arrayBuffer());
      } else {
        const errMsg = parsed?.erro || parsed?.mensagem || parsed?.message || 'PDF não retornado pela API.';
        console.error(`[${serviceId}] resposta inesperada da despbrasil: ${JSON.stringify(parsed)}`);
        return res.status(422).json({ error: errMsg });
      }
    }

    // Serviço Vistocar (Código de Segurança) — resposta em JSON com PDF pronto
    // em base64 (mesmo padrão dos serviços em PDF_BASE64_SVCS).
    if (VISTOCAR_ENDPOINTS[serviceId]) {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (VISTOCAR_ASYNC_SVCS.has(serviceId)) {
        // Assíncrono: a resposta de sucesso só confirma o REGISTRO da consulta
        // ("CONSULTA PENDENTE"/"Cadastro do ATPVe realizado com sucesso",
        // resultAvailable=false) e devolve o movementId; o documento chega depois
        // em POST /api/webhooks/vistocar. Sem movementId não há como correlacionar
        // a notificação com este pedido, então isso é tratado como falha (nada é
        // cobrado — a cobrança só ocorre na entrega).
        const ok = parsed?.status === 200 && parsed?.response?.success === true;
        if (!ok) {
          const orgao = service.uf ? `Detran-${service.uf.toUpperCase()}` : 'órgão';
          const errMsg = parsed?.message || parsed?.response?.msg || parsed?.response?.error
            || `Não foi possível registrar a consulta no ${orgao}.`;
          console.error(`[${serviceId}] resposta inesperada da Vistocar: ${JSON.stringify(parsed)}`);
          return res.status(422).json({ error: errMsg });
        }
        // O ATPV-e pode sair pronto na própria resposta do cadastro
        // (arquivoPdfBase64 preenchido). Quando isso acontece não há o que
        // esperar: segue pelo caminho normal de PDF, cobrando agora.
        const jaPronto = parsed?.response?.arquivoPdfBase64 || parsed?.response?.pdfBase64;
        if (jaPronto) {
          base64PdfBuf = Buffer.from(String(jaPronto).replace(/^data:[^,]+,/, '').replace(/\s/g, ''), 'base64');
          vistocarEntregaImediata = true;
        } else {
          // O CRLV-e devolve movementId; o ATPV-e devolve os DOIS, e são coisas
          // diferentes: movementId é o número interno da consulta na Vistocar
          // (é por ele que o webhook correlaciona a notificação) e protocolo é o
          // UUID do ATPV-e no Detran. As rotas de registro, alteração, exclusão
          // e situação só aceitam o protocolo — mandar o movementId nelas volta
          // "Protocolo não encontrado" (conferido em 18/09/2026). Por isso os
          // dois são guardados; guardar só o movementId, como era antes, deixava
          // o cadastro sem como ser registrado e ele morria no prazo de 48h.
          const proto = parsed?.response?.protocolo;
          vistocarProtocolo = (proto === null || proto === undefined) ? null : String(proto).trim() || null;
          const id = parsed?.response?.movementId ?? proto;
          if (id === null || id === undefined || String(id).trim() === '') {
            console.error(`[${serviceId}] Vistocar aceitou o pedido sem movementId/protocolo: ${JSON.stringify(parsed)}`);
            return res.status(422).json({ error: 'A emissão foi aceita, mas sem número de protocolo para acompanhar. Fale com o suporte antes de tentar de novo.' });
          }
          vistocarMovementId = String(id).trim();
          // Cadastro de ATPV-e que volta sem protocolo não pode ser registrado
          // pelo painel — nem pelo nosso, nem pelo do cliente. O pedido segue
          // (o cadastro existe do lado de lá e nada foi cobrado), mas o dono é
          // avisado na hora, porque só ele consegue registrar pelo painel da
          // Vistocar antes de o prazo de 48h derrubar o cadastro.
          if (VISTOCAR_ATPVE_SVCS.has(serviceId) && !vistocarProtocolo) {
            console.error(`[${serviceId}] cadastro aceito sem protocolo: ${JSON.stringify(parsed)}`);
            const placaAviso = String(params?.placa || '').toUpperCase();
            sendWhatsApp(ADMIN_PHONE, [
              `⚠️ *ATPV-e cadastrado SEM protocolo*`,
              ``,
              `🔤 *Placa:* ${placaAviso}`,
              `🧾 *Serviço:* ${service.name}`,
              `🔢 *movementId:* ${vistocarMovementId}`,
              ``,
              `A Vistocar não devolveu o protocolo, então o registro no Detran não pode ser feito pelo painel. Registre pelo painel da Vistocar — o cadastro cai no prazo de 48h.`,
            ].join('\n')).catch(() => {});
          }
        }
      } else if (serviceId === 'vistocar-debitos-cod-barra') {
        // Mesmo padrão de envelope dos outros endpoints Vistocar: status/message no
        // nível raiz, dados de verdade dentro de "response" (aqui: success/registros).
        const ok = parsed?.status === 200 && parsed?.response?.success === true && Array.isArray(parsed?.response?.registros);
        if (!ok) {
          const errMsg = parsed?.message || parsed?.response?.msg || 'Nenhum resultado encontrado para essa consulta.';
          console.error(`[${serviceId}] resposta inesperada da Vistocar: ${JSON.stringify(parsed)}`);
          return res.status(422).json({ error: errMsg });
        }
        try {
          dcDebitoPdfBuf = await buildDebitosCodBarraPdfBuffer(service, parsed.response, params);
        } catch (e) {
          console.error(`[${serviceId}] erro ao gerar PDF do relatório:`, e.message);
          return res.status(500).json({ error: 'Erro ao gerar o PDF do relatório.' });
        }
      } else {
        const ok = parsed?.status === 200 && parsed?.response?.success === true
          && parsed?.response?.paid === true && parsed?.response?.pdfBase64;
        if (!ok) {
          const errMsg = parsed?.message || parsed?.response?.msg || 'Nenhum resultado encontrado para essa consulta.';
          console.error(`[${serviceId}] resposta inesperada da Vistocar: ${JSON.stringify(parsed)}`);
          return res.status(422).json({ error: errMsg });
        }
        base64PdfBuf = Buffer.from(parsed.response.pdfBase64, 'base64');
      }
    }

    // ── Vistocar assíncrono (CRLV-e Ceará antigo, ATPV-e RJ/MG): registrado agora, cobrado na entrega ──
    // A consulta foi só REGISTRADA no Detran (ver tratamento de resposta acima):
    // não há documento ainda, então nada é debitado aqui e o fluxo sai antes das
    // validações de resultado abaixo, que esperam um documento. A consulta fica
    // 'aguardando_pdf' e o débito acontece quando o webhook da Vistocar entrega o
    // PDF (ver POST /api/webhooks/vistocar → finalizePendingQuery). Se o documento
    // nunca sair, runVistocarPendingCheck marca como 'cancelado' sem cobrar nada.
    if (VISTOCAR_ASYNC_SVCS.has(serviceId) && !vistocarEntregaImediata) {
      await ensureDbReady();   // vistocar_pending é tabela nova — ver ensureDbReady
      const placa = String(params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, result_type, result_data)
         VALUES ($1,$2,$3,$4,'aguardando_pdf',$5,'pdf',$6) RETURNING id`,
        [userId, serviceId, service.name, JSON.stringify(params || {}), price,
         JSON.stringify({ placa, movementId: vistocarMovementId, protocolo: vistocarProtocolo })]
      );
      // ON CONFLICT: a Vistocar pode reaproveitar um movementId de um pedido
      // anterior da mesma placa — a pendência nova é a que vale.
      await pool.query(
        `INSERT INTO vistocar_pending (movement_id, query_id, user_id, phone, service_id, placa, protocolo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (movement_id) DO UPDATE SET query_id=EXCLUDED.query_id, user_id=EXCLUDED.user_id,
           phone=EXCLUDED.phone, placa=EXCLUDED.placa, protocolo=EXCLUDED.protocolo,
           registrado_em=NULL, created_at=NOW()`,
        [vistocarMovementId, qRow.rows[0].id, userId, user.phone || null, serviceId, placa, vistocarProtocolo]
      );
      await notifyAdminNewQuery(user, service, price, params);
      const orgao = service.uf ? `Detran-${service.uf.toUpperCase()}` : 'Detran';
      // Sem protocolo o cliente não tem como registrar (a Vistocar só aceita o
      // protocolo nessa rota), então a tela volta a ser a de espera — quem
      // registra nesse caso é o suporte, pelo painel da Vistocar, avisado acima.
      const aguardandoRegistro = VISTOCAR_ATPVE_SVCS.has(serviceId) && !!vistocarProtocolo;
      return res.json({
        success: true,
        pending: true,
        // queryId: é por ele que o painel acompanha a emissão na barra de
        // progresso (GET /api/queries/:id/atpve-status).
        queryId: qRow.rows[0].id,
        // O ATPV-e nasce apenas CADASTRADO: o documento só é gerado depois do
        // registro no Detran, que é um passo à parte e fica com o cliente (ver
        // POST /api/queries/:id/atpve-registrar). É esta bandeira que faz o
        // painel abrir a tela de conferência em vez da barra de progresso.
        aguardandoRegistro,
        result: {
          status: aguardandoRegistro
            ? `Cadastro criado no ${orgao}! Confira os dados e clique em "Registrar no Detran" para o ATPV-e ser emitido — enquanto não registrar, o documento não existe. Você só é cobrado quando ele for entregue.`
            : `Consulta registrada no ${orgao}! O documento ainda está sendo emitido — assim que sair, ele chega pelo WhatsApp e fica no seu histórico. Você só é cobrado quando o PDF for entregue.`,
          protocolo: vistocarProtocolo || vistocarMovementId,
        },
        charged: 0,
      });
    }

    // Serviços que retornam HTML — capturado para servir via /api/html/:token
    let htmlBuf = null;

    // Serviços genéricos (não-PDF, não-HTML): recusa cobrar se a API não retornou
    // nenhum dado relevante (corpo vazio, JSON vazio/nulo ou com indicador de falha).
    let genericData = null, genericParseOk = false;
    const willBePdfOrHtml = isRealPdf || base64PdfBuf || htmlBuf || dcDebitoPdfBuf || dcMotorPdfBuf || despbrasilJsonPdfBuf;
    if (!willBePdfOrHtml) {
      const trimmed = bodyStr.trim();
      if (!trimmed) {
        console.error(`[${serviceId}] resposta vazia da API.`);
        return res.status(422).json({ error: 'Nenhum resultado encontrado para essa consulta.' });
      }
      try { genericData = JSON.parse(trimmed); genericParseOk = true; } catch { genericParseOk = false; }
      if (genericParseOk) {
        const isEmptyResult =
          genericData === null ||
          (Array.isArray(genericData) && genericData.length === 0) ||
          (typeof genericData === 'object' && !Array.isArray(genericData) && Object.keys(genericData).length === 0) ||
          genericData?.success === false ||
          genericData?.sucesso === false ||
          genericData?.error;
        if (isEmptyResult) {
          const errMsg = genericData?.error || genericData?.message || genericData?.mensagem
            || 'Nenhum resultado encontrado para essa consulta.';
          console.error(`[${serviceId}] resposta vazia/sem dados: ${errMsg}`);
          return res.status(422).json({ error: errMsg });
        }
      }
    }

    // ── Debita créditos somente após validar resposta ─────────────────────────
    await debitarConsulta(userId, price);
    const txRow = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
      [userId, price, `Consulta: ${service.name}`]
    );
    // Guarda o corpo JSON retornado (quando não é PDF/HTML) para o histórico poder
    // reexibir o mesmo resultado depois, sem precisar refazer (e recobrar) a consulta.
    // Exceção: Inserir Comunicação Venda não vira PDF aqui — o comprovante só é
    // gerado depois, quando o usuário transmite (ver /comunicacao-venda-transmitir),
    // porque antes disso a comunicação ainda está "importada", não "comunicada".
    // O JSON de origem (com o "id" do portal) fica salvo mesmo assim — é o que
    // habilita o botão "Transmitir" em "Meus Comunicados de Venda".
    const resultData = willBePdfOrHtml ? null
      : JSON.stringify(genericParseOk ? genericData : { resposta: bodyStr });
    const qRow = await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type, result_data)
       VALUES ($1,$2,$3,$4,'success',$5,$6,$7,$8) RETURNING id`,
      [userId, serviceId, service.name, JSON.stringify(params || {}),
       price, txRow.rows[0].id,
       htmlBuf ? 'html' : (isRealPdf || base64PdfBuf || dcDebitoPdfBuf || dcMotorPdfBuf || despbrasilJsonPdfBuf) ? 'pdf' : 'json',
       resultData]
    );
    // ── Envia PDF + salva no cache por 7 dias ────────────────────────────────
    const pdfToSend = base64PdfBuf || (isRealPdf ? bodyBuffer : null) || dcDebitoPdfBuf || dcMotorPdfBuf || despbrasilJsonPdfBuf;

    await notifyAdminNewQuery(user, service, price, params);

    if (pdfToSend || htmlBuf) {
      const dataToCache = pdfToSend || htmlBuf;
      const token       = crypto.randomBytes(32).toString('hex');
      const expiresAt   = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, userId, token, dataToCache.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));
      if (pdfToSend) {
        // Envia PDF via WhatsApp para CRLV-e Digital (instantâneo)
        if (serviceId.startsWith('consultar-crlv-') && user.phone) {
          const ufCode = serviceId.replace('consultar-crlv-', '').toUpperCase();
          const placa  = (params?.placa || '').toUpperCase();
          const caption = `✅ *CRLV-e ${ufCode} pronto!*\n🔤 Placa: ${placa}\n\nDocumento gerado pela MC Despachadoria.`;
          const fileName = `CRLV-e-${ufCode}-${placa || 'doc'}.pdf`;
          await sendWhatsAppPdf(user.phone, pdfToSend, fileName, caption).catch(() => {});
        }
        // Envia PDF via WhatsApp para serviços despbrasil.com.br
        if (DESPBRASIL_SVCS[serviceId] && user.phone) {
          const placa = (params?.placa || '').toUpperCase();
          const caption = `✅ *${service.name} pronto!*\n🔤 Placa: ${placa}\n\nDocumento gerado pela MC Despachadoria.`;
          const fileName = nomeArquivoVistocar(serviceId, placa || 'doc')
            || `${DESPBRASIL_SVCS[serviceId].arquivo || DESPBRASIL_SVCS[serviceId].servico}-${placa || 'doc'}.pdf`;
          await sendWhatsAppPdf(user.phone, pdfToSend, fileName, caption).catch(() => {});
        }
        // Envia PDF via WhatsApp para os CRLV-e do portal cujo id não começa
        // com "consultar-crlv-" (o da regra acima) — Rio Reemissão 2, Rio
        // Agendado e Pernambuco.
        if (CRLV_PORTAL_PDF_SVCS.has(serviceId) && user.phone) {
          const placa = (params?.placa || '').toUpperCase();
          const caption = `✅ *${service.name} pronto!*\n🔤 Placa: ${placa}\n\nDocumento gerado pela MC Despachadoria.`;
          const fileName = `${serviceId}-${placa || 'doc'}.pdf`;
          await sendWhatsAppPdf(user.phone, pdfToSend, fileName, caption).catch(() => {});
        }
        // Envia PDF via WhatsApp para serviços Vistocar (Código de Segurança)
        if (VISTOCAR_ENDPOINTS[serviceId] && user.phone) {
          const placa = (params?.placa || '').toUpperCase();
          const caption = `✅ *${service.name} pronto!*\n🔤 Placa: ${placa}\n\nDocumento gerado pela MC Despachadoria.`;
          const fileName = nomeArquivoVistocar(serviceId, placa || 'doc')
            || `${serviceId}-${placa || 'doc'}.pdf`;
          await sendWhatsAppPdf(user.phone, pdfToSend, fileName, caption).catch(() => {});
        }
        // Envia PDF via WhatsApp para Localização CPF (e V3)
        if (isDcLocalizacaoCpf && user.phone) {
          const caption = `✅ *${service.name} pronto!*\n🪪 CPF: ${maskDocDisplay(params?.cpf)}\n\nDocumento gerado pela MC Despachadoria.`;
          const fileName = `${serviceId}-${(params?.cpf || 'doc').replace(/\D/g, '')}.pdf`;
          await sendWhatsAppPdf(user.phone, pdfToSend, fileName, caption).catch(() => {});
        }
        res.setHeader('Content-Type', 'application/pdf');
        // Serviço da Vistocar sai com o nome da casa; o resto segue como estava.
        const nomeArquivo = nomeArquivoVistocar(serviceId, params?.placa)
          || `${serviceId}-${Date.now()}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
        return res.send(pdfToSend);
      }
      return res.json({ success: true, result: { status: 'Relatório gerado com sucesso' }, charged: price, html_token: token });
    }

    if (genericParseOk) {
      const data = genericData;

      // WhatsApp para CRLV-e Agendado (não é verificação de status)
      if (isAgendadoSolicitar(serviceId) && user.phone) {
        // Tenta múltiplos caminhos pois o endpoint /solicitar pode retornar estrutura variada
        const pedido = data?.pedido || data?.data?.pedido || {};
        const svcData = data?.servico || data?.data?.servico || {};
        const pedidoIdCru = pedido.id ?? pedido.pedido_id ?? data?.id ?? data?.pedido_id ?? data?.data?.id ?? '-';
        // Prefixo PORTAL- desligado: com um host só (o AutoCRLV usa o prefixo
        // próprio "AUTOCRLV-"), o número cru já identifica o pedido. Continua
        // sendo aceito na leitura, para os pedidos antigos que o têm gravado.
        const ehPortal = false;
        const pedidoId = ehPortal ? PORTAL_PEDIDO_PREFIX + pedidoIdCru : pedidoIdCru;
        if (ehPortal && data && typeof data === 'object') {
          if (data.pedido_id !== undefined) data.pedido_id = pedidoId;
          if (data.id !== undefined)        data.id        = pedidoId;
          if (data.pedido && typeof data.pedido === 'object') {
            if (data.pedido.id !== undefined)        data.pedido.id        = pedidoId;
            if (data.pedido.pedido_id !== undefined) data.pedido.pedido_id = pedidoId;
          }
        }
        const placa = (pedido.placa || data?.placa || params?.placa || '-').toString().toUpperCase();
        const uf = (pedido.uf || data?.uf || service.uf || '-').toString().toUpperCase();
        const status = pedido.status_normalizado || pedido.status || data?.status || 'pendente';
        const nomeSvc = svcData.nome_longo || data?.servico_nome || service.name;
        const msg = [
          `✅ *CRLV-e Agendado — Consulta Concluída*`,
          ``,
          `🚗 *Serviço:* ${nomeSvc}`,
          `📋 *ID do Pedido:* ${pedidoId}`,
          `🔤 *Placa:* ${placa}`,
          `📍 *UF:* ${uf}`,
          `📊 *Status:* ${status}`,
          ``,
          `⏰ A partir de 2 horas depois de feita essa consulta vá em:`,
          `*CRLV Agendado — Ver Status*`,
          `e use o ID *${pedidoId}* para acompanhar quando for emitido seu CRLV-e.`,
        ].join('\n');
        await sendWhatsApp(user.phone, msg).catch(() => {});

        // Enfileira o pedido para o cron checar o status periodicamente e
        // avisar por WhatsApp assim que o PDF ficar pronto (sem depender do
        // usuário voltar e clicar em "Ver Status" manualmente).
        if (pedidoId && pedidoId !== '-') {
          await pool.query(
            `INSERT INTO crlv_agendado_pending (pedido_id, user_id, phone, service_id, uf, placa, query_id, amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (pedido_id) DO NOTHING`,
            [String(pedidoId), userId, user.phone, serviceId, uf, placa, qRow.rows[0].id, price]
          ).catch(e => console.error('Erro ao enfileirar CRLV-e Agendado:', e.message));
        }
      }

      // WhatsApp com o PDF assim que "Ver Status" indicar que o CRLV-e Agendado ficou pronto
      if (serviceId === 'crlv-agendado-status' && user.phone) {
        const pedido       = data?.pedido || data?.data?.pedido || {};
        const statusResumo = data?.status_resumo || data?.data?.status_resumo || {};
        const pdfPath       = pedido.pdf_url || statusResumo.pdf_url || '';
        const podeBaixar    = data?.pdf_disponivel === true || statusResumo.pode_baixar_pdf === true;
        const pedidoIdNotif = params?.pedido_id ? String(params.pedido_id).trim() : null;

        if (podeBaixar && pdfPath && pedidoIdNotif) {
          try {
            const already = await pool.query(
              'SELECT 1 FROM crlv_agendado_notifications WHERE pedido_id=$1', [pedidoIdNotif]
            );
            if (already.rows.length === 0) {
              // pdf_url costuma vir relativo — a base é o host que emitiu o pedido.
              const fullUrl = /^https?:\/\//i.test(pdfPath) ? pdfPath : PORTAL_BASE_URL + pdfPath;
              const pdfApiRes = await fetch(fullUrl);
              if (pdfApiRes.ok) {
                const pdfBuf = Buffer.from(await pdfApiRes.arrayBuffer());
                if (pdfBuf.slice(0, 4).toString() === '%PDF') {
                  const placa = (pedido.placa || data?.placa || '-').toString().toUpperCase();
                  const uf    = (pedido.uf    || data?.uf    || '-').toString().toUpperCase();
                  const caption = `✅ *CRLV-e Agendado pronto!*\n🔤 Placa: ${placa}\n📍 UF: ${uf}\n📋 Pedido: ${pedidoIdNotif}\n\nDocumento gerado pela MC Despachadoria.`;
                  await sendWhatsAppPdf(user.phone, pdfBuf, `CRLV-e-Agendado-${pedidoIdNotif}.pdf`, caption).catch(() => {});
                  await pool.query(
                    'INSERT INTO crlv_agendado_notifications (pedido_id) VALUES ($1) ON CONFLICT DO NOTHING', [pedidoIdNotif]
                  );
                  await pool.query(
                    'DELETE FROM crlv_agendado_pending WHERE pedido_id=$1', [pedidoIdNotif]
                  ).catch(() => {});
                }
              }
            }
          } catch (e) {
            console.error('Erro ao notificar CRLV-e Agendado via WhatsApp:', e.message);
          }
        }
      }

      // Inserir Comunicação Venda: não expõe o JSON bruto do portal (traz um campo
      // de situação tipo "importado" que confundiria o usuário) — o comprovante em
      // PDF só é gerado depois, na transmissão (ver /comunicacao-venda-transmitir).
      if (serviceId === 'inserir-comunicacao-venda') {
        return res.json({
          success: true,
          result: { status: 'Comunicação de venda inserida com sucesso! Vá em "Meus Comunicados de Venda" e clique em "Transmitir" para finalizar — o comprovante em PDF fica disponível após a transmissão.' },
          charged: price,
        });
      }

      return res.json({ success: true, result: data, charged: price });
    } else {
      return res.json({ success: true, result: { resposta: bodyStr }, charged: price });
    }
  } catch (err) {
    console.error('Erro em /api/query:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

// ── POST /api/query ────────────────────────────────────────────────────────
app.post('/api/query', requireAuth, (req, res) =>
  processCatalogQuery(req.user.id, req.body.serviceId, req.body.params, res));

// Grupos/serviços do catálogo "Nova Consulta" fora do alcance da API de chave
// (/api/v1): os serviços "manuais" (upload de PDF pelo super admin) não
// respondem na hora — não há hoje uma rota de API para o cliente buscar esse
// resultado depois.
const V1_EXCLUDED_GROUPS = [];
function isV1Eligible(serviceId) {
  const svc = SERVICES.find(s => s.id === serviceId);
  if (!svc) return false;
  if (V1_EXCLUDED_GROUPS.includes(svc.group)) return false;
  if (MANUAL_SERVICE_IDS.includes(svc.id)) return false;
  return true;
}

// Preço fixo da consulta pós-paga (chave Geral) de CRLV 2 Rio Reemissão pela
// API — diferente do preço do painel (R$ 55,00) e do preço fixo do cadastro de
// ATPV-e MG (EXTERNAL_API_PRICE, R$ 5,00); valor comercial definido para os
// contratos de API. Usado também na tela Cobranças API do admin (ver
// externalApiPriceFor logo abaixo, junto às rotas ATPV-e MG).
const CRLV_RJ_REEMISSAO_2_API_PRICE = 28.00;

// Roda a consulta de CRLV 2 Rio Reemissão para chave Geral (pós-paga): não
// debita ninguém, registra em api_general_queries para cobrança posterior
// (página Cobranças API do admin) e devolve o PDF pronto na hora — mesmo
// contrato de resposta do endpoint pré-pago (processCatalogQuery).
async function runCrlvRj2General(req, res) {
  const placa = (req.body?.placa || '').toUpperCase().replace(/[\s-]/g, '');
  if (placa.length !== 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });

  try {
    let bodyBuffer;
    try {
      const apiRes = await fetch(`${PORTAL_BASE_URL}/consultar-crlv-rj2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY },
        body: JSON.stringify({ placa }),
      });
      bodyBuffer = Buffer.from(await apiRes.arrayBuffer());
    } catch (e) {
      console.error('Erro na API portaldespachantes [crlv-rj-reemissao-2 externo]:', e.message);
      return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
    }

    // Sucesso é o PDF em bytes; qualquer outra coisa é o JSON de erro do portal
    // ({ error } ou { erro }), inclusive nos 401/403 de chave.
    if (bodyBuffer.slice(0, 4).toString() !== '%PDF') {
      let parsed;
      try { parsed = JSON.parse(bodyBuffer.toString('utf8')); } catch { parsed = null; }
      const errMsg = parsed?.error || parsed?.erro || parsed?.message || 'Nenhum resultado encontrado para essa consulta.';
      console.error(`[crlv-rj-reemissao-2 externo] resposta inesperada do portal: ${bodyBuffer.toString('utf8').slice(0, 300)}`);
      return res.status(422).json({ error: errMsg });
    }
    const pdfBuffer = bodyBuffer;

    await pool.query(
      `INSERT INTO api_general_queries (api_key_id, service_id, params, result_data)
       VALUES ($1,$2,$3,$4)`,
      [req.apiKey.id, 'crlv-rj-reemissao-2', JSON.stringify({ placa }), JSON.stringify({ success: true })]
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="crlv-rj-reemissao-2-${placa}.pdf"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro em API externa [crlv-rj-reemissao-2]:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

// ── POST /api/v1/crlv-rj-reemissao-2 — único serviço do catálogo liberado
// para chave Geral (pós-paga, R$ 28,00 via runCrlvRj2General acima).
// Registrada ANTES da rota genérica /api/v1/:serviceId para interceptar esse
// serviceId específico também para chaves Gerais; chave vinculada cai no
// mesmo fluxo pré-pago de sempre (processCatalogQuery, preço do painel).
app.post('/api/v1/crlv-rj-reemissao-2', requireApiKey, (req, res) => {
  if (!req.apiUser) return runCrlvRj2General(req, res);
  if (!isV1Eligible('crlv-rj-reemissao-2'))
    return res.status(404).json({ error: 'Serviço não disponível pela API.' });
  return processCatalogQuery(req.apiUser.id, 'crlv-rj-reemissao-2', req.body, res);
});

// ── POST /api/v1/:serviceId — catálogo "Nova Consulta" para clientes com chave
// de API ─────────────────────────────────────────────────────────────────────
// Mesmo núcleo (processCatalogQuery) e mesmo preço do painel (basePrice *
// markup), mas autenticado por chave em vez de cookie JWT, e debitando sempre
// da conta vinculada à chave — chave Geral (pós-paga, sem usuário) não serve
// aqui, só para o CRLV 2 Rio Reemissão (ver runCrlvRj2General acima).
app.post('/api/v1/:serviceId', requireApiKey, (req, res) => {
  if (!req.apiUser)
    return res.status(403).json({ error: 'Esta chave é do tipo Geral e não pode ser usada para o catálogo de Nova Consulta.' });
  if (!isV1Eligible(req.params.serviceId))
    return res.status(404).json({ error: 'Serviço não disponível pela API.' });
  return processCatalogQuery(req.apiUser.id, req.params.serviceId, req.body, res);
});

// Alguns serviços SERVICES_V2 (ver flag returnsPdf, ex.: dc-crlve-rj-flash)
// devolvem o documento pronto como PDF em base64 dentro do JSON, em vez de
// campos estruturados. Em vez de depender do nome exato do campo (que muda
// por endpoint), detecta pela assinatura base64 de "%PDF-" (JVBERi0) e
// devolve tanto o base64 extraído quanto uma cópia do objeto com esse campo
// substituído por um placeholder, para o result_data salvo não ficar gigante.
function findAndStripBase64Pdf(obj) {
  if (!obj || typeof obj !== 'object') return { pdf: null, data: obj };
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const k of Object.keys(clone)) {
    const v = clone[k];
    if (typeof v === 'string' && v.startsWith('JVBERi0')) {
      clone[k] = '[PDF]';
      return { pdf: v, data: clone };
    }
    if (v && typeof v === 'object') {
      const nested = findAndStripBase64Pdf(v);
      if (nested.pdf) {
        clone[k] = nested.data;
        return { pdf: nested.pdf, data: clone };
      }
    }
  }
  return { pdf: null, data: clone };
}

// ── POST /api/query-v2 (API Datacube — aba "Opção 2 Nova Consulta") ───────────
// Fluxo isolado do /api/query: usa o mesmo saldo/tabelas do usuário, mas nunca
// toca em SERVICES, MANUAL_SERVICE_IDS ou nas integrações portal/autocrlv.
app.post('/api/query-v2', requireAuth, async (req, res) => {
  const { serviceId, params } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Serviço não informado.' });

  const service = SERVICES_V2.find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });
  if (service.adminOnly && !(await isSuperAdmin(req.user.id)))
    return res.status(403).json({ error: 'Serviço disponível apenas para administradores.' });

  const price = parseFloat((service.basePrice * (service.noMarkup ? 1 : MARKUP)).toFixed(2));

  try {
    const ur = await pool.query('SELECT id, credits, active, pos_pago, pos_pago_limite FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    const bloqueio = await bloqueioPagamentoConsulta(user.id, user, price);
    if (bloqueio) return res.status(bloqueio.status).json(bloqueio.body);

    const form = new URLSearchParams({ auth_token: DATACUBE_TOKEN });

    switch (service.inputType) {
      case 'dc_placa': {
        const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
        if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        form.set('placa', placa);
        break;
      }
      case 'dc_chassi': {
        const chassi = (params?.chassi || '').toUpperCase().replace(/\s/g, '');
        if (chassi.length !== 17) return res.status(400).json({ error: 'Chassi deve ter exatamente 17 caracteres.' });
        form.set('chassi', chassi);
        break;
      }
      case 'dc_motor': {
        const motor = (params?.motor || '').toUpperCase().replace(/\s/g, '');
        if (!motor) return res.status(400).json({ error: 'Informe o número do motor.' });
        form.set('motor', motor);
        break;
      }
      case 'dc_renavam': {
        const renavam = (params?.renavam || '').replace(/\D/g, '');
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        form.set('renavam', renavam);
        break;
      }
      case 'dc_documento': {
        const documento = (params?.documento || '').replace(/\D/g, '');
        if (documento.length !== 11 && documento.length !== 14)
          return res.status(400).json({ error: 'Documento inválido. Informe CPF (11 dígitos) ou CNPJ (14 dígitos).' });
        form.set('documento', documento);
        break;
      }
      case 'dc_tipo': {
        const tipo = (params?.tipo || '').toLowerCase().trim();
        if (!['carro', 'moto', 'caminhao'].includes(tipo))
          return res.status(400).json({ error: 'Selecione um tipo de veículo válido (carro, moto ou caminhão).' });
        form.set('tipo', tipo);
        break;
      }
      case 'dc_tipo_marca': {
        const tipo  = (params?.tipo  || '').toLowerCase().trim();
        const marca = (params?.marca || '').trim();
        if (!['carro', 'moto', 'caminhao'].includes(tipo))
          return res.status(400).json({ error: 'Selecione um tipo de veículo válido (carro, moto ou caminhão).' });
        if (!marca) return res.status(400).json({ error: 'Informe a marca.' });
        form.set('tipo', tipo);
        form.set('marca', marca);
        break;
      }
      case 'dc_fipe': {
        const codigoFipe = (params?.codigo_fipe    || '').trim();
        const anoFab     = (params?.ano_fabricacao || '').trim();
        const anoMod     = (params?.ano_modelo     || '').trim();
        if (!codigoFipe)            return res.status(400).json({ error: 'Informe o código FIPE.' });
        if (!/^\d{4}$/.test(anoFab)) return res.status(400).json({ error: 'Ano de fabricação inválido.' });
        if (!/^\d{4}$/.test(anoMod)) return res.status(400).json({ error: 'Ano de modelo inválido.' });
        form.set('codigo_fipe', codigoFipe);
        form.set('ano_fabricacao', anoFab);
        form.set('ano_modelo', anoMod);
        break;
      }
      case 'dc_csv': {
        const placa    = (params?.placa    || '').toUpperCase().replace(/[\s-]/g, '');
        const renavam  = (params?.renavam  || '').replace(/\D/g, '');
        const documento = (params?.documento || '').replace(/\D/g, '');
        if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        if (documento.length !== 11 && documento.length !== 14)
          return res.status(400).json({ error: 'Documento inválido. Informe CPF ou CNPJ.' });
        form.set('placa', placa);
        form.set('renavam', renavam);
        form.set('documento', documento);
        break;
      }
      case 'dc_debito': {
        const placa   = (params?.placa   || '').toUpperCase().replace(/[\s-]/g, '');
        const renavam = (params?.renavam || '').replace(/\D/g, '');
        if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        form.set('placa', placa);
        form.set('renavam', renavam);
        break;
      }
      case 'dc_debito_doc': {
        const placa     = (params?.placa     || '').toUpperCase().replace(/[\s-]/g, '');
        const renavam   = (params?.renavam   || '').replace(/\D/g, '');
        const documento = (params?.documento || '').replace(/\D/g, '');
        if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        if (documento.length !== 11 && documento.length !== 14)
          return res.status(400).json({ error: 'Documento inválido. Informe CPF ou CNPJ.' });
        form.set('placa', placa);
        form.set('renavam', renavam);
        form.set('documento', documento);
        break;
      }
      case 'dc_debito_chassi': {
        const placa   = (params?.placa   || '').toUpperCase().replace(/[\s-]/g, '');
        const renavam = (params?.renavam || '').replace(/\D/g, '');
        const chassi  = (params?.chassi  || '').toUpperCase().replace(/\s/g, '');
        if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        if (chassi.length !== 17) return res.status(400).json({ error: 'Chassi deve ter exatamente 17 caracteres.' });
        form.set('placa', placa);
        form.set('renavam', renavam);
        form.set('chassi', chassi);
        break;
      }
      case 'dc_debito_renavam': {
        const renavam = (params?.renavam || '').replace(/\D/g, '');
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        form.set('renavam', renavam);
        break;
      }
      case 'dc_cpf': {
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        form.set('cpf', cpf);
        break;
      }
      case 'dc_cnpj': {
        const cnpj = (params?.cnpj || '').replace(/\D/g, '');
        if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido. Deve ter 14 dígitos.' });
        form.set('cnpj', cnpj);
        break;
      }
      case 'dc_cnh_nome_cpf': {
        const nome = (params?.nome || '').trim();
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        form.set('nome', nome);
        form.set('cpf', cpf);
        break;
      }
      case 'dc_cnh_al': {
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        const data_nascimento = (params?.data_nascimento || '').trim();
        const cod_municipio_nascimento = (params?.cod_municipio_nascimento || '').trim();
        const uf_nascimento = (params?.uf_nascimento || '').trim();
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        if (!data_nascimento) return res.status(400).json({ error: 'Data de nascimento é obrigatória.' });
        if (!cod_municipio_nascimento) return res.status(400).json({ error: 'Código do município de nascimento é obrigatório.' });
        if (!uf_nascimento) return res.status(400).json({ error: 'UF de nascimento é obrigatória.' });
        form.set('cpf', cpf);
        form.set('data_nascimento', data_nascimento);
        form.set('cod_municipio_nascimento', cod_municipio_nascimento);
        form.set('uf_nascimento', uf_nascimento);
        break;
      }
      case 'dc_cnh_cpf_formulario': {
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        const formulario = (params?.formulario || '').trim();
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        if (!formulario) return res.status(400).json({ error: 'Número do formulário é obrigatório.' });
        form.set('cpf', cpf);
        form.set('formulario', formulario);
        break;
      }
      case 'dc_cnh_only': {
        const cnh = (params?.cnh || '').trim();
        if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
        form.set('cnh', cnh);
        break;
      }
      case 'dc_cnh_cpf_cnh': {
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        const cnh = (params?.cnh || '').trim();
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
        form.set('cpf', cpf);
        form.set('cnh', cnh);
        break;
      }
      case 'dc_cnh_cpf_renach': {
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        const renach = (params?.renach || '').trim();
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        if (!renach) return res.status(400).json({ error: 'Número do RENACH é obrigatório.' });
        form.set('cpf', cpf);
        form.set('renach', renach);
        break;
      }
      case 'dc_cnh_pr': {
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        const cnh = (params?.cnh || '').trim();
        const data_validade_cnh = (params?.data_validade_cnh || '').trim();
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
        if (!data_validade_cnh) return res.status(400).json({ error: 'Data de validade da CNH é obrigatória.' });
        form.set('cpf', cpf);
        form.set('cnh', cnh);
        form.set('data_validade_cnh', data_validade_cnh);
        break;
      }
      case 'dc_cnh_se': {
        const cnh = (params?.cnh || '').trim();
        const registro = (params?.registro || '').trim();
        const data_nascimento = (params?.data_nascimento || '').trim();
        if (!cnh) return res.status(400).json({ error: 'Número da CNH é obrigatório.' });
        if (!registro) return res.status(400).json({ error: 'Registro é obrigatório.' });
        if (!data_nascimento) return res.status(400).json({ error: 'Data de nascimento é obrigatória.' });
        form.set('cnh', cnh);
        form.set('registro', registro);
        form.set('data_nascimento', data_nascimento);
        break;
      }
      case 'dc_cnh_cpf_nascimento': {
        const cpf = (params?.cpf || '').replace(/\D/g, '');
        const data_nascimento = (params?.data_nascimento || '').trim();
        if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
        if (!data_nascimento) return res.status(400).json({ error: 'Data de nascimento é obrigatória.' });
        form.set('cpf', cpf);
        form.set('data_nascimento', data_nascimento);
        break;
      }
      case 'dc_telefone': {
        const ddd = (params?.ddd || '').replace(/\D/g, '');
        const numero = (params?.numero || '').replace(/\D/g, '');
        if (ddd.length !== 2) return res.status(400).json({ error: 'DDD inválido. Deve ter 2 dígitos.' });
        if (!numero) return res.status(400).json({ error: 'Número de telefone é obrigatório.' });
        form.set('ddd', ddd);
        form.set('numero', numero);
        break;
      }
      case 'dc_uf': {
        const uf = (params?.uf || '').trim().toUpperCase();
        if (uf.length !== 2) return res.status(400).json({ error: 'UF inválida. Deve ter 2 letras.' });
        form.set('uf', uf);
        break;
      }
      case 'dc_qrcode': {
        const image_base64 = (params?.image_base64 || '').trim();
        const verify_signature = (params?.verify_signature || '1').trim();
        if (!image_base64) return res.status(400).json({ error: 'Imagem em base64 é obrigatória.' });
        form.set('image_base64', image_base64);
        form.set('verify_signature', verify_signature);
        break;
      }
      case 'dc_sintegra': {
        const cnpj_ie = (params?.cnpj_ie || '').trim();
        const tipo = (params?.tipo || '').trim().toUpperCase();
        const uf = (params?.uf || '').trim().toUpperCase();
        if (!cnpj_ie) return res.status(400).json({ error: 'CNPJ ou IE é obrigatório.' });
        if (tipo !== 'CNPJ' && tipo !== 'IE') return res.status(400).json({ error: 'Tipo inválido. Deve ser CNPJ ou IE.' });
        if (tipo === 'IE' && uf.length !== 2) return res.status(400).json({ error: 'UF é obrigatória e deve ter 2 letras quando o tipo for IE.' });
        form.set('cnpj_ie', cnpj_ie);
        form.set('tipo', tipo);
        if (uf) form.set('uf', uf);
        break;
      }
      case 'dc_nfe': {
        const chave = (params?.chave || '').trim();
        const baixarBoletos = (params?.baixarBoletos || '').trim();
        if (!chave) return res.status(400).json({ error: 'Chave da NFe é obrigatória.' });
        form.set('chave', chave);
        if (baixarBoletos) form.set('baixarBoletos', baixarBoletos);
        break;
      }
      case 'dc_comunicado_venda': {
        const placa = (params?.['veiculo.placa'] || '').trim();
        const renavam = (params?.['veiculo.renavam'] || '').replace(/\D/g, '');
        const veiculoUf = (params?.['veiculo.uf'] || '').trim().toUpperCase();
        const vendedorNome = (params?.['vendedor.nome'] || '').trim();
        const vendedorDocumento = (params?.['vendedor.documento'] || '').replace(/\D/g, '');
        const compradorNome = (params?.['comprador.nome'] || '').trim();
        const compradorDocumento = (params?.['comprador.documento'] || '').replace(/\D/g, '');
        const vendaData = (params?.['venda.data'] || '').trim();
        const vendaValor = (params?.['venda.valor'] || '').trim();
        const comprovante = (params?.comprovante || '').trim();
        if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        if (veiculoUf.length !== 2) return res.status(400).json({ error: 'UF do veículo é obrigatória e deve ter 2 letras.' });
        if (!vendedorNome) return res.status(400).json({ error: 'Nome do vendedor é obrigatório.' });
        if (vendedorDocumento.length !== 11 && vendedorDocumento.length !== 14) return res.status(400).json({ error: 'Documento do vendedor inválido. Informe CPF ou CNPJ.' });
        if (!compradorNome) return res.status(400).json({ error: 'Nome do comprador é obrigatório.' });
        if (compradorDocumento.length !== 11 && compradorDocumento.length !== 14) return res.status(400).json({ error: 'Documento do comprador inválido. Informe CPF ou CNPJ.' });
        if (!vendaData) return res.status(400).json({ error: 'Data da venda é obrigatória.' });
        if (!vendaValor) return res.status(400).json({ error: 'Valor da venda é obrigatório.' });
        if (!comprovante) return res.status(400).json({ error: 'Comprovante (PDF Base64) é obrigatório.' });

        form.set('veiculo[placa]', placa);
        form.set('veiculo[renavam]', renavam);
        form.set('veiculo[ano_fabricacao]', (params?.['veiculo.ano_fabricacao'] || '').trim());
        form.set('veiculo[ano_modelo]', (params?.['veiculo.ano_modelo'] || '').trim());
        form.set('veiculo[numero_crv]', (params?.['veiculo.numero_crv'] || '').trim());
        form.set('veiculo[data_emissao_crv]', (params?.['veiculo.data_emissao_crv'] || '').trim());
        form.set('veiculo[n_via_crv]', (params?.['veiculo.n_via_crv'] || '').trim());
        form.set('veiculo[cod_seguranca_crv]', (params?.['veiculo.cod_seguranca_crv'] || '').trim());
        form.set('veiculo[uf]', veiculoUf);
        form.set('vendedor[nome]', vendedorNome);
        form.set('vendedor[documento]', vendedorDocumento);
        form.set('vendedor[cidade]', (params?.['vendedor.cidade'] || '').trim());
        form.set('vendedor[uf]', (params?.['vendedor.uf'] || '').trim().toUpperCase());
        form.set('comprador[nome]', compradorNome);
        form.set('comprador[documento]', compradorDocumento);
        form.set('comprador[endereco][cep]', (params?.['comprador.endereco.cep'] || '').replace(/\D/g, ''));
        form.set('comprador[endereco][logradouro]', (params?.['comprador.endereco.logradouro'] || '').trim());
        form.set('comprador[endereco][numero]', (params?.['comprador.endereco.numero'] || '').trim());
        form.set('comprador[endereco][bairro]', (params?.['comprador.endereco.bairro'] || '').trim());
        form.set('comprador[endereco][complemento]', (params?.['comprador.endereco.complemento'] || '').trim());
        form.set('comprador[endereco][uf]', (params?.['comprador.endereco.uf'] || '').trim().toUpperCase());
        form.set('comprador[endereco][cidade]', (params?.['comprador.endereco.cidade'] || '').trim());
        form.set('venda[data]', vendaData);
        form.set('venda[valor]', vendaValor);
        form.set('comprovante', comprovante);
        break;
      }
      case 'dc_cancelar_comunicado_venda': {
        const placa = (params?.placa || '').trim();
        const renavam = (params?.renavam || '').replace(/\D/g, '');
        const numero_crv = (params?.numero_crv || '').trim();
        const num_transacao = (params?.num_transacao || '').trim();
        const motivo_cancelamento = (params?.motivo_cancelamento || '').trim();
        if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
        if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
        if (!num_transacao) return res.status(400).json({ error: 'Número da transação é obrigatório.' });
        if (!motivo_cancelamento) return res.status(400).json({ error: 'Motivo do cancelamento é obrigatório.' });
        form.set('placa', placa);
        form.set('renavam', renavam);
        if (numero_crv) form.set('numero_crv', numero_crv);
        form.set('num_transacao', num_transacao);
        form.set('motivo_cancelamento', motivo_cancelamento);
        break;
      }
      default:
        return res.status(400).json({ error: 'Tipo de entrada não suportado.' });
    }

    let apiRes, apiData;
    try {
      apiRes = await fetch(`${DATACUBE_API_URL}${service.dcPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      apiData = await apiRes.json().catch(() => null);
    } catch (e) {
      console.error(`Erro na API Datacube [${serviceId}]:`, e.message);
      return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
    }

    if (!apiRes.ok || !apiData || apiData.status === false) {
      const errMsg = apiData ? extractApiErrorMsg(apiData) : `Erro HTTP ${apiRes.status}.`;
      console.error(`Erro API Datacube [${serviceId}] HTTP ${apiRes.status}: ${errMsg}`);
      return res.status(apiRes.status && apiRes.status >= 400 ? apiRes.status : 502).json({ error: errMsg });
    }

    let resultV2 = apiData.result ?? apiData;
    let pdfBase64 = null;
    if (service.returnsPdf) {
      const found = findAndStripBase64Pdf(resultV2);
      if (found.pdf) { pdfBase64 = found.pdf; resultV2 = found.data; }
      // documentos-crlve-rj-flash é documentado como assíncrono (pode devolver só
      // um request_uid/task_id sem o PDF pronto ainda) — nunca cobra sem o
      // documento em mãos.
      if (!pdfBase64) {
        console.error(`[${serviceId}] resposta sem PDF (possível tarefa assíncrona pendente): ${JSON.stringify(apiData)}`);
        return res.status(422).json({ error: 'Documento ainda não está pronto. Tente novamente em alguns instantes.' });
      }
    }

    // Serviços que a upstream responde em JSON mas que o cliente recebe como
    // relatório PDF (ver V2_PDF_BUILDERS). Montado ANTES do débito, igual ao
    // /api/query: consulta vazia ou falha na geração não cobra crédito.
    if (!pdfBase64 && V2_PDF_BUILDERS[serviceId]) {
      const temDados = resultV2 && (Array.isArray(resultV2) ? resultV2.length > 0 : Object.keys(resultV2).length > 0);
      if (!temDados) {
        console.error(`[${serviceId}] resposta sem dados para montar o PDF: ${JSON.stringify(apiData)}`);
        return res.status(422).json({ error: 'Nenhum dado encontrado para essa consulta. Nenhum crédito foi debitado.' });
      }
      try {
        const buf = await V2_PDF_BUILDERS[serviceId](service, resultV2, params || {});
        pdfBase64 = buf.toString('base64');
      } catch (e) {
        console.error(`[${serviceId}] falha ao montar o PDF:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF da consulta. Nenhum crédito foi debitado.' });
      }
    }

    await debitarConsulta(req.user.id, price);
    const txRow = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
      [req.user.id, price, `Consulta: ${service.name} (Opção 2)`]
    );
    const qRow = await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type, result_data)
       VALUES ($1,$2,$3,$4,'success',$5,$6,$7,$8) RETURNING id`,
      [req.user.id, service.id, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id,
       pdfBase64 ? 'pdf' : 'json', JSON.stringify(resultV2)]
    );

    let pdfToken = null;
    if (pdfBase64) {
      pdfToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, req.user.id, pdfToken, pdfBase64, expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache (v2):', e.message));
    }

    return res.json({ success: true, result: resultV2, charged: price, ...(pdfToken ? { pdf_token: pdfToken } : {}) });
  } catch (err) {
    console.error('Erro em /api/query-v2:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/query-v3 (API Infosimples — aba "Infosimples Nova Consulta") ────
// Fluxo genérico e isolado dos demais /api/query*: os parâmetros de cada
// consulta vêm do próprio catálogo (SERVICES_V3, gerado a partir do OpenAPI da
// Infosimples), então a validação aqui é só "campo obrigatório preenchido" —
// não existe um switch por inputType como em SERVICES_V2/Datacube porque a
// Infosimples já declara nome/obrigatoriedade de cada parâmetro no spec.
app.post('/api/query-v3', requireAuth, async (req, res) => {
  const { serviceId, params } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Serviço não informado.' });

  const service = SERVICES_V3.find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });

  const price = parseFloat((service.basePrice * INFOSIMPLES_MARKUP).toFixed(2));

  try {
    const ur = await pool.query('SELECT id, credits, active, pos_pago, pos_pago_limite FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    const bloqueio = await bloqueioPagamentoConsulta(user.id, user, price);
    if (bloqueio) return res.status(bloqueio.status).json(bloqueio.body);

    for (const p of service.params) {
      const v = (params?.[p.name] ?? '').toString().trim();
      if (p.required && !v) return res.status(400).json({ error: `Campo obrigatório: ${p.label}` });
    }

    const qs = new URLSearchParams({ token: INFOSIMPLES_TOKEN });
    for (const p of service.params) {
      const v = (params?.[p.name] ?? '').toString().trim();
      if (v) qs.set(p.name, v);
    }

    let apiRes, apiData;
    try {
      apiRes = await fetch(`${INFOSIMPLES_API_URL}/${service.path}?${qs.toString()}`, { method: 'POST' });
      apiData = await apiRes.json().catch(() => null);
    } catch (e) {
      console.error(`Erro na API Infosimples [${serviceId}]:`, e.message);
      return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
    }

    if (!apiData || apiData.code !== 200) {
      const errMsg = (apiData && (apiData.errors?.[0] || apiData.code_message)) || `Erro HTTP ${apiRes.status}.`;
      console.error(`Erro API Infosimples [${serviceId}] code ${apiData?.code}: ${errMsg}`);
      return res.status(apiRes.status && apiRes.status >= 400 ? apiRes.status : 502).json({ error: errMsg });
    }

    const result = Array.isArray(apiData.data) ? (apiData.data[0] ?? {}) : (apiData.data ?? {});
    const label = `${service.group} — ${service.name}`;

    await debitarConsulta(req.user.id, price);
    const txRow = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
      [req.user.id, price, `Consulta: ${label} (Infosimples)`]
    );
    await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type, result_data)
       VALUES ($1,$2,$3,$4,'success',$5,$6,'json',$7)`,
      [req.user.id, service.id, label, JSON.stringify(params || {}), price, txRow.rows[0].id, JSON.stringify(result)]
    );

    return res.json({ success: true, result, charged: price });
  } catch (err) {
    console.error('Erro em /api/query-v3:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── API externa /api/v1 (autenticada por chave de API) ────────────────────────
// Preço fixo por consulta na API externa — não segue a tabela Infosimples nem
// o markup do painel; valor comercial definido para os contratos de API.
const EXTERNAL_API_PRICE = 5.00;

// Preço por serviço nas rotas de API externa que aceitam chave Geral (pós-paga)
// e aparecem em Cobranças API — ATPV-e MG/SP (cadastrar) usa o preço fixo padrão acima; CRLV 2
// Rio Reemissão (fora do SERVICES_V3, via Vistocar) tem preço comercial próprio
// (ver CRLV_RJ_REEMISSAO_2_API_PRICE / runCrlvRj2General).
function externalApiPriceFor(serviceId) {
  return serviceId === 'crlv-rj-reemissao-2' ? CRLV_RJ_REEMISSAO_2_API_PRICE : EXTERNAL_API_PRICE;
}


// ── Gestão de chaves de API (admin) ───────────────────────────────────────────
// A API é contratual (sem self-service, ver seção API da landing page): o admin
// cria a chave já vinculada à conta do cliente que será debitada nas consultas.
app.post('/api/admin/api-keys', requireAuth, requireSuperAdmin, async (req, res) => {
  // Dois modos: com user_id (chave pré-paga, debita a conta do cliente) ou
  // general:true (chave GERAL pós-paga, sem usuário — cobrança via WhatsApp
  // na página Cobranças API).
  const isGeneral = req.body?.general === true;
  const userId = parseInt(req.body?.user_id, 10);
  const label  = (req.body?.label || '').trim().slice(0, 100);
  if (!isGeneral && (!Number.isInteger(userId) || userId <= 0))
    return res.status(400).json({ error: 'Informe o user_id do cliente ou marque como chave geral.' });
  if (isGeneral && !label)
    return res.status(400).json({ error: 'Informe uma identificação para a chave geral.' });
  try {
    let user = null;
    if (!isGeneral) {
      const u = await pool.query('SELECT id, name, email FROM users WHERE id=$1', [userId]);
      if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
      user = u.rows[0];
    }

    const key = 'mcd_' + crypto.randomBytes(24).toString('hex');
    const r = await pool.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [isGeneral ? null : userId, hashApiKey(key), key.slice(0, 12), label || null]
    );
    res.json({
      success: true,
      id: r.rows[0].id,
      api_key: key,
      user,
      general: isGeneral,
      aviso: 'Guarde esta chave agora: por segurança ela não poderá ser exibida novamente.',
    });
  } catch (e) {
    console.error('Erro ao criar chave de API:', e.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

app.get('/api/admin/api-keys', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT k.id, k.key_prefix, k.label, k.active, k.last_used_at, k.created_at,
             u.id AS user_id, u.name AS user_name, u.email AS user_email
        FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
       ORDER BY k.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

app.put('/api/admin/api-keys/:id/toggle', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE api_keys SET active = NOT active WHERE id=$1 RETURNING id, active',
      [parseInt(req.params.id, 10)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Chave não encontrada.' });
    res.json({ success: true, active: r.rows[0].active });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── Cobranças API (consultas da chave geral, pós-pagas) ───────────────────────
// Cada consulta feita com chave geral aparece aqui com a placa; o admin digita
// o WhatsApp do cliente final e o sistema envia o PIX de R$ 5,00 (QR Code como
// imagem + copia e cola como texto) referente àquela consulta específica.
app.get('/api/admin/api-cobrancas', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT q.id, q.service_id, q.params, q.charge_phone, q.charge_status,
             q.charge_sent_at, q.created_at, k.label AS key_label, k.key_prefix
        FROM api_general_queries q
        LEFT JOIN api_keys k ON k.id = q.api_key_id
       ORDER BY q.created_at DESC LIMIT 500
    `);
    res.json(r.rows.map(q => {
      let p = {};
      try { p = JSON.parse(q.params || '{}'); } catch {}
      return {
        id: q.id, service_id: q.service_id, key_label: q.key_label, key_prefix: q.key_prefix,
        placa: p.placa || null, renavam: p.renavam || null,
        charge_phone: q.charge_phone, charge_status: q.charge_status,
        charge_sent_at: q.charge_sent_at, created_at: q.created_at,
        price: externalApiPriceFor(q.service_id),
      };
    }));
  } catch {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

app.post('/api/admin/api-cobrancas/:id/cobrar', requireAuth, requireSuperAdmin, async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  let phone = (req.body?.telefone || '').replace(/\D/g, '');
  try {
    const qr = await pool.query('SELECT * FROM api_general_queries WHERE id=$1', [id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Consulta não encontrada.' });
    const q = qr.rows[0];
    if (q.charge_status === 'PAID') return res.status(400).json({ error: 'Esta consulta já foi paga.' });
    // Reenvio sem telefone no corpo: reutiliza o número da cobrança anterior.
    if (!phone) phone = q.charge_phone || '';
    if (phone.length < 10 || phone.length > 13)
      return res.status(400).json({ error: 'Telefone inválido. Informe DDD + número (ex.: 22999951574).' });

    let placa = '';
    try { placa = (JSON.parse(q.params || '{}').placa || '').toUpperCase(); } catch {}
    // Registro antigo de ATPV-e da API externa (rota removida): o id não existe
    // em catálogo nenhum, então vira nome amigável aqui para não aparecer cru.
    const svcName = (/^atpve-[a-z]{2}$/.test(q.service_id)
        ? `ATPV-e ${q.service_id.replace('atpve-', '').toUpperCase()} — Cadastrar`
        : null)
      || SERVICES_V3.find(s => s.id === q.service_id)?.name
      || SERVICES.find(s => s.id === q.service_id)?.name || q.service_id;
    const price = externalApiPriceFor(q.service_id);

    const payment = await mpReq('POST', '/v1/payments', {
      transaction_amount: price,
      description: `Consulta API — ${svcName}${placa ? ' ' + placa : ''}`,
      payment_method_id: 'pix',
      payer: { email: `cliente-${phone}@despachantesconsultas.com.br`, first_name: 'Cliente', last_name: 'API' },
    }, { 'X-Idempotency-Key': crypto.randomUUID() });

    const txData = payment.point_of_interaction?.transaction_data || {};
    if (!txData.qr_code) throw new Error('Mercado Pago não retornou o QR Code PIX.');

    await pool.query(
      `UPDATE api_general_queries
          SET charge_phone=$1, charge_gateway_id=$2, charge_status='PENDING', charge_sent_at=NOW()
        WHERE id=$3`,
      [phone, String(payment.id), id]
    );

    const caption = [
      `💳 *PIX de ${fmtMoneyBRL(price)} — MC Despachadoria*`,
      `🧾 Serviço: ${svcName}`,
      ...(placa ? [`🔤 Placa: ${placa}`] : []),
      ``,
      `Escaneie o QR Code acima ou use o código copia e cola enviado na próxima mensagem.`,
    ].join('\n');
    const enviado = await sendWhatsAppImage(phone, txData.qr_code_base64, caption).catch(() => false);
    // Mensagem de texto com a placa da cobrança — garante que a identificação
    // chega por escrito mesmo se a legenda da imagem não for exibida; o código
    // copia e cola vai sozinho na mensagem seguinte para facilitar a cópia.
    const detalhes = [
      ...(placa ? [`🔤 *Placa: ${placa}*`] : []),
      `🧾 ${svcName}`,
      `💰 Valor: ${fmtMoneyBRL(price)}`,
      ``,
      `👇 Código PIX copia e cola:`,
    ].join('\n');
    await sendWhatsApp(phone, detalhes).catch(() => {});
    await sendWhatsApp(phone, txData.qr_code).catch(() => {});

    res.json({ success: true, whatsappEnviado: enviado });
  } catch (e) {
    console.error('Erro ao cobrar consulta API:', e.message);
    await alertAdminPixFalha(e, 'Cobrança API (painel admin)');
    res.status(500).json({ error: e.message || 'Erro ao gerar a cobrança.' });
  }
});

app.post('/api/admin/api-cobrancas/:id/verificar', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const qr = await pool.query('SELECT charge_status, charge_gateway_id FROM api_general_queries WHERE id=$1',
      [parseInt(req.params.id, 10)]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Consulta não encontrada.' });
    const q = qr.rows[0];
    if (q.charge_status === 'PAID') return res.json({ status: 'PAID' });
    if (!q.charge_gateway_id)      return res.json({ status: 'NONE' });

    const mp = await mpReq('GET', `/v1/payments/${q.charge_gateway_id}`);
    if (mp.status === 'approved') {
      await pool.query(`UPDATE api_general_queries SET charge_status='PAID' WHERE id=$1`,
        [parseInt(req.params.id, 10)]);
      return res.json({ status: 'PAID' });
    }
    res.json({ status: 'PENDING', payment_status: mp.status });
  } catch (e) {
    console.error('Erro ao verificar cobrança API:', e.message);
    res.status(500).json({ error: 'Erro ao verificar o pagamento.' });
  }
});

// Lista os pedidos avulsos no admin — toda consulta paga por PIX fica registrada
// em public_orders (placa, dados enviados, e-mail, pagamento e resultado), com o
// nome do cliente resolvido pelo código de acesso usado.
app.get('/api/admin/public-orders', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.token, o.service_id, o.params, o.amount, o.status, o.error_msg,
              o.contact, o.created_at, o.access_code, c.label AS client_label
         FROM public_orders o
         LEFT JOIN public_access_codes c ON c.code = o.access_code
        ORDER BY o.created_at DESC LIMIT 500`
    );
    res.json(r.rows.map(o => {
      let p = {};
      try { p = JSON.parse(o.params || '{}'); } catch {}
      return {
        id: o.id, token: o.token, service_id: o.service_id, amount: o.amount,
        status: o.status, error_msg: o.error_msg, contact: o.contact, created_at: o.created_at,
        access_code: o.access_code, client_label: o.client_label,
        placa: p.placa || null, renavam: p.renavam || null,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── Códigos de acesso da página avulsa (admin) ────────────────────────────────
// Cada cliente recebe um código próprio: a página /consulta-avulsa só libera os
// formulários com código ativo, e o código usado fica gravado em cada pedido.
function generateAccessCode() {
  // Sem caracteres ambíguos (0/O, 1/I/L) para facilitar a digitação pelo cliente.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

app.post('/api/admin/access-codes', requireAuth, requireSuperAdmin, async (req, res) => {
  const label = (req.body?.label || '').trim().slice(0, 100);
  if (!label) return res.status(400).json({ error: 'Informe o nome do cliente.' });
  try {
    let code, inserted = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = generateAccessCode();
      inserted = await pool.query(
        `INSERT INTO public_access_codes (code, label) VALUES ($1,$2)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [code, label]
      ).then(r => r.rows[0] || null);
    }
    if (!inserted) return res.status(500).json({ error: 'Não foi possível gerar o código. Tente novamente.' });
    res.json({ success: true, id: inserted.id, code, label });
  } catch (e) {
    console.error('Erro ao criar código de acesso:', e.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

app.get('/api/admin/access-codes', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, code, label, active, uses, last_used_at, created_at
         FROM public_access_codes ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

app.put('/api/admin/access-codes/:id/toggle', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE public_access_codes SET active = NOT active WHERE id=$1 RETURNING id, active',
      [parseInt(req.params.id, 10)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Código não encontrado.' });
    res.json({ success: true, active: r.rows[0].active });
  } catch {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── Consulta avulsa (pública, paga por PIX — sem cadastro) ────────────────────
// O visitante preenche os dados, paga um PIX de valor fixo e a consulta só é
// executada na Infosimples depois do pagamento ser aprovado no Mercado Pago —
// mesma regra do restante do sistema: nunca consultar sem receber.
const PUBLIC_PAY_SERVICES = {
};

// "Reemissão da ATPVe Com Comunicação de Venda" avulsa — não usa Infosimples
// (ver runPublicAtpveComunicacaoVenda), por isso fica fora do PUBLIC_PAY_SERVICES
// acima (mapa Infosimples-only). Preço fixo, sem markup — cobre despbrasil + 3
// consultas complementares, igual à versão logada (R$120), com margem maior pela
// customização de comprador/vendedor/data.
const PUBLIC_ATPVE_COMUNICACAO_VENDA_ID    = 'atpve-comunicacao-venda';
const PUBLIC_ATPVE_COMUNICACAO_VENDA_PRICE = 140.00;

async function callInfosimples(service, params) {
  const qs = new URLSearchParams({ token: INFOSIMPLES_TOKEN });
  for (const p of service.params) {
    const v = (params?.[p.name] ?? '').toString().trim();
    if (v) qs.set(p.name, v);
  }
  const apiRes  = await fetch(`${INFOSIMPLES_API_URL}/${service.path}?${qs.toString()}`, { method: 'POST' });
  const apiData = await apiRes.json().catch(() => null);
  if (!apiData || apiData.code !== 200) {
    const errMsg = (apiData && (apiData.errors?.[0] || apiData.code_message)) || `Erro HTTP ${apiRes.status}.`;
    return { ok: false, errMsg };
  }
  return { ok: true, result: Array.isArray(apiData.data) ? (apiData.data[0] ?? {}) : (apiData.data ?? {}) };
}

// Valida o código de acesso do cliente — usado pela página antes de liberar os
// formulários. Não conta uso: o incremento acontece só na criação do pedido.
app.post('/api/public/validar-codigo', async (req, res) => {
  const codigo = (req.body?.codigo || '').trim().toUpperCase();
  if (!codigo) return res.status(400).json({ error: 'Informe o código de acesso.' });
  try {
    const r = await pool.query(
      'SELECT label FROM public_access_codes WHERE code=$1 AND active=true', [codigo]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Código de acesso inválido ou desativado.' });
    res.json({ ok: true, cliente: r.rows[0].label });
  } catch {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Validação do pedido avulso — igual para PIX e para cartão de débito, por isso
// vive fora das rotas. Devolve { erro: { status, msg } } ou os dados já limpos.
// Nada é cobrado antes disso passar: serviço do catálogo público, código de
// acesso ativo, e-mail válido e campos obrigatórios do serviço.
async function validarPedidoAvulso(corpo) {
  const { servico, email, params, codigo } = corpo || {};
  const isAtpveComunicacaoVenda = servico === PUBLIC_ATPVE_COMUNICACAO_VENDA_ID;

  let serviceId, service, valor, description;
  if (isAtpveComunicacaoVenda) {
    serviceId = PUBLIC_ATPVE_COMUNICACAO_VENDA_ID;
    valor = PUBLIC_ATPVE_COMUNICACAO_VENDA_PRICE;
    description = 'Consulta avulsa — Reemissão da ATPVe Com Comunicação de Venda';
  } else {
    serviceId = PUBLIC_PAY_SERVICES[servico];
    if (!serviceId) return { erro: { status: 400, msg: 'Serviço inválido.' } };
    service = SERVICES_V3.find(s => s.id === serviceId);
    if (!service) return { erro: { status: 500, msg: 'Serviço não configurado.' } };
    valor = EXTERNAL_API_PRICE;
    description = `Consulta avulsa — ${service.name}`;
  }

  // Página restrita por código de acesso por cliente — sem código ativo não cobra.
  const accessCode = (codigo || '').trim().toUpperCase();
  if (!accessCode) return { erro: { status: 401, msg: 'Informe o código de acesso.' } };
  const ac = await pool.query(
    'SELECT id FROM public_access_codes WHERE code=$1 AND active=true', [accessCode]
  ).catch(() => ({ rows: [] }));
  if (!ac.rows.length) return { erro: { status: 401, msg: 'Código de acesso inválido ou desativado.' } };

  const mail = (email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))
    return { erro: { status: 400, msg: 'Informe um e-mail válido para o pagamento.' } };

  if (isAtpveComunicacaoVenda) {
    const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
    if (placa.length !== 7)
      return { erro: { status: 400, msg: 'Placa inválida. Informe no formato ABC1D23.' } };
  } else {
    const faltando = service.params
      .filter(p => p.required && !(params?.[p.name] ?? '').toString().trim())
      .map(p => p.label || p.name);
    if (faltando.length)
      return { erro: { status: 400, msg: `Campos obrigatórios ausentes: ${faltando.join(', ')}` } };
  }

  return { serviceId, valor, description, params: params || {}, mail, accessCode, accessCodeId: ac.rows[0].id };
}

// CPF do vendedor/comprador digitado no formulário — o Mercado Pago pede um
// documento no pagador e o cliente avulso não tem cadastro aqui.
const docPedidoAvulso = (params) =>
  (params?.cpf_vendedor || params?.cpf_comprador || '').replace(/\D/g, '');

// Grava o pedido e marca o uso do código de acesso. O "amount" é sempre o preço
// do serviço; no cartão o cobrado (5% maior) vai em charged_amount.
async function registrarPedidoAvulso({ ped, gatewayId, method, chargedAmount }) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO public_orders (token, service_id, params, amount, gateway_id, contact, access_code, method, charged_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [token, ped.serviceId, JSON.stringify(ped.params), ped.valor, String(gatewayId), ped.mail,
     ped.accessCode, method, chargedAmount]
  );
  await pool.query(
    'UPDATE public_access_codes SET uses = uses + 1, last_used_at = NOW() WHERE id=$1',
    [ped.accessCodeId]
  ).catch(() => {});
  return token;
}

app.post('/api/public/pedido', async (req, res) => {
  const ped = await validarPedidoAvulso(req.body);
  if (ped.erro) return res.status(ped.erro.status).json({ error: ped.erro.msg });

  try {
    const payer = { email: ped.mail, first_name: 'Cliente', last_name: 'Consulta Avulsa' };
    const doc = docPedidoAvulso(ped.params);
    if (doc.length === 11) payer.identification = { type: 'CPF', number: doc };

    const payment = await mpReq('POST', '/v1/payments', {
      transaction_amount: ped.valor,
      description: ped.description,
      payment_method_id: 'pix',
      payer,
    }, { 'X-Idempotency-Key': crypto.randomUUID() });

    const txData = payment.point_of_interaction?.transaction_data || {};
    if (!txData.qr_code) throw new Error('Mercado Pago não retornou o QR Code PIX.');

    const token = await registrarPedidoAvulso({ ped, gatewayId: payment.id, method: 'PIX', chargedAmount: ped.valor });

    res.json({
      token,
      valor: ped.valor,
      qrCode: txData.qr_code_base64,
      pixCopiaECola: txData.qr_code,
      expirationDate: payment.date_of_expiration,
    });
  } catch (err) {
    console.error('Erro ao criar pedido avulso:', err.message);
    await alertAdminPixFalha(err, 'Consulta avulsa (/api/public/pedido)');
    res.status(500).json({ error: mpErroAmigavel(err, 'Erro ao gerar o PIX. Tente novamente.') });
  }
});

// ── POST /api/public/pedido/cartao ───────────────────────────────────────────
// Mesmo pedido avulso, pago no cartão de débito com o acréscimo de 5% (ver
// CARTAO_ACRESCIMO). O acompanhamento é o mesmo GET /api/public/pedido/:token
// do PIX: ele pergunta o status do pagamento ao Mercado Pago e só executa a
// consulta depois de aprovado — o que também cobre o intervalo em que o
// pagamento fica pendente esperando o cliente terminar o desafio do 3DS.
app.post('/api/public/pedido/cartao', async (req, res) => {
  const ped = await validarPedidoAvulso(req.body);
  if (ped.erro) return res.status(ped.erro.status).json({ error: ped.erro.msg });

  try {
    const cartao = await validarCartao(req.body);
    const valorCobrado = valorComAcrescimoCartao(ped.valor, cartao.tipo);

    const pagamento = await criarPagamentoCartao({
      valorCobrado,
      descricao: ped.description,
      cartao,
      payer: payerCartao({
        email: ped.mail,
        nome: 'Cliente Consulta Avulsa',
        docCadastro: docPedidoAvulso(ped.params),
        identificationBrick: req.body?.payer?.identification,
      }),
    });

    // Recusa do emissor não vira pedido: nada foi cobrado e o cliente pode
    // tentar outro cartão ou o PIX sem ficar com um pedido órfão no banco.
    if (pagamento.status === 'rejected')
      return res.status(402).json({ error: cartaoRecusaMsg(pagamento), statusDetail: pagamento.status_detail });

    const token = await registrarPedidoAvulso({
      ped, gatewayId: pagamento.id, method: metodoDaTabela(cartao.tipo), chargedAmount: valorCobrado,
    });

    res.json({ token, valor: ped.valor, chargedValue: valorCobrado, ...respostaPagamentoCartao(pagamento) });
  } catch (err) {
    if (err.entradaInvalida) return res.status(400).json({ error: err.message });
    console.error('Erro ao criar pedido avulso no cartão:', err.message);
    await alertAdminPixFalha(err, 'Consulta avulsa no cartão (/api/public/pedido/cartao)');
    res.status(500).json({ error: mpErroAmigavel(err, 'Erro ao processar o pagamento no cartão.') });
  }
});

// Marca o pedido avulso como erro e tenta estornar o PIX automaticamente — o
// cliente pagou mas a consulta não saiu, então não deve ficar cobrado por algo
// que não recebeu. Falha no estorno (rede, PIX fora do prazo de estorno etc.)
// não trava a resposta: o pedido fica ERROR com aviso pra procurar o suporte.
async function failPublicOrderAndRefund(order, errMsg) {
  let refunded = false;
  try {
    await mpRefundPayment(order.gateway_id);
    refunded = true;
  } catch (refundErr) {
    console.error(`Falha ao estornar PIX do pedido avulso ${order.token}:`, refundErr.message);
  }
  const finalMsg = refunded
    ? `${errMsg} O valor pago foi estornado automaticamente para o seu PIX.`
    : `${errMsg} Não foi possível estornar automaticamente — entre em contato com o suporte informando o número do pedido.`;
  await pool.query(
    `UPDATE public_orders SET status='ERROR', error_msg=$1, refund_status=$2 WHERE id=$3`,
    [finalMsg, refunded ? 'REFUNDED' : 'FAILED', order.id]
  );
  return { status: 'ERROR', error: finalMsg, refunded };
}

// Polling do pedido: confirma o pagamento no Mercado Pago e executa a consulta.
// A execução é reivindicada com UPDATE ... WHERE status='PENDING' (lock de linha
// do Postgres), então polling concorrente ou duplicado nunca consulta duas vezes.
app.get('/api/public/pedido/:token', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM public_orders WHERE token=$1', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const order = r.rows[0];

    if (order.status === 'DONE')  return res.json({ status: 'DONE', result: JSON.parse(order.result_data || '{}') });
    if (order.status === 'ERROR') return res.json({ status: 'ERROR', error: order.error_msg || 'Erro ao processar a consulta.' });
    if (order.status === 'PAID')  return res.json({ status: 'PROCESSING' });

    const mp = await mpReq('GET', `/v1/payments/${order.gateway_id}`);
    if (mp.status !== 'approved') return res.json({ status: 'PENDING', payment_status: mp.status });

    const claim = await pool.query(
      `UPDATE public_orders SET status='PAID' WHERE id=$1 AND status='PENDING' RETURNING id`,
      [order.id]
    );
    if (!claim.rows.length) return res.json({ status: 'PROCESSING' });

    const params = JSON.parse(order.params || '{}');

    if (order.service_id === PUBLIC_ATPVE_COMUNICACAO_VENDA_ID) {
      try {
        const pdfBuf = await runPublicAtpveComunicacaoVenda(params);
        const resultPayload = { pdf_base64: pdfBuf.toString('base64') };
        await pool.query(`UPDATE public_orders SET status='DONE', result_data=$1 WHERE id=$2`,
          [JSON.stringify(resultPayload), order.id]);
        return res.json({ status: 'DONE', result: resultPayload });
      } catch (e) {
        console.error('Erro ao processar ATPVe com comunicação de venda avulsa:', e.message);
        return res.json(await failPublicOrderAndRefund(order, e.message));
      }
    }

    const service = SERVICES_V3.find(s => s.id === order.service_id);
    try {
      const out = await callInfosimples(service, params);
      if (out.ok) {
        await pool.query(`UPDATE public_orders SET status='DONE', result_data=$1 WHERE id=$2`,
          [JSON.stringify(out.result), order.id]);
        return res.json({ status: 'DONE', result: out.result });
      }
      return res.json(await failPublicOrderAndRefund(order, out.errMsg));
    } catch (e) {
      return res.json(await failPublicOrderAndRefund(order, 'Erro ao processar a consulta após o pagamento.'));
    }
  } catch (err) {
    console.error('Erro no status do pedido avulso:', err.message);
    res.status(500).json({ error: 'Erro ao verificar o pedido.' });
  }
});

// ── PUT /api/profile/password ─────────────────────────────────────────────────
app.put('/api/profile/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  if (new_password.length < 8)
    return res.status(400).json({ error: 'Nova senha deve ter ao menos 8 caracteres.' });
  try {
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const ok = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta.' });
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

app.get('/api/chave/diagnostico', requireAuth, async (req, res) => {
  const raw = (process.env.PORTAL_DESP_KEY || '');
  res.json({
    tamanho: raw.length,
    inicio: raw.slice(0, 10) + '...',
    fim: '...' + raw.slice(-6),
    temMaisOuBarra: raw.includes('+') || raw.includes('/'),
    charsInvalidos: raw.split('').filter(c => c.charCodeAt(0) > 127).length,
  });
});

// ── Cartão de débito (Checkout Bricks do Mercado Pago) ───────────────────────
// O PIX não tem taxa para nós; o cartão tem. Por isso todo pagamento que NÃO é
// PIX sai 5% mais caro, e esse acréscimo é calculado SEMPRE aqui no servidor —
// o front só exibe o valor, nunca o define.
//
// O número do cartão não passa por este servidor em momento algum: quem coleta
// é o Card Payment Brick, cujos campos são iframes do próprio Mercado Pago. O
// que chega aqui é o "token" de uso único que o SDK devolve. Por isso também o
// celular consegue oferecer o escaneamento do cartão pela câmera (o campo do
// número do brick é marcado com autocomplete="cc-number"): a leitura vai da
// câmera do sistema direto para o campo do MP, sem passar pelo nosso código.
// Acréscimo por tipo de cartão, indexado pelo payment_type_id do Mercado Pago.
// Crédito custa mais que débito na taxa do gateway, por isso os 7% contra 5%.
// Quem manda é a chave desta tabela: o que não estiver aqui não é cobrado no
// cartão (pré-pago, voucher, saldo em conta etc. ficam de fora).
const CARTAO_ACRESCIMOS = { debit_card: 0.05, credit_card: 0.07 };
// Interruptor do que a casa QUER oferecer, independente do que a conta do
// Mercado Pago suportaria. Hoje o débito está desligado por decisão: a conta
// não tem débito habilitado e, sem isso, todo cartão de débito volta do MP com
// a bandeira de crédito e o cliente levava uma recusa dizendo que o cartão dele
// é de crédito. Quando o MP habilitar, ligar aqui é trocar false por true — o
// que a conta suporta continua sendo conferido por mpTiposCartaoDisponiveis, e
// vale o E das duas coisas.
const CARTAO_TIPOS_HABILITADOS = { debito: false, credito: true };
// Parcelamento no crédito, com JUROS DO COMPRADOR: o Mercado Pago soma o juro
// por cima, na fatura do cliente, e nós continuamos recebendo o mesmo
// transaction_amount (o valor à vista com os 7%). Por isso o número de parcelas
// não muda nada do nosso lado — nem o acréscimo, nem o crédito liberado. A
// tabela de juros é do MP, vai até 18x e varia por bandeira/emissor; quem a exibe é o
// próprio formulário, com os textos que a API devolve. Débito é sempre 1x.
const CARTAO_MAX_PARCELAS = 18;
const CARTAO_TIPOS = { debito: 'debit_card', credito: 'credit_card' };
const valorComAcrescimoCartao = (valor, tipo) =>
  Math.round(Number(valor) * (1 + (CARTAO_ACRESCIMOS[tipo] ?? 0)) * 100) / 100;

// Tipos de cartão que a conta do Mercado Pago realmente processa, lidos da
// MESMA fonte que o formulário usa: a busca de meios de pagamento pela public
// key. É diferente da lista do access token — o `debelo` aparece lá como ativo
// e mesmo assim não sai aqui, ou seja, o formulário nunca conseguiria oferecer
// débito com ele.
//
// Isso existe porque oferecer na tela um meio que a conta não processa é pior
// que não oferecer: o cliente digitava um cartão de débito, a bandeira voltava
// como crédito (é o que a conta expõe) e ele levava um "esse cartão é de
// crédito" na cara. Com o menu montado a partir daqui, o botão de débito some
// enquanto a conta não tiver débito habilitado e volta sozinho no dia em que
// tiver — sem mexer em código.
let mpTiposCartaoCache = { emCache: null, quando: 0 };
async function mpTiposCartaoDisponiveis() {
  if (mpTiposCartaoCache.emCache && Date.now() - mpTiposCartaoCache.quando < 3600000)
    return mpTiposCartaoCache.emCache;
  const tipos = { debito: false, credito: false };
  try {
    const r = await fetch(`${MP_BASE}/v1/payment_methods/search?public_key=${encodeURIComponent(MP_PUBLIC_KEY)}&marketplace=NONE`);
    const d = await r.json();
    const lista = Array.isArray(d?.results) ? d.results : (Array.isArray(d) ? d : []);
    for (const m of lista) {
      if (m.payment_type_id === 'debit_card') tipos.debito = true;
      if (m.payment_type_id === 'credit_card') tipos.credito = true;
    }
    if (!lista.length) throw new Error('lista vazia');
    mpTiposCartaoCache = { emCache: tipos, quando: Date.now() };
  } catch (e) {
    // Sem resposta do MP não dá para saber: mantém o crédito (que sempre
    // funcionou) e esconde o débito, em vez de oferecer o que pode falhar.
    console.error('[pagamento] não consegui listar os meios do checkout:', e.message);
    return { debito: false, credito: true };
  }
  return tipos;
}

// A public key é pública por definição (vai no HTML do formulário) — o que não
// pode vazar é o MP_ACCESS_TOKEN, que fica só aqui. Sem a chave configurada o
// front esconde a opção de cartão e segue só com PIX.
app.get('/api/pagamento/config', async (req, res) => {
  const temChaves = Boolean(MP_PUBLIC_KEY && MP_ACCESS_TOKEN);
  const suportados = temChaves ? await mpTiposCartaoDisponiveis() : { debito: false, credito: false };
  // Oferece só o que a casa quer E a conta processa.
  const tipos = {
    debito: suportados.debito && CARTAO_TIPOS_HABILITADOS.debito,
    credito: suportados.credito && CARTAO_TIPOS_HABILITADOS.credito,
  };
  res.json({
    publicKey: MP_PUBLIC_KEY || null,
    cartaoDisponivel: temChaves && (tipos.debito || tipos.credito),
    tipos,
    acrescimos: { debito: CARTAO_ACRESCIMOS.debit_card, credito: CARTAO_ACRESCIMOS.credit_card },
    maxParcelas: CARTAO_MAX_PARCELAS,
  });
});

// Lista de meios de pagamento do Mercado Pago, em cache de 1 hora. É ela que
// diz se o cartão é de crédito ou de débito — e é esse tipo, não o que o
// navegador afirma, que define o acréscimo cobrado. Sem isso bastaria montar a
// requisição na mão dizendo "débito" para pagar no crédito com 5%.
let mpMetodosCache = { emCache: null, quando: 0 };
async function mpMetodosPagamento() {
  if (mpMetodosCache.emCache && Date.now() - mpMetodosCache.quando < 3600000) return mpMetodosCache.emCache;
  const lista = await mpReq('GET', '/v1/payment_methods');
  if (!Array.isArray(lista)) throw new Error('Mercado Pago não devolveu a lista de meios de pagamento.');
  mpMetodosCache = { emCache: lista, quando: Date.now() };
  return lista;
}

// Valida o que veio do brick e devolve os campos do pagamento já limpos, com o
// TIPO real do cartão (debit_card/credit_card) lido da lista do Mercado Pago.
// Erros aqui são de entrada (HTTP 400), não falha de gateway.
//
// O corpo traz "tipo_cartao" com a aba que o cliente escolheu na tela (o que
// define o total que ele viu). Se a bandeira disser outra coisa, o pedido é
// recusado em vez de cobrado: cobrar 7% em quem leu 5% na tela seria pior que
// pedir para escolher a aba certa.
async function validarCartao(corpo) {
  const recusa = (msg) => {
    const e = new Error(msg);
    e.entradaInvalida = true;
    return e;
  };
  const token = String(corpo?.token || '').trim();
  const metodo = String(corpo?.payment_method_id || '').trim();
  if (!token || !metodo) throw recusa('Dados do cartão incompletos. Recarregue a página e tente de novo.');

  // Tipo desligado no interruptor: recusa antes de qualquer chamada ao MP.
  const pedido = String(corpo?.tipo_cartao || '').toLowerCase();
  if (pedido && CARTAO_TIPOS_HABILITADOS[pedido] === false)
    throw recusa(`No momento não estamos aceitando cartão de ${pedido === 'credito' ? 'crédito' : 'débito'}. Pague com PIX (sem acréscimo)${pedido === 'debito' && CARTAO_TIPOS_HABILITADOS.credito ? ' ou no crédito' : ''}.`);

  const metodos = await mpMetodosPagamento();
  const achado = metodos.find(m => m.id === metodo);
  const tipo = achado?.payment_type_id;
  if (!tipo || !CARTAO_ACRESCIMOS[tipo])
    throw recusa('Aceitamos cartão de crédito ou de débito. Para outras formas, use o PIX.');

  const escolhido = CARTAO_TIPOS[String(corpo?.tipo_cartao || '').toLowerCase()];
  if (escolhido && escolhido !== tipo) {
    // Quando o cliente pediu débito e veio crédito, pode não ser o cartão dele:
    // se a conta não tem débito habilitado, TODO cartão de débito chega aqui
    // como crédito. Nesse caso a mensagem manda usar o PIX, em vez de acusar o
    // cartão de ser o que não é.
    const disp = await mpTiposCartaoDisponiveis();
    if (escolhido === 'debit_card' && !(disp.debito && CARTAO_TIPOS_HABILITADOS.debito))
      throw recusa('No momento não estamos aceitando cartão de débito. Pague com PIX (sem acréscimo) ou no crédito.');
    throw recusa(tipo === 'credit_card'
      ? 'Esse cartão é de CRÉDITO. Volte e escolha a opção "Crédito" (acréscimo de 7%).'
      : 'Esse cartão é de DÉBITO. Volte e escolha a opção "Débito" (acréscimo de 5%).');
  }

  // Parcelas: só no crédito e no máximo CARTAO_MAX_PARCELAS. O que chega do
  // navegador é conferido aqui — 24x mandado na mão viraria juro que o cliente
  // não escolheu.
  let installments = parseInt(corpo?.installments, 10);
  if (!Number.isInteger(installments) || installments < 1) installments = 1;
  if (tipo !== 'credit_card') installments = 1;
  if (installments > CARTAO_MAX_PARCELAS)
    throw recusa(`Parcelamento em até ${CARTAO_MAX_PARCELAS}x.`);

  return {
    token,
    payment_method_id: metodo,
    issuer_id: corpo?.issuer_id ? String(corpo.issuer_id) : undefined,
    tipo,
    installments,
  };
}

// Cria o pagamento no Mercado Pago com o token do brick.
//
// three_d_secure_mode 'optional' liga o 3DS 2.0: no débito o emissor quase
// sempre exige o desafio (aquela tela do banco), e sem isso a compra seria
// recusada; no crédito ele só aparece quando o emissor acha necessário.
// Quando o desafio é necessário a resposta volta status 'pending' com
// status_detail 'pending_challenge' e um three_ds_info { external_resource_url,
// creq } — que o front entrega ao Status Screen Brick. Por isso binary_mode
// fica false: com ele ligado o MP recusaria o pagamento em vez de deixá-lo
// pendente esperando o cliente terminar o desafio.
async function criarPagamentoCartao({ valorCobrado, descricao, payer, cartao }) {
  return mpReq('POST', '/v1/payments', {
    transaction_amount: valorCobrado,
    description: descricao,
    token: cartao.token,
    payment_method_id: cartao.payment_method_id,
    ...(cartao.issuer_id ? { issuer_id: cartao.issuer_id } : {}),
    installments: cartao.installments,
    capture: true,
    binary_mode: false,
    three_d_secure_mode: 'optional',
    payer,
  }, { 'X-Idempotency-Key': crypto.randomUUID() });
}

// Rótulo gravado em pix_payments.method / public_orders.method. Fica curto de
// propósito: a coluna é VARCHAR(10) e o histórico já tem 'PIX' e 'CARTAO'
// (débito, do primeiro dia do cartão) gravados.
const metodoDaTabela = (tipo) => (tipo === 'credit_card' ? 'CREDITO' : 'CARTAO');

// Mensagem em português para a recusa do emissor. O status_detail do Mercado
// Pago é em inglês e técnico demais para mostrar a quem está pagando.
const CARTAO_RECUSA_MSGS = {
  cc_rejected_bad_filled_card_number: 'Confira o número do cartão.',
  cc_rejected_bad_filled_date: 'Confira a data de validade do cartão.',
  cc_rejected_bad_filled_security_code: 'Confira o código de segurança (CVV).',
  cc_rejected_bad_filled_other: 'Confira os dados do cartão e tente de novo.',
  cc_rejected_insufficient_amount: 'Saldo insuficiente na conta do cartão.',
  cc_rejected_call_for_authorize: 'O banco pediu que você autorize esse valor. Ligue para o banco e tente de novo.',
  cc_rejected_card_disabled: 'Cartão desativado. Fale com o banco ou use outro cartão.',
  cc_rejected_duplicated_payment: 'Você já fez um pagamento igual a esse. Se precisa pagar de novo, use outro cartão ou o PIX.',
  cc_rejected_high_risk: 'Pagamento recusado por segurança. Use o PIX ou outro cartão.',
  cc_rejected_max_attempts: 'Você atingiu o limite de tentativas com esse cartão. Use outro cartão ou o PIX.',
  cc_rejected_card_error: 'Não foi possível processar esse cartão. Tente de novo ou use o PIX.',
  cc_rejected_blacklist: 'Pagamento recusado por segurança. Use o PIX ou outro cartão.',
};
const cartaoRecusaMsg = (pagamento) =>
  CARTAO_RECUSA_MSGS[pagamento?.status_detail] ||
  'Pagamento recusado pelo emissor do cartão. Tente outro cartão ou pague com PIX.';

// Resposta padrão das rotas de cartão. Três desfechos possíveis:
//  - approved: pago na hora (sem desafio);
//  - pending/in_process: o front monta o desafio 3DS com three_ds_info e depois
//    confirma pelo mesmo polling do PIX;
//  - rejected: recusa do emissor, com mensagem em português.
function respostaPagamentoCartao(pagamento) {
  return {
    paymentId: String(pagamento.id),
    parcelas: pagamento.installments || 1,
    status: pagamento.status,
    statusDetail: pagamento.status_detail,
    threeDs: pagamento.three_ds_info
      ? { externalResourceURL: pagamento.three_ds_info.external_resource_url, creq: pagamento.three_ds_info.creq }
      : null,
  };
}

// Dados do pagador exigidos pelo Mercado Pago no Brasil (e-mail + CPF/CNPJ).
// O documento vem do brick (é o do titular do cartão); o cadastro serve de
// reserva quando o brick não coleta.
function payerCartao({ email, nome, docCadastro, identificationBrick }) {
  const doc = String(identificationBrick?.number || docCadastro || '').replace(/\D/g, '');
  const partes = String(nome || 'Cliente').trim().split(/\s+/);
  return {
    email,
    first_name: partes[0],
    last_name: partes.slice(1).join(' ') || partes[0],
    ...(doc ? { identification: { type: doc.length > 11 ? 'CNPJ' : 'CPF', number: doc } } : {}),
  };
}

// ── POST /api/cartao/recarga ─────────────────────────────────────────────────
// Recarga de créditos no débito. O usuário escolhe quanto quer RECEBER de
// crédito; o cobrado é esse valor + 5%. A linha em pix_payments nasce com
// value = crédito e charged_value = cobrado, então todo o resto do sistema
// (polling, webhook, cron de reconciliação) credita o valor certo sem saber que
// o meio mudou.
app.post('/api/cartao/recarga', requireAuth, async (req, res) => {
  const value = parseFloat(req.body?.value);
  if (!value || value < 5 || value > 10000)
    return res.status(400).json({ error: 'Valor inválido. Mínimo R$ 5,00, máximo R$ 10.000,00.' });

  try {
    const ur = await pool.query('SELECT id, name, email, cpf_cnpj, pos_pago FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (user.pos_pago) return res.status(400).json({ error: RECARGA_POS_PAGO_MSG });

    const cartao = await validarCartao(req.body);
    const valorCobrado = valorComAcrescimoCartao(value, cartao.tipo);

    const pagamento = await criarPagamentoCartao({
      valorCobrado,
      descricao: `Recarga de créditos — ${user.name}`,
      cartao,
      payer: payerCartao({
        email: user.email,
        nome: user.name,
        docCadastro: user.cpf_cnpj,
        identificationBrick: req.body?.payer?.identification,
      }),
    });

    if (pagamento.status === 'rejected')
      return res.status(402).json({ error: cartaoRecusaMsg(pagamento), statusDetail: pagamento.status_detail });

    await pool.query(
      `INSERT INTO pix_payments (user_id, gateway_id, value, status, method, charged_value)
       VALUES ($1,$2,$3,'PENDING',$4,$5) ON CONFLICT (gateway_id) DO NOTHING`,
      [req.user.id, String(pagamento.id), value, metodoDaTabela(cartao.tipo), valorCobrado]
    );

    const out = respostaPagamentoCartao(pagamento);
    out.value = value;
    out.chargedValue = valorCobrado;
    if (pagamento.status === 'approved') {
      const r = await creditPixPaymentIfApproved(String(pagamento.id));
      out.credited = r.credited;
    }
    res.json(out);
  } catch (err) {
    if (err.entradaInvalida) return res.status(400).json({ error: err.message });
    console.error('Erro cartão recarga:', err.message);
    await alertAdminPixFalha(err, 'Recarga no cartão de débito (/api/cartao/recarga)');
    res.status(500).json({ error: mpErroAmigavel(err, 'Erro ao processar o pagamento no cartão.') });
  }
});

// ── POST /api/cartao/assinatura ──────────────────────────────────────────────
// Mesma assinatura de R$ 30,00 do PIX, cobrada com o acréscimo de 5%. O período
// é aberto por creditPixPaymentIfApproved graças ao purpose='ASSINATURA'.
app.post('/api/cartao/assinatura', requireAuth, async (req, res) => {
  try {
    const cartao = await validarCartao(req.body);
    const ur = await pool.query('SELECT id, name, email, cpf_cnpj, active FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });

    const ciclo = await proximoCicloAssinatura(req.user.id);
    const valorAssinatura = precoAssinaturaProRata(ciclo.dias);
    const valorCobrado = valorComAcrescimoCartao(valorAssinatura, cartao.tipo);
    const pagamento = await criarPagamentoCartao({
      valorCobrado,
      descricao: `Assinatura Coisas de Despachantes (${ciclo.dias} dias, até ${fmtDataCicloBR(ciclo.fim)}) — ${user.name}`,
      cartao,
      payer: payerCartao({
        email: user.email,
        nome: user.name,
        docCadastro: user.cpf_cnpj,
        identificationBrick: req.body?.payer?.identification,
      }),
    });

    if (pagamento.status === 'rejected')
      return res.status(402).json({ error: cartaoRecusaMsg(pagamento), statusDetail: pagamento.status_detail });

    await pool.query(
      `INSERT INTO pix_payments (user_id, gateway_id, value, status, purpose, method, charged_value,
                                 periodo_fim, periodo_dias)
       VALUES ($1,$2,$3,'PENDING','ASSINATURA',$4,$5,$6,$7) ON CONFLICT (gateway_id) DO NOTHING`,
      [req.user.id, String(pagamento.id), valorAssinatura, metodoDaTabela(cartao.tipo), valorCobrado,
       ciclo.fim, ciclo.dias]
    );

    const out = respostaPagamentoCartao(pagamento);
    out.value = valorAssinatura;
    out.chargedValue = valorCobrado;
    out.dias = ciclo.dias;
    out.vence = ciclo.fim;
    if (pagamento.status === 'approved') {
      const r = await creditPixPaymentIfApproved(String(pagamento.id));
      out.credited = r.credited;
    }
    res.json(out);
  } catch (err) {
    if (err.entradaInvalida) return res.status(400).json({ error: err.message });
    console.error('Erro cartão assinatura:', err.message);
    await alertAdminPixFalha(err, 'Assinatura no cartão de débito (/api/cartao/assinatura)');
    res.status(500).json({ error: mpErroAmigavel(err, 'Erro ao processar o pagamento no cartão.') });
  }
});

// ── POST /api/pix/criar ───────────────────────────────────────────────────────
app.post('/api/pix/criar', requireAuth, async (req, res) => {
  const value = parseFloat(req.body.value);
  if (!value || value < 5 || value > 10000)
    return res.status(400).json({ error: 'Valor inválido. Mínimo R$ 5,00, máximo R$ 10.000,00.' });

  try {
    const ur = await pool.query(
      'SELECT id, name, email, cpf_cnpj, pos_pago FROM users WHERE id=$1',
      [req.user.id]
    );
    const user = ur.rows[0];
    if (user.pos_pago) return res.status(400).json({ error: RECARGA_POS_PAGO_MSG });

    const doc = (user.cpf_cnpj || '').replace(/\D/g, '');
    const docType = doc.length > 11 ? 'CNPJ' : 'CPF';
    const nameParts = (user.name || 'Cliente').trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ') || firstName;

    const payment = await mpReq('POST', '/v1/payments', {
      transaction_amount: value,
      description: `Recarga de créditos — ${user.name}`,
      payment_method_id: 'pix',
      payer: {
        email: user.email,
        first_name: firstName,
        last_name: lastName,
        identification: { type: docType, number: doc },
      },
    }, { 'X-Idempotency-Key': crypto.randomUUID() });

    const txData = payment.point_of_interaction?.transaction_data || {};
    if (!txData.qr_code) throw new Error('Mercado Pago não retornou o QR Code PIX.');

    await pool.query(
      `INSERT INTO pix_payments (user_id, gateway_id, value, status)
       VALUES ($1,$2,$3,'PENDING') ON CONFLICT (gateway_id) DO NOTHING`,
      [req.user.id, String(payment.id), value]
    );

    res.json({
      paymentId: payment.id,
      qrCode: txData.qr_code_base64,
      pixCopiaECola: txData.qr_code,
      expirationDate: payment.date_of_expiration,
      value,
    });
  } catch (err) {
    console.error('Erro PIX criar:', err.message);
    await alertAdminPixFalha(err, 'Recarga de créditos (/api/pix/criar)');
    res.status(500).json({ error: mpErroAmigavel(err, 'Erro ao criar cobrança PIX.') });
  }
});

// ── GET /api/assinatura/status ────────────────────────────────────────────────
// Consultado pelo painel ao abrir a aba "Coisas de Despachantes" e depois de
// confirmar um PIX, para decidir entre liberar o serviço ou abrir o popup.
app.get('/api/assinatura/status', requireAuth, async (req, res) => {
  try {
    const assinatura = await getAssinaturaVigente(req.user.id);
    // Próximo período (o que o botão "Assinar" vai cobrar): vai até o dia 30 e
    // custa por dia; as cotas saem proporcionais ao mesmo número de dias.
    const ciclo = await proximoCicloAssinatura(req.user.id);
    const proximo = {
      proximoPreco: precoAssinaturaProRata(ciclo.dias),
      proximoDias: ciclo.dias,
      proximoVencimento: ciclo.fim,
      proximoCotas: cotasAssinaturaProRata(ciclo.dias),
      precoCheio: ASSINATURA_PLACAS_PRICE,
      diaVencimento: POS_PAGO_DIA_VENCIMENTO,
    };
    if (!assinatura) {
      return res.json({
        ativa: false,
        preco: proximo.proximoPreco,
        dias: proximo.proximoDias,
        cota: proximo.proximoCotas.placas,
        cotaCrv: proximo.proximoCotas.crv,
        cotaAssinatura: proximo.proximoCotas.assinatura,
        cotaVerificarCrlv: proximo.proximoCotas.verificarCrlv,
        ...proximo,
      });
    }
    // expiraEm null = sem data limite; cota/consultasRestantes null = ilimitada.
    // O painel trata os dois casos (ver renderAssinaturaBanner). A cota do Código
    // de Segurança CRV é contada à parte (cotaCrv/consultasCrvRestantes).
    const ilimitada = assinatura.cota === null;
    const ilimitadaCrv = assinatura.cota_crv === null;
    const ilimitadaAssin = assinatura.cota_assinatura === null;
    const ilimitadaVerif = assinatura.cota_verificar_crlv === null;
    res.json({
      ativa: true,
      indefinida: assinatura.expires_at === null,
      cortesia: assinatura.origem === 'CORTESIA',
      expiraEm: assinatura.expires_at,
      consultasUsadas: assinatura.queries_used,
      consultasRestantes: ilimitada ? null : Math.max(0, assinatura.cota - assinatura.queries_used),
      consultasCrvUsadas: assinatura.queries_used_crv,
      consultasCrvRestantes: ilimitadaCrv ? null : Math.max(0, assinatura.cota_crv - assinatura.queries_used_crv),
      assinaturasUsadas: assinatura.queries_used_assinatura,
      assinaturasRestantes: ilimitadaAssin ? null : Math.max(0, assinatura.cota_assinatura - assinatura.queries_used_assinatura),
      verificarCrlvUsadas: assinatura.queries_used_verificar_crlv,
      verificarCrlvRestantes: ilimitadaVerif ? null : Math.max(0, assinatura.cota_verificar_crlv - assinatura.queries_used_verificar_crlv),
      preco: proximo.proximoPreco,
      dias: proximo.proximoDias,
      ...proximo,
      cota: assinatura.cota,
      cotaCrv: assinatura.cota_crv,
      cotaAssinatura: assinatura.cota_assinatura,
      cotaVerificarCrlv: assinatura.cota_verificar_crlv,
    });
  } catch (err) {
    console.error('Erro em /api/assinatura/status:', err.message);
    res.status(500).json({ error: 'Erro ao consultar a assinatura.' });
  }
});

// ── POST /api/assinatura/pix ──────────────────────────────────────────────────
// Cria a cobrança PIX de R$ 30,00 da Assinatura Coisas de Despachantes. O valor é fixo
// no servidor (nunca vem do corpo da requisição) e a linha nasce com
// purpose='ASSINATURA', que é o que faz creditPixPaymentIfApproved abrir um
// período em vez de creditar saldo. A confirmação reaproveita todo o caminho já
// existente: polling em /api/pix/status/:id, webhook e cron de reconciliação.
app.post('/api/assinatura/pix', requireAuth, async (req, res) => {
  try {
    const ur = await pool.query('SELECT id, name, email, cpf_cnpj, active FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });

    const doc = (user.cpf_cnpj || '').replace(/\D/g, '');
    const docType = doc.length > 11 ? 'CNPJ' : 'CPF';
    const nameParts = (user.name || 'Cliente').trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ') || firstName;

    // O período vai até o dia 30 e o preço acompanha os dias (ver
    // cicloAssinatura). Quem renova antes de vencer compra o ciclo seguinte.
    const ciclo = await proximoCicloAssinatura(req.user.id);
    const valorAssinatura = precoAssinaturaProRata(ciclo.dias);

    const payment = await mpReq('POST', '/v1/payments', {
      transaction_amount: valorAssinatura,
      description: `Assinatura Coisas de Despachantes (${ciclo.dias} dias, até ${fmtDataCicloBR(ciclo.fim)}) — ${user.name}`,
      payment_method_id: 'pix',
      payer: {
        email: user.email,
        first_name: firstName,
        last_name: lastName,
        identification: { type: docType, number: doc },
      },
    }, { 'X-Idempotency-Key': crypto.randomUUID() });

    const txData = payment.point_of_interaction?.transaction_data || {};
    if (!txData.qr_code) throw new Error('Mercado Pago não retornou o QR Code PIX.');

    await pool.query(
      `INSERT INTO pix_payments (user_id, gateway_id, value, status, purpose, periodo_fim, periodo_dias)
       VALUES ($1,$2,$3,'PENDING','ASSINATURA',$4,$5) ON CONFLICT (gateway_id) DO NOTHING`,
      [req.user.id, String(payment.id), valorAssinatura, ciclo.fim, ciclo.dias]
    );

    res.json({
      paymentId: payment.id,
      qrCode: txData.qr_code_base64,
      pixCopiaECola: txData.qr_code,
      expirationDate: payment.date_of_expiration,
      value: valorAssinatura,
      dias: ciclo.dias,
      vence: ciclo.fim,
    });
  } catch (err) {
    console.error('Erro ao criar PIX da assinatura:', err.message);
    await alertAdminPixFalha(err, 'Assinatura de placas (/api/assinatura/pix)');
    res.status(500).json({ error: mpErroAmigavel(err, 'Erro ao criar a cobrança PIX da assinatura.') });
  }
});

// ── GET /api/pos-pago/resumo ─────────────────────────────────────────────────
// Tudo que a aba "Conta Pós-paga" do painel mostra: o ciclo corrente, as faturas
// fechadas esperando pagamento e as consultas que compõem o ciclo. A virada de
// ciclo acontece aqui dentro (resumoPosPago → garantirCicloPosPago), então
// abrir a tela já mostra a situação do dia, sem depender de cron.
app.get('/api/pos-pago/resumo', requireAuth, async (req, res) => {
  try {
    const pp = await resumoPosPago(req.user.id);
    if (!pp.posPago) return res.json({ posPago: false });

    const itens = pp.fatura ? await pool.query(
      `SELECT id, service_id, amount, created_at, status FROM queries
        WHERE user_id=$1 AND created_at >= $2 AND amount > 0 AND status <> 'estornado'
        ORDER BY created_at DESC LIMIT 200`,
      [req.user.id, pp.fatura.periodo_inicio]
    ) : { rows: [] };

    res.json({
      posPago: true,
      desde: pp.desde,
      limite: pp.limite,
      carenciaDias: POS_PAGO_CARENCIA_DIAS,
      diaVencimento: POS_PAGO_DIA_VENCIMENTO,
      emAberto: pp.emAberto,
      devido: pp.devido,
      bloqueado: pp.bloqueado,
      fatura: pp.fatura && {
        id: pp.fatura.id,
        valor: parseFloat(pp.fatura.valor),
        periodo_inicio: pp.fatura.periodo_inicio,
        vencimento: pp.fatura.vencimento,
      },
      fechadas: pp.fechadas.map(f => ({
        id: f.id, valor: parseFloat(f.valor), vencimento: f.vencimento,
        vencida: new Date(f.vencimento) < new Date(),
      })),
      itens: itens.rows.map(q => ({
        id: q.id,
        servico: (SERVICES.find(s => s.id === q.service_id) || {}).name || q.service_id,
        valor: parseFloat(q.amount),
        data: q.created_at,
      })),
    });
  } catch (e) {
    console.error('Erro no resumo do pós-pago:', e.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── POST /api/pos-pago/pix ───────────────────────────────────────────────────
// Cobrança PIX da fatura. O valor NUNCA vem do corpo: é a soma das faturas em
// aberto no servidor. Antes de gerar o QR, a fatura do ciclo corrente é fechada
// (fecharFaturaParaCobranca) — assim o valor fica congelado e uma consulta
// feita com o QR na tela entra no ciclo seguinte, em vez de ficar sem cobrança.
// Pagar adiantado não muda o dia 30: o vencimento da fatura nova é o mesmo de
// sempre. A confirmação reaproveita /api/pix/status/:id, o webhook e o cron.
app.post('/api/pos-pago/pix', requireAuth, async (req, res) => {
  try {
    const ur = await pool.query(
      'SELECT id, name, email, cpf_cnpj, active, pos_pago FROM users WHERE id=$1', [req.user.id]
    );
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    if (!user.pos_pago) return res.status(400).json({ error: 'Sua conta não é pós-paga.' });

    await fecharFaturaParaCobranca(req.user.id);
    const pend = await pool.query(
      `SELECT id, valor FROM faturas WHERE user_id=$1 AND status='FECHADA' ORDER BY vencimento ASC`,
      [req.user.id]
    );
    const total = parseFloat(pend.rows.reduce((s, f) => s + parseFloat(f.valor), 0).toFixed(2));
    if (!pend.rows.length || total <= 0)
      return res.status(400).json({ error: 'Não há nada a pagar neste momento.' });

    const doc = (user.cpf_cnpj || '').replace(/\D/g, '');
    const nameParts = (user.name || 'Cliente').trim().split(/\s+/);
    const payment = await mpReq('POST', '/v1/payments', {
      transaction_amount: total,
      description: `Fatura MC Despachadoria — ${user.name}`,
      payment_method_id: 'pix',
      payer: {
        email: user.email,
        first_name: nameParts[0],
        last_name: nameParts.slice(1).join(' ') || nameParts[0],
        identification: { type: doc.length > 11 ? 'CNPJ' : 'CPF', number: doc },
      },
    }, { 'X-Idempotency-Key': crypto.randomUUID() });

    const txData = payment.point_of_interaction?.transaction_data || {};
    if (!txData.qr_code) throw new Error('Mercado Pago não retornou o QR Code PIX.');

    await pool.query(
      `INSERT INTO pix_payments (user_id, gateway_id, value, status, purpose)
       VALUES ($1,$2,$3,'PENDING','FATURA') ON CONFLICT (gateway_id) DO NOTHING`,
      [req.user.id, String(payment.id), total]
    );
    // Carimba o PIX nas faturas cobradas: é por ele que a baixa acha quais
    // quitar quando o pagamento aprova. QR abandonado só deixa o carimbo velho
    // para trás — a próxima tentativa sobrescreve, e a baixa tem um plano B
    // (ver o purpose FATURA em creditPixPaymentIfApproved).
    await pool.query(
      `UPDATE faturas SET gateway_id=$1 WHERE id = ANY($2::int[])`,
      [String(payment.id), pend.rows.map(f => f.id)]
    );

    res.json({
      paymentId: payment.id,
      qrCode: txData.qr_code_base64,
      pixCopiaECola: txData.qr_code,
      expirationDate: payment.date_of_expiration,
      value: total,
    });
  } catch (err) {
    console.error('Erro ao criar PIX da fatura:', err.message);
    await alertAdminPixFalha(err, 'Fatura pós-pago (/api/pos-pago/pix)');
    res.status(500).json({ error: mpErroAmigavel(err, 'Erro ao criar a cobrança PIX da fatura.') });
  }
});

// ── GET /api/admin/assinantes ────────────────────────────────────────────────
// Lista de quem assina "Coisas de Despachantes". Cada pagamento cria uma linha
// nova em subscriptions (um período), então aqui interessa UMA linha por
// usuário: o DISTINCT ON repete a regra do getAssinaturaVigente — expires_at
// NULL (liberação sem prazo dada pelo admin) vem primeiro, depois o vencimento
// mais distante. Quem já teve assinatura e deixou vencer continua na lista,
// marcado como vencido, porque é justamente esse o pessoal que vale a pena
// chamar para renovar.
app.get('/api/admin/assinantes', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (s.user_id)
                s.id, s.user_id, s.starts_at, s.expires_at, s.origem,
                s.queries_used, s.cota, s.queries_used_crv, s.cota_crv,
                u.name, u.email, u.phone, u.cpf_cnpj, u.active AS user_active,
                (SELECT COUNT(*) FROM subscriptions s2 WHERE s2.user_id = s.user_id) AS periodos
           FROM subscriptions s
           JOIN users u ON u.id = s.user_id
          ORDER BY s.user_id, (s.expires_at IS NULL) DESC, s.expires_at DESC
       ) t
       ORDER BY (t.expires_at IS NULL OR t.expires_at > NOW()) DESC,
                t.expires_at DESC NULLS FIRST`
    );
    res.json(r.rows.map(s => ({
      ...s,
      periodos: parseInt(s.periodos, 10),
      // Quem decide a vigência é o servidor, não o front: a verdade é sempre
      // expires_at (o campo "status" da tabela fica defasado entre duas
      // execuções do cron de expiração).
      vigente: s.expires_at === null || new Date(s.expires_at) > new Date(),
    })));
  } catch (e) {
    console.error('Erro ao listar assinantes:', e.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── Crédito de pagamento PIX aprovado — ponto único usado por /status, /webhook
// e pelo cron de reconciliação. O passo que credita o usuário é uma única
// UPDATE ... WHERE credited=false, cujo lock de linha do Postgres garante que
// só uma chamada concorrente (polling do front + webhook do Mercado Pago
// chegando ao mesmo tempo, ou webhook duplicado) realmente credita — as demais
// veem 0 linhas afetadas e não fazem nada. Isso elimina a corrida que causava
// depósito duplicado.
async function creditPixPaymentIfApproved(gatewayId) {
  const mp = await mpReq('GET', `/v1/payments/${gatewayId}`);

  if (mp.status !== 'approved') {
    await pool.query(
      'UPDATE pix_payments SET status=$1 WHERE gateway_id=$2 AND credited=false',
      [mp.status, gatewayId]
    );
    return { credited: false, status: mp.status };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE pix_payments SET status='approved', credited=true
       WHERE gateway_id=$1 AND credited=false
       RETURNING id, user_id, value, purpose, method, periodo_fim, periodo_dias`,
      [gatewayId]
    );
    if (upd.rows.length === 0) {
      // Já creditado por outra chamada concorrente (ou pagamento desconhecido) — não repete.
      await client.query('ROLLBACK');
      const existing = await pool.query('SELECT value FROM pix_payments WHERE gateway_id=$1', [gatewayId]);
      return { credited: true, status: 'approved', alreadyCredited: true, value: existing.rows[0] ? parseFloat(existing.rows[0].value) : null };
    }
    const p = upd.rows[0];

    // Pagamento da Assinatura Coisas de Despachantes: não credita saldo — abre o
    // período que foi COBRADO (periodo_fim/periodo_dias, gravados na criação da
    // cobrança), que termina no dia 30 e pode ser parcial. Se o assinante renova
    // antes de vencer, o período novo começa no fim do atual (não perde os dias
    // que faltavam); se já venceu, conta a partir de agora. Cada pagamento é um
    // período próprio, com cota própria — por isso uma linha nova em vez de
    // UPDATE no período anterior.
    if (p.purpose === 'ASSINATURA') {
      // QR abandonado e pago dias depois pode ter o fim do período já no
      // passado: em vez de abrir um período nascido vencido, o cliente recebe o
      // ciclo corrente. Pagamento anterior a 22/09/2026 não tem as colunas e
      // cai no comportamento antigo (30 dias corridos, cotas cheias).
      let fimPeriodo = p.periodo_fim ? new Date(p.periodo_fim) : null;
      if (fimPeriodo && fimPeriodo.getTime() <= Date.now()) {
        const novo = cicloAssinatura(new Date());
        fimPeriodo = novo.fim;
      }
      const diasPeriodo = p.periodo_dias || ASSINATURA_PLACAS_DIAS;
      const cotas = cotasAssinaturaProRata(diasPeriodo);
      const fimSql = fimPeriodo ? '$3::timestamptz' : "inicio + ($3 || ' days')::interval";
      await client.query(
        `INSERT INTO subscriptions (user_id, plan, status, starts_at, expires_at, gateway_id, origem,
                                    cota, cota_crv, cota_assinatura, cota_verificar_crlv)
         SELECT $1, $2, 'ACTIVE', inicio, ${fimSql}, $4, 'PIX', $5, $6, $7, $8
           FROM (SELECT GREATEST(NOW(), COALESCE(
                   (SELECT MAX(expires_at) FROM subscriptions WHERE user_id=$1 AND expires_at > NOW()),
                   NOW())) AS inicio) t
         ON CONFLICT (gateway_id) DO NOTHING`,
        [p.user_id, ASSINATURA_PLACAS_SERVICE_ID,
         fimPeriodo || String(ASSINATURA_PLACAS_DIAS), gatewayId,
         cotas.placas, cotas.crv, cotas.assinatura, cotas.verificarCrlv]
      );
      // De propósito não grava em transactions: aquele extrato é o de créditos
      // pré-pagos, e a assinatura não movimenta saldo. O pagamento fica
      // registrado em pix_payments e o período em subscriptions.
      await client.query('COMMIT');
      return { credited: true, status: 'approved', value: parseFloat(p.value), purpose: 'ASSINATURA' };
    }

    // Pagamento de fatura do pós-pago: não credita saldo — dá baixa nas faturas
    // que aquele PIX cobrou. O caminho normal é pelo gateway_id carimbado na
    // geração do QR. O plano B existe para o QR abandonado e pago depois, cujo
    // carimbo já foi sobrescrito por uma cobrança nova: nesse caso quita as
    // faturas fechadas mais antigas até o valor pago acabar, que é exatamente o
    // que o cliente comprou. Sem ele, o dinheiro entraria e a fatura seguiria
    // em aberto, bloqueando quem já pagou.
    if (p.purpose === 'FATURA') {
      const porCarimbo = await client.query(
        `UPDATE faturas SET status='PAGA', paga_em=NOW(), origem_baixa='PIX'
          WHERE gateway_id=$1 AND status='FECHADA' RETURNING id`,
        [gatewayId]
      );
      if (!porCarimbo.rows.length) {
        const abertas = await client.query(
          `SELECT id, valor FROM faturas WHERE user_id=$1 AND status='FECHADA'
            ORDER BY vencimento ASC`,
          [p.user_id]
        );
        let resta = parseFloat(p.value);
        const quitar = [];
        for (const f of abertas.rows) {
          const v = parseFloat(f.valor);
          if (v > resta + 0.001) break;
          resta -= v;
          quitar.push(f.id);
        }
        if (quitar.length) {
          await client.query(
            `UPDATE faturas SET status='PAGA', paga_em=NOW(), origem_baixa='PIX', gateway_id=$2
              WHERE id = ANY($1::int[])`,
            [quitar, gatewayId]
          );
        } else {
          console.error(`[pos-pago] PIX ${gatewayId} aprovado (R$ ${p.value}) sem fatura correspondente para baixar.`);
        }
      }
      // Como na assinatura, de propósito não grava em transactions: aquele
      // extrato é o do saldo pré-pago, e a fatura não movimenta saldo. O
      // pagamento fica em pix_payments e a baixa na própria fatura.
      await client.query('COMMIT');
      return { credited: true, status: 'approved', value: parseFloat(p.value), purpose: 'FATURA' };
    }

    await client.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [p.value, p.user_id]);
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'deposit',$2,$3)`,
      [p.user_id, p.value, `Recarga ${{ CARTAO: 'cartão de débito', CREDITO: 'cartão de crédito' }[p.method] || 'PIX'} — R$ ${parseFloat(p.value).toFixed(2).replace('.', ',')}`]
    );
    await client.query('COMMIT');
    return { credited: true, status: 'approved', value: parseFloat(p.value) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── GET /api/pix/status/:paymentId ────────────────────────────────────────────
app.get('/api/pix/status/:paymentId', requireAuth, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const pr = await pool.query(
      'SELECT * FROM pix_payments WHERE gateway_id=$1 AND user_id=$2',
      [paymentId, req.user.id]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Pagamento não encontrado.' });
    const p = pr.rows[0];

    if (p.credited) return res.json({ status: 'RECEIVED', credited: true, value: parseFloat(p.value) });

    const result = await creditPixPaymentIfApproved(paymentId);
    if (result.credited) return res.json({ status: 'RECEIVED', credited: true, value: result.value });

    res.json({ status: result.status, credited: false });
  } catch (err) {
    console.error('Erro PIX status:', err.message);
    res.status(500).json({ error: 'Erro ao verificar pagamento.' });
  }
});

// ── POST /api/pix/webhook ─────────────────────────────────────────────────────
// Mercado Pago envia notificações leves (só o id) — sempre confirmamos o status
// consultando a API diretamente, nunca confiando no corpo do webhook.
app.post('/api/pix/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body || {};
  const type = body.type || body.topic || req.query.type || req.query.topic;
  const paymentId = body.data?.id || req.query['data.id'] || req.query.id;
  if (type !== 'payment' || !paymentId) return;

  try {
    const exists = await pool.query('SELECT 1 FROM pix_payments WHERE gateway_id=$1', [String(paymentId)]);
    if (!exists.rows.length) return;
    await creditPixPaymentIfApproved(String(paymentId));
  } catch (err) {
    console.error('Webhook PIX erro:', err.message);
  }
});

// ── Cron: reconcilia PIX pendentes que o webhook não confirmou ───────────────
// Rede de segurança para quando o webhook do Mercado Pago falha ou nunca chega
// (e o usuário fecha a página antes do polling confirmar) — sem isso, o
// depósito fica pago no Mercado Pago mas nunca creditado na plataforma.
async function runPixReconcile() {
  const { rows: pendentes } = await pool.query(
    `SELECT gateway_id FROM pix_payments
     WHERE credited=false AND created_at > NOW() - INTERVAL '2 days'
     ORDER BY created_at ASC LIMIT 200`
  );
  let checked = 0, credited = 0;
  for (const row of pendentes) {
    checked++;
    try {
      const result = await creditPixPaymentIfApproved(row.gateway_id);
      if (result.credited && !result.alreadyCredited) credited++;
    } catch (e) {
      console.error(`Erro ao reconciliar PIX ${row.gateway_id}:`, e.message);
    }
  }
  console.log(`✅ Reconciliação PIX: ${checked} verificados, ${credited} creditados`);
  return { checked, credited, pending: pendentes.length };
}

// ── GET /api/cron/assinaturas-expirar (Vercel Cron) ───────────────────────────
// Fecha os períodos vencidos da Assinatura Coisas de Despachantes. O bloqueio em si
// NÃO depende deste cron — o porteiro usa expires_at > NOW(), então uma
// assinatura vencida já é barrada mesmo que o cron não tenha rodado ainda. Este
// job só mantém o campo "status" coerente para relatórios e para o admin.
app.get('/api/cron/assinaturas-expirar', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const avisos = await avisarVencimentoAssinaturas();
    const r = await pool.query(
      `UPDATE subscriptions SET status='EXPIRED'
       WHERE status='ACTIVE' AND expires_at <= NOW() RETURNING id`
    );
    console.log(`✅ Assinaturas expiradas: ${r.rowCount}`);
    res.json({ success: true, expiradas: r.rowCount, ...avisos });
  } catch (err) {
    console.error('Erro no cron de assinaturas:', err.message);
    res.status(500).json({ error: 'Erro ao expirar assinaturas.' });
  }
});

// Avisa o assinante no WhatsApp faltando 5 dias e no dia do vencimento.
// Quem garante "uma vez só" são as colunas aviso_5d_em/aviso_venc_em, não a
// janela de tempo — por isso a janela é "faltam até 5 dias" em vez de "faltam
// exatamente 5 dias": se o cron falhar num dia, o aviso ainda sai no dia
// seguinte (atrasado, mas sai) em vez de se perder para sempre. O piso de 7
// dias no aviso de vencimento evita disparar em lote para assinaturas velhas
// na primeira execução depois do deploy.
// O aviso é marcado ANTES do envio: se a Z-API falhar, a mensagem é perdida em
// vez de virar spam diário para o cliente (o painel continua mostrando o prazo).
async function avisarVencimentoAssinaturas() {
  const enviar = async (rows, montarMsg, coluna) => {
    let enviados = 0;
    for (const s of rows) {
      await pool.query(`UPDATE subscriptions SET ${coluna}=NOW() WHERE id=$1`, [s.id]);
      if (!s.phone) continue;
      const ok = await sendWhatsApp(s.phone, montarMsg(s)).catch(() => false);
      if (ok) enviados++;
    }
    return enviados;
  };

  const { rows: faltando5 } = await pool.query(
    `SELECT s.id, s.expires_at, u.name, u.phone
       FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.aviso_5d_em IS NULL
        AND s.expires_at > NOW()
        AND s.expires_at <= NOW() + INTERVAL '5 days'`
  );
  const { rows: vencendo } = await pool.query(
    `SELECT s.id, s.expires_at, u.name, u.phone
       FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.aviso_venc_em IS NULL
        AND s.expires_at > NOW() - INTERVAL '7 days'
        AND s.expires_at <= NOW() + INTERVAL '1 day'`
  );

  const primeiroNome = n => (n || 'Cliente').trim().split(/\s+/)[0];
  const dataBR = d => new Date(d).toLocaleDateString('pt-BR');
  // O valor da renovação não é mais fixo: o período novo vai do fim do atual até
  // o dia 30, e o preço é por dia (ver cicloAssinatura). Anunciar R$ 30,00 para
  // quem vai pagar R$ 11,00 seria espantar o cliente com um número errado.
  const valorRenovacao = (inicio) => {
    const ciclo = cicloAssinatura(new Date(inicio));
    return `R$ ${precoAssinaturaProRata(ciclo.dias).toFixed(2).replace('.', ',')} (até ${fmtDataCicloBR(ciclo.fim)})`;
  };

  const n5 = await enviar(faltando5, s =>
    `Olá, ${primeiroNome(s.name)}! 👋\n\n` +
    `Sua *Assinatura Coisas de Despachantes* vence em *5 dias* (${dataBR(s.expires_at)}).\n\n` +
    `Para não ficar sem acesso à consulta de placa, à Declaração de Residência, à Nota de Prestação de Serviços e à ASD, ` +
    `renove por ${valorRenovacao(s.expires_at)} direto no painel, em *Coisas de Despachantes*.\n\n` +
    `_MC Despachadoria Consultas_`, 'aviso_5d_em');

  // Já venceu x vence hoje: o cron pode pegar a assinatura no dia ou logo depois
  // (ver janela acima), então o texto se adapta em vez de afirmar "vence hoje".
  const nv = await enviar(vencendo, s => {
    const venceu = new Date(s.expires_at).getTime() <= Date.now();
    return `Olá, ${primeiroNome(s.name)}!\n\n` +
      (venceu
        ? `Sua *Assinatura Coisas de Despachantes* venceu em ${dataBR(s.expires_at)}. ⏰\n\n`
        : `Sua *Assinatura Coisas de Despachantes* vence hoje (${dataBR(s.expires_at)}). ⏰\n\n`) +
      `Renove por ${valorRenovacao(venceu ? new Date() : s.expires_at)} no painel, em *Coisas de Despachantes*, ` +
      `para continuar emitindo seus documentos sem interrupção.\n\n` +
      `_MC Despachadoria Consultas_`;
  }, 'aviso_venc_em');

  console.log(`✅ Avisos de assinatura: ${n5} de 5 dias, ${nv} de vencimento`);
  return { avisos5Dias: n5, avisosVencimento: nv };
}

// ── GET /api/cron/pix-reconcile (Vercel Cron) ─────────────────────────────────
app.get('/api/cron/pix-reconcile', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runPixReconcile();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no cron pix-reconcile:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/pix-reconcile (teste manual pelo admin) ──────────────────
app.post('/api/admin/pix-reconcile', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runPixReconcile();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no pix-reconcile manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook Vistocar (consultas assíncronas) ─────────────────────────────────
// Documentação de integração "Webhook Vistocar Consultas" v1.2 (agosto/2026).
// Fluxo: a consulta é registrada (devolve movementId) → a Vistocar dispara
// 'consulta.pendente' → depois 'consulta.atualizada' → quando
// data.resultAvailable é true, o PDF é buscado em GET /apiclient/consult/:id.
//
// A notificação NUNCA traz o documento, só avisa que ele existe: o PDF vem de
// uma chamada nossa, autenticada com o JWT de sempre. Por isso uma notificação
// forjada não consegue injetar documento nenhum — no máximo faz o servidor
// consultar um pedido da própria conta.
//
// O cadastro do endpoint é feito pela própria API (POST /apiclient/webhook/save,
// ver registrarWebhookVistocar) e a chaveSeguranca fica no banco, não em
// variável de ambiente — nada para configurar à mão.
// O que vai para o cadastro na Vistocar é o caminho COM /api (o primeiro de
// VISTOCAR_WEBHOOK_PATHS) — é o que está ativo na conta deles e já entregou
// notificação. O outro caminho é só tolerância do lado de cá; mudar este valor
// re-registraria o webhook sem necessidade.
const VISTOCAR_WEBHOOK_URL = `${WEBHOOK_BASE_URL || 'https://www.despachantesconsultas.com.br'}${VISTOCAR_WEBHOOK_PATHS[0]}`;

async function getVistocarWebhookSecret() {
  const r = await pool.query('SELECT chave_seguranca FROM vistocar_webhook_config ORDER BY id DESC LIMIT 1');
  return r.rows[0]?.chave_seguranca || '';
}

// Assinatura documentada: HMAC-SHA256(chaveSeguranca, corpoBruto + timestamp),
// hexadecimal minúsculo com prefixo "sha256=". O corpo tem que ser o BRUTO
// (bytes recebidos), por isso express.json guarda req.rawBody nesta rota.
function validarAssinaturaVistocar(rawBody, timestamp, chave, assinaturaRecebida) {
  if (!chave || !assinaturaRecebida) return false;
  const esperado = 'sha256=' + crypto
    .createHmac('sha256', chave)
    .update(Buffer.concat([Buffer.from(rawBody || ''), Buffer.from(String(timestamp || ''), 'utf8')]))
    .digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(assinaturaRecebida));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── ATPV-e: ciclo de vida do protocolo ───────────────────────────────────────
// O cadastro (POST) é só o primeiro passo — ele NÃO emite o documento. Sobre o
// mesmo protocolo ainda existem, na mesma rota da UF (doc "Integração API",
// 18/09/2026):
//   PUT    /apiclient/atpve-<uf>            → efetiva o registro no DETRAN
//   POST   /apiclient/atpve-<uf>/situacao   → situação + arquivoPdfBase64
//   PUT    /apiclient/atpve-<uf>/alteracao  → corrige os dados (corpo do cadastro)
//   DELETE /apiclient/atpve-<uf>            → cancela
// As três primeiras e a exclusão só são aceitas em determinadas situações do
// protocolo, e a API não documenta quais. Por isso NADA aqui tenta adivinhar a
// tabela de situações: as ações são oferecidas e quem recusa é a Vistocar, com
// a mensagem dela ("ATPVe não pode ser excluído - situação atual (...) não
// permite essa operação"). Assim uma situação nova do lado deles não quebra o
// painel nem esconde um botão que funcionaria.
//
// A rota de alteração não está aqui de propósito: ela exige o corpo inteiro do
// cadastro, e os três anexos em base64 são descartados na hora de gravar
// (paramsSemAnexosAtpve) — não temos como remontar o pedido. Corrigir um
// cadastro errado é excluir e cadastrar de novo.
async function chamarAtpveVistocar(serviceId, metodo, sufixo, body) {
  const rota = VISTOCAR_ENDPOINTS[serviceId];
  if (!rota) throw new Error(`Serviço ${serviceId} não tem rota de ATPV-e na Vistocar.`);
  const r = await fetch(`${VISTOCAR_BASE_URL}/apiclient/${rota}${sufixo}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getVistocarToken()}` },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => null);
  const resp = data?.response || {};
  // A recusa chega de duas formas e as duas precisam ser tratadas como erro: HTTP
  // 400 com a explicação em "message" (ex.: "Protocolo não encontrado") e HTTP 200
  // com success:true mas "error" preenchido, que é como a Vistocar repassa o texto
  // do fornecedor (ex.: "0-ENTIDADE NAO POSSUI CONFIGURACOES..."). Olhar só o
  // status HTTP daria sucesso para um pedido que não andou.
  const textoErro = (resp.error || '').trim() || null;
  const erro = (!r.ok || textoErro)
    ? (textoErro || resp.msg || data?.message || `HTTP ${r.status} na Vistocar`)
    : null;
  return { ok: !erro, erro, http: r.status, resp };
}

async function consultarSituacaoAtpve(serviceId, protocolo) {
  const r = await chamarAtpveVistocar(serviceId, 'POST', '/situacao', { protocolo });
  const codigo = r.resp?.situacaoCodigo;
  return {
    ok: r.ok,
    erro: r.erro,
    codigo: (codigo === null || codigo === undefined || codigo === '') ? null : String(codigo),
    descricao: String(r.resp?.situacaoDescricao || '').trim() || null,
    motivo: String(r.resp?.motivoSituacao || '').trim() || null,
    pdfBase64: r.resp?.arquivoPdfBase64 || null,
  };
}

const registrarAtpveVistocar = (serviceId, protocolo) =>
  chamarAtpveVistocar(serviceId, 'PUT', '', { protocolo });
const excluirAtpveVistocar = (serviceId, protocolo) =>
  chamarAtpveVistocar(serviceId, 'DELETE', '', { protocolo });

// Texto curto da situação para a tela e para o WhatsApp ("5 · COMUNICADA").
const textoSituacaoAtpve = s =>
  [s?.codigo, s?.descricao].filter(Boolean).join(' · ') || null;

// Onde o documento é buscado depende do serviço. O ATPV-e tem rota própria de
// situação, que devolve o PDF junto — e é a única que funciona para ele, porque
// GET /apiclient/consult/:movementId só responde depois que a Vistocar fecha a
// consulta. O CRLV-e (e os ATPV-e antigos, cadastrados antes de o protocolo
// passar a ser guardado) continuam pelo consult.
async function buscarDocumentoVistocar(pend) {
  if (VISTOCAR_ATPVE_SVCS.has(pend.service_id) && pend.protocolo) {
    let s;
    try { s = await consultarSituacaoAtpve(pend.service_id, pend.protocolo); }
    catch (e) { return { motivo: `falha ao consultar a situação: ${e.message}` }; }
    if (!s.ok) return { motivo: s.erro || 'não foi possível consultar a situação', situacao: s };
    // Sem PDF é o caso normal de quem ainda não registrou: o documento só passa
    // a existir depois do PUT de registro.
    if (!s.pdfBase64) {
      return { motivo: `situação atual: ${textoSituacaoAtpve(s) || 'em andamento'}`, situacao: s };
    }
    return { b64: s.pdfBase64, situacao: s };
  }
  const r = await fetch(`${VISTOCAR_BASE_URL}/apiclient/consult/${encodeURIComponent(pend.movement_id)}`, {
    headers: { 'Authorization': `Bearer ${await getVistocarToken()}` },
  });
  if (r.status === 404) return { motivo: 'resultado ainda não disponível' };
  if (!r.ok) return { motivo: `HTTP ${r.status} ao buscar o resultado` };
  const data = await r.json().catch(() => null);
  // CRLV usa response.pdfBase64; ATPV-e usa response.arquivoPdfBase64 (doc, seção 8).
  const b64 = data?.response?.pdfBase64 || data?.response?.arquivoPdfBase64;
  if (!b64) return { motivo: 'resposta sem PDF' };
  return { b64 };
}

// Efetiva o registro de um cadastro de ATPV-e no Detran e, se o documento já
// sair na mesma hora, entrega na sequência. Usado pelo painel do cliente e pelo
// admin — os dois passando pela MESMA função, para não existir um caminho que
// registre sem marcar registrado_em.
async function registrarAtpvePendencia(pend) {
  if (!pend.protocolo) {
    return { ok: false, erro: 'Este pedido foi cadastrado antes do registro pelo painel e não tem o protocolo guardado. Registre pelo painel da Vistocar ou cadastre de novo.' };
  }
  if (pend.registrado_em) return { ok: false, erro: 'Este ATPV-e já foi registrado no Detran.' };
  const r = await registrarAtpveVistocar(pend.service_id, pend.protocolo);
  if (!r.ok) return { ok: false, erro: r.erro };
  await pool.query('UPDATE vistocar_pending SET registrado_em=NOW() WHERE movement_id=$1', [pend.movement_id]);
  console.log(`✅ ATPV-e registrado no Detran [protocolo ${pend.protocolo}, query ${pend.query_id}]`);
  // O PDF costuma demorar; se já vier, entrega (e cobra) agora.
  const entrega = await entregarResultadoVistocar({ ...pend, registrado_em: new Date() })
    .catch(e => { console.error(`[atpve-registrar] falha na entrega imediata:`, e.message); return { entregue: false }; });
  return { ok: true, entregue: !!entrega.entregue, situacao: entrega.situacao || null };
}

// Cancela o cadastro no Detran e encerra a pendência sem cobrar — o mesmo
// estado final de um pedido que não saiu no prazo (cancelarPendenciaVistocar),
// só que pedido pelo cliente.
async function excluirAtpvePendencia(pend) {
  if (!pend.protocolo) {
    return { ok: false, erro: 'Este pedido foi cadastrado antes do registro pelo painel e não tem o protocolo guardado. Exclua pelo painel da Vistocar.' };
  }
  const r = await excluirAtpveVistocar(pend.service_id, pend.protocolo);
  if (!r.ok) return { ok: false, erro: r.erro };
  await pool.query(
    `UPDATE queries SET status='cancelado' WHERE id=$1 AND status='aguardando_pdf'`,
    [pend.query_id]
  );
  await pool.query('DELETE FROM vistocar_pending WHERE movement_id=$1', [pend.movement_id]);
  console.log(`🗑️ ATPV-e excluído no Detran [protocolo ${pend.protocolo}, query ${pend.query_id}]`);
  return { ok: true };
}

// Busca o resultado de uma consulta concluída e entrega ao dono do pedido:
// cobra (só agora, com o documento em mãos), guarda no pdf_cache e manda por
// WhatsApp. Usado pelo webhook e pela varredura periódica — daí o claim atômico
// em finalizePendingQuery e a checagem de cache, que evitam entrega dupla.
async function entregarResultadoVistocar(pend) {
  const movementId = pend.movement_id;
  const achado = await buscarDocumentoVistocar(pend);
  if (!achado.b64) return { entregue: false, motivo: achado.motivo, situacao: achado.situacao || null };
  const buf = Buffer.from(String(achado.b64).replace(/^data:[^,]+,/, '').replace(/\s/g, ''), 'base64');
  if (buf.slice(0, 4).toString() !== '%PDF') return { entregue: false, motivo: 'conteúdo devolvido não é um PDF' };

  const jaTem = await pool.query('SELECT 1 FROM pdf_cache WHERE query_id=$1 AND expires_at > NOW()', [pend.query_id]);
  if (jaTem.rows.length) {
    await pool.query('DELETE FROM vistocar_pending WHERE movement_id=$1', [movementId]);
    return { entregue: false, motivo: 'documento já havia sido entregue' };
  }

  const service = SERVICES.find(s => s.id === pend.service_id);
  await finalizePendingQuery(pend.query_id, pend.user_id, `Consulta: ${service?.name || pend.service_id}`);

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [pend.query_id, pend.user_id, token, buf.toString('base64'), new Date(Date.now() + 7 * 24 * 3600 * 1000)]
  );

  if (pend.phone) {
    const placa = (pend.placa || '').toUpperCase();
    const nome = service?.name || 'Documento';
    const caption = `✅ *${nome} pronto!*\n🔤 Placa: ${placa}\n\nDocumento gerado pela MC Despachadoria.`;
    // Mesma razão da Assinatura Digital: é whatsapp_sent_at que o admin lê para
    // saber se o cliente recebeu, e é o que decide se vale reenviar.
    const nomeArquivo = nomeArquivoVistocar(pend.service_id, placa || 'doc')
      || `${pend.service_id}-${placa || 'doc'}.pdf`;
    const enviado = await sendWhatsAppPdf(pend.phone, buf, nomeArquivo, caption)
      .catch(e => { console.error(`Erro ao enviar ${nome} por WhatsApp:`, e.message); return false; });
    if (enviado) await pool.query('UPDATE queries SET whatsapp_sent_at = NOW() WHERE id=$1', [pend.query_id]).catch(() => {});
  }

  await pool.query('DELETE FROM vistocar_pending WHERE movement_id=$1', [movementId]);
  console.log(`✅ Resultado Vistocar entregue [movementId ${movementId}, query ${pend.query_id}]`);
  return { entregue: true };
}

// A consulta foi estornada/cancelada pelo fornecedor (status 3): nada a entregar
// e nada a estornar — a cobrança só acontece na entrega.
async function cancelarPendenciaVistocar(pend, motivo) {
  const marcado = await pool.query(
    `UPDATE queries SET status='cancelado' WHERE id=$1 AND status='aguardando_pdf' RETURNING id`,
    [pend.query_id]
  );
  await pool.query('DELETE FROM vistocar_pending WHERE movement_id=$1', [pend.movement_id]);
  if (marcado.rows.length && pend.phone) {
    const placa = (pend.placa || '').toUpperCase();
    const msg = `⚠️ *${SERVICES.find(s => s.id === pend.service_id)?.name || 'Consulta'}*\n\nO documento${placa ? ` da placa ${placa}` : ''} não pôde ser emitido${motivo ? `: ${motivo}` : '.'}\n\nVocê não foi cobrado por essa tentativa. Se precisar, tente novamente ou fale com o suporte.`;
    await sendWhatsApp(pend.phone, msg).catch(() => {});
  }
}

// ── Assinatura Digital: entrega do documento assinado ────────────────────────
// Busca o PDF assinado e entrega ao dono do pedido: guarda no pdf_cache e manda
// por WhatsApp. Usado pela tela de acompanhamento e pelo cron — daí o claim
// atômico no status e a checagem de cache, que evitam entrega dupla.
// Não há cobrança aqui: o envio é pago pela assinatura (amount 0), então o
// finalizePendingQuery não serve — ele criaria uma transação de R$ 0,00.
async function entregarAssinaturaDigital(pend) {
  const r = await buscarDocumentoAssinadoAssinafy(pend.document_id);
  if (r.encerrado) {
    const marcado = await pool.query(
      `UPDATE queries SET status='cancelado' WHERE id=$1 AND status='aguardando_pdf' RETURNING id`,
      [pend.query_id]
    );
    await pool.query('DELETE FROM assinafy_pending WHERE document_id=$1', [pend.document_id]);
    if (marcado.rows.length && pend.phone) {
      const motivo = r.status === 'rejected_by_signer' ? 'o signatário recusou a assinatura'
        : r.status === 'expired' ? 'o prazo de assinatura expirou'
        : 'o pedido foi encerrado sem assinatura';
      await sendWhatsApp(pend.phone,
        `⚠️ *Assinatura Digital*\n\nO documento "${pend.nome_arquivo}" não foi assinado: ${motivo}.\n\nSe precisar, envie de novo pelo painel.`).catch(() => {});
    }
    return { entregue: false, motivo: `encerrado sem assinatura (${r.status})` };
  }
  if (!r.pronto) return { entregue: false, motivo: `ainda não assinado (${r.status || 'sem status'})` };

  const jaTem = await pool.query('SELECT 1 FROM pdf_cache WHERE query_id=$1 AND expires_at > NOW()', [pend.query_id]);
  if (jaTem.rows.length) {
    await pool.query('DELETE FROM assinafy_pending WHERE document_id=$1', [pend.document_id]);
    return { entregue: false, motivo: 'documento já havia sido entregue' };
  }

  const claimed = await pool.query(
    `UPDATE queries SET status='success' WHERE id=$1 AND status='aguardando_pdf' RETURNING id`,
    [pend.query_id]
  );
  if (!claimed.rows.length) return { entregue: false, motivo: 'pedido já fechado por outra execução' };

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [pend.query_id, pend.user_id, token, r.pdf.toString('base64'), new Date(Date.now() + 7 * 24 * 3600 * 1000)]
  );

  if (pend.phone) {
    const caption = `✅ *Documento assinado!*\n📄 ${pend.nome_arquivo}\n✍️ Assinado por: ${pend.signatario}\n\nAssinatura digital pela MC Despachadoria.`;
    // Marca whatsapp_sent_at no sucesso: é essa coluna que o admin mostra para
    // saber se o cliente já recebeu, e sem isso ela diria "não enviado" sempre.
    const enviado = await sendWhatsAppPdf(pend.phone, r.pdf, `assinado-${pend.nome_arquivo}`, caption)
      .catch(e => { console.error('Erro ao enviar documento assinado por WhatsApp:', e.message); return false; });
    if (enviado) await pool.query('UPDATE queries SET whatsapp_sent_at = NOW() WHERE id=$1', [pend.query_id]).catch(() => {});
  }

  await pool.query('DELETE FROM assinafy_pending WHERE document_id=$1', [pend.document_id]);
  console.log(`✅ Documento assinado entregue [documentId ${pend.document_id}, query ${pend.query_id}]`);
  return { entregue: true };
}

// ── GET /api/queries/:id/assinatura-status ───────────────────────────────────
// Alimenta a tela de acompanhamento do painel. Igual à do ATPV-e: a cada
// consulta TENTA buscar o documento assinado, porque quem está com a tela aberta
// não pode depender do cron. A entrega é idempotente (claim atômico no status +
// checagem do pdf_cache), então chamar de novo não entrega duas vezes.
app.get('/api/queries/:id/assinatura-status', requireAuth, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT id, status, created_at FROM queries WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    let q = qr.rows[0];

    if (q.status === 'aguardando_pdf') {
      await ensureDbReady();   // assinafy_pending é tabela nova — ver ensureDbReady
      const pr = await pool.query('SELECT * FROM assinafy_pending WHERE query_id=$1', [q.id]);
      if (pr.rows.length) {
        try { await entregarAssinaturaDigital(pr.rows[0]); }
        catch (e) { console.error(`[assinatura-status] falha ao buscar o documento da query ${q.id}:`, e.message); }
        const rel = await pool.query('SELECT status FROM queries WHERE id=$1', [q.id]);
        if (rel.rows.length) q.status = rel.rows[0].status;
      }
    }

    const pdf = await pool.query(
      `SELECT token FROM pdf_cache WHERE query_id=$1 AND expires_at > NOW() ORDER BY id DESC LIMIT 1`,
      [q.id]
    );
    const decorridoSegundos = Math.max(0, Math.round((Date.now() - new Date(q.created_at).getTime()) / 1000));
    if (pdf.rows.length) return res.json({ situacao: 'pronto', token: pdf.rows[0].token, decorridoSegundos });
    if (q.status === 'cancelado')
      return res.json({
        situacao: 'cancelado', decorridoSegundos,
        mensagem: 'O documento não foi assinado. Nada foi descontado da sua cota além deste envio.',
      });
    return res.json({ situacao: 'aguardando', decorridoSegundos });
  } catch (err) {
    console.error('Erro em /api/queries/:id/assinatura-status:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/queries/:id/atpve-status ────────────────────────────────────────
// Alimenta a barra de progresso do painel enquanto o ATPV-e está sendo emitido.
// Não é só leitura de banco: a cada consulta ele TENTA buscar o resultado na
// Vistocar (entregarResultadoVistocar, o mesmo do webhook e do cron), porque
// quem está com a tela aberta esperando não pode depender de a notificação
// chegar. A entrega é idempotente — claim atômico em finalizePendingQuery e
// checagem do pdf_cache —, então chamar de novo não cobra nem entrega duas vezes.
app.get('/api/queries/:id/atpve-status', requireAuth, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT id, service_id, service_name, status, created_at FROM queries
       WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Consulta não encontrada.' });
    let q = qr.rows[0];

    let pend = null, situacao = null;
    if (q.status === 'aguardando_pdf') {
      await ensureDbReady();   // vistocar_pending é tabela nova — ver ensureDbReady
      const pr = await pool.query('SELECT * FROM vistocar_pending WHERE query_id=$1', [q.id]);
      if (pr.rows.length) {
        pend = pr.rows[0];
        try {
          const r = await entregarResultadoVistocar(pend);
          situacao = r.situacao || null;
        }
        catch (e) { console.error(`[atpve-status] falha ao buscar o resultado da query ${q.id}:`, e.message); }
        const rel = await pool.query('SELECT status FROM queries WHERE id=$1', [q.id]);
        if (rel.rows.length) q.status = rel.rows[0].status;
      }
    }

    const pdf = await pool.query(
      `SELECT token FROM pdf_cache WHERE query_id=$1 AND expires_at > NOW() ORDER BY id DESC LIMIT 1`,
      [q.id]
    );
    const decorridoSegundos = Math.max(0, Math.round((Date.now() - new Date(q.created_at).getTime()) / 1000));
    // O prazo é o mesmo em que runVistocarPendingCheck desiste e cancela sem
    // cobrar — é ele que a barra usa de régua, para não prometer um tempo nosso.
    const prazoSegundos = ASYNC_PDF_REFUND_HOURS * 3600;

    if (pdf.rows.length) {
      return res.json({ situacao: 'pronto', token: pdf.rows[0].token, decorridoSegundos, prazoSegundos });
    }
    if (q.status === 'cancelado') {
      return res.json({
        situacao: 'cancelado', decorridoSegundos, prazoSegundos,
        mensagem: 'O documento não pôde ser emitido. Você não foi cobrado por essa tentativa.',
      });
    }
    // Cadastrado e ainda não registrado: o painel precisa distinguir isso de
    // "esperando o Detran emitir", porque aqui quem tem que agir é o cliente —
    // sem o registro o ATPV-e não sai e o cadastro morre no prazo.
    const base = {
      decorridoSegundos, prazoSegundos,
      protocolo: pend?.protocolo || null,
      registrado: !!pend?.registrado_em,
      situacaoCodigo: situacao?.codigo || null,
      situacaoDescricao: situacao?.descricao || null,
      motivoSituacao: situacao?.motivo || null,
    };
    if (pend && !pend.registrado_em && VISTOCAR_ATPVE_SVCS.has(pend.service_id) && pend.protocolo) {
      return res.json({ ...base, situacao: 'aguardando_registro' });
    }
    return res.json({ ...base, situacao: 'aguardando' });
  } catch (err) {
    console.error('Erro em /api/queries/:id/atpve-status:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── Registro e exclusão do ATPV-e pelo dono do pedido ────────────────────────
// O cadastro sozinho não emite nada: é este PUT que manda a intenção de venda
// para o Detran. Fica com o cliente de propósito — ele confere os dados antes de
// virar ato no Detran, e o que estiver errado se resolve excluindo e cadastrando
// de novo (a rota de alteração exige os anexos, que não guardamos).
async function pendenciaAtpveDoUsuario(req) {
  await ensureDbReady();   // colunas protocolo/registrado_em são novas — ver ensureDbReady
  const qr = await pool.query(
    `SELECT id, service_id, status FROM queries WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.user.id]
  );
  if (!qr.rows.length) return { erro: 'Consulta não encontrada.', http: 404 };
  const q = qr.rows[0];
  if (!VISTOCAR_ATPVE_SVCS.has(q.service_id)) return { erro: 'Esta consulta não é um ATPV-e.', http: 400 };
  if (q.status !== 'aguardando_pdf') {
    return { erro: q.status === 'success'
      ? 'Este ATPV-e já foi emitido.'
      : 'Este pedido não está mais aberto.', http: 409 };
  }
  const pr = await pool.query('SELECT * FROM vistocar_pending WHERE query_id=$1', [q.id]);
  if (!pr.rows.length) return { erro: 'Pedido sem pendência aberta na Vistocar.', http: 409 };
  return { pend: pr.rows[0] };
}

app.post('/api/queries/:id/atpve-registrar', requireAuth, async (req, res) => {
  try {
    const { pend, erro, http } = await pendenciaAtpveDoUsuario(req);
    if (erro) return res.status(http).json({ error: erro });
    const r = await registrarAtpvePendencia(pend);
    if (!r.ok) return res.status(422).json({ error: r.erro });
    return res.json({
      success: true,
      entregue: r.entregue,
      mensagem: r.entregue
        ? 'ATPV-e registrado e emitido! O documento já está disponível.'
        : 'ATPV-e registrado no Detran! Assim que o documento sair, ele chega pelo WhatsApp e fica no seu histórico.',
    });
  } catch (err) {
    console.error('Erro em /api/queries/:id/atpve-registrar:', err.message);
    res.status(500).json({ error: 'Erro interno ao registrar o ATPV-e.' });
  }
});

app.post('/api/queries/:id/atpve-excluir', requireAuth, async (req, res) => {
  try {
    const { pend, erro, http } = await pendenciaAtpveDoUsuario(req);
    if (erro) return res.status(http).json({ error: erro });
    const r = await excluirAtpvePendencia(pend);
    if (!r.ok) return res.status(422).json({ error: r.erro });
    return res.json({ success: true, mensagem: 'Cadastro excluído. Você não foi cobrado por ele.' });
  } catch (err) {
    console.error('Erro em /api/queries/:id/atpve-excluir:', err.message);
    res.status(500).json({ error: 'Erro interno ao excluir o ATPV-e.' });
  }
});

app.post(VISTOCAR_WEBHOOK_PATHS, async (req, res) => {
  const payload = req.body || {};
  const eventId = req.headers['x-webhook-id'] || payload.eventId || null;
  const movementKey = payload?.data?.movementId != null ? String(payload.data.movementId) : null;

  let logId = null;
  try {
    await ensureDbReady();   // vistocar_webhooks/vistocar_pending são tabelas novas
    // event_id é UNIQUE: reenvio da mesma notificação (a Vistocar repete até
    // receber 2xx, com o mesmo eventId) não é processado duas vezes.
    const logRow = await pool.query(
      `INSERT INTO vistocar_webhooks (event_id, movement_id, evento, payload)
       VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
      [eventId, movementKey, payload.event || null, JSON.stringify(payload).slice(0, 200000)]
    );
    if (!logRow.rows.length && eventId) {
      console.log(`Webhook Vistocar ignorado (reenvio do evento ${eventId}).`);
      return res.sendStatus(200);
    }
    logId = logRow.rows[0]?.id || null;
  } catch (e) {
    console.error('Erro ao gravar webhook da Vistocar:', e.message);
  }

  // 2xx imediato, como a doc recomenda — o processamento continua depois.
  res.sendStatus(200);

  const registrar = async (msg, ok = false) => {
    if (!ok) console.error(`Webhook Vistocar [movementId ${movementKey || '-'}]: ${msg}`);
    if (logId) await pool.query('UPDATE vistocar_webhooks SET processed=$1, erro=$2 WHERE id=$3',
      [ok, ok ? null : msg, logId]).catch(() => {});
  };

  try {
    const chave = await getVistocarWebhookSecret();
    const assinatura = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'] || payload.timestamp;
    if (chave) {
      if (!validarAssinaturaVistocar(req.rawBody, timestamp, chave, assinatura))
        return registrar('assinatura inválida — notificação descartada');
    } else {
      // Sem chave salva o webhook ainda não foi cadastrado por nós; segue em
      // frente porque o documento vem da chamada autenticada, não daqui.
      console.error('Webhook Vistocar recebido sem chaveSeguranca cadastrada — assinatura não verificada.');
    }

    if (!movementKey) return registrar('notificação sem data.movementId');

    const pr = await pool.query('SELECT * FROM vistocar_pending WHERE movement_id=$1', [movementKey]);
    const pend = pr.rows[0];
    if (!pend) return registrar('nenhum pedido pendente com esse movementId');

    const status = Number(payload?.data?.status);
    const statusMessage = payload?.data?.statusMessage || '';

    // 3 = estornada/cancelada pelo fornecedor.
    if (status === 3) {
      await cancelarPendenciaVistocar(pend, statusMessage);
      return registrar(`consulta cancelada pelo fornecedor: ${statusMessage}`, true);
    }

    // O sinal confiável é resultAvailable, não o status (doc, seção 6): em alguns
    // produtos 'consulta.atualizada' chega mais de uma vez antes do documento.
    if (payload?.data?.resultAvailable !== true)
      return registrar(`sem resultado disponível ainda (${payload.event || 'evento'}${statusMessage ? `: ${statusMessage}` : ''})`, true);

    const r = await entregarResultadoVistocar(pend);
    return registrar(r.entregue ? 'resultado entregue' : r.motivo, r.entregue);
  } catch (e) {
    await registrar(`erro ao processar: ${e.message}`);
  }
});

// ── Cadastro do nosso endpoint na Vistocar (POST /apiclient/webhook/save) ─────
// Só pode existir um webhook ATIVO por conta (doc, seção 2): quando já houver
// outro cadastrado, este helper não sobrescreve nada — devolve o que encontrou
// para o admin decidir. A chaveSeguranca gerada fica no banco e é o que valida
// a assinatura das notificações.
async function registrarWebhookVistocar() {
  await ensureDbReady();
  const token = await getVistocarToken();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  const listaRes = await fetch(`${VISTOCAR_BASE_URL}/apiclient/webhook`, { headers });
  const lista = listaRes.status === 204 ? [] : await listaRes.json().catch(() => []);
  const ativos = (Array.isArray(lista) ? lista : [lista]).filter(w => w && w.status === 'ATIVO');
  const nosso = ativos.find(w => w.url === VISTOCAR_WEBHOOK_URL);
  if (ativos.length && !nosso)
    return { ok: false, error: `Já existe um webhook ATIVO nesta conta Vistocar (${ativos[0].url}). Inative-o antes de cadastrar o nosso.`, webhooks: ativos };
  if (nosso && await getVistocarWebhookSecret())
    return { ok: true, jaCadastrado: true, webhook: nosso };

  const chaveSeguranca = crypto.randomBytes(24).toString('hex');
  const saveRes = await fetch(`${VISTOCAR_BASE_URL}/apiclient/webhook/save`, {
    method: 'POST', headers,
    body: JSON.stringify({ url: VISTOCAR_WEBHOOK_URL, chaveSeguranca }),
  });
  const saved = await saveRes.json().catch(() => null);
  if (!saveRes.ok || !saved?.id)
    return { ok: false, error: saved?.message || `Falha ao cadastrar o webhook (HTTP ${saveRes.status}).` };

  await pool.query(
    `INSERT INTO vistocar_webhook_config (webhook_id, url, chave_seguranca) VALUES ($1,$2,$3)`,
    [String(saved.id), saved.url || VISTOCAR_WEBHOOK_URL, saved.chaveSeguranca || chaveSeguranca]
  );
  return { ok: true, webhook: { id: saved.id, url: saved.url, status: saved.status } };
}

// ── ADMIN: gestão do webhook da Vistocar ─────────────────────────────────────
app.get('/api/admin/vistocar-webhook', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const listaRes = await fetch(`${VISTOCAR_BASE_URL}/apiclient/webhook`, {
      headers: { 'Authorization': `Bearer ${await getVistocarToken()}` },
    });
    const lista = listaRes.status === 204 ? [] : await listaRes.json().catch(() => []);
    const cfg = await pool.query('SELECT webhook_id, url, created_at FROM vistocar_webhook_config ORDER BY id DESC LIMIT 1');
    res.json({ success: true, urlEsperada: VISTOCAR_WEBHOOK_URL, vistocar: lista, local: cfg.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/vistocar-webhook', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await registrarWebhookVistocar();
    res.status(r.ok ? 200 : 400).json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/webhooks/zapi ───────────────────────────────────────────────────
app.post('/api/webhooks/zapi', async (req, res) => {
  res.sendStatus(200);
  const event = req.body;
  if (!event) return;

  const type = event.type || '';

  try {
    if (type === 'ReceivedCallback') {
      const phone      = event.phone || '';
      const senderName = event.senderName || '';
      const messageId  = event.messageId || '';
      const msgType    = event.image ? 'image' : event.audio ? 'audio' : event.video ? 'video' : event.document ? 'document' : 'text';
      const message    = event.text?.message
        || event.image?.caption
        || event.audio?.caption
        || event.document?.caption
        || `[${msgType}]`;

      await pool.query(
        `INSERT INTO whatsapp_inbox (phone, sender_name, message, message_type, message_id, raw)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (message_id) DO NOTHING`,
        [phone, senderName, message, msgType, messageId, JSON.stringify(event)]
      );
      console.log(`📱 WhatsApp recebido de ${phone} (${senderName}): ${message}`);
    }
  } catch (err) {
    console.error('Webhook Z-API erro:', err.message);
  }
});

// ── GET /api/admin/whatsapp-inbox ─────────────────────────────────────────────
app.get('/api/admin/whatsapp-inbox', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, phone, sender_name, message, message_type, read, created_at
       FROM whatsapp_inbox ORDER BY created_at DESC LIMIT 200`
    );
    // Marca como lidas
    await pool.query(`UPDATE whatsapp_inbox SET read=true WHERE read=false`);
    res.json({ messages: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── GET /api/admin/whatsapp-inbox/count ──────────────────────────────────────
app.get('/api/admin/whatsapp-inbox/count', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT COUNT(*) FROM whatsapp_inbox WHERE read=false`);
    res.json({ unread: parseInt(r.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── POST /api/declaracao-residencia/localizar ─────────────────────────────────
// Etapa 1 do serviço "Gerar Declaração de Residência DETRAN RJ": busca nome +
// endereço mais recente na Localização CPF V3 (Datacube) pra pré-preencher o
// formulário editável do front (ver extractDeclaracaoResidenciaFields). Não
// cobra créditos — só a geração final (POST /api/query, serviceId
// declaracao-residencia-detran-rj) debita o valor do serviço.
app.post('/api/declaracao-residencia/localizar', requireAuth, async (req, res) => {
  const cpf = (req.body?.cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });

  try {
    const ur = await pool.query('SELECT active FROM users WHERE id=$1', [req.user.id]);
    if (!ur.rows[0]?.active) return res.status(403).json({ error: 'Conta bloqueada.' });

    const apiRes = await fetch(`${DATACUBE_API_URL}/pessoas/localizacao_v3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_token: DATACUBE_TOKEN, cpf }),
    });
    const bodyStr = await apiRes.text();
    let parsed;
    try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
    if (!parsed) return res.status(502).json({ error: 'Erro ao consultar Localização CPF V3.' });

    // Mesmo desembrulhamento de "historicos" usado no relatório da Localização CPF
    // (ver isDcLocalizacaoCpf em /api/query) — a v3 devolve "result" como array com
    // um único objeto { historicos: {nomes, enderecos, ...}, participacao_empresas }.
    const localizacaoResult = parsed.result ?? parsed;
    let localizacaoData = Array.isArray(localizacaoResult) ? (localizacaoResult[0] ?? {}) : localizacaoResult;
    if (localizacaoData?.historicos && typeof localizacaoData.historicos === 'object') {
      localizacaoData = localizacaoData.historicos;
    }
    const hasData = localizacaoData && (Array.isArray(localizacaoData)
      ? localizacaoData.length > 0
      : Object.keys(localizacaoData).length > 0);
    if (!hasData) return res.status(422).json({ error: 'Nenhum dado encontrado para esse CPF.' });

    const fields = extractDeclaracaoResidenciaFields(localizacaoData);
    res.json({ success: true, data: fields });
  } catch (err) {
    console.error('Erro em /api/declaracao-residencia/localizar:', err.message);
    res.status(500).json({ error: 'Erro interno ao buscar dados do CPF.' });
  }
});

// ── POST /api/contrato-aluguel/localizar ──────────────────────────────────────
// Etapa 1 do serviço "Gerar Contrato de Aluguel": busca o nome mais recente na
// Localização CPF V3 (Datacube) pra pré-preencher o nome do Locador ou do
// Locatário no formulário (ver extractNomeFromLocalizacaoV3) — chamada duas
// vezes pelo front, uma por parte. Só funciona para CPF (pessoa física); CNPJ
// (pessoa jurídica) não é suportado por esse endpoint da Datacube, o nome
// precisa ser preenchido manualmente nesse caso. Não cobra créditos — só a
// geração final (POST /api/query, serviceId contrato-aluguel) debita o valor.
app.post('/api/contrato-aluguel/localizar', requireAuth, async (req, res) => {
  const cpf = (req.body?.cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });

  try {
    const ur = await pool.query('SELECT active FROM users WHERE id=$1', [req.user.id]);
    if (!ur.rows[0]?.active) return res.status(403).json({ error: 'Conta bloqueada.' });

    const apiRes = await fetch(`${DATACUBE_API_URL}/pessoas/localizacao_v3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_token: DATACUBE_TOKEN, cpf }),
    });
    const bodyStr = await apiRes.text();
    let parsed;
    try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
    if (!parsed) return res.status(502).json({ error: 'Erro ao consultar Localização CPF V3.' });

    const localizacaoResult = parsed.result ?? parsed;
    let localizacaoData = Array.isArray(localizacaoResult) ? (localizacaoResult[0] ?? {}) : localizacaoResult;
    if (localizacaoData?.historicos && typeof localizacaoData.historicos === 'object') {
      localizacaoData = localizacaoData.historicos;
    }
    const hasData = localizacaoData && (Array.isArray(localizacaoData)
      ? localizacaoData.length > 0
      : Object.keys(localizacaoData).length > 0);
    if (!hasData) return res.status(422).json({ error: 'Nenhum dado encontrado para esse CPF.' });

    const nome = extractNomeFromLocalizacaoV3(localizacaoData);
    res.json({ success: true, nome });
  } catch (err) {
    console.error('Erro em /api/contrato-aluguel/localizar:', err.message);
    res.status(500).json({ error: 'Erro interno ao buscar dados do CPF.' });
  }
});

// ── POST /api/procuracao-veicular/localizar-cpf ───────────────────────────────
// Etapa 1a do serviço "Gerar Procuração Veicular": busca o nome mais recente
// na Localização CPF V3 (Datacube) pra pré-preencher o nome do OUTORGADO (quem
// vai representar o OUTORGANTE) a partir do CPF digitado. Não cobra créditos.
// Reaproveitado pela "Gerar ASD" (aba Coisas de Despachantes) nos botões de
// busca do Profissional e do Beneficiário do Serviço — mesma entrada (CPF) e
// mesma saída (nome), então não vale duplicar a rota.
app.post('/api/procuracao-veicular/localizar-cpf', requireAuth, async (req, res) => {
  const cpf = (req.body?.cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });

  try {
    const ur = await pool.query('SELECT active FROM users WHERE id=$1', [req.user.id]);
    if (!ur.rows[0]?.active) return res.status(403).json({ error: 'Conta bloqueada.' });

    const apiRes = await fetch(`${DATACUBE_API_URL}/pessoas/localizacao_v3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_token: DATACUBE_TOKEN, cpf }),
    });
    const bodyStr = await apiRes.text();
    let parsed;
    try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
    if (!parsed) return res.status(502).json({ error: 'Erro ao consultar Localização CPF V3.' });

    const localizacaoResult = parsed.result ?? parsed;
    let localizacaoData = Array.isArray(localizacaoResult) ? (localizacaoResult[0] ?? {}) : localizacaoResult;
    if (localizacaoData?.historicos && typeof localizacaoData.historicos === 'object') {
      localizacaoData = localizacaoData.historicos;
    }
    const hasData = localizacaoData && (Array.isArray(localizacaoData)
      ? localizacaoData.length > 0
      : Object.keys(localizacaoData).length > 0);
    if (!hasData) return res.status(422).json({ error: 'Nenhum dado encontrado para esse CPF.' });

    const nome = extractNomeFromLocalizacaoV3(localizacaoData);
    res.json({ success: true, nome });
  } catch (err) {
    console.error('Erro em /api/procuracao-veicular/localizar-cpf:', err.message);
    res.status(500).json({ error: 'Erro interno ao buscar dados do CPF.' });
  }
});

// ── POST /api/procuracao-veicular/localizar-placa ─────────────────────────────
// Etapa 1b do serviço "Gerar Procuração Veicular": busca o proprietário atual
// e os dados do veículo (Proprietário Atual, mesmo endpoint Datacube da aba
// "Opção 2 Nova Consulta" — dc-proprietario-atual) a partir da placa, pra
// pré-preencher o OUTORGANTE (nome + CPF/CNPJ vêm junto do proprietário atual
// do veículo) e os campos do veículo. Se a Proprietário Atual não trouxer
// endereço, cai pra consulta completa da Vistocar só pra completar esse dado
// (ver fallback abaixo). Não cobra créditos. Reaproveitado pela "Gerar ASD"
// (aba Coisas de Despachantes) no botão de busca da Descrição Documental.
app.post('/api/procuracao-veicular/localizar-placa', requireAuth, async (req, res) => {
  const placa = (req.body?.placa || '').toUpperCase().replace(/[\s-]/g, '');
  if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });

  try {
    const ur = await pool.query('SELECT active FROM users WHERE id=$1', [req.user.id]);
    if (!ur.rows[0]?.active) return res.status(403).json({ error: 'Conta bloqueada.' });

    const apiRes = await fetch(`${DATACUBE_API_URL}/veiculos/proprietario-atual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_token: DATACUBE_TOKEN, placa }),
    });
    const bodyStr = await apiRes.text();
    let parsed;
    try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
    if (!parsed) return res.status(502).json({ error: 'Erro ao consultar Proprietário Atual.' });

    const result = parsed.result ?? parsed;
    const hasData = result && (Array.isArray(result) ? result.length > 0 : Object.keys(result).length > 0);
    if (!hasData) return res.status(422).json({ error: 'Nenhum dado encontrado para essa placa.' });

    const fields = extractProprietarioAtualFields(result);
    let endereco = composeEndereco(fields);

    // Proprietário Atual nem sempre traz endereço — cai pra consulta completa
    // da Vistocar (POST apiclient/completa, envelope status/response) só pra
    // completar esse dado. Best-effort: se falhar ou também não trouxer
    // endereço, segue sem — o formulário fica editável de qualquer forma.
    if (!endereco) {
      try {
        const token = await getVistocarToken();
        const vcRes = await fetch(`${VISTOCAR_BASE_URL}/apiclient/completa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ plate: placa }),
        });
        const vcParsed = await vcRes.json().catch(() => null);
        const vcOk = vcParsed?.status === 200 && vcParsed?.response?.success === true && vcParsed?.response?.dadosVeicular;
        if (vcOk) {
          const enderecos = vcParsed.response.dadosVeicular.proprietario?.enderecos;
          const end = Array.isArray(enderecos) && enderecos.length ? enderecos[0] : null;
          if (end) {
            endereco = composeEndereco({
              logradouro:  pickAlias(end, ['logradouro', 'endereco', 'rua']),
              numero:      pickAlias(end, ['numero', 'numero_endereco', 'num']),
              complemento: pickAlias(end, ['complemento']),
              bairro:      pickAlias(end, ['bairro']),
              cidade:      pickAlias(end, ['cidade', 'municipio']),
              uf:          pickAlias(end, ['uf', 'estado']),
              cep:         pickAlias(end, ['cep']),
            });
          }
        }
      } catch (e) {
        console.warn('[procuracao-veicular] fallback consulta completa Vistocar (endereço) falhou:', e.message);
      }
    }

    res.json({
      success: true,
      data: {
        nome: fields.nome, cpfCnpj: fields.cpfCnpj, endereco,
        marcaModelo: fields.marcaModelo, chassi: fields.chassi, renavam: fields.renavam,
        cor: fields.cor, anoFabricacao: fields.anoFabricacao, anoModelo: fields.anoModelo,
        // Só a ASD RJ consome estes — a Procuração Veicular ignora.
        especie: fields.especie, capacidade: fields.capacidade, procedencia: fields.procedencia,
        categoria: fields.categoria, tipo: fields.tipo, potencia: fields.potencia,
        combustivel: fields.combustivel, municipio: fields.municipio,
        // Endereço em partes, para as células separadas do formulário da ASD.
        logradouro: fields.logradouro, numero: fields.numero, complemento: fields.complemento,
        bairro: fields.bairro, cidade: fields.cidade, uf: fields.uf, cep: fields.cep,
      },
    });
  } catch (err) {
    console.error('Erro em /api/procuracao-veicular/localizar-placa:', err.message);
    res.status(500).json({ error: 'Erro interno ao buscar dados da placa.' });
  }
});

// ── GET /api/cep/:cep ─────────────────────────────────────────────────────────
// Busca endereço + código IBGE do município via ViaCEP, para autopreencher o
// formulário de Comunicação de Venda a partir do CEP do comprador.
app.get('/api/cep/:cep', requireAuth, async (req, res) => {
  const cep = (req.params.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido. Deve ter 8 dígitos.' });

  try {
    const viaCepRes = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    if (!viaCepRes.ok) return res.status(502).json({ error: 'Erro ao consultar o CEP.' });
    const data = await viaCepRes.json();
    if (data.erro) return res.status(404).json({ error: 'CEP não encontrado.' });
    res.json({
      logradouro: data.logradouro || '',
      bairro: data.bairro || '',
      uf: data.uf || '',
      cidade_nome: data.localidade || '',
      cidade_ibge: data.ibge || '',
    });
  } catch (err) {
    console.error('Erro ao consultar ViaCEP:', err.message);
    res.status(502).json({ error: 'Erro ao consultar o CEP.' });
  }
});

// ── Extrai campos a partir dos valores de formulário do PDF (AcroForm) ─────────
// O ATPV-e do SENATRAN é um PDF preenchível: os valores reais (CPF, nome, chassi
// etc.) ficam em campos de formulário, não no texto da página — por isso os
// rótulos aparecem todos juntos no texto (só o "template" estático) enquanto os
// valores ficam soltos em outro lugar, sem proximidade com o rótulo correspondente.
// Como o nome interno de cada campo nem sempre é descritivo, classificamos os
// valores pelo FORMATO (placa, CPF, data, UF...) e usamos o nome do campo como
// desempate quando ele contém uma palavra-chave reconhecível.
function extrairDeCampos(campos) {
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const lista = campos
    .map(c => ({ chave: norm(c.nome), valor: String(c.valor || '').trim() }))
    .filter(c => c.valor);

  // Controla quais ENTRADAS (não valores) já foram atribuídas a um campo de
  // saída — usar o valor em si para isso quebraria sempre que dois campos
  // diferentes tiverem o mesmo conteúdo (ex.: UF do comprador igual à UF da
  // venda, bem comum), fazendo o segundo "desaparecer" por engano.
  const usadas = new Set();
  const marcar = (entrada) => { if (entrada) usadas.add(entrada); return entrada ? entrada.valor : ''; };
  const livres = () => lista.filter(c => !usadas.has(c));
  // aceita tanto RegExp (via .test) quanto função predicado — isChassiF é uma
  // função porque precisa de duas condições (17 chars + tem letra)
  const bate = (padrao, v) => typeof padrao === 'function' ? padrao(v) : padrao.test(v);

  // entradas livres cujo nome do campo contém todas as palavras dadas
  const porNome = (...palavras) => livres().filter(c => palavras.every(p => c.chave.includes(p)));

  // primeira entrada (nome > formato) que combina com o padrão e ainda está livre
  const primeiro = (padrao, ...palavrasNome) => {
    const porPalavra = palavrasNome.length ? porNome(...palavrasNome).find(c => bate(padrao, c.valor)) : null;
    if (porPalavra) return marcar(porPalavra);
    const porFormato = livres().find(c => bate(padrao, c.valor));
    return marcar(porFormato);
  };

  // campo que aparece 2x (vendedor/comprador) com o mesmo formato — usa o nome
  // do campo pra saber de quem é; se não der pra saber, assume a ordem em que os
  // campos aparecem no formulário (vendedor vem antes do comprador no ATPV-e).
  const par = (padrao, tagsA, tagsB) => {
    const entA = porNome(...tagsA).find(c => bate(padrao, c.valor));
    let a = marcar(entA);
    const entB = porNome(...tagsB).find(c => bate(padrao, c.valor));
    let b = marcar(entB);
    if (!a) { const f = livres().find(c => bate(padrao, c.valor)); a = marcar(f); }
    if (!b) { const f = livres().find(c => bate(padrao, c.valor)); b = marcar(f); }
    return [a, b];
  };

  const isPlaca   = /^[A-Z]{3}[\s-]?[0-9][A-Z0-9][0-9]{2}$/i;
  const isChassiF = (v) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(v) && /[A-Z]/i.test(v);
  const isCep     = /^\d{5}-?\d{3}$/;
  const isUF      = /^[A-Z]{2}$/i;
  const isData    = /^\d{2}\/\d{2}\/\d{4}$/;
  const isValor   = /^\d{1,3}(\.\d{3})*(,\d{2})?$|^\d+([.,]\d{2})?$/;
  const isCpf     = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
  const isNumero9a12 = /^\d{9,12}$/;
  const isNome    = (v) => /^[A-ZÀ-Ú' ]{4,60}$/i.test(v) && /\s/.test(v.trim());

  const placa      = primeiro(isPlaca, 'placa');
  const chassiVal  = primeiro(isChassiF, 'chassi');
  const renavam    = primeiro(isNumero9a12, 'renavam');
  const crv_numero = primeiro(isNumero9a12, 'crv', 'numero');
  const crv_codigo = primeiro(isNumero9a12, 'seguranca');
  const crv_via    = primeiro(/^\d{1,2}$/, 'via');
  const crv_uf     = primeiro(isUF, 'emissao');
  const crv_data   = primeiro(isData, 'emissao');

  const [v_cpf, c_cpf] = par(isCpf, ['vendedor'], ['comprador']);
  const [v_nomeVal, c_nomeVal] = (() => {
    let vn = marcar(porNome('vendedor', 'nome').find(c => isNome(c.valor)) || porNome('vendedor').find(c => isNome(c.valor)));
    let cn = marcar(porNome('comprador', 'nome').find(c => isNome(c.valor)) || porNome('comprador').find(c => isNome(c.valor)));
    if (!vn) vn = marcar(livres().find(c => isNome(c.valor)));
    if (!cn) cn = marcar(livres().find(c => isNome(c.valor)));
    return [vn, cn];
  })();

  const c_cep       = primeiro(isCep, 'cep');
  const c_uf         = primeiro(isUF, 'comprador') || primeiro(isUF, 'uf');
  const venda_valor  = primeiro(isValor, 'valor');
  const venda_data   = primeiro(isData, 'venda') || primeiro(isData);
  const venda_estado = primeiro(isUF, 'venda') || primeiro(isUF, 'uf');

  return {
    placa: placa.replace(/[\s-]/g, ''),
    renavam: renavam.replace(/\D/g, ''),
    chassi: chassiVal,
    crv_numero, crv_codigo, crv_via, crv_data, crv_uf,
    v_cpf: v_cpf.replace(/[\.\-\s]/g, ''),
    v_nome: v_nomeVal,
    c_cpf: c_cpf.replace(/[\.\-\s]/g, ''),
    c_nome: c_nomeVal,
    c_cep: c_cep.replace(/[\.\-\s]/g, ''),
    c_uf,
    venda_valor: venda_valor.replace(/\./g, '').replace(',', '.'),
    venda_data,
    venda_estado,
  };
}

// ── Extrai campos pela POSIÇÃO do texto na página (x/y de cada item do PDF.js) ──
// O ATPV-e do SENATRAN, quando "achatado" (sem AcroForm — ver extrairDeCampos),
// é um formulário em duas colunas onde cada rótulo fica visualmente ACIMA (ou,
// em um caso, ao lado) do seu valor — mas a ORDEM em que o texto sai do PDF não
// segue esse layout visual. Reconstruindo as linhas por coordenada (y desc, x
// asc) e pareando cada rótulo conhecido com o texto na mesma coluna logo
// abaixo, conseguimos ler qualquer valor independente do formato (isso também
// resolve o chassi: veículos antigos têm chassi só numérico, mais novos têm
// letras — aqui não importa, pegamos o que estiver na posição certa).
function extrairDePosicoes(itens) {
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

  const validos = (itens || [])
    .filter(i => i && typeof i.str === 'string' && i.str.trim() && typeof i.x === 'number' && typeof i.y === 'number')
    .map(i => ({ str: i.str, x: i.x, y: i.y }));
  if (!validos.length) return {};

  validos.sort((a, b) => b.y - a.y || a.x - b.x);
  const linhas = [];
  for (const it of validos) {
    const ultima = linhas[linhas.length - 1];
    if (ultima && Math.abs(ultima.y - it.y) < 5) ultima.itens.push(it);
    else linhas.push({ y: it.y, itens: [it] });
  }
  linhas.forEach(l => l.itens.sort((a, b) => a.x - b.x));

  const acharLinha = (textoAlvo, dentro) => {
    const alvo = norm(textoAlvo);
    for (let i = 0; i < linhas.length; i++) {
      if (dentro && !dentro(linhas[i].y)) continue;
      const item = linhas[i].itens.find(it => norm(it.str) === alvo);
      if (item) return { linhaIdx: i, item };
    }
    return null;
  };
  const valorAbaixo = (linhaIdx, x, maxLinhas = 3, xTol = 20) => {
    for (let j = linhaIdx + 1; j < linhas.length && j <= linhaIdx + maxLinhas; j++) {
      const cand = linhas[j].itens.find(it => Math.abs(it.x - x) <= xTol && it.str.trim());
      if (cand) return cand.str.trim();
    }
    return '';
  };
  const valorMesmaLinha = (linhaIdx, x) => {
    const cand = linhas[linhaIdx].itens.find(it => it.x > x + 5 && it.str.trim());
    return cand ? cand.str.trim() : '';
  };

  const lComprador = acharLinha('IDENTIFICAÇÃO DO COMPRADOR');
  const yCompradorInicio = lComprador ? lComprador.item.y : -Infinity;
  const naSecao = (secao) => (y) => secao === 'vendedor' ? y > yCompradorInicio : y <= yCompradorInicio;

  const campo = (label, secao) => {
    const l = acharLinha(label, secao ? naSecao(secao) : undefined);
    return l ? valorAbaixo(l.linhaIdx, l.item.x) : '';
  };

  const placa      = campo('PLACA');
  const renavam    = campo('CÓDIGO RENAVAM').replace(/\D/g, '');
  const chassi     = campo('CHASSI');
  const crv_numero = campo('NÚMERO CRV');
  const crv_codigo = campo('CÓDIGO DE SEGURANÇA CRV');
  const crv_data   = campo('DATA EMISSÃO DO CRV');
  const venda_data = campo('DATA DECLARADA DA VENDA');

  // UF de emissão (DETRAN emissor) — fica ao lado do texto "DETRAN -"
  const lDetran = acharLinha('DETRAN -');
  const crv_uf = lDetran ? (linhas[lDetran.linhaIdx].itens.find(it => it.x > lDetran.item.x)?.str.trim() || '') : '';

  const v_nome = campo('NOME', 'vendedor');
  const v_cpf  = campo('CPF/CNPJ', 'vendedor').replace(/[.\-\s]/g, '');
  const c_nome = campo('NOME', 'comprador');
  const c_cpf  = campo('CPF/CNPJ', 'comprador').replace(/[.\-\s]/g, '');
  const c_uf   = campo('UF', 'comprador');

  const lValor = acharLinha('Valor declarado na venda: R$');
  const venda_valor_raw = lValor ? valorMesmaLinha(lValor.linhaIdx, lValor.item.x) : '';
  const venda_valor = venda_valor_raw.replace(/\./g, '').replace(',', '.');

  // Endereço do comprador: valor pode ocupar 1-2 linhas até aparecer o CEP
  let c_cep = '';
  const lEndereco = acharLinha('ENDEREÇO DE DOMICÍLIO OU RESIDÊNCIA', naSecao('comprador'));
  if (lEndereco) {
    let texto = '';
    for (let j = lEndereco.linhaIdx + 1; j < linhas.length; j++) {
      const linhaTexto = linhas[j].itens.map(it => it.str).join(' ').trim();
      if (!linhaTexto) continue;
      if (/ASSINATURA|MENSAGENS|AUTENTICA/.test(norm(linhaTexto))) break;
      texto += (texto ? ' ' : '') + linhaTexto;
      if (/CEP/i.test(linhaTexto)) break;
    }
    const cepM = texto.match(/CEP[:\s]*([0-9]{5}-?[0-9]{3})/i);
    c_cep = cepM ? cepM[1].replace(/\D/g, '') : '';
  }

  // "Estado" da venda não tem rótulo próprio neste modelo de documento — a UF
  // do DETRAN emissor é o melhor palpite disponível (normalmente a mesma).
  const venda_estado = crv_uf;

  return {
    placa, renavam, chassi, crv_numero, crv_codigo, crv_via: '', crv_data, crv_uf,
    v_cpf, v_nome, c_cpf, c_nome, c_cep, c_uf,
    venda_valor, venda_data, venda_estado,
  };
}

// ── CRLV-e: extração por POSIÇÃO + validação ──────────────────────────────────
// Alimenta o "Importar CRLV-e" do formulário de ATPV-e. O CRLV-e digital é o
// modelo nacional do SENATRAN — idêntico em RJ e MG (conferido em 16/09/2026
// contra três documentos reais, um deles de PJ) — e é "achatado": no texto puro
// os rótulos saem todos juntos e os valores em outra ordem, colados uns nos
// outros ("KML1C23/RJ" seguido do chassi na mesma linha). Ler por regex ali dá
// errado. O que salva é a POSIÇÃO: cada valor fica na linha de baixo, na MESMA
// coluna (x) do rótulo. Por isso a leitura é por coordenada, como no ATPV-e.
//
// O que NÃO sai daqui, de propósito:
// - **Código de Segurança do CRV**: o CRLV-e traz o "CÓDIGO DE SEGURANÇA DO
//   CLA", que é do Certificado de Licenciamento Anual, não do CRV. São códigos
//   diferentes; preencher um no campo do outro entregaria um ATPV-e com dado
//   errado. (Se ele estivesse no CRLV-e, o serviço "Código de Segurança CRV" do
//   nosso próprio catálogo não teria razão de existir.)
// - **Comprador**: o CRLV-e é do vendedor; não há nada do comprador nele.
function extrairCrlvePosicoes(itens) {
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

  const validos = (itens || [])
    .filter(i => i && typeof i.str === 'string' && i.str.trim() && typeof i.x === 'number' && typeof i.y === 'number')
    .map(i => ({ str: i.str, x: i.x, y: i.y }));
  if (!validos.length) return {};

  validos.sort((a, b) => b.y - a.y || a.x - b.x);
  const linhas = [];
  for (const it of validos) {
    const ultima = linhas[linhas.length - 1];
    if (ultima && Math.abs(ultima.y - it.y) < 5) ultima.itens.push(it);
    else linhas.push({ y: it.y, itens: [it] });
  }
  linhas.forEach(l => l.itens.sort((a, b) => a.x - b.x));

  // Rótulo é comparado por igualdade exata (normalizada): "PLACA" não pode
  // casar com "PLACA ANTERIOR / UF", que fica logo abaixo na mesma coluna.
  const acharLinha = (textoAlvo) => {
    const alvo = norm(textoAlvo);
    for (let i = 0; i < linhas.length; i++) {
      const item = linhas[i].itens.find(it => norm(it.str) === alvo);
      if (item) return { linhaIdx: i, item };
    }
    return null;
  };
  const valorAbaixo = (linhaIdx, x, maxLinhas = 3, xTol = 20) => {
    for (let j = linhaIdx + 1; j < linhas.length && j <= linhaIdx + maxLinhas; j++) {
      const cand = linhas[j].itens.find(it => Math.abs(it.x - x) <= xTol && it.str.trim());
      if (cand) return cand.str.trim();
    }
    return '';
  };
  const campo = (rotulo) => {
    const l = acharLinha(rotulo);
    return l ? valorAbaixo(l.linhaIdx, l.item.x) : '';
  };

  // A UF do Detran emissor fica ao LADO do texto "DETRAN-", não abaixo.
  const lDetran = acharLinha('DETRAN-');
  const detran_uf = lDetran
    ? (linhas[lDetran.linhaIdx].itens.find(it => it.x > lDetran.item.x)?.str.trim() || '')
    : '';

  // "LOCAL" vem como "CAMPOS DOS GOYTACAZES RJ" — município e UF no mesmo item,
  // separados por espaço. A UF é o último pedaço, quando tem 2 letras.
  const local = campo('LOCAL');
  const mLocal = local.match(/^(.*?)\s+([A-Za-z]{2})$/);

  // O PDF é mesmo um CRLV-e? Sem isso, o ATPV-e do próprio veículo (que o
  // despachante tem aberto na mesma pasta e seleciona por engano) é lido como
  // se fosse: placa e renavam até saem certos, mas os rótulos dele caem nos
  // campos errados — visto ao rodar um ATPV-e real por aqui em 16/09/2026, que
  // devolvia "DATA DECLARADA DA VENDA" como município. Melhor recusar o arquivo
  // do que preencher um cadastro que vai ao Detran com dado de outro documento.
  const ehCrlve = validos.some(it => norm(it.str).includes('LICENCIAMENTO DE VEICULO'))
    || (!!acharLinha('CÓDIGO RENAVAM') && !!acharLinha('CÓDIGO DE SEGURANÇA DO CLA'));

  return {
    eh_crlve:        ehCrlve,
    placa:           campo('PLACA'),
    renavam:         campo('CÓDIGO RENAVAM'),
    chassi:          campo('CHASSI'),
    ano_fabricacao:  campo('ANO FABRICAÇÃO'),
    ano_modelo:      campo('ANO MODELO'),
    crv_numero:      campo('NÚMERO DO CRV'),
    v_nome:          campo('NOME'),
    v_doc:           campo('CPF / CNPJ'),
    // "LOCAL" do CRLV-e é sempre "MUNICÍPIO UF" no mesmo item. Sem a UF colada
    // no fim, o que veio não é esse campo — e um rótulo de outro documento no
    // lugar do município é exatamente o erro que se quer evitar aqui.
    local_cidade:    mLocal ? mLocal[1].trim() : '',
    local_uf:        mLocal ? mLocal[2].toUpperCase() : '',
    detran_uf:       detran_uf.toUpperCase(),
  };
}

// Valida campo a campo o que veio do PDF. Nada entra no formulário sem passar
// por aqui: o CRLV-e pode ter vindo de OCR (PDF escaneado), e um dado torto
// preenchido em silêncio vira um ATPV-e errado — que é registrado no Detran e
// cobrado. O que não passa volta como "rejeitado", com o rótulo, para o painel
// dizer ao despachante o que ele precisa conferir e digitar à mão.
function validarCamposCrlve(bruto) {
  const campos = {};
  const rejeitados = [];
  const b = bruto || {};
  const dig = (v) => String(v || '').replace(/\D/g, '');
  const anoMax = new Date().getFullYear() + 1;
  const guardar = (chave, valor) => { if (valor) campos[chave] = valor; };
  // Só é "rejeitado" o que o PDF trouxe e não passou. Campo que simplesmente
  // não existe no documento (CRV digital não tem número de CRV, por exemplo)
  // não vira aviso — não há nada de errado com ele.
  const recusar = (chave, rotulo, valorLido) => {
    if (String(valorLido || '').trim()) rejeitados.push({ campo: chave, rotulo });
  };

  const placa = String(b.placa || '').toUpperCase().replace(/[\s-]/g, '');
  if (/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) guardar('placa', placa);
  else recusar('placa', 'Placa', b.placa);

  // Renavam tem 11 dígitos e a Vistocar recusa com menos ("INFORME CORRETAMENTE
  // O RENAVAM ... DEVE TER 11 DIGITOS"). O documento às vezes sai com os zeros
  // da frente comidos, então completamos — é o mesmo número, e sem isso o
  // pedido morreria lá no fornecedor.
  const renavam = dig(b.renavam);
  if (renavam.length >= 9 && renavam.length <= 11) guardar('renavam', renavam.padStart(11, '0'));
  else recusar('renavam', 'Renavam', b.renavam);

  // Chassi: 17 posições, sem I/O/Q (padrão VIN). Veículo antigo pode ter chassi
  // só de números, então não se exige letra.
  const chassi = String(b.chassi || '').toUpperCase().replace(/[\s.-]/g, '');
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(chassi)) guardar('chassi', chassi);
  else recusar('chassi', 'Chassi', b.chassi);

  for (const [chave, rotulo] of [['ano_fabricacao', 'Ano de fabricação'], ['ano_modelo', 'Ano do modelo']]) {
    const ano = dig(b[chave]);
    if (/^\d{4}$/.test(ano) && Number(ano) >= 1900 && Number(ano) <= anoMax) guardar(chave, ano);
    else recusar(chave, rotulo, b[chave]);
  }

  const crvNumero = dig(b.crv_numero);
  if (crvNumero.length >= 9 && crvNumero.length <= 12) guardar('crv_numero', crvNumero);
  else recusar('crv_numero', 'Número do CRV', b.crv_numero);

  // Documento do proprietário: dígito verificador conferido (isValidDoc). OCR
  // troca 8 por B com facilidade — um CPF que não fecha é um CPF que não é.
  const doc = dig(b.v_doc);
  if (isValidDoc(doc)) guardar('v_doc', doc);
  else recusar('v_doc', 'CPF/CNPJ do vendedor', b.v_doc);

  const nome = String(b.v_nome || '').trim().replace(/\s+/g, ' ');
  if (nome.length >= 3 && /^[A-Za-zÀ-ÿ0-9&'.\- ]+$/.test(nome)) guardar('v_nome', nome.toUpperCase());
  else recusar('v_nome', 'Nome do vendedor', b.v_nome);

  const cidade = String(b.local_cidade || '').trim().replace(/\s+/g, ' ');
  if (cidade.length >= 2 && /^[A-Za-zÀ-ÿ'.\- ]+$/.test(cidade)) guardar('local_cidade', cidade.toUpperCase());
  else recusar('local_cidade', 'Município do licenciamento', b.local_cidade);

  const uf = String(b.local_uf || b.detran_uf || '').toUpperCase();
  if (ATPVE_UFS_VALIDAS.has(uf)) guardar('local_uf', uf);
  else recusar('local_uf', 'UF do licenciamento', b.local_uf || b.detran_uf);

  return { campos, rejeitados };
}

// ── POST /api/pdf/extrair-crlve ───────────────────────────────────────────────
// Irmã da /api/pdf/extrair-atpv, para o outro documento: recebe o texto e as
// posições que o PDF.js leu no navegador e devolve os campos do CRLV-e **já
// validados** (`{ campos, rejeitados }`), para o painel preencher o formulário
// do ATPV-e. Sem posição não há leitura confiável neste documento (ver o
// comentário de extrairCrlvePosicoes), então o texto puro serve só de reserva
// para o caso do OCR, em que não há coordenada de PDF nenhuma.
app.post('/api/pdf/extrair-crlve', requireAuth, async (req, res) => {
  const { texto, posicoes } = req.body;
  const temPosicoes = Array.isArray(posicoes) && posicoes.length;
  if (!texto && !temPosicoes) return res.status(400).json({ error: 'Nenhum dado enviado.' });

  let bruto = temPosicoes ? extrairCrlvePosicoes(posicoes) : {};

  const txtCru = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const pareceCrlve = bruto.eh_crlve || txtCru.includes('LICENCIAMENTO DE VEICULO');
  if (!pareceCrlve)
    return res.status(422).json({ error: 'Esse PDF não parece um CRLV-e. Selecione o Certificado de Registro e Licenciamento do veículo — o ATPV-e e o CRV não servem aqui.' });

  // Reserva para texto sem coordenada (OCR): pega o que dá por rótulo. É menos
  // confiável, e é justamente por isso que a validação acima existe — o que sair
  // torto é recusado em vez de entrar no formulário.
  if (!bruto.placa || !bruto.renavam) {
    const txt = String(texto || '').replace(/\s+/g, ' ').toUpperCase();
    const m = (r) => (txt.match(r) || [])[1] || '';
    bruto = {
      ...bruto,
      placa:   bruto.placa   || m(/PLACA[^A-Z0-9]{0,20}([A-Z]{3}[\s-]?[0-9][A-Z0-9][0-9]{2})\b/),
      renavam: bruto.renavam || m(/RENAVAM[^0-9]{0,20}(\d{9,11})\b/),
      chassi:  bruto.chassi  || m(/CHASSI[^A-Z0-9]{0,20}([A-HJ-NPR-Z0-9]{17})\b/),
    };
  }

  const { campos, rejeitados } = validarCamposCrlve(bruto);

  // Sem placa nem renavam não houve leitura nenhuma — provavelmente o PDF não é
  // um CRLV-e, ou é uma imagem ruim demais até para o OCR.
  if (!campos.placa && !campos.renavam)
    return res.status(422).json({ error: 'Não consegui ler os dados do CRLV-e. Confira se o PDF é o documento do veículo — se for uma foto, preencha à mão.' });

  res.json({ campos, rejeitados });
});

// ── POST /api/pdf/extrair-atpv ────────────────────────────────────────────────
// Recebe texto (e, se o PDF for preenchível, os campos de formulário) extraídos
// pelo PDF.js no browser e retorna os campos identificados.
app.post('/api/pdf/extrair-atpv', requireAuth, async (req, res) => {
  const { texto, campos, posicoes } = req.body;
  if (!texto && !(Array.isArray(campos) && campos.length) && !(Array.isArray(posicoes) && posicoes.length))
    return res.status(400).json({ error: 'Nenhum dado enviado.' });

  const doCampos    = Array.isArray(campos) && campos.length ? extrairDeCampos(campos) : null;
  const doPosicoes  = Array.isArray(posicoes) && posicoes.length ? extrairDePosicoes(posicoes) : null;

  const txt = (texto || '').replace(/\s+/g, ' ').toUpperCase();
  const m   = (r) => (txt.match(r) || [])[1] || '';

  // ── Vendedor/Comprador CPF (extraídos cedo para não colidir com renavam/chassi) ──
  // Janela limitada a 40 caracteres entre o rótulo e o valor: evita que o regex
  // "vaze" para outra seção do documento (ex.: pegar o Renavam do veículo em vez
  // do CPF) quando o rótulo e o valor de outro campo ficam próximos no texto extraído.
  let v_cpf_raw = m(/(?:VENDEDOR|ALIENANTE|TRANSMITENTE)[^0-9]{0,40}?(\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\.\s\-]?\d{2})/);
  const v_nome = m(/(?:VENDEDOR|ALIENANTE|TRANSMITENTE)[^A-Z]{0,40}?([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]{4,60}?)(?:\s{2,}|CPF|CNPJ)/);
  let c_cpf_raw = m(/(?:COMPRADOR|ADQUIRENTE)[^0-9]{0,40}?(\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\.\s\-]?\d{2})/);

  // ── Veículo ──
  let placa  = m(/PLACA[^A-Z0-9]*([A-Z]{3}[\s-]?[0-9A-Z][0-9A-Z]{2}[0-9]{2})/);
  if (!placa) placa = m(/\b([A-Z]{3}[\s-]?[0-9][A-Z0-9][0-9]{2})\b/);
  placa = placa.replace(/[\s-]/g, '');

  const cpfsConhecidos = () => [v_cpf_raw, c_cpf_raw].map(v => v.replace(/[\.\-\s]/g, '')).filter(Boolean);

  let renavam = m(/RENAVAM[^0-9]{0,40}?(\d{9,11})/);
  if (!renavam || cpfsConhecidos().includes(renavam)) {
    // Fallback: primeiro número solto de 9-11 dígitos que não seja um CPF já identificado
    const candidatos = txt.match(/\b\d{9,11}\b/g) || [];
    renavam = candidatos.find(n => !cpfsConhecidos().includes(n)) || renavam || '';
  }

  // Chassi (VIN): sempre alfanumérico com pelo menos uma letra e sem I/O/Q — evita
  // que uma sequência de 17 dígitos puros (ex.: outro código do documento) seja
  // confundida com o chassi real.
  let chassi = m(/CHASSI[^A-Z0-9]{0,40}?([A-HJ-NPR-Z0-9]{17})/);
  if (!chassi) chassi = m(/\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/);

  // Um CPF que na verdade é o Renavam do veículo indica que o regex vazou para a
  // seção errada — melhor deixar em branco do que preencher errado.
  if (renavam && v_cpf_raw.replace(/[\.\-\s]/g, '') === renavam) v_cpf_raw = '';
  if (renavam && c_cpf_raw.replace(/[\.\-\s]/g, '') === renavam) c_cpf_raw = '';

  // ── CRV ──
  const crv_numero = m(/(?:N[ÚU]MERO\s+(?:DO\s+)?CRV|CRV\s+N[ÚU]MERO)[^0-9]*(\d{9,12})/);
  const crv_codigo = m(/C[ÓO]DIGO\s+(?:DE\s+)?SEGURAN[CÇ]A[^0-9]*(\d{6,11})/);
  const crv_via    = m(/(?:N[ÚU]MERO\s+)?VIA[^0-9]*(\d)\b/);
  const crv_uf     = m(/(?:UF|ESTADO)\s+(?:DE\s+)?EMISS[ÃA]O[^A-Z]*([A-Z]{2})\b/);
  const datas      = txt.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  const crv_data   = datas[0] || '';
  const v_cpf = v_cpf_raw;

  // ── Comprador ──
  const c_cpf  = c_cpf_raw;
  const c_nome = m(/(?:COMPRADOR|ADQUIRENTE)[^A-Z]*([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]{4,60}?)(?:\s{2,}|CPF|CNPJ)/);
  const c_cep  = m(/CEP[^0-9]*(\d{5}[\-]?\d{3})/);
  const c_uf   = m(/(?:ESTADO|UF)[^A-Z]*(?:DO\s+COMPRADOR)?[^A-Z]*([A-Z]{2})\b/);

  // ── Venda ──
  const venda_valor  = m(/VALOR[^0-9]*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/);
  // Só usa a 2ª data encontrada no PDF; se houver apenas uma, ela já foi atribuída
  // ao CRV (crv_data) e não deve ser duplicada aqui — melhor deixar em branco para
  // o usuário conferir do que preencher automaticamente com a data errada.
  const venda_data   = datas[1] || '';
  const venda_estado = m(/(?:MUNIC[ÍI]PIO|CIDADE)\s+(?:DA\s+)?VENDA[^A-Z]*[A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]+[\s,]+([A-Z]{2})\b/);

  const doTexto = {
    placa, renavam, chassi, crv_numero, crv_codigo, crv_via, crv_data, crv_uf,
    v_cpf: v_cpf.replace(/[\.\-\s]/g,''),
    v_nome: v_nome.trim(),
    c_cpf: c_cpf.replace(/[\.\-\s]/g,''),
    c_nome: c_nome.trim(),
    c_cep: c_cep.replace(/[\.\-\s]/g,''),
    c_uf,
    venda_valor: venda_valor.replace(/\./g,'').replace(',','.'),
    venda_data,
    venda_estado,
  };

  // Prioridade: campos de formulário (quando o PDF é preenchível) > posição do
  // texto na página (quando é "achatado", caso mais comum do ATPV-e) > regex
  // por proximidade no texto puro (último recurso, cobre variações de layout).
  const resultado = {};
  for (const chave of Object.keys(doTexto)) {
    resultado[chave] = (doCampos && doCampos[chave]) || (doPosicoes && doPosicoes[chave]) || doTexto[chave];
  }

  if (!resultado.placa && !resultado.renavam && !resultado.chassi)
    return res.status(422).json({ error: 'Não foi possível extrair dados do PDF. Preencha manualmente.' });

  res.json(resultado);
});

// ── ADMIN: GET /api/admin/stats ───────────────────────────────────────────────
app.get('/api/admin/stats', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [usersRow, activeRow, bannedRow, creditsRow, revenueRow, queriesRow, monthRow, todayRow, depositMonthRow] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM users WHERE active=true'),
      pool.query('SELECT COUNT(*) FROM users WHERE active=false'),
      pool.query('SELECT COALESCE(SUM(credits),0) AS total FROM users'),
      pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='deposit'"),
      pool.query('SELECT COUNT(*) FROM queries'),
      pool.query("SELECT COUNT(*) FROM queries WHERE created_at >= date_trunc('month', NOW())"),
      pool.query("SELECT COUNT(*) FROM queries WHERE created_at >= CURRENT_DATE"),
      pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='deposit' AND created_at >= date_trunc('month', NOW())"),
    ]);
    res.json({
      total_users:     parseInt(usersRow.rows[0].count),
      active_users:    parseInt(activeRow.rows[0].count),
      banned_users:    parseInt(bannedRow.rows[0].count),
      total_credits:   parseFloat(creditsRow.rows[0].total),
      total_revenue:   parseFloat(revenueRow.rows[0].total),
      total_queries:   parseInt(queriesRow.rows[0].count),
      month_queries:   parseInt(monthRow.rows[0].count),
      today_queries:   parseInt(todayRow.rows[0].count),
      month_revenue:   parseFloat(depositMonthRow.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: GET /api/admin/users ───────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
  const { search = '', role = '', active = '' } = req.query;
  try {
    const conds = []; const vals = []; let i = 1;
    if (search) { conds.push(`(u.name ILIKE $${i} OR u.email ILIKE $${i} OR u.cpf_cnpj ILIKE $${i})`); vals.push(`%${search}%`); i++; }
    if (role)   { conds.push(`u.role=$${i}`);   vals.push(role); i++; }
    if (active !== '') { conds.push(`u.active=$${i}`); vals.push(active === 'true'); i++; }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    await ensureDbReady();   // mensagens_usuario é tabela nova — ver ensureDbReady
    // LEFT JOIN LATERAL traz a assinatura vigente de cada usuário (a indefinida
    // primeiro, mesma regra do getAssinaturaVigente) para a tabela do admin
    // mostrar quem tem acesso à aba "Coisas de Despachantes" sem uma consulta
    // por linha.
    const r = await pool.query(
      `SELECT u.id,u.name,u.email,u.cpf_cnpj,u.phone,u.role,u.credits,u.active,u.created_at,u.affiliate_code,
              u.pos_pago, u.pos_pago_limite,
              (SELECT COUNT(*)::int FROM mensagens_usuario mu
                WHERE mu.user_id = u.id AND mu.autor='usuario' AND mu.lida_em IS NULL) AS mensagens_nao_lidas,
              (SELECT COUNT(*)::int FROM mensagens_usuario mu
                WHERE mu.user_id = u.id AND mu.autor='admin' AND mu.lida_em IS NULL) AS mensagens_pendentes,
              s.expires_at AS assinatura_expira_em,
              s.origem     AS assinatura_origem,
              s.cota       AS assinatura_cota,
              s.queries_used AS assinatura_usadas
         FROM users u
         LEFT JOIN LATERAL (
           SELECT expires_at, origem, cota, queries_used FROM subscriptions
            WHERE user_id = u.id AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY expires_at DESC NULLS FIRST LIMIT 1
         ) s ON true
       ${where}
       ORDER BY u.created_at DESC LIMIT 500`, vals
    );
    res.json({ users: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: POST /api/admin/users/:id/assinatura ──────────────────────────────
// Libera a Assinatura Coisas de Despachantes na mão, sem PIX. Dois modos:
//   modo='indefinida' → expires_at NULL, vale até o admin revogar
//   modo='ate'        → expires_at na data escolhida (fim do dia, horário de BSB)
// cota vazia/ausente = ilimitada; qualquer número = teto de consultas de placa.
// Cada liberação SUBSTITUI a cortesia anterior do usuário (não empilha), mas
// não mexe nos períodos pagos por PIX — se o cliente já pagou, aquele período
// continua valendo e o de cortesia soma como alternativa.
app.post('/api/admin/users/:id/assinatura', requireAuth, requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { modo, data, cota } = req.body || {};
  if (!['indefinida', 'ate'].includes(modo))
    return res.status(400).json({ error: 'Modo inválido. Use "indefinida" ou "ate".' });

  let expiresAt = null;
  if (modo === 'ate') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || '')))
      return res.status(400).json({ error: 'Informe a data limite no formato AAAA-MM-DD.' });
    // Fim do dia no horário de Brasília: liberar "até 20/09" deve valer o dia 20 inteiro.
    expiresAt = new Date(`${data}T23:59:59-03:00`);
    if (isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'Data limite inválida.' });
    if (expiresAt.getTime() <= Date.now())
      return res.status(400).json({ error: 'A data limite precisa ser no futuro.' });
  }

  let cotaFinal = null;
  if (cota !== '' && cota !== null && cota !== undefined) {
    cotaFinal = parseInt(cota, 10);
    if (!Number.isInteger(cotaFinal) || cotaFinal < 1)
      return res.status(400).json({ error: 'Cota inválida. Informe um número inteiro maior que zero ou deixe vazio para ilimitada.' });
  }

  try {
    const u = await pool.query('SELECT id, name FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

    // A cortesia segue o formato do plano pago: cota de placas escolhida pelo
    // admin e a do Código de Segurança CRV no padrão (ASSINATURA_CRV_COTA). Se o
    // admin liberou sem teto, as duas ficam ilimitadas — é o sentido de "cota
    // vazia" na tela do admin, que continua com um campo só.
    const cotaCrvFinal = cotaFinal === null ? null : ASSINATURA_CRV_COTA;
    const cotaAssinFinal = cotaFinal === null ? null : ASSINATURA_DIGITAL_COTA;
    const cotaVerifFinal = cotaFinal === null ? null : ASSINATURA_VERIFICAR_CRLV_COTA;
    await pool.query(`DELETE FROM subscriptions WHERE user_id=$1 AND origem='CORTESIA'`, [userId]);
    const r = await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, starts_at, expires_at, origem,
                                  cota, cota_crv, cota_assinatura, cota_verificar_crlv)
       VALUES ($1,$2,'ACTIVE',NOW(),$3,'CORTESIA',$4,$5,$6,$7)
       RETURNING id, expires_at, cota, cota_crv`,
      [userId, ASSINATURA_PLACAS_SERVICE_ID, expiresAt, cotaFinal, cotaCrvFinal,
       cotaAssinFinal, cotaVerifFinal]
    );
    console.log(`[admin] assinatura liberada para user ${userId} (${modo}${expiresAt ? ' até ' + data : ''}, cota ${cotaFinal ?? 'ilimitada'}, cota CRV ${cotaCrvFinal ?? 'ilimitada'})`);
    res.json({ success: true, assinatura: r.rows[0] });
  } catch (err) {
    console.error('Erro ao liberar assinatura:', err.message);
    res.status(500).json({ error: 'Erro ao liberar a assinatura.' });
  }
});

// ── ADMIN: DELETE /api/admin/users/:id/assinatura ────────────────────────────
// Revoga só a liberação manual. Períodos pagos por PIX são preservados de
// propósito: o cliente pagou por eles e cancelá-los seria estorno, não revogação.
app.delete('/api/admin/users/:id/assinatura', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM subscriptions WHERE user_id=$1 AND origem='CORTESIA' RETURNING id`,
      [parseInt(req.params.id, 10)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Este usuário não tem liberação manual para revogar.' });
    res.json({ success: true, revogadas: r.rowCount });
  } catch (err) {
    console.error('Erro ao revogar assinatura:', err.message);
    res.status(500).json({ error: 'Erro ao revogar a assinatura.' });
  }
});

// ── ADMIN: POST /api/admin/users/:id/pos-pago ────────────────────────────────
// Liga ou desliga o pós-pago do cliente. Ligar abre a primeira fatura na hora,
// com vencimento no próximo dia 30 — é aí que a "pro rata" acontece: o ciclo
// nasce mais curto e a fatura cobra só o que for consultado até lá.
// Desligar NÃO apaga fatura: o que já foi consumido continua devido (fica
// FECHADA para o admin cobrar), senão desligar viraria perdão de dívida sem
// querer. Só a fatura zerada é cancelada, porque não há o que cobrar nela.
app.post('/api/admin/users/:id/pos-pago', requireAuth, requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { ativo, limite } = req.body || {};
  let limiteFinal = null;
  if (limite !== '' && limite !== null && limite !== undefined) {
    limiteFinal = parseFloat(String(limite).replace(',', '.'));
    if (!(limiteFinal > 0))
      return res.status(400).json({ error: 'Limite inválido. Informe um valor maior que zero ou deixe vazio para sem limite.' });
  }
  try {
    const u = await pool.query('SELECT id, name, pos_pago FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

    if (ativo) {
      await pool.query(
        `UPDATE users SET pos_pago=true, pos_pago_limite=$2,
                pos_pago_desde=COALESCE(pos_pago_desde, NOW()) WHERE id=$1`,
        [userId, limiteFinal]
      );
      const fatura = await garantirFaturaAberta(userId);
      console.log(`[admin] pós-pago ligado para user ${userId} (limite ${limiteFinal ?? 'sem limite'}, vence ${fatura?.vencimento})`);
      return res.json({ success: true, posPago: true, fatura });
    }

    await pool.query('UPDATE users SET pos_pago=false, pos_pago_limite=NULL WHERE id=$1', [userId]);
    await pool.query(
      `UPDATE faturas SET status = CASE WHEN valor > 0 THEN 'FECHADA' ELSE 'CANCELADA' END,
              fechada_em=NOW()
        WHERE user_id=$1 AND status='ABERTA'`,
      [userId]
    );
    console.log(`[admin] pós-pago desligado para user ${userId}`);
    res.json({ success: true, posPago: false });
  } catch (err) {
    console.error('Erro ao mudar o pós-pago:', err.message);
    res.status(500).json({ error: 'Erro ao alterar o pós-pago do usuário.' });
  }
});

// ── Mensagens ao cliente ─────────────────────────────────────────────────────
// Canal de último recurso para quando o WhatsApp do cadastro está errado: o
// admin escreve para UM cliente e ele lê no painel logado, num aviso que abre
// sozinho na entrada e só fecha com "Li a mensagem". A conversa é sempre
// aberta pelo admin — o cliente só responde a uma mensagem que recebeu, para
// isto não virar um segundo canal de suporte ao lado do WhatsApp.
const MENSAGEM_MAX_CHARS = 2000;

function lerTextoMensagem(body) {
  const texto = String(body?.texto || '').replace(/\r\n/g, '\n').trim();
  if (!texto) return { error: 'Escreva a mensagem.' };
  if (texto.length > MENSAGEM_MAX_CHARS)
    return { error: `A mensagem passou de ${MENSAGEM_MAX_CHARS} caracteres.` };
  return { texto };
}

// ── ADMIN: GET /api/admin/mensagens ──────────────────────────────────────────
// Caixa de entrada do admin: uma linha por cliente com conversa, as que têm
// resposta nova primeiro. É o que alimenta o alerta ao abrir o admin e o selo
// do menu — sem isso a resposta só aparecia como um ponto na linha do usuário,
// e ninguém fica procurando.
app.get('/api/admin/mensagens', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureDbReady();
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone,
              COUNT(*) FILTER (WHERE m.autor='usuario' AND m.lida_em IS NULL)::int AS nao_lidas,
              COUNT(*) FILTER (WHERE m.autor='admin'   AND m.lida_em IS NULL)::int AS pendentes_cliente,
              MAX(m.created_at) AS ultima_em,
              (SELECT row_to_json(x) FROM (
                 SELECT autor, texto FROM mensagens_usuario
                  WHERE user_id=u.id ORDER BY created_at DESC, id DESC LIMIT 1) x) AS ultima
         FROM mensagens_usuario m
         JOIN users u ON u.id = m.user_id
        GROUP BY u.id
        -- Quem só recebeu comunicado e não respondeu não é conversa: sem isso,
        -- cada comunicado encheria a caixa com uma linha por cliente.
       HAVING bool_or(m.comunicado_id IS NULL)
        ORDER BY (COUNT(*) FILTER (WHERE m.autor='usuario' AND m.lida_em IS NULL) > 0) DESC,
                 MAX(m.created_at) DESC
        LIMIT 300`
    );
    const naoLidas = r.rows.reduce((s, c) => s + c.nao_lidas, 0);
    res.json({ conversas: r.rows, naoLidas });
  } catch (err) {
    console.error('Erro ao listar conversas (admin):', err.message);
    res.status(500).json({ error: 'Erro ao carregar as mensagens.' });
  }
});

// ── ADMIN: comunicados (mensagem para todos) ─────────────────────────────────
// Destinatários: toda conta ativa, menos os super admins. Um INSERT ... SELECT
// só, dentro de transação com o registro do comunicado — ou todo mundo recebe,
// ou ninguém (um envio pela metade não teria como ser completado sem duplicar).
const COMUNICADO_DESTINATARIOS_SQL = `FROM users WHERE active = true AND email <> ALL($1::text[])`;

app.get('/api/admin/comunicados', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureDbReady();
    const dest = await pool.query(`SELECT COUNT(*)::int AS n ${COMUNICADO_DESTINATARIOS_SQL}`, [SUPER_ADMIN_EMAILS]);
    const r = await pool.query(
      `SELECT c.id, c.texto, c.total, c.created_at,
              COUNT(m.id) FILTER (WHERE m.lida_em IS NOT NULL)::int AS lidas
         FROM comunicados c
         LEFT JOIN mensagens_usuario m ON m.comunicado_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at DESC
        LIMIT 50`
    );
    res.json({ comunicados: r.rows, destinatarios: dest.rows[0].n });
  } catch (err) {
    console.error('Erro ao listar comunicados:', err.message);
    res.status(500).json({ error: 'Erro ao carregar os comunicados.' });
  }
});

app.post('/api/admin/comunicados', requireAuth, requireSuperAdmin, async (req, res) => {
  const { texto, error } = lerTextoMensagem(req.body);
  if (error) return res.status(400).json({ error });
  const client = await pool.connect();
  try {
    await ensureDbReady();
    await client.query('BEGIN');
    const c = await client.query(`INSERT INTO comunicados (texto) VALUES ($1) RETURNING id`, [texto]);
    const comunicadoId = c.rows[0].id;
    const ins = await client.query(
      `INSERT INTO mensagens_usuario (user_id, autor, texto, comunicado_id)
       SELECT id, 'admin', $2, $3 ${COMUNICADO_DESTINATARIOS_SQL}`,
      [SUPER_ADMIN_EMAILS, texto, comunicadoId]
    );
    await client.query('UPDATE comunicados SET total=$2 WHERE id=$1', [comunicadoId, ins.rowCount]);
    await client.query('COMMIT');
    console.log(`[admin] comunicado #${comunicadoId} enviado a ${ins.rowCount} cliente(s)`);
    res.json({ success: true, id: comunicadoId, total: ins.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro ao enviar comunicado:', err.message);
    res.status(500).json({ error: 'Erro ao enviar o comunicado. Ninguém recebeu; tente de novo.' });
  } finally {
    client.release();
  }
});

// ── ADMIN: GET /api/admin/users/:id/mensagens ────────────────────────────────
// Abrir a conversa é o que conta como "o admin leu" as respostas do cliente.
app.get('/api/admin/users/:id/mensagens', requireAuth, requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  try {
    await ensureDbReady();   // mensagens_usuario é tabela nova — ver ensureDbReady
    const u = await pool.query('SELECT id, name, email, phone FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    await pool.query(
      `UPDATE mensagens_usuario SET lida_em=NOW()
        WHERE user_id=$1 AND autor='usuario' AND lida_em IS NULL`, [userId]
    );
    const m = await pool.query(
      `SELECT id, autor, texto, lida_em, created_at FROM mensagens_usuario
        WHERE user_id=$1 ORDER BY created_at, id`, [userId]
    );
    res.json({ usuario: u.rows[0], mensagens: m.rows });
  } catch (err) {
    console.error('Erro ao listar mensagens (admin):', err.message);
    res.status(500).json({ error: 'Erro ao carregar as mensagens.' });
  }
});

// ── ADMIN: POST /api/admin/users/:id/mensagens ───────────────────────────────
app.post('/api/admin/users/:id/mensagens', requireAuth, requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { texto, error } = lerTextoMensagem(req.body);
  if (error) return res.status(400).json({ error });
  try {
    await ensureDbReady();
    const u = await pool.query('SELECT id FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const r = await pool.query(
      `INSERT INTO mensagens_usuario (user_id, autor, texto) VALUES ($1, 'admin', $2)
       RETURNING id, autor, texto, lida_em, created_at`, [userId, texto]
    );
    console.log(`[admin] mensagem #${r.rows[0].id} enviada ao painel do user ${userId}`);
    res.json({ success: true, mensagem: r.rows[0] });
  } catch (err) {
    console.error('Erro ao enviar mensagem (admin):', err.message);
    res.status(500).json({ error: 'Erro ao enviar a mensagem.' });
  }
});

// ── GET /api/mensagens ───────────────────────────────────────────────────────
// Só lista: marcar como lida é um passo à parte (POST /api/mensagens/lidas),
// dado pelo botão do aviso. Se abrir o painel já marcasse, a mensagem urgente
// contaria como lida mesmo quando a página carregou e ninguém olhou.
app.get('/api/mensagens', requireAuth, async (req, res) => {
  try {
    await ensureDbReady();
    const m = await pool.query(
      `SELECT id, autor, texto, lida_em, created_at FROM mensagens_usuario
        WHERE user_id=$1 ORDER BY created_at, id`, [req.user.id]
    );
    const naoLidas = m.rows.filter(x => x.autor === 'admin' && !x.lida_em).length;
    res.json({ mensagens: m.rows, naoLidas });
  } catch (err) {
    console.error('Erro ao listar mensagens:', err.message);
    res.status(500).json({ error: 'Erro ao carregar as mensagens.' });
  }
});

// ── POST /api/mensagens/lidas ────────────────────────────────────────────────
app.post('/api/mensagens/lidas', requireAuth, async (req, res) => {
  try {
    await ensureDbReady();
    await pool.query(
      `UPDATE mensagens_usuario SET lida_em=NOW()
        WHERE user_id=$1 AND autor='admin' AND lida_em IS NULL`, [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao marcar mensagens como lidas:', err.message);
    res.status(500).json({ error: 'Erro ao marcar as mensagens como lidas.' });
  }
});

// ── POST /api/mensagens ──────────────────────────────────────────────────────
// Resposta do cliente. O admin é avisado no WhatsApp dele (ADMIN_PHONE) — é o
// número do admin, não o do cliente, então chega mesmo quando o cadastro do
// cliente está errado.
app.post('/api/mensagens', requireAuth, async (req, res) => {
  const { texto, error } = lerTextoMensagem(req.body);
  if (error) return res.status(400).json({ error });
  try {
    await ensureDbReady();
    const abertaPeloAdmin = await pool.query(
      `SELECT 1 FROM mensagens_usuario WHERE user_id=$1 AND autor='admin' LIMIT 1`, [req.user.id]
    );
    if (!abertaPeloAdmin.rows.length)
      return res.status(403).json({ error: 'Você ainda não recebeu mensagens. Para falar com o suporte, use o WhatsApp.' });
    const r = await pool.query(
      `INSERT INTO mensagens_usuario (user_id, autor, texto) VALUES ($1, 'usuario', $2)
       RETURNING id, autor, texto, lida_em, created_at`, [req.user.id, texto]
    );
    // Quem responde também já leu o que recebeu.
    await pool.query(
      `UPDATE mensagens_usuario SET lida_em=NOW()
        WHERE user_id=$1 AND autor='admin' AND lida_em IS NULL`, [req.user.id]
    );
    if (ADMIN_PHONE) {
      const u = await pool.query('SELECT name, email, phone FROM users WHERE id=$1', [req.user.id]);
      const c = u.rows[0] || {};
      const msg = [
        `💬 *Resposta de cliente no painel*`,
        ``,
        `👤 *Cliente:* ${c.name || '-'} (#${req.user.id})`,
        ...(c.email ? [`✉️ *E-mail:* ${c.email}`] : []),
        ...(c.phone ? [`📱 *WhatsApp do cadastro:* ${c.phone}`] : []),
        ``,
        texto.length > 500 ? texto.slice(0, 500) + '…' : texto,
        ``,
        `Responda pelo admin, em Usuários → 💬.`,
      ].join('\n');
      // await: na Vercel a função pode congelar logo depois da resposta.
      await sendWhatsApp(ADMIN_PHONE, msg).catch(() => {});
    }
    res.json({ success: true, mensagem: r.rows[0] });
  } catch (err) {
    console.error('Erro ao enviar resposta:', err.message);
    res.status(500).json({ error: 'Erro ao enviar a mensagem.' });
  }
});

// ── ADMIN: GET /api/admin/pos-pago ───────────────────────────────────────────
// A página "Pós-pago": um cliente por linha, com o ciclo corrente, o que está
// fechado esperando pagamento e desde quando. A virada de ciclo de cada um
// acontece na leitura (garantirCicloPosPago) — abrir a página põe todo mundo
// em dia, que é o que faz o bloqueio por atraso valer sem cron.
app.get('/api/admin/pos-pago', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const ids = await pool.query('SELECT id FROM users WHERE pos_pago=true ORDER BY id');
    for (const row of ids.rows) {
      try { await garantirCicloPosPago(row.id); }
      catch (e) { console.error(`[pos-pago] virada do ciclo falhou para user ${row.id}: ${e.message}`); }
    }
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.cpf_cnpj, u.active, u.pos_pago_limite, u.pos_pago_desde,
              a.id AS fatura_id, a.valor AS fatura_valor, a.vencimento AS fatura_vencimento,
              a.periodo_inicio AS fatura_inicio,
              COALESCE(f.total, 0)  AS fechado_total,
              COALESCE(f.qtd, 0)    AS fechado_qtd,
              f.mais_antigo         AS fechado_vencimento
         FROM users u
         LEFT JOIN LATERAL (
           SELECT id, valor, vencimento, periodo_inicio FROM faturas
            WHERE user_id=u.id AND status='ABERTA' LIMIT 1
         ) a ON true
         LEFT JOIN LATERAL (
           SELECT SUM(valor) AS total, COUNT(*) AS qtd, MIN(vencimento) AS mais_antigo
             FROM faturas WHERE user_id=u.id AND status='FECHADA'
         ) f ON true
        WHERE u.pos_pago = true
        ORDER BY COALESCE(f.total,0) DESC, u.name ASC`
    );
    const carenciaMs = POS_PAGO_CARENCIA_DIAS * 86400000;
    res.json({
      carenciaDias: POS_PAGO_CARENCIA_DIAS,
      diaVencimento: POS_PAGO_DIA_VENCIMENTO,
      clientes: r.rows.map(c => ({
        ...c,
        pos_pago_limite: c.pos_pago_limite === null ? null : parseFloat(c.pos_pago_limite),
        fatura_valor:    c.fatura_valor === null ? 0 : parseFloat(c.fatura_valor),
        fechado_total:   parseFloat(c.fechado_total),
        fechado_qtd:     parseInt(c.fechado_qtd, 10),
        // Bloqueado é o mesmo critério do porteiro da consulta: fatura fechada
        // com o vencimento passado da carência.
        bloqueado: !!c.fechado_vencimento &&
          new Date(c.fechado_vencimento).getTime() + carenciaMs < Date.now(),
      })),
    });
  } catch (err) {
    console.error('Erro ao listar pós-pago:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: GET /api/admin/pos-pago/:id/faturas ───────────────────────────────
// Histórico de faturas de um cliente, com as consultas do ciclo corrente.
app.get('/api/admin/pos-pago/:id/faturas', requireAuth, requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  try {
    await garantirCicloPosPago(userId).catch(() => null);
    const [u, f] = await Promise.all([
      pool.query('SELECT id, name, email, phone, pos_pago, pos_pago_limite, pos_pago_desde FROM users WHERE id=$1', [userId]),
      pool.query(
        `SELECT id, status, valor, periodo_inicio, vencimento, fechada_em, paga_em, origem_baixa, gateway_id
           FROM faturas WHERE user_id=$1 ORDER BY periodo_inicio DESC LIMIT 60`, [userId]
      ),
    ]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const aberta = f.rows.find(x => x.status === 'ABERTA');
    const itens = aberta ? await pool.query(
      `SELECT id, service_id, amount, created_at FROM queries
        WHERE user_id=$1 AND created_at >= $2 AND amount > 0 AND status <> 'estornado'
        ORDER BY created_at DESC LIMIT 200`,
      [userId, aberta.periodo_inicio]
    ) : { rows: [] };
    res.json({
      usuario: u.rows[0],
      faturas: f.rows.map(x => ({ ...x, valor: parseFloat(x.valor) })),
      itens: itens.rows.map(q => ({
        id: q.id,
        servico: (SERVICES.find(s => s.id === q.service_id) || {}).name || q.service_id,
        valor: parseFloat(q.amount),
        data: q.created_at,
      })),
    });
  } catch (err) {
    console.error('Erro ao listar faturas:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: POST /api/admin/faturas/:id/pagar ─────────────────────────────────
// Baixa manual: o cliente pagou por fora (PIX na conta, dinheiro, transferência)
// e o admin marca a fatura como paga. origem_baixa='MANUAL' separa isso do que
// entrou pelo Mercado Pago, para a conciliação não confundir os dois.
// Fatura ainda ABERTA é fechada antes de quitar (congela o valor) e o ciclo
// seguinte abre na hora — senão o cliente ficaria sem fatura corrente.
app.post('/api/admin/faturas/:id/pagar', requireAuth, requireSuperAdmin, async (req, res) => {
  const faturaId = parseInt(req.params.id, 10);
  try {
    const f = await pool.query('SELECT * FROM faturas WHERE id=$1', [faturaId]);
    if (!f.rows.length) return res.status(404).json({ error: 'Fatura não encontrada.' });
    const fatura = f.rows[0];
    if (fatura.status === 'PAGA') return res.status(400).json({ error: 'Esta fatura já está paga.' });
    if (fatura.status === 'CANCELADA') return res.status(400).json({ error: 'Esta fatura foi cancelada.' });

    const upd = await pool.query(
      `UPDATE faturas SET status='PAGA', paga_em=NOW(), origem_baixa='MANUAL',
              fechada_em=COALESCE(fechada_em, NOW())
        WHERE id=$1 AND status IN ('ABERTA','FECHADA') RETURNING *`,
      [faturaId]
    );
    if (!upd.rows.length) return res.status(409).json({ error: 'A fatura mudou de situação — recarregue a página.' });
    if (fatura.status === 'ABERTA') await garantirFaturaAberta(fatura.user_id);
    console.log(`[admin] fatura ${faturaId} baixada na mão (R$ ${fatura.valor})`);
    res.json({ success: true, fatura: upd.rows[0] });
  } catch (err) {
    console.error('Erro ao dar baixa na fatura:', err.message);
    res.status(500).json({ error: 'Erro ao marcar a fatura como paga.' });
  }
});

// ── ADMIN: POST /api/admin/faturas/:id/fechar ────────────────────────────────
// Fecha o ciclo antes do dia 30 (cliente pediu a fatura agora, ou o admin vai
// cobrar por fora). Congela o valor e abre o ciclo seguinte; o vencimento do
// ciclo novo continua sendo o próximo dia 30.
app.post('/api/admin/faturas/:id/fechar', requireAuth, requireSuperAdmin, async (req, res) => {
  const faturaId = parseInt(req.params.id, 10);
  try {
    const upd = await pool.query(
      `UPDATE faturas SET status='FECHADA', fechada_em=NOW()
        WHERE id=$1 AND status='ABERTA' AND valor > 0 RETURNING *`,
      [faturaId]
    );
    if (!upd.rows.length)
      return res.status(400).json({ error: 'Só dá para fechar uma fatura aberta com valor maior que zero.' });
    await garantirFaturaAberta(upd.rows[0].user_id);
    res.json({ success: true, fatura: upd.rows[0] });
  } catch (err) {
    console.error('Erro ao fechar fatura:', err.message);
    res.status(500).json({ error: 'Erro ao fechar a fatura.' });
  }
});

// ── ADMIN: GET /api/admin/users/:id ──────────────────────────────────────────
app.get('/api/admin/users/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [u, q, t] = await Promise.all([
      pool.query('SELECT id,name,email,cpf_cnpj,phone,role,credits,active,created_at,affiliate_code,pos_pago,pos_pago_limite FROM users WHERE id=$1', [req.params.id]),
      pool.query('SELECT COUNT(*) AS total, COALESCE(SUM(amount),0) AS spent FROM queries WHERE user_id=$1', [req.params.id]),
      pool.query("SELECT COUNT(*) AS total, COALESCE(SUM(amount),0) AS deposited FROM transactions WHERE user_id=$1 AND type='deposit'", [req.params.id]),
    ]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ ...u.rows[0], total_queries: parseInt(q.rows[0].total), total_spent: parseFloat(q.rows[0].spent), total_deposited: parseFloat(t.rows[0].deposited) });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: POST /api/admin/users ──────────────────────────────────────────────
app.post('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
  const { name, cpf_cnpj, email, phone, password, role, credits } = req.body;
  if (!name || !cpf_cnpj || !email || !password)
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Senha deve ter ao menos 8 caracteres.' });
  if (!isValidDoc(cpf_cnpj))
    return res.status(400).json({ error: 'CPF ou CNPJ inválido.' });
  if (phone && !isValidPhoneBR(phone))
    return res.status(400).json({ error: 'Telefone inválido. Informe com DDD, ex.: (21) 90000-0000.' });
  const doc = cleanDoc(cpf_cnpj); const mail = email.toLowerCase().trim();
  try {
    const dup = await pool.query('SELECT id FROM users WHERE email=$1 OR cpf_cnpj=$2', [mail, doc]);
    if (dup.rows.length) return res.status(409).json({ error: 'E-mail ou CPF/CNPJ já cadastrado.' });
    const hash = await bcrypt.hash(password, 12);
    const affCode = generateAffiliateCode(name);
    const userRole = ['user','reseller','admin'].includes(role) ? role : 'user';
    const r = await pool.query(
      `INSERT INTO users (name,cpf_cnpj,email,phone,password_hash,role,affiliate_code,credits)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,email,role,credits,active,created_at`,
      [name.trim(), doc, mail, phone?.trim()||null, hash, userRole, affCode, parseFloat(credits)||0]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: PUT /api/admin/users/:id ──────────────────────────────────────────
app.put('/api/admin/users/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { name, cpf_cnpj, email, phone, role, credits } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'E-mail é obrigatório.' });
  if (!['user','reseller','admin'].includes(role)) return res.status(400).json({ error: 'Role inválido.' });
  const parsedCredits = parseFloat(credits);
  if (isNaN(parsedCredits)) return res.status(400).json({ error: 'Valor de créditos inválido.' });
  // CPF/CNPJ é opcional no corpo: quando não vem, o documento fica como está —
  // assim uma tela antiga (ou integração) que não conhece o campo não apaga o
  // que já estava gravado. Quando vem, passa pela mesma validação do cadastro.
  if (cpf_cnpj !== undefined && !isValidDoc(cpf_cnpj))
    return res.status(400).json({ error: 'CPF/CNPJ inválido.' });
  const doc = cpf_cnpj !== undefined ? cleanDoc(cpf_cnpj) : null;
  try {
    const r = await pool.query(
      `UPDATE users SET name=$1,email=$2,phone=$3,role=$4,credits=$5,
              cpf_cnpj=COALESCE($6,cpf_cnpj)
       WHERE id=$7
       RETURNING id,name,cpf_cnpj,email,phone,role,credits,active`,
      [name.trim(), email.toLowerCase().trim(), phone?.trim()||null, role, parsedCredits, doc, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    // users tem UNIQUE em email E em cpf_cnpj — a mensagem precisa dizer qual dos
    // dois colidiu, senão o admin fica procurando duplicidade no campo errado.
    if (err.code === '23505') {
      const campo = /cpf/i.test(err.constraint || err.detail || '') ? 'CPF/CNPJ' : 'E-mail';
      return res.status(409).json({ error: `${campo} já está em uso por outro usuário.` });
    }
    console.error('Erro ao editar usuário:', err.message);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ── ADMIN: PUT /api/admin/users/:id/toggle ────────────────────────────────────
app.put('/api/admin/users/:id/toggle', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const c = await pool.query('SELECT active FROM users WHERE id=$1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const na = !c.rows[0].active;
    await pool.query('UPDATE users SET active=$1 WHERE id=$2', [na, req.params.id]);
    res.json({ success: true, active: na });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: POST /api/admin/users/:id/credits ──────────────────────────────────
app.post('/api/admin/users/:id/credits', requireAuth, requireSuperAdmin, async (req, res) => {
  const val = parseFloat(req.body.amount);
  if (isNaN(val)) return res.status(400).json({ error: 'Valor inválido.' });
  try {
    await pool.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [val, req.params.id]);
    await pool.query(
      `INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,$2,$3,$4)`,
      [req.params.id, val >= 0 ? 'deposit' : 'debit', Math.abs(val), req.body.description || 'Ajuste manual pelo administrador']
    );
    const r = await pool.query('SELECT credits FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true, credits: parseFloat(r.rows[0].credits) });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: POST /api/admin/users/:id/reset-password ──────────────────────────
app.post('/api/admin/users/:id/reset-password', requireAuth, requireSuperAdmin, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8)
    return res.status(400).json({ error: 'Senha deve ter ao menos 8 caracteres.' });
  try {
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: DELETE /api/admin/users/:id ───────────────────────────────────────
app.delete('/api/admin/users/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'Não é possível excluir sua própria conta.' });
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: GET /api/admin/users/:id/service-prices ───────────────────────────
// Lista os preços personalizados já cadastrados para o usuário, com o nome do
// serviço e o preço padrão do catálogo para comparação na tela do admin.
app.get('/api/admin/users/:id/service-prices', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT service_id, price, updated_at FROM user_service_prices WHERE user_id=$1 ORDER BY updated_at DESC',
      [req.params.id]
    );
    const prices = r.rows.map(row => {
      const svc = SERVICES.find(s => s.id === row.service_id);
      return {
        service_id:    row.service_id,
        service_name:  svc?.name || row.service_id,
        service_group: svc?.group || '-',
        default_price: svc ? catalogPrice(svc) : null,
        price:         parseFloat(row.price),
        updated_at:    row.updated_at,
      };
    });
    res.json({ prices });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: POST /api/admin/users/:id/service-prices ──────────────────────────
// Cria ou atualiza o preço fixo de um serviço específico para este usuário
// (substitui o valor padrão do catálogo enquanto a exceção existir).
app.post('/api/admin/users/:id/service-prices', requireAuth, requireSuperAdmin, async (req, res) => {
  const { service_id, price } = req.body;
  const svc = SERVICES.find(s => s.id === service_id);
  if (!svc) return res.status(400).json({ error: 'Serviço inválido.' });
  // Grupo gratuito não aceita preço personalizado — a cobrança ignoraria o valor
  // (ver getUserServicePrice), então recusa aqui em vez de gravar um preço morto.
  if (isFreeService(svc))
    return res.status(400).json({ error: `"${svc.group}" é um grupo gratuito — não aceita preço personalizado.` });
  const parsedPrice = parseFloat(price);
  if (isNaN(parsedPrice) || parsedPrice < 0) return res.status(400).json({ error: 'Preço inválido.' });
  try {
    const userExists = await pool.query('SELECT id FROM users WHERE id=$1', [req.params.id]);
    if (!userExists.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    await pool.query(
      `INSERT INTO user_service_prices (user_id, service_id, price)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, service_id) DO UPDATE SET price=$3, updated_at=NOW()`,
      [req.params.id, service_id, parsedPrice]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: DELETE /api/admin/users/:id/service-prices/:serviceId ─────────────
// Remove a exceção de preço — o usuário volta a pagar o valor padrão do catálogo.
app.delete('/api/admin/users/:id/service-prices/:serviceId', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM user_service_prices WHERE user_id=$1 AND service_id=$2',
      [req.params.id, req.params.serviceId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: GET /api/admin/transactions ───────────────────────────────────────
app.get('/api/admin/transactions', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id,t.type,t.amount,t.description,t.created_at,
              u.name AS user_name,u.email AS user_email
       FROM transactions t JOIN users u ON u.id=t.user_id
       ORDER BY t.created_at DESC LIMIT 500`
    );
    res.json({ transactions: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: GET /api/admin/queries ─────────────────────────────────────────────
app.get('/api/admin/queries', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    // pdf_disponivel diz se o documento ainda está no pdf_cache (ele expira em
    // 7 dias) — é o que decide se a linha vira link no admin. LATERAL com
    // LIMIT 1 porque a mesma consulta pode ter mais de um PDF em cache
    // (reemissão), e um JOIN direto duplicaria a linha no histórico.
    const r = await pool.query(
      `SELECT q.id,q.service_name,q.amount,q.result_type,q.created_at,
              u.name AS user_name,u.email AS user_email,
              (pc.query_id IS NOT NULL) AS pdf_disponivel
       FROM queries q
       JOIN users u ON u.id=q.user_id
       LEFT JOIN LATERAL (
         SELECT p.query_id FROM pdf_cache p
          WHERE p.query_id = q.id AND p.expires_at > NOW()
          LIMIT 1
       ) pc ON TRUE
       ORDER BY q.created_at DESC LIMIT 500`
    );
    res.json({ queries: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: GET /api/admin/queries/:id/pdf ────────────────────────────────────
// Abre o PDF de uma consulta de qualquer cliente. Precisa de rota própria: o
// /api/pdf/:token do painel casa o token com o user_id de quem pede, então o
// admin nunca conseguiria abrir o documento de outra pessoa por lá.
app.get('/api/admin/queries/:id/pdf', requireAuth, requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Consulta inválida.' });
  try {
    const r = await pool.query(
      `SELECT c.pdf_data, q.service_id, q.params
         FROM pdf_cache c LEFT JOIN queries q ON q.id = c.query_id
        WHERE c.query_id=$1 AND c.expires_at > NOW()
        ORDER BY c.created_at DESC LIMIT 1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'PDF não encontrado ou expirado.' });
    let placaCache = '';
    try { placaCache = (JSON.parse(r.rows[0].params || '{}').placa || '').toUpperCase(); } catch {}
    const nomeArquivo = nomeArquivoVistocar(r.rows[0].service_id, placaCache) || `consulta-${id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}"`);
    return res.send(Buffer.from(r.rows[0].pdf_data, 'base64'));
  } catch (err) {
    console.error('Erro ao abrir PDF no admin:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: GET /api/admin/manual-queries (fila de upload manual) ─────────────
app.get('/api/admin/manual-queries', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT q.id, q.service_id, q.service_name, q.params, q.amount, q.status, q.created_at, q.whatsapp_sent_at,
              u.id AS user_id, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
       FROM queries q JOIN users u ON u.id = q.user_id
       WHERE q.service_id = ANY($1)
       ORDER BY (q.status = 'pendente') DESC, q.created_at DESC
       LIMIT 300`,
      [MANUAL_SERVICE_IDS]
    );
    res.json({ queries: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: POST /api/admin/manual-queries/:id/upload ─────────────────────────
app.post('/api/admin/manual-queries/:id/upload', requireAuth, requireSuperAdmin, async (req, res) => {
  const { pdf_base64 } = req.body;
  if (!pdf_base64) return res.status(400).json({ error: 'Arquivo PDF não enviado.' });
  try {
    const qr = await pool.query(
      `SELECT q.id, q.user_id, q.service_id, q.service_name, u.phone
       FROM queries q JOIN users u ON u.id = q.user_id WHERE q.id=$1`,
      [req.params.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const query = qr.rows[0];
    if (!MANUAL_SERVICE_IDS.includes(query.service_id))
      return res.status(400).json({ error: 'Este pedido não é de um serviço manual.' });

    const pdfBuf = Buffer.from(pdf_base64, 'base64');
    if (pdfBuf.slice(0, 4).toString() !== '%PDF')
      return res.status(400).json({ error: 'Arquivo inválido. Envie um PDF.' });

    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
    await pool.query(
      `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [query.id, query.user_id, token, pdfBuf.toString('base64'), expiresAt]
    );
    await pool.query(`UPDATE queries SET status='concluido' WHERE id=$1`, [query.id]);

    let whatsappSent = false;
    if (query.phone) {
      const caption = `✅ *${query.service_name}* — documento pronto!\n\nSeu PDF já está disponível para download no seu painel.`;
      const nomeArquivo = nomeArquivoVistocar(query.service_id, query.id)
        || `${query.service_id}-${query.id}.pdf`;
      whatsappSent = await sendWhatsAppPdf(query.phone, pdfBuf, nomeArquivo, caption).catch(() => false);
      if (whatsappSent) {
        await pool.query(`UPDATE queries SET whatsapp_sent_at = NOW() WHERE id=$1`, [query.id]);
      }
    }

    res.json({ success: true, whatsappSent });
  } catch (err) {
    console.error('Erro no upload manual:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: POST /api/admin/manual-queries/:id/reject ──────────────────────────
// Usado quando o documento não pôde ser localizado/emitido — estorna os
// créditos ao cliente em vez de deixar o pedido cobrado para sempre sem PDF.
app.post('/api/admin/manual-queries/:id/reject', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT q.id, q.user_id, q.service_id, q.service_name, q.status, q.amount, u.phone
       FROM queries q JOIN users u ON u.id = q.user_id WHERE q.id=$1`,
      [req.params.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const query = qr.rows[0];
    if (!MANUAL_SERVICE_IDS.includes(query.service_id))
      return res.status(400).json({ error: 'Este pedido não é de um serviço manual.' });
    if (query.status !== 'pendente')
      return res.status(400).json({ error: 'Este pedido já foi concluído ou estornado.' });

    const ok = await refundQuery(query.id, query.user_id, parseFloat(query.amount),
      `Pedido manual não pôde ser atendido: ${query.service_name}`);
    if (!ok) return res.status(400).json({ error: 'Não foi possível estornar este pedido.' });

    if (query.phone) {
      const msg = `⚠️ *${query.service_name}*\n\nNão conseguimos localizar/emitir o documento para este pedido. O valor pago foi estornado para o seu saldo. Se precisar, tente novamente ou fale com o suporte.`;
      await sendWhatsApp(query.phone, msg).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao recusar/estornar pedido manual:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: POST /api/admin/manual-queries/:id/resend-whatsapp ────────────────
app.post('/api/admin/manual-queries/:id/resend-whatsapp', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT q.id, q.user_id, q.service_id, q.service_name, q.status, u.phone
       FROM queries q JOIN users u ON u.id = q.user_id WHERE q.id=$1`,
      [req.params.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const query = qr.rows[0];
    if (!MANUAL_SERVICE_IDS.includes(query.service_id))
      return res.status(400).json({ error: 'Este pedido não é de um serviço manual.' });
    if (query.status !== 'concluido')
      return res.status(400).json({ error: 'Este pedido ainda não tem PDF enviado.' });
    if (!query.phone)
      return res.status(400).json({ error: 'Usuário sem telefone cadastrado.' });

    const pr = await pool.query(
      `SELECT pdf_data FROM pdf_cache WHERE query_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [query.id]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'PDF não encontrado para este pedido.' });
    const pdfBuf = Buffer.from(pr.rows[0].pdf_data, 'base64');

    const caption = `✅ *${query.service_name}* — documento pronto!\n\nSeu PDF já está disponível para download no seu painel.`;
    const nomeArquivo = nomeArquivoVistocar(query.service_id, query.id)
      || `${query.service_id}-${query.id}.pdf`;
    const sent = await sendWhatsAppPdf(query.phone, pdfBuf, nomeArquivo, caption).catch(() => false);
    if (!sent) return res.status(502).json({ error: 'Falha ao reenviar pelo WhatsApp. Tente novamente.' });

    await pool.query(`UPDATE queries SET whatsapp_sent_at = NOW() WHERE id=$1`, [query.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro no reenvio manual de WhatsApp:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: vídeo de apresentação ─────────────────────────────────────────────
// O MP4 NÃO fica no repositório nem passa por esta function: tudo aqui roda
// numa function só (vercel.json), e um 1080p de 2 minutos tem dezenas de MB.
// A HeyGen guarda o vídeo e devolve um link assinado que expira; por isso a
// rota pede um link novo a cada acesso e só redireciona — o download sai
// direto do CDN deles. Vídeo novo = trocar o id abaixo.
const VIDEO_APRESENTACAO_ID = '9ca2400ff0e149e69b1adc2f74d5bd03';

async function buscarVideoApresentacao() {
  if (!HEYGEN_API_KEY) throw new Error('HEYGEN_API_KEY não configurada no servidor.');
  const r = await fetch(`https://api.heygen.com/v3/videos/${VIDEO_APRESENTACAO_ID}`, {
    headers: { 'X-Api-Key': HEYGEN_API_KEY },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.data) throw new Error(j?.error?.message || `HeyGen respondeu HTTP ${r.status}.`);
  return j.data;
}

// O roteiro escreve as siglas letra a letra ("A, T, P, V, e") para a voz não
// ler "atpêvê" como palavra, e a legenda da HeyGen transcreve o roteiro — então
// sai soletrada. Aqui as siglas voltam ao normal. Um bloco pode terminar no
// meio da sigla ("A, T, P," | "V, e, que…"), daí os dois últimos replaces.
function juntarSiglasLegenda(srt) {
  return srt.replace(/\r\n/g, '\n')
    .replace(/A, T, P, V, e,?/g, 'ATPV-e')
    .replace(/C, R, L, V, e,?/g, 'CRLV-e')
    .replace(/C, R, V(?=[,\s])/g, 'CRV')
    .replace(/A, S, D/g, 'ASD')
    .replace(/A, T, P,\n/g, 'ATPV-e\n')
    .replace(/^V, e, /gm, '');
}

app.get('/api/admin/video-apresentacao', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const v = await buscarVideoApresentacao();
    res.json({
      status: v.status,
      titulo: v.title || 'Vídeo de apresentação',
      duracao: v.duration || null,
      thumbnail_url: v.thumbnail_url || null,
      video_url: v.video_url || null,
      tem_legenda: !!v.subtitle_url,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/admin/video-apresentacao/:arquivo', requireAuth, requireSuperAdmin, async (req, res) => {
  const arquivo = req.params.arquivo;
  if (arquivo !== 'mp4' && arquivo !== 'srt') return res.status(404).json({ error: 'Arquivo inválido.' });
  try {
    const v = await buscarVideoApresentacao();
    if (v.status !== 'completed') return res.status(409).json({ error: 'O vídeo ainda está sendo gerado. Tente em alguns minutos.' });
    if (arquivo === 'srt') {
      // A legenda é pequena: vem por aqui para sair com nome de arquivo e
      // como download (o link da HeyGen abriria o texto no navegador).
      if (!v.subtitle_url) return res.status(404).json({ error: 'Este vídeo não tem legenda.' });
      const s = await fetch(v.subtitle_url);
      if (!s.ok) throw new Error(`Legenda indisponível (HTTP ${s.status}).`);
      res.set('Content-Type', 'application/x-subrip; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="despachantes-consultas-apresentacao.srt"');
      return res.send(juntarSiglasLegenda(await s.text()));
    }
    if (!v.video_url) throw new Error('A HeyGen não devolveu o link do vídeo.');
    res.redirect(302, v.video_url);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── ADMIN: pedidos de ATPV-e ─────────────────────────────────────────────────
// Controle total dos pedidos, com as MESMAS ações que o cliente tem no painel —
// a diferença é só quem está olhando. Por isso as rotas reaproveitam as mesmas
// funções (entregarResultadoVistocar, cancelarPendenciaVistocar) em vez de
// mexerem no banco por fora: o que o admin faz aqui e o que o cron faz sozinho
// passam exatamente pelo mesmo caminho, sem estado divergente.
const ATPVE_ADMIN_SVCS = [...VISTOCAR_ATPVE_SVCS];
// Pedido só pode ser apagado depois desta idade, e um de cada vez (não há rota
// de exclusão em lote de propósito). O prazo casa com a validade do pdf_cache
// (7 dias) com folga: passados 30 dias o documento já não está mais lá para
// baixar, e o que sobra é registro. A transação financeira NÃO some junto —
// ela vive em `transactions`, que não é apagada aqui.
const ATPVE_ADMIN_EXCLUSAO_DIAS = 30;

app.get('/api/admin/atpve-pedidos', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureDbReady();   // vistocar_pending é tabela nova — ver ensureDbReady
    const r = await pool.query(
      `SELECT q.id, q.service_id, q.service_name, q.status, q.amount, q.params, q.result_data,
              q.created_at, q.whatsapp_sent_at, q.transaction_id,
              u.id AS user_id, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
              p.movement_id AS pendencia_movement_id, p.created_at AS pendencia_desde,
              p.protocolo AS pendencia_protocolo, p.registrado_em AS pendencia_registrado_em,
              (SELECT 1 FROM pdf_cache c WHERE c.query_id = q.id AND c.expires_at > NOW() LIMIT 1) AS tem_pdf
         FROM queries q
         JOIN users u ON u.id = q.user_id
         LEFT JOIN vistocar_pending p ON p.query_id = q.id
        WHERE q.service_id = ANY($1)
        ORDER BY (q.status = 'aguardando_pdf') DESC, q.created_at DESC
        LIMIT 500`,
      [ATPVE_ADMIN_SVCS]
    );
    // params/result_data são TEXT com JSON; o painel do admin recebe já parseado
    // para não repetir try/catch em cada célula da tabela.
    const pedidos = r.rows.map(row => {
      let params = {}, result = {};
      try { params = JSON.parse(row.params || '{}'); } catch {}
      try { result = JSON.parse(row.result_data || '{}'); } catch {}
      return {
        id: row.id,
        service_id: row.service_id,
        service_name: row.service_name,
        uf: (SERVICES.find(s => s.id === row.service_id)?.uf || '').toUpperCase(),
        status: row.status,
        amount: row.amount,
        cobrada: !!row.transaction_id,
        created_at: row.created_at,
        whatsapp_sent_at: row.whatsapp_sent_at,
        tem_pdf: !!row.tem_pdf,
        pendente: !!row.pendencia_movement_id,
        pendencia_desde: row.pendencia_desde,
        // O protocolo (UUID) é o que serve para registrar/excluir no Detran; o
        // movementId é só o número interno da Vistocar. Os dois vão para a tela:
        // pedido antigo só tem o movementId, e é isso que explica por que nele
        // os botões de registrar e excluir não aparecem.
        protocolo: row.pendencia_protocolo || result.protocolo || null,
        movement_id: result.movementId || row.pendencia_movement_id || null,
        registrado_em: row.pendencia_registrado_em,
        placa: (params.placa || result.placa || '').toUpperCase(),
        comprador: params.nomeComprador || '',
        vendedor: params.nomeVendedor || '',
        valor_venda: params.valorVenda || '',
        data_venda: params.dataVenda || '',
        user: { id: row.user_id, name: row.user_name, email: row.user_email, phone: row.user_phone },
      };
    });
    res.json({ pedidos, prazoHoras: ASYNC_PDF_REFUND_HOURS, exclusaoDias: ATPVE_ADMIN_EXCLUSAO_DIAS });
  } catch (err) {
    console.error('Erro ao listar pedidos de ATPV-e no admin:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Força a busca do documento na Vistocar agora, sem esperar o cron nem o cliente
// abrir a tela. É idempotente — a entrega tem claim atômico e checagem de cache.
app.post('/api/admin/atpve-pedidos/:id/verificar', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureDbReady();
    const qr = await pool.query(
      `SELECT id, service_id, status FROM queries WHERE id=$1`, [req.params.id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (!ATPVE_ADMIN_SVCS.includes(qr.rows[0].service_id))
      return res.status(400).json({ error: 'Este pedido não é de ATPV-e.' });

    const pr = await pool.query('SELECT * FROM vistocar_pending WHERE query_id=$1', [qr.rows[0].id]);
    if (!pr.rows.length) {
      const atual = await pool.query('SELECT status FROM queries WHERE id=$1', [qr.rows[0].id]);
      return res.json({ success: true, entregue: false, status: atual.rows[0].status,
        motivo: 'Não há pendência aberta para este pedido (já foi entregue ou cancelado).' });
    }
    const r = await entregarResultadoVistocar(pr.rows[0]);
    const atual = await pool.query('SELECT status FROM queries WHERE id=$1', [qr.rows[0].id]);
    res.json({ success: true, entregue: r.entregue, motivo: r.motivo || null, status: atual.rows[0].status });
  } catch (err) {
    console.error('Erro ao verificar pedido de ATPV-e no admin:', err.message);
    res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

// Registrar / excluir no Detran pelo admin — as mesmas ações do painel do
// cliente, pelas MESMAS funções (registrarAtpvePendencia, excluirAtpvePendencia),
// para o pedido não acabar em estado diferente conforme quem clicou.
async function pendenciaAtpveDoAdmin(id) {
  await ensureDbReady();   // colunas protocolo/registrado_em são novas — ver ensureDbReady
  const qr = await pool.query(`SELECT id, service_id, status FROM queries WHERE id=$1`, [id]);
  if (!qr.rows.length) return { erro: 'Pedido não encontrado.', http: 404 };
  if (!ATPVE_ADMIN_SVCS.includes(qr.rows[0].service_id))
    return { erro: 'Este pedido não é de ATPV-e.', http: 400 };
  const pr = await pool.query('SELECT * FROM vistocar_pending WHERE query_id=$1', [qr.rows[0].id]);
  if (!pr.rows.length) return { erro: 'Não há pendência aberta para este pedido (já foi entregue ou cancelado).', http: 409 };
  return { pend: pr.rows[0] };
}

app.post('/api/admin/atpve-pedidos/:id/registrar', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { pend, erro, http } = await pendenciaAtpveDoAdmin(req.params.id);
    if (erro) return res.status(http).json({ error: erro });
    const r = await registrarAtpvePendencia(pend);
    if (!r.ok) return res.status(422).json({ error: r.erro });
    res.json({ success: true, entregue: r.entregue });
  } catch (err) {
    console.error('Erro ao registrar ATPV-e no admin:', err.message);
    res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

app.post('/api/admin/atpve-pedidos/:id/excluir-detran', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { pend, erro, http } = await pendenciaAtpveDoAdmin(req.params.id);
    if (erro) return res.status(http).json({ error: erro });
    const r = await excluirAtpvePendencia(pend);
    if (!r.ok) return res.status(422).json({ error: r.erro });
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao excluir ATPV-e no admin:', err.message);
    res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

// Reenvia por WhatsApp o ATPV-e já entregue — para quando o cliente diz que não
// recebeu. Mesmo padrão do reenvio dos serviços manuais.
app.post('/api/admin/atpve-pedidos/:id/reenviar-whatsapp', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT q.id, q.service_id, q.service_name, q.params, u.phone
         FROM queries q JOIN users u ON u.id = q.user_id WHERE q.id=$1`,
      [req.params.id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const q = qr.rows[0];
    if (!ATPVE_ADMIN_SVCS.includes(q.service_id))
      return res.status(400).json({ error: 'Este pedido não é de ATPV-e.' });
    const phone = (req.body?.phone || '').replace(/\D/g, '') || q.phone;
    if (!phone) return res.status(400).json({ error: 'Cliente sem telefone cadastrado. Informe um número no reenvio.' });

    const pr = await pool.query(
      `SELECT pdf_data FROM pdf_cache WHERE query_id=$1 ORDER BY created_at DESC LIMIT 1`, [q.id]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Este pedido ainda não tem documento entregue.' });

    let placa = '';
    try { placa = (JSON.parse(q.params || '{}').placa || '').toUpperCase(); } catch {}
    const buf = Buffer.from(pr.rows[0].pdf_data, 'base64');
    const caption = `✅ *${q.service_name} pronto!*\n🔤 Placa: ${placa}\n\nDocumento gerado pela MC Despachadoria.`;
    const nomeArquivo = nomeArquivoVistocar(q.service_id, placa || q.id)
      || `${q.service_id}-${placa || q.id}.pdf`;
    const sent = await sendWhatsAppPdf(phone, buf, nomeArquivo, caption).catch(() => false);
    if (!sent) return res.status(502).json({ error: 'Falha ao reenviar pelo WhatsApp. Tente novamente.' });

    await pool.query(`UPDATE queries SET whatsapp_sent_at = NOW() WHERE id=$1`, [q.id]);
    res.json({ success: true, phone });
  } catch (err) {
    console.error('Erro no reenvio de ATPV-e no admin:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Encerra um pedido que não vai sair. Não há estorno a fazer: o ATPV-e só é
// cobrado na entrega, então cancelar um pendente é sempre sem cobrança — o
// cliente é avisado por WhatsApp pela própria cancelarPendenciaVistocar.
app.post('/api/admin/atpve-pedidos/:id/cancelar', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureDbReady();
    const qr = await pool.query(`SELECT id, service_id, status FROM queries WHERE id=$1`, [req.params.id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (!ATPVE_ADMIN_SVCS.includes(qr.rows[0].service_id))
      return res.status(400).json({ error: 'Este pedido não é de ATPV-e.' });
    if (qr.rows[0].status !== 'aguardando_pdf')
      return res.status(400).json({ error: 'Só dá para cancelar pedido que ainda está aguardando o documento.' });

    const pr = await pool.query('SELECT * FROM vistocar_pending WHERE query_id=$1', [qr.rows[0].id]);
    if (pr.rows.length) {
      await cancelarPendenciaVistocar(pr.rows[0], (req.body?.motivo || '').trim() || 'cancelado pelo suporte');
    } else {
      await pool.query(`UPDATE queries SET status='cancelado' WHERE id=$1 AND status='aguardando_pdf'`, [qr.rows[0].id]);
    }
    const atual = await pool.query('SELECT status FROM queries WHERE id=$1', [qr.rows[0].id]);
    res.json({ success: true, status: atual.rows[0].status });
  } catch (err) {
    console.error('Erro ao cancelar pedido de ATPV-e no admin:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Exclusão de UM pedido, e só depois de ATPVE_ADMIN_EXCLUSAO_DIAS. Não existe
// exclusão em lote aqui de propósito: apagar registro é irreversível e um clique
// errado num "excluir todos" levaria o histórico inteiro junto.
// Um pedido ainda aguardando NÃO é apagado — ele tem pendência viva na Vistocar,
// e some da fila sem ninguém saber que o documento ainda pode chegar. Cancele
// antes; aí ele vira 'cancelado' e pode ser apagado.
app.delete('/api/admin/atpve-pedidos/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, service_id, status, created_at FROM queries WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const q = r.rows[0];
    if (!ATPVE_ADMIN_SVCS.includes(q.service_id))
      return res.status(400).json({ error: 'Este pedido não é de ATPV-e.' });
    if (q.status === 'aguardando_pdf')
      return res.status(400).json({ error: 'Este pedido ainda aguarda o documento. Cancele antes de excluir.' });

    const dias = (Date.now() - new Date(q.created_at).getTime()) / 86400000;
    if (dias < ATPVE_ADMIN_EXCLUSAO_DIAS)
      return res.status(400).json({
        error: `Só é possível excluir depois de ${ATPVE_ADMIN_EXCLUSAO_DIAS} dias. Este pedido tem ${Math.floor(dias)} dia(s).`,
      });

    // pdf_cache e vistocar_pending têm ON DELETE CASCADE na query; a transação
    // financeira fica, porque extrato não se apaga junto com histórico.
    await pool.query('DELETE FROM queries WHERE id=$1', [q.id]);
    console.log(`🗑️  Pedido de ATPV-e ${q.id} excluído pelo admin (${Math.floor(dias)} dias).`);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao excluir pedido de ATPV-e:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

const noCache = (res) => res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

// ── GET /api/html/:token ──────────────────────────────────────────────────────
app.get('/api/html/:token', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT pdf_data FROM pdf_cache WHERE token=$1 AND user_id=$2 AND expires_at > NOW()`,
      [req.params.token, req.user.id]
    );
    if (!r.rows.length)
      return res.status(404).send('<p style="font-family:sans-serif;padding:2rem">Relatório não encontrado ou expirado.</p>');
    const buf = Buffer.from(r.rows[0].pdf_data, 'base64');
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    return res.send(buf);
  } catch (err) {
    res.status(500).send('<p>Erro interno.</p>');
  }
});

// ── Verificação pública da ASD ────────────────────────────────────────────────
// Página aberta (sem login) para quem recebeu a ASD conferir o documento pelo
// QR/código impresso. Mostra SÓ o profissional, o serviço e a data: o
// beneficiário é dado de terceiro e não entra numa página pública. O CPF/CNPJ do
// profissional sai mascarado.
const escapeHtmlServer = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Mostra só os 3 primeiros e os 2 últimos dígitos (***.171.***-**), suficiente
// para conferir contra o documento em mãos sem publicar o CPF inteiro.
function maskDocPublic(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) return `***.${d.slice(3, 6)}.***-${d.slice(9)}`;
  if (d.length === 14) return `**.${d.slice(2, 5)}.***/****-${d.slice(12)}`;
  return '-';
}

function asdVerificacaoHtml({ titulo, corpo }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtmlServer(titulo)} — MC Despachadoria Consultas</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#f3f4f6; color:#111827; padding:24px 16px; }
  .card { max-width:640px; margin:0 auto; background:#fff; border:1px solid #e5e7eb;
          border-radius:14px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  .head { background:#1e40af; color:#fff; padding:18px 22px; }
  .head h1 { margin:0; font-size:17px; }
  .head p { margin:4px 0 0; font-size:12.5px; opacity:.85; }
  .body { padding:22px; }
  .badge { display:inline-flex; align-items:center; gap:7px; font-weight:700; font-size:14px;
           padding:8px 14px; border-radius:999px; margin-bottom:18px; }
  .ok   { background:#dcfce7; color:#166534; }
  .fail { background:#fee2e2; color:#991b1b; }
  dl { margin:0; display:grid; grid-template-columns:1fr; gap:2px; }
  .row { padding:10px 0; border-bottom:1px solid #f3f4f6; }
  .row:last-child { border-bottom:0; }
  dt { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#6b7280; margin-bottom:3px; }
  dd { margin:0; font-size:14.5px; font-weight:600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px;
         word-break:break-all; font-weight:400; color:#374151; }
  .nota { margin-top:20px; padding:13px 15px; background:#f9fafb; border:1px solid #e5e7eb;
          border-radius:10px; font-size:12px; color:#4b5563; line-height:1.55; }
  form { display:flex; gap:8px; margin-top:6px; flex-wrap:wrap; }
  input { flex:1 1 200px; padding:11px 13px; border:1px solid #d1d5db; border-radius:9px; font-size:14px; }
  button { padding:11px 20px; border:0; border-radius:9px; background:#1e40af; color:#fff;
           font-size:14px; font-weight:600; cursor:pointer; }
  .rodape { max-width:640px; margin:14px auto 0; text-align:center; font-size:11.5px; color:#6b7280; }
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <h1>Verificação de ASD</h1>
    <p>Anotação de Serviço Documental — MC Despachadoria Consultas</p>
  </div>
  <div class="body">${corpo}</div>
</div>
<p class="rodape">Consulta pública de integridade. Não substitui assinatura eletrônica (Lei nº 14.063/2020).</p>
</body>
</html>`;
}

const ASD_FORM_HTML = `
  <p style="margin:0 0 6px;font-size:13.5px;color:#4b5563">Informe o código impresso na ASD:</p>
  <form method="GET" action="/verificar-asd">
    <input name="codigo" placeholder="ASD-2026-XXXXXXXX" autocapitalize="characters" required>
    <button type="submit">Verificar</button>
  </form>`;

app.get('/verificar-asd', (req, res) => {
  const codigo = (req.query.codigo || '').toString().trim().toUpperCase();
  if (codigo) return res.redirect(`/verificar-asd/${encodeURIComponent(codigo)}`);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  noCache(res);
  res.type('html').send(asdVerificacaoHtml({ titulo: 'Verificar ASD', corpo: ASD_FORM_HTML }));
});

app.get('/verificar-asd/:codigo', async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  noCache(res);
  const codigo = (req.params.codigo || '').trim().toUpperCase();

  const naoEncontrada = (msg) => res.status(404).type('html').send(asdVerificacaoHtml({
    titulo: 'ASD não localizada',
    corpo: `<div class="badge fail">✕ ${escapeHtmlServer(msg)}</div>${ASD_FORM_HTML}`,
  }));

  if (!/^ASD-\d{4}-[0-9A-F]{8}$/.test(codigo))
    return naoEncontrada('Código inválido');

  try {
    await ensureDbReady(); // asd_registros é tabela nova — ver comentário em ensureDbReady
    const r = await pool.query(
      `SELECT seq, codigo, doc_hash, chain_hash, servico, uf, prof_nome, prof_doc, prof_matricula, created_at
         FROM asd_registros WHERE codigo=$1`,
      [codigo]
    );
    if (!r.rows.length) return naoEncontrada('Nenhuma ASD encontrada com esse código');

    const a = r.rows[0];
    const dt = new Date(a.created_at);
    const linha = (rot, val) => `<div class="row"><dt>${rot}</dt><dd>${val}</dd></div>`;

    const corpo = `
      <div class="badge ok">✓ ASD autêntica e registrada</div>
      <dl>
        ${linha('Código de verificação', escapeHtmlServer(a.codigo))}
        ${linha('Emitida em', dt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}
        ${linha('Serviço', escapeHtmlServer(a.servico || '-'))}
        ${linha('UF', escapeHtmlServer(a.uf || '-'))}
        ${linha('Profissional responsável', escapeHtmlServer(a.prof_nome || '-'))}
        ${linha('Matrícula (CRDD-UF)', escapeHtmlServer(a.prof_matricula || 'não informada'))}
        ${linha('CPF/CNPJ do profissional', maskDocPublic(a.prof_doc))}
        ${linha('Posição no livro do profissional', `ASD nº ${a.seq}`)}
        ${linha('Hash do documento (SHA-256)', `<code>${escapeHtmlServer(a.doc_hash)}</code>`)}
        ${linha('Hash da cadeia', `<code>${escapeHtmlServer(a.chain_hash)}</code>`)}
      </dl>
      <div class="nota">
        <strong>O que esta página comprova:</strong> que uma ASD com esses dados foi registrada nesta
        plataforma na data indicada e não foi alterada desde então. O <em>hash do documento</em> deve
        conferir com o impresso na ASD que você tem em mãos. Cada ASD encadeia a anterior do mesmo
        profissional, então modificar um registro antigo invalidaria todos os seguintes.<br><br>
        Por privacidade, os dados do beneficiário do serviço não são exibidos publicamente.
      </div>`;

    res.type('html').send(asdVerificacaoHtml({ titulo: `ASD ${a.codigo}`, corpo }));
  } catch (err) {
    console.error('Erro em /verificar-asd:', err.message);
    res.status(500).type('html').send(asdVerificacaoHtml({
      titulo: 'Erro',
      corpo: '<div class="badge fail">✕ Erro ao consultar. Tente novamente em instantes.</div>',
    }));
  }
});

// ── Rotas HTML ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  noCache(res); res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/entrar', (req, res) => {
  noCache(res); res.sendFile(path.join(__dirname, 'entrar.html'));
});
app.get('/cadastrar', (req, res) => {
  noCache(res); res.sendFile(path.join(__dirname, 'cadastrar.html'));
});
app.get('/cadastrar/revendedor', (req, res) => {
  noCache(res); res.sendFile(path.join(__dirname, 'cadastrar.html'));
});
app.get('/consulta-avulsa', async (req, res) => {
  // Página privada: o link sem código foi revogado — só abre com ?codigo=XXXXXX
  // de um cliente ativo (validado no banco antes de servir o HTML). Qualquer
  // outra tentativa volta para a home, como se a página não existisse.
  const codigo = (req.query.codigo || '').toString().trim().toUpperCase();
  if (!codigo) return res.redirect('/');
  const r = await pool.query(
    'SELECT 1 FROM public_access_codes WHERE code=$1 AND active=true', [codigo]
  ).catch(() => ({ rows: [] }));
  if (!r.rows.length) return res.redirect('/');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  noCache(res); res.sendFile(path.join(__dirname, 'consulta-avulsa.html'));
});
app.get('/painel', requireAuth, (req, res) => {
  if (req.user.role === 'reseller' || req.user.role === 'admin')
    return res.redirect('/painel/revendedor');
  res.redirect('/painel/usuario');
});
app.get('/painel/usuario', requireAuth, (req, res) => {
  noCache(res); res.sendFile(path.join(__dirname, 'painel-usuario.html'));
});
app.get('/recarga-pix', requireAuth, (req, res) => {
  noCache(res); res.sendFile(path.join(__dirname, 'recarga-pix.html'));
});
app.get('/painel/revendedor', requireAuth, (req, res) => {
  noCache(res); res.sendFile(path.join(__dirname, 'painel-revendedor.html'));
});
app.get('/admin', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length || !SUPER_ADMIN_EMAILS.includes(r.rows[0].email)) return res.redirect('/painel');
    noCache(res); res.sendFile(path.join(__dirname, 'admin.html'));
  } catch {
    res.redirect('/painel');
  }
});

// ── Broadcast WhatsApp — campanhas em rodízio ───────────────────────────────
// Duas campanhas em rodizio: os grupos recebem uma a cada disparo, alternando,
// para o mesmo card nao se repetir sempre no mesmo grupo.
// - Campanha com `videoApresentacao`: vai o VIDEO de apresentacao (HeyGen, ver
//   VIDEO_APRESENTACAO_ID) com a mensagem como legenda, e so ele — o marcos.mp4
//   nao vai depois (seriam dois videos seguidos). O video vai por LINK, nao
//   base64: sao ~25 MB, e a Z-API baixa direto do CDN da HeyGen (aceita ate
//   100 MB). Se a HeyGen falhar na hora, cai na `imagem` + mensagem de antes.
// - As demais: imagem + mensagem e, logo depois, o marcos.mp4.
const BROADCAST_VIDEO_PATH = path.join(__dirname, 'marcos.mp4');

const BROADCAST_CAMPANHAS = [
  {
    id: 'atpve',
    videoApresentacao: true,
    imagem: path.join(__dirname, 'promo-atpve.png'), // reserva, se a HeyGen falhar
    mensagem:
`🛑ATENÇÃO CADASTRE COM SEU NUMERO WHATSAPP CORRETO PARA RECEBER AS NOTIFICAÇÕES
✅ FAÇA SEU CADASTRO:
✅ PAGAMENTO INSTANTÂNEO: PIX: QRcod, copia e Cola, na tela.
✅ Faça Recarga via PIX no valor que quiser.
🔎 Nossos Serviços:
🛑Agora temos consulta ATPVe com comunicação de venda, Saindo na hora
🛑Numero do CRV Antigo, dos Estados: RJ, SP, MG, CE, ES, BA, RN, PE, PB, e outros, total de 21 Estados veja em seu painel🛑
✅ Sem mensalidade. Pague só pelo que usar.
👉 https://www.despachantesconsultas.com.br`,
  },
  {
    id: 'despachantes',
    imagem: path.join(__dirname, 'promo-despachantes.png'),
    mensagem:
`🛑 NO CARD: Coisas de Despachantes.
🛑 ATENÇÃO DESPACHANTES ESSA É SÓ PARA VOCÊS ASSINATURA POR 30 REAIS MÊS, INCLUINDO 5 CONSULTAS:
✅ Consulta placas 50
✅ Consulta 3 Código Segurança CRV (PDF) 5
✅ Gerar Declaração de Residência DETRAN RJ
✅ Nota de Prestação de Serviços Para Despachantes Rio
✅ Gerar ASD
################################################################################
✅CRLVe CE 32,50 Você Recebe no WhatsApp em minutos
✅CRLVe PE 35,00 Imediato
✅CRLVe Rio 1° via 20,00 imediato
✅CRLVe Rio 2° via Reemissão 55,00 imediato
👉 https://www.despachantesconsultas.com.br`,
  },
];

// Rodizio por canal (geral / portal / servicos): cada canal tem cadencia
// propria, entao guardar um contador por canal faz os tres alternarem sem se
// atrapalhar. Precisa de estado no banco porque na Vercel cada execucao do cron
// e um processo novo — variavel em memoria voltaria sempre a mesma campanha.
async function proximaCampanhaBroadcast(canal) {
  const r = await pool.query(
    `INSERT INTO broadcast_campanha_state (canal, disparos) VALUES ($1, 1)
     ON CONFLICT (canal) DO UPDATE SET disparos = broadcast_campanha_state.disparos + 1,
                                       updated_at = NOW()
     RETURNING disparos`,
    [canal]
  );
  const n = r.rows[0].disparos;
  return BROADCAST_CAMPANHAS[(n - 1) % BROADCAST_CAMPANHAS.length];
}

// Envia broadcast apenas para grupos — envio para contatos individuais foi
// desativado por estar sendo denunciado como spam no WhatsApp.
// Grupos vêm da Z-API com isGroup:true e phone no formato "<id>-group"
// (não usam o sufixo "@g.us" do protocolo interno do WhatsApp).
// Retorna { phone, name } de cada grupo — o "name" permite filtrar grupos
// específicos no broadcast prioritário (ver BROADCAST_PRIORITY_GROUPS).
async function fetchZApiDestinations() {
  const headers = ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {};
  const base = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

  const statusRes = await fetch(`${base}/status`, { headers });
  if (statusRes.ok) {
    const st = await statusRes.json().catch(() => ({}));
    if (!st.connected) {
      throw new Error('WhatsApp não conectado na Z-API. Escaneie o QR Code para reconectar a instância.');
    }
  }

  // Chave = ID único (phone do grupo)
  const destinations = new Map();

  for (let page = 1; page <= 5; page++) {
    const chatsRes = await fetch(`${base}/chats?page=${page}&pageSize=500`, { headers });
    if (!chatsRes.ok) { console.warn('⚠️  Z-API /chats falhou:', chatsRes.status); break; }
    const data = await chatsRes.json().catch(() => []);
    const list = Array.isArray(data) ? data : (data.value || data.chats || []);
    list.forEach(c => {
      const phone = String(c.phone || '');
      if (c.isGroup === true && phone) destinations.set(phone, { phone, name: c.name || c.chatName || '' });
    });
    if (list.length < 500) break;
  }
  console.log(`📋 Grupos: ${destinations.size}`);

  return [...destinations.values()];
}

// Envio de texto puro para grupo. Nao da para usar o sendWhatsApp comum: ele
// passa pelo formatWhatsAppPhone, que so deixa digitos e destruiria o sufixo
// "-group" do id do grupo.
async function sendBroadcastText(dest, message) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !dest) return;
  const phone = String(dest);
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {}),
        },
        body: JSON.stringify({ phone, message }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Broadcast texto erro [${phone}]:`, JSON.stringify(d)); throw new Error('envio recusado'); }
    console.log(`✅ Broadcast texto → ${phone}`);
  } catch (err) {
    console.error(`Broadcast texto falha [${phone}]:`, err.message);
    throw err;
  }
}

// Envio para broadcast — sempre para IDs de grupo ("<id>-group"), imagem + legenda
async function sendBroadcastImage(dest, base64Png, caption) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !dest) return;
  const phone = String(dest);
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-image`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {}),
        },
        body: JSON.stringify({ phone, image: `data:image/png;base64,${base64Png}`, caption }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) console.error(`Broadcast erro [${phone}]:`, JSON.stringify(d));
    else console.log(`✅ Broadcast → ${phone}`);
  } catch (err) {
    console.error(`Broadcast falha [${phone}]:`, err.message);
    throw err;
  }
}

// Envia vídeo para o grupo. `video` é um link (https://…) ou o base64 do MP4;
// `caption` é opcional (o marcos.mp4 vai sem legenda, depois da imagem).
async function sendBroadcastVideo(dest, video, caption) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !dest) return;
  const phone = String(dest);
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-video`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {}),
        },
        body: JSON.stringify({
          phone,
          video: /^https?:\/\//.test(video) ? video : `data:video/mp4;base64,${video}`,
          ...(caption ? { caption } : {}),
        }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Broadcast vídeo erro [${phone}]:`, JSON.stringify(d)); throw new Error('envio recusado'); }
    console.log(`✅ Broadcast vídeo → ${phone}`);
  } catch (err) {
    console.error(`Broadcast vídeo falha [${phone}]:`, err.message);
    throw err;
  }
}

// Grupos com disparo proprio, em cadencia diferente do resto:
// PORTAL⚔️DESPACHANTES roda de 3 em 3 horas em horario comercial (seg-sex,
// 10h/13h/16h BRT) e SERVIÇOS, OFERTAS E AMIGOS de 3 em 3 horas todos os dias
// (ver schedules em vercel.json). Como ja tem cadencia propria, os dois ficam
// FORA do disparo geral — antes recebiam os dois e viam a mensagem repetida.
const BROADCAST_GROUP_PORTAL = 'PORTAL⚔️DESPACHANTES';
const BROADCAST_GROUP_SERVICOS = 'SERVIÇOS, OFERTAS E AMIGOS';
const BROADCAST_GROUP_DOCUMENTALISTAS = 'Despachantes Documentalistas do Brasil';
// Grupos do canal "servicos" — mesma cadencia e mesmo rodizio de campanhas.
const BROADCAST_GRUPOS_SERVICOS = [BROADCAST_GROUP_SERVICOS, BROADCAST_GROUP_DOCUMENTALISTAS];
// Grupo ainda em formacao: so entra na cadencia do canal "servicos" (de 3 em 3
// horas) quando atingir este numero de membros. Ate la ele recebe o disparo
// geral (de 3 em 3 dias) junto com os demais grupos — por isso a mesma regra
// serve para os dois lados: incluir no "servicos" a partir do minimo e excluir
// do "geral" a partir do minimo, sem nunca receber os dois.
const BROADCAST_MIN_MEMBROS = [{ nome: BROADCAST_GROUP_DOCUMENTALISTAS, minimo: 200 }];

// Nome de grupo no WhatsApp costuma ter emoji/sufixo extra
// (ex.: "PORTAL⚔️DESPACHANTES🇧🇷📌"), por isso startsWith e nao igualdade.
// Acento e espaco repetido tambem saem da comparacao: os nomes-alvo sao
// digitados a mao e o grupo pode estar salvo sem acento ("NOTICIAS DE
// SAQUAREMA") ou com dois espacos no meio ("ARARUAMA NEWS RJ  01").
const normalizaNomeGrupo = s => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').trim().toUpperCase();

function nomeGrupoCombina(nome, alvos) {
  const n = normalizaNomeGrupo(nome);
  return alvos.some(a => n.startsWith(normalizaNomeGrupo(a)));
}

// Quantos membros um grupo tem hoje (Z-API group-metadata). Retorna null se a
// consulta falhar — quem chama decide o que fazer com a incerteza.
async function contarMembrosGrupo(phone) {
  const headers = ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {};
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/group-metadata/${encodeURIComponent(phone)}`,
      { headers }
    );
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d) return null;
    if (Array.isArray(d.participants)) return d.participants.length;
    // Algumas respostas trazem so o total, sem a lista de participantes.
    const n = Number(d.participantsCount ?? d.size ?? d.membersCount);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// canal identifica o rodizio de campanha (ver proximaCampanhaBroadcast);
// incluir = so estes grupos; excluir = todos menos estes; minMembros =
// [{ nome, minimo }] so dispara para o grupo depois que ele cresceu;
// excluirAoAtingir = o inverso, tira o grupo assim que ele cresce.
async function selecionarDestinosBroadcast({ canal, incluir, excluir, minMembros, excluirAoAtingir } = {}) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) throw new Error('Z-API não configurada');
  let dests = await fetchZApiDestinations();
  if (incluir?.length) dests = dests.filter(d => nomeGrupoCombina(d.name, incluir));
  if (excluir?.length) dests = dests.filter(d => !nomeGrupoCombina(d.name, excluir));

  // Regras de minimo de membros. No canal "servicos" (minMembros) o grupo so
  // entra depois de atingir a marca; no disparo geral (excluirAoAtingir) ele
  // sai justamente quando atinge, porque passa a receber pela outra cadencia.
  // Se nao der para contar (Z-API fora do ar), trata como "ainda nao atingiu":
  // o grupo continua no geral e fica fora do servicos, nunca nos dois.
  const regrasMin = minMembros || excluirAoAtingir;
  if (regrasMin?.length) {
    const manter = [];
    for (const d of dests) {
      const regra = regrasMin.find(r => nomeGrupoCombina(d.name, [r.nome]));
      if (!regra) { manter.push(d); continue; }
      const membros = await contarMembrosGrupo(d.phone);
      const atingiu = membros !== null && membros >= regra.minimo;
      if (atingiu === Boolean(minMembros)) manter.push(d);
      else console.log(`⏭️  Broadcast [${canal || 'geral'}] pulou "${d.name}": ${membros ?? '?'} membros (minimo ${regra.minimo})`);
    }
    dests = manter;
  }

  return dests;
}

async function runWhatsAppBroadcast(opts = {}) {
  const { canal } = opts;
  const dests = await selecionarDestinosBroadcast(opts);

  const campanha = await proximaCampanhaBroadcast(canal || 'geral');
  console.log(`📢 Broadcast [${canal || 'geral'}] campanha "${campanha.id}": ${dests.length} grupos`);

  // Link novo a cada disparo: o da HeyGen é assinado e expira.
  let videoUrl = null;
  if (campanha.videoApresentacao) {
    try {
      const v = await buscarVideoApresentacao();
      if (v.status === 'completed' && v.video_url) videoUrl = v.video_url;
      else console.error(`Broadcast: vídeo de apresentação indisponível (status ${v.status}) — indo com a imagem.`);
    } catch (e) {
      console.error('Broadcast: HeyGen falhou, indo com a imagem:', e.message);
    }
  }
  const imageBase64 = videoUrl ? null : fs.readFileSync(campanha.imagem).toString('base64');
  const videoBase64 = videoUrl ? null : fs.readFileSync(BROADCAST_VIDEO_PATH).toString('base64');
  let sent = 0, failed = 0;
  for (const dest of dests) {
    try {
      if (videoUrl) {
        try {
          await sendBroadcastVideo(dest.phone, videoUrl, campanha.mensagem);
        } catch {
          // Vídeo recusado pela Z-API: o grupo recebe o card de antes em vez
          // de ficar sem a campanha.
          await sendBroadcastImage(dest.phone, fs.readFileSync(campanha.imagem).toString('base64'), campanha.mensagem);
        }
      } else {
        await sendBroadcastImage(dest.phone, imageBase64, campanha.mensagem);
        await new Promise(r => setTimeout(r, 1000));
        await sendBroadcastVideo(dest.phone, videoBase64);
      }
      sent++;
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`✅ Broadcast concluído: ${sent} enviados, ${failed} falhas`);
  return { sent, failed, total: dests.length, campanha: campanha.id, formato: videoUrl ? 'video' : 'imagem' };
}

// ── GET /api/cron/broadcast-whatsapp (Vercel Cron — 8h BRT = 11h UTC, de 3 em
// 3 dias) ── Vai para os DEMAIS grupos: PORTAL e SERVIÇOS ficam de fora porque
// ja tem disparo proprio, varias vezes ao dia.
app.get('/api/cron/broadcast-whatsapp', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runWhatsAppBroadcast({
      canal: 'geral',
      excluir: [BROADCAST_GROUP_PORTAL, BROADCAST_GROUP_SERVICOS],
      excluirAoAtingir: BROADCAST_MIN_MEMBROS,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no cron broadcast:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/broadcast-whatsapp (teste manual pelo admin) ──────────────
app.post('/api/admin/broadcast-whatsapp', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runWhatsAppBroadcast({
      canal: 'geral',
      excluir: [BROADCAST_GROUP_PORTAL, BROADCAST_GROUP_SERVICOS],
      excluirAoAtingir: BROADCAST_MIN_MEMBROS,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no broadcast manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/broadcast-whatsapp-priority (Vercel Cron — de 3 em 3 horas, todo dia) ─
// Só para o grupo SERVIÇOS, OFERTAS E AMIGOS.
app.get('/api/cron/broadcast-whatsapp-priority', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runWhatsAppBroadcast({ canal: 'servicos', incluir: BROADCAST_GRUPOS_SERVICOS, minMembros: BROADCAST_MIN_MEMBROS });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no cron broadcast prioritário:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/broadcast-whatsapp-priority (teste manual pelo admin) ────
app.post('/api/admin/broadcast-whatsapp-priority', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runWhatsAppBroadcast({ canal: 'servicos', incluir: BROADCAST_GRUPOS_SERVICOS, minMembros: BROADCAST_MIN_MEMBROS });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no broadcast prioritário manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/broadcast-whatsapp-portal (Vercel Cron — de 3 em 3 horas,
// seg-sex, 10h/13h/16h BRT) ── Só para o grupo PORTAL⚔️DESPACHANTES.
app.get('/api/cron/broadcast-whatsapp-portal', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runWhatsAppBroadcast({ canal: 'portal', incluir: [BROADCAST_GROUP_PORTAL] });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no cron broadcast portal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/broadcast-whatsapp-portal (teste manual pelo admin) ──────
app.post('/api/admin/broadcast-whatsapp-portal', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runWhatsAppBroadcast({ canal: 'portal', incluir: [BROADCAST_GROUP_PORTAL] });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no broadcast portal manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Tabela de serviços — disparo de 5 em 5 dias ──────────────────────────────
// Mensagem de texto puro (sem imagem nem vídeo, diferente das campanhas em
// rodízio) para os grupos do disparo geral: PORTAL e SERVIÇOS ficam de fora
// porque já recebem campanha de 3 em 3 horas.
const BROADCAST_TABELA_DIAS = 5;
const BROADCAST_TABELA_MENSAGEM = `👉 https://www.despachantesconsultas.com.br
Olá! 🚗💨 Confira nossa tabela atualizada de serviços e consultas veiculares. Facilidade, rapidez e sem burocracia para você resolver tudo direto pelo WhatsApp:

🛑 📄 DOCUMENTOS E ATPV-e

✅ Reemissão ATPV-e com Com. Venda: R$ 120,00 (Placa)

✅ Reemissão ATPV-e: R$ 18,90 (Placa + Renavam ou Chassi)

✅ Inserir Comunicação de Venda: R$ 32,90

✅ Transmitir / Desbloquear Comunicação: R$ 7,00

✅ Cancelar Comunicação de Venda: R$ 11,20

🚗 EMISSÃO DE CRLV-e (LICENCIAMENTO)

✅ CRLV-e RJ (⚡ Na hora / Reemissão): R$ 20,00 a R$ 65,00

✅ CRLV-e Instantâneo (PE / CE): A partir de R$ 32,50

✅ CRLV-e Agendado (ES, AL, DF, PB, PR, RN, SC): R$ 21,00 a R$ 84,00

✅ CRLV-e Digital por Estado (SP, MG, BA, PR, etc.): R$ 14,00 a R$ 162,00 (Placa + Renavam + CPF)

🔍 CONSULTAS E DÉBITOS

✅ Consulta FIPE: Grátis

✅ Consulta de Débitos: R$ 1,50 (Placa) | Todos os estados: R$ 3,00 (Placa + Renavam)

✅ Licenciamento + BIN: R$ 14,00 (Placa)

✅ Básica Estadual / Nacional / RENAVAM: R$ 3,00 a R$ 9,80

✅ Gravame / RENAJUD / Comunicado: R$ 10,50 a R$ 13,30

✅ Histórico de Proprietários: R$ 13,99 (Placa)

✅ Consulta Cautelar VIP GOLD: R$ 27,99 (Placa)

✅ Histórico de Leilão / Fotos: R$ 14,00 a R$ 30,00

✅ Roubo e Furto: R$ 25,00

✅ Auto KM / Prop. Atual / Chassi: R$ 10,50

🛠️ OUTROS SERVIÇOS E DOCUMENTAÇÕES

✅ Localização / Veículos por CPF ou CNPJ: R$ 5,00 a R$ 14,00

✅ Consultar CNH (Por Estado): R$ 4,00 a R$ 16,00

✅ Número CRV Antigo (Por Estado): R$ 77,00 a R$ 600,00

✅ Dívida Ativa (SP, DF, RJ): R$ 3,00

✅ Consulta SPC / Crédito: R$ 21,00

✅ Gerar Contrato / Procuração Veicular: R$ 16,00 a R$ 22,00

⭐ Ferramentas Exclusivas para Assinantes: Declaração de Residência, Nota de Serviços e ASD são Grátis!`;

// Cadência real de 5 dias: o cron roda todo dia e esta troca atômica decide se
// já venceu. O UPDATE condicional no ON CONFLICT garante que só um processo
// leva o disparo, mesmo se a Vercel executar o cron duas vezes.
async function reservarDisparoTabela() {
  const r = await pool.query(
    `INSERT INTO broadcast_agenda (canal, ultimo_envio) VALUES ($1, NOW())
     ON CONFLICT (canal) DO UPDATE SET ultimo_envio = NOW()
      WHERE broadcast_agenda.ultimo_envio <= NOW() - make_interval(days => $2)
     RETURNING ultimo_envio`,
    ['tabela', BROADCAST_TABELA_DIAS]
  );
  return r.rowCount > 0;
}

// Devolve a marca para trás quando o disparo nem chegou a sair (Z-API fora do
// ar, por exemplo) — assim o cron do dia seguinte tenta de novo em vez de
// esperar os 5 dias inteiros.
async function devolverDisparoTabela() {
  await pool.query(
    `UPDATE broadcast_agenda
        SET ultimo_envio = ultimo_envio - make_interval(days => $1)
      WHERE canal = 'tabela'`,
    [BROADCAST_TABELA_DIAS]
  ).catch(() => {});
}

async function runBroadcastTabela() {
  const dests = await selecionarDestinosBroadcast({
    canal: 'tabela',
    excluir: [BROADCAST_GROUP_PORTAL, BROADCAST_GROUP_SERVICOS],
    excluirAoAtingir: BROADCAST_MIN_MEMBROS,
  });
  console.log(`📢 Broadcast [tabela]: ${dests.length} grupos`);

  let sent = 0, failed = 0;
  for (const dest of dests) {
    try {
      await sendBroadcastText(dest.phone, BROADCAST_TABELA_MENSAGEM);
      sent++;
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`✅ Broadcast tabela concluído: ${sent} enviados, ${failed} falhas`);
  return { sent, failed, total: dests.length };
}

// ── GET /api/cron/broadcast-whatsapp-tabela (Vercel Cron — todo dia às 11h BRT;
// o envio mesmo sai de 5 em 5 dias, quem decide é reservarDisparoTabela) ──────
app.get('/api/cron/broadcast-whatsapp-tabela', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (!await reservarDisparoTabela())
      return res.json({ success: true, skipped: 'ainda não completou 5 dias desde o último disparo' });
    try {
      const result = await runBroadcastTabela();
      res.json({ success: true, ...result });
    } catch (err) {
      await devolverDisparoTabela();
      throw err;
    }
  } catch (err) {
    console.error('Erro no cron broadcast tabela:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/broadcast-whatsapp-tabela (disparo manual pelo admin) ─────
// Sai na hora e reinicia a contagem dos 5 dias a partir de agora.
app.post('/api/admin/broadcast-whatsapp-tabela', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runBroadcastTabela();
    await pool.query(
      `INSERT INTO broadcast_agenda (canal, ultimo_envio) VALUES ('tabela', NOW())
       ON CONFLICT (canal) DO UPDATE SET ultimo_envio = NOW()`
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no broadcast tabela manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EducaAI (suead.com.br) — disparo diario as 10h BRT ───────────────────────
// Campanha de outra marca, fora do catalogo de consultas: vai so para os grupos
// listados aqui (incluir), nunca para a base inteira. Texto puro, sem imagem
// nem video, e sem rodizio — a mensagem e sempre a mesma.
const BROADCAST_EDUCAAI_GRUPOS = [
  'ANÚNCIO ARARUAMA NEWS RJ 01',
  'NOTÍCIAS DE SAQUAREMA',
  'LAGOS INFORMAÇÃO NEWS',
  BROADCAST_GROUP_SERVICOS,
  'SOS IGUABINHA',
  'Grupo de divulgação de vendas em geral',
  'Amigos de Cabo Frio',
  'REGIÃO DOS LAGOS RJ',
  'NOTÓRIOS NOTÍCIAS 24H',
  // De proposito casa com DOIS grupos: existem duas "Notícias de Arraial do
  // Cabo" na conta, com ids diferentes, e as duas devem receber.
  'Notícias de Arraial do Cabo',
  'OLX LAGOS E LINKS WHATSAPP',
];

const BROADCAST_EDUCAAI_MENSAGEM = `Olá! Tudo bem? 📱

Se você busca transformar e modernizar processos educativos com tecnologia de ponta, precisa conhecer o EducaAI. Combinamos inteligência artificial e soluções práticas para otimizar o aprendizado e potencializar resultados no setor educacional. 🚀

Confira nossas soluções e saiba mais em nosso site:
👉 https://www.suead.com.br/`;

// O cron e diario, mas a Vercel pode repetir a execucao — esta troca atomica
// (mesma tabela do disparo da tabela de servicos) garante um envio por dia.
// O guarda e por DIA no fuso de Brasilia, nao por intervalo de horas: um
// disparo manual a tarde nao pode bloquear o cron das 10h do dia seguinte
// (com janela de 24h, bloquearia).
async function reservarDisparoEducaAI() {
  const r = await pool.query(
    `INSERT INTO broadcast_agenda (canal, ultimo_envio) VALUES ($1, NOW())
     ON CONFLICT (canal) DO UPDATE SET ultimo_envio = NOW()
      WHERE (broadcast_agenda.ultimo_envio AT TIME ZONE 'America/Sao_Paulo')::date
          < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
     RETURNING ultimo_envio`,
    ['educaai']
  );
  return r.rowCount > 0;
}

// Devolve a marca para ontem quando o disparo nem chegou a sair (Z-API fora do
// ar): a proxima execucao tenta de novo em vez de pular o dia.
async function devolverDisparoEducaAI() {
  await pool.query(
    `UPDATE broadcast_agenda
        SET ultimo_envio = ultimo_envio - INTERVAL '1 day'
      WHERE canal = 'educaai'`
  ).catch(() => {});
}

async function runBroadcastEducaAI() {
  const dests = await selecionarDestinosBroadcast({
    canal: 'educaai',
    incluir: BROADCAST_EDUCAAI_GRUPOS,
  });
  console.log(`📢 Broadcast [educaai]: ${dests.length} grupos`);

  // Grupo da lista que a Z-API nao devolveu (nome mudou, saimos do grupo): sem
  // isso o disparo "funciona" caindo em menos grupos a cada dia, sem aviso.
  const faltando = BROADCAST_EDUCAAI_GRUPOS.filter(
    alvo => !dests.some(d => nomeGrupoCombina(d.name, [alvo]))
  );
  if (faltando.length) console.warn(`⚠️  Broadcast [educaai] nao encontrou: ${faltando.join(' | ')}`);

  let sent = 0, failed = 0;
  for (const dest of dests) {
    try {
      await sendBroadcastText(dest.phone, BROADCAST_EDUCAAI_MENSAGEM);
      sent++;
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`✅ Broadcast educaai concluído: ${sent} enviados, ${failed} falhas`);
  return { sent, failed, total: dests.length, naoEncontrados: faltando };
}

// ── GET /api/cron/broadcast-whatsapp-educaai (Vercel Cron — todo dia 13h UTC =
// 10h BRT) ───────────────────────────────────────────────────────────────────
app.get('/api/cron/broadcast-whatsapp-educaai', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (!await reservarDisparoEducaAI())
      return res.json({ success: true, skipped: 'o disparo EducaAI de hoje já saiu' });
    try {
      const result = await runBroadcastEducaAI();
      res.json({ success: true, ...result });
    } catch (err) {
      await devolverDisparoEducaAI();
      throw err;
    }
  } catch (err) {
    console.error('Erro no cron broadcast educaai:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/broadcast-whatsapp-educaai (disparo manual pelo admin) ────
// Sai na hora e marca o dia como disparado, para o cron das 10h não repetir.
app.post('/api/admin/broadcast-whatsapp-educaai', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runBroadcastEducaAI();
    await pool.query(
      `INSERT INTO broadcast_agenda (canal, ultimo_envio) VALUES ('educaai', NOW())
       ON CONFLICT (canal) DO UPDATE SET ultimo_envio = NOW()`
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no broadcast educaai manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: verifica pedidos de CRLV-e Agendado pendentes e avisa por WhatsApp ──
async function checkCrlvAgendadoStatus(pedidoId) {
  const pid = String(pedidoId).trim();
  let apiUrl, headers;
  if (pid.startsWith('AUTOCRLV-')) {
    const code = pid.slice('AUTOCRLV-'.length);
    apiUrl  = `https://autocrlv.com.br/cliente/api_integracao_crlv_agendado_status.php?code=${encodeURIComponent(code)}`;
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTOCRLV_KEY}` };
  } else if (pid.startsWith(PORTAL_PEDIDO_PREFIX)) {
    // Pedido do portal (hoje o CE): o prefixo é nosso, a API só conhece o número.
    apiUrl  = `${PORTAL_BASE_URL}/api/crlv-agendado/${pid.slice(PORTAL_PEDIDO_PREFIX.length)}`;
    headers = { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY };
  } else {
    apiUrl  = `${PORTAL_BASE_URL}/api/crlv-agendado/${pid}`;
    headers = { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY };
  }
  const apiRes = await fetch(apiUrl, { method: 'GET', headers });
  if (!apiRes.ok) return null;
  const data = await apiRes.json().catch(() => null);
  if (!data) return null;
  const pedido       = data?.pedido || data?.data?.pedido || {};
  const statusResumo = data?.status_resumo || data?.data?.status_resumo || {};
  const pdfPath    = pedido.pdf_url || statusResumo.pdf_url || '';
  const podeBaixar = data?.pdf_disponivel === true || statusResumo.pode_baixar_pdf === true;
  const placa = (pedido.placa || data?.placa || '-').toString().toUpperCase();
  const uf    = (pedido.uf    || data?.uf    || '-').toString().toUpperCase();
  return { podeBaixar, pdfPath, placa, uf };
}

// Prazo máximo que um pedido assíncrono (CRLV-e Agendado) fica pendente antes
// do cron desistir e estornar
// automaticamente os créditos — nunca fica cobrado para sempre sem o documento.
const ASYNC_PDF_REFUND_HOURS = 48;

async function runCrlvAgendadoPendingCheck() {
  await pool.query(`DELETE FROM crlv_agendado_pending WHERE created_at < NOW() - INTERVAL '20 days'`).catch(() => {});
  const { rows: pendentes } = await pool.query('SELECT * FROM crlv_agendado_pending ORDER BY created_at ASC LIMIT 200');
  let notified = 0, checked = 0, refunded = 0;
  for (const row of pendentes) {
    checked++;
    try {
      const already = await pool.query('SELECT 1 FROM crlv_agendado_notifications WHERE pedido_id=$1', [row.pedido_id]);
      if (already.rows.length > 0) {
        await pool.query('DELETE FROM crlv_agendado_pending WHERE pedido_id=$1', [row.pedido_id]);
        continue;
      }

      const status = await checkCrlvAgendadoStatus(row.pedido_id);
      if (status?.podeBaixar && status.pdfPath && row.phone) {
        const fullUrl = /^https?:\/\//i.test(status.pdfPath) ? status.pdfPath : PORTAL_BASE_URL + status.pdfPath;
        const pdfApiRes = await fetch(fullUrl);
        if (pdfApiRes.ok) {
          const pdfBuf = Buffer.from(await pdfApiRes.arrayBuffer());
          if (pdfBuf.slice(0, 4).toString() === '%PDF') {
            const placa = status.placa !== '-' ? status.placa : (row.placa || '-');
            const uf    = status.uf    !== '-' ? status.uf    : (row.uf    || '-');
            const caption = `✅ *CRLV-e Agendado pronto!*\n🔤 Placa: ${placa}\n📍 UF: ${uf}\n📋 Pedido: ${row.pedido_id}\n\nDocumento gerado pela MC Despachadoria.`;
            await sendWhatsAppPdf(row.phone, pdfBuf, `CRLV-e-Agendado-${row.pedido_id}.pdf`, caption).catch(() => {});
            await pool.query('INSERT INTO crlv_agendado_notifications (pedido_id) VALUES ($1) ON CONFLICT DO NOTHING', [row.pedido_id]);
            await pool.query('DELETE FROM crlv_agendado_pending WHERE pedido_id=$1', [row.pedido_id]);
            notified++;
            continue;
          }
        }
      }

      // Documento ainda não ficou pronto — se já passou do prazo, estorna e
      // para de tentar (evita cobrar para sempre por um pedido que nunca sai).
      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (ageMs > ASYNC_PDF_REFUND_HOURS * 3600 * 1000) {
        if (!row.query_id || !row.amount) {
          // Pedido enfileirado antes desta migração (sem query_id/amount) — não
          // dá para estornar com segurança. Mantém na fila (não apaga) até o
          // admin resolver manualmente ou a limpeza de 20 dias remover.
          console.error(`CRLV-e Agendado pedido ${row.pedido_id} vencido (${ASYNC_PDF_REFUND_HOURS}h) sem query_id/amount — não estornado automaticamente.`);
        } else {
          const ok = await refundQuery(row.query_id, row.user_id, parseFloat(row.amount),
            `CRLV-e Agendado (pedido ${row.pedido_id}) não ficou pronto em ${ASYNC_PDF_REFUND_HOURS}h`);
          if (ok) {
            refunded++;
            if (row.phone) {
              const msg = `⚠️ *CRLV-e Agendado — Pedido ${row.pedido_id}*\n\nO documento não ficou disponível dentro do prazo esperado. O valor pago foi estornado para o seu saldo. Se precisar, tente novamente ou fale com o suporte.`;
              await sendWhatsApp(row.phone, msg).catch(() => {});
            }
          }
          await pool.query('DELETE FROM crlv_agendado_pending WHERE pedido_id=$1', [row.pedido_id]);
        }
      }
    } catch (e) {
      console.error(`Erro ao checar CRLV-e Agendado pedido ${row.pedido_id}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`✅ Checagem CRLV-e Agendado: ${checked} verificados, ${notified} avisados, ${refunded} estornados`);
  return { checked, notified, refunded, pending: pendentes.length };
}

// Varre os pedidos assíncronos da Vistocar (hoje o CRLV-e CE) que ainda não
// foram entregues e tenta buscar o resultado em GET /apiclient/consult/:id —
// rede de segurança para a notificação que se perder (webhook fora do ar,
// cadastro inativo, 5xx nosso além das 5 tentativas dela). Passado o prazo sem
// documento, desiste: como a cobrança só acontece na entrega, não há estorno a
// fazer — a consulta é marcada como 'cancelado' e o cliente avisado de que não
// pagou nada.
// Varre os pedidos de Assinatura Digital em aberto e tenta entregar o documento
// assinado. Roda no mesmo cron do CRLV/Vistocar (de 15 em 15 minutos): é o que
// atende quem fechou a página depois de enviar. Não há prazo para desistir nem
// estorno — o envio já foi feito e pago pela assinatura; um documento que o
// signatário nunca assina fica pendente até a Assinafy marcá-lo como expirado,
// e aí entrarmos pelo ramo "encerrado".
async function runAssinafyPendingCheck() {
  await ensureDbReady();   // assinafy_pending é tabela nova — ver ensureDbReady
  const { rows } = await pool.query(
    `SELECT * FROM assinafy_pending ORDER BY created_at ASC LIMIT 100`
  );
  let entregues = 0, encerrados = 0;
  for (const row of rows) {
    try {
      const r = await entregarAssinaturaDigital(row);
      if (r.entregue) entregues++;
      else if (String(r.motivo || '').startsWith('encerrado')) encerrados++;
    } catch (e) {
      console.error(`Erro ao checar assinatura pendente [documentId ${row.document_id}]:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (rows.length) console.log(`✅ Assinaturas pendentes: ${rows.length} verificadas, ${entregues} entregues, ${encerrados} encerradas`);
  return { verificadas: rows.length, entregues, encerrados };
}

async function runVistocarPendingCheck() {
  await ensureDbReady();   // vistocar_pending é tabela nova — ver ensureDbReady
  const { rows } = await pool.query(
    `SELECT p.*, q.service_name FROM vistocar_pending p
     LEFT JOIN queries q ON q.id = p.query_id
     ORDER BY p.created_at ASC LIMIT 200`
  );
  let entregues = 0, cancelled = 0;
  for (const row of rows) {
    try {
      const r = await entregarResultadoVistocar(row);
      if (r.entregue) { entregues++; continue; }

      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (ageMs <= ASYNC_PDF_REFUND_HOURS * 3600 * 1000) continue;   // ainda dentro do prazo
      // Cadastro de ATPV-e que expirou sem nunca ter sido registrado não é falha
      // do Detran: ninguém apertou "Registrar". Dizer isso ao cliente é o que
      // evita a ligação "paguei e não veio" — e ele não foi cobrado.
      const semRegistro = VISTOCAR_ATPVE_SVCS.has(row.service_id) && !row.registrado_em;
      await cancelarPendenciaVistocar(row, semRegistro
        ? 'o cadastro não chegou a ser registrado no Detran dentro do prazo — é preciso cadastrar de novo e clicar em "Registrar no Detran"'
        : 'não foi emitido dentro do prazo esperado');
      cancelled++;
    } catch (e) {
      console.error(`Erro ao checar pendência Vistocar [movementId ${row.movement_id}]:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (rows.length) console.log(`✅ Pendências Vistocar: ${rows.length} verificadas, ${entregues} entregues, ${cancelled} canceladas`);
  return { verificadas: rows.length, entregues, cancelled };
}

// ── Aviso de saldo baixo no portaldespachantes.online ────────────────────────
// A conta é pré-paga: sem saldo, TODA consulta que fala com o portal para de
// funcionar de uma vez (é a maior parte do catálogo). O dono acompanha o saldo
// de perto e repõe; este aviso é a rede de segurança para quando ele estiver
// longe do painel.
const SALDO_PORTAL_MINIMO = 130.00;
// Enquanto o saldo seguir abaixo do mínimo, repete o aviso neste intervalo em
// vez de mandar um a cada execução do cron — que roda de hora em hora.
const SALDO_ALERTA_INTERVALO_HORAS = 6;

async function consultarSaldoPortal() {
  const r = await fetch(`${PORTAL_BASE_URL}/api/consumo`, {
    headers: { 'chaveAcesso': PORTAL_DESP_KEY },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ao consultar o consumo do portal.`);
  const d = await r.json().catch(() => null);
  const saldo = Number(d?.saldo);
  // Saldo ausente ou não numérico é resposta inesperada: melhor falhar alto do
  // que tratar como zero e disparar alarme falso.
  if (!Number.isFinite(saldo)) throw new Error('Resposta do portal sem o campo "saldo".');
  return { saldo, consumo: d?.consumo || null };
}

// Troca atômica na mesma tabela do broadcast (canal + ultimo_envio): garante um
// aviso por intervalo mesmo se a Vercel executar o cron duas vezes.
async function reservarAlertaSaldo() {
  const r = await pool.query(
    `INSERT INTO broadcast_agenda (canal, ultimo_envio) VALUES ($1, NOW())
     ON CONFLICT (canal) DO UPDATE SET ultimo_envio = NOW()
      WHERE broadcast_agenda.ultimo_envio <= NOW() - make_interval(hours => $2)
     RETURNING ultimo_envio`,
    ['saldo-portal', SALDO_ALERTA_INTERVALO_HORAS]
  );
  return r.rowCount > 0;
}

async function runSaldoPortalCheck() {
  const { saldo, consumo } = await consultarSaldoPortal();
  const fmt = v => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

  if (saldo > SALDO_PORTAL_MINIMO) {
    // Voltou a ficar acima do mínimo: libera o próximo aviso para sair assim
    // que cair de novo, sem esperar o intervalo.
    await pool.query(
      `UPDATE broadcast_agenda SET ultimo_envio = NOW() - make_interval(hours => $1)
        WHERE canal = 'saldo-portal'`,
      [SALDO_ALERTA_INTERVALO_HORAS]
    ).catch(() => {});
    return { saldo, alertado: false, motivo: 'saldo acima do mínimo' };
  }

  if (!await reservarAlertaSaldo())
    return { saldo, alertado: false, motivo: 'já avisado nas últimas horas' };

  const msg = [
    `⚠️ *Saldo baixo no Portal Despachantes*`,
    ``,
    `💰 *Saldo atual:* ${fmt(saldo)}`,
    `📉 *Mínimo configurado:* ${fmt(SALDO_PORTAL_MINIMO)}`,
    ...(consumo ? [
      ``,
      `📊 *Consumo do mês:* ${consumo.consultas} consultas (${fmt(consumo.valor)})`,
      `❌ *Com erro:* ${consumo.consultasComErro}`,
    ] : []),
    ``,
    `Sem saldo, as consultas que passam pelo portal param de funcionar.`,
  ].join('\n');
  await sendWhatsApp(ADMIN_PHONE, msg).catch(() => {});
  console.log(`⚠️  Aviso de saldo baixo enviado: ${fmt(saldo)}`);
  return { saldo, alertado: true };
}

// ── GET /api/cron/saldo-portal (Vercel Cron — de hora em hora) ───────────────
app.get('/api/cron/saldo-portal', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    res.json({ success: true, ...(await runSaldoPortalCheck()) });
  } catch (err) {
    console.error('Erro no cron de saldo do portal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/saldo-portal (consulta manual pelo admin) ────────────────
// Devolve o saldo na hora, sem depender do gatilho.
app.post('/api/admin/saldo-portal', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    res.json({ success: true, minimo: SALDO_PORTAL_MINIMO, ...(await consultarSaldoPortal()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/crlv-agendado-status (Vercel Cron) ──────────────────────────
app.get('/api/cron/crlv-agendado-status', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runCrlvAgendadoPendingCheck();
    const vistocar = await runVistocarPendingCheck();
    // Assinatura Digital pega carona no mesmo cron: é entrega de documento
    // pendente igual às outras duas, e não compensa um agendamento próprio.
    // Falha aqui não pode derrubar as entregas acima, que já rodaram.
    let assinafy = null;
    try { assinafy = await runAssinafyPendingCheck(); }
    catch (e) { console.error('Erro na checagem de assinaturas pendentes:', e.message); assinafy = { erro: e.message }; }
    res.json({ success: true, ...result, vistocar, assinafy });
  } catch (err) {
    console.error('Erro no cron crlv-agendado-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/crlv-agendado-status-check (teste manual pelo admin) ─────
app.post('/api/admin/crlv-agendado-status-check', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runCrlvAgendadoPendingCheck();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro na checagem manual CRLV-e Agendado:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Iniciar ───────────────────────────────────────────────────────────────────
// require.main === module → true quando rodado diretamente (node server.js)
//                         → false quando importado pelo Vercel
if (require.main === module) {
  initDB()
    .then(() => app.listen(PORT, () =>
      console.log(`🚀 Servidor rodando em http://localhost:${PORT}`)
    ))
    .catch((err) => {
      console.error('❌ Falha ao inicializar banco:', err.message);
      process.exit(1);
    });
} else {
  // Vercel serverless: inicializa o banco no cold start e exporta o app
  // (via ensureDbReady, para que quem precisar possa aguardar a mesma promise)
  ensureDbReady().catch((err) => console.error('Erro DB:', err.message));
}

module.exports = app;
