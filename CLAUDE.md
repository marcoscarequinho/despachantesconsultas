# CLAUDE.md

Guia do projeto para o Claude Code. Plataforma B2B de consultas veiculares da **MC Despachadoria Consultas** (despachantes, lojistas e escritórios jurídicos): sistema pré-pago com recarga via PIX, painel de usuário, painel de revendedor e painel admin.

## Comandos

```bash
npm run dev              # roda o servidor local (node server.js, porta 3000)
node --check server.js   # valida sintaxe após editar o server
```

Deploy é feito na Vercel (`vercel.json` + `api/index.js`). Não há testes automatizados nem build step.

## Arquitetura

- **[server.js](server.js)** — TODO o backend em um único arquivo Express (~240 KB): auth (JWT em cookie), catálogo de serviços, proxy para APIs externas, cobrança de créditos, geração de PDF (pdfkit), PIX (Mercado Pago), WhatsApp (Z-API), crons e rotas admin. Banco: PostgreSQL via `pg` (tabelas criadas com `CREATE TABLE IF NOT EXISTS` no boot).
- **[api/index.js](api/index.js)** — entry point Vercel; apenas reexporta o app do `server.js` (Zero Config para honrar `maxDuration`). Rewrites em [vercel.json](vercel.json) mandam tudo para essa function.
- **Front-end** — HTML estático servido pelo próprio Express, sem framework: [index.html](index.html) (landing), [painel-usuario.html](painel-usuario.html) (painel principal — "Visão geral / Nova Consulta"), [painel-revendedor.html](painel-revendedor.html), [admin.html](admin.html), [entrar.html](entrar.html), [cadastrar.html](cadastrar.html), [recarga-pix.html](recarga-pix.html). Tailwind via CDN, JS inline em cada página.

## Catálogo de serviços (server.js)

- `SERVICES` — serviços da aba "Nova Consulta" (`/api/query`). Cada item tem `id`, `name`, `group`, `basePrice`, `inputType`, `icon`; opcionais: `noMarkup` (preço fixo, sem markup de 40%), `dcPath` (rota Datacube), `uf`.
- `SERVICES_V2` — aba "Opção 2 Nova Consulta" (`/api/query-v2`), fluxo isolado só com API Datacube.
- Markup padrão: `MARKUP = 1.40`; Infosimples usa `INFOSIMPLES_MARKUP = 1.70`.

### Integrações upstream

| Provedor | URL | Auth |
|---|---|---|
| Chekaki (base) | `https://chekaki.online` | header `chaveAcesso` (`CHAVE_ACESSO`) |
| Datacube | `https://api.consultasdeveiculos.com` | form-urlencoded `auth_token` (`DATACUBE_TOKEN`) |
| Portal Despachantes | `https://portaldespachantes.online` | header `chaveAcesso` (`PORTAL_DESP_KEY`) |
| AutoCRLV | `https://autocrlv.com.br` | Bearer (`AUTOCRLV_KEY`) |
| Infosimples | `https://api.infosimples.com/api/v2/consultas` | `INFOSIMPLES_TOKEN` |
| Mercado Pago (PIX) | `https://api.mercadopago.com` | `MP_ACCESS_TOKEN` |
| Z-API (WhatsApp) | `https://api.z-api.io` | `ZAPI_*` |

## Fluxo de /api/query (padrão importante)

1. Valida serviço, saldo e monta `apiUrl`/`body` por `serviceId` (blocos `if` sequenciais).
2. Chama a API upstream e valida a resposta ANTES de debitar créditos (nunca cobrar consulta sem resultado).
3. **Padrão "Débitos por Estado"**: quando a upstream devolve JSON mas o usuário deve receber um relatório, existe um builder `buildXxxPdfBuffer(service, data, params)` que monta o PDF com pdfkit usando os helpers `pdfReportHeader`, `pdfBar`, `pdfSubBar`, `pdfFieldGrid`, `pdfRenderGenericObject`, `pdfReportFooter`. Exemplos: `buildDebitoPdfBuffer`, `buildCnhPdfBuffer`, `buildLeilaoPdfBuffer`, `buildComunicacaoVendaPdfBuffer` (Inserir Comunicação Venda). Para adicionar um novo relatório PDF, siga esse padrão e conecte o buffer em `pdfToSend`, `result_type` e `resultData`.
4. Debita créditos, grava `transactions` + `queries` (`result_type`: `'pdf' | 'html' | 'json'`).
5. PDFs/HTML são salvos em `pdf_cache` por 7 dias (token) — o histórico do painel rebaixa por esse token, sem recobrar.
6. O front-end ([painel-usuario.html](painel-usuario.html) → `submitQuery`) decide pela `Content-Type`: `application/pdf` → download automático; JSON com `html_token` → abre `/api/html/:token`; senão renderiza JSON.

## API externa (/api/v1 — chave de API)

- Autenticação por chave `mcd_...` (header `X-API-Key` ou `Authorization: Bearer`), middleware `requireApiKey`. Só o SHA-256 fica na tabela `api_keys`; a chave completa aparece uma única vez na criação.
- Chaves são criadas pelo admin (modelo contratual, sem self-service): `POST /api/admin/api-keys` (`user_id`, `label`), `GET /api/admin/api-keys`, `PUT /api/admin/api-keys/:id/toggle`.
- Endpoints externos proxy para a Infosimples via `runExternalInfosimplesQuery` (parâmetros no corpo raiz, débito na conta dona da chave): `POST /api/v1/detran-mg/intencao-venda` e `POST /api/v1/detran-mg/atpve`.

## Convenções

- Idioma do código, comentários, mensagens de erro e UI: **português (pt-BR)**. Valores em BRL (`fmtMoneyBRL`).
- Comentários no server.js explicam decisões não óbvias (peculiaridades das APIs upstream, campos não documentados) — mantenha esse estilo.
- Validação de entrada sempre no servidor antes de chamar a upstream (placa 7 chars, renavam 11 dígitos, CPF 11/CNPJ 14, etc.), com mensagem de erro específica em português.
- Nunca logar CPF/CNPJ completos — use máscara (ver `maskDoc` no payload de comunicação de venda).
- Crons (Vercel): `/api/cron/broadcast-whatsapp`, `/api/cron/crlv-agendado-status`, `/api/cron/pix-reconcile`.

## Variáveis de ambiente (.env)

`DATABASE_URL`, `JWT_SECRET`, `CHAVE_ACESSO`, `MP_ACCESS_TOKEN`, `AUTOCRLV_KEY`, `PORTAL_DESP_KEY`, `DATACUBE_TOKEN`, `INFOSIMPLES_TOKEN`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`, `WEBHOOK_BASE_URL`, `ADMIN_PHONE`. O `.env` existe localmente e não é commitado.
