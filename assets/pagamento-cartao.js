/* Pagamento no cartão de débito — Checkout Bricks do Mercado Pago.
 *
 * Usado pelas três telas que cobram do cliente (recarga de créditos, consulta
 * avulsa e assinatura). O PIX continua sendo o caminho padrão e sem acréscimo;
 * este arquivo cuida só do "outro meio", que sai 5% mais caro.
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

    // Busca a public key e o percentual do acréscimo no servidor. O percentual
    // vem de lá de propósito: mudar os 5% é mexer numa constante só (server.js),
    // sem precisar caçar número solto no HTML das páginas.
    async carregarConfig() {
      if (this.config) return this.config;
      try {
        const r = await fetch('/api/pagamento/config');
        this.config = await r.json();
      } catch {
        this.config = { publicKey: null, cartaoDisponivel: false, acrescimoCartao: 0.05 };
      }
      return this.config;
    },

    percentual() {
      return (this.config?.acrescimoCartao ?? 0.05);
    },

    // Mesma conta do servidor (valorComAcrescimoCartao), para a tela poder
    // mostrar o valor antes de o cliente escolher.
    comAcrescimo(valor) {
      return Math.round(Number(valor) * (1 + this.percentual()) * 100) / 100;
    },

    brl,

    textoAviso(valor) {
      const pct = Math.round(this.percentual() * 100);
      return valor
        ? `No cartão de débito há acréscimo de ${pct}%: ${brl(valor)} passa a ${brl(this.comAcrescimo(valor))}. No PIX não há acréscimo.`
        : `No cartão de débito há acréscimo de ${pct}%. No PIX não há acréscimo.`;
    },

    // Monta o formulário do cartão. "valor" é o LÍQUIDO (o que o cliente leva);
    // o brick cobra o valor com acréscimo.
    async montar({
      containerId, container3dsId, valor, email, doc,
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

      const valorCobrado = this.comAcrescimo(valor);
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
          // Só débito. A conferência que vale é a do servidor
          // (validarCartaoDebito) — esta aqui é para o cliente não perder tempo
          // digitando um cartão de crédito que seria recusado depois.
          paymentMethods: { types: { excluded: ['credit_card', 'prepaid_card'] }, maxInstallments: 1 },
          visual: {
            style: { theme: 'default' },
            // O título padrão do brick é "Cartão de crédito ou débito" — como
            // crédito está excluído, ele prometeria o que a tela não aceita.
            texts: {
              formTitle: 'Cartão de débito',
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
            // O brick já exclui crédito, mas a bandeira só é conhecida depois
            // do BIN — se ainda assim vier outro tipo, avisa aqui em vez de
            // deixar o servidor recusar com um erro mais seco.
            if (additionalData?.paymentTypeId && additionalData.paymentTypeId !== 'debit_card') {
              onErro?.('Aceitamos apenas cartão de DÉBITO. Para outras formas, use o PIX.');
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
