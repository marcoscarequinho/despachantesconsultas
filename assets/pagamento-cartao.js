/* Pagamento no cartão — mp.cardForm() do Mercado Pago (SDK JS v2).
 *
 * Usado pelas três telas que cobram do cliente (recarga de créditos, consulta
 * avulsa e assinatura). O PIX continua sendo o caminho padrão e sem acréscimo;
 * este arquivo cuida do cartão: débito (+5%) ou crédito (+7%), sempre à vista.
 *
 * POR QUE cardForm E NÃO O CARD PAYMENT BRICK
 * Os campos do brick são iframes de secure-fields.mercadopago.com e vêm com
 * autocomplete="off" — com isso o celular não oferece nem o "Escanear cartão"
 * pela câmera nem o preenchimento do cartão salvo, e não há como mudar isso de
 * fora do iframe. O cardForm com iframe:false usa <input> NOSSOS, que marcamos
 * com autocomplete="cc-number"/"cc-exp-month"/"cc-exp-year"/"cc-csc" — é o que
 * faz o iPhone e o Android oferecerem o escaneamento e o autofill. A validade
 * é dividida em mês e ano de propósito: o iOS só preenche a data quando ela
 * está em dois campos.
 *
 * O PREÇO DISSO, decidido pelo dono do negócio com a informação na mão: o
 * número do cartão passa a existir dentro do JavaScript desta página (o SDK lê
 * o input e tokeniza direto com o Mercado Pago). Ele continua NÃO chegando ao
 * nosso servidor — o backend só recebe o token de uso único —, mas a
 * classificação PCI do site sai de SAQ A para SAQ A-EP. Consequência prática
 * para quem mexer aqui: nada de logar, guardar, copiar ou mandar para lugar
 * nenhum o valor de #form-checkout__cardNumber; ele só existe para o SDK ler.
 *
 * O valor com acréscimo é sempre RECALCULADO no servidor; o que este arquivo
 * mostra é só a informação para o cliente decidir.
 */
(function () {
  const SDK_URL = 'https://sdk.mercadopago.com/js/v2';

  let sdkCarregando = null;
  let mp = null;
  let cardFormAtual = null;
  let brick3ds = null;
  let estiloPosto = false;

  const brl = (v) =>
    'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function carregarSdk() {
    if (window.MercadoPago) return Promise.resolve();
    if (sdkCarregando) return sdkCarregando;
    sdkCarregando = new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.onload = ok;
      s.onerror = () => falha(new Error('Não consegui carregar o Mercado Pago.'));
      document.head.appendChild(s);
    });
    return sdkCarregando;
  }

  // Estilo do formulário. Fica aqui (e não no CSS de cada página) porque as três
  // telas têm visuais diferentes e o formulário precisa ser o mesmo nas três.
  // As cores saem de variáveis com fallback, então o tema escuro
  // (assets/tema.css) continua valendo.
  function porEstilo() {
    if (estiloPosto || document.getElementById('pgc-estilo')) { estiloPosto = true; return; }
    const st = document.createElement('style');
    st.id = 'pgc-estilo';
    st.textContent = `
      .pgc-form { display: grid; gap: .75rem; }
      .pgc-linha { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .5rem; }
      .pgc-campo { display: flex; flex-direction: column; gap: .25rem; }
      .pgc-campo label { font-size: .75rem; font-weight: 600; color: #4b5563; }
      .pgc-campo input, .pgc-campo select {
        width: 100%; padding: .65rem .75rem; border: 1.5px solid #d1d5db; border-radius: .5rem;
        font-size: 1rem; background: #fff; color: #111827; box-sizing: border-box;
      }
      .pgc-campo input:focus, .pgc-campo select:focus {
        outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15);
      }
      .pgc-campo input::placeholder { color: #9ca3af; }
      .pgc-doc { display: grid; grid-template-columns: 7rem 1fr; gap: .5rem; }
      .pgc-oculto { display: none !important; }
      .metodo-btn.pgc-oculto { display: none !important; }
      .pgc-btn {
        width: 100%; padding: .8rem 1rem; border: 0; border-radius: .5rem; cursor: pointer;
        background: #f97316; color: #fff; font-weight: 700; font-size: 1rem;
      }
      .pgc-btn:disabled { opacity: .6; cursor: default; }
      .pgc-dica { font-size: .7rem; color: #6b7280; }
      html.dark .pgc-campo label { color: #cbd5e1; }
      html.dark .pgc-campo input, html.dark .pgc-campo select { background: #1e293b; border-color: #475569; color: #e2e8f0; }
      html.dark .pgc-dica { color: #94a3b8; }
    `;
    document.head.appendChild(st);
    estiloPosto = true;
  }

  // O HTML do formulário. Os ids são os que o cardForm espera; os autocomplete
  // são o motivo de o formulário ser nosso (ver o comentário do topo).
  function formHtml({ textoBotao, email, doc }) {
    const emailAttr = email ? ` value="${String(email).replace(/"/g, '&quot;')}"` : '';
    const docAttr = doc ? ` value="${String(doc).replace(/[^0-9]/g, '')}"` : '';
    return `
      <form id="form-checkout" class="pgc-form" autocomplete="on">
        <div class="pgc-campo">
          <label for="form-checkout__cardNumber">Número do cartão</label>
          <input type="text" id="form-checkout__cardNumber" name="cardNumber"
                 autocomplete="cc-number" inputmode="numeric" maxlength="23"
                 placeholder="1234 1234 1234 1234">
        </div>
        <div class="pgc-linha">
          <div class="pgc-campo">
            <label for="form-checkout__expirationMonth">Mês</label>
            <input type="text" id="form-checkout__expirationMonth" name="expirationMonth"
                   autocomplete="cc-exp-month" inputmode="numeric" maxlength="2" placeholder="MM">
          </div>
          <div class="pgc-campo">
            <label for="form-checkout__expirationYear">Ano</label>
            <input type="text" id="form-checkout__expirationYear" name="expirationYear"
                   autocomplete="cc-exp-year" inputmode="numeric" maxlength="4" placeholder="AAAA">
          </div>
          <div class="pgc-campo">
            <label for="form-checkout__securityCode">CVV</label>
            <input type="text" id="form-checkout__securityCode" name="securityCode"
                   autocomplete="cc-csc" inputmode="numeric" maxlength="4" placeholder="123">
          </div>
        </div>
        <div class="pgc-campo">
          <label for="form-checkout__cardholderName">Nome do titular como está no cartão</label>
          <input type="text" id="form-checkout__cardholderName" name="cardholderName"
                 autocomplete="cc-name" placeholder="NOME COMPLETO">
        </div>
        <div class="pgc-campo">
          <label for="form-checkout__identificationNumber">Documento do titular</label>
          <div class="pgc-doc">
            <select id="form-checkout__identificationType" name="identificationType"></select>
            <input type="text" id="form-checkout__identificationNumber" name="identificationNumber"
                   inputmode="numeric" placeholder="Somente números"${docAttr}>
          </div>
        </div>
        <div class="pgc-campo">
          <label for="form-checkout__cardholderEmail">E-mail</label>
          <input type="email" id="form-checkout__cardholderEmail" name="cardholderEmail"
                 autocomplete="email" placeholder="voce@exemplo.com"${emailAttr}>
        </div>
        <div class="pgc-campo pgc-oculto" id="pgc-emissor">
          <label for="form-checkout__issuer">Banco emissor</label>
          <select id="form-checkout__issuer" name="issuer"></select>
        </div>
        <!-- Parcelas fica escondido: cobramos sempre à vista (o servidor manda
             installments: 1 de qualquer jeito). O elemento precisa existir
             porque o cardForm o preenche e lê. -->
        <div class="pgc-campo pgc-oculto">
          <label for="form-checkout__installments">Parcelas</label>
          <select id="form-checkout__installments" name="installments"></select>
        </div>
        <button type="submit" id="form-checkout__submit" class="pgc-btn">${textoBotao}</button>
        <p class="pgc-dica">🔒 Os dados do cartão vão direto para o Mercado Pago. No celular, toque no campo do número para usar a câmera e escanear o cartão.</p>
      </form>
    `;
  }

  // O SDK do Mercado Pago SOBRESCREVE o autocomplete dos campos sensíveis para
  // "off" quando monta o cardForm (conferido no navegador: o cc-number que
  // escrevemos no HTML vira off; só o cc-name do titular sobrevive). Sem o
  // atributo certo o celular não oferece o "Escanear cartão" nem o cartão
  // salvo — que é a razão inteira de termos trocado o brick por este
  // formulário. Então o valor é reposto depois da montagem e a cada foco (o
  // momento em que o teclado/scanner do sistema aparece). Reposto, ele fica:
  // o SDK não volta a mexer enquanto se digita.
  const AUTOCOMPLETE_CAMPOS = {
    'form-checkout__cardNumber': 'cc-number',
    'form-checkout__expirationMonth': 'cc-exp-month',
    'form-checkout__expirationYear': 'cc-exp-year',
    'form-checkout__securityCode': 'cc-csc',
    'form-checkout__cardholderName': 'cc-name',
  };
  function reforcarAutocomplete() {
    for (const [id, valor] of Object.entries(AUTOCOMPLETE_CAMPOS)) {
      const el = document.getElementById(id);
      if (el && el.getAttribute('autocomplete') !== valor) el.setAttribute('autocomplete', valor);
    }
  }

  const PagamentoCartao = {
    config: null,

    // Busca a public key e os percentuais no servidor. Eles vêm de lá de
    // propósito: mudar 5%/7% é mexer numa tabela só (CARTAO_ACRESCIMOS no
    // server.js), sem caçar número solto no HTML das páginas.
    async carregarConfig() {
      if (this.config) return this.config;
      try {
        const r = await fetch('/api/pagamento/config');
        this.config = await r.json();
      } catch {
        this.config = { publicKey: null, cartaoDisponivel: false };
      }
      this.config.acrescimos = this.config.acrescimos || { debito: 0.05, credito: 0.07 };
      // Tipos que a conta do Mercado Pago processa de verdade (ver
      // mpTiposCartaoDisponiveis no server.js). Sem essa informação, assume o
      // conservador: só crédito.
      this.config.tipos = this.config.tipos || { debito: false, credito: true };
      return this.config;
    },

    percentual(tipo) {
      return this.config?.acrescimos?.[tipo === 'credito' ? 'credito' : 'debito'] ?? (tipo === 'credito' ? 0.07 : 0.05);
    },

    // Mesma conta do servidor (valorComAcrescimoCartao), para a tela poder
    // mostrar o valor antes de o cliente escolher.
    comAcrescimo(valor, tipo) {
      return Math.round(Number(valor) * (1 + this.percentual(tipo)) * 100) / 100;
    },

    brl,

    rotuloTipo(tipo) {
      return tipo === 'credito' ? 'crédito' : 'débito';
    },

    aceita(tipo) {
      return Boolean(this.config?.tipos?.[tipo === 'credito' ? 'credito' : 'debito']);
    },

    // Esconde o botão de um tipo que não está sendo oferecido e devolve os que
    // ficaram. Chamado por cada tela depois de carregarConfig(). Esconde por
    // style inline de propósito: o CSS do módulo só é injetado quando o
    // formulário monta, e aqui o menu aparece antes disso.
    aplicarTiposDisponiveis(seletor) {
      const restantes = [];
      document.querySelectorAll(seletor).forEach(btn => {
        const tipo = btn.dataset.metodo || btn.dataset.metodoAssinatura;
        const some = tipo !== 'pix' && !this.aceita(tipo);
        btn.style.display = some ? 'none' : '';
        if (!some) restantes.push(tipo);
      });
      return restantes;
    },

    // Aviso de uma linha. Com valor, mostra quanto fica em cada opção — é o que
    // deixa a escolha honesta antes de o cliente digitar o cartão.
    textoAviso(valor, tipo) {
      const pct = (t) => Math.round(this.percentual(t) * 100);
      // Sem tipo: descreve só o que a conta aceita hoje, para o aviso não
      // prometer um meio que a tela não vai mostrar.
      if (!tipo) {
        const partes = [];
        if (this.aceita('debito')) partes.push(`no débito, +${pct('debito')}%${valor ? ` (${brl(this.comAcrescimo(valor, 'debito'))})` : ''}`);
        if (this.aceita('credito')) partes.push(`no crédito, +${pct('credito')}%${valor ? ` (${brl(this.comAcrescimo(valor, 'credito'))})` : ''}`);
        const base = valor ? `No PIX não há acréscimo (${brl(valor)}).` : 'No PIX não há acréscimo.';
        return partes.length ? `${base} No cartão há acréscimo: ${partes.join('; ')}.` : base;
      }
      if (tipo) {
        const p = pct(tipo);
        return valor
          ? `No cartão de ${this.rotuloTipo(tipo)} há acréscimo de ${p}%: ${brl(valor)} passa a ${brl(this.comAcrescimo(valor, tipo))}. No PIX não há acréscimo.`
          : `No cartão de ${this.rotuloTipo(tipo)} há acréscimo de ${p}%. No PIX não há acréscimo.`;
      }
      return '';
    },

    // Monta o formulário do cartão. "valor" é o LÍQUIDO (o que o cliente leva);
    // o formulário cobra o valor com acréscimo do tipo escolhido.
    async montar({
      containerId, container3dsId, valor, tipo = 'debito', email, doc,
      endpoint, corpoExtra = {}, textoBotao,
      onAprovado, onPendente, onErro, onProcessando,
    }) {
      const cfg = await this.carregarConfig();
      if (!cfg.cartaoDisponivel || !cfg.publicKey) {
        onErro?.('Pagamento no cartão indisponível no momento. Use o PIX.');
        return false;
      }
      await carregarSdk();
      await this.desmontar();
      porEstilo();

      const ehCredito = tipo === 'credito';
      const tipoMp = ehCredito ? 'credit_card' : 'debit_card';
      const valorCobrado = this.comAcrescimo(valor, tipo);

      const alvo = document.getElementById(containerId);
      if (!alvo) { onErro?.('Não consegui montar o formulário do cartão.'); return false; }
      alvo.innerHTML = formHtml({ textoBotao: textoBotao || `Pagar ${brl(valorCobrado)}`, email, doc });

      mp = mp || new window.MercadoPago(cfg.publicKey, { locale: 'pt-BR' });

      // Meios que o Mercado Pago devolve para o BIN digitado. Guardamos porque
      // cartão de função dupla ("múltiplo") aparece nos dois tipos e o cardForm
      // escolhe um sozinho: na hora de pagar trocamos pelo que casa com a aba
      // que o cliente escolheu, senão ele veria "débito" na tela e seria
      // cobrado como crédito.
      let metodosDoBin = [];
      const botao = document.getElementById('form-checkout__submit');

      cardFormAtual = mp.cardForm({
        amount: String(valorCobrado),
        iframe: false,
        form: {
          id: 'form-checkout',
          cardNumber: { id: 'form-checkout__cardNumber' },
          expirationMonth: { id: 'form-checkout__expirationMonth' },
          expirationYear: { id: 'form-checkout__expirationYear' },
          securityCode: { id: 'form-checkout__securityCode' },
          cardholderName: { id: 'form-checkout__cardholderName' },
          issuer: { id: 'form-checkout__issuer' },
          installments: { id: 'form-checkout__installments' },
          identificationType: { id: 'form-checkout__identificationType' },
          identificationNumber: { id: 'form-checkout__identificationNumber' },
          cardholderEmail: { id: 'form-checkout__cardholderEmail' },
        },
        callbacks: {
          onFormMounted: (erro) => {
            if (erro) {
              console.error('[cartao] onFormMounted:', erro);
              onErro?.('Não consegui carregar o formulário do cartão. Tente o PIX.');
              return;
            }
            reforcarAutocomplete();
            for (const id of Object.keys(AUTOCOMPLETE_CAMPOS)) {
              document.getElementById(id)?.addEventListener('focus', reforcarAutocomplete);
            }
          },
          onPaymentMethodsReceived: (erro, metodos) => {
            if (!erro && Array.isArray(metodos)) metodosDoBin = metodos;
          },
          onIssuersReceived: (erro, emissores) => {
            // O seletor de banco só faz sentido quando há mais de um emissor
            // para a bandeira; com um só, o cardForm já preenche sozinho.
            const bloco = document.getElementById('pgc-emissor');
            if (bloco) bloco.classList.toggle('pgc-oculto', !!erro || !Array.isArray(emissores) || emissores.length < 2);
          },
          onError: (erros) => {
            const lista = Array.isArray(erros) ? erros : [erros];
            const msg = lista.map(e => e?.message).filter(Boolean).join(' ');
            console.error('[cartao] cardForm:', erros);
            onErro?.(msg || 'Confira os dados do cartão e tente de novo.');
            if (botao) botao.disabled = false;
            onProcessando?.(false);
          },
          onSubmit: async (evento) => {
            evento.preventDefault();
            onErro?.('');
            onProcessando?.(true);
            if (botao) botao.disabled = true;
            try {
              const d = cardFormAtual.getCardFormData();
              if (!d?.token) {
                onErro?.('Confira os dados do cartão e tente de novo.');
                onProcessando?.(false);
                if (botao) botao.disabled = false;
                return;
              }

              // Cartão de função dupla: escolhe o meio do tipo pedido.
              const doTipo = metodosDoBin.find(m => m.payment_type_id === tipoMp);
              const metodoAtual = metodosDoBin.find(m => m.id === d.paymentMethodId);
              if (metodoAtual && metodoAtual.payment_type_id !== tipoMp && !doTipo) {
                onErro?.(ehCredito
                  ? 'Esse cartão é de débito. Volte e escolha a opção "Débito".'
                  : 'Esse cartão é de crédito. Volte e escolha a opção "Crédito".');
                onProcessando?.(false);
                if (botao) botao.disabled = false;
                return;
              }

              const r = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  ...corpoExtra,
                  // O servidor confere o tipo na lista do MP e recusa se não
                  // bater com esta aba — quem paga não pode ver 5% na tela e
                  // ser cobrado 7%.
                  tipo_cartao: tipo,
                  token: d.token,
                  payment_method_id: (doTipo && doTipo.id) || d.paymentMethodId,
                  issuer_id: d.issuerId,
                  payer: {
                    email: d.cardholderEmail,
                    identification: { type: d.identificationType, number: d.identificationNumber },
                  },
                }),
              });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) {
                onProcessando?.(false);
                if (botao) botao.disabled = false;
                onErro?.(data.error || 'Não foi possível concluir o pagamento. Tente o PIX.');
                return;
              }
              if (data.status === 'approved') {
                onAprovado?.(data);
                return;
              }
              // Pendente: no débito o emissor quase sempre pede o desafio do
              // 3DS (a tela do banco). Ela é montada pelo Status Screen Brick,
              // que devolve o resultado na própria tela; a confirmação de
              // verdade vem do polling da página, que pergunta ao servidor.
              if (data.threeDs?.externalResourceURL && container3dsId) {
                await PagamentoCartao.montarDesafio3ds({
                  containerId: container3dsId,
                  paymentId: data.paymentId,
                  threeDs: data.threeDs,
                  onErro,
                });
              }
              onPendente?.(data);
            } catch (e) {
              console.error('[cartao] envio:', e);
              onProcessando?.(false);
              if (botao) botao.disabled = false;
              onErro?.('Erro de conexão ao enviar o pagamento. Tente de novo.');
            }
          },
        },
      });
      return true;
    },

    // Desafio 3DS: o Status Screen Brick redireciona para o banco, traz o
    // cliente de volta e mostra o desfecho. Precisa do paymentId e do par
    // externalResourceURL/creq que veio no three_ds_info do pagamento.
    async montarDesafio3ds({ containerId, paymentId, threeDs, onErro }) {
      await carregarSdk();
      if (cardFormAtual) { try { cardFormAtual.unmount(); } catch {} cardFormAtual = null; }
      const alvoForm = document.getElementById('form-checkout');
      if (alvoForm) alvoForm.remove();
      const bricks = mp.bricks();
      brick3ds = await bricks.create('statusScreen', containerId, {
        initialization: {
          paymentId: String(paymentId),
          additionalInfo: { externalResourceURL: threeDs.externalResourceURL, creq: threeDs.creq },
        },
        callbacks: {
          onReady: () => {},
          onError: (erro) => {
            console.error('[cartao] 3ds:', erro);
            onErro?.('Não consegui abrir a confirmação do seu banco. Se o valor não for debitado, tente de novo ou use o PIX.');
          },
        },
      });
    },

    // O SDK do Mercado Pago pede que a instância seja destruída ao sair da
    // tela; sem isso, reabrir o formulário monta um em cima do outro — e os ids
    // (form-checkout__*) são únicos na página.
    async desmontar() {
      if (cardFormAtual) { try { cardFormAtual.unmount(); } catch {} cardFormAtual = null; }
      if (brick3ds) { try { brick3ds.unmount(); } catch {} brick3ds = null; }
      const form = document.getElementById('form-checkout');
      if (form) form.remove();
    },
  };

  window.PagamentoCartao = PagamentoCartao;
})();
