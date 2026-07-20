require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-inseguro';
const CHAVE_ACESSO = process.env.CHAVE_ACESSO || '';
const BASE_API_URL = 'https://chekaki.online';
const MARKUP = 1.40;
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '')
  .split('').filter(c => c.charCodeAt(0) <= 127).join('').trim();
const MP_BASE = 'https://api.mercadopago.com';
const AUTOCRLV_KEY    = process.env.AUTOCRLV_KEY    || '';
const PORTAL_DESP_KEY = process.env.PORTAL_DESP_KEY || '';
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

async function sendWhatsApp(phone, message) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !phone) return false;
  const digits = phone.replace(/\D/g, '');
  const formatted = digits.startsWith('55') ? digits : `55${digits}`;
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
  const digits = phone.replace(/\D/g, '');
  const formatted = digits.startsWith('55') ? digits : `55${digits}`;
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
    throw new Error(msg);
  }
  return data;
}

const SERVICES = [
  // ── Consultas Básicas ──
  { id:'base-estadual',          name:'Base Estadual',              group:'Consultas Básicas', basePrice:7.00,   inputType:'placa',       icon:'🚗' },
  { id:'base-nacional',          name:'Base Nacional',              group:'Consultas Básicas', basePrice:7.00,   inputType:'placa',       icon:'🗺️' },
  { id:'consulta-cautelar',      name:'Consulta Cautelar VIP GOLD', group:'Consultas Básicas', basePrice:19.99,  inputType:'placa',       icon:'🔍' },
  { id:'consultar-autovistoria', name:'Auto Quilometragem',         group:'Consultas Básicas', basePrice:7.50,   inputType:'placa',       icon:'⚡' },
  { id:'consultar-placa-v2',     name:'Proprietário Atual (v2)',    group:'Consultas Básicas', basePrice:7.50,   inputType:'placa',       icon:'🔍' },
  { id:'consultar-placa-v3',     name:'Consulta Placa v3',          group:'Consultas Básicas', basePrice:7.50,   inputType:'placa_uf',    icon:'🔍' },
  { id:'consultar-placa-fipe',   name:'Consulta FIPE',              group:'Consultas Básicas', basePrice:0.00,   inputType:'placa',       icon:'💰' },
  { id:'consultar-foto-leilao',  name:'Foto Leilão',                group:'Consultas Básicas', basePrice:10.00,  inputType:'placa',       icon:'📸' },
  { id:'consultar-chassi-v2',    name:'Consulta Chassi',            group:'Consultas Básicas', basePrice:7.50,   inputType:'chassi',      icon:'🔑' },
  { id:'consultar-cnh',          name:'Consultar CNH',              group:'Consultas Básicas', basePrice:11.43,  inputType:'cpfcnpj',     icon:'🪪' },
  // API Datacube (form-urlencoded) — valor fixo de R$3,00, ver bloco dc-decodificar-motor em /api/query.
  { id:'dc-decodificar-motor',   name:'Decodificação de Motor',     group:'Consultas Básicas', basePrice:3.00,   noMarkup:true, inputType:'motor', icon:'🔧', dcPath:'/veiculos/decodificar-motor' },
  // ── Débitos e Documentação ──
  { id:'consulta-debitos-portal',          name:'Consulta de Débitos',          group:'Débitos e Documentação', basePrice:1.0714, inputType:'placa',       icon:'💳' },
  { id:'consultar-licenciamento',         name:'Licenciamento + BIN',          group:'Débitos e Documentação', basePrice:10.00, inputType:'placa',        icon:'📋' },
  { id:'consultar-gravame',               name:'Consulta Gravame',             group:'Débitos e Documentação', basePrice:7.50,  inputType:'placa',        icon:'🏦' },
  { id:'consultar-historico-proprietario',name:'Histórico de Proprietários',   group:'Débitos e Documentação', basePrice:9.99,  inputType:'placa',        icon:'👥' },
  { id:'renajud',                         name:'RENAJUD',                      group:'Débitos e Documentação', basePrice:9.50,  inputType:'placa',        icon:'⚖️' },
  { id:'consultar-atpve',                 name:'Reemissão ATPV-e (Chassi)',    group:'Débitos e Documentação', basePrice:13.50, inputType:'chassi',       icon:'📄' },
  { id:'consultar-atpve-v1',             name:'Reemissão ATPV-e (Placa)',     group:'Débitos e Documentação', basePrice:13.50, inputType:'placa_renavam', icon:'📄' },
  { id:'consultar-Numero-ATPVE',          name:'Número ATPV-E',                group:'Débitos e Documentação', basePrice:25.00, inputType:'placa',        icon:'🔢' },
  { id:'consultar-comunicado',            name:'Consulta Comunicado',          group:'Débitos e Documentação', basePrice:7.50,  inputType:'placa_renavam',icon:'📝' },
  // ── CRLV-e Digital (instantâneo) ──
  { id:'consultar-crlv-ac', name:'CRLV-e Acre (AC)',               group:'CRLV-e Digital', basePrice:20.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ap', name:'CRLV-e Amapá (AP)',              group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ba', name:'CRLV-e Bahia (BA)',              group:'CRLV-e Digital', basePrice:20.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-go', name:'CRLV-e Goiás (GO)',              group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ma', name:'CRLV-e Maranhão (MA)',           group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-mg', name:'CRLV-e Minas Gerais (MG)',       group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ms', name:'CRLV-e Mato Grosso do Sul (MS)',group:'CRLV-e Digital', basePrice:15.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-mt', name:'CRLV-e Mato Grosso (MT)',        group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-pi', name:'CRLV-e Piauí (PI)',              group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-pr', name:'CRLV-e Paraná (PR)',             group:'CRLV-e Digital', basePrice:15.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-ro', name:'CRLV-e Rondônia (RO)',           group:'CRLV-e Digital', basePrice:20.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-rr', name:'CRLV-e Roraima (RR)',            group:'CRLV-e Digital', basePrice:30.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-se', name:'CRLV-e Sergipe (SE)',            group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-sp', name:'CRLV-e São Paulo (SP)',          group:'CRLV-e Digital', basePrice:15.00, inputType:'placa_renavam_cpf', icon:'📄' },
  { id:'consultar-crlv-to', name:'CRLV-e Tocantins (TO)',          group:'CRLV-e Digital', basePrice:10.00, inputType:'placa_renavam_cpf', icon:'📄' },
  // ── CRLV-e Agendado (assíncrono) ──
  { id:'crlv-agendado-al', name:'CRLV-e Agendado Alagoas (AL)',            group:'CRLV-e Agendado', basePrice:28.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'al' },
  { id:'crlv-agendado-ce', name:'CRLV-e Agendado Ceará (CE)',              group:'CRLV-e Agendado', basePrice:38.50,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'ce' },
  { id:'crlv-agendado-df', name:'CRLV-e Agendado Distrito Federal (DF)',   group:'CRLV-e Agendado', basePrice:38.50,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'df' },
  { id:'crlv-agendado-es', name:'CRLV-e Agendado Espírito Santo (ES)',     group:'CRLV-e Agendado', basePrice:20.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'es' },
  { id:'crlv-agendado-pb', name:'CRLV-e Agendado Paraíba (PB)',            group:'CRLV-e Agendado', basePrice:35.00,  inputType:'crlv_agendado_cpf',   icon:'⏳', uf:'pb' },
  { id:'crlv-agendado-pe', name:'CRLV-e Agendado Pernambuco (PE)',         group:'CRLV-e Agendado', basePrice:75.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'pe' },
  { id:'crlv-agendado-pr', name:'CRLV-e Agendado Paraná (PR)',             group:'CRLV-e Agendado', basePrice:15.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'pr' },
  { id:'crlv-agendado-rj', name:'CRLV-e Agendado Rio de Janeiro (RJ)',     group:'CRLV-e Agendado', basePrice:10.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'rj' },
  { id:'crlv-agendado-rj-reemissao', name:'Reemissão Crlv-e Rio de Janeiro (RJ)', group:'CRLV-e Agendado', basePrice:90.00, inputType:'placa', icon:'⏳', uf:'rj', noMarkup:true },
  { id:'crlv-agendado-rn', name:'CRLV-e Agendado Rio Grande do Norte (RN)',group:'CRLV-e Agendado', basePrice:55.00,  inputType:'crlv_agendado_cpf',   icon:'⏳', uf:'rn' },
  { id:'crlv-agendado-sc', name:'CRLV-e Agendado Santa Catarina (SC)',     group:'CRLV-e Agendado', basePrice:60.00,  inputType:'crlv_agendado_placa', icon:'⏳', uf:'sc' },
  { id:'crlv-agendado-status', name:'CRLV Agendado — Ver Status',          group:'CRLV-e Agendado', basePrice:0.00,   inputType:'pedido_id_get',       icon:'🔄' },
  // ── CRV ──
  { id:'consultar-crv-v2',   name:'Código Segurança CRV (PDF)', group:'CRV', basePrice:6.50,  inputType:'placa',      icon:'🔐' },
  { id:'consultar-placa-crv',name:'Placa + CRV (JSON+PDF)',     group:'CRV', basePrice:10.50, inputType:'placa',      icon:'🔐' },
  { id:'valida-crv',         name:'Valida CRV',                 group:'CRV', basePrice:0.00,  inputType:'valida_crv', icon:'✅' },
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
  { id:'crv-antigo-rio', name:'Consulta CRV antigo Rio', group:'Número CRV (Apenas antigos)', basePrice:500.00, inputType:'placa', icon:'📁', uf:'rj', noMarkup:true },
  { id:'crv-antigo-ce', name:'Consulta CRV antigo CE', group:'Número CRV (Apenas antigos)', basePrice:55.00,  inputType:'placa', icon:'📁', uf:'ce' },
  { id:'crv-antigo-ba', name:'Consulta CRV antigo BA', group:'Número CRV (Apenas antigos)', basePrice:199.99, inputType:'placa', icon:'📁', uf:'ba' },
  { id:'crv-antigo-sp', name:'Consulta CRV antigo SP', group:'Número CRV (Apenas antigos)', basePrice:139.99, inputType:'placa', icon:'📁', uf:'sp' },
  { id:'crv-antigo-rn', name:'Consulta CRV antigo RN', group:'Número CRV (Apenas antigos)', basePrice:150.00, inputType:'placa', icon:'📁', uf:'rn' },
  { id:'crv-antigo-pe', name:'Consulta CRV antigo PE', group:'Número CRV (Apenas antigos)', basePrice:100.00, inputType:'placa', icon:'📁', uf:'pe' },
  { id:'crv-antigo-pb', name:'Consulta CRV antigo PB', group:'Número CRV (Apenas antigos)', basePrice:79.99,  inputType:'placa', icon:'📁', uf:'pb' },
  { id:'crv-antigo-mg', name:'Consulta CRV antigo MG', group:'Número CRV (Apenas antigos)', basePrice:169.99, inputType:'placa', icon:'📁', uf:'mg' },
  { id:'crv-antigo-es', name:'Consulta CRV antigo ES', group:'Número CRV (Apenas antigos)', basePrice:450.00, inputType:'placa', icon:'📁', uf:'es', noMarkup:true },
  { id:'crv-antigo-al', name:'Consulta CRV antigo AL', group:'Número CRV (Apenas antigos)', basePrice:420.00, inputType:'placa', icon:'📁', uf:'al', noMarkup:true },
  { id:'crv-antigo-am', name:'Consulta CRV antigo AM', group:'Número CRV (Apenas antigos)', basePrice:462.00, inputType:'placa', icon:'📁', uf:'am', noMarkup:true },
  { id:'crv-antigo-df', name:'Consulta CRV antigo DF', group:'Número CRV (Apenas antigos)', basePrice:392.00, inputType:'placa', icon:'📁', uf:'df', noMarkup:true },
  { id:'crv-antigo-go', name:'Consulta CRV antigo GO', group:'Número CRV (Apenas antigos)', basePrice:532.00, inputType:'placa', icon:'📁', uf:'go', noMarkup:true },
  { id:'crv-antigo-ms', name:'Consulta CRV antigo MS', group:'Número CRV (Apenas antigos)', basePrice:532.00, inputType:'placa', icon:'📁', uf:'ms', noMarkup:true },
  { id:'crv-antigo-mt', name:'Consulta CRV antigo MT', group:'Número CRV (Apenas antigos)', basePrice:532.00, inputType:'placa', icon:'📁', uf:'mt', noMarkup:true },
  { id:'crv-antigo-pa', name:'Consulta CRV antigo PA', group:'Número CRV (Apenas antigos)', basePrice:392.00, inputType:'placa', icon:'📁', uf:'pa', noMarkup:true },
  { id:'crv-antigo-pr', name:'Consulta CRV antigo PR', group:'Número CRV (Apenas antigos)', basePrice:392.00, inputType:'placa', icon:'📁', uf:'pr', noMarkup:true },
  { id:'crv-antigo-ro', name:'Consulta CRV antigo RO', group:'Número CRV (Apenas antigos)', basePrice:406.00, inputType:'placa', icon:'📁', uf:'ro', noMarkup:true },
  { id:'crv-antigo-rr', name:'Consulta CRV antigo RR', group:'Número CRV (Apenas antigos)', basePrice:490.00, inputType:'placa', icon:'📁', uf:'rr', noMarkup:true },
  { id:'crv-antigo-se', name:'Consulta CRV antigo SE', group:'Número CRV (Apenas antigos)', basePrice:448.00, inputType:'placa', icon:'📁', uf:'se', noMarkup:true },
  { id:'crv-antigo-to', name:'Consulta CRV antigo TO', group:'Número CRV (Apenas antigos)', basePrice:350.00, inputType:'placa', icon:'📁', uf:'to', noMarkup:true },
  { id:'crv-antigo-sc', name:'Consulta CRV antigo SC', group:'Número CRV (Apenas antigos)', basePrice:600.00, inputType:'placa', icon:'📁', uf:'sc', noMarkup:true },
  // ── Intenção de Venda (ATPVE) — processamento manual: cliente envia os 4 documentos +
  // endereço com CEP, admin baixa tudo em página dedicada e devolve o PDF final por upload ──
  { id:'intencao-venda-rj', name:'Intenção de Venda RJ', group:'Intenção de Venda (ATPVE)', basePrice:70.00, noMarkup:true, inputType:'intencao_venda', icon:'📝', uf:'rj' },
  { id:'intencao-venda-mg', name:'Intenção de Venda MG', group:'Intenção de Venda (ATPVE)', basePrice:50.00, noMarkup:true, inputType:'intencao_venda', icon:'📝', uf:'mg' },
];

// Serviços desta categoria (mais a Reemissão CRLV-e RJ) não retornam resultado na hora:
// o pedido fica pendente até o super admin subir o PDF manualmente (ver
// /api/admin/manual-queries).
const MANUAL_UPLOAD_GROUP = 'Número CRV (Apenas antigos)';
const INTENCAO_VENDA_SERVICE_IDS = ['intencao-venda-rj', 'intencao-venda-mg'];
const MANUAL_SERVICE_IDS  = [...SERVICES.filter(s => s.group === MANUAL_UPLOAD_GROUP).map(s => s.id), 'crlv-agendado-rj-reemissao', ...INTENCAO_VENDA_SERVICE_IDS];

// ── SERVICES_V2 — API Datacube (api.consultasdeveiculos.com) ──────────────────
// Catálogo completamente separado do SERVICES/autocrlv/chekaki acima. Preços em
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
  { id:'dc-cadastro-localizacao-cpf', name:'Localização CPF',           group:'Cadastros', basePrice:1.381, inputType:'dc_cpf',      icon:'🗂️', dcPath:'/pessoas/localizacao' },
  { id:'dc-cadastro-localizacao-v3',  name:'Localização CPF V3',        group:'Cadastros', basePrice:2.844, inputType:'dc_cpf',      icon:'🗂️', dcPath:'/pessoas/localizacao_v3' },
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

  // ── Comunicação de Venda — preços com o mesmo MARKUP (40%) do resto do sistema ──
  { id:'dc-comunicado-venda',           name:'Comunicação de Venda',           group:'Comunicação de Venda', basePrice:39.063, inputType:'dc_comunicado_venda',           icon:'📤', dcPath:'/veiculos/comunicado_venda_v2' },
  { id:'dc-comunicado-venda-cancelar',  name:'Cancelar Comunicação de Venda',  group:'Comunicação de Venda', basePrice:0.000,  inputType:'dc_cancelar_comunicado_venda',  icon:'📤', dcPath:'/veiculos/cancelar_comunicado_venda_v2' },
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
// chekaki/autocrlv/Datacube.
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intencao_venda_files (
      id         SERIAL PRIMARY KEY,
      query_id   INTEGER UNIQUE REFERENCES queries(id) ON DELETE CASCADE,
      files      JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
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
  console.log('✅ Tabelas prontas');
}

// ── Middlewares ──────────────────────────────────────────────────────────────
// Limite elevado para acomodar o envio de Intenção de Venda (4 documentos em base64
// numa única requisição — fotos de RG/CNH tiradas do celular somam bem mais que 1 PDF).
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname), { etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

// ── Helpers ──────────────────────────────────────────────────────────────────
const cleanDoc = (v) => v.replace(/[\.\-\/]/g, '').trim();

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

async function requireSuperAdmin(req, res, next) {
  try {
    const r = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length || !SUPER_ADMIN_EMAILS.includes(r.rows[0].email))
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

async function requireApiKey(req, res, next) {
  const raw = (req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
  if (!raw || !raw.startsWith('mcd_'))
    return res.status(401).json({ error: 'Chave de API ausente. Envie no header X-API-Key ou Authorization: Bearer mcd_...' });
  try {
    const r = await pool.query(
      `SELECT k.id AS key_id, u.id AS user_id, u.active, u.name, u.email
         FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash=$1 AND k.active=true`,
      [hashApiKey(raw)]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Chave de API inválida ou revogada.' });
    if (!r.rows[0].active) return res.status(403).json({ error: 'Conta bloqueada.' });
    req.apiKey  = { id: r.rows[0].key_id };
    req.apiUser = { id: r.rows[0].user_id, name: r.rows[0].name, email: r.rows[0].email };
    pool.query('UPDATE api_keys SET last_used_at=NOW() WHERE id=$1', [r.rows[0].key_id]).catch(() => {});
    next();
  } catch (e) {
    console.error('Erro em requireApiKey:', e.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, cpf_cnpj, email, phone, password, role, referral_code } = req.body;

  if (!name || !cpf_cnpj || !email || !password)
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });

  if (password.length < 8)
    return res.status(400).json({ error: 'A senha deve ter ao menos 8 caracteres.' });

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
      'SELECT id, name, email, phone, role, credits, affiliate_code FROM users WHERE id=$1',
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

  if (!name || !cpf_cnpj || !email || !password)
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'A senha deve ter ao menos 8 caracteres.' });

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
app.get('/api/services', requireAuth, (req, res) => {
  res.json({
    services: SERVICES.map(s => ({
      ...s,
      price: parseFloat((s.basePrice * (s.noMarkup ? 1 : MARKUP)).toFixed(2)),
    })),
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
      price: parseFloat((s.basePrice * (s.noMarkup ? 1 : MARKUP)).toFixed(2)),
    })),
  });
});

// ── GET /api/services-v2 (catálogo Datacube — aba "Opção 2 Nova Consulta") ────
app.get('/api/services-v2', requireAuth, (req, res) => {
  res.json({
    services: SERVICES_V2.map(s => ({
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
    res.json({
      credits:       parseFloat(userRow.rows[0].credits),
      month_spent:   parseFloat(monthRow.rows[0].total),
      total_spent:   parseFloat(totalRow.rows[0].total),
      total_queries: parseInt(countRow.rows[0].total),
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
      `SELECT pdf_data FROM pdf_cache
       WHERE token=$1 AND user_id=$2 AND expires_at > NOW()`,
      [req.params.token, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'PDF não encontrado ou expirado.' });
    const buf = Buffer.from(r.rows[0].pdf_data, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="consulta-${req.params.token.slice(0,8)}.pdf"`);
    return res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// Algumas APIs upstream (ex.: chekaki.online) aninham o motivo real do erro em
// `details.details.msg` em vez de expor no nível raiz — desce a cadeia de
// `details` para achar a mensagem mais específica disponível.
function extractApiErrorMsg(data) {
  let msg = data?.error || data?.message || data?.msg;
  let current = data;
  while (current?.details && typeof current.details === 'object') {
    current = current.details;
    msg = current?.msg || current?.message || current?.error || msg;
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

      pdfReportHeader(doc, 'COMUNICAÇÃO DE VENDA', now);

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

// ── POST /api/query ───────────────────────────────────────────────────────────
app.post('/api/query', requireAuth, async (req, res) => {
  const { serviceId, params } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Serviço não informado.' });

  const service = SERVICES.find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });

  if (INTENCAO_VENDA_SERVICE_IDS.includes(serviceId)) {
    const files = params?.files || {};
    const required = ['atpve', 'cod_seguranca', 'doc_vendedor', 'doc_comprador'];
    const missing = required.filter(k => !files[k]?.data);
    if (missing.length)
      return res.status(400).json({ error: 'Envie os 4 documentos obrigatórios: ATPVE, Código de Segurança, RG/CPF/CNH do Vendedor e do Comprador.' });
    if (!params?.endereco || !String(params.endereco).trim())
      return res.status(400).json({ error: 'Informe o endereço com CEP.' });
  }

  const price = parseFloat((service.basePrice * (service.noMarkup ? 1 : MARKUP)).toFixed(2));

  try {
    const ur = await pool.query(
      'SELECT credits, active, phone, name, email FROM users WHERE id=$1', [req.user.id]
    );
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    if (parseFloat(user.credits) < price)
      return res.status(400).json({
        error: `Saldo insuficiente. Necessário: R$ ${price.toFixed(2).replace('.', ',')}`,
      });

    // ── Serviços manuais (upload de arquivo pelo super admin — resultado não vem na hora) ──
    if (MANUAL_SERVICE_IDS.includes(serviceId)) {
      const isIntencaoVenda = INTENCAO_VENDA_SERVICE_IDS.includes(serviceId);
      // Para Intenção de Venda os 4 documentos ficam em intencao_venda_files (tabela à parte);
      // queries.params guarda só o endereço, para não carregar base64 pesado em toda listagem.
      const storedParams = isIntencaoVenda ? { endereco: String(params.endereco).trim() } : (params || {});

      await pool.query('UPDATE users SET credits = credits - $1 WHERE id=$2', [price, req.user.id]);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [req.user.id, price, `Consulta: ${service.name}`]
      );
      const qRow = await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'pendente',$5,$6,'pdf') RETURNING id`,
        [req.user.id, serviceId, service.name, JSON.stringify(storedParams), price, txRow.rows[0].id]
      );

      if (isIntencaoVenda) {
        const f = params.files;
        await pool.query(
          `INSERT INTO intencao_venda_files (query_id, files) VALUES ($1,$2)`,
          [qRow.rows[0].id, JSON.stringify({
            atpve:            f.atpve,
            cod_seguranca:    f.cod_seguranca,
            doc_vendedor:     f.doc_vendedor,
            doc_comprador:    f.doc_comprador,
            contrato_social:  f.contrato_social || null,
          })]
        );
      }

      await notifyAdminNewQuery(user, service, price, params);
      return res.json({
        success: true,
        pending: true,
        result: { status: 'Pedido registrado! Nossa equipe vai localizar o documento e o PDF ficará disponível para download aqui no seu painel.' },
        charged: price,
      });
    }

    // Build URL and method
    let apiUrl = `${BASE_API_URL}/${serviceId}`;
    let method = 'POST';
    let body = params || {};

    // CRLV Agendado: solicitar (demais UFs)
    if (serviceId.startsWith('crlv-agendado-') && serviceId !== 'crlv-agendado-status') {
      const svcDef = SERVICES.find(s => s.id === serviceId);
      apiUrl = `${BASE_API_URL}/api/crlv-agendado/solicitar`;
      body = { ...params, uf: svcDef?.uf || params.uf };
    }
    // CRLV Agendado: verificar status
    if (serviceId === 'crlv-agendado-status' && params?.pedido_id) {
      const pid = String(params.pedido_id).trim();
      if (pid.startsWith('AUTOCRLV-')) {
        const code = pid.slice('AUTOCRLV-'.length);
        apiUrl = `https://autocrlv.com.br/cliente/api_integracao_crlv_agendado_status.php?code=${encodeURIComponent(code)}`;
      } else {
        apiUrl = `${BASE_API_URL}/api/crlv-agendado/${pid}`;
      }
      method = 'GET'; body = null;
    }
    // Comunicado venda por ID (GET)
    if (serviceId === 'com-venda-por-id' && params?.id) {
      apiUrl = `${BASE_API_URL}/api/comunicado-venda/${params.id}`;
      method = 'GET'; body = null;
    }
    // Comunicado venda desbloquear
    if (serviceId === 'com-venda-desbloquear') {
      apiUrl = `${BASE_API_URL}/api/comunicado-venda/desbloquear`;
    }
    // Transmitir comunicação de venda
    if (serviceId === 'venda-transmitir' && params?.id) {
      apiUrl = `${BASE_API_URL}/comunicacao-venda/transmitir/${params.id}`;
      body = {};
    }
    // Motivos cancelamento
    if (serviceId === 'motivos-cancelamento' && params?.protocolo) {
      apiUrl = `${BASE_API_URL}/motivos-cancelamento/${params.protocolo}`;
      method = 'GET'; body = null;
    }
    // Inserir comunicação de venda — a API exige id/numero_via/cidade/valor como número
    // JSON (não string) e rejeita com erro genérico ("Dados incompletos.") quando o tipo
    // não bate, então validamos e convertemos aqui antes de repassar.
    if (serviceId === 'inserir-comunicacao-venda') {
      const v    = params?.vendedor  || {};
      const c    = params?.comprador || {};
      const end  = c.endereco        || {};
      const vda  = params?.venda     || {};
      const veic = params?.veiculo   || {};
      const crv  = veic.crv          || {};

      // Regras abaixo replicadas do próprio formulário do CHEKAKI (montarPayloadDoFormulario
      // / coletarErrosPayload em chekaki.online/comunicacao-venda), inspecionado após o
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

      if (placa.length !== 7)                        return res.status(400).json({ error: 'Placa do veículo inválida. Deve ter 7 caracteres (sem hífen).' });
      if (renavam.length !== 11)                      return res.status(400).json({ error: 'Renavam inválido. Deve ter até 11 dígitos.' });
      if (!Number.isInteger(anoFabricacao) || anoFabricacao < 1950) return res.status(400).json({ error: 'Ano de fabricação do veículo inválido.' });
      if (!Number.isInteger(anoModelo) || anoModelo < 1950)          return res.status(400).json({ error: 'Ano do modelo do veículo inválido.' });
      if (vDoc.length !== 11 && vDoc.length !== 14)   return res.status(400).json({ error: 'CPF/CNPJ do vendedor inválido. Informe 11 dígitos (CPF) ou 14 dígitos (CNPJ).' });
      if (cDoc.length !== 11 && cDoc.length !== 14)   return res.status(400).json({ error: 'CPF/CNPJ do comprador inválido. Informe 11 dígitos (CPF) ou 14 dígitos (CNPJ).' });
      if (!v.nome?.trim())                            return res.status(400).json({ error: 'Informe o nome do vendedor.' });
      if (!c.nome?.trim())                            return res.status(400).json({ error: 'Informe o nome do comprador.' });
      if (cep.length !== 8)                            return res.status(400).json({ error: 'CEP inválido. Deve ter 8 dígitos.' });
      if (!numeroResidencia || numeroResidencia.length > 6) return res.status(400).json({ error: 'Número do endereço do comprador inválido. Use só dígitos (máx. 6).' });
      if (Number.isNaN(cidadeComprador) || cidadeComprador <= 0) return res.status(400).json({ error: 'Código IBGE da cidade do comprador inválido.' });
      if (Number.isNaN(valor) || valor <= 0)          return res.status(400).json({ error: 'Valor da venda inválido.' });
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(vda.data || '')) return res.status(400).json({ error: 'Data da venda inválida. Use o formato DD/MM/AAAA.' });
      if (!Number.isInteger(numeroVia) || numeroVia < 1) return res.status(400).json({ error: 'Número da via do CRV inválido.' });
      if (numeroCrvRaw.length < 9 || numeroCrvRaw.length > 12) return res.status(400).json({ error: 'Número do CRV deve ter de 9 a 12 dígitos.' });
      if (codigoSeguranca.length !== 11)              return res.status(400).json({ error: 'Código de segurança do CRV deve ter 11 dígitos.' });
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(crv.data_emissao || '')) return res.status(400).json({ error: 'Data de emissão do CRV inválida. Use o formato DD/MM/AAAA.' });

      const vendedorPayload = vDoc.length === 14
        ? { tipo_pessoa: 'J', cnpj: vDoc, nome: v.nome.trim().toUpperCase() }
        : { tipo_pessoa: 'F', cpf: vDoc, nome: v.nome.trim().toUpperCase() };
      const compradorPayload = cDoc.length === 14
        ? { tipo_pessoa: 'J', cnpj: cDoc, nome: c.nome.trim().toUpperCase() }
        : { tipo_pessoa: 'F', cpf: cDoc, nome: c.nome.trim().toUpperCase() };

      // O ViaCEP às vezes devolve bairro/logradouro com parênteses (ex.: "Paracatu
      // (Morro Grande)"); removemos e uppercase para bater com o formulário real.
      const sanitizeAddr = s => (s || '').replace(/[()]/g, ' ').replace(/\s{2,}/g, ' ').trim().toUpperCase();

      body = {
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
    };
    if (PORTAL_PLACA_MAP[serviceId]) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `https://portaldespachantes.online/${PORTAL_PLACA_MAP[serviceId]}`;
      method = 'POST';
      body   = { placa };
    }
    // ATPV-e por chassi
    if (serviceId === 'consultar-atpve') {
      const chassi = (params?.chassi || '').toUpperCase().replace(/\s/g, '');
      if (chassi.length !== 17)
        return res.status(400).json({ error: 'Chassi deve ter exatamente 17 caracteres.' });
      body = { chassi };
    }
    // ATPV-e por placa + renavam → mesmo endpoint da nova API
    if (serviceId === 'consultar-atpve-v1') {
      const placa   = (params?.placa   || '').toUpperCase().replace(/\s|-/g, '');
      const renavam = (params?.renavam || '').replace(/\D/g, '');
      if (placa.length < 7)
        return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      if (renavam.length < 9 || renavam.length > 11)
        return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
      apiUrl = `${BASE_API_URL}/consultar-atpve`;
      body = { placa, renavam };
    }
    // CNH: converte cpfCnpj → cpf para a nova API
    if (serviceId === 'consultar-cnh') {
      body = { cpf: (params?.cpfCnpj || '').replace(/\D/g, '') };
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

    const isDatacubeForm = isDcDebito || isDcDividaAtiva || isDcCnh || isDcVeiculosDoc || isDcRouboFurto || isDcHistoricoProprietario || isDcHistoricoGravames || isDcLeilao || isDcConsulta0km || isDcBinEstadual || serviceId === 'dc-decodificar-motor';

    let fetchHeaders;
    if (isDatacubeForm) {
      fetchHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
    } else if (apiUrl.startsWith('https://autocrlv.com.br/cliente/api_integracao_crlv_agendado')) {
      fetchHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTOCRLV_KEY}` };
    } else if (PORTAL_PLACA_MAP[serviceId]) {
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY };
    } else {
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': CHAVE_ACESSO };
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
      return res.status(apiRes.status).json({ error: errMsg });
    }

    // Lê o corpo uma única vez
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
      }
    }

    // serviços que retornam JSON com pdf_base64
    const PDF_BASE64_SVCS = ['consultar-placa-crv', 'consultar-crv-v2', 'consulta-debitos-portal'];
    let base64PdfBuf = null;
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

    // Serviços que retornam HTML — capturado para servir via /api/html/:token
    let htmlBuf = null;

    // Serviços genéricos (não-PDF, não-HTML): recusa cobrar se a API não retornou
    // nenhum dado relevante (corpo vazio, JSON vazio/nulo ou com indicador de falha).
    let genericData = null, genericParseOk = false;
    const willBePdfOrHtml = isRealPdf || base64PdfBuf || htmlBuf || dcDebitoPdfBuf || dcMotorPdfBuf;
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

    // Inserir Comunicação Venda: o retorno de sucesso deixa de ser exibido como
    // JSON — monta o PDF do comprovante a partir do JSON retornado, no mesmo
    // padrão visual do relatório de Débitos por Estado.
    let vendaPdfBuf = null;
    if (serviceId === 'inserir-comunicacao-venda' && !willBePdfOrHtml && genericParseOk) {
      try {
        vendaPdfBuf = await buildComunicacaoVendaPdfBuffer(service, genericData, params);
      } catch (e) {
        console.error(`[${serviceId}] erro ao gerar PDF do comprovante:`, e.message);
        return res.status(500).json({ error: 'Erro ao gerar o PDF do comprovante.' });
      }
    }

    // ── Debita créditos somente após validar resposta ─────────────────────────
    await pool.query(
      'UPDATE users SET credits = credits - $1 WHERE id=$2', [price, req.user.id]
    );
    const txRow = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
      [req.user.id, price, `Consulta: ${service.name}`]
    );
    // Guarda o corpo JSON retornado (quando não é PDF/HTML) para o histórico poder
    // reexibir o mesmo resultado depois, sem precisar refazer (e recobrar) a consulta.
    const resultData = (willBePdfOrHtml || vendaPdfBuf) ? null : JSON.stringify(genericParseOk ? genericData : { resposta: bodyStr });
    const qRow = await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type, result_data)
       VALUES ($1,$2,$3,$4,'success',$5,$6,$7,$8) RETURNING id`,
      [req.user.id, serviceId, service.name, JSON.stringify(params || {}),
       price, txRow.rows[0].id,
       htmlBuf ? 'html' : (isRealPdf || base64PdfBuf || dcDebitoPdfBuf || dcMotorPdfBuf || vendaPdfBuf) ? 'pdf' : 'json',
       resultData]
    );
    await notifyAdminNewQuery(user, service, price, params);

    // ── Envia PDF + salva no cache por 7 dias ────────────────────────────────
    const pdfToSend = base64PdfBuf || (isRealPdf ? bodyBuffer : null) || dcDebitoPdfBuf || dcMotorPdfBuf || vendaPdfBuf;
    if (pdfToSend || htmlBuf) {
      const dataToCache = pdfToSend || htmlBuf;
      const token       = crypto.randomBytes(32).toString('hex');
      const expiresAt   = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, req.user.id, token, dataToCache.toString('base64'), expiresAt]
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
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${serviceId}-${Date.now()}.pdf"`);
        return res.send(pdfToSend);
      }
      return res.json({ success: true, result: { status: 'Relatório gerado com sucesso' }, charged: price, html_token: token });
    }

    if (genericParseOk) {
      const data = genericData;

      // WhatsApp para CRLV-e Agendado (não é verificação de status)
      if (serviceId.startsWith('crlv-agendado-') && serviceId !== 'crlv-agendado-status' && user.phone) {
        // Tenta múltiplos caminhos pois o endpoint /solicitar pode retornar estrutura variada
        const pedido = data?.pedido || data?.data?.pedido || {};
        const svcData = data?.servico || data?.data?.servico || {};
        const pedidoId = pedido.id ?? pedido.pedido_id ?? data?.id ?? data?.pedido_id ?? data?.data?.id ?? '-';
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
            `INSERT INTO crlv_agendado_pending (pedido_id, user_id, phone, service_id, uf, placa)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (pedido_id) DO NOTHING`,
            [String(pedidoId), req.user.id, user.phone, serviceId, uf, placa]
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
              const fullUrl = /^https?:\/\//i.test(pdfPath) ? pdfPath : 'https://chekaki.online' + pdfPath;
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

      return res.json({ success: true, result: data, charged: price });
    } else {
      return res.json({ success: true, result: { resposta: bodyStr }, charged: price });
    }
  } catch (err) {
    console.error('Erro em /api/query:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/query-v2 (API Datacube — aba "Opção 2 Nova Consulta") ───────────
// Fluxo isolado do /api/query: usa o mesmo saldo/tabelas do usuário, mas nunca
// toca em SERVICES, MANUAL_SERVICE_IDS ou nas integrações chekaki/autocrlv.
app.post('/api/query-v2', requireAuth, async (req, res) => {
  const { serviceId, params } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Serviço não informado.' });

  const service = SERVICES_V2.find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });

  const price = parseFloat((service.basePrice * (service.noMarkup ? 1 : MARKUP)).toFixed(2));

  try {
    const ur = await pool.query('SELECT credits, active FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    if (parseFloat(user.credits) < price)
      return res.status(400).json({
        error: `Saldo insuficiente. Necessário: R$ ${price.toFixed(2).replace('.', ',')}`,
      });

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

    await pool.query('UPDATE users SET credits = credits - $1 WHERE id=$2', [price, req.user.id]);
    const txRow = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
      [req.user.id, price, `Consulta: ${service.name} (Opção 2)`]
    );
    const resultV2 = apiData.result ?? apiData;
    await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type, result_data)
       VALUES ($1,$2,$3,$4,'success',$5,$6,'json',$7)`,
      [req.user.id, service.id, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id, JSON.stringify(resultV2)]
    );

    return res.json({ success: true, result: resultV2, charged: price });
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
    const ur = await pool.query('SELECT credits, active FROM users WHERE id=$1', [req.user.id]);
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    if (parseFloat(user.credits) < price)
      return res.status(400).json({
        error: `Saldo insuficiente. Necessário: R$ ${price.toFixed(2).replace('.', ',')}`,
      });

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

    await pool.query('UPDATE users SET credits = credits - $1 WHERE id=$2', [price, req.user.id]);
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
// Executa um serviço do catálogo Infosimples em nome de um cliente externo:
// mesma regra do /api/query-v3 (validar → consultar → só então debitar créditos
// da conta dona da chave), mas os parâmetros vêm no corpo raiz da requisição —
// não aninhados em "params" — para a integração do cliente ficar mais simples.
async function runExternalInfosimplesQuery(req, res, serviceId) {
  const service = SERVICES_V3.find(s => s.id === serviceId);
  if (!service) return res.status(500).json({ error: 'Serviço não configurado.' });

  const price  = parseFloat((service.basePrice * INFOSIMPLES_MARKUP).toFixed(2));
  const params = req.body || {};

  try {
    const ur = await pool.query('SELECT credits, active FROM users WHERE id=$1', [req.apiUser.id]);
    const user = ur.rows[0];
    if (!user || !user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    if (parseFloat(user.credits) < price)
      return res.status(402).json({
        error: `Saldo insuficiente. Necessário: R$ ${price.toFixed(2).replace('.', ',')}`,
      });

    const faltando = service.params
      .filter(p => p.required && !(params?.[p.name] ?? '').toString().trim())
      .map(p => p.name);
    if (faltando.length)
      return res.status(400).json({ error: `Campos obrigatórios ausentes: ${faltando.join(', ')}` });

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
      console.error(`Erro na API Infosimples [externo ${serviceId}]:`, e.message);
      return res.status(502).json({ error: 'Erro ao consultar a API. Tente novamente.' });
    }

    if (!apiData || apiData.code !== 200) {
      const errMsg = (apiData && (apiData.errors?.[0] || apiData.code_message)) || `Erro HTTP ${apiRes.status}.`;
      console.error(`Erro API Infosimples [externo ${serviceId}] code ${apiData?.code}: ${errMsg}`);
      return res.status(apiRes.status && apiRes.status >= 400 ? apiRes.status : 502).json({ error: errMsg });
    }

    const result = Array.isArray(apiData.data) ? (apiData.data[0] ?? {}) : (apiData.data ?? {});
    const label  = `${service.group} — ${service.name}`;

    await pool.query('UPDATE users SET credits = credits - $1 WHERE id=$2', [price, req.apiUser.id]);
    const txRow = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
      [req.apiUser.id, price, `Consulta: ${label} (API externa)`]
    );
    const qRow = await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type, result_data)
       VALUES ($1,$2,$3,$4,'success',$5,$6,'json',$7) RETURNING id`,
      [req.apiUser.id, service.id, label, JSON.stringify(params), price, txRow.rows[0].id, JSON.stringify(result)]
    );

    return res.json({ success: true, consulta_id: qRow.rows[0].id, servico: label, charged: price, result });
  } catch (err) {
    console.error(`Erro em API externa [${serviceId}]:`, err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

// DETRAN/MG — Registrar Intenção de Venda de Veículo
app.post('/api/v1/detran-mg/intencao-venda', requireApiKey, (req, res) =>
  runExternalInfosimplesQuery(req, res, 'is-detran-mg-reg-intencao-venda'));

// DETRAN/MG — Emitir ATPV-e
app.post('/api/v1/detran-mg/atpve', requireApiKey, (req, res) =>
  runExternalInfosimplesQuery(req, res, 'is-detran-mg-atpve'));

// ── Gestão de chaves de API (admin) ───────────────────────────────────────────
// A API é contratual (sem self-service, ver seção API da landing page): o admin
// cria a chave já vinculada à conta do cliente que será debitada nas consultas.
app.post('/api/admin/api-keys', requireAuth, requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.body?.user_id, 10);
  const label  = (req.body?.label || '').trim().slice(0, 100);
  if (!Number.isInteger(userId) || userId <= 0)
    return res.status(400).json({ error: 'Informe o user_id do cliente.' });
  try {
    const u = await pool.query('SELECT id, name, email FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const key = 'mcd_' + crypto.randomBytes(24).toString('hex');
    const r = await pool.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [userId, hashApiKey(key), key.slice(0, 12), label || null]
    );
    res.json({
      success: true,
      id: r.rows[0].id,
      api_key: key,
      user: u.rows[0],
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
        FROM api_keys k JOIN users u ON u.id = k.user_id
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
  const raw = (process.env.CHAVE_ACESSO || '');
  res.json({
    tamanho: raw.length,
    inicio: raw.slice(0, 10) + '...',
    fim: '...' + raw.slice(-6),
    temMaisOuBarra: raw.includes('+') || raw.includes('/'),
    charsInvalidos: raw.split('').filter(c => c.charCodeAt(0) > 127).length,
  });
});

// ── POST /api/pix/criar ───────────────────────────────────────────────────────
app.post('/api/pix/criar', requireAuth, async (req, res) => {
  const value = parseFloat(req.body.value);
  if (!value || value < 5 || value > 10000)
    return res.status(400).json({ error: 'Valor inválido. Mínimo R$ 5,00, máximo R$ 10.000,00.' });

  try {
    const ur = await pool.query(
      'SELECT id, name, email, cpf_cnpj FROM users WHERE id=$1',
      [req.user.id]
    );
    const user = ur.rows[0];
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
    res.status(500).json({ error: err.message || 'Erro ao criar cobrança PIX.' });
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
       WHERE gateway_id=$1 AND credited=false RETURNING id, user_id, value`,
      [gatewayId]
    );
    if (upd.rows.length === 0) {
      // Já creditado por outra chamada concorrente (ou pagamento desconhecido) — não repete.
      await client.query('ROLLBACK');
      const existing = await pool.query('SELECT value FROM pix_payments WHERE gateway_id=$1', [gatewayId]);
      return { credited: true, status: 'approved', alreadyCredited: true, value: existing.rows[0] ? parseFloat(existing.rows[0].value) : null };
    }
    const p = upd.rows[0];
    await client.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [p.value, p.user_id]);
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'deposit',$2,$3)`,
      [p.user_id, p.value, `Recarga PIX — R$ ${parseFloat(p.value).toFixed(2).replace('.', ',')}`]
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
    if (search) { conds.push(`(name ILIKE $${i} OR email ILIKE $${i} OR cpf_cnpj ILIKE $${i})`); vals.push(`%${search}%`); i++; }
    if (role)   { conds.push(`role=$${i}`);   vals.push(role); i++; }
    if (active !== '') { conds.push(`active=$${i}`); vals.push(active === 'true'); i++; }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT id,name,email,cpf_cnpj,phone,role,credits,active,created_at,affiliate_code
       FROM users ${where} ORDER BY created_at DESC LIMIT 500`, vals
    );
    res.json({ users: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: GET /api/admin/users/:id ──────────────────────────────────────────
app.get('/api/admin/users/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [u, q, t] = await Promise.all([
      pool.query('SELECT id,name,email,cpf_cnpj,phone,role,credits,active,created_at,affiliate_code FROM users WHERE id=$1', [req.params.id]),
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
  const { name, email, phone, role, credits } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'E-mail é obrigatório.' });
  if (!['user','reseller','admin'].includes(role)) return res.status(400).json({ error: 'Role inválido.' });
  const parsedCredits = parseFloat(credits);
  if (isNaN(parsedCredits)) return res.status(400).json({ error: 'Valor de créditos inválido.' });
  try {
    const r = await pool.query(
      `UPDATE users SET name=$1,email=$2,phone=$3,role=$4,credits=$5 WHERE id=$6
       RETURNING id,name,email,phone,role,credits,active`,
      [name.trim(), email.toLowerCase().trim(), phone?.trim()||null, role, parsedCredits, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-mail já está em uso por outro usuário.' });
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
    const r = await pool.query(
      `SELECT q.id,q.service_name,q.amount,q.result_type,q.created_at,
              u.name AS user_name,u.email AS user_email
       FROM queries q JOIN users u ON u.id=q.user_id
       ORDER BY q.created_at DESC LIMIT 500`
    );
    res.json({ queries: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
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
      whatsappSent = await sendWhatsAppPdf(query.phone, pdfBuf, `${query.service_id}-${query.id}.pdf`, caption).catch(() => false);
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
    const sent = await sendWhatsAppPdf(query.phone, pdfBuf, `${query.service_id}-${query.id}.pdf`, caption).catch(() => false);
    if (!sent) return res.status(502).json({ error: 'Falha ao reenviar pelo WhatsApp. Tente novamente.' });

    await pool.query(`UPDATE queries SET whatsapp_sent_at = NOW() WHERE id=$1`, [query.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro no reenvio manual de WhatsApp:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: GET /api/admin/intencao-venda/:uf (fila de "Intenção de Venda RJ/MG") ──
app.get('/api/admin/intencao-venda/:uf', requireAuth, requireSuperAdmin, async (req, res) => {
  const uf = String(req.params.uf || '').toLowerCase();
  const serviceId = `intencao-venda-${uf}`;
  if (!INTENCAO_VENDA_SERVICE_IDS.includes(serviceId))
    return res.status(400).json({ error: 'UF inválida.' });
  try {
    const r = await pool.query(
      `SELECT q.id, q.service_id, q.service_name, q.params, q.amount, q.status, q.created_at, q.whatsapp_sent_at,
              u.id AS user_id, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
       FROM queries q JOIN users u ON u.id = q.user_id
       WHERE q.service_id = $1
       ORDER BY (q.status = 'pendente') DESC, q.created_at DESC
       LIMIT 300`,
      [serviceId]
    );
    res.json({ queries: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: GET /api/admin/intencao-venda/:queryId/file/:slot (baixar 1 documento) ──
const INTENCAO_VENDA_SLOTS = ['atpve', 'cod_seguranca', 'doc_vendedor', 'doc_comprador', 'contrato_social'];
app.get('/api/admin/intencao-venda/:queryId/file/:slot', requireAuth, requireSuperAdmin, async (req, res) => {
  const { queryId, slot } = req.params;
  if (!INTENCAO_VENDA_SLOTS.includes(slot)) return res.status(400).json({ error: 'Documento inválido.' });
  try {
    const qr = await pool.query(`SELECT service_id FROM queries WHERE id=$1`, [queryId]);
    if (!qr.rows.length || !INTENCAO_VENDA_SERVICE_IDS.includes(qr.rows[0].service_id))
      return res.status(404).json({ error: 'Pedido não encontrado.' });

    const fr = await pool.query(`SELECT files FROM intencao_venda_files WHERE query_id=$1`, [queryId]);
    const file = fr.rows[0]?.files?.[slot];
    if (!file?.data) return res.status(404).json({ error: 'Arquivo não encontrado.' });

    const buf = Buffer.from(file.data, 'base64');
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Type', file.type || 'application/octet-stream');
    res.set('Content-Disposition', `${disposition}; filename="${(file.name || slot).replace(/"/g, '')}"`);
    res.send(buf);
  } catch (err) {
    console.error('Erro ao baixar documento de intenção de venda:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── ADMIN: GET /api/admin/intencao-venda/:queryId/messages (histórico do chat) ──
app.get('/api/admin/intencao-venda/:queryId/messages', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, message, created_at FROM query_messages WHERE query_id=$1 ORDER BY created_at ASC`,
      [req.params.queryId]
    );
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
});

// ── ADMIN: POST /api/admin/intencao-venda/:queryId/messages (enviar msg pro WhatsApp do usuário) ──
app.post('/api/admin/intencao-venda/:queryId/messages', requireAuth, requireSuperAdmin, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Digite uma mensagem.' });
  try {
    const qr = await pool.query(
      `SELECT q.id, q.service_id, u.phone
       FROM queries q JOIN users u ON u.id = q.user_id WHERE q.id=$1`,
      [req.params.queryId]
    );
    if (!qr.rows.length || !INTENCAO_VENDA_SERVICE_IDS.includes(qr.rows[0].service_id))
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    const query = qr.rows[0];
    if (!query.phone) return res.status(400).json({ error: 'Usuário sem telefone cadastrado.' });

    const whatsappSent = await sendWhatsApp(query.phone, message).catch(() => false);
    if (!whatsappSent) return res.status(502).json({ error: 'Falha ao enviar pelo WhatsApp. Tente novamente.' });

    const mr = await pool.query(
      `INSERT INTO query_messages (query_id, message) VALUES ($1,$2) RETURNING id, message, created_at`,
      [query.id, message]
    );
    res.json({ success: true, message: mr.rows[0] });
  } catch (err) {
    console.error('Erro ao enviar mensagem de intenção de venda:', err.message);
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

// ── Broadcast WhatsApp (disparo diário automático) ───────────────────────────
const BROADCAST_MESSAGE =
`🛑ATENÇÃO CADASTRE COM SEU NUMERO WHATSAPP CORRETO PARA RECEBER AS NOTIFICAÇÕES DO SITE, SE NAO TIVER RECEBENDO AS NOTIFICAÇÕES, VÁ EM PERFIL E ALTERE SEU NUMERO.

Precisa puxar a capivara do carro ou emitir a ATPV-e? Aqui é vapt-vupt:
✅ FAÇA SEU CADASTRO: ✅ PAGAMENTO INSTANTÂNEO: PIX QR, copia e Cola, na tela. ✅ Faça Carga via PIX no valor que quiser.


🔎 Nossos Serviços:

🛑Numero do CRV Antigo, das UFs: RJ, SP, MG, CE, ES, BA, RN, PE, PB, e outros, total de 21 UFs veja em seu painel🛑

Galera, minha plataforma está com preços melhores do que a TDI, cod segurança 9,10, reemissão de ATPVE 18,90, CRLV-e do Rio 14,00, reemissão CRVL-e Rio 110,00, o kit de códigos da ATPVE quando tem comunicação de venda, 35,00.
Olá! Quero te indicar a plataforma DESPACHANTES CONSULTAS — consultas veiculares e CRLV-e digital para profissionais.

🎁 Cadastre-se pelo meu link e ganhe R$ 10,00 de crédito grátis para usar na plataforma!

👉 https://www.despachantesconsultas.com.br/cadastrar?ref=MARCOTSN0

✅ Sem mensalidade. Pague só pelo que usar`;

// Envia broadcast apenas para grupos — envio para contatos individuais foi
// desativado por estar sendo denunciado como spam no WhatsApp.
// Grupos vêm da Z-API com isGroup:true e phone no formato "<id>-group"
// (não usam o sufixo "@g.us" do protocolo interno do WhatsApp).
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

  // Chave = ID único; valor = ID de grupo pronto para envio
  const destinations = new Map();

  for (let page = 1; page <= 5; page++) {
    const chatsRes = await fetch(`${base}/chats?page=${page}&pageSize=500`, { headers });
    if (!chatsRes.ok) { console.warn('⚠️  Z-API /chats falhou:', chatsRes.status); break; }
    const data = await chatsRes.json().catch(() => []);
    const list = Array.isArray(data) ? data : (data.value || data.chats || []);
    list.forEach(c => {
      const phone = String(c.phone || '');
      if (c.isGroup === true && phone) destinations.set(phone, phone);
    });
    if (list.length < 500) break;
  }
  console.log(`📋 Grupos: ${destinations.size}`);

  return [...destinations.values()];
}

// Envio para broadcast — sempre para IDs de grupo ("<id>-group")
async function sendBroadcastMessage(dest, message) {
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
    if (!r.ok) console.error(`Broadcast erro [${phone}]:`, JSON.stringify(d));
    else console.log(`✅ Broadcast → ${phone}`);
  } catch (err) {
    console.error(`Broadcast falha [${phone}]:`, err.message);
    throw err;
  }
}

async function runWhatsAppBroadcast() {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) throw new Error('Z-API não configurada');
  const dests = await fetchZApiDestinations();
  console.log(`📢 Broadcast: ${dests.length} grupos`);
  let sent = 0, failed = 0;
  for (const dest of dests) {
    try {
      await sendBroadcastMessage(dest, BROADCAST_MESSAGE);
      sent++;
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`✅ Broadcast concluído: ${sent} enviados, ${failed} falhas`);
  return { sent, failed, total: dests.length };
}

// ── GET /api/cron/broadcast-whatsapp (Vercel Cron — 8h BRT = 11h UTC) ────────
app.get('/api/cron/broadcast-whatsapp', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runWhatsAppBroadcast();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no cron broadcast:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/broadcast-whatsapp (teste manual pelo admin) ──────────────
app.post('/api/admin/broadcast-whatsapp', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await runWhatsAppBroadcast();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro no broadcast manual:', err.message);
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
  } else {
    apiUrl  = `${BASE_API_URL}/api/crlv-agendado/${pid}`;
    headers = { 'Content-Type': 'application/json', 'chaveAcesso': CHAVE_ACESSO };
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

async function runCrlvAgendadoPendingCheck() {
  await pool.query(`DELETE FROM crlv_agendado_pending WHERE created_at < NOW() - INTERVAL '20 days'`).catch(() => {});
  const { rows: pendentes } = await pool.query('SELECT * FROM crlv_agendado_pending ORDER BY created_at ASC LIMIT 200');
  let notified = 0, checked = 0;
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
        const fullUrl = /^https?:\/\//i.test(status.pdfPath) ? status.pdfPath : 'https://chekaki.online' + status.pdfPath;
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
          }
        }
      }
    } catch (e) {
      console.error(`Erro ao checar CRLV-e Agendado pedido ${row.pedido_id}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`✅ Checagem CRLV-e Agendado: ${checked} verificados, ${notified} avisados`);
  return { checked, notified, pending: pendentes.length };
}

// ── GET /api/cron/crlv-agendado-status (Vercel Cron) ──────────────────────────
app.get('/api/cron/crlv-agendado-status', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runCrlvAgendadoPendingCheck();
    res.json({ success: true, ...result });
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
  initDB().catch((err) => console.error('Erro DB:', err.message));
}

module.exports = app;
