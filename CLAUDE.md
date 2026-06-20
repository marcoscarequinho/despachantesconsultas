<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Plataforma profissional de consultas veiculares e emissão de CRLV-e digital para despachantes, lojistas e escritórios jurídicos. Sistema pré-pago sem mensalidade.">
    <meta name="keywords" content="consulta veicular, CRLV-e, ATPV-e, despachante, documento digital veículo, consulta placa, débitos veiculares">
    <meta name="robots" content="index, follow">

    <!-- Open Graph -->
    <meta property="og:title" content="MC DESPACHADORIA CONSULTAS - Consultas Veiculares e CRLV-e Digital para Profissionais">
    <meta property="og:description" content="Plataforma B2B de consultas veiculares e emissão de documentos digitais. Sem mensalidade, crédito pré-pago via PIX.">
    <meta property="og:type" content="website">

    <title>MC DESPACHADORIA CONSULTAS - Consultas Veiculares e CRLV-e Digital para Profissionais</title>

    <!-- Tailwind CSS -->
    <script src="https://cdn.tailwindcss.com"></script>

    <style>
        :root {
            --primary: #1e40af;
            --secondary: #374151;
            --accent: #f97316;
            --light: #f3f4f6;
        }

        html {
            scroll-behavior: smooth;
        }

        .topbar {
            background: var(--secondary);
            color: white;
        }

        .btn-primary {
            background: var(--accent);
            color: white;
            padding: 0.75rem 2rem;
            border-radius: 0.5rem;
            font-weight: 600;
            transition: all 0.3s;
        }

        .btn-primary:hover {
            background: #ea580c;
            transform: translateY(-2px);
        }

        .btn-secondary {
            background: var(--primary);
            color: white;
            padding: 0.75rem 2rem;
            border-radius: 0.5rem;
            font-weight: 600;
            transition: all 0.3s;
        }

        .btn-secondary:hover {
            background: #1e3a8a;
            transform: translateY(-2px);
        }

        .stat-card {
            background: white;
            padding: 1.5rem;
            border-radius: 0.5rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            text-align: center;
        }

        .feature-card {
            background: white;
            padding: 2rem;
            border-radius: 0.5rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            transition: all 0.3s;
        }

        .feature-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 8px 12px rgba(0,0,0,0.15);
        }

        .faq-item {
            border: 1px solid #e5e7eb;
            border-radius: 0.5rem;
            margin-bottom: 1rem;
            overflow: hidden;
        }

        .faq-question {
            background: #f9fafb;
            padding: 1.25rem;
            cursor: pointer;
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .faq-question:hover {
            background: #f3f4f6;
        }

        .faq-answer {
            padding: 0 1.25rem;
            max-height: 0;
            overflow: hidden;
            transition: all 0.3s;
        }

        .faq-answer.active {
            padding: 1.25rem;
            max-height: 500px;
        }

        .whatsapp-float {
            position: fixed;
            bottom: 30px;
            right: 30px;
            background: #25d366;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
            transition: all 0.3s;
        }

        .whatsapp-float:hover {
            transform: scale(1.1);
            background: #20ba5a;
        }

        .step-number {
            width: 60px;
            height: 60px;
            background: var(--accent);
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            font-weight: bold;
            margin: 0 auto 1rem;
        }

        .legal-section {
            background: #f9fafb;
            padding: 3rem 0;
        }

        .legal-content {
            background: white;
            padding: 2rem;
            border-radius: 0.5rem;
            margin-bottom: 2rem;
        }

        .legal-content h3 {
            color: var(--primary);
            font-size: 1.5rem;
            font-weight: 700;
            margin: 2rem 0 1rem;
        }

        .legal-content h4 {
            color: var(--secondary);
            font-size: 1.25rem;
            font-weight: 600;
            margin: 1.5rem 0 0.75rem;
        }

        .legal-content p, .legal-content ul {
            margin-bottom: 1rem;
            line-height: 1.8;
        }

        .legal-content ul {
            list-style: disc;
            padding-left: 2rem;
        }
    </style>
</head>
<body class="bg-gray-50">

    <!-- Topbar -->
    <div class="topbar text-sm py-2 px-4">
        <div class="container mx-auto flex flex-wrap justify-between items-center">
            <div class="font-semibold">Consultas veiculares rápidas e seguras</div>
            <div class="flex gap-4 items-center text-xs md:text-sm">
                <a href="tel:(22) 99995-1574" class="hover:text-orange-400">📞 (22) 99995-1574</a>
                <a href="https://wa.me/5522999951574" class="hover:text-orange-400">💬 WhatsApp</a>
                <a href="mailto:contato@mcdespachadoria.com.br" class="hover:text-orange-400">✉️ contato@mcdespachadoria.com.br</a>
            </div>
        </div>
    </div>

    <!-- Header/Nav -->
    <header class="bg-white shadow-md sticky top-0 z-50">
        <div class="container mx-auto px-4 py-4">
            <nav class="flex justify-between items-center flex-wrap">
                <div class="text-2xl font-bold text-blue-900">
                    <a href="#hero">MC DESPACHADORIA</a>
                </div>

                <button id="menu-toggle" class="md:hidden text-gray-700">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
                    </svg>
                </button>

                <ul id="menu" class="hidden md:flex gap-6 text-sm font-medium w-full md:w-auto mt-4 md:mt-0">
                    <li><a href="#vantagens" class="hover:text-orange-500">Vantagens</a></li>
                    <li><a href="#revenda" class="hover:text-orange-500">Seja Revendedor</a></li>
                    <li><a href="#sobre" class="hover:text-orange-500">Sobre</a></li>
                    <li><a href="#recursos" class="hover:text-orange-500">Recursos</a></li>
                    <li><a href="#precos" class="hover:text-orange-500">Preços</a></li>
                    <li><a href="#como-funciona" class="hover:text-orange-500">Como Funciona</a></li>
                    <li><a href="#faq" class="hover:text-orange-500">FAQ</a></li>
                    <li><a href="#contato" class="hover:text-orange-500">Contato</a></li>
                </ul>

                <div class="hidden md:flex gap-3">
                    <a href="/entrar" class="text-sm font-semibold text-blue-900 hover:text-orange-500">Entrar</a>
                    <a href="/cadastrar" class="btn-primary text-sm">Criar Conta</a>
                </div>
            </nav>
        </div>
    </header>

    <!-- Hero -->
    <section id="hero" class="bg-gradient-to-r from-blue-900 to-blue-700 text-white py-20">
        <div class="container mx-auto px-4">
            <div class="grid md:grid-cols-2 gap-12 items-center">
                <div>
                    <h1 class="text-4xl md:text-5xl font-bold mb-6">
                        Consultas Veiculares e CRLV-e Digital para Profissionais
                    </h1>
                    <p class="text-xl mb-8 text-gray-200">
                        Plataforma completa para despachantes, lojistas de veículos e escritórios jurídicos.
                        Sistema pré-pago sem mensalidade, com créditos via PIX.
                    </p>
                    <div class="flex gap-4 flex-wrap">
                        <a href="/cadastrar" class="btn-primary">Começar Agora - Grátis</a>
                        <a href="#como-funciona" class="btn-secondary">Como Funciona</a>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4">
                    <div class="stat-card">
                        <div class="text-3xl font-bold text-orange-500">27</div>
                        <div class="text-gray-600 mt-2">UFs com CRLV-e</div>
                    </div>
                    <div class="stat-card">
                        <div class="text-3xl font-bold text-orange-500">30+</div>
                        <div class="text-gray-600 mt-2">Tipos de Consulta</div>
                    </div>
                    <div class="stat-card">
                        <div class="text-3xl font-bold text-orange-500">25s</div>
                        <div class="text-gray-600 mt-2">Resposta Turbo</div>
                    </div>
                    <div class="stat-card">
                        <div class="text-3xl font-bold text-orange-500">PIX</div>
                        <div class="text-gray-600 mt-2">Instantâneo</div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- Vantagens (Afiliados) -->
    <section id="vantagens" class="py-16 bg-white">
        <div class="container mx-auto px-4">
            <div class="max-w-4xl mx-auto">
                <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Programa de Afiliados</h2>
                <p class="text-center text-gray-600 mb-12">Indique clientes e ganhe comissão sobre cada depósito aprovado</p>

                <div class="grid md:grid-cols-2 gap-8">
                    <div class="feature-card">
                        <div class="text-4xl mb-4">🔗</div>
                        <h3 class="text-xl font-bold mb-3 text-blue-900">Link de Indicação</h3>
                        <p class="text-gray-600">
                            Acesse seu painel e gere seu link exclusivo de afiliado. Compartilhe com seus contatos e
                            acompanhe todas as indicações em tempo real.
                        </p>
                    </div>

                    <div class="feature-card">
                        <div class="text-4xl mb-4">💰</div>
                        <h3 class="text-xl font-bold mb-3 text-blue-900">Comissão Recorrente</h3>
                        <p class="text-gray-600">
                            Ganhe um percentual sobre cada depósito aprovado que seus indicados realizarem na plataforma.
                            Quanto mais indicar, mais você ganha.
                        </p>
                    </div>
                </div>

                <div class="mt-8 p-6 bg-orange-50 border-l-4 border-orange-500 rounded">
                    <p class="text-gray-700">
                        <strong>Regra Antifraude:</strong> Cadastros realizados pelo mesmo IP do afiliado não geram comissão.
                        Mantenha sempre práticas éticas de indicação.
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- Revenda -->
    <section id="revenda" class="py-16 bg-gray-100">
        <div class="container mx-auto px-4">
            <div class="max-w-4xl mx-auto">
                <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Programa de Revenda</h2>
                <p class="text-center text-gray-600 mb-12">Seja um revendedor e opere seu próprio negócio de consultas veiculares</p>

                <div class="grid md:grid-cols-3 gap-6 mb-10">
                    <div class="feature-card text-center">
                        <div class="text-4xl mb-4">👥</div>
                        <h3 class="text-lg font-bold mb-3 text-blue-900">Cadastre Clientes</h3>
                        <p class="text-gray-600">
                            Crie e gerencie contas de seus próprios clientes direto do seu painel de revendedor.
                        </p>
                    </div>

                    <div class="feature-card text-center">
                        <div class="text-4xl mb-4">📈</div>
                        <h3 class="text-lg font-bold mb-3 text-blue-900">Defina Seu Markup</h3>
                        <p class="text-gray-600">
                            Aplique sua margem de lucro sobre a tabela base e repasse para seus clientes.
                        </p>
                    </div>

                    <div class="feature-card text-center">
                        <div class="text-4xl mb-4">💵</div>
                        <h3 class="text-lg font-bold mb-3 text-blue-900">Comissão Maior</h3>
                        <p class="text-gray-600">
                            Revendedores ganham comissões diferenciadas sobre depósitos dos clientes cadastrados.
                        </p>
                    </div>
                </div>

                <div class="bg-white p-8 rounded-lg shadow-md text-center">
                    <h3 class="text-2xl font-bold mb-4 text-blue-900">Painel Exclusivo de Revendedor</h3>
                    <p class="text-gray-600 mb-6">
                        Gerencie toda sua operação, clientes, comissões e relatórios em um painel completo e intuitivo.
                        Acompanhe o desempenho de cada cliente e otimize seus resultados.
                    </p>
                    <a href="/cadastrar/revendedor" class="btn-primary inline-block">Quero Ser Revendedor</a>
                </div>
            </div>
        </div>
    </section>

    <!-- Parcerias Despachantes -->
    <section id="parcerias" class="py-16 bg-blue-900 text-white">
        <div class="container mx-auto px-4">
            <div class="max-w-3xl mx-auto text-center">
                <h2 class="text-3xl md:text-4xl font-bold mb-6">Parceria para Despachantes</h2>
                <p class="text-xl mb-8 text-gray-200">
                    Você é despachante e possui serviços próprios (transferências, licenciamentos, regularizações)?
                    Ofereça seus serviços através da nossa plataforma e alcance novos clientes!
                </p>
                <p class="text-lg mb-8">
                    Entre em contato via WhatsApp para conhecer as condições da parceria e começar a expandir seu negócio.
                </p>
                <a href="https://wa.me/5522999951574?text=Olá, gostaria de saber mais sobre parcerias para despachantes"
                   class="btn-primary inline-block text-lg">
                    💬 Falar com Parceiro Comercial
                </a>
            </div>
        </div>
    </section>

    <!-- Recursos/Funcionalidades -->
    <section id="recursos" class="py-16 bg-white">
        <div class="container mx-auto px-4">
            <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Recursos e Funcionalidades</h2>
            <p class="text-center text-gray-600 mb-12">Tudo que você precisa para trabalhar com eficiência</p>

            <div class="grid md:grid-cols-3 gap-6">
                <div class="feature-card">
                    <div class="text-4xl mb-4">📄</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">CRLV-e Digital</h3>
                    <p class="text-gray-600">
                        Emissão de CRLV-e (Certificado de Registro e Licenciamento de Veículo eletrônico)
                        para 27 UFs brasileiras, com validade oficial.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">🔍</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Consulta por Placa</h3>
                    <p class="text-gray-600">
                        Dados completos do veículo: marca, modelo, ano, cor, chassis, motor, categoria e muito mais.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">💳</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Débitos e Multas</h3>
                    <p class="text-gray-600">
                        Consulta detalhada de débitos de IPVA, licenciamento, multas de trânsito e outras pendências.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">📊</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Análise de Crédito</h3>
                    <p class="text-gray-600">
                        Integração com Serasa, SPC e Boa Vista para consulta de score, restrições e histórico de crédito.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">⚡</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Retorno Rápido</h3>
                    <p class="text-gray-600">
                        Consultas turbo processadas em até 25 segundos. Emissões agendadas conforme prazo de cada UF.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">🔒</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Segurança e LGPD</h3>
                    <p class="text-gray-600">
                        Plataforma 100% em conformidade com a LGPD. Seus dados e de seus clientes protegidos com criptografia.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">📋</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Histórico no Painel</h3>
                    <p class="text-gray-600">
                        Acesse todas as consultas realizadas, recargas, comissões e extratos financeiros no seu painel.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">🤝</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Programa de Afiliados</h3>
                    <p class="text-gray-600">
                        Indique novos usuários e ganhe comissão sobre os depósitos aprovados realizados por eles.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-4xl mb-4">🔐</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Código de Segurança</h3>
                    <p class="text-gray-600">
                        Geração de código de segurança do veículo (CRV) para validações e procedimentos oficiais.
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- Preços -->
    <section id="precos" class="py-16 bg-gray-100">
        <div class="container mx-auto px-4">
            <div class="max-w-3xl mx-auto">
                <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Preços Transparentes</h2>
                <p class="text-center text-gray-600 mb-12">Sem mensalidade. Pague apenas pelo que usar.</p>

                <div class="bg-white p-8 rounded-lg shadow-md">
                    <div class="text-center mb-8">
                        <div class="text-5xl font-bold text-orange-500 mb-2">R$ 0</div>
                        <div class="text-xl text-gray-600">Mensalidade</div>
                    </div>

                    <div class="border-t border-gray-200 pt-6">
                        <h3 class="text-xl font-bold mb-4 text-blue-900">Como Funciona?</h3>
                        <ul class="space-y-3 text-gray-700">
                            <li class="flex items-start">
                                <span class="text-orange-500 mr-2">✓</span>
                                <span>Cadastro 100% gratuito sem compromisso</span>
                            </li>
                            <li class="flex items-start">
                                <span class="text-orange-500 mr-2">✓</span>
                                <span>Tabela completa de preços disponível no painel após cadastro</span>
                            </li>
                            <li class="flex items-start">
                                <span class="text-orange-500 mr-2">✓</span>
                                <span>Créditos pré-pagos via PIX com compensação instantânea</span>
                            </li>
                            <li class="flex items-start">
                                <span class="text-orange-500 mr-2">✓</span>
                                <span>Pague somente pelas consultas e emissões que efetivamente usar</span>
                            </li>
                            <li class="flex items-start">
                                <span class="text-orange-500 mr-2">✓</span>
                                <span>Sem taxas escondidas ou valores surpresa</span>
                            </li>
                        </ul>
                    </div>

                    <div class="mt-8 p-6 bg-blue-50 border-l-4 border-blue-500 rounded">
                        <p class="font-semibold text-blue-900 mb-2">⚠️ Cadastro com Dados Reais Obrigatório</p>
                        <p class="text-gray-700 text-sm">
                            Por questões de segurança e conformidade legal, exigimos cadastro com informações reais e verificáveis.
                            Cadastros com dados falsos, temporários ou duplicados serão recusados ou bloqueados sem aviso prévio.
                        </p>
                    </div>

                    <div class="text-center mt-8">
                        <a href="/cadastrar" class="btn-primary inline-block">Criar Conta e Ver Preços</a>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- Mockup Painel -->
    <section id="mockup" class="py-16 bg-white">
        <div class="container mx-auto px-4">
            <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Painel Intuitivo e Completo</h2>
            <p class="text-center text-gray-600 mb-12">Interface simples para você trabalhar com agilidade</p>

            <div class="max-w-4xl mx-auto">
                <div class="bg-gray-800 rounded-lg p-6 shadow-2xl">
                    <div class="flex gap-2 mb-4">
                        <div class="w-3 h-3 rounded-full bg-red-500"></div>
                        <div class="w-3 h-3 rounded-full bg-yellow-500"></div>
                        <div class="w-3 h-3 rounded-full bg-green-500"></div>
                    </div>

                    <div class="bg-white rounded p-6">
                        <div class="border-b pb-4 mb-4">
                            <h3 class="text-xl font-bold text-green-600 flex items-center gap-2">
                                ✓ Consulta Concluída
                            </h3>
                        </div>

                        <div class="grid md:grid-cols-2 gap-4 mb-6">
                            <div>
                                <div class="text-sm text-gray-500 mb-1">Placa</div>
                                <div class="font-bold text-lg">ABC-1D23</div>
                            </div>
                            <div>
                                <div class="text-sm text-gray-500 mb-1">Tipo de Consulta</div>
                                <div class="font-bold text-lg">CRLV-e Digital</div>
                            </div>
                            <div>
                                <div class="text-sm text-gray-500 mb-1">Veículo</div>
                                <div class="font-bold">HONDA CIVIC EXL 2.0</div>
                            </div>
                            <div>
                                <div class="text-sm text-gray-500 mb-1">UF</div>
                                <div class="font-bold">São Paulo - SP</div>
                            </div>
                            <div>
                                <div class="text-sm text-gray-500 mb-1">Renavam</div>
                                <div class="font-bold">12345678901</div>
                            </div>
                            <div>
                                <div class="text-sm text-gray-500 mb-1">Status</div>
                                <div class="font-bold text-green-600">✓ Documento Disponível</div>
                            </div>
                        </div>

                        <div class="flex gap-3">
                            <button class="btn-primary flex items-center gap-2">
                                📥 Baixar PDF
                            </button>
                            <button class="btn-secondary flex items-center gap-2">
                                📄 Ver Detalhes
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- Como Funciona -->
    <section id="como-funciona" class="py-16 bg-gradient-to-b from-blue-50 to-white">
        <div class="container mx-auto px-4">
            <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Como Funciona?</h2>
            <p class="text-center text-gray-600 mb-12">Comece a usar em 4 passos simples</p>

            <div class="max-w-4xl mx-auto grid md:grid-cols-4 gap-8">
                <div class="text-center">
                    <div class="step-number">1</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Criar Conta</h3>
                    <p class="text-gray-600">
                        Cadastro rápido e gratuito com seus dados reais. Acesse a tabela completa de preços.
                    </p>
                </div>

                <div class="text-center">
                    <div class="step-number">2</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Adicionar Créditos</h3>
                    <p class="text-gray-600">
                        Faça uma recarga via PIX. Compensação instantânea através de gateway seguro.
                    </p>
                </div>

                <div class="text-center">
                    <div class="step-number">3</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Fazer Consultas</h3>
                    <p class="text-gray-600">
                        Escolha o tipo de consulta, informe a placa e pronto. Resultado em segundos.
                    </p>
                </div>

                <div class="text-center">
                    <div class="step-number">4</div>
                    <h3 class="text-xl font-bold mb-3 text-blue-900">Baixar Documentos</h3>
                    <p class="text-gray-600">
                        Documentos em PDF com validade oficial. Acesso ilimitado ao histórico.
                    </p>
                </div>
            </div>

            <div class="text-center mt-12">
                <a href="/cadastrar" class="btn-primary inline-block text-lg">Criar Minha Conta Grátis</a>
            </div>
        </div>
    </section>

    <!-- Para Quem -->
    <section id="sobre" class="py-16 bg-white">
        <div class="container mx-auto px-4">
            <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Para Quem é a Plataforma?</h2>
            <p class="text-center text-gray-600 mb-12">Soluções especializadas para cada segmento</p>

            <div class="max-w-5xl mx-auto grid md:grid-cols-3 gap-8">
                <div class="feature-card">
                    <div class="text-5xl mb-4 text-center">🏢</div>
                    <h3 class="text-2xl font-bold mb-4 text-blue-900 text-center">Despachantes</h3>
                    <p class="text-gray-600">
                        Agilize seu trabalho diário com consultas rápidas e emissão de CRLV-e digital.
                        Reduza filas, economize tempo e ofereça um serviço mais ágil aos seus clientes.
                        Torne-se parceiro e ofereça seus próprios serviços pela plataforma.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-5xl mb-4 text-center">🚗</div>
                    <h3 class="text-2xl font-bold mb-4 text-blue-900 text-center">Lojistas de Veículos</h3>
                    <p class="text-gray-600">
                        Valide rapidamente a situação de veículos antes de negociar. Consulte débitos,
                        restrições e histórico de crédito do comprador. Emita documentos necessários
                        na hora e feche negócios com mais segurança e confiança.
                    </p>
                </div>

                <div class="feature-card">
                    <div class="text-5xl mb-4 text-center">⚖️</div>
                    <h3 class="text-2xl font-bold mb-4 text-blue-900 text-center">Escritórios Jurídicos</h3>
                    <p class="text-gray-600">
                        Obtenha informações completas sobre veículos em processos judiciais,
                        inventários e disputas patrimoniais. Consultas detalhadas para embasar
                        petições, pareceres e diligências com dados oficiais atualizados.
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- API para Empresas -->
    <section id="api" class="py-16 bg-gray-900 text-white">
        <div class="container mx-auto px-4">
            <div class="max-w-4xl mx-auto">
                <h2 class="text-3xl md:text-4xl font-bold text-center mb-4">API para Empresas</h2>
                <p class="text-center text-gray-300 mb-12">Integre nossos serviços diretamente no seu sistema</p>

                <div class="bg-gray-800 rounded-lg p-8 mb-8">
                    <h3 class="text-2xl font-bold mb-4 text-orange-500">Acesso Exclusivo por Contrato</h3>
                    <p class="text-gray-300 mb-6">
                        Nossa API REST está disponível apenas para empresas com CNPJ ativo, mediante análise comercial
                        e assinatura de contrato. Não oferecemos acesso self-service à API.
                    </p>

                    <div class="grid md:grid-cols-2 gap-6 mb-8">
                        <div>
                            <h4 class="font-bold text-lg mb-2 text-orange-400">✓ Requisitos</h4>
                            <ul class="text-gray-300 space-y-1 text-sm">
                                <li>• CNPJ ativo e regularizado</li>
                                <li>• Análise comercial aprovada</li>
                                <li>• Contrato formal assinado</li>
                                <li>• Volume mínimo mensal</li>
                            </ul>
                        </div>
                        <div>
                            <h4 class="font-bold text-lg mb-2 text-orange-400">✓ Benefícios</h4>
                            <ul class="text-gray-300 space-y-1 text-sm">
                                <li>• Integração completa via REST API</li>
                                <li>• Documentação técnica detalhada</li>
                                <li>• Suporte técnico prioritário</li>
                                <li>• Webhooks para notificações</li>
                            </ul>
                        </div>
                    </div>

                    <div class="bg-gray-700 rounded p-4 mb-6">
                        <h4 class="font-bold mb-3 text-orange-400">Exemplo de Requisição:</h4>
                        <pre class="text-xs bg-gray-900 p-4 rounded overflow-x-auto"><code>POST /api/v1/consultas/crlv
Content-Type: application/json
Authorization: Bearer SEU_TOKEN_API

{
  "placa": "ABC1D23",
  "uf": "SP",
  "renavam": "12345678901"
}</code></pre>
                    </div>

                    <div class="bg-gray-700 rounded p-4">
                        <h4 class="font-bold mb-3 text-orange-400">Exemplo de Resposta:</h4>
                        <pre class="text-xs bg-gray-900 p-4 rounded overflow-x-auto"><code>{
  "status": "success",
  "consulta_id": "uuid-da-consulta",
  "placa": "ABC1D23",
  "veiculo": {
    "marca": "HONDA",
    "modelo": "CIVIC EXL 2.0",
    "ano_fabricacao": "2022",
    "ano_modelo": "2023",
    "cor": "PRATA"
  },
  "documento_url": "https://...",
  "creditos_utilizados": 15.00
}</code></pre>
                    </div>
                </div>

                <div class="text-center">
                    <a href="https://wa.me/5522999951574?text=Gostaria de saber mais sobre a API para empresas"
                       class="btn-primary inline-block text-lg">
                        📞 Solicitar Análise Comercial
                    </a>
                </div>
            </div>
        </div>
    </section>

    <!-- FAQ -->
    <section id="faq" class="py-16 bg-white">
        <div class="container mx-auto px-4">
            <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Perguntas Frequentes</h2>
            <p class="text-center text-gray-600 mb-12">Tire suas dúvidas sobre a plataforma</p>

            <div class="max-w-3xl mx-auto">
                <div class="faq-item">
                    <div class="faq-question">
                        <span>Por que não posso usar dados falsos no cadastro?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Por questões de segurança, conformidade legal (LGPD) e prevenção a fraudes, exigimos
                            cadastro com informações reais e verificáveis. Trabalhamos com dados sensíveis e
                            documentos oficiais, portanto mantemos rigoroso controle sobre quem acessa a plataforma.
                            Cadastros com dados falsos, temporários, descartáveis ou duplicados serão recusados
                            ou bloqueados sem aviso prévio.
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Como faço para ver os preços dos serviços?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            A tabela completa de preços fica disponível no painel da plataforma após o cadastro
                            gratuito. Isso garante que apenas profissionais realmente interessados tenham acesso
                            às informações comerciais. O cadastro é rápido, sem compromisso e sem cobrança de
                            mensalidade.
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Existe mensalidade ou taxa de manutenção?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Não. A plataforma funciona 100% no modelo pré-pago. Você só paga pelas consultas e
                            emissões que efetivamente realizar. Não há mensalidade, anuidade, taxa de manutenção
                            ou qualquer cobrança recorrente. Seus créditos não expiram.
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Como funciona o programa de afiliados?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Após criar sua conta, você terá acesso a um link exclusivo de afiliado no painel.
                            Compartilhe esse link com seus contatos. Quando alguém se cadastrar através do seu
                            link e fizer depósitos aprovados, você ganha uma comissão percentual sobre cada
                            depósito. Importante: cadastros pelo mesmo IP não geram comissão (regra antifraude).
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Despachantes podem oferecer serviços próprios na plataforma?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Sim! Despachantes que possuem serviços próprios (transferências, licenciamentos,
                            regularizações, etc.) podem se tornar parceiros e oferecê-los através da nossa
                            plataforma, alcançando novos clientes. Entre em contato via WhatsApp para conhecer
                            as condições da parceria.
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Qual o prazo para emissão do CRLV-e?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            As consultas turbo são processadas em até 25 segundos. Já as emissões de CRLV-e
                            dependem do prazo de processamento de cada UF (órgão estadual). Emissões agendadas
                            podem levar de minutos a horas, conforme disponibilidade dos sistemas dos DETRANs.
                            Você acompanha o status em tempo real no painel.
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Todos os estados brasileiros estão disponíveis?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Sim para consultas básicas. Para emissão de CRLV-e digital, atualmente atendemos
                            27 UFs brasileiras. A cobertura é ampliada conforme os DETRANs estaduais disponibilizam
                            integração. Consulte no painel quais serviços estão disponíveis para cada estado.
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Fazem análise de crédito (Serasa, SPC)?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Sim. Oferecemos integração com os principais bureaus de crédito do Brasil: Serasa,
                            SPC e Boa Vista. Você pode consultar score, restrições, protestos e histórico de
                            crédito de pessoas físicas e jurídicas diretamente pela plataforma.
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Posso integrar a plataforma ao meu sistema via API?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Sim, mas apenas para empresas com CNPJ. O acesso à API não é self-service: é necessário
                            passar por análise comercial e assinar um contrato formal. Entre em contato via WhatsApp
                            para solicitar análise e conhecer os requisitos (volume mínimo, SLA, documentação técnica, etc.).
                        </p>
                    </div>
                </div>

                <div class="faq-item">
                    <div class="faq-question">
                        <span>Como faço recarga de créditos?</span>
                        <span class="faq-icon">+</span>
                    </div>
                    <div class="faq-answer">
                        <p class="text-gray-700">
                            Dentro do painel, clique em "Adicionar Créditos", informe o valor desejado e escolha
                            PIX como forma de pagamento. Você receberá o QR Code para pagar via PIX. A compensação
                            é instantânea através do nosso gateway de pagamento, e os créditos são liberados
                            automaticamente em sua conta.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- Termos de Uso -->
    <section id="termos" class="legal-section">
        <div class="container mx-auto px-4">
            <div class="max-w-4xl mx-auto">
                <div class="legal-content">
                    <h2 class="text-3xl font-bold text-center mb-8 text-blue-900">Termos de Uso</h2>

                    <p class="text-gray-600 text-sm mb-6">
                        <strong>Última atualização:</strong> 20 de junho de 2026
                    </p>

                    <h3>1. Aceitação dos Termos</h3>
                    <p>
                        Ao acessar e utilizar a plataforma MC DESPACHADORIA CONSULTAS ("Plataforma"), você ("Usuário") concorda
                        integralmente com estes Termos de Uso. Se você não concorda com qualquer disposição destes
                        Termos, não deve utilizar a Plataforma.
                    </p>

                    <h3>2. Objeto do Serviço</h3>
                    <p>
                        A Plataforma oferece serviços de consultas veiculares, emissão de documentos digitais
                        (CRLV-e, ATPV-e, Código de Segurança), consultas de débitos e multas, análise de crédito,
                        entre outros serviços relacionados, destinados exclusivamente a profissionais (despachantes,
                        lojistas de veículos, escritórios jurídicos e empresas).
                    </p>

                    <h3>3. Cadastro e Responsabilidade da Conta</h3>
                    <h4>3.1. Dados Reais Obrigatórios</h4>
                    <p>
                        O Usuário declara e garante que todas as informações fornecidas no cadastro são verdadeiras,
                        precisas, atualizadas e verificáveis. Cadastros com dados falsos, temporários, descartáveis
                        ou fraudulentos serão recusados ou bloqueados sem aviso prévio e sem direito a reembolso.
                    </p>

                    <h4>3.2. Responsabilidade pela Conta</h4>
                    <p>
                        O Usuário é o único responsável por manter a confidencialidade de sua senha e por todas
                        as atividades realizadas em sua conta. Qualquer uso não autorizado deve ser comunicado
                        imediatamente à Plataforma.
                    </p>

                    <h4>3.3. Unicidade de Cadastro</h4>
                    <p>
                        Cada CPF ou CNPJ pode possuir apenas uma conta na Plataforma. Cadastros duplicados serão
                        bloqueados.
                    </p>

                    <h3>4. Créditos e Recargas</h3>
                    <h4>4.1. Sistema Pré-Pago</h4>
                    <p>
                        A Plataforma funciona exclusivamente no modelo pré-pago. O Usuário deve adicionar créditos
                        à sua conta antes de utilizar os serviços.
                    </p>

                    <h4>4.2. Natureza dos Créditos</h4>
                    <p>
                        Os créditos não constituem depósito bancário ou aplicação financeira. Trata-se de moeda
                        virtual para uso exclusivo na Plataforma, sem prazo de validade.
                    </p>

                    <h4>4.3. Forma de Pagamento</h4>
                    <p>
                        As recargas são realizadas via PIX, com compensação instantânea através de gateway de
                        pagamento autorizado.
                    </p>

                    <h3>5. Regras Específicas sobre Emissão de CRLV-e</h3>
                    <h4>5.1. Responsabilidade do Usuário</h4>
                    <p>
                        O Usuário é responsável por verificar previamente a situação do veículo antes de solicitar
                        a emissão do CRLV-e (débitos, bloqueios, restrições judiciais ou administrativas).
                        A Plataforma não se responsabiliza por impossibilidade de emissão decorrente de irregularidades
                        do próprio veículo.
                    </p>

                    <h4>5.2. Serviço Processado sem Estorno</h4>
                    <p>
                        <strong>IMPORTANTE:</strong> Uma vez que a solicitação de emissão do CRLV-e seja processada
                        pela Plataforma junto aos órgãos competentes, o serviço é considerado efetivamente prestado,
                        ainda que o documento não possa ser emitido por irregularidade do veículo (débito pendente,
                        bloqueio, restrição judicial/administrativa, etc.). Nesses casos, NÃO haverá estorno de
                        créditos, uma vez que o processamento já foi realizado.
                    </p>

                    <h4>5.3. Dependência de Terceiros</h4>
                    <p>
                        A emissão de CRLV-e depende da disponibilidade e do tempo de resposta dos sistemas dos
                        DETRANs estaduais e outros órgãos públicos. A Plataforma não garante prazos específicos,
                        que podem variar conforme a UF.
                    </p>

                    <h3>6. Cancelamentos e Reembolsos</h3>
                    <h4>6.1. Consultas e Emissões Processadas</h4>
                    <p>
                        Consultas e emissões efetivamente processadas NÃO são reembolsáveis, conforme item 5.2.
                    </p>

                    <h4>6.2. Erro da Plataforma</h4>
                    <p>
                        Caso ocorra erro técnico comprovadamente originado pela Plataforma (não por terceiros ou
                        órgãos públicos), o Usuário poderá solicitar reembolso em créditos ou revisão da cobrança.
                    </p>

                    <h4>6.3. Recargas Não Utilizadas</h4>
                    <p>
                        Créditos adicionados à conta e não utilizados em consultas/emissões podem ser solicitados
                        para estorno ao saldo bancário, mediante análise e dedução de eventuais taxas administrativas
                        ou de gateway.
                    </p>

                    <h3>7. Uso Permitido e Proibido</h3>
                    <h4>7.1. Uso Profissional</h4>
                    <p>
                        A Plataforma destina-se exclusivamente a uso profissional por despachantes, lojistas de
                        veículos, escritórios jurídicos e empresas. Uso para fins ilícitos, fraudulentos ou em
                        desacordo com a legislação brasileira é terminantemente proibido.
                    </p>

                    <h4>7.2. Proibições</h4>
                    <ul>
                        <li>Revender acesso à Plataforma sem autorização expressa;</li>
                        <li>Utilizar meios automatizados (bots, scrapers) sem contrato de API;</li>
                        <li>Compartilhar credenciais de acesso com terceiros;</li>
                        <li>Realizar engenharia reversa ou tentativas de invasão;</li>
                        <li>Violar direitos de propriedade intelectual.</li>
                    </ul>

                    <h3>8. Propriedade Intelectual</h3>
                    <p>
                        Todos os direitos sobre a Plataforma, incluindo marcas, logotipos, código-fonte, layout
                        e conteúdo, pertencem à MC Despachadoria Consultas LTDA ou seus licenciadores. É proibida a reprodução,
                        distribuição ou uso não autorizado.
                    </p>

                    <h3>9. Disponibilidade do Serviço</h3>
                    <p>
                        A Plataforma se esforça para manter os serviços disponíveis 24/7, mas não garante
                        disponibilidade ininterrupta. Manutenções programadas serão comunicadas previamente.
                        Indisponibilidade causada por terceiros (DETRANs, provedores de infraestrutura, etc.)
                        não gera direito a ressarcimento.
                    </p>

                    <h3>10. Limitação de Responsabilidade</h3>
                    <p>
                        A Plataforma não se responsabiliza por:
                    </p>
                    <ul>
                        <li>Danos indiretos, lucros cessantes ou perdas de negócio;</li>
                        <li>Indisponibilidade de sistemas de terceiros (DETRANs, bureaus de crédito);</li>
                        <li>Uso indevido de informações pelo Usuário;</li>
                        <li>Decisões tomadas com base em consultas realizadas.</li>
                    </ul>

                    <h3>11. Privacidade e LGPD</h3>
                    <p>
                        O tratamento de dados pessoais pela Plataforma é regido pela Política de Privacidade,
                        disponível em seção específica deste site, em conformidade com a Lei Geral de Proteção
                        de Dados (Lei 13.709/2018).
                    </p>

                    <h3>12. Comunicações</h3>
                    <p>
                        O Usuário autoriza o envio de comunicações por e-mail, SMS, WhatsApp e notificações no
                        painel relacionadas ao uso da Plataforma (confirmações, alertas de saldo, novidades).
                        Comunicações comerciais podem ser descontinuadas a pedido do Usuário.
                    </p>

                    <h3>13. Suspensão e Encerramento de Conta</h3>
                    <p>
                        A Plataforma reserva-se o direito de suspender ou encerrar contas que violem estes Termos,
                        apresentem atividade suspeita ou fraudulenta, ou mantenham cadastro com dados falsos/inverificáveis.
                    </p>

                    <h3>14. Alterações dos Termos</h3>
                    <p>
                        Estes Termos podem ser atualizados a qualquer momento. Alterações substanciais serão
                        comunicadas ao Usuário. O uso continuado da Plataforma após a publicação de novos Termos
                        implica aceitação.
                    </p>

                    <h3>15. Lei Aplicável e Foro</h3>
                    <p>
                        Estes Termos são regidos pelas leis da República Federativa do Brasil. Fica eleito o
                        foro da comarca de Araruama/RJ para dirimir quaisquer controvérsias.
                    </p>

                    <h3>16. Aceite Eletrônico</h3>
                    <p>
                        Ao clicar em "Aceito os Termos de Uso" ou ao utilizar a Plataforma, o Usuário manifesta
                        seu consentimento livre, expresso e informado a todos os termos e condições aqui estabelecidos.
                    </p>

                    <hr class="my-8 border-gray-300">

                    <p class="text-sm text-gray-600">
                        <strong>MC Despachadoria Consultas LTDA</strong><br>
                        CNPJ: 57.138.895/0001-42<br>
                        Endereço: Rua Antenor Soares de Souza, 658 Loja C - Mataruana, Araruama/RJ - CEP 28970-735<br>
                        E-mail: contato@mcdespachadoria.com.br<br>
                        Telefone: (22) 99995-1574
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- Política de Privacidade -->
    <section id="privacidade" class="legal-section">
        <div class="container mx-auto px-4">
            <div class="max-w-4xl mx-auto">
                <div class="legal-content">
                    <h2 class="text-3xl font-bold text-center mb-8 text-blue-900">Política de Privacidade e LGPD</h2>

                    <p class="text-gray-600 text-sm mb-6">
                        <strong>Última atualização:</strong> 20 de junho de 2026
                    </p>

                    <h3>1. Introdução</h3>
                    <p>
                        Esta Política de Privacidade descreve como a MC Despachadoria Consultas LTDA ("nós", "nosso" ou "Plataforma")
                        coleta, usa, armazena e protege os dados pessoais dos usuários ("você", "Usuário") da
                        plataforma MC DESPACHADORIA CONSULTAS, em conformidade com a Lei Geral de Proteção de Dados (Lei 13.709/2018 - LGPD).
                    </p>

                    <h3>2. Controlador de Dados e DPO</h3>
                    <p>
                        <strong>Controlador:</strong> MC Despachadoria Consultas LTDA, CNPJ 57.138.895/0001-42, com sede em Rua Antenor Soares de Souza, 658 Loja C - Mataruana, Araruama/RJ - CEP 28970-735.
                    </p>
                    <p>
                        <strong>Encarregado de Dados (DPO):</strong> Dr. Rafael Mendes Costa<br>
                        <strong>Contato DPO:</strong> dpo@mcdespachadoria.com.br
                    </p>
                    <p>
                        Para exercer seus direitos ou esclarecer dúvidas sobre privacidade, entre em contato com
                        nosso DPO.
                    </p>

                    <h3>3. Dados Coletados</h3>

                    <h4>3.1. Dados Fornecidos pelo Usuário</h4>
                    <ul>
                        <li><strong>Cadastro:</strong> nome completo, CPF ou CNPJ, e-mail, telefone, endereço;</li>
                        <li><strong>Financeiro:</strong> informações de recarga (PIX), histórico de transações;</li>
                        <li><strong>Consultas:</strong> placas de veículos, Renavam, CPF/CNPJ consultados, dados
                        solicitados em análises de crédito.</li>
                    </ul>

                    <h4>3.2. Dados Coletados Automaticamente</h4>
                    <ul>
                        <li>Endereço IP, navegador, dispositivo, sistema operacional;</li>
                        <li>Logs de acesso, data e hora de uso;</li>
                        <li>Cookies e tecnologias similares (ver seção 9).</li>
                    </ul>

                    <h4>3.3. Dados Consultados em Bases Públicas e Privadas</h4>
                    <ul>
                        <li>Informações veiculares obtidas junto a DETRANs e órgãos de trânsito;</li>
                        <li>Dados de crédito obtidos de bureaus (Serasa, SPC, Boa Vista), mediante solicitação
                        expressa do Usuário para consulta de terceiros.</li>
                    </ul>

                    <h3>4. Finalidade do Tratamento de Dados</h3>
                    <p>Os dados pessoais são tratados para:</p>
                    <ul>
                        <li>Criar e gerenciar sua conta na Plataforma;</li>
                        <li>Processar consultas veiculares e emissões de documentos solicitadas;</li>
                        <li>Processar pagamentos e recargas de créditos;</li>
                        <li>Fornecer suporte técnico e atendimento ao cliente;</li>
                        <li>Prevenir fraudes e garantir a segurança da Plataforma;</li>
                        <li>Cumprir obrigações legais e regulatórias;</li>
                        <li>Enviar comunicações relacionadas ao serviço (confirmações, alertas, atualizações);</li>
                        <li>Melhorar a experiência do Usuário e desenvolver novos recursos;</li>
                        <li>Realizar análises estatísticas e de uso (dados anonimizados).</li>
                    </ul>

                    <h3>5. Bases Legais do Tratamento (LGPD)</h3>
                    <p>O tratamento de dados pessoais ocorre com base nas seguintes hipóteses legais:</p>
                    <ul>
                        <li><strong>Execução de contrato (Art. 7º, V):</strong> para prestar os serviços contratados;</li>
                        <li><strong>Obrigação legal (Art. 7º, II):</strong> para cumprir determinações legais e
                        regulatórias (ex.: retenção de logs, emissão de notas fiscais);</li>
                        <li><strong>Legítimo interesse (Art. 7º, IX):</strong> prevenção a fraudes, segurança da
                        Plataforma, melhoria de serviços;</li>
                        <li><strong>Consentimento (Art. 7º, I):</strong> quando aplicável, especialmente para
                        comunicações comerciais opcionais.</li>
                    </ul>

                    <h3>6. Compartilhamento de Dados</h3>
                    <h4>6.1. Com Quem Compartilhamos</h4>
                    <p>Podemos compartilhar seus dados com:</p>
                    <ul>
                        <li><strong>Órgãos públicos:</strong> DETRANs e autoridades de trânsito, para processamento
                        de consultas e emissões;</li>
                        <li><strong>Bureaus de crédito:</strong> Serasa, SPC, Boa Vista, mediante sua solicitação
                        expressa de consulta;</li>
                        <li><strong>Provedores de pagamento:</strong> gateways de PIX para processamento de recargas;</li>
                        <li><strong>Prestadores de serviço:</strong> hospedagem, infraestrutura de TI, e-mail, SMS
                        (sob contrato de confidencialidade e conformidade com LGPD);</li>
                        <li><strong>Autoridades legais:</strong> quando exigido por lei, ordem judicial ou para
                        proteger direitos da Plataforma.</li>
                    </ul>

                    <h4>6.2. Não Vendemos Dados</h4>
                    <p>
                        <strong>Jamais vendemos, alugamos ou comercializamos dados pessoais de usuários a terceiros
                        para fins de marketing ou publicidade.</strong>
                    </p>

                    <h3>7. Armazenamento e Segurança</h3>
                    <h4>7.1. Localização dos Dados</h4>
                    <p>
                        Os dados são armazenados em servidores localizados no Brasil e/ou em datacenters de
                        provedores internacionais que garantem conformidade com LGPD.
                    </p>

                    <h4>7.2. Medidas de Segurança</h4>
                    <p>Adotamos medidas técnicas e organizacionais para proteger seus dados:</p>
                    <ul>
                        <li>Criptografia de dados em trânsito (HTTPS/TLS) e em repouso;</li>
                        <li>Controle de acesso restrito a colaboradores autorizados;</li>
                        <li>Monitoramento de atividades suspeitas e tentativas de invasão;</li>
                        <li>Backups regulares e plano de recuperação de desastres;</li>
                        <li>Auditorias periódicas de segurança.</li>
                    </ul>

                    <h4>7.3. Limitações</h4>
                    <p>
                        Apesar de todos os esforços, nenhum sistema é 100% seguro. O Usuário também deve adotar
                        boas práticas (senha forte, não compartilhar credenciais, etc.).
                    </p>

                    <h3>8. Direitos do Titular de Dados</h3>
                    <p>Conforme a LGPD, você tem direito a:</p>
                    <ul>
                        <li><strong>Confirmação e acesso:</strong> saber se tratamos seus dados e acessá-los;</li>
                        <li><strong>Correção:</strong> solicitar correção de dados incompletos ou desatualizados;</li>
                        <li><strong>Anonimização, bloqueio ou eliminação:</strong> de dados desnecessários ou
                        tratados em desconformidade;</li>
                        <li><strong>Portabilidade:</strong> receber seus dados em formato estruturado;</li>
                        <li><strong>Informação sobre compartilhamento:</strong> saber com quem compartilhamos seus dados;</li>
                        <li><strong>Revogação do consentimento:</strong> quando o tratamento for baseado em consentimento;</li>
                        <li><strong>Oposição:</strong> opor-se a tratamentos realizados com base em legítimo interesse.</li>
                    </ul>
                    <p>
                        Para exercer seus direitos, entre em contato com nosso DPO: dpo@mcdespachadoria.com.br.
                    </p>

                    <h3>9. Cookies</h3>
                    <p>
                        Utilizamos cookies e tecnologias similares para melhorar a experiência do Usuário,
                        lembrar preferências, analisar tráfego e prevenir fraudes.
                    </p>

                    <h4>9.1. Tipos de Cookies</h4>
                    <ul>
                        <li><strong>Essenciais:</strong> necessários para funcionamento básico da Plataforma;</li>
                        <li><strong>Funcionais:</strong> lembram preferências e configurações;</li>
                        <li><strong>Analíticos:</strong> medem desempenho e uso (Google Analytics ou similar);</li>
                        <li><strong>Segurança:</strong> detectam atividades suspeitas.</li>
                    </ul>

                    <h4>9.2. Gerenciamento</h4>
                    <p>
                        Você pode gerenciar ou desativar cookies nas configurações do navegador. Atenção:
                        desativar cookies essenciais pode afetar o funcionamento da Plataforma.
                    </p>

                    <h3>10. Retenção e Eliminação de Dados</h3>
                    <p>
                        Mantemos seus dados pessoais apenas pelo tempo necessário para cumprir as finalidades
                        descritas nesta Política ou conforme exigido por lei.
                    </p>
                    <ul>
                        <li><strong>Dados de cadastro:</strong> durante a vigência da conta e por até 5 anos após
                        encerramento (obrigação legal fiscal/contábil);</li>
                        <li><strong>Logs de acesso:</strong> conforme exigido pelo Marco Civil da Internet (6 meses);</li>
                        <li><strong>Consultas e transações:</strong> por até 5 anos (obrigações legais e contratuais).</li>
                    </ul>
                    <p>
                        Após esses prazos, os dados serão eliminados ou anonimizados de forma irreversível.
                    </p>

                    <h3>11. Menores de Idade</h3>
                    <p>
                        A Plataforma não se destina a menores de 18 anos. Não coletamos intencionalmente dados
                        de crianças ou adolescentes. Caso identifiquemos cadastro de menor, a conta será
                        encerrada imediatamente.
                    </p>

                    <h3>12. Alterações nesta Política</h3>
                    <p>
                        Esta Política pode ser atualizada periodicamente. Alterações substanciais serão comunicadas
                        por e-mail ou notificação no painel. Recomendamos revisar esta página regularmente.
                    </p>

                    <h3>13. Contato</h3>
                    <p>
                        Para dúvidas, solicitações ou exercício de direitos relacionados à privacidade e proteção
                        de dados:
                    </p>
                    <p>
                        <strong>Encarregado de Dados (DPO):</strong> Dr. Rafael Mendes Costa<br>
                        <strong>E-mail:</strong> dpo@mcdespachadoria.com.br<br>
                        <strong>Telefone:</strong> (22) 99995-1574<br>
                        <strong>Endereço:</strong> Rua Antenor Soares de Souza, 658 Loja C - Mataruana, Araruama/RJ - CEP 28970-735
                    </p>

                    <hr class="my-8 border-gray-300">

                    <p class="text-sm text-gray-600">
                        <strong>MC Despachadoria Consultas LTDA</strong><br>
                        CNPJ: 57.138.895/0001-42<br>
                        Endereço: Rua Antenor Soares de Souza, 658 Loja C - Mataruana, Araruama/RJ - CEP 28970-735<br>
                        E-mail: contato@mcdespachadoria.com.br<br>
                        Telefone: (22) 99995-1574
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- Contato -->
    <section id="contato" class="py-16 bg-white">
        <div class="container mx-auto px-4">
            <h2 class="text-3xl md:text-4xl font-bold text-center mb-4 text-blue-900">Entre em Contato</h2>
            <p class="text-center text-gray-600 mb-12">Estamos prontos para atender você</p>

            <div class="max-w-4xl mx-auto grid md:grid-cols-2 gap-8">
                <div>
                    <form class="space-y-4">
                        <div>
                            <label class="block text-sm font-semibold mb-2 text-gray-700">Nome Completo</label>
                            <input type="text" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-orange-500" required>
                        </div>

                        <div>
                            <label class="block text-sm font-semibold mb-2 text-gray-700">E-mail</label>
                            <input type="email" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-orange-500" required>
                        </div>

                        <div>
                            <label class="block text-sm font-semibold mb-2 text-gray-700">Telefone/WhatsApp</label>
                            <input type="tel" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-orange-500">
                        </div>

                        <div>
                            <label class="block text-sm font-semibold mb-2 text-gray-700">Mensagem</label>
                            <textarea rows="5" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-orange-500" required></textarea>
                        </div>

                        <button type="submit" class="btn-primary w-full">Enviar Mensagem</button>
                    </form>
                </div>

                <div>
                    <div class="feature-card h-full">
                        <h3 class="text-xl font-bold mb-6 text-blue-900">Informações de Contato</h3>

                        <div class="space-y-4">
                            <div class="flex items-start gap-3">
                                <div class="text-2xl">📞</div>
                                <div>
                                    <div class="font-semibold text-gray-700">Telefone</div>
                                    <a href="tel:(22) 99995-1574" class="text-orange-500 hover:underline">(22) 99995-1574</a>
                                </div>
                            </div>

                            <div class="flex items-start gap-3">
                                <div class="text-2xl">💬</div>
                                <div>
                                    <div class="font-semibold text-gray-700">WhatsApp</div>
                                    <a href="https://wa.me/5522999951574" class="text-orange-500 hover:underline">5522999951574</a>
                                </div>
                            </div>

                            <div class="flex items-start gap-3">
                                <div class="text-2xl">✉️</div>
                                <div>
                                    <div class="font-semibold text-gray-700">E-mail</div>
                                    <a href="mailto:contato@mcdespachadoria.com.br" class="text-orange-500 hover:underline">contato@mcdespachadoria.com.br</a>
                                </div>
                            </div>

                            <div class="flex items-start gap-3">
                                <div class="text-2xl">🕒</div>
                                <div>
                                    <div class="font-semibold text-gray-700">Horário de Atendimento</div>
                                    <div class="text-gray-600">
                                        Segunda a Sexta: 8h às 18h<br>
                                        Sábado: 8h às 12h
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- CTA Final -->
    <section class="py-16 bg-gradient-to-r from-orange-500 to-orange-600 text-white">
        <div class="container mx-auto px-4 text-center">
            <h2 class="text-3xl md:text-4xl font-bold mb-6">Pronto para Começar?</h2>
            <p class="text-xl mb-8 max-w-2xl mx-auto">
                Cadastro 100% gratuito. Sem mensalidade. Pague apenas pelo que usar.
            </p>
            <div class="flex gap-4 justify-center flex-wrap">
                <a href="/cadastrar" class="bg-white text-orange-600 px-8 py-4 rounded-lg font-bold text-lg hover:bg-gray-100 transition">
                    Criar Conta Grátis
                </a>
                <a href="#como-funciona" class="border-2 border-white text-white px-8 py-4 rounded-lg font-bold text-lg hover:bg-white hover:text-orange-600 transition">
                    Saiba Mais
                </a>
            </div>
        </div>
    </section>

    <!-- Footer -->
    <footer class="bg-gray-900 text-gray-300 py-12">
        <div class="container mx-auto px-4">
            <div class="grid md:grid-cols-4 gap-8 mb-8">
                <div>
                    <div class="text-2xl font-bold text-white mb-4">MC DESPACHADORIA CONSULTAS</div>
                    <p class="text-sm mb-4">
                        Plataforma profissional de consultas veiculares e emissão de documentos digitais.
                    </p>
                    <p class="text-sm">
                        <strong>CNPJ:</strong> 57.138.895/0001-42
                    </p>
                </div>

                <div>
                    <h4 class="font-bold text-white mb-4">Plataforma</h4>
                    <ul class="space-y-2 text-sm">
                        <li><a href="#recursos" class="hover:text-orange-400">Recursos</a></li>
                        <li><a href="#precos" class="hover:text-orange-400">Preços</a></li>
                        <li><a href="#revenda" class="hover:text-orange-400">Seja Revendedor</a></li>
                        <li><a href="#vantagens" class="hover:text-orange-400">Programa de Afiliados</a></li>
                        <li><a href="#api" class="hover:text-orange-400">API</a></li>
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-white mb-4">Acesso</h4>
                    <ul class="space-y-2 text-sm">
                        <li><a href="/entrar" class="hover:text-orange-400">Entrar</a></li>
                        <li><a href="/cadastrar" class="hover:text-orange-400">Criar Conta</a></li>
                        <li><a href="/painel" class="hover:text-orange-400">Painel</a></li>
                        <li><a href="/recuperar-senha" class="hover:text-orange-400">Recuperar Senha</a></li>
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-white mb-4">Suporte</h4>
                    <ul class="space-y-2 text-sm">
                        <li><a href="#faq" class="hover:text-orange-400">FAQ</a></li>
                        <li><a href="#contato" class="hover:text-orange-400">Contato</a></li>
                        <li><a href="#termos" class="hover:text-orange-400">Termos de Uso</a></li>
                        <li><a href="#privacidade" class="hover:text-orange-400">Política de Privacidade</a></li>
                    </ul>
                </div>
            </div>

            <div class="border-t border-gray-700 pt-8 text-center text-sm">
                <p class="mb-2">
                    © 2026 MC Despachadoria Consultas LTDA. Todos os direitos reservados.
                </p>
                <p class="text-xs text-gray-400">
                    🔒 Uso responsável de dados conforme LGPD (Lei 13.709/2018)
                </p>
            </div>
        </div>
    </footer>

    <!-- WhatsApp Flutuante -->
    <a href="https://wa.me/5522999951574?text=Olá, gostaria de saber mais sobre a MC DESPACHADORIA CONSULTAS"
       class="whatsapp-float"
       target="_blank"
       aria-label="WhatsApp">
        <svg class="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
        </svg>
    </a>

    <script>
        // Menu mobile toggle
        document.getElementById('menu-toggle').addEventListener('click', function() {
            const menu = document.getElementById('menu');
            menu.classList.toggle('hidden');
            menu.classList.toggle('flex');
            menu.classList.toggle('flex-col');
        });

        // FAQ accordion
        document.querySelectorAll('.faq-question').forEach(question => {
            question.addEventListener('click', function() {
                const answer = this.nextElementSibling;
                const icon = this.querySelector('.faq-icon');

                // Close all other FAQs
                document.querySelectorAll('.faq-answer').forEach(otherAnswer => {
                    if (otherAnswer !== answer) {
                        otherAnswer.classList.remove('active');
                        otherAnswer.previousElementSibling.querySelector('.faq-icon').textContent = '+';
                    }
                });

                // Toggle current FAQ
                answer.classList.toggle('active');
                icon.textContent = answer.classList.contains('active') ? '−' : '+';
            });
        });

        // Smooth scroll for anchor links
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

                        // Close mobile menu if open
                        const menu = document.getElementById('menu');
                        if (window.innerWidth < 768) {
                            menu.classList.add('hidden');
                            menu.classList.remove('flex', 'flex-col');
                        }
                    }
                }
            });
        });
    </script>
</body>
</html>
