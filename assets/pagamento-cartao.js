/* Pagamento no cartão — Checkout Bricks do Mercado Pago.
 *
 * Usado pelas três telas que cobram do cliente (recarga de créditos, consulta
 * avulsa e assinatura). O PIX continua sendo o caminho padrão e sem acréscimo;
 * este arquivo cuida do cartão: débito (+5%) ou crédito (+7%), sempre à vista.
 * É um brick por tipo — o total no botão já é o daquele acréscimo, então cada
 * tela monta o formulário do tipo que o cliente escolheu.
 *
 * Por que o formulário é NOSSO e não uma página do Mercado Pago: os campos do
 * brick são iframes do próprio MP (o número do cartão nunca entra no nosso
 * JavaScript nem chega ao nosso servidor — recebemos só um token de uso único),
 * e o campo do número vem marcado como cartão de crédito para o navegador. É
 * isso que faz o iPhone e o Android oferecerem "Escanear cartão" com a câmera:
 * a leitura vai do sistema direto para o campo do MP. Um leitor ótico nosso
 * colocaria o número do cartão dentro do nosso código — é o que não queremos.
 *
 * O valor com acréscimo é sempre RECALCULADO no servidor; o que este arquivo
 * mostra é só a informação para o cliente decidir.
 */
(function () {
  const SDK_URL = 'https://sdk.mercadopago.com/js/v2';

  let sdkCarregando = null;
  let brickCartao = null;
  let brick3ds = null;
  let mp = null;

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

    // Aviso de uma linha. Com valor, mostra quanto fica em cada opção — é o que
    // deixa a escolha honesta antes de o cliente digitar o cartão.
    textoAviso(valor, tipo) {
      const pct = (t) => Math.round(this.percentual(t) * 100);
      if (tipo) {
        const p = pct(tipo);
        return valor
          ? `No cartão de ${this.rotuloTipo(tipo)} há acréscimo de ${p}%: ${brl(valor)} passa a ${brl(this.comAcrescimo(valor, tipo))}. No PIX não há acréscimo.`
          : `No cartão de ${this.rotuloTipo(tipo)} há acréscimo de ${p}%. No PIX não há acréscimo.`;
      }
      return valor
        ? `No PIX não há acréscimo (${brl(valor)}). No débito, +${pct('debito')}% (${brl(this.comAcrescimo(valor, 'debito'))}); no crédito, +${pct('credito')}% (${brl(this.comAcrescimo(valor, 'credito'))}).`
        : `No PIX não há acréscimo. No débito há acréscimo de ${pct('debito')}% e no crédito, de ${pct('credito')}%.`;
    },

    // Monta o formulário do cartão. "valor" é o LÍQUIDO (o que o cliente leva);
    // o brick cobra o valor com acréscimo.
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

      const ehCredito = tipo === 'credito';
      const valorCobrado = this.comAcrescimo(valor, tipo);
      mp = mp || new window.MercadoPago(cfg.publicKey, { locale: 'pt-BR' });
      const bricks = mp.bricks();

      const docLimpo = String(doc || '').replace(/\D/g, '');

      brickCartao = await bricks.create('cardPayment', containerId, {
        initialization: {
          amount: valorCobrado,
          payer: {
            ...(email ? { email } : {}),
            ...(docLimpo ? { identification: { type: docLimpo.length > 11 ? 'CNPJ' : 'CPF', number: docLimpo } } : {}),
          },
        },
        customization: {
          // Um brick por tipo: o total exibido no botão já é o daquele
          // acréscimo, então a tela não pode aceitar o outro tipo. A
          // conferência que vale é a do servidor (validarCartao) — esta aqui é
          // para o cliente não digitar um cartão que seria recusado depois.
          // maxInstallments 1: cobramos sempre à vista (ver installments no
          // criarPagamentoCartao).
          paymentMethods: {
            types: { excluded: ehCredito ? ['debit_card', 'prepaid_card'] : ['credit_card', 'prepaid_card'] },
            maxInstallments: 1,
          },
          visual: {
            style: { theme: 'default' },
            // O título padrão do brick é "Cartão de crédito ou débito" — como
            // um dos dois está excluído, ele prometeria o que a tela não aceita.
            texts: {
              formTitle: ehCredito ? 'Cartão de crédito' : 'Cartão de débito',
              formSubmit: textoBotao || `Pagar ${brl(valorCobrado)}`,
            },
          },
        },
        callbacks: {
          onReady: () => {},
          onError: (erro) => {
            console.error('[cartao] brick:', erro);
            onErro?.(erro?.message || 'Não consegui carregar o formulário do cartão. Tente o PIX.');
          },
          onSubmit: async (cardData, additionalData) => {
            // O brick já exclui o outro tipo, mas a bandeira só é conhecida
            // depois do BIN — se ainda assim vier trocado, avisa aqui, com o
            // total certo, em vez de deixar o servidor recusar mais seco.
            const esperado = ehCredito ? 'credit_card' : 'debit_card';
            if (additionalData?.paymentTypeId && additionalData.paymentTypeId !== esperado) {
              onErro?.(ehCredito
                ? 'Esse cartão é de débito. Volte e escolha a opção "Débito".'
                : 'Esse cartão é de crédito. Volte e escolha a opção "Crédito".');
              return;
            }
            onProcessando?.(true);
            onErro?.('');
            try {
              const r = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  ...corpoExtra,
                  // O servidor confere o tipo na lista do MP e recusa se não
                  // bater com esta aba — quem paga não pode ver 5% na tela e
                  // ser cobrado 7%.
                  tipo_cartao: tipo,
                  token: cardData.token,
                  payment_method_id: cardData.payment_method_id,
                  issuer_id: cardData.issuer_id,
                  payer: cardData.payer,
                }),
              });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) {
                onProcessando?.(false);
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
              onProcessando?.(false);
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
      if (brickCartao) { try { brickCartao.unmount(); } catch {} brickCartao = null; }
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
    // tela; sem isso, reabrir o formulário monta um brick em cima do outro.
    async desmontar() {
      if (brickCartao) { try { brickCartao.unmount(); } catch {} brickCartao = null; }
      if (brick3ds) { try { brick3ds.unmount(); } catch {} brick3ds = null; }
    },
  };

  window.PagamentoCartao = PagamentoCartao;
})();
