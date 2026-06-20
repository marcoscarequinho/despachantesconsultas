# MC DESPACHADORIA CONSULTAS

Landing page profissional para plataforma B2B de consultas veiculares e emissão de documentos digitais (CRLV-e, ATPV-e, Código de Segurança).

## 📋 Descrição

Plataforma completa destinada a despachantes, lojistas de veículos e escritórios jurídicos no Brasil. Sistema pré-pago sem mensalidade, com créditos via PIX.

## 🚀 Tecnologias Utilizadas

- **HTML5** - Estrutura semântica
- **CSS3** - Estilização customizada
- **JavaScript (ES6+)** - Funcionalidades interativas
- **Tailwind CSS** - Framework CSS utility-first
- **Design Responsivo** - Mobile-first

## 📁 Estrutura de Arquivos

```
mysite/
├── index.html          # Página principal
├── styles.css          # Estilos customizados
├── script.js           # Lógica JavaScript
├── claude.md           # Versão antiga (HTML monolítico)
└── README.md           # Documentação
```

## ⚙️ Funcionalidades

### ✅ Implementadas

- [x] Menu responsivo com mobile menu
- [x] Navegação suave por âncoras
- [x] FAQ accordion interativo
- [x] Formulário de contato funcional
- [x] Animações ao scroll
- [x] Botão flutuante WhatsApp
- [x] Cards de recursos dinâmicos
- [x] Seções de afiliados e revenda
- [x] Conformidade com LGPD
- [x] SEO otimizado

### 🎨 Seções da Landing Page

1. **Hero** - Apresentação principal com mini-stats
2. **Programa de Afiliados** - Sistema de indicações
3. **Programa de Revenda** - Painel exclusivo para revendedores
4. **Parcerias para Despachantes** - Convite para parceiros
5. **Recursos e Funcionalidades** - 9 recursos principais
6. **Preços** - Modelo pré-pago transparente
7. **Como Funciona** - 4 passos simples
8. **FAQ** - 10 perguntas frequentes
9. **Contato** - Formulário + informações
10. **Footer** - Links organizados e informações legais

## 🎯 Como Usar

1. **Abrir o projeto:**
   - Navegue até a pasta `mysite`
   - Abra o arquivo `index.html` no navegador

2. **Desenvolvimento local:**
   ```bash
   # Se tiver Python instalado
   python -m http.server 8000

   # Ou com Node.js
   npx serve
   ```

3. **Acesse:**
   ```
   http://localhost:8000
   ```

## 🔧 Personalização

### Alterar Cores

Edite as variáveis CSS em `styles.css`:

```css
:root {
    --primary: #1e40af;      /* Azul principal */
    --secondary: #374151;    /* Cinza escuro */
    --accent: #f97316;       /* Laranja destaque */
    --light: #f3f4f6;        /* Cinza claro */
}
```

### Modificar Conteúdo

Os dados dinâmicos estão no arquivo `script.js`:

```javascript
const recursos = [...];  // Lista de recursos
const passos = [...];    // Passos "Como Funciona"
const faqData = [...];   // Perguntas frequentes
```

### Atualizar Informações de Contato

Edite diretamente no `index.html` ou crie variáveis em `script.js`.

## 📱 Responsividade

A landing page é totalmente responsiva e otimizada para:

- 📱 Mobile (< 768px)
- 💻 Tablet (768px - 1024px)
- 🖥️ Desktop (> 1024px)

## 🔒 Conformidade LGPD

A página inclui:

- Política de Privacidade completa
- Termos de Uso detalhados
- Informações sobre DPO (Encarregado de Dados)
- Práticas de segurança e armazenamento

## 📞 Informações de Contato

- **Telefone:** (22) 99995-1574
- **WhatsApp:** (22) 99995-1574
- **E-mail:** contato@mcdespachadoria.com.br
- **Endereço:** Rua Antenor Soares de Souza, 658 Loja C - Mataruana, Araruama/RJ
- **CEP:** 28970-735

## 🚧 Próximas Melhorias

- [ ] Integração com backend/API
- [ ] Sistema de autenticação
- [ ] Painel administrativo
- [ ] Dashboard de métricas
- [ ] Testes automatizados
- [ ] PWA (Progressive Web App)
- [ ] Internacionalização (i18n)

## 📄 Licença

© 2026 MC Despachadoria Consultas LTDA. Todos os direitos reservados.

## 👨‍💻 Desenvolvimento

Desenvolvido com ❤️ usando JavaScript moderno e boas práticas de desenvolvimento web.

---

**Versão:** 1.0.0
**Última atualização:** 20 de junho de 2026
