# Chrome Web Store — Despachantes Consultas

> Última atualização: 29/10/2026

Tudo o que o painel do desenvolvedor da Chrome Web Store pede, pronto para copiar. Este arquivo **não** vai no .zip.

## Ficha da loja

**Nome** (igual ao `manifest.json`)
Despachantes Consultas

**Descrição curta** (máx. 132 caracteres)
Saldo da sua conta Despachantes Consultas com um clique e agendamento assistido no Detran RJ (você marca o captcha, ela faz o resto).

**Descrição detalhada** (a loja não formata Markdown — colar como texto puro)

```
Veja o saldo da sua conta Despachantes Consultas sem abrir o site e entre no painel de consultas veiculares com um clique.

O QUE FAZ
• Mostra o seu saldo disponível para consultas.
• Em conta pós-paga, mostra o valor da fatura em aberto, o vencimento e o total devido, e avisa se as consultas estiverem bloqueadas por fatura vencida.
• Abre o painel para fazer consultas (CRLV-e, ATPV-e, débitos, dados do veículo e mais).
• Leva direto para a Recarga PIX (ou para a Conta Pós-paga, se for o seu caso).
• Se o site já estiver aberto numa aba, usa essa aba em vez de abrir outra.

AGENDAMENTO ASSISTIDO NO DETRAN RJ (grátis)
• Transferência de Propriedade, Transferência de Jurisdição e Troca de Município.
• Cadastre os veículos e escolha a cidade e o posto de cada um.
• A extensão preenche o formulário no site do Detran e para no reCAPTCHA: você marca "Não sou um robô" e ela continua sozinha, escolhendo o posto e o primeiro dia e horário livres.
• Sem vaga, ela tenta de novo no intervalo que você escolher e avisa (notificação e som) quando precisa de você.
• "Testar" preenche o formulário sem enviar, para conferir os dados.

COMO USAR
1. Instale a extensão e fixe o ícone na barra do Chrome.
2. Entre na sua conta em despachantesconsultas.com.br (só na primeira vez).
3. Clique no ícone para ver o saldo e abrir o painel.
4. Para agendar no Detran, clique em "Agendamento Detran RJ" (não precisa de conta).

PRIVACIDADE
A extensão usa o login que você já fez no site: não pede nem guarda senha. Os veículos do agendamento ficam só no seu navegador e são enviados apenas ao site do Detran RJ, no formulário de agendamento — nunca à Despachantes Consultas. Ela não lê outras páginas que você visita.

PERMISSÃO
• "Ler e alterar seus dados em www.despachantesconsultas.com.br" — para mostrar o saldo da sua conta.
• "Ler e alterar seus dados em www5.detran.rj.gov.br" — para preencher o agendamento no site do Detran RJ.
• Notificações — para avisar quando marcar o captcha e quando o agendamento sair.

SUPORTE
contato@despachantesconsultas.com.br · WhatsApp (22) 99995-1574

Versão 1.1.0 — agendamento assistido no Detran RJ.
```

**Categoria**: Produtividade (Productivity)

**Finalidade única** (vai para a revisão, não aparece para o cliente)
Ferramenta do despachante: mostra o saldo da conta na plataforma Despachantes Consultas e preenche o agendamento de veículo no Detran RJ, deixando o reCAPTCHA para o usuário marcar.

**Idioma principal**: Português (Brasil)

## Imagens

| Imagem | Tamanho | Situação | Arquivo |
|---|---|---|---|
| Ícone da loja (obrigatório) | 128×128 PNG | ✅ Pronto | `icons/icon-128.png` |
| Captura 1 (obrigatória) | 1280×800 ou 640×400 | ⬜ Falta | |
| Captura 2 | 1280×800 ou 640×400 | ⬜ Falta | |
| Bloco promocional pequeno | 440×280 | ⬜ Falta (opcional) | |

**Capturas**: tirar com a extensão instalada. Uma delas pode ser a tela do Agendamento Detran RJ com um veículo fictício. (1) Janelinha aberta com o saldo, sobre o site ao fundo; (2) a mesma coisa numa conta pós-paga, mostrando a fatura. Usar uma conta de teste — não mostrar nome, e-mail ou valores de cliente de verdade.

## Justificativa das permissões

| Permissão | Tipo | Justificativa |
|---|---|---|
| `https://www.despachantesconsultas.com.br/*` | host_permissions | Ao clicar no ícone, a extensão lê o nome e o saldo (ou o resumo da fatura pós-paga) da conta do próprio usuário no nosso site, usando o login que ele já fez lá. Também é usada para achar uma aba do site já aberta e reaproveitá-la ao abrir o painel. |
| `https://www5.detran.rj.gov.br/*` | host_permissions + content_scripts | O agendamento assistido preenche o formulário de agendamento de veículo do Detran RJ com os dados que o usuário cadastrou na extensão e escolhe cidade, posto, dia e horário. Os scripts só rodam em `/_agendamento.eletronico/*` e só agem na aba que a própria extensão abriu para o agendamento. O reCAPTCHA é sempre marcado pelo usuário: a extensão espera ele marcar e só então clica em Enviar. Um dos scripts roda no mundo da página (`world: MAIN`) apenas para registrar o texto dos avisos (alert) do site, que continuam aparecendo normalmente. |
| `storage` | permissions | Guardar no próprio navegador a lista de veículos do agendamento e o andamento, para o usuário não digitar de novo e para o agendamento continuar entre as telas do Detran. |
| `alarms` | permissions | Sem vaga, agendar a nova tentativa para o intervalo escolhido pelo usuário (o service worker dorme entre tentativas). |
| `notifications` | permissions | Avisar o usuário que é a vez dele marcar o captcha, que um passo precisa ser feito à mão e que o agendamento saiu. |

Não há `tabs`, `cookies`, `scripting` nem `<all_urls>`.

## Privacidade e uso de dados

**A extensão coleta dados do usuário?** Sim. (1) Lê do nosso servidor dados da conta do usuário só para mostrar na janelinha, sem guardar. (2) Guarda no próprio navegador os dados de veículos que o usuário digita para o agendamento e os envia apenas ao site do Detran RJ, no formulário de agendamento. Nada disso chega ao nosso servidor.

| Tipo de dado | Coletado? | Sai do aparelho? | Finalidade | Compartilhado com terceiros? |
|---|---|---|---|---|
| Informações de identificação pessoal | Sim (primeiro nome; e CPF/CNPJ, CEP e placa/renavam dos veículos do agendamento) | Nome: não. Dados do agendamento: só para o site do Detran RJ, no formulário de agendamento | Saudar o usuário logado; preencher o agendamento | Não (o Detran RJ é o destino do próprio serviço) |
| Informações financeiras | Sim (saldo / valor da fatura) | Não — idem | Mostrar saldo ou fatura | Não |
| Informações de autenticação | Não (usa o login do site; não lê nem guarda senha ou token) | — | — | — |
| Conteúdo de sites | Sim (só o texto das páginas de agendamento do Detran RJ, na aba do agendamento) | Não | Saber em que tela do agendamento está e o que escolher | Não |
| Saúde, comunicações, localização, histórico, atividade | Não | — | — | — |

**Certificações** (marcar as três)
- [x] Os dados não são vendidos a terceiros
- [x] Os dados não são usados para fins fora da função principal
- [x] Os dados não são usados para crédito ou empréstimo

## Política de privacidade

**URL**: https://www.despachantesconsultas.com.br/extensao/privacidade
(página `privacidade-extensao.html` do site. Mudou o que a extensão lê ou envia? Atualize a página e este formulário juntos — divergência entre os dois é motivo de recusa.)

## Distribuição

**Visibilidade**: Pública (ou "Não listada", para só quem tiver o link instalar)
**Regiões**: Brasil

## Desenvolvedor

**Editor**: MC Despachadoria Consultas
**E-mail de contato**: contato@despachantesconsultas.com.br
**Suporte**: https://wa.me/5522999951574
**Site**: https://www.despachantesconsultas.com.br/

## Histórico de versões

| Versão | Data | Mudanças | Situação |
|---|---|---|---|
| 1.0.0 | 27/09/2026 | Primeira versão: saldo/fatura e atalho para o painel | Rascunho |
| 1.1.0 | 29/10/2026 | Agendamento assistido no Detran RJ (propriedade, jurisdição, município): permissões `storage`, `alarms`, `notifications` e host `www5.detran.rj.gov.br` | Rascunho |

## Observações para a revisão

- Para testar, o revisor precisa de uma conta no site. Se a loja pedir, informe as credenciais de uma **conta de teste** no campo de instruções do painel (nunca de um cliente).
- Deslogado, a extensão mostra "Entrar" e "Criar conta" — funciona sem conta, só não mostra saldo.
- O agendamento não precisa de conta: o revisor pode cadastrar um veículo fictício e usar **Testar**, que abre o site do Detran e só preenche o formulário, sem enviar.
