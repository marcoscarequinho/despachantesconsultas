# API Externa — MC Despachadoria Consultas

Documentação de integração para clientes contratantes da API. Acesso mediante contrato — a chave de API é fornecida pela MC Despachadoria já vinculada à conta que será debitada.

- **URL base:** `https://www.despachantesconsultas.com.br`
- **Autenticação:** header `X-API-Key: mcd_...` (ou `Authorization: Bearer mcd_...`)
- **Preço:** R$ 5,00 por **cadastro** bem-sucedido de ATPV-e (MG ou SP), debitados dos créditos pré-pagos da conta. Os demais endpoints (consultar, baixar PDF, atualizar, registrar, excluir) são gratuitos — gerenciam um pedido já cadastrado. Requisições que falham (validação, erro do DETRAN, saldo insuficiente) **não são cobradas**.
- **Formato:** requisição em JSON (`Content-Type: application/json`); resposta em **PDF** (`application/pdf`, bytes do arquivo) nos endpoints de documento ou JSON conforme o endpoint.

> ⚠️ A chave deve ser usada apenas **servidor a servidor** (Node, PHP, etc.). Não chame a API a partir do navegador: a chave ficaria exposta e a API não libera CORS.

## Endpoints — ATPV-e MG e SP

São os mesmos 9 endpoints para cada estado: troque `{uf}` por `mg` ou `sp` na rota (`/api/v1/atpve-mg/...` ou `/api/v1/atpve-sp/...`). Os pedidos de cada estado são independentes — um `:id` de SP só existe nas rotas de SP.

| # | Método | Rota | Descrição | Cobra? |
|---|---|---|---|---|
| 1 | `POST` | `/api/v1/atpve-{uf}/cadastrar` | Cadastrar novo ATPV-e | **R$ 5,00** |
| 2 | `GET` | `/api/v1/atpve-{uf}` | Listar pedidos | Não |
| 3 | `GET` | `/api/v1/atpve-{uf}/:id` | Consultar por ID | Não |
| 4 | `GET` | `/api/v1/atpve-{uf}/protocolo/:protocolo` | Consultar por protocolo | Não |
| 5 | `GET` | `/api/v1/atpve-{uf}/:id/pdf` | Baixar PDF | Não |
| 6 | `GET` | `/api/v1/atpve-{uf}/:id/pdf/base64` | PDF em Base64 | Não |
| 7 | `POST` | `/api/v1/atpve-{uf}/:id/atualizar` | Atualizar situação/PDF | Não |
| 8 | `POST` | `/api/v1/atpve-{uf}/:id/registrar` | Registrar no DETRAN | Não |
| 9 | `POST` | `/api/v1/atpve-{uf}/:id/excluir` | Excluir pedido | Não |

Os endpoints `POST` com `:id` não exigem corpo (envie `{}`).

### 1. Cadastrar ATPV-e

```
POST /api/v1/atpve-mg/cadastrar
POST /api/v1/atpve-sp/cadastrar
```

Campos do corpo (JSON):

| Campo | Descrição |
|---|---|
| `placa` | Placa do veículo (ex.: `ABC1D23`) |
| `renavam` | Renavam do veículo, só números |
| `ano_fabricacao` / `ano_modelo` | Anos do veículo (ex.: `"2020"`) |
| `chassi` | Chassi do veículo (17 caracteres) |
| `kilometragem` | Leitura do hodômetro (ex.: `"50000"`) |
| `crv_numero` | Número do CRV |
| `crv_numero_via` | Via do CRV (ex.: `"1"`) |
| `crv_uf_emissao` | UF de emissão do CRV (ex.: `"MG"` ou `"SP"`) |
| `crv_data_emissao` | Data de emissão, formato `dd/mm/aaaa` |
| `crv_codigo_seguranca` | Código de segurança do CRV |
| `vendedor_tipo_pessoa` | `"F"` (física) ou `"J"` (jurídica) |
| `vendedor_documento` | CPF (11) ou CNPJ (14), só números |
| `vendedor_nome` / `vendedor_email` | Dados do vendedor |
| `venda_cidade` / `venda_uf` | Local da venda |
| `venda_valor` | Valor da venda, formato `"25000,00"` |
| `venda_data` | Data da venda, formato `dd/mm/aaaa` |
| `comprador_tipo_pessoa` | `"F"` ou `"J"` |
| `comprador_documento` | CPF ou CNPJ do comprador, só números |
| `comprador_nome` / `comprador_email` | Dados do comprador |
| `comprador_cep` | CEP, só números (8 dígitos) |
| `comprador_logradouro` / `comprador_numero` / `comprador_complemento` / `comprador_bairro` / `comprador_cidade` / `comprador_uf` | Endereço do comprador |

Payload de exemplo:

```json
{
  "placa": "ABC1D23",
  "renavam": "12345678901",
  "ano_fabricacao": "2020",
  "ano_modelo": "2020",
  "chassi": "9BWZZZ377VT004251",
  "kilometragem": "50000",
  "crv_numero": "123456789012",
  "crv_numero_via": "1",
  "crv_uf_emissao": "MG",
  "crv_data_emissao": "01/01/2024",
  "crv_codigo_seguranca": "12345678901234",
  "vendedor_tipo_pessoa": "F",
  "vendedor_documento": "12345678901",
  "vendedor_nome": "VENDEDOR TESTE",
  "vendedor_email": "vendedor@email.com",
  "venda_cidade": "BELO HORIZONTE",
  "venda_uf": "MG",
  "venda_valor": "25000,00",
  "venda_data": "01/01/2025",
  "comprador_tipo_pessoa": "F",
  "comprador_documento": "98765432100",
  "comprador_nome": "COMPRADOR TESTE",
  "comprador_email": "comprador@email.com",
  "comprador_cep": "20040020",
  "comprador_logradouro": "RUA EXEMPLO",
  "comprador_numero": "100",
  "comprador_complemento": "-",
  "comprador_bairro": "CENTRO",
  "comprador_cidade": "BELO HORIZONTE",
  "comprador_uf": "MG"
}
```

Para **SP**, o corpo é idêntico — muda apenas a rota (`/api/v1/atpve-sp/cadastrar`) e os campos de local (`crv_uf_emissao: "SP"`, `venda_uf: "SP"`, `venda_cidade: "SAO PAULO"`).

Resposta de sucesso (200): o **PDF do ATPV-e** em bytes (`Content-Type: application/pdf`).

```bash
curl -X POST https://www.despachantesconsultas.com.br/api/v1/atpve-mg/cadastrar \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mcd_SUA_CHAVE" \
  -d @payload.json \
  --output atpve.pdf
```

### Demais endpoints

Exemplos com `atpve-mg`; para São Paulo troque por `atpve-sp`.

```bash
# Listar pedidos
curl https://www.despachantesconsultas.com.br/api/v1/atpve-mg \
  -H "X-API-Key: mcd_SUA_CHAVE"

# Consultar por ID / por protocolo
curl https://www.despachantesconsultas.com.br/api/v1/atpve-mg/123 \
  -H "X-API-Key: mcd_SUA_CHAVE"
curl https://www.despachantesconsultas.com.br/api/v1/atpve-mg/protocolo/SEU_PROTOCOLO \
  -H "X-API-Key: mcd_SUA_CHAVE"

# Baixar PDF (bytes) / PDF em Base64
curl https://www.despachantesconsultas.com.br/api/v1/atpve-mg/123/pdf \
  -H "X-API-Key: mcd_SUA_CHAVE" --output atpve.pdf
curl https://www.despachantesconsultas.com.br/api/v1/atpve-mg/123/pdf/base64 \
  -H "X-API-Key: mcd_SUA_CHAVE"

# Atualizar situação / Registrar no DETRAN / Excluir
curl -X POST https://www.despachantesconsultas.com.br/api/v1/atpve-mg/123/atualizar \
  -H "Content-Type: application/json" -H "X-API-Key: mcd_SUA_CHAVE" -d '{}'
curl -X POST https://www.despachantesconsultas.com.br/api/v1/atpve-mg/123/registrar \
  -H "Content-Type: application/json" -H "X-API-Key: mcd_SUA_CHAVE" -d '{}'
curl -X POST https://www.despachantesconsultas.com.br/api/v1/atpve-mg/123/excluir \
  -H "Content-Type: application/json" -H "X-API-Key: mcd_SUA_CHAVE" -d '{}'
```

## Exemplo em Node.js

```javascript
const API_KEY = 'mcd_SUA_CHAVE_AQUI';
const BASE    = 'https://www.despachantesconsultas.com.br/api/v1';

// uf: 'mg' ou 'sp'
async function cadastrarAtpve(uf, dados) {
  const res = await fetch(`${BASE}/atpve-${uf}/cadastrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(dados),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || `Erro HTTP ${res.status}`);
  }
  const tipo = res.headers.get('content-type') || '';
  if (tipo.includes('application/pdf')) {
    return Buffer.from(await res.arrayBuffer()); // bytes do PDF do ATPV-e
  }
  return res.json();
}
```

## Exemplo em PHP (cURL)

```php
<?php
$apiKey = 'mcd_SUA_CHAVE_AQUI';
$uf  = 'mg'; // 'mg' ou 'sp'
$url = "https://www.despachantesconsultas.com.br/api/v1/atpve-$uf/cadastrar";

$ch = curl_init($url);
curl_setopt_array($ch, [
  CURLOPT_POST           => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'X-API-Key: ' . $apiKey],
  CURLOPT_POSTFIELDS     => json_encode($dados), // array com os campos acima
]);
$resposta = curl_exec($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$tipo = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

if ($http === 200 && strpos($tipo, 'application/pdf') !== false) {
  file_put_contents('atpve.pdf', $resposta); // PDF do ATPV-e
} else {
  $json = json_decode($resposta, true);
  // falha: $json['error'] traz a mensagem
}
```

## Códigos de erro

| HTTP | Significado | Cobra? |
|---|---|---|
| `400` | Dados inválidos ou erro de negócio (a mensagem detalha) | Não |
| `401` | Chave ausente, inválida ou revogada | Não |
| `402` | Saldo insuficiente na conta | Não |
| `403` | Conta bloqueada | Não |
| `404` | Pedido não encontrado | Não |
| `502` | Erro do provedor/DETRAN — tente novamente | Não |
| `500` | Erro interno — tente novamente | Não |

Corpo de erro sempre no formato `{ "error": "mensagem em português" }`.

## Suporte

WhatsApp (22) 99995-1574 — contato@mcdespachadoria.com.br
