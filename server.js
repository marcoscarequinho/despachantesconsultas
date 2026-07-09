require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');

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
const ZAPI_INSTANCE_ID   = process.env.ZAPI_INSTANCE_ID   || '';
const ZAPI_TOKEN         = process.env.ZAPI_TOKEN         || '';
const ZAPI_CLIENT_TOKEN  = process.env.ZAPI_CLIENT_TOKEN  || '';
const WEBHOOK_BASE_URL   = (process.env.WEBHOOK_BASE_URL  || '').replace(/\/$/, '');
const ADMIN_PHONE        = process.env.ADMIN_PHONE        || '';

async function sendWhatsApp(phone, message) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !phone) return;
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
    if (!r.ok) console.error(`Z-API erro [${formatted}]:`, JSON.stringify(d));
    else console.log(`✅ WhatsApp enviado para ${formatted}`);
  } catch (err) {
    console.error('Erro ao enviar WhatsApp:', err.message);
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
  { id:'consultar-motor',        name:'Consulta Motor',             group:'Consultas Básicas', basePrice:7.50,   inputType:'motor',       icon:'🔧' },
  { id:'consultar-placa-v2',     name:'Proprietário Atual (v2)',    group:'Consultas Básicas', basePrice:7.50,   inputType:'placa',       icon:'🔍' },
  { id:'consultar-placa-v3',     name:'Consulta Placa v3',          group:'Consultas Básicas', basePrice:7.50,   inputType:'placa_uf',    icon:'🔍' },
  { id:'consultar-placa-fipe',   name:'Consulta FIPE',              group:'Consultas Básicas', basePrice:0.00,   inputType:'placa',       icon:'💰' },
  { id:'consultar-foto-leilao',  name:'Foto Leilão',                group:'Consultas Básicas', basePrice:10.00,  inputType:'placa',       icon:'📸' },
  { id:'consultar-chassi-v2',    name:'Consulta Chassi',            group:'Consultas Básicas', basePrice:7.50,   inputType:'chassi',      icon:'🔑' },
  { id:'consultar-cnh',          name:'Consultar CNH',              group:'Consultas Básicas', basePrice:11.43,  inputType:'cpfcnpj',     icon:'🪪' },
  // ── Débitos e Documentação ──
  { id:'consulta-debitos-portal',          name:'Consulta de Débitos',          group:'Débitos e Documentação', basePrice:1.0714, inputType:'placa',       icon:'💳' },
  { id:'consultar-debito',                name:'Consulta Débito (PDF)',        group:'Débitos e Documentação', basePrice:11.99, inputType:'placa',        icon:'💳' },
  { id:'consultar-debito-api',            name:'Débitos (JSON)',               group:'Débitos e Documentação', basePrice:11.99, inputType:'placa',        icon:'💳' },
  { id:'consultar-debito-boletos-json',   name:'Emissão de boleto + Multas',   group:'Débitos e Documentação', basePrice:20.00, inputType:'placa',        icon:'🧾' },
  { id:'consultar-licenciamento',         name:'Licenciamento + BIN',          group:'Débitos e Documentação', basePrice:10.00, inputType:'placa',        icon:'📋' },
  { id:'consultar-gravame',               name:'Consulta Gravame',             group:'Débitos e Documentação', basePrice:7.50,  inputType:'placa',        icon:'🏦' },
  { id:'consultar-historico-proprietario',name:'Histórico de Proprietários',   group:'Débitos e Documentação', basePrice:9.99,  inputType:'placa',        icon:'👥' },
  { id:'renajud',                         name:'RENAJUD',                      group:'Débitos e Documentação', basePrice:9.50,  inputType:'placa',        icon:'⚖️' },
  { id:'consultar-atpve',                 name:'Reemissão ATPV-e (Chassi)',    group:'Débitos e Documentação', basePrice:13.50, inputType:'chassi',       icon:'📄' },
  { id:'consultar-atpve-v1',             name:'Reemissão ATPV-e (Placa)',     group:'Débitos e Documentação', basePrice:13.50, inputType:'placa_renavam', icon:'📄' },
  { id:'consultar-Numero-ATPVE',          name:'Número ATPV-E',                group:'Débitos e Documentação', basePrice:25.00, inputType:'placa',        icon:'🔢' },
  { id:'consultar-comunicado',            name:'Consulta Comunicado',          group:'Débitos e Documentação', basePrice:7.50,  inputType:'placa_renavam',icon:'📝' },
  { id:'dados-veiculares-debitos',        name:'Dados Veiculares Básico + Débitos + Gravame', group:'Débitos e Documentação', basePrice:1.786, inputType:'dados_veiculares_uf', icon:'🔎' },
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
  { id:'consultar-crv',      name:'Número CRV Digital',         group:'CRV', basePrice:10.50, inputType:'placa',      icon:'🔐' },
  { id:'consultar-crv-v2',   name:'Código Segurança CRV (PDF)', group:'CRV', basePrice:6.50,  inputType:'placa',      icon:'🔐' },
  { id:'consultar-placa-crv',name:'Placa + CRV (JSON+PDF)',     group:'CRV', basePrice:10.50, inputType:'placa',      icon:'🔐' },
  { id:'valida-crv',         name:'Valida CRV',                 group:'CRV', basePrice:0.00,  inputType:'valida_crv', icon:'✅' },
  // ── Análise de Crédito ──
  { id:'consultar-spc', name:'Consulta SPC/Crédito', group:'Análise de Crédito', basePrice:15.00, inputType:'cpfcnpj', icon:'📊' },
  // ── Comunicação de Venda ──
  { id:'inserir-comunicacao-venda',   name:'Inserir Comunicação Venda',     group:'Comunicação Venda', basePrice:23.50, inputType:'venda',          icon:'📝' },
  { id:'cancelar-comunicacao-venda',  name:'Cancelar Comunicação Venda',    group:'Comunicação Venda', basePrice:8.00,  inputType:'cancelar_venda', icon:'❌' },
  { id:'venda-transmitir',            name:'Transmitir Comunicação Venda',  group:'Comunicação Venda', basePrice:5.00,  inputType:'id_only',        icon:'📤' },
  { id:'com-venda-desbloquear',       name:'Desbloquear Comunicação Venda', group:'Comunicação Venda', basePrice:5.00,  inputType:'placa',          icon:'🔓' },
  { id:'com-venda-por-id',            name:'Consultar Comunicação por ID',  group:'Comunicação Venda', basePrice:3.00,  inputType:'id_get',         icon:'🔍' },
  { id:'motivos-cancelamento',        name:'Motivos de Cancelamento',       group:'Comunicação Venda', basePrice:3.00,  inputType:'protocolo_get',  icon:'📋' },
  // ── Débitos por Estado (autocrlv.com.br) ──
  { id:'debito-uf', name:'Débitos Veiculares por Estado', group:'Débitos por Estado', basePrice:1.786, inputType:'debito_uf_select', icon:'🏛️' },
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
];

// Serviços desta categoria (mais a Reemissão CRLV-e RJ) não retornam resultado na hora:
// o pedido fica pendente até o super admin subir o PDF manualmente (ver
// /api/admin/manual-queries).
const MANUAL_UPLOAD_GROUP = 'Número CRV (Apenas antigos)';
const MANUAL_SERVICE_IDS  = [...SERVICES.filter(s => s.group === MANUAL_UPLOAD_GROUP).map(s => s.id), 'crlv-agendado-rj-reemissao'];

// ── SERVICES_V2 — API Datacube (api.consultasdeveiculos.com) ──────────────────
// Catálogo completamente separado do SERVICES/autocrlv/chekaki acima. Preços em
// basePrice são o custo cobrado pela Datacube na faixa "De 0 - 10.000" da tabela
// de valores; o preço final ao cliente aplica o mesmo MARKUP (40%) do restante
// do sistema, exceto quando noMarkup:true (ex.: categoria "Débitos por Estado",
// vendida a valor fixo de R$3,00). Exposto no painel na aba "Opção 2 Nova
// Consulta" (rota /api/query-v2).
const SERVICES_V2 = [
  { id:'dc-agregados',              name:'Agregados',                               group:'Documentos', basePrice:0.380,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/agregados' },
  { id:'dc-agregados-v2',           name:'Agregados V2',                            group:'Documentos', basePrice:0.380,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/agregados_v2' },
  { id:'dc-bin-nacional',           name:'BIN Nacional',                            group:'Documentos', basePrice:2.214,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/bin-nacional' },
  { id:'dc-bin-nacional-v2',        name:'BIN Nacional V2',                         group:'Documentos', basePrice:2.214,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/bin-nacional-v2' },
  { id:'dc-bin-estadual',           name:'Base Estadual (BIN)',                     group:'Documentos', basePrice:2.214,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/bin-estadual' },
  { id:'dc-base-nacional-v2',       name:'Base Nacional V2',                        group:'Documentos', basePrice:2.203,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/base-nacional-v2' },
  { id:'dc-informacao-basica',      name:'Informação Básica',                       group:'Documentos', basePrice:0.359,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/informacao-basica' },
  { id:'dc-consulta-0km',           name:'Veículo 0km',                             group:'Documentos', basePrice:6.486,  inputType:'dc_chassi',     icon:'🚗', dcPath:'/veiculos/consulta-0km' },
  { id:'dc-informacao-basica-v2',   name:'Informação Básica V2',                    group:'Documentos', basePrice:0.391,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/informacao-basica-v2' },
  { id:'dc-proprietario-ano-lic',   name:'Proprietário / Ano Último Licenciamento', group:'Documentos', basePrice:1.006,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/proprietario-ano-licenciamento' },
  { id:'dc-proprietario-atual',     name:'Proprietário Atual',                      group:'Documentos', basePrice:1.266,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/proprietario-atual' },
  { id:'dc-informacao-simples-v2',  name:'Informação Simples V2',                   group:'Documentos', basePrice:1.563,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/informacao-simples-v2' },
  { id:'dc-infracoes-v3',           name:'Infrações V3',                            group:'Documentos', basePrice:3.891,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/infracoes-v3' },
  { id:'dc-renainf',                name:'Renainf',                                 group:'Documentos', basePrice:3.594,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renainf' },
  { id:'dc-informacao-por-renavam', name:'Informações por Renavam',                 group:'Documentos', basePrice:0.375,  inputType:'dc_renavam',    icon:'🚗', dcPath:'/veiculos/informacao-por-renavam' },
  { id:'dc-decodificar-chassi',     name:'Decodificação de Chassi',                 group:'Documentos', basePrice:0.359,  inputType:'dc_chassi',     icon:'🚗', dcPath:'/veiculos/decodificar-chassi' },
  { id:'dc-decodificar-motor',      name:'Decodificação de Motor',                  group:'Documentos', basePrice:0.359,  inputType:'dc_motor',      icon:'🚗', dcPath:'/veiculos/decodificar-motor' },
  { id:'dc-cronotacografo',         name:'Cronotacógrafo',                          group:'Documentos', basePrice:0.738,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/cronotacografo' },
  { id:'dc-gravames-v2',            name:'Gravames V2',                             group:'Documentos', basePrice:3.594,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/gravames-v2' },
  { id:'dc-gravames-v3',            name:'Gravames V3',                             group:'Documentos', basePrice:3.091,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/gravames-v3' },
  { id:'dc-historico-gravames',     name:'Histórico de Gravames',                   group:'Documentos', basePrice:4.672,  inputType:'dc_chassi',     icon:'🚗', dcPath:'/veiculos/historico_gravames' },
  { id:'dc-uf-placa',               name:'UF da Placa',                             group:'Documentos', basePrice:0.281,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/uf-placa' },
  { id:'dc-marcas',                 name:'Marcas',                                  group:'Documentos', basePrice:0.230,  inputType:'dc_tipo',       icon:'🚗', dcPath:'/veiculos/marcas' },
  { id:'dc-modelos',                name:'Modelos',                                 group:'Documentos', basePrice:0.230,  inputType:'dc_tipo_marca', icon:'🚗', dcPath:'/veiculos/modelos' },
  { id:'dc-recall',                 name:'Recall',                                  group:'Documentos', basePrice:0.391,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/recall' },
  { id:'dc-renavam',                name:'Renavam',                                 group:'Documentos', basePrice:0.853,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renavam' },
  { id:'dc-renavam-v2',             name:'Renavam V2',                              group:'Documentos', basePrice:0.234,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renavam-v2' },
  { id:'dc-leilao',                 name:'Leilão',                                  group:'Documentos', basePrice:19.155, inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/leilao' },
  { id:'dc-indicio-roubo-furto',    name:'Indício de Roubo e Furto',                group:'Documentos', basePrice:0.375,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/indicio-roubo-furto' },
  { id:'dc-sinistro',               name:'Indício de Sinistro',                     group:'Documentos', basePrice:0.947,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/sinistro' },
  { id:'dc-roubo-furto',            name:'Roubo e Furto',                           group:'Documentos', basePrice:16.514, inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/roubo_furto' },
  { id:'dc-historico-fipe',         name:'Histórico FIPE',                          group:'Documentos', basePrice:0.234,  inputType:'dc_fipe',       icon:'🚗', dcPath:'/veiculos/historico-fipe' },
  { id:'dc-renajud-v3',             name:'Renajud V3',                              group:'Documentos', basePrice:3.047,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renajud-v3' },
  { id:'dc-renajud-v4',             name:'Renajud V4',                              group:'Documentos', basePrice:2.791,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/renajud-v4' },
  { id:'dc-csv',                    name:'Certificado de Segurança Veicular (CSV)', group:'Documentos', basePrice:4.314,  inputType:'dc_csv',        icon:'🚗', dcPath:'/veiculos/csv' },
  { id:'dc-veiculos-doc',           name:'Veículos por Documento (CPF/CNPJ)',       group:'Documentos', basePrice:7.188,  inputType:'dc_documento',  icon:'🚗', dcPath:'/pessoas/veiculos' },
  { id:'dc-veiculos-doc-v2',        name:'Veículos por Documento V2',               group:'Documentos', basePrice:8.984,  inputType:'dc_documento',  icon:'🚗', dcPath:'/pessoas/veiculos_v2' },
  { id:'dc-veiculos-doc-v3',        name:'Veículos por Documento V3',               group:'Documentos', basePrice:8.984,  inputType:'dc_documento',  icon:'🚗', dcPath:'/pessoas/veiculos_v3' },
  { id:'dc-historico-proprietario', name:'Histórico de Proprietários',              group:'Documentos', basePrice:7.813,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/historico-proprietario' },
  { id:'dc-roubo-furto-simples',    name:'Roubo e Furto Simples',                   group:'Documentos', basePrice:6.250,  inputType:'dc_placa',      icon:'🚗', dcPath:'/veiculos/roubo_furto_simples' },

  // ── Débitos por Estado — valor fixo R$3,00, sem markup ───────────────────────
  { id:'dc-debito-ac',    name:'Débitos - Acre',                   group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/ac' },
  { id:'dc-debito-al',    name:'Débitos - Alagoas',                group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/al' },
  { id:'dc-debito-ap',    name:'Débitos - Amapá',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/ap' },
  { id:'dc-debito-am',    name:'Débitos - Amazonas',               group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/am' },
  { id:'dc-debito-ce',    name:'Débitos - Ceará',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/ce' },
  { id:'dc-debito-df',    name:'Débitos - Distrito Federal',       group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/df' },
  { id:'dc-debito-es',    name:'Débitos - Espírito Santo',         group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/es' },
  { id:'dc-debito-go',    name:'Débitos - Goiás',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/go' },
  { id:'dc-debito-ma',    name:'Débitos - Maranhão',               group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/ma' },
  { id:'dc-debito-mt',    name:'Débitos - Mato Grosso',            group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/mt' },
  { id:'dc-debito-ms',    name:'Débitos - Mato Grosso do Sul',     group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/ms' },
  { id:'dc-debito-mg',    name:'Débitos - Minas Gerais',           group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/mg-simples' },
  { id:'dc-debito-pa',    name:'Débitos - Pará',                   group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/pa' },
  { id:'dc-debito-pb',    name:'Débitos - Paraíba',                group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/pb' },
  { id:'dc-debito-pr',    name:'Débitos - Paraná',                 group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_renavam', icon:'🏛️', dcPath:'/debitos/pr' },
  { id:'dc-debito-pi',    name:'Débitos - Piauí',                  group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/pi' },
  { id:'dc-debito-rj',    name:'Débitos - Rio de Janeiro',         group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/rj' },
  { id:'dc-debito-rn',    name:'Débitos - Rio Grande do Norte',    group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/rn' },
  { id:'dc-debito-rs',    name:'Débitos - Rio Grande do Sul',      group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/rs-v2' },
  { id:'dc-debito-ro',    name:'Débitos - Rondônia',               group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/ro' },
  { id:'dc-debito-rr',    name:'Débitos - Roraima',                group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/rr' },
  { id:'dc-debito-sc',    name:'Débitos - Santa Catarina',         group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_chassi',  icon:'🏛️', dcPath:'/debitos/sc' },
  { id:'dc-debito-sc-v2', name:'Débitos - Santa Catarina V2',      group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/sc-v2' },
  { id:'dc-debito-sp',    name:'Débitos - São Paulo',              group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito',         icon:'🏛️', dcPath:'/debitos/sp' },
  { id:'dc-debito-to',    name:'Débitos - Tocantins',              group:'Débitos por Estado', basePrice:3.00, noMarkup:true, inputType:'dc_debito_doc',     icon:'🏛️', dcPath:'/debitos/to' },
];

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
  console.log('✅ Tabelas prontas');
}

// ── Middlewares ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
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

const SUPER_ADMIN_EMAIL = 'contato@mygmail.com.br';

async function requireSuperAdmin(req, res, next) {
  try {
    const r = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length || r.rows[0].email !== SUPER_ADMIN_EMAIL)
      return res.status(403).json({ error: 'Acesso restrito ao super administrador.' });
    next();
  } catch {
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

// ── POST /api/query ───────────────────────────────────────────────────────────
app.post('/api/query', requireAuth, async (req, res) => {
  const { serviceId, params } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Serviço não informado.' });

  const service = SERVICES.find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });

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
      await pool.query('UPDATE users SET credits = credits - $1 WHERE id=$2', [price, req.user.id]);
      const txRow = await pool.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
        [req.user.id, price, `Consulta: ${service.name}`]
      );
      await pool.query(
        `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
         VALUES ($1,$2,$3,$4,'pendente',$5,$6,'pdf')`,
        [req.user.id, serviceId, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id]
      );
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

      const placa    = (veic.placa   || '').toUpperCase().replace(/[\s-]/g, '');
      const renavam  = (veic.renavam || '').replace(/\D/g, '');
      const vCpf     = (v.cpf || '').replace(/\D/g, '');
      const cCpf     = (c.cpf || '').replace(/\D/g, '');
      const cep      = (end.cep || '').replace(/\D/g, '');
      const numeroVia       = parseInt(crv.numero_via, 10);
      const cidadeComprador = parseInt(end.cidade, 10);
      const cidadeVenda     = parseInt(vda.cidade, 10);
      const valorStr = String(vda.valor ?? '').trim();
      const valor    = valorStr.includes(',')
        ? parseFloat(valorStr.replace(/\./g, '').replace(',', '.'))
        : parseFloat(valorStr);

      if (placa.length < 7)                          return res.status(400).json({ error: 'Placa do veículo inválida. Informe no formato ABC1D23.' });
      if (renavam.length < 9 || renavam.length > 11)  return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
      if (vCpf.length !== 11)                         return res.status(400).json({ error: 'CPF do vendedor inválido. Deve ter 11 dígitos.' });
      if (cCpf.length !== 11)                         return res.status(400).json({ error: 'CPF do comprador inválido. Deve ter 11 dígitos.' });
      if (!v.nome?.trim())                            return res.status(400).json({ error: 'Informe o nome do vendedor.' });
      if (!c.nome?.trim())                            return res.status(400).json({ error: 'Informe o nome do comprador.' });
      if (cep.length !== 8)                            return res.status(400).json({ error: 'CEP inválido. Deve ter 8 dígitos.' });
      if (!end.uf || end.uf.trim().length !== 2)      return res.status(400).json({ error: 'UF do endereço do comprador inválida.' });
      if (!vda.estado || vda.estado.trim().length !== 2) return res.status(400).json({ error: 'UF da venda inválida.' });
      if (Number.isNaN(cidadeComprador))              return res.status(400).json({ error: 'Código IBGE da cidade do comprador inválido.' });
      if (Number.isNaN(cidadeVenda))                   return res.status(400).json({ error: 'Código IBGE da cidade da venda inválido.' });
      if (Number.isNaN(valor) || valor <= 0)          return res.status(400).json({ error: 'Valor da venda inválido.' });
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(vda.data || '')) return res.status(400).json({ error: 'Data da venda inválida. Use o formato DD/MM/AAAA.' });
      if (!Number.isInteger(numeroVia) || numeroVia < 1) return res.status(400).json({ error: 'Número da via do CRV inválido.' });
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(crv.data_emissao || '')) return res.status(400).json({ error: 'Data de emissão do CRV inválida. Use o formato DD/MM/AAAA.' });

      body = {
        vendedor: { tipo_pessoa: 'F', cpf: vCpf, cnpj: '', nome: v.nome.trim().toUpperCase() },
        comprador: {
          tipo_pessoa: 'F', cpf: cCpf, cnpj: '', nome: c.nome.trim().toUpperCase(),
          endereco: {
            cep, logradouro: end.logradouro || '', numero: end.numero || '',
            bairro: end.bairro || '', complemento: end.complemento || '',
            cidade: cidadeComprador, uf: end.uf.trim().toUpperCase(),
          },
        },
        venda: {
          cidade: cidadeVenda, data: vda.data, valor,
          comprador_solicitante: 'S', estado: vda.estado.trim().toUpperCase(),
        },
        veiculo: {
          placa, renavam,
          crv: {
            numero: crv.numero || '', codigo_seguranca: crv.codigo_seguranca || '',
            numero_via: numeroVia, data_emissao: crv.data_emissao,
            uf_emissao: (crv.uf_emissao || '').trim().toUpperCase(),
          },
        },
      };
      // DEBUG temporário — remover após diagnosticar o erro "Campos obrigatórios
      // ausentes ou inválidos." reportado pela API upstream (CPFs mascarados).
      console.log('[inserir-comunicacao-venda] payload:', JSON.stringify({
        ...body,
        vendedor:  { ...body.vendedor,  cpf: body.vendedor.cpf.replace(/\d(?=\d{4})/g, '*') },
        comprador: { ...body.comprador, cpf: body.comprador.cpf.replace(/\d(?=\d{4})/g, '*') },
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
    // Dados Veiculares Básico + Débitos + Gravame (autocrlv.com.br)
    if (serviceId === 'dados-veiculares-debitos') {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      const uf    = (params?.uf    || '').toUpperCase().replace(/\s/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      if (!uf)              return res.status(400).json({ error: 'Selecione o estado (UF).' });
      const qp = new URLSearchParams({ chaveAcesso: AUTOCRLV_KEY, uf, placa });
      apiUrl = `https://autocrlv.com.br/api/v1/dados_veiculares_debitos.php?${qp.toString()}`;
      method = 'GET';
      body   = null;
    }
    // Serviços migrados para portaldespachantes.online (placa only)
    const PORTAL_PLACA_MAP = {
      'consulta-debitos-portal':  'consultar-debito-api',
      'base-estadual':            'base-estadual',
      'base-nacional':            'base-nacional',
      'consultar-gravame':        'consultar-gravame',
      'consultar-licenciamento':  'consultar-licenciamento',
    };
    if (PORTAL_PLACA_MAP[serviceId]) {
      const placa = (params?.placa || '').toUpperCase().replace(/[\s-]/g, '');
      if (placa.length < 7) return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      apiUrl = `https://portaldespachantes.online/${PORTAL_PLACA_MAP[serviceId]}`;
      method = 'POST';
      body   = { placa };
    }
    // Débitos JSON → endpoint diferente na nova API
    if (serviceId === 'consultar-debito-api') {
      apiUrl = `${BASE_API_URL}/consultar-debito-boletos-json`;
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

    // Débitos por Estado — serviço unificado com dropdown de UF
    if (serviceId === 'debito-uf') {
      const uf      = (params?.uf || '').toLowerCase().replace(/\s/g, '');
      const placa   = (params?.placa   || '').toUpperCase().replace(/[\s-]/g, '');
      const renavam = (params?.renavam || '').replace(/\D/g, '');
      if (!uf)                                      return res.status(400).json({ error: 'Selecione o estado (UF).' });
      if (placa.length < 7)                         return res.status(400).json({ error: 'Placa inválida. Informe no formato ABC1D23.' });
      if (renavam.length < 9 || renavam.length > 11) return res.status(400).json({ error: 'Renavam inválido. Deve ter entre 9 e 11 dígitos.' });
      const qp = new URLSearchParams({ endpoint:`debitos_${uf}_pdf`, require_api_key:'1', chaveAcesso:AUTOCRLV_KEY, placa, renavam });
      if (params?.documento) qp.set('documento', (params.documento||'').replace(/\D/g,''));
      if (params?.chassi)    qp.set('chassi',    (params.chassi||'').toUpperCase());
      apiUrl = `https://autocrlv.com.br/cliente/api.php?${qp.toString()}`;
      method = 'GET';
      body   = null;
    }

    // Débitos por Estado — autocrlv.com.br (GET, auth via query param)
    const DEBITO_UF_SVCS = ['debito-ac','debito-al','debito-am','debito-ap','debito-ce','debito-df','debito-es','debito-ma','debito-mg','debito-mt','debito-pa','debito-pb','debito-pi','debito-pr','debito-rj','debito-rn','debito-ro','debito-sc','debito-sp'];
    if (DEBITO_UF_SVCS.includes(serviceId)) {
      const uf      = service.uf;
      const placa   = (params?.placa   || '').toUpperCase().replace(/[\s-]/g, '');
      const renavam = (params?.renavam || '').replace(/\D/g, '');
      const qp = new URLSearchParams({ endpoint:`debitos_${uf}_pdf`, require_api_key:'1', chaveAcesso:AUTOCRLV_KEY, placa, renavam });
      if (params?.documento) qp.set('documento', (params.documento||'').replace(/\D/g,''));
      if (params?.chassi)    qp.set('chassi',    (params.chassi||'').toUpperCase());
      apiUrl = `https://autocrlv.com.br/cliente/api.php?${qp.toString()}`;
      method = 'GET';
      body   = null;
    }

    let fetchHeaders;
    if (DEBITO_UF_SVCS.includes(serviceId) || serviceId === 'debito-uf') {
      fetchHeaders = {};
    } else if (serviceId === 'dados-veiculares-debitos') {
      fetchHeaders = { 'Authorization': `Bearer ${AUTOCRLV_KEY}` };
    } else if (apiUrl.startsWith('https://autocrlv.com.br/cliente/api_integracao_crlv_agendado')) {
      fetchHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTOCRLV_KEY}` };
    } else if (PORTAL_PLACA_MAP[serviceId]) {
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': PORTAL_DESP_KEY };
    } else {
      fetchHeaders = { 'Content-Type': 'application/json', 'chaveAcesso': CHAVE_ACESSO };
    }
    const fetchOpts = { method, headers: fetchHeaders };
    if (body !== null) fetchOpts.body = JSON.stringify(body);

    const apiRes = await fetch(apiUrl, fetchOpts);
    const ct = apiRes.headers.get('content-type') || '';

    if (!apiRes.ok) {
      let errMsg = 'Erro na API.';
      try {
        if (ct.includes('application/json') || ct.includes('text/')) {
          const errData = await apiRes.json().catch(() => null)
            || { error: await apiRes.text().catch(() => 'Sem resposta') };
          errMsg = extractApiErrorMsg(errData);
        } else {
          errMsg = `HTTP ${apiRes.status}`;
        }
      } catch {}
      console.error(`Erro API [${serviceId}] HTTP ${apiRes.status}: ${errMsg}`);
      return res.status(apiRes.status).json({ error: errMsg });
    }

    // Lê o corpo uma única vez
    const bodyBuffer = Buffer.from(await apiRes.arrayBuffer());
    const bodyStr    = bodyBuffer.toString('utf8');
    const isRealPdf  = bodyBuffer.slice(0, 4).toString() === '%PDF';

    // Débitos por estado: valida PDF antes de debitar
    if ((DEBITO_UF_SVCS.includes(serviceId) || serviceId === 'debito-uf') && !isRealPdf) {
      let errMsg = 'Resposta inválida da API de débitos.';
      try {
        const p = JSON.parse(bodyStr);
        errMsg = extractApiErrorMsg(p);
      } catch { errMsg = bodyStr.slice(0, 300) || errMsg; }
      console.error(`[${serviceId}] esperava PDF, recebeu: ${errMsg}`);
      return res.status(422).json({ error: errMsg });
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

    // Dados Veiculares Básico retorna HTML — captura para servir via /api/html/:token
    let htmlBuf = null;
    if (serviceId === 'dados-veiculares-debitos') {
      if (ct.includes('text/html') && bodyBuffer.length > 100) {
        htmlBuf = bodyBuffer;
      } else {
        let parsed; try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
        const errMsg = parsed ? extractApiErrorMsg(parsed) : (bodyStr.slice(0, 200) || 'Resposta inválida da API.');
        console.error(`[dados-veiculares-debitos] inesperado: ${errMsg}`);
        return res.status(422).json({ error: errMsg });
      }
    }

    // Serviços genéricos (não-PDF, não-HTML): recusa cobrar se a API não retornou
    // nenhum dado relevante (corpo vazio, JSON vazio/nulo ou com indicador de falha).
    let genericData = null, genericParseOk = false;
    const willBePdfOrHtml = isRealPdf || base64PdfBuf || htmlBuf;
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
    await pool.query(
      'UPDATE users SET credits = credits - $1 WHERE id=$2', [price, req.user.id]
    );
    const txRow = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3) RETURNING id`,
      [req.user.id, price, `Consulta: ${service.name}`]
    );
    const qRow = await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
       VALUES ($1,$2,$3,$4,'success',$5,$6,$7) RETURNING id`,
      [req.user.id, serviceId, service.name, JSON.stringify(params || {}),
       price, txRow.rows[0].id,
       htmlBuf ? 'html' : (isRealPdf || base64PdfBuf) ? 'pdf' : 'json']
    );
    await notifyAdminNewQuery(user, service, price, params);

    // ── Envia PDF + salva no cache por 7 dias ────────────────────────────────
    const pdfToSend = base64PdfBuf || (isRealPdf ? bodyBuffer : null);
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
    await pool.query(
      `INSERT INTO queries (user_id, service_id, service_name, params, status, amount, transaction_id, result_type)
       VALUES ($1,$2,$3,$4,'success',$5,$6,'json')`,
      [req.user.id, service.id, service.name, JSON.stringify(params || {}), price, txRow.rows[0].id]
    );

    return res.json({ success: true, result: apiData.result ?? apiData, charged: price });
  } catch (err) {
    console.error('Erro em /api/query-v2:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
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

    const mp = await mpReq('GET', `/v1/payments/${paymentId}`);

    if (mp.status === 'approved') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [p.value, p.user_id]);
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'deposit',$2,$3)`,
          [p.user_id, p.value, `Recarga PIX — R$ ${parseFloat(p.value).toFixed(2).replace('.', ',')}`]
        );
        await client.query('UPDATE pix_payments SET status=$1, credited=true WHERE id=$2', [mp.status, p.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return res.json({ status: 'RECEIVED', credited: true, value: parseFloat(p.value) });
    }

    await pool.query('UPDATE pix_payments SET status=$1 WHERE id=$2', [mp.status, p.id]);
    res.json({ status: mp.status, credited: false });
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
    const pr = await pool.query(
      'SELECT * FROM pix_payments WHERE gateway_id=$1 AND credited=false',
      [String(paymentId)]
    );
    if (!pr.rows.length) return;
    const p = pr.rows[0];

    const mp = await mpReq('GET', `/v1/payments/${paymentId}`);
    if (mp.status !== 'approved') return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [p.value, p.user_id]);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'deposit',$2,$3)`,
        [p.user_id, p.value, `Recarga PIX — R$ ${parseFloat(p.value).toFixed(2).replace('.', ',')}`]
      );
      await client.query('UPDATE pix_payments SET status=$1, credited=true WHERE id=$2', [mp.status, p.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Webhook PIX rollback:', e.message);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Webhook PIX erro:', err.message);
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
    if (!r.rows.length || r.rows[0].email !== SUPER_ADMIN_EMAIL) return res.redirect('/painel');
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

Galera, minha plataforma está com preços melhores do que a TDI, cod segurança 9,10, reemissão de ATPVE 18,90, CRLV-e do Rio 14,00, reemissão CRVL-e Rio 90,00, o kit de códigos da ATPVE quando tem comunicação de venda, 35,00.
Olá! Quero te indicar a plataforma DESPACHANTES CONSULTAS — consultas veiculares e CRLV-e digital para profissionais.

🎁 Cadastre-se pelo meu link e ganhe R$ 10,00 de crédito grátis para usar na plataforma!

👉 https://www.despachantesconsultas.com.br/cadastrar?ref=MARCOTSN0

✅ Sem mensalidade. Pague só pelo que usar.`;

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

  const [contactsRes, chatsRes] = await Promise.all([
    fetch(`${base}/contacts`,                  { headers }),
    fetch(`${base}/chats?page=1&pageSize=500`, { headers }),
  ]);

  // Chave = ID único; valor = phone string pronto para envio
  const destinations = new Map();

  if (contactsRes.ok) {
    const data = await contactsRes.json().catch(() => []);
    const list = Array.isArray(data) ? data : (data.value || data.contacts || []);
    list.forEach(c => {
      const p = String(c.phone || '').replace(/\D/g, '');
      if (p.length >= 10) destinations.set(p, p);
    });
    console.log(`📋 Contatos individuais: ${destinations.size}`);
  } else {
    console.warn('⚠️  Z-API /contacts falhou:', contactsRes.status);
  }

  const before = destinations.size;

  if (chatsRes.ok) {
    const data = await chatsRes.json().catch(() => []);
    const list = Array.isArray(data) ? data : (data.value || data.chats || []);
    list.forEach(c => {
      const rawId = String(c.id || c.phone || '');
      if (!rawId) return;
      if (rawId.includes('@g.us')) {
        // Grupo: preservar ID com @g.us para entrega correta
        destinations.set(rawId, rawId);
      } else {
        const p = rawId.replace(/\D/g, '');
        if (p.length >= 10 && !destinations.has(p)) destinations.set(p, p);
      }
    });
    console.log(`📋 Grupos/chats adicionados: ${destinations.size - before}`);
  } else {
    console.warn('⚠️  Z-API /chats falhou:', chatsRes.status);
  }

  return [...destinations.values()];
}

// Envio para broadcast — trata individualmente números e IDs de grupo (@g.us)
async function sendBroadcastMessage(dest, message) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !dest) return;
  let phone;
  if (String(dest).includes('@g.us')) {
    phone = dest; // grupo: usa ID completo
  } else {
    const digits = String(dest).replace(/\D/g, '');
    phone = digits.startsWith('55') ? digits : `55${digits}`;
  }
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
  console.log(`📢 Broadcast: ${dests.length} destinos (contatos + grupos)`);
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
