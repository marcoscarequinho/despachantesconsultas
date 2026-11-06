// Funções que o programa Java roda DENTRO das páginas do Detran, pelo
// Runtime.evaluate do Chrome. É o mesmo trabalho que o agendar.js faz com o
// page.evaluate do Playwright (e o detran.js da extensão): escolher no menu,
// preencher a identificação, ler o texto da tela e clicar no que avança.
// O Java monta "(function(){ <este arquivo> return H.acao(args); })()".
const H = {
  norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); },
  soDigitos(s) { return String(s || '').replace(/\D/g, ''); },

  // Marca a escolha no menu do serviço e submete, como o "Continuar" do site.
  menu(acao, itens, opcao, combustivel) {
    const f = document.forms.form;
    if (!f) return 'formulário do menu não encontrado';
    if (itens) {
      // O site já vem com a "Baixa de gravame" marcada: desmarca tudo antes.
      for (const cb of f.querySelectorAll('input[type=checkbox]')) cb.checked = false;
      for (const cod of itens) {
        const cb = f.elements['serv' + cod];
        if (!cb) return 'o serviço ' + cod + ' não existe mais na tela';
        cb.checked = true;
      }
      if (combustivel && f.elements.tipoCombustivel) f.elements.tipoCombustivel.value = combustivel;
    } else {
      const r = f.querySelector('input[name=parte1][value="' + opcao + '"]');
      if (!r) return 'a opção ' + opcao + ' não existe mais na tela';
      r.checked = true;
    }
    f.action = acao;
    f.submit();
    return '';
  },

  temIdentificacao() { return !!(document.forms.Form1 && document.forms.Form1.elements.cpf); },

  preencher(v) {
    const f = document.forms.Form1;
    const doc = H.soDigitos(v.cpfCnpj);
    const radio = f.querySelector('input[name=cpfcnpj][value=' + (doc.length === 14 ? 'cnpj' : 'cpf') + ']');
    if (radio) radio.click(); // na 1ª Licença é o clique que monta o "Quem vai à unidade"
    const tipo = String(v.tipo || '4');
    const selects = { tipo, tipoVeiculo: tipo, RegiaoRenavam: String(v.regiao || '01'), categoria: String(v.categoria || '01'), solicitante: String(v.solicitante || '00'), uf: v.ufOrigem || '' };
    for (const nome in selects) {
      const el = f.elements[nome];
      if (el && selects[nome]) { el.value = selects[nome]; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    if (typeof window.tipoUsuario === 'function' && f.solicitante) window.tipoUsuario(f.solicitante.value);
    const campos = {
      placa: String(v.placa || '').toUpperCase(), renavam: H.soDigitos(v.renavam), chassi: v.chassi || '', crv: v.crv || '',
      data_venda: v.dataVenda || '', duda: H.soDigitos(v.duda), cpf: doc, CEP: H.soDigitos(v.cep), cep: H.soDigitos(v.cep),
      despachante: v.matriculaDespachante || '',
    };
    for (const nome in campos) {
      const el = f.elements[nome];
      if (el && el.type !== 'hidden' && campos[nome]) el.value = campos[nome];
    }
    if (v.tipoDespachante != null && v.tipoDespachante !== '') {
      const td = f.querySelector('input[name=TipoDespachante][value="' + v.tipoDespachante + '"]');
      if (td) td.click();
    }
    const c = document.querySelector('.g-recaptcha');
    if (c) c.scrollIntoView({ block: 'center' });
    return true;
  },

  campos() {
    const mascara = (d) => (d.length > 5 ? d.slice(0, 3) + '*'.repeat(d.length - 5) + d.slice(-2) : d);
    return [...document.forms.Form1.elements]
      .filter((e) => e.name && !['hidden', 'submit', 'reset', 'button', 'textarea'].includes(e.type) && (e.type !== 'radio' || e.checked))
      .map((e) => e.name + '=' + (e.name === 'cpf' ? mascara(e.value) : e.value)).join('\n    ');
  },

  captchaMarcado() { return !!(window.grecaptcha && window.grecaptcha.getResponse && window.grecaptcha.getResponse() !== ''); },

  enviar() {
    const b = document.forms.Form1.querySelector('input[type=submit], button[type=submit]');
    if (b) b.click(); else document.forms.Form1.submit();
    return true;
  },

  texto() { return H.norm(document.body ? document.body.innerText : ''); },
  textoCru() { return (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim(); },
  html() { return document.documentElement.outerHTML; },

  // Marca a página atual: some quando o navegador troca de documento.
  marcar(t) { window.__agendTok = t; return document.readyState; },
  pronta(t) { return window.__agendTok !== t && document.readyState === 'complete'; },
  assinatura() { return location.href + '|' + (document.body ? document.body.innerText.length : 0); },

  escolherPorTexto(termos) {
    const ts = termos.map(H.norm).filter(Boolean);
    if (!ts.length) return null;
    const bate = (txt) => ts.some((t) => H.norm(txt).includes(t));
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
  },

  escolherPrimeiro() {
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
  },

  clicarAvancar() {
    const re = /^(continuar|enviar|avancar|proximo|confirmar|concluir|agendar|ok)$/;
    const el = [...document.querySelectorAll('input[type=submit], input[type=button], button, a')]
      .find((b) => re.test(H.norm(b.value || b.innerText)));
    if (!el) return false;
    el.click();
    return true;
  },
};
