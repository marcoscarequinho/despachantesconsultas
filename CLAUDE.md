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
- **Gerar ASD RJ** (aba "Coisas de Despachantes"): o PDF **reproduz o formulário oficial em papel do CRDD-RJ**, em preto e branco. As coordenadas em `ASD_FAIXAS`/`ASD_TABELA` foram medidas no modelo escaneado (1240x1753 px = A4 a 150 dpi) e viram ponto por `asdPx()` — são as linhas do próprio formulário, não um layout livre; mexer num número é sair do modelo. Cada célula é `rótulo + valor`, e o valor encolhe até 5.5pt em vez de quebrar linha. Célula sem dado sai em branco de propósito (o despachante completa à mão): só Serviço, UF, Contratante, Profissional e Beneficiário são obrigatórios, o resto está em `ASD_CAMPOS_OPCIONAIS` (uma lista só, usada no hash da cadeia e no desenho). Os campos do veículo (Espécie, Capacidade, Procedência, Categoria, Tipo, Potência, Combustível, Município) vêm da busca por placa (`extractProprietarioAtualFields`). O QR de verificação fica numa coluna à esquerda e as digitalizações da carteirinha ocupam a metade de baixo da **mesma** folha, frente e verso lado a lado. O brasão vem de `ASD_LOGOS` (só `rj` hoje, `ASD_LOGO_PADRAO = 'rj'`); para oferecer outro estado, coloque o PNG em `assets/` e acrescente uma linha — o painel monta o menu por `GET /api/asd-logos` e o esconde enquanto houver uma opção só.

### Integrações upstream

| Provedor | URL | Auth |
|---|---|---|
| Chekaki (base) | `https://chekaki.online` | header `chaveAcesso` (`CHAVE_ACESSO`) |
| Datacube | `https://api.consultasdeveiculos.com` | form-urlencoded `auth_token` (`DATACUBE_TOKEN`) |
| Portal Despachantes (inclui os 3 CRLV-e do Rio) | `https://portaldespachantes.online` | header `chaveAcesso` (`PORTAL_DESP_KEY`), ver `PORTAL_PLACA_MAP` |
| AutoCRLV | `https://autocrlv.com.br` | Bearer (`AUTOCRLV_KEY`) |
| Infosimples | `https://api.infosimples.com/api/v2/consultas` | `INFOSIMPLES_TOKEN` |
| Despbrasil (CRLV Rio Reemissão, Código de Segurança CRV) | `https://despbrasil.com.br/functions/apiConsulta` | header `chaveAcesso` (`DESPBRASIL_KEY`), ver `DESPBRASIL_SVCS` |
| Consultas Fácil (CRLV Rio Reemissão v2) | `https://www.consultasfacil.net` | header `chaveAcesso` (`CONSULTASFACIL_KEY`) |
| Vistocar (Débitos e Documentação, Código de Segurança CRV, CRLV-e BA) | `https://vistocarconsulta.com.br/api/v1` | login JWT (`VISTOCAR_LOGIN`/`VISTOCAR_PASSWORD`, ver `getVistocarToken`), ver `VISTOCAR_ENDPOINTS` |
| Mercado Pago (PIX) | `https://api.mercadopago.com` | `MP_ACCESS_TOKEN` |
| Z-API (WhatsApp) | `https://api.z-api.io` | `ZAPI_*` |

### CRLV-e no Portal Despachantes

Quase todo o CRLV-e do catálogo saiu para o `portaldespachantes.online` (docs "Documentação de Integração", 24/08/2026). Dois contratos, os dois com header `chaveAcesso` (`PORTAL_DESP_KEY`):

**PDF na hora** — `POST { placa }` e o PDF pronto em bytes; erro é JSON `{ error }`. Ligar/mudar um é uma linha em `PORTAL_PLACA_MAP`:

| Serviço | Rota | Preço |
|---|---|---|
| `consultar-crlv-rj` | `/consultar-crlv-rj` | R$ 20,00 |
| `crlv-rj-reemissao-2` | `/consultar-crlv-rj2` | R$ 55,00 |
| `crlv-pe-instantaneo` | `/consultar-crlv-pe` | R$ 35,00 |
| `crlv-ce-instantaneo` | `/consultar-crlv-ce` | R$ 32,50 |

O envio do PDF por WhatsApp é decidido pelo prefixo `consultar-crlv-`, então os ids fora desse padrão precisam estar em `CRLV_PORTAL_PDF_SVCS` — esquecer disso não quebra a consulta, só faz o cliente parar de receber o documento no WhatsApp. A chave Geral (pós-paga) do `crlv-rj-reemissao-2` usa a mesma rota em `runCrlvRj2General`.

**CRLV-e Agendado** (`PORTAL_AGENDADO_SVCS`, **hoje vazio** — o CE agendado foi removido do catálogo e o caminho segue de pé para os pedidos `PORTAL-` já criados) — mesmo contrato dos agendados da Chekaki (`POST /api/crlv-agendado/solicitar` → `pedido_id`; `GET /api/crlv-agendado/:id` → status; `GET .../:id/pdf`), só muda o host e a chave, então reaproveita `crlv_agendado_pending` e o cron `runCrlvAgendadoPendingCheck` (entrega por WhatsApp, estorno em 48h). O `pedido_id` do portal é numérico igual ao da Chekaki: ele é gravado, exibido e devolvido na resposta com o prefixo `PORTAL-` (`PORTAL_PEDIDO_PREFIX`, mesma convenção do `AUTOCRLV-`) — é isso que faz o "Ver Status" e o cron perguntarem no host certo, inclusive quando o cliente copia o id da tela.

O CE hoje é só `crlv-ce-instantaneo`: passou pela Vistocar (`apiclient/crlv-ce` + webhook) e pelo agendado do portal antes de ficar só na emissão na hora. Por isso `VISTOCAR_ASYNC_SVCS` e `PORTAL_AGENDADO_SVCS` estão vazios — os dois caminhos continuam de pé para entregar pedido antigo (`vistocar_pending`, `crlv_agendado_pending`).

O resto do grupo "CRLV-e Digital" continua na Chekaki (`placa_renavam_cpf`), com **uma exceção**: o `consultar-crlv-ba` foi para a Vistocar (`apiclient/crlv-ba`, entrada em `VISTOCAR_ENDPOINTS`), que é **síncrona** — devolve o envelope `{ status, message, response: { pdfBase64, paid, success } }` já tratado no ramo comum dos serviços Vistocar, não entra em `VISTOCAR_ASYNC_SVCS`. Como todo `apiclient` da Vistocar, o corpo é só `{ plate }`, então a BA virou `inputType:'placa'`: foi essa troca que resolveu o proprietário pessoa jurídica (a rota da Chekaki tinha um campo `cpf` só e recusava CNPJ). O id dela começa com `consultar-crlv-`, então o envio do PDF por WhatsApp cai na primeira regra — a dos serviços Vistocar exclui esse prefixo justamente para o cliente não receber o documento duas vezes.

## Fluxo de /api/query (padrão importante)

1. Valida serviço, saldo e monta `apiUrl`/`body` por `serviceId` (blocos `if` sequenciais).
2. Chama a API upstream e valida a resposta ANTES de debitar créditos (nunca cobrar consulta sem resultado). **Exceção: Intenção de Venda (ATPV-e)** — cobra assim que a Chekaki aceita o cadastro (situação CADASTRADA), mesmo que o PDF saia depois; a consulta fica em `aguardando_pdf` já com `transaction_id`, e se o documento não for emitido o admin devolve manualmente (o cron `runAtpvePendingCheck` avisa admin e cliente em vez de estornar).
3. **Padrão "Débitos por Estado"**: quando a upstream devolve JSON mas o usuário deve receber um relatório, existe um builder `buildXxxPdfBuffer(service, data, params)` que monta o PDF com pdfkit usando os helpers `pdfReportHeader`, `pdfBar`, `pdfSubBar`, `pdfFieldGrid`, `pdfRenderGenericObject`, `pdfReportFooter`. Exemplos: `buildDebitoPdfBuffer`, `buildCnhPdfBuffer`, `buildLeilaoPdfBuffer`, `buildComunicacaoVendaPdfBuffer` (Inserir Comunicação Venda). Para adicionar um novo relatório PDF, siga esse padrão e conecte o buffer em `pdfToSend`, `result_type` e `resultData`.
4. Debita créditos, grava `transactions` + `queries` (`result_type`: `'pdf' | 'html' | 'json'`).
5. PDFs/HTML são salvos em `pdf_cache` por 7 dias (token) — o histórico do painel rebaixa por esse token, sem recobrar.
6. O front-end ([painel-usuario.html](painel-usuario.html) → `submitQuery`) decide pela `Content-Type`: `application/pdf` → download automático; JSON com `html_token` → abre `/api/html/:token`; senão renderiza JSON.

## API externa (/api/v1 — chave de API)

- Autenticação por chave `mcd_...` (header `X-API-Key` ou `Authorization: Bearer`), middleware `requireApiKey`. Só o SHA-256 fica na tabela `api_keys`; a chave completa aparece uma única vez na criação.
- Chaves são criadas pelo admin (modelo contratual, sem self-service): `POST /api/admin/api-keys` (`user_id`, `label`), `GET /api/admin/api-keys`, `PUT /api/admin/api-keys/:id/toggle`.
- **ATPV-e MG e SP** (`/api/v1/atpve-mg/*`, `/api/v1/atpve-sp/*`): proxy transparente 1:1 para a API ATPV-e da Chekaki via `proxyAtpveExternal(req, res, uf, path, opts)`, com as rotas geradas em loop por `ATPVE_EXTERNAL_UFS` (MG substituiu os antigos `POST /api/v1/detran-mg/intencao-venda` e `POST /api/v1/detran-mg/atpve` da Infosimples). 9 rotas por UF espelhando a upstream: `GET /api/v1/atpve-<uf>` (listar), `POST .../cadastrar`, `GET .../:id`, `GET .../:id/pdf`, `GET .../:id/pdf/base64`, `POST .../:id/atualizar`, `POST .../:id/registrar`, `POST .../:id/excluir`, `GET .../protocolo/:protocolo`. Só o `cadastrar` cobra (`EXTERNAL_API_PRICE`), após sucesso da upstream; as demais rotas gerenciam pedido já pago e são gratuitas. O `cadastrar` aceita anexos em Base64 (`ATPVE_ANEXO_FIELDS`: CRLV-e, CNH e comprovante de endereço das duas partes — documentados para SP); eles nunca são gravados em `queries.params` (ver `stripAtpveAnexos`). Respostas (PDF ou JSON) são repassadas como vêm da upstream. Para expor outro estado, basta acrescentar a UF em `ATPVE_EXTERNAL_UFS` e o rótulo em `AVULSA_SERVICE_NAMES` ([admin.html](admin.html)).
- Preço fixo por consulta externa: `EXTERNAL_API_PRICE` (R$ 5,00) — não usa a tabela Infosimples nem markup.
- **Consulta avulsa** (`/consulta-avulsa` + [consulta-avulsa.html](consulta-avulsa.html)): fluxo público sem cadastro — `POST /api/public/pedido` valida os campos e cria PIX no Mercado Pago (tabela `public_orders`); `GET /api/public/pedido/:token` faz polling, confirma o pagamento e só então executa a consulta na Infosimples (claim atômico `UPDATE ... WHERE status='PENDING'` impede execução dupla). Serviços em `PUBLIC_PAY_SERVICES`, mesmo preço de R$ 5,00. A página exige **código de acesso por cliente** (tabela `public_access_codes`, gerado no admin em Consultas Avulsas; link `?codigo=XXXXXX` validado no servidor antes de servir o HTML — sem código volta para a home). O código usado fica gravado em cada pedido (`public_orders.access_code`). Página com `noindex` (meta + X-Robots-Tag + robots.txt) — divulgada só por link direto.
- **Chave de API geral (pós-paga)**: `api_keys.user_id` NULL (`POST /api/admin/api-keys` com `general:true`). Consultas com chave geral não debitam ninguém — ficam em `api_general_queries` e aparecem no admin em **Cobranças API**, onde o admin digita o WhatsApp do cliente final e envia o PIX de R$ 5,00 daquela placa (QR como imagem via `sendWhatsAppImage` + copia-e-cola como texto; rotas `/api/admin/api-cobrancas`, `/:id/cobrar`, `/:id/verificar` — `charge_status`: `NONE|PENDING|PAID`).

## Convenções

- Idioma do código, comentários, mensagens de erro e UI: **português (pt-BR)**. Valores em BRL (`fmtMoneyBRL`).
- Comentários no server.js explicam decisões não óbvias (peculiaridades das APIs upstream, campos não documentados) — mantenha esse estilo.
- Validação de entrada sempre no servidor antes de chamar a upstream (placa 7 chars, renavam 11 dígitos, CPF 11/CNPJ 14, etc.), com mensagem de erro específica em português.
- Nunca logar CPF/CNPJ completos — use máscara (ver `maskDoc` no payload de comunicação de venda).
- Crons (Vercel): `/api/cron/broadcast-whatsapp`, `/api/cron/crlv-agendado-status` (roda também `runVistocarPendingCleanup`), `/api/cron/pix-reconcile`.
- **Consultas assíncronas da Vistocar** (`VISTOCAR_ASYNC_SVCS` — **hoje vazio**, o CE migrou para o Portal Despachantes; o fluxo abaixo segue de pé para os pedidos antigos e para habilitar outra UF): o POST em `apiclient/<uf>` só registra a consulta (devolve `movementId`) e a Vistocar notifica `POST /api/webhooks/vistocar` com `consulta.pendente`/`consulta.atualizada`. A notificação **não traz o PDF** — quando `data.resultAvailable` é true, o documento é buscado em `GET /apiclient/consult/:movementId` com o JWT de sempre (`entregarResultadoVistocar`). A consulta fica `aguardando_pdf` e **só é cobrada na entrega** (`finalizePendingQuery`). O endpoint é cadastrado pela própria API (`registrarWebhookVistocar` → `POST /apiclient/webhook/save`, rotas admin `/api/admin/vistocar-webhook`) e a `chaveSeguranca` fica na tabela `vistocar_webhook_config`, não em variável de ambiente; ela valida o header `X-Webhook-Signature` (HMAC-SHA256 do corpo bruto + timestamp — daí o `verify` no `express.json`). Reenvios são deduplicados por `event_id`. `runVistocarPendingCheck` (no cron do CRLV) rebusca o resultado das pendências, cobrindo notificação perdida, e cancela sem cobrar depois de 48h. A doc da Vistocar lista DF/ES/PB/RN/RS/SC e ATPV-e como produtos desse mesmo fluxo, **mas essas rotas ainda não existem na nossa conta** (21/08/2026: `apiclient/crlv-df`, `crlv-es`, `crlv-pb`, `crlv-rn`, `crlv-rs`, `crlv-sc`, `atpve` respondem o 500 genérico do Spring, idêntico ao de um caminho inventado — só `crlv-ce`/`crlv-pe`/`crlv-rj`/`base-estadual`/`completa`/`dossie-veicular` devolvem o envelope da aplicação). Quando forem liberadas, habilitar cada uma é: rota em `VISTOCAR_ENDPOINTS` + serviço em `SERVICES` + id em `VISTOCAR_ASYNC_SVCS` — não precisa de bloco novo em `processCatalogQuery`.

### Aba "Visão Geral" (painel-usuario.html)

A Visão Geral é a **vitrine de consultas**, não um menu de atalhos: abaixo dos cards de saldo/estatísticas ela lista **todos os serviços de `/api/services`** (as abas "Acesse Aqui Para as Principais Consultas", "Intenção de Venda (ATPVE)" e "Coisas de Despachantes") em cards com busca (`#catalog-search`, sem acento e por palavra) e filtro por grupo (`#catalog-filters`). É só front-end e não duplica catálogo nem formulário — `openCatalogService` chama `quickSelect`, que leva para a aba de origem já com o serviço aberto (grupo "Para os Despachantes" → aba Despachantes; "Intenção de Venda (ATPVE)" → aba própria; o resto → "Acesse Aqui..."). A ordem dos blocos vem de `CATALOG_GROUP_ORDER` e o ícone/selo de cada grupo de `CATALOG_GROUP_META`; grupo novo no `server.js` aparece sozinho, no fim. `CATALOG_DESTAQUES` (lista de ids) sobe consultas para o bloco "⭐ Destaques" no topo: o card **sai** do bloco do grupo dele e aparece só lá — nada é duplicado e os chips continuam contando pelo grupo real (`catalogGroupOf`). As demais seções (Opção 2, Infosimples, Consultas Extras, Histórico, Preços, Integração API) **não têm card aqui de propósito** — ficam só no menu lateral, cada uma com sua cor, porque os atalhos escondiam as consultas.

### Aba "Consultas Extras" (painel-usuario.html)

Vitrine que reúne num lugar só os CRLV-e que **não saem na hora** (DF, ES, PB, RN, RS, SC) mais o ATPV-e — os produtos que a doc da Vistocar trata como assíncronos. É só front-end: `EXTRAS_SERVICE_IDS` aponta para os serviços que atendem cada UF hoje (Chekaki no `crlv-agendado-*`, Datacube no `dc-crlve-rs-v2`), que continuam também nas abas de origem — nada é duplicado no catálogo. O ATPV-e é um atalho para a aba "Intenção de Venda (ATPVE)", que tem formulário próprio. O formulário/resultado é o mesmo `#query-form-host` das abas "Acesse Aqui..." e "Coisas de Despachantes" (ver `FORM_SLOTS` em `showSection`).

## Variáveis de ambiente (.env)

`DATABASE_URL`, `JWT_SECRET`, `CHAVE_ACESSO`, `MP_ACCESS_TOKEN`, `AUTOCRLV_KEY`, `PORTAL_DESP_KEY`, `DATACUBE_TOKEN`, `INFOSIMPLES_TOKEN`, `DESPBRASIL_KEY`, `CONSULTASFACIL_KEY`, `VISTOCAR_LOGIN`, `VISTOCAR_PASSWORD`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`, `WEBHOOK_BASE_URL`, `ADMIN_PHONE`. O `.env` existe localmente e não é commitado.
