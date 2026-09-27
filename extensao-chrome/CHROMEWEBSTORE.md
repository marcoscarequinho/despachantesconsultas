# Chrome Web Store — Despachantes Consultas

> Última atualização: 27/09/2026

Tudo o que o painel do desenvolvedor da Chrome Web Store pede, pronto para copiar. Este arquivo **não** vai no .zip.

## Ficha da loja

**Nome** (igual ao `manifest.json`)
Despachantes Consultas

**Descrição curta** (máx. 132 caracteres)
Mostra o saldo ou a fatura da sua conta Despachantes Consultas e abre o painel de consultas veiculares com um clique.

**Descrição detalhada** (a loja não formata Markdown — colar como texto puro)

```
Veja o saldo da sua conta Despachantes Consultas sem abrir o site e entre no painel de consultas veiculares com um clique.

O QUE FAZ
• Mostra o seu saldo disponível para consultas.
• Em conta pós-paga, mostra o valor da fatura em aberto, o vencimento e o total devido, e avisa se as consultas estiverem bloqueadas por fatura vencida.
• Abre o painel para fazer consultas (CRLV-e, ATPV-e, débitos, dados do veículo e mais).
• Leva direto para a Recarga PIX (ou para a Conta Pós-paga, se for o seu caso).
• Se o site já estiver aberto numa aba, usa essa aba em vez de abrir outra.

COMO USAR
1. Instale a extensão e fixe o ícone na barra do Chrome.
2. Entre na sua conta em despachantesconsultas.com.br (só na primeira vez).
3. Clique no ícone para ver o saldo e abrir o painel.

PRIVACIDADE
A extensão usa o login que você já fez no site: não pede nem guarda senha. Ela só se comunica com despachantesconsultas.com.br, não lê as páginas que você visita e não guarda nada no navegador.

PERMISSÃO
• "Ler e alterar seus dados em www.despachantesconsultas.com.br" — necessária para mostrar o saldo da sua conta. A extensão não acessa nenhum outro site.

SUPORTE
contato@despachantesconsultas.com.br · WhatsApp (22) 99995-1574

Versão 1.0.0 — primeira versão.
```

**Categoria**: Produtividade (Productivity)

**Finalidade única** (vai para a revisão, não aparece para o cliente)
Mostra o saldo ou a fatura da conta do usuário na plataforma Despachantes Consultas e abre o painel do site.

**Idioma principal**: Português (Brasil)

## Imagens

| Imagem | Tamanho | Situação | Arquivo |
|---|---|---|---|
| Ícone da loja (obrigatório) | 128×128 PNG | ✅ Pronto | `icons/icon-128.png` |
| Captura 1 (obrigatória) | 1280×800 ou 640×400 | ⬜ Falta | |
| Captura 2 | 1280×800 ou 640×400 | ⬜ Falta | |
| Bloco promocional pequeno | 440×280 | ⬜ Falta (opcional) | |

**Capturas**: tirar com a extensão instalada. (1) Janelinha aberta com o saldo, sobre o site ao fundo; (2) a mesma coisa numa conta pós-paga, mostrando a fatura. Usar uma conta de teste — não mostrar nome, e-mail ou valores de cliente de verdade.

## Justificativa das permissões

| Permissão | Tipo | Justificativa |
|---|---|---|
| `https://www.despachantesconsultas.com.br/*` | host_permissions | Ao clicar no ícone, a extensão lê o nome e o saldo (ou o resumo da fatura pós-paga) da conta do próprio usuário no nosso site, usando o login que ele já fez lá. Também é usada para achar uma aba do site já aberta e reaproveitá-la ao abrir o painel. Nenhum outro domínio é acessado. |

Não há outras permissões (nem `tabs`, `storage`, `cookies` ou `<all_urls>`).

## Privacidade e uso de dados

**A extensão coleta dados do usuário?** Sim — só exibe, não guarda: lê do nosso próprio servidor dados da conta do usuário para mostrar na janelinha.

| Tipo de dado | Coletado? | Sai do aparelho? | Finalidade | Compartilhado com terceiros? |
|---|---|---|---|---|
| Informações de identificação pessoal | Sim (primeiro nome) | Não — vem do nosso servidor e só aparece na tela | Saudar o usuário logado | Não |
| Informações financeiras | Sim (saldo / valor da fatura) | Não — idem | Mostrar saldo ou fatura | Não |
| Informações de autenticação | Não (usa o login do site; não lê nem guarda senha ou token) | — | — | — |
| Saúde, comunicações, localização, histórico, atividade, conteúdo de sites | Não | — | — | — |

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

## Observações para a revisão

- Para testar, o revisor precisa de uma conta no site. Se a loja pedir, informe as credenciais de uma **conta de teste** no campo de instruções do painel (nunca de um cliente).
- Deslogado, a extensão mostra "Entrar" e "Criar conta" — funciona sem conta, só não mostra saldo.
