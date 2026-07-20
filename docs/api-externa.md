# API Externa — MC Despachadoria Consultas

Documentação de integração para clientes contratantes da API. Acesso mediante contrato — a chave de API é fornecida pela MC Despachadoria já vinculada à conta que será debitada.

- **URL base:** `https://www.despachantesconsultas.com.br`
- **Autenticação:** header `X-API-Key: mcd_...` (ou `Authorization: Bearer mcd_...`)
- **Preço:** R$ 5,00 por consulta bem-sucedida, debitados dos créditos pré-pagos da conta. Consultas que falham (validação, erro do DETRAN, saldo insuficiente) **não são cobradas**.
- **Formato:** requisição e resposta em JSON (`Content-Type: application/json`).

> ⚠️ A chave deve ser usada apenas **servidor a servidor** (Node, PHP, etc.). Não chame a API a partir do navegador: a chave ficaria exposta e a API não libera CORS.

## Endpoints

### 1. Emitir ATPV-e — DETRAN/MG

```
POST /api/v1/detran-mg/atpve
```

| Campo | Obrigatório | Descrição |
|---|---|---|
| `placa` | ✔️ | Placa do veículo (ex.: `ABC1D23`) |
| `renavam` | ✔️ | Renavam do veículo |

```bash
curl -X POST https://www.despachantesconsultas.com.br/api/v1/detran-mg/atpve \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mcd_SUA_CHAVE" \
  -d '{"placa": "ABC1D23", "renavam": "12345678901"}'
```

### 2. Registrar Intenção de Venda de Veículo — DETRAN/MG

```
POST /api/v1/detran-mg/intencao-venda
```

| Campo | Obrigatório | Descrição |
|---|---|---|
| `cpf_vendedor` / `cnpj_vendedor` | um dos dois | CPF (11 dígitos) ou CNPJ (14 dígitos) do vendedor, só números |
| `email_vendedor` | ✔️ | E-mail do vendedor |
| `placa` | ✔️ | Placa do veículo |
| `chassi` | ✔️ | Chassi do veículo (17 caracteres) |
| `renavam` | ✔️ | Renavam do veículo |
| `crv` | ✔️ | Número do CRV |
| `hodometro` | — | Leitura do hodômetro |
| `datahora_hodometro` | — | Formato `dd/mm/aaaa hh:mm` (ex.: `20/07/2026 10:30`) |
| `valor_venda` | ✔️ | Número com ponto decimal — R$ 35.000,00 → `"35000.00"` |
| `cpf_comprador` / `cnpj_comprador` | um dos dois | CPF ou CNPJ do comprador, só números |
| `nome_comprador` | ✔️ | Nome completo do comprador |
| `email_comprador` | ✔️ | E-mail do comprador |
| `rg_comprador` | — | RG do comprador |
| `cep_comprador` | ✔️ | CEP, só números (8 dígitos) |
| `logradouro_endereco_comprador` | ✔️ | Rua/avenida do endereço do comprador |
| `numero_endereco_comprador` | ✔️ | Número do endereço |
| `complemento_endereco_comprador` | — | Complemento |
| `bairro_endereco_comprador` | ✔️ | Bairro |
| `municipio_endereco_comprador` | ✔️ | Município |
| `uf_endereco_comprador` | ✔️ | UF (ex.: `MG`) |

Payload de exemplo:

```json
{
  "cpf_vendedor": "12345678901",
  "email_vendedor": "vendedor@email.com",
  "placa": "ABC1D23",
  "chassi": "9BWZZZ377VT004251",
  "renavam": "12345678901",
  "crv": "123456789012",
  "hodometro": "85000",
  "datahora_hodometro": "20/07/2026 10:30",
  "valor_venda": "35000.00",
  "cpf_comprador": "98765432100",
  "nome_comprador": "JOAO DA SILVA",
  "email_comprador": "comprador@email.com",
  "rg_comprador": "MG1234567",
  "cep_comprador": "30130010",
  "logradouro_endereco_comprador": "RUA DOS TIMBIRAS",
  "numero_endereco_comprador": "1500",
  "complemento_endereco_comprador": "APTO 302",
  "bairro_endereco_comprador": "CENTRO",
  "municipio_endereco_comprador": "BELO HORIZONTE",
  "uf_endereco_comprador": "MG"
}
```

## Exemplo em Node.js

```javascript
const API_KEY = 'mcd_SUA_CHAVE_AQUI';
const URL_API = 'https://www.despachantesconsultas.com.br/api/v1/detran-mg/intencao-venda';

async function registrarIntencaoVenda(dados) {
  const res = await fetch(URL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(dados),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Erro HTTP ${res.status}`);
  return json; // { success, consulta_id, servico, charged, result }
}
```

## Exemplo em PHP (cURL)

```php
<?php
$apiKey = 'mcd_SUA_CHAVE_AQUI';
$url = 'https://www.despachantesconsultas.com.br/api/v1/detran-mg/intencao-venda';

$ch = curl_init($url);
curl_setopt_array($ch, [
  CURLOPT_POST           => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'X-API-Key: ' . $apiKey],
  CURLOPT_POSTFIELDS     => json_encode($dados), // array com os campos acima
]);
$resposta = curl_exec($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$json = json_decode($resposta, true);
if ($http === 200 && !empty($json['success'])) {
  // sucesso: $json['result'] traz o retorno do DETRAN/MG
} else {
  // falha: $json['error'] traz a mensagem
}
```

## Resposta de sucesso

```json
{
  "success": true,
  "consulta_id": 12345,
  "servico": "DETRAN — MG / Registrar Intenção de Venda de Veículo",
  "charged": 5,
  "result": { "...": "retorno do DETRAN/MG via Infosimples" }
}
```

## Códigos de erro

| HTTP | Significado | Cobra? |
|---|---|---|
| `400` | Campos obrigatórios ausentes (a mensagem lista quais) | Não |
| `401` | Chave ausente, inválida ou revogada | Não |
| `402` | Saldo insuficiente na conta | Não |
| `403` | Conta bloqueada | Não |
| `422` / `502` | Erro do DETRAN/Infosimples (ex.: veículo com pendência) | Não |
| `500` | Erro interno — tente novamente | Não |

Corpo de erro sempre no formato `{ "error": "mensagem em português" }`.

## Suporte

WhatsApp (22) 99995-1574 — contato@mcdespachadoria.com.br
