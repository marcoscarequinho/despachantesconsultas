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
| Vistocar (Débitos e Documentação, Código de Segurança CRV) | `https://vistocarconsulta.com.br/api/v1` | login JWT (`VISTOCAR_LOGIN`/`VISTOCAR_PASSWORD`, ver `getVistocarToken`), ver `VISTOCAR_ENDPOINTS` |
| ViaCEP | `https://viacep.com.br` | público, sem chave (só recupera acento de logradouro/bairro no ATPV-e, ver `repairAtpveAccents`) |
| Mercado Pago (PIX e cartão de débito) | `https://api.mercadopago.com` | `MP_ACCESS_TOKEN` (servidor) + `MP_PUBLIC_KEY` (navegador) |
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
| `consultar-crlv-ba` | `/consultar-crlv-ba` | R$ 30,00 |

O envio do PDF por WhatsApp é decidido pelo prefixo `consultar-crlv-`, então os ids fora desse padrão precisam estar em `CRLV_PORTAL_PDF_SVCS` — esquecer disso não quebra a consulta, só faz o cliente parar de receber o documento no WhatsApp. A chave Geral (pós-paga) do `crlv-rj-reemissao-2` usa a mesma rota em `runCrlvRj2General`.

**CRLV-e Agendado** (`PORTAL_AGENDADO_SVCS`, **hoje vazio** — o CE agendado foi removido do catálogo e o caminho segue de pé para os pedidos `PORTAL-` já criados) — mesmo contrato dos agendados da Chekaki (`POST /api/crlv-agendado/solicitar` → `pedido_id`; `GET /api/crlv-agendado/:id` → status; `GET .../:id/pdf`), só muda o host e a chave, então reaproveita `crlv_agendado_pending` e o cron `runCrlvAgendadoPendingCheck` (entrega por WhatsApp, estorno em 48h). O `pedido_id` do portal é numérico igual ao da Chekaki: ele é gravado, exibido e devolvido na resposta com o prefixo `PORTAL-` (`PORTAL_PEDIDO_PREFIX`, mesma convenção do `AUTOCRLV-`) — é isso que faz o "Ver Status" e o cron perguntarem no host certo, inclusive quando o cliente copia o id da tela.

O CE hoje é só `crlv-ce-instantaneo`: passou pela Vistocar (`apiclient/crlv-ce` + webhook) e pelo agendado do portal antes de ficar só na emissão na hora. Por isso `VISTOCAR_ASYNC_SVCS` e `PORTAL_AGENDADO_SVCS` estão vazios — os dois caminhos continuam de pé para entregar pedido antigo (`vistocar_pending`, `crlv_agendado_pending`).

O resto do grupo "CRLV-e Digital" continua na Chekaki (`placa_renavam_cpf`), com **uma exceção**: o `consultar-crlv-ba`, que está no portal (`PORTAL_PLACA_MAP`, doc de 26/08/2026) e por isso é `inputType:'placa'` — a rota da Chekaki pedia placa+renavam+CPF e tinha um campo de documento só, o que recusava proprietário pessoa jurídica. É o único id do `PORTAL_PLACA_MAP` que já começa com `consultar-crlv-`: o PDF sai no WhatsApp pela regra do prefixo, então ele **não** entra em `CRLV_PORTAL_PDF_SVCS` (entraria em duplicidade). No meio do caminho a BA passou pela Vistocar (`apiclient/crlv-ba`): a rota existe na conta, mas responde `500 "Erro interno. Saldo estornado."` em toda chamada — com placa válida, com placa inválida e até sem placa nenhuma —, ou seja, falha antes de olhar a entrada; não vale reativar sem eles confirmarem que arrumaram.

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
- **ATPV-e MG, SP e MS** (`/api/v1/atpve-mg/*`, `/api/v1/atpve-sp/*`, `/api/v1/atpve-ms/*`): proxy transparente 1:1 para a API ATPV-e da Chekaki via `proxyAtpveExternal(req, res, uf, path, opts)`, com as rotas geradas em loop por `ATPVE_EXTERNAL_UFS` (MG substituiu os antigos `POST /api/v1/detran-mg/intencao-venda` e `POST /api/v1/detran-mg/atpve` da Infosimples). 9 rotas por UF espelhando a upstream: `GET /api/v1/atpve-<uf>` (listar), `POST .../cadastrar`, `GET .../:id`, `GET .../:id/pdf`, `GET .../:id/pdf/base64`, `POST .../:id/atualizar`, `POST .../:id/registrar`, `POST .../:id/excluir`, `GET .../protocolo/:protocolo`. Só o `cadastrar` cobra (`EXTERNAL_API_PRICE`), após sucesso da upstream; as demais rotas gerenciam pedido já pago e são gratuitas. O `cadastrar` aceita anexos em Base64 (`ATPVE_ANEXO_FIELDS`: CRLV-e, CNH e comprovante de endereço das duas partes — documentados para SP); eles nunca são gravados em `queries.params` (ver `stripAtpveAnexos`). Respostas (PDF ou JSON) são repassadas como vêm da upstream. Para expor outro estado, basta acrescentar a UF em `ATPVE_EXTERNAL_UFS` e o rótulo em `AVULSA_SERVICE_NAMES` ([admin.html](admin.html)).
- Preço fixo por consulta externa: `EXTERNAL_API_PRICE` (R$ 5,00) — não usa a tabela Infosimples nem markup.
- **Consulta avulsa** (`/consulta-avulsa` + [consulta-avulsa.html](consulta-avulsa.html)): fluxo público sem cadastro — `POST /api/public/pedido` valida os campos e cria PIX no Mercado Pago (tabela `public_orders`); `GET /api/public/pedido/:token` faz polling, confirma o pagamento e só então executa a consulta na Infosimples (claim atômico `UPDATE ... WHERE status='PENDING'` impede execução dupla). Serviços em `PUBLIC_PAY_SERVICES`, mesmo preço de R$ 5,00. A página exige **código de acesso por cliente** (tabela `public_access_codes`, gerado no admin em Consultas Avulsas; link `?codigo=XXXXXX` validado no servidor antes de servir o HTML — sem código volta para a home). O código usado fica gravado em cada pedido (`public_orders.access_code`). Página com `noindex` (meta + X-Robots-Tag + robots.txt) — divulgada só por link direto.
- **Chave de API geral (pós-paga)**: `api_keys.user_id` NULL (`POST /api/admin/api-keys` com `general:true`). Consultas com chave geral não debitam ninguém — ficam em `api_general_queries` e aparecem no admin em **Cobranças API**, onde o admin digita o WhatsApp do cliente final e envia o PIX de R$ 5,00 daquela placa (QR como imagem via `sendWhatsAppImage` + copia-e-cola como texto; rotas `/api/admin/api-cobrancas`, `/:id/cobrar`, `/:id/verificar` — `charge_status`: `NONE|PENDING|PAID`).

## Pagamento: PIX (0%) e cartão de crédito (+7%) — débito desligado

Toda cobrança do cliente aceita PIX sem acréscimo ou cartão com acréscimo — `CARTAO_ACRESCIMOS = { debit_card: 0.05, credit_card: 0.07 }` / `valorComAcrescimoCartao` no server.js, calculado **sempre no servidor** (o front só exibe).

**O débito está desligado** em `CARTAO_TIPOS_HABILITADOS = { debito: false, credito: true }`. Motivo: a conta do Mercado Pago não tem débito habilitado — a busca de meios pela public key (o que o formulário enxerga) devolve `credit_card`, `prepaid_card`, `ticket`, `bank_transfer` e `account_money`, e **nenhum** `debit_card`; com a chave de acesso aparece um `debelo` ativo que não sai nessa busca. Na prática, todo cartão de débito digitado voltava com a bandeira de crédito e o cliente levava um "esse cartão é de crédito" na cara. O que a tela oferece é o **E** de duas coisas: o interruptor acima e `mpTiposCartaoDisponiveis()` (cache de 1h da busca pela public key). Para religar quando o MP habilitar: trocar `debito` para `true` — o resto já está pronto e testado. São três telas: recarga de créditos (`POST /api/cartao/recarga`), assinatura (`POST /api/cartao/assinatura`) e consulta avulsa (`POST /api/public/pedido/cartao`); a Cobrança API do admin continua só em PIX, porque ela vai por WhatsApp e precisaria de página de pagamento própria.

- **Quem decide o acréscimo é a bandeira, não a tela**: `validarCartao` busca o `payment_method_id` na lista `/v1/payment_methods` do MP e usa o `payment_type_id` que vier de lá. O corpo traz `tipo_cartao` com a aba escolhida pelo cliente e, se não bater, a compra é **recusada** em vez de cobrada — quem leu 5% na tela não pode ser cobrado 7%. O que não está em `CARTAO_ACRESCIMOS` (pré-pago, voucher, saldo) não é aceito.
- **Sempre à vista** (`installments: 1`, `maxInstallments: 1` no brick): no parcelado a taxa do MP cresce por parcela e passaria dos 7%. Parcelamento exigiria acréscimo por número de parcelas.
- **O formulário é nosso, por causa do escaneamento** ([assets/pagamento-cartao.js](assets/pagamento-cartao.js)): usamos `mp.cardForm({ iframe: false })`, com `<input>` da própria página, e **não** o Card Payment Brick. Motivo: os campos do brick são iframes de `secure-fields.mercadopago.com` com `autocomplete="off"`, e com isso o celular não oferece o "Escanear cartão" pela câmera nem o cartão salvo. Nos nossos inputs marcamos `cc-number`/`cc-exp-month`/`cc-exp-year`/`cc-csc` — e a validade é dividida em mês e ano porque o iOS só preenche a data assim. **O SDK sobrescreve esses atributos para `off` ao montar**, então `reforcarAutocomplete()` os repõe no `onFormMounted` e a cada foco; reposto, o valor fica.
- **O preço disso é PCI**: o número do cartão passa a existir no JavaScript desta página (o SDK lê o input e tokeniza direto com o MP). Continua **não** chegando ao nosso servidor — o backend só vê o token de uso único —, mas o site sai de SAQ A para **SAQ A-EP**. Consequência para quem mexer aqui: nunca logar, guardar, copiar ou enviar o valor de `#form-checkout__cardNumber`. Decisão tomada pelo dono do negócio com esse custo na mesa.
- **Cartão de função dupla**: o BIN aparece nos dois tipos e o cardForm escolhe um sozinho. Antes de enviar, trocamos pelo `payment_method_id` que casa com a aba escolhida (`onPaymentMethodsReceived` guarda a lista); sem correspondência, o pedido é recusado com a mensagem certa.
- **3DS**: `three_d_secure_mode: 'optional'` com `binary_mode: false`. No débito o emissor quase sempre pede o desafio: a resposta volta `pending`/`pending_challenge` com `three_ds_info`, que o front entrega ao Status Screen Brick. Por isso o pagamento no cartão **não é confirmado na resposta da rota** — quem confirma é o mesmo polling do PIX (`/api/pix/status/:id` ou `/api/public/pedido/:token`), mais o webhook e o cron `runPixReconcile`.
- **Colunas**: `pix_payments.value` e `public_orders.amount` continuam sendo o valor LÍQUIDO (o crédito que o cliente recebe / o preço do serviço) — é o que credita. O cobrado com acréscimo fica em `charged_value`/`charged_amount`, e `method` diz `PIX`, `CARTAO` (débito, nome herdado do primeiro dia do cartão) ou `CREDITO`.

## ATPV-e: conferência da intenção de venda e estorno automático

O ATPV-e sair não garante que o DETRAN atribuiu a **intenção de venda** ao veículo — e é a restrição, não o papel, que o cliente comprou. Por isso todo pedido concluído entra na tabela `atpve_verificacoes` (`agendarVerificacaoIntencaoVenda`, chamada em `finalizeAtpveQuery` e, na API externa, quando o `cadastrar` já devolve o PDF).

O rastreio é sempre **depois**, nunca antes: o cron do ATPV-e (`/api/cron/atpve-rj-status`, a cada 5 min) roda `runAtpveIntencaoVendaCheck`, que só pega o que passou de `ATPVE_VERIFICACAO_HORAS` (2h) **contadas da conclusão do pedido** (`concluida_em`), não do cadastro — a base nacional não reflete o registro na mesma hora, e conferir cedo estornaria pedido bom. A consulta é o `/veiculos/bin-nacional` da Datacube (o mesmo `dc-bin-nacional` da aba "Opção 2 Nova Consulta"), e a restrição é procurada em `restricoes_e_impedimentos.restricoes_list` / `.restricoes` (a Datacube devolve sem acento: `INTENCAO VENDA`).

- **Achou** → marca `COM_INTENCAO` e encerra.
- **Não achou** → `refundQuery` devolve o valor (idempotente, marca a consulta como `estornado`) e avisa cliente e admin no WhatsApp.
- **Indeterminado** (API fora do ar) → conta a tentativa e volta na próxima passada; em `ATPVE_VERIFICACAO_TENTATIVAS` (5) sem resposta, avisa o admin e para — nada é estornado no escuro.

Cada conferência custa uma consulta Datacube, paga pela casa. **Só vale daqui para frente**: entra na fila apenas o pedido concluído *naquela chamada* — `finalizePendingQuery` devolve `true` só quando ele estava `aguardando_pdf` e virou `success`. É esse guarda que impede um ATPV-e antigo de ser enfileirado (e, no limite, estornado) quando o usuário abre "Meus ATPV-e" e clica numa ação que devolve o PDF de novo, já que `finalizeAtpveQuery` roda outra vez. O histórico não é reprocessado. Na API externa, pedido que volta JSON (em análise) fica de fora — quem o conclui é o parceiro pelo `/registrar`, caminho que não passa pelo agendamento.

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

`DATABASE_URL`, `JWT_SECRET`, `CHAVE_ACESSO`, `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY`, `AUTOCRLV_KEY`, `PORTAL_DESP_KEY`, `DATACUBE_TOKEN`, `INFOSIMPLES_TOKEN`, `DESPBRASIL_KEY`, `CONSULTASFACIL_KEY`, `VISTOCAR_LOGIN`, `VISTOCAR_PASSWORD`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`, `WEBHOOK_BASE_URL`, `ADMIN_PHONE`. O `.env` existe localmente e não é commitado.
