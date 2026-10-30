# Agendamento assistido — Detran RJ

Agenda **Transferência de Propriedade**, **Transferência de Jurisdição** e **Troca de Município** no site do Detran RJ. O script preenche a identificação e **para no reCAPTCHA**: você marca "Não sou um robô" na janela do Chrome e ele faz o resto (cidade/posto, primeiro dia e horário livres). Sem vaga, ele tenta de novo a cada `intervaloMinutos`, e cada tentativa pede o captcha de novo, com bipe e aviso no WhatsApp.

## Pelo instalador (computador do cliente)

O site oferece em `/baixar-app` o `downloads/Instalar-Agendamento-Detran.exe`. Ele instala em `%LOCALAPPDATA%\Programs\Agendamento Detran RJ` (sem pedir administrador), baixa e instala o Node.js LTS de nodejs.org se faltar (aí o Windows pede permissão), e cria o atalho no Menu Iniciar e, se marcado, na Área de Trabalho e o início com o Windows. No lugar do `.bat`, quem roda é o `AgendamentoDetran.exe`: sobe o `servidor.js` sem janela, com um ícone perto do relógio (abrir, iniciar com o Windows, sair). A desinstalação fica em Configurações → Aplicativos e pergunta se apaga os veículos cadastrados.

O pacote **não leva o `.env`** (as chaves são da MC): sem a Z-API o painel esconde o campo "WhatsApp para avisos" e o resto funciona igual. Atualizar por cima mantém `veiculos.json`, `registros/` e `perfil-chrome/`.

Para gerar de novo depois de mexer na ferramenta (usa o `csc.exe` do próprio Windows, sem instalar nada):

```bash
powershell -ExecutionPolicy Bypass -File ferramentas/agendamento-detran/instalador/build.ps1
```

O `.exe` tem de ficar abaixo de 4,5 MB, o limite de resposta da function da Vercel por onde o site serve o download. O build avisa se passar.

## Pelo atalho (sem terminal)

Dê dois cliques em **Agendamento Detran** na Área de Trabalho (ou em `Agendamento Detran.bat` nesta pasta). Abre uma janela preta minimizada, que precisa ficar aberta enquanto você usa, e a tela do agendamento no navegador (`http://localhost:3939`). Lá você:

1. clica em **+ Novo veículo**, escolhe o serviço e preenche os dados, a cidade e o posto;
2. clica em **Testar** para conferir (só preenche o formulário do Detran, sem enviar);
3. clica em **Agendar** (ou **Agendar todos**). Quando o aviso amarelo aparecer e a página bipar, marque o captcha na janela do Chrome que o script abriu. **Parar** interrompe.

Na primeira vez o atalho instala sozinho o que falta. Ele precisa do Node.js e do Google Chrome instalados. A tela só funciona neste computador: ela não fica na internet.

## Campos

A tela grava tudo em `veiculos.json`, que fica fora do git porque tem CPF e renavam dos clientes. Pelo terminal, dá para editar esse arquivo direto (o modelo é o `veiculos.exemplo.json`).

| Campo | O que é |
|---|---|
| `servico` | `propriedade`, `jurisdicao` ou `municipio` |
| `opcao` | linha escolhida na 1ª tela do serviço (1 = a primeira). Propriedade: 1 simples, 2 com inclusão de gravame, 3 com baixa de gravame. Jurisdição e Município: 1 a 5, na ordem do site |
| `placa`, `renavam`, `cpfCnpj` | sem ponto nem traço. Na Propriedade o CPF/CNPJ é do **novo** proprietário; na Troca de Município é do **atual** |
| `dataVenda`, `duda` | só na Propriedade (`dd/mm/aaaa`; DUDA pago no documento do comprador) |
| `ufOrigem`, `crv`, `chassi` | Jurisdição (UF de onde o veículo vem); `chassi` só para placa antiga |
| `cep` | CEP do novo proprietário (Propriedade) ou de destino |
| `regiao` | `01` Metropolitana, `02` Interior |
| `tipo` | `1` Ônibus, `2` Táxi, `3` Carga, `4` Outros |
| `categoria` | `01` Particular, `02` Aluguel… (só na Propriedade) |
| `solicitante` | quem vai à unidade: `00` Proprietário, `03` Despachante, `11` Cônjuge… |
| `matriculaDespachante`, `tipoDespachante` | quando `solicitante` é `03`; `tipoDespachante` 0 = Público, 1 = Documentalista |
| `cidade`, `posto` | você escolhe: o script procura esse texto na tela de posto (sem diferença de acento ou maiúscula). Pode informar só a cidade |

Em `opcoes`: `intervaloMinutos` entre tentativas, `maxTentativas` (0 = até conseguir), `esperaCaptchaMinutos`, e `avisarWhatsApp`, o número que recebe "marque o captcha" e "agendado" pela Z-API do `.env` do site.

## Pelo terminal

```bash
npm install
```

```bash
node agendar.js --teste
```
Só preenche e mostra os campos, sem enviar. Faça isso antes da primeira vez.

```bash
node agendar.js
```
Agenda todos os veículos, um de cada vez. Para uma placa só, use `node agendar.js ABC1D23`. Veículo agendado ganha `"feito"` no `veiculos.json` e não roda de novo.

Cada tela fica gravada (imagem + HTML) em `registros/`, junto com o comprovante em PDF.

## Limites

- **As telas depois do captcha (posto, data, horário, conclusão) ainda não foram vistas** — não dava sem um agendamento de verdade. A escolha nelas é por texto, e os textos de "sem vaga" e "concluído" ficam no topo do `agendar.js` (`SEM_VAGA`, `CONCLUIDO`). Se o script não reconhecer uma tela, ele pausa, você faz aquele passo no Chrome e ele continua. Depois do primeiro uso real, mande as telas de `registros/` para acertar o que faltar.
- O captcha é sempre seu: o script não tenta passar por ele.
