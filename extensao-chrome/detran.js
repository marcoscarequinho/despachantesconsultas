// Agendamento assistido — roda em cada página do agendamento do Detran RJ
// (www5.detran.rj.gov.br/_agendamento.eletronico/…), mas só age na aba que o
// background.js abriu para o agendamento; em qualquer outra aba não faz nada.
//
// Cada carregamento de página é um passo: lê do background o veículo e a
// etapa, faz o que aquela tela pede e avisa o background. As telas:
//   menu0X.asp  — escolha da opção do serviço (submete direto para a tela de
//                 identificação, como o botão "Continuar" do site faz);
//   Form1       — identificação: preenche e PARA no reCAPTCHA. Quem marca é a
//                 pessoa; a extensão só percebe que foi marcado e clica Enviar;
//   depois      — posto, data/turno, horário, conclusão. Não puderam ser vistas
//                 sem um agendamento real (29/10/2026), então a escolha é por
//                 texto; tela que não for entendida vira "faça este passo".
'use strict';

(() => {
  const SERVICOS = {
    propriedade: { menu: 'menu02.asp', continuar: 'menu0204.asp' },
    jurisdicao: { menu: 'menu03.asp', continuar: 'menu0303.asp' },
    municipio: { menu: 'menu04.asp', continuar: 'menu0403.asp' },
  };
  // Textos do Detran para "não tem horário" e "deu certo" (sem acento, minúsculo).
  const SEM_VAGA = /nao ha (vagas?|horarios?|datas?)|sem (vagas?|horarios?) disponive|nenhum(a)? (vaga|horario|data) disponive|esgotad|indisponive/;
  const CONCLUIDO = /agendamento (realizado|efetuado|confirmado) com sucesso|comprovante de agendamento|numero do agendamento|seu agendamento foi/;
  const BOTAO_AVANCAR = /^(continuar|enviar|avancar|proximo|confirmar|concluir|agendar|ok)$/;
  const MAX_PASSOS = 12;

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const msg = (m) => chrome.runtime.sendMessage(m).catch(() => null);
  const mascarar = (d) => (d.length > 5 ? d.slice(0, 3) + '*'.repeat(d.length - 5) + d.slice(-2) : d);

  let saindo = false;
  window.addEventListener('beforeunload', () => { saindo = true; });

  function alertasDaPagina() {
    try { return JSON.parse(document.documentElement.getAttribute('data-detran-alertas') || '[]'); } catch (e) { return []; }
  }

  function textoPagina() { return document.body ? document.body.innerText : ''; }

  // ---------- identificação ----------

  function preencher(f, v) {
    const doc = soDigitos(v.cpfCnpj);
    const radioDoc = f.querySelector(`input[name=cpfcnpj][value=${doc.length === 14 ? 'cnpj' : 'cpf'}]`);
    if (radioDoc) radioDoc.click();
    const selects = {
      tipo: String(v.tipo || '4'),
      RegiaoRenavam: String(v.regiao || '01'),
      categoria: String(v.categoria || '01'),
      solicitante: String(v.solicitante || '00'),
      uf: v.ufOrigem || '',
    };
    // O change dispara o onchange do próprio site (o do "Quem vai à unidade"
    // mostra o campo da matrícula do despachante).
    for (const [nome, valor] of Object.entries(selects)) {
      const el = f.elements[nome];
      if (el && valor) { el.value = valor; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const campos = {
      placa: String(v.placa || '').toUpperCase(),
      renavam: soDigitos(v.renavam),
      chassi: v.chassi || '',
      crv: soDigitos(v.crv),
      data_venda: v.dataVenda || '',
      duda: soDigitos(v.duda),
      cpf: doc,
      CEP: soDigitos(v.cep),
      cep: soDigitos(v.cep),
      despachante: soDigitos(v.matriculaDespachante),
    };
    for (const [nome, valor] of Object.entries(campos)) {
      const el = f.elements[nome];
      if (el && el.type !== 'hidden' && valor) {
        el.value = valor;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (String(v.solicitante) === '03') {
      const td = f.querySelector(`input[name=TipoDespachante][value="${Number(v.tipoDespachante) || 0}"]`);
      if (td) td.click();
    }
  }

  function camposPreenchidos(f) {
    return [...f.elements]
      .filter((e) => e.name && !['hidden', 'submit', 'reset', 'button', 'fieldset', 'textarea'].includes(e.type) && (e.type !== 'radio' || e.checked))
      .map((e) => `${e.name}=${e.name === 'cpf' ? mascarar(e.value) : e.value}`)
      .join(', ');
  }

  async function telaIdentificacao(f, est) {
    const { job, veiculo: v } = est;
    if (job.etapa === 'pos-captcha') {
      // O Detran devolveu a identificação depois do Enviar: recusou algo.
      const motivo = alertasDaPagina().join(' / ') || textoPagina().match(/(atencao|erro|invalid|nao (foi )?(encontrad|localizad|confere))[^\n]{0,160}/i)?.[0] || 'sem mensagem';
      const recusas = (job.recusas || 0) + 1;
      if (recusas >= 3) {
        return msg({ tipo: 'fimVeiculo', placa: v.placa, resultado: 'erro', detalhe: `o Detran recusou a identificação 3 vezes: ${motivo}` });
      }
      await msg({ tipo: 'atualizar', patch: { recusas }, log: `${v.placa} — o Detran devolveu a identificação (${motivo}). Preenchendo de novo.` });
    }
    preencher(f, v);
    if (job.teste) {
      return msg({ tipo: 'fimVeiculo', placa: v.placa, resultado: 'teste', detalhe: `TESTE, nada enviado. Campos: ${camposPreenchidos(f)}` });
    }
    const captcha = document.querySelector('.g-recaptcha');
    if (captcha) captcha.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await msg({ tipo: 'captcha', placa: v.placa });

    // Espera a pessoa marcar: o token aparece no textarea do reCAPTCHA.
    const resposta = () => (document.getElementById('g-recaptcha-response') || {}).value || '';
    while (!resposta()) {
      if (saindo) return;
      await esperar(1000);
    }
    // Dá para ela conferir/corrigir algum campo depois de marcar: os dados da
    // tela valem, não os da lista (o que ela mudou aqui é o que o Detran recebe).
    await msg({ tipo: 'atualizar', patch: { etapa: 'pos-captcha', passo: 0 }, log: `${v.placa} — captcha marcado, enviando.` });
    await esperar(600);
    const enviar = f.querySelector('input[type=submit], button[type=submit]');
    if (enviar) enviar.click(); else f.submit();
  }

  // ---------- telas depois do captcha ----------

  function escolherPorTexto(termos) {
    const ts = termos.map(norm).filter(Boolean);
    if (!ts.length) return null;
    const bate = (txt) => ts.some((t) => norm(txt).includes(t));
    for (const sel of document.querySelectorAll('select')) {
      const op = [...sel.options].find((o) => o.value && !o.disabled && bate(o.text));
      if (op) { sel.value = op.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return op.text.trim(); }
    }
    for (const r of document.querySelectorAll('input[type=radio]')) {
      const txt = (r.labels && r.labels[0] ? r.labels[0].innerText : '') || (r.parentElement ? r.parentElement.innerText : '') || r.value;
      if (!r.disabled && bate(txt)) { r.click(); return txt.trim(); }
    }
    for (const a of document.querySelectorAll('a, button, input[type=button], input[type=submit]')) {
      const txt = a.innerText || a.value || '';
      if (txt && bate(txt) && !/voltar|imprimir|sair/i.test(txt)) { a.click(); return txt.trim(); }
    }
    return null;
  }

  // Data/turno/horário: o primeiro livre.
  function escolherPrimeiro() {
    for (const sel of document.querySelectorAll('select')) {
      const op = [...sel.options].find((o) => o.value && !o.disabled && !/selecione/i.test(o.text));
      if (op && !sel.value) { sel.value = op.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return op.text.trim(); }
    }
    const radios = [...document.querySelectorAll('input[type=radio]')].filter((r) => !r.disabled);
    if (radios.length && !radios.some((r) => r.checked)) {
      radios[0].click();
      return (radios[0].parentElement ? radios[0].parentElement.innerText : radios[0].value).trim();
    }
    return null;
  }

  function clicarAvancar() {
    if (saindo) return true; // a própria escolha já mandou para a próxima tela
    const el = [...document.querySelectorAll('input[type=submit], input[type=button], button, a')]
      .find((b) => BOTAO_AVANCAR.test(norm(b.value || b.innerText)));
    if (!el) return false;
    el.click();
    return true;
  }

  async function telaDepoisDoCaptcha(est) {
    const { job, veiculo: v } = est;
    const passo = (job.passo || 0) + 1;
    if (passo > MAX_PASSOS) {
      return msg({ tipo: 'fimVeiculo', placa: v.placa, resultado: 'erro', detalhe: 'muitas telas sem chegar ao fim do agendamento.' });
    }
    await msg({ tipo: 'atualizar', patch: { passo } });
    await esperar(1200);
    const txt = norm(textoPagina());

    if (CONCLUIDO.test(txt)) {
      const trecho = textoPagina().replace(/\s+/g, ' ').match(/.{0,80}(agendamento|comprovante).{0,200}/i);
      return msg({ tipo: 'fimVeiculo', placa: v.placa, resultado: 'ok', detalhe: trecho ? trecho[0].trim() : '' });
    }
    if (SEM_VAGA.test(txt)) return msg({ tipo: 'semVaga', placa: v.placa });

    if (!job.localEscolhido && (v.cidade || v.posto)) {
      // Cidade e posto podem vir na mesma tela ou em telas seguidas.
      const cidade = v.cidade ? escolherPorTexto([v.cidade]) : null;
      if (cidade) await esperar(1200);
      const posto = v.posto && !saindo ? escolherPorTexto([v.posto]) : null;
      if (cidade || posto) {
        const fechou = !!posto || !v.posto;
        await msg({ tipo: 'atualizar', patch: { localEscolhido: fechou }, log: `${v.placa} — ${[cidade && 'cidade: ' + cidade, posto && 'posto: ' + posto].filter(Boolean).join(', ')}` });
        await esperar(800);
        if (clicarAvancar()) return;
      }
    } else if (job.localEscolhido) {
      const item = escolherPrimeiro();
      if (item) {
        await msg({ tipo: 'atualizar', log: `${v.placa} — escolhido: ${item.replace(/\s+/g, ' ').slice(0, 80)}` });
        await esperar(800);
      }
      if (clicarAvancar()) return;
    }
    const alertas = alertasDaPagina();
    await msg({ tipo: 'passoManual', placa: v.placa, motivo: alertas.length ? `o site avisou: ${alertas.join(' / ')}` : 'não reconheci esta tela' });
  }

  // ---------- início ----------

  (async () => {
    const est = await msg({ tipo: 'estado' });
    if (!est || !est.meu || !est.veiculo) return;
    const { job, veiculo: v } = est;
    if (job.etapa === 'aguardando' || job.etapa === 'fim') return;
    const s = SERVICOS[v.servico];

    const menu = document.querySelector('form[name=form] input[name=parte1]');
    const f = document.forms.Form1;

    if (menu) {
      if (!location.pathname.endsWith('/' + s.menu)) return;
      const form = menu.form;
      const radio = form.querySelector(`input[name=parte1][value="${Number(v.opcao) || 1}"]`);
      if (!radio) return msg({ tipo: 'fimVeiculo', placa: v.placa, resultado: 'erro', detalhe: `a opção ${v.opcao} não existe mais na tela do serviço.` });
      radio.checked = true;
      await msg({ tipo: 'atualizar', patch: { etapa: 'identificacao' } });
      form.action = s.continuar;
      form.submit();
      return;
    }
    if (f && f.elements.placa) return telaIdentificacao(f, est);
    if (job.etapa === 'pos-captcha') return telaDepoisDoCaptcha(est);

    // Tela fora do caminho antes do captcha (erro do site, manutenção…).
    const trecho = textoPagina().replace(/\s+/g, ' ').trim().slice(0, 160);
    await msg({ tipo: 'passoManual', placa: v.placa, motivo: `o Detran mostrou outra tela: ${trecho || 'página em branco'}` });
  })();
})();
