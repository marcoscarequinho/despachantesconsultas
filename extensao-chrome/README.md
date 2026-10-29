# Extensão do Chrome — Despachantes Consultas

Atalho na barra do Chrome: mostra quem está logado, o **saldo** (pré-pago) ou a **fatura** (pós-pago) e abre o painel. Desde a 1.1.0 tem também o **agendamento assistido no Detran RJ**.

## Agendamento Detran RJ

Transferência de Propriedade, Transferência de Jurisdição e Troca de Município, de graça e sem conta. É a mesma lógica da ferramenta de linha de comando em `ferramentas/agendamento-detran`, só que dentro do Chrome de quem agenda.

- **[agendamento.html](agendamento.html)/[agendamento.js](agendamento.js)**: tela da extensão (botão no popup) com os veículos. Lista em `chrome.storage.local` (`agendDados`), **nunca** no nosso servidor: são CPF e renavam de clientes.
- **[background.js](background.js)**: dono do estado do agendamento (`agendJob`). Abre a aba do Detran, recebe os eventos das páginas em ordem e agenda a nova tentativa sem vaga com `chrome.alarms`. Cada veículo abre numa aba nova, para a do anterior (comprovante, erro) ficar aberta. Fechar a aba do agendamento para tudo.
- **[detran.js](detran.js)**: roda nas páginas `www5.detran.rj.gov.br/_agendamento.eletronico/*` e só age na aba do agendamento. Menu do serviço → submete direto para a identificação (como o "Continuar" do site); identificação → preenche e **para no reCAPTCHA** (espera o token no `#g-recaptcha-response` e então clica Enviar); depois → cidade/posto por texto, primeiro dia/horário, `SEM_VAGA`/`CONCLUIDO` por texto. **As telas depois do captcha não foram vistas** (exigem agendamento real): tela não reconhecida vira notificação "faça este passo" e a extensão segue na próxima.
- **[detran-alerta.js](detran-alerta.js)** (`world: MAIN`): o site avisa recusa por `alert()`, invisível ao mundo isolado; o texto fica em `data-detran-alertas` no `<html>`.
- O captcha é sempre do usuário. A extensão não tenta passar por ele.
- Testado em 29/10/2026 com veículo fictício (Chromium do Playwright, extensão sem compactação): Testar preencheu o formulário; Agendar parou no captcha com aviso, selo "!" e notificação; Parar encerrou. Sem vaga e as telas finais: não testados.

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
