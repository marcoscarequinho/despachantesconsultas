// ===========================================
// DADOS DA APLICAÇÃO
// ===========================================

const recursos = [
    {
        icon: '📄',
        title: 'CRLV-e Digital',
        description: 'Emissão de CRLV-e (Certificado de Registro e Licenciamento de Veículo eletrônico) para 27 UFs brasileiras, com validade oficial.'
    },
    {
        icon: '🔍',
        title: 'Consulta por Placa',
        description: 'Dados completos do veículo: marca, modelo, ano, cor, chassis, motor, categoria e muito mais.'
    },
    {
        icon: '💳',
        title: 'Débitos e Multas',
        description: 'Consulta detalhada de débitos de IPVA, licenciamento, multas de trânsito e outras pendências.'
    },
    {
        icon: '📊',
        title: 'Análise de Crédito',
        description: 'Integração com Serasa, SPC e Boa Vista para consulta de score, restrições e histórico de crédito.'
    },
    {
        icon: '⚡',
        title: 'Retorno Rápido',
        description: 'Consultas turbo processadas em até 25 segundos. Emissões agendadas conforme prazo de cada UF.'
    },
    {
        icon: '🔒',
        title: 'Segurança e LGPD',
        description: 'Plataforma 100% em conformidade com a LGPD. Seus dados e de seus clientes protegidos com criptografia.'
    },
    {
        icon: '📋',
        title: 'Histórico no Painel',
        description: 'Acesse todas as consultas realizadas, recargas, comissões e extratos financeiros no seu painel.'
    },
    {
        icon: '🤝',
        title: 'Programa de Afiliados',
        description: 'Indique novos usuários e ganhe comissão sobre os depósitos aprovados realizados por eles.'
    },
    {
        icon: '🔐',
        title: 'Código de Segurança',
        description: 'Geração de código de segurança do veículo (CRV) para validações e procedimentos oficiais.'
    }
];

const passos = [
    {
        number: 1,
        title: 'Criar Conta',
        description: 'Cadastro rápido e gratuito com seus dados reais. Acesse a tabela completa de preços.'
    },
    {
        number: 2,
        title: 'Adicionar Créditos',
        description: 'Faça uma recarga via PIX. Compensação instantânea através de gateway seguro.'
    },
    {
        number: 3,
        title: 'Fazer Consultas',
        description: 'Escolha o tipo de consulta, informe a placa e pronto. Resultado em segundos.'
    },
    {
        number: 4,
        title: 'Baixar Documentos',
        description: 'Documentos em PDF com validade oficial. Acesso ilimitado ao histórico.'
    }
];

const faqData = [
    {
        question: 'Por que não posso usar dados falsos no cadastro?',
        answer: 'Por questões de segurança, conformidade legal (LGPD) e prevenção a fraudes, exigimos cadastro com informações reais e verificáveis. Trabalhamos com dados sensíveis e documentos oficiais, portanto mantemos rigoroso controle sobre quem acessa a plataforma. Cadastros com dados falsos, temporários, descartáveis ou duplicados serão recusados ou bloqueados sem aviso prévio.'
    },
    {
        question: 'Como faço para ver os preços dos serviços?',
        answer: 'A tabela completa de preços fica disponível no painel da plataforma após o cadastro gratuito. Isso garante que apenas profissionais realmente interessados tenham acesso às informações comerciais. O cadastro é rápido, sem compromisso e sem cobrança de mensalidade.'
    },
    {
        question: 'Existe mensalidade ou taxa de manutenção?',
        answer: 'Não. A plataforma funciona 100% no modelo pré-pago. Você só paga pelas consultas e emissões que efetivamente realizar. Não há mensalidade, anuidade, taxa de manutenção ou qualquer cobrança recorrente. Seus créditos não expiram.'
    },
    {
        question: 'Como funciona o programa de afiliados?',
        answer: 'Após criar sua conta, você terá acesso a um link exclusivo de afiliado no painel. Compartilhe esse link com seus contatos. Quando alguém se cadastrar através do seu link e fizer depósitos aprovados, você ganha uma comissão percentual sobre cada depósito. Importante: cadastros pelo mesmo IP não geram comissão (regra antifraude).'
    },
    {
        question: 'Despachantes podem oferecer serviços próprios na plataforma?',
        answer: 'Sim! Despachantes que possuem serviços próprios (transferências, licenciamentos, regularizações, etc.) podem se tornar parceiros e oferecê-los através da nossa plataforma, alcançando novos clientes. Entre em contato via WhatsApp para conhecer as condições da parceria.'
    },
    {
        question: 'Qual o prazo para emissão do CRLV-e?',
        answer: 'As consultas turbo são processadas em até 25 segundos. Já as emissões de CRLV-e dependem do prazo de processamento de cada UF (órgão estadual). Emissões agendadas podem levar de minutos a horas, conforme disponibilidade dos sistemas dos DETRANs. Você acompanha o status em tempo real no painel.'
    },
    {
        question: 'Todos os estados brasileiros estão disponíveis?',
        answer: 'Sim para consultas básicas. Para emissão de CRLV-e digital, atualmente atendemos 27 UFs brasileiras. A cobertura é ampliada conforme os DETRANs estaduais disponibilizam integração. Consulte no painel quais serviços estão disponíveis para cada estado.'
    },
    {
        question: 'Fazem análise de crédito (Serasa, SPC)?',
        answer: 'Sim. Oferecemos integração com os principais bureaus de crédito do Brasil: Serasa, SPC e Boa Vista. Você pode consultar score, restrições, protestos e histórico de crédito de pessoas físicas e jurídicas diretamente pela plataforma.'
    },
    {
        question: 'Posso integrar a plataforma ao meu sistema via API?',
        answer: 'Sim, mas apenas para empresas com CNPJ. O acesso à API não é self-service: é necessário passar por análise comercial e assinar um contrato formal. Entre em contato via WhatsApp para solicitar análise e conhecer os requisitos (volume mínimo, SLA, documentação técnica, etc.).'
    },
    {
        question: 'Como faço recarga de créditos?',
        answer: 'Dentro do painel, clique em "Adicionar Créditos", informe o valor desejado e escolha PIX como forma de pagamento. Você receberá o QR Code para pagar via PIX. A compensação é instantânea através do nosso gateway de pagamento, e os créditos são liberados automaticamente em sua conta.'
    }
];

// ===========================================
// FUNÇÕES DE RENDERIZAÇÃO
// ===========================================

/**
 * Renderiza os cards de recursos
 */
function renderRecursos() {
    const container = document.getElementById('recursos-grid');
    if (!container) return;

    container.innerHTML = recursos.map(recurso => `
        <div class="feature-card">
            <div class="text-4xl mb-4">${recurso.icon}</div>
            <h3 class="text-xl font-bold mb-3 text-blue-900">${recurso.title}</h3>
            <p class="text-gray-600">${recurso.description}</p>
        </div>
    `).join('');
}

/**
 * Renderiza os passos de "Como Funciona"
 */
function renderPassos() {
    const container = document.getElementById('passos-grid');
    if (!container) return;

    container.innerHTML = passos.map(passo => `
        <div class="text-center">
            <div class="step-number">${passo.number}</div>
            <h3 class="text-xl font-bold mb-3 text-blue-900">${passo.title}</h3>
            <p class="text-gray-600">${passo.description}</p>
        </div>
    `).join('');
}

/**
 * Renderiza o FAQ
 */
function renderFAQ() {
    const container = document.getElementById('faq-container');
    if (!container) return;

    container.innerHTML = faqData.map((item, index) => `
        <div class="faq-item">
            <div class="faq-question" data-faq="${index}">
                <span>${item.question}</span>
                <span class="faq-icon">+</span>
            </div>
            <div class="faq-answer">
                <p class="text-gray-700">${item.answer}</p>
            </div>
        </div>
    `).join('');
}

// ===========================================
// FUNCIONALIDADES INTERATIVAS
// ===========================================

/**
 * Menu mobile toggle
 */
function initMobileMenu() {
    const menuToggle = document.getElementById('menu-toggle');
    const menu = document.getElementById('menu');

    if (menuToggle && menu) {
        menuToggle.addEventListener('click', () => {
            menu.classList.toggle('hidden');
            menu.classList.toggle('flex');
            menu.classList.toggle('flex-col');
        });
    }
}

/**
 * FAQ accordion
 */
function initFAQ() {
    document.querySelectorAll('.faq-question').forEach(question => {
        question.addEventListener('click', function() {
            const answer = this.nextElementSibling;
            const icon = this.querySelector('.faq-icon');

            // Fecha todas as outras FAQs
            document.querySelectorAll('.faq-answer').forEach(otherAnswer => {
                if (otherAnswer !== answer) {
                    otherAnswer.classList.remove('active');
                    otherAnswer.previousElementSibling.querySelector('.faq-icon').textContent = '+';
                }
            });

            // Toggle FAQ atual
            answer.classList.toggle('active');
            icon.textContent = answer.classList.contains('active') ? '−' : '+';
        });
    });
}

/**
 * Smooth scroll para links âncora
 */
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href !== '#' && href !== '') {
                e.preventDefault();
                const target = document.querySelector(href);
                if (target) {
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });

                    // Fecha menu mobile se estiver aberto
                    const menu = document.getElementById('menu');
                    if (window.innerWidth < 768 && menu) {
                        menu.classList.add('hidden');
                        menu.classList.remove('flex', 'flex-col');
                    }
                }
            }
        });
    });
}

/**
 * Formulário de contato
 */
function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;

    form.addEventListener('submit', function(e) {
        e.preventDefault();

        // Obtém os dados do formulário
        const formData = new FormData(form);
        const data = {};
        formData.forEach((value, key) => {
            data[key] = value;
        });

        console.log('Dados do formulário:', data);

        // Aqui você pode adicionar a lógica de envio
        // Por exemplo, enviar para uma API ou servidor

        // Feedback visual
        alert('Mensagem enviada com sucesso! Entraremos em contato em breve.');
        form.reset();
    });
}

/**
 * Animação ao scroll (opcional)
 */
function initScrollAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -100px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);

    // Observa elementos que devem animar
    document.querySelectorAll('.feature-card, .stat-card').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'all 0.5s ease-out';
        observer.observe(el);
    });
}

// ===========================================
// INICIALIZAÇÃO
// ===========================================

/**
 * Função principal de inicialização
 */
function init() {
    // Renderiza conteúdo dinâmico
    renderRecursos();
    renderPassos();
    renderFAQ();

    // Inicializa funcionalidades
    initMobileMenu();
    initFAQ();
    initSmoothScroll();
    initContactForm();
    initScrollAnimations();

    console.log('✅ Landing Page DESPACHANTES CONSULTAS carregada com sucesso!');
}

// Executa quando o DOM estiver pronto
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// ===========================================
// EXPORTS (para uso em módulos, se necessário)
// ===========================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        recursos,
        passos,
        faqData,
        init
    };
}
