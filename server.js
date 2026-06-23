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
const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || '')
  .split('').filter(c => c.charCodeAt(0) <= 127).join('').trim();
const ASAAS_BASE = 'https://api.asaas.com/v3';
const AUTOCRLV_KEY = process.env.AUTOCRLV_KEY || '';

async function asaasReq(method, endpoint, body = null) {
  const opts = {
    method,
    headers: { 'access_token': ASAAS_API_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${ASAAS_BASE}${endpoint}`, opts);
  const data = await r.json();
  if (!r.ok) {
    const msg = data.errors?.[0]?.description || data.error || 'Erro Asaas';
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
  { id:'consultar-debito',                name:'Consulta Débito (PDF)',        group:'Débitos e Documentação', basePrice:11.99, inputType:'placa',        icon:'💳' },
  { id:'consultar-debito-api',            name:'Débitos (JSON)',               group:'Débitos e Documentação', basePrice:11.99, inputType:'placa',        icon:'💳' },
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
  { id:'debito-ac', name:'Débitos AC — Acre',                group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'ac' },
  { id:'debito-al', name:'Débitos AL — Alagoas',             group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'al' },
  { id:'debito-am', name:'Débitos AM — Amazonas',            group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'am' },
  { id:'debito-ap', name:'Débitos AP — Amapá',               group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'ap' },
  { id:'debito-ce', name:'Débitos CE — Ceará',               group:'Débitos por Estado', basePrice:1.07, inputType:'debito_doc',     icon:'🏛️', uf:'ce' },
  { id:'debito-df', name:'Débitos DF — Distrito Federal',    group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'df' },
  { id:'debito-es', name:'Débitos ES — Espírito Santo',      group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'es' },
  { id:'debito-ma', name:'Débitos MA — Maranhão',            group:'Débitos por Estado', basePrice:1.07, inputType:'debito_doc',     icon:'🏛️', uf:'ma' },
  { id:'debito-mg', name:'Débitos MG — Minas Gerais',        group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'mg' },
  { id:'debito-mt', name:'Débitos MT — Mato Grosso',         group:'Débitos por Estado', basePrice:1.07, inputType:'debito_doc',     icon:'🏛️', uf:'mt' },
  { id:'debito-pa', name:'Débitos PA — Pará',                group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'pa' },
  { id:'debito-pb', name:'Débitos PB — Paraíba',             group:'Débitos por Estado', basePrice:1.07, inputType:'debito_doc',     icon:'🏛️', uf:'pb' },
  { id:'debito-pi', name:'Débitos PI — Piauí',               group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'pi' },
  { id:'debito-pr', name:'Débitos PR — Paraná',              group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'pr' },
  // debito-rj removido: endpoint debitos_rj_pdf retorna 405 (não suportado pela autocrlv)
  { id:'debito-rn', name:'Débitos RN — Rio Grande do Norte', group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'rn' },
  { id:'debito-ro', name:'Débitos RO — Rondônia',            group:'Débitos por Estado', basePrice:1.07, inputType:'debito_doc',     icon:'🏛️', uf:'ro' },
  { id:'debito-sc', name:'Débitos SC — Santa Catarina',      group:'Débitos por Estado', basePrice:1.07, inputType:'debito_chassi',  icon:'🏛️', uf:'sc' },
  { id:'debito-sp', name:'Débitos SP — São Paulo',           group:'Débitos por Estado', basePrice:1.07, inputType:'placa_renavam',  icon:'🏛️', uf:'sp' },
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
      asaas_id   VARCHAR(100) UNIQUE NOT NULL,
      value      NUMERIC(10,2) NOT NULL,
      status     VARCHAR(20) DEFAULT 'PENDING',
      credited   BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Tabelas prontas');
}

// ── Middlewares ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname)));

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

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, email, role, credits, affiliate_code FROM users WHERE id=$1',
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
      price: parseFloat((s.basePrice * MARKUP).toFixed(2)),
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
      price: parseFloat((s.basePrice * MARKUP).toFixed(2)),
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

// ── POST /api/query ───────────────────────────────────────────────────────────
app.post('/api/query', requireAuth, async (req, res) => {
  const { serviceId, params } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Serviço não informado.' });

  const service = SERVICES.find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });

  const price = parseFloat((service.basePrice * MARKUP).toFixed(2));

  try {
    const ur = await pool.query(
      'SELECT credits, active FROM users WHERE id=$1', [req.user.id]
    );
    const user = ur.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Conta bloqueada.' });
    if (parseFloat(user.credits) < price)
      return res.status(400).json({
        error: `Saldo insuficiente. Necessário: R$ ${price.toFixed(2).replace('.', ',')}`,
      });

    // Build URL and method
    let apiUrl = `${BASE_API_URL}/${serviceId}`;
    let method = 'POST';
    let body = params || {};

    // CRLV Agendado: solicitar
    if (serviceId.startsWith('crlv-agendado-') && serviceId !== 'crlv-agendado-status') {
      const svcDef = SERVICES.find(s => s.id === serviceId);
      apiUrl = `${BASE_API_URL}/api/crlv-agendado/solicitar`;
      body = { ...params, uf: svcDef?.uf || params.uf };
    }
    // CRLV Agendado: verificar status
    if (serviceId === 'crlv-agendado-status' && params?.pedido_id) {
      apiUrl = `${BASE_API_URL}/api/crlv-agendado/${params.pedido_id}`;
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

    const fetchOpts = {
      method,
      headers: DEBITO_UF_SVCS.includes(serviceId)
        ? {}
        : { 'Content-Type': 'application/json', 'chaveAcesso': CHAVE_ACESSO },
    };
    if (body !== null) fetchOpts.body = JSON.stringify(body);

    const apiRes = await fetch(apiUrl, fetchOpts);
    const ct = apiRes.headers.get('content-type') || '';

    if (!apiRes.ok) {
      let errMsg = 'Erro na API.';
      try {
        if (ct.includes('application/json') || ct.includes('text/')) {
          const errData = await apiRes.json().catch(() => null)
            || { error: await apiRes.text().catch(() => 'Sem resposta') };
          errMsg = errData?.error || errData?.message || JSON.stringify(errData);
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
    if (DEBITO_UF_SVCS.includes(serviceId) && !isRealPdf) {
      let errMsg = 'Resposta inválida da API de débitos.';
      try {
        const p = JSON.parse(bodyStr);
        errMsg = p.error || p.message || p.msg || JSON.stringify(p);
      } catch { errMsg = bodyStr.slice(0, 300) || errMsg; }
      console.error(`[${serviceId}] esperava PDF, recebeu: ${errMsg}`);
      return res.status(422).json({ error: errMsg });
    }

    // serviços que retornam JSON com pdf_base64
    const PDF_BASE64_SVCS = ['consultar-placa-crv', 'consultar-crv-v2'];
    let base64PdfBuf = null;
    if (PDF_BASE64_SVCS.includes(serviceId)) {
      let parsed;
      try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
      if (parsed?.pdf_base64) {
        base64PdfBuf = Buffer.from(parsed.pdf_base64, 'base64');
      } else if (!isRealPdf) {
        const errMsg = parsed?.error || parsed?.message || 'PDF não retornado pela API.';
        console.error(`[${serviceId}] sem pdf_base64: ${errMsg}`);
        return res.status(422).json({ error: errMsg });
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
       price, txRow.rows[0].id, (isRealPdf || base64PdfBuf) ? 'pdf' : 'json']
    );

    // ── Envia PDF + salva no cache por 7 dias ────────────────────────────────
    const pdfToSend = base64PdfBuf || (isRealPdf ? bodyBuffer : null);
    if (pdfToSend) {
      const token     = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await pool.query(
        `INSERT INTO pdf_cache (query_id, user_id, token, pdf_data, expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [qRow.rows[0].id, req.user.id, token, pdfToSend.toString('base64'), expiresAt]
      ).catch(e => console.error('Erro ao salvar pdf_cache:', e.message));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${serviceId}-${Date.now()}.pdf"`);
      return res.send(pdfToSend);
    }

    try {
      const data = JSON.parse(bodyStr);
      return res.json({ success: true, result: data, charged: price });
    } catch {
      return res.json({ success: true, result: { resposta: bodyStr }, charged: price });
    }
  } catch (err) {
    console.error('Erro em /api/query:', err.message);
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

// ── GET /api/pix/diagnostico (temporário — remove após debug) ─────────────────
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

app.get('/api/pix/diagnostico', requireAuth, async (req, res) => {
  const keyOk = ASAAS_API_KEY.length > 20;
  let asaasOk = false;
  let asaasErro = null;
  try {
    const r = await fetch(`${ASAAS_BASE}/customers?limit=1`, {
      headers: { 'access_token': ASAAS_API_KEY },
    });
    const d = await r.json();
    asaasOk = r.ok;
    if (!r.ok) asaasErro = JSON.stringify(d);
  } catch (e) {
    asaasErro = e.message;
  }
  const raw = (process.env.ASAAS_API_KEY || '');
  res.json({
    keyCarregada: keyOk,
    keyTamanho: ASAAS_API_KEY.length,
    keyTamanhoRaw: raw.length,
    charsCorrompidos: raw.split('').filter(c => c.charCodeAt(0) > 127).length,
    keyInicio: ASAAS_API_KEY.slice(0, 12) + '...',
    asaasConectado: asaasOk,
    asaasErro,
    nodeVersion: process.version,
  });
});

// ── POST /api/pix/criar ───────────────────────────────────────────────────────
app.post('/api/pix/criar', requireAuth, async (req, res) => {
  const value = parseFloat(req.body.value);
  if (!value || value < 5 || value > 10000)
    return res.status(400).json({ error: 'Valor inválido. Mínimo R$ 5,00, máximo R$ 10.000,00.' });

  try {
    const ur = await pool.query(
      'SELECT id, name, email, phone, cpf_cnpj, asaas_customer_id FROM users WHERE id=$1',
      [req.user.id]
    );
    const user = ur.rows[0];

    let customerId = user.asaas_customer_id;
    if (!customerId) {
      // Tenta buscar cliente já existente pelo CPF/CNPJ
      const search = await asaasReq('GET', `/customers?cpfCnpj=${user.cpf_cnpj}&limit=1`);
      if (search.data && search.data.length > 0) {
        customerId = search.data[0].id;
      } else {
        const customer = await asaasReq('POST', '/customers', {
          name: user.name,
          cpfCnpj: user.cpf_cnpj,
          email: user.email,
          ...(user.phone ? { phone: user.phone } : {}),
        });
        customerId = customer.id;
      }
      await pool.query('UPDATE users SET asaas_customer_id=$1 WHERE id=$2', [customerId, user.id]);
    }

    const today = new Date().toISOString().split('T')[0];
    const payment = await asaasReq('POST', '/payments', {
      customer: customerId,
      billingType: 'PIX',
      value,
      dueDate: today,
      description: `Recarga de créditos — ${user.name}`,
    });

    const qr = await asaasReq('GET', `/payments/${payment.id}/pixQrCode`);

    await pool.query(
      `INSERT INTO pix_payments (user_id, asaas_id, value, status)
       VALUES ($1,$2,$3,'PENDING') ON CONFLICT (asaas_id) DO NOTHING`,
      [req.user.id, payment.id, value]
    );

    res.json({
      paymentId: payment.id,
      qrCode: qr.encodedImage,
      pixCopiaECola: qr.payload,
      expirationDate: qr.expirationDate,
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
      'SELECT * FROM pix_payments WHERE asaas_id=$1 AND user_id=$2',
      [paymentId, req.user.id]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Pagamento não encontrado.' });
    const p = pr.rows[0];

    if (p.credited) return res.json({ status: 'RECEIVED', credited: true, value: parseFloat(p.value) });

    const ap = await asaasReq('GET', `/payments/${paymentId}`);

    if (ap.status === 'RECEIVED' || ap.status === 'CONFIRMED') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [p.value, p.user_id]);
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'deposit',$2,$3)`,
          [p.user_id, p.value, `Recarga PIX — R$ ${parseFloat(p.value).toFixed(2).replace('.', ',')}`]
        );
        await client.query('UPDATE pix_payments SET status=$1, credited=true WHERE id=$2', [ap.status, p.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return res.json({ status: ap.status, credited: true, value: parseFloat(p.value) });
    }

    await pool.query('UPDATE pix_payments SET status=$1 WHERE id=$2', [ap.status, p.id]);
    res.json({ status: ap.status, credited: false });
  } catch (err) {
    console.error('Erro PIX status:', err.message);
    res.status(500).json({ error: 'Erro ao verificar pagamento.' });
  }
});

// ── POST /api/pix/webhook ─────────────────────────────────────────────────────
app.post('/api/pix/webhook', async (req, res) => {
  res.sendStatus(200);
  const { event, payment } = req.body || {};
  if (!payment?.id) return;
  if (event !== 'PAYMENT_RECEIVED' && event !== 'PAYMENT_CONFIRMED') return;

  try {
    const pr = await pool.query(
      'SELECT * FROM pix_payments WHERE asaas_id=$1 AND credited=false',
      [payment.id]
    );
    if (!pr.rows.length) return;
    const p = pr.rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET credits = credits + $1 WHERE id=$2', [p.value, p.user_id]);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'deposit',$2,$3)`,
        [p.user_id, p.value, `Recarga PIX — R$ ${parseFloat(p.value).toFixed(2).replace('.', ',')}`]
      );
      await client.query('UPDATE pix_payments SET status=$1, credited=true WHERE id=$2', [event.replace('PAYMENT_', ''), p.id]);
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

// ── POST /api/pdf/extrair-atpv ────────────────────────────────────────────────
// Recebe texto extraído pelo PDF.js no browser e retorna campos via regex
app.post('/api/pdf/extrair-atpv', requireAuth, (req, res) => {
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ error: 'Texto não enviado.' });

  const txt = texto.replace(/\s+/g, ' ').toUpperCase();
  const m   = (r) => (txt.match(r) || [])[1] || '';

  // ── Veículo ──
  let placa  = m(/PLACA[^A-Z0-9]*([A-Z]{3}[\s-]?[0-9A-Z][0-9A-Z]{2}[0-9]{2})/);
  if (!placa) placa = m(/\b([A-Z]{3}[\s-]?[0-9][A-Z0-9][0-9]{2})\b/);
  placa = placa.replace(/[\s-]/g, '');

  let renavam = m(/RENAVAM[^0-9]*(\d{9,11})/);
  if (!renavam) renavam = m(/\b(\d{9,11})\b/);

  let chassi = m(/CHASSI[^A-Z0-9]*([A-Z0-9]{17})/);
  if (!chassi) chassi = m(/\b([A-Z0-9]{17})\b/);

  // ── CRV ──
  const crv_numero = m(/(?:N[ÚU]MERO\s+(?:DO\s+)?CRV|CRV\s+N[ÚU]MERO)[^0-9]*(\d{9,12})/);
  const crv_codigo = m(/C[ÓO]DIGO\s+(?:DE\s+)?SEGURAN[CÇ]A[^0-9]*(\d{6,11})/);
  const crv_via    = m(/(?:N[ÚU]MERO\s+)?VIA[^0-9]*(\d)\b/);
  const crv_uf     = m(/(?:UF|ESTADO)\s+(?:DE\s+)?EMISS[ÃA]O[^A-Z]*([A-Z]{2})\b/);
  const datas      = txt.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  const crv_data   = datas[0] || '';

  // ── Vendedor ──
  const v_cpf  = m(/(?:VENDEDOR|ALIENANTE|TRANSMITENTE)[^0-9]*(\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\.\s\-]?\d{2})/);
  const v_nome = m(/(?:VENDEDOR|ALIENANTE|TRANSMITENTE)[^A-Z]*([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]{4,60}?)(?:\s{2,}|CPF|CNPJ)/);

  // ── Comprador ──
  const c_cpf  = m(/(?:COMPRADOR|ADQUIRENTE)[^0-9]*(\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\.\s\-]?\d{2})/);
  const c_nome = m(/(?:COMPRADOR|ADQUIRENTE)[^A-Z]*([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]{4,60}?)(?:\s{2,}|CPF|CNPJ)/);
  const c_cep  = m(/CEP[^0-9]*(\d{5}[\-]?\d{3})/);
  const c_uf   = m(/(?:ESTADO|UF)[^A-Z]*(?:DO\s+COMPRADOR)?[^A-Z]*([A-Z]{2})\b/);

  // ── Venda ──
  const venda_valor  = m(/VALOR[^0-9]*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/);
  const venda_data   = datas[1] || datas[0] || '';
  const venda_estado = m(/(?:MUNIC[ÍI]PIO|CIDADE)\s+(?:DA\s+)?VENDA[^A-Z]*[A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]+[\s,]+([A-Z]{2})\b/);

  if (!placa && !renavam && !chassi)
    return res.status(422).json({ error: 'Não foi possível extrair dados do PDF. Preencha manualmente.' });

  res.json({
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
  });
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
  try {
    const r = await pool.query(
      `UPDATE users SET name=$1,email=$2,phone=$3,role=$4,credits=$5 WHERE id=$6
       RETURNING id,name,email,phone,role,credits,active`,
      [name, email, phone||null, role, parseFloat(credits)||0, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ success: true, user: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro interno.' }); }
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

// ── Rotas HTML ────────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);
app.get('/entrar', (req, res) =>
  res.sendFile(path.join(__dirname, 'entrar.html'))
);
app.get('/cadastrar', (req, res) =>
  res.sendFile(path.join(__dirname, 'cadastrar.html'))
);
app.get('/cadastrar/revendedor', (req, res) =>
  res.sendFile(path.join(__dirname, 'cadastrar.html'))
);
app.get('/painel', requireAuth, (req, res) => {
  if (req.user.role === 'reseller' || req.user.role === 'admin')
    return res.redirect('/painel/revendedor');
  res.redirect('/painel/usuario');
});
app.get('/painel/usuario', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'painel-usuario.html'));
});
app.get('/recarga-pix', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'recarga-pix.html'));
});
app.get('/painel/revendedor', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'painel-revendedor.html'));
});
app.get('/admin', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length || r.rows[0].email !== SUPER_ADMIN_EMAIL) return res.redirect('/painel');
    res.sendFile(path.join(__dirname, 'admin.html'));
  } catch {
    res.redirect('/painel');
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
