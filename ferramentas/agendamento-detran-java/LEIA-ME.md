# Agendamento Detran RJ — versão Java

Segunda opção da página `/baixar-app` (06/11/2026, pedido do dono): o mesmo agendamento assistido da [versão Node](../agendamento-detran/LEIA-ME.md), com a mesma tela, entregue como **.zip sem nenhum .exe nosso**. O objetivo é escapar do aviso "O Windows protegeu o computador", que o SmartScreen mostra para executável **sem assinatura** (o `Instalar-Agendamento-Detran.exe` não tem assinatura).

## Por que funciona sem certificado

- Os únicos executáveis do pacote são os do **Java da Microsoft** (`java/bin/javaw.exe` e DLLs), que vêm assinados por ela.
- O Java vai **reduzido pelo jlink** (só `java.base`, `java.net.http`, `jdk.httpserver`, ~25 MB). O jlink monta o runtime a partir dos `.jmod`, que trazem os binários **sem assinatura**. Por isso o `build.ps1` copia por cima os mesmos `.exe`/`.dll` do JDK instalado (idênticos, só que assinados) e **falha se algum ficar sem assinatura**.
- Quem a pessoa clica é `Abrir Agendamento Detran.cmd` (entra na pasta e chama `javaw -cp … Main`). A primeira versão, com `start "" "%~dp0javabinjavaw.exe" -jar …`, fez o Windows Defender marcar o .zip como `Trojan:Script/Ulthar.A!ml` (palpite do modelo, só com .cmd + .jar + Java juntos); o build agora escaneia o pacote e falha se o Defender reclamar. Foi testado com o arquivo marcado como baixado da internet (Zone.Identifier 3): o `.cmd` abriu direto, e o `.vbs` parou numa janela de "Aviso de segurança", por isso ele ficou de fora.
- **Não confirmado:** neste computador o SmartScreen deixou passar até um .exe de teste sem assinatura, então não deu para reproduzir o aviso. Falta conferir num PC "limpo", baixando pelo site.

## Como é por dentro

Sem dependência nenhuma, só Java 11:

| Arquivo | O que faz |
|---|---|
| `Main.java` | Servidor da tela em `http://localhost:3940` (porta diferente da versão Node, 3939, para as duas conviverem), com as mesmas `/api` do `servidor.js`. Serve o **mesmo `painel.html`** da versão Node (copiado para o `.jar` no build, sem segunda cópia), com um botão a mais, **Fechar programa** (`/api/sair`): esta versão não tem janela nem ícone perto do relógio |
| `Robo.java` | A lógica do `agendar.js`: catálogo dos 8 serviços, validação, menu → identificação → captcha → posto/data/horário, nova tentativa sem vaga |
| `Chrome.java` | Abre o Chrome (ou o Edge) com perfil próprio e o comanda pelo **protocolo DevTools** por WebSocket — o mesmo que o Playwright usa por baixo, sem precisar de Node nem do Playwright. Aceita os `alert()` do Detran e põe o texto no andamento |
| `pagina.js` | As funções que rodam dentro das páginas do Detran (preencher, ler, escolher por texto). Mudar uma regra do formulário é mexer aqui **e** no `agendar.js`/`detran.js` |
| `Json.java` | JSON mínimo (não há Gson no runtime reduzido) |

Os dados ficam em `%LOCALAPPDATA%\Agendamento Detran RJ (Java)` (`veiculos.json`, `registros/`, `perfil-chrome/`), fora da pasta do programa: descompactar uma versão nova por cima não apaga nada. Sem WhatsApp (as chaves da Z-API são da MC). Sem PDF do comprovante (o Chrome com janela não gera PDF pelo DevTools): fica a imagem e a página em `registros/`.

## Gerar de novo

```bash
powershell -ExecutionPolicy Bypass -File ferramentas/agendamento-detran-java/build.ps1
```

Precisa do JDK 11 da Microsoft (`C:\Program Files\Microsoft\jdk-11.0.12.7-hotspot`, ou `JDK_HOME`). Sai em `downloads-java/Agendamento-Detran-RJ-Java.zip` (~15 MB). Esse arquivo **não passa pela Vercel** (a function corta em 4,5 MB e o `includeFiles` não o inclui): `/baixar-app/java` redireciona para ele no GitHub (`AGENDAMENTO_JAVA_ZIP` no `server.js`), por isso só vale depois do push.

Conferir sem enviar nada (só preenche os formulários do Detran, com os veículos da pasta de dados):

```bash
java -jar app/agendamento.jar --teste
```

Com `AGENDAMENTO_SEM_JANELA=1` o Chrome roda sem janela. Testado em 06/11/2026 nos 8 serviços (11 casos fictícios), igual à versão Node.
