# Extensão do Chrome — Despachantes Consultas

Atalho na barra do Chrome: mostra quem está logado, o **saldo** (pré-pago) ou a **fatura** (pós-pago) e abre o painel.

- Sem build, sem dependência: Manifest V3 puro. Não pode ter script remoto nem inline (CSP do MV3), por isso não usa Tailwind CDN.
- Não guarda senha nem token: usa o cookie `auth_token` do próprio site. A `host_permissions` do `www.despachantesconsultas.com.br` é o que faz o Chrome mandar o cookie nas chamadas da extensão. O domínio sem `www` redireciona (308) e o cookie nasce no `www`, então só ele entra.
- Pós-pago segue a regra do painel: rótulo "Fatura", cor âmbar e sem "Recarga PIX" (o servidor recusa recarga de pós-pago).
- Esta pasta **não** vai para a Vercel: o `includeFiles` do `vercel.json` não a inclui.

## Testar

1. `chrome://extensions` → ligar **Modo do desenvolvedor**.
2. **Carregar sem compactação** → escolher esta pasta (`extensao-chrome`).
3. Entrar no site em outra aba e clicar no ícone da extensão.

## Publicar na Chrome Web Store

1. Gerar o pacote: `powershell -ExecutionPolicy Bypass -File .\empacotar.ps1` (sai em `dist/`, fora do git, e uma cópia em `assets/extensao-chrome.zip`, que o site serve em https://www.despachantesconsultas.com.br/assets/extensao-chrome.zip depois do commit).
2. Enviar o .zip no [painel do desenvolvedor](https://chrome.google.com/webstore/devconsole) (taxa única de US$ 5 na conta Google que vai ser a dona da extensão).
3. Preencher a ficha com os textos de [CHROMEWEBSTORE.md](CHROMEWEBSTORE.md): descrições, justificativa da permissão, formulário de privacidade e a URL da política — https://www.despachantesconsultas.com.br/extensao/privacidade (`privacidade-extensao.html`).

A cada versão nova, subir o `version` do `manifest.json` e anotar no histórico do CHROMEWEBSTORE.md.
