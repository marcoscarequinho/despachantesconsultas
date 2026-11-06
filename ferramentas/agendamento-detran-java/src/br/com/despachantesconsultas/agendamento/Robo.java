package br.com.despachantesconsultas.agendamento;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Agendamento assistido no Detran RJ — a mesma lógica do agendar.js
 * (ferramentas/agendamento-detran), em Java. Abre o serviço, preenche a
 * identificação e PARA no reCAPTCHA: quem marca é a pessoa. Depois tenta a
 * cidade/posto informados e o primeiro dia e horário. Sem vaga, espera o
 * intervalo e tenta de novo. O captcha é sempre de quem está no computador.
 *
 * As telas depois do captcha não foram vistas sem um agendamento de verdade,
 * então a escolha nelas é por texto, e tela que não for entendida vira pausa:
 * a pessoa faz aquele passo no navegador e o programa segue dali.
 */
final class Robo {
    static final String BASE = "https://www5.detran.rj.gov.br/_agendamento.eletronico/renavam2/";

    /** Entrada de cada serviço; "acao" quando a entrada é um menu (ver agendar.js). */
    static final class Servico {
        final String nome, menu, acao;
        final boolean itens;
        Servico(String nome, String menu, String acao, boolean itens) { this.nome = nome; this.menu = menu; this.acao = acao; this.itens = itens; }
    }

    static final Map<String, Servico> SERVICOS = Map.of(
        "propriedade", new Servico("Transferência de Propriedade", "menu02.asp", "menu0204.asp", false),
        "jurisdicao", new Servico("Transferência de Jurisdição", "menu03.asp", "menu0303.asp", false),
        "municipio", new Servico("Troca de Município", "menu04.asp", "menu0403.asp", false),
        "licenca", new Servico("1ª Licença", "tela0c.asp", null, false),
        "alteracao", new Servico("Alteração de Características em Geral", "menu05.asp", "menu0502.asp", true),
        "segundaVia", new Servico("2ª Via de CRV / Código de Segurança", "menu01.asp", "menu0102.asp", false),
        "retificacao", new Servico("Retificação de Dados", "menu08.asp", "menu0802.asp", true),
        "intencao", new Servico("ATPV-e / Intenção de Venda", "intencao_venda.asp", null, false));

    private static final Pattern SEM_VAGA = Pattern.compile("nao ha (vagas?|horarios?|datas?)|sem (vagas?|horarios?) disponive|nenhum(a)? (vaga|horario|data) disponive|esgotad|indisponive");
    private static final Pattern CONCLUIDO = Pattern.compile("agendamento (realizado|efetuado|confirmado) com sucesso|comprovante de agendamento|numero do agendamento|seu agendamento foi");
    private static final Pattern ERRO = Pattern.compile("(atencao|erro|invalid[oa]|nao (foi )?(encontrad|localizad|confere))[^\\n]{0,160}");

    private final Chrome chrome;
    private final Path registros;
    private final Consumer<String> saida;
    private final String paginaJs;
    private volatile boolean parar;
    private int contador;

    Robo(Chrome chrome, Path registros, Consumer<String> saida, String paginaJs) {
        this.chrome = chrome;
        this.registros = registros;
        this.saida = saida;
        this.paginaJs = paginaJs;
    }

    void parar() { parar = true; }

    // ---------- campos do veículo ----------

    static String str(Map<String, Object> v, String k) {
        Object o = v.get(k);
        if (o == null) return "";
        if (o instanceof Double && (Double) o == Math.rint((Double) o)) return String.valueOf(((Double) o).longValue());
        return o.toString();
    }
    static String digitos(String s) { return s.replaceAll("\\D", ""); }
    static int opcao(Map<String, Object> v) { try { return Integer.parseInt(str(v, "opcao")); } catch (NumberFormatException e) { return 1; } }
    static List<String> itens(Map<String, Object> v) {
        List<String> l = new ArrayList<>();
        if (v.get("itens") instanceof List) for (Object o : (List<?>) v.get("itens")) l.add(o instanceof Number ? String.valueOf(((Number) o).longValue()) : String.valueOf(o));
        return l;
    }
    /** DUDA e data só existem no formulário com transferência de propriedade. */
    static boolean temTransferencia(Map<String, Object> v) {
        String s = str(v, "servico");
        return s.equals("propriedade") || ((s.equals("jurisdicao") || s.equals("municipio")) && opcao(v) >= 3);
    }
    /** A 1ª Licença não tem placa: o DUDA identifica o pedido. */
    static String ident(Map<String, Object> v) {
        if (str(v, "servico").equals("licenca")) return str(v, "duda").isEmpty() ? "" : "DUDA " + digitos(str(v, "duda"));
        return str(v, "placa").toUpperCase();
    }
    static String mascarar(String doc) {
        String d = digitos(doc);
        return d.length() > 5 ? d.substring(0, 3) + "*".repeat(d.length() - 5) + d.substring(d.length() - 2) : d;
    }

    /** Mesmas regras do validar() do agendar.js. */
    static List<String> validar(Map<String, Object> v) {
        List<String> erros = new ArrayList<>();
        String s = str(v, "servico");
        if (!SERVICOS.containsKey(s)) { erros.add("serviço desconhecido"); return erros; }
        if (!s.equals("licenca")) {
            if (!str(v, "placa").toUpperCase().matches("[A-Z]{3}\\d[A-Z0-9]\\d{2}")) erros.add("placa inválida");
            if (!digitos(str(v, "renavam")).matches("\\d{9,11}")) erros.add("renavam inválido");
        }
        int doc = digitos(str(v, "cpfCnpj")).length();
        if (doc != 11 && doc != 14) erros.add("CPF/CNPJ deve ter 11 ou 14 dígitos");
        if (List.of("propriedade", "jurisdicao", "municipio", "licenca").contains(s) && !digitos(str(v, "cep")).matches("\\d{8}")) erros.add("CEP inválido");
        if ((temTransferencia(v) || s.equals("licenca")) && !digitos(str(v, "duda")).matches("\\d{1,10}")) erros.add("informe o DUDA pago");
        if (temTransferencia(v) && !str(v, "dataVenda").matches("\\d{2}/\\d{2}/\\d{4}")) erros.add("data da venda no formato dd/mm/aaaa");
        if (s.equals("jurisdicao") && str(v, "ufOrigem").isEmpty()) erros.add("informe a UF de origem");
        if (s.equals("alteracao") && itens(v).isEmpty()) erros.add("marque pelo menos um serviço");
        if (itens(v).contains("40") && str(v, "combustivel").isEmpty()) erros.add("escolha o combustível novo");
        if (str(v, "solicitante").equals("03") && digitos(str(v, "matriculaDespachante")).isEmpty()) erros.add("informe a matrícula do despachante");
        if (str(v, "cidade").isEmpty() && str(v, "posto").isEmpty()) erros.add("informe a cidade e/ou o posto");
        return erros;
    }

    // ---------- página ----------

    private Object js(String chamada) throws Exception {
        return chrome.avaliar("(function(){" + paginaJs + "\nreturn " + chamada + ";})()");
    }

    private void log(Map<String, Object> v, String msg) {
        saida.accept("[" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss")) + "] " + (v != null ? ident(v) + " — " : "") + msg);
    }

    private void dormir(long ms) throws InterruptedException {
        long fim = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < fim) {
            if (parar) throw new InterruptedException("parado");
            Thread.sleep(Math.min(500, Math.max(1, fim - System.currentTimeMillis())));
        }
    }

    /** Espera a página trocar de documento e terminar de carregar. */
    private boolean esperarNovaPagina(String marca, long ms) throws Exception {
        long fim = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < fim) {
            dormir(400);
            try { if (Boolean.TRUE.equals(js("H.pronta(" + Json.stringify(marca) + ")"))) return true; } catch (Exception e) { /* trocando de página */ }
        }
        return false;
    }

    private String marcar() throws Exception {
        String m = "m" + System.nanoTime();
        for (int k = 0; k < 20; k++) {
            try { js("H.marcar(" + Json.stringify(m) + ")"); return m; } catch (Exception e) { dormir(300); }
        }
        return m;
    }

    private String textoPagina() throws Exception {
        for (int k = 0; ; k++) {
            try { return String.valueOf(js("H.texto()")); } catch (Exception e) { if (k > 20) throw e; dormir(500); }
        }
    }

    private String registrar(Map<String, Object> v, String etapa) {
        String nome = ident(v).replace(" ", "") + "-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss")) + "-" + (++contador) + "-" + etapa;
        try {
            Files.createDirectories(registros);
            Files.writeString(registros.resolve(nome + ".html"), String.valueOf(js("H.html()")), StandardCharsets.UTF_8);
            Files.write(registros.resolve(nome + ".png"), Base64.getDecoder().decode(chrome.capturaPng()));
        } catch (Exception e) { /* registro é ajuda, não pode parar o agendamento */ }
        return nome;
    }

    // ---------- telas ----------

    private void abrirIdentificacao(Map<String, Object> v) throws Exception {
        Servico s = SERVICOS.get(str(v, "servico"));
        String marca = marcar();
        chrome.navegar(BASE + s.menu);
        if (!esperarNovaPagina(marca, 60000)) throw new IllegalStateException("o site do Detran não abriu (sem internet ou fora do ar?)");
        if (s.acao != null) {
            String chamada = "H.menu(" + Json.stringify(s.acao) + "," + (s.itens ? Json.stringify(itens(v)) : "null") + ","
                + Json.stringify(String.valueOf(opcao(v))) + "," + Json.stringify(str(v, "combustivel")) + ")";
            marca = marcar();
            Object erro = js(chamada);
            if (erro != null && !String.valueOf(erro).isEmpty()) throw new IllegalStateException("a tela de opções de " + s.nome + " mudou: " + erro);
            esperarNovaPagina(marca, 60000);
        }
        // Entre o menu e a identificação há uma página que se submete sozinha.
        long fim = System.currentTimeMillis() + 60000;
        while (System.currentTimeMillis() < fim) {
            try { if (Boolean.TRUE.equals(js("H.temIdentificacao()")) && Boolean.TRUE.equals(js("document.readyState==='complete'"))) return; } catch (Exception e) { /* carregando */ }
            dormir(500);
        }
        String reg = registrar(v, "sem-identificacao");
        String txt = String.valueOf(js("H.textoCru()"));
        throw new IllegalStateException("o Detran não abriu a tela de identificação (registrada como " + reg + "): " + (txt.length() > 200 ? txt.substring(0, 200) : txt));
    }

    private void preencher(Map<String, Object> v) throws Exception { js("H.preencher(" + Json.stringify(v) + ")"); }

    private void esperarCaptchaEEnviar(Map<String, Object> v, int minutos) throws Exception {
        log(v, ">>> MARQUE O \"NÃO SOU UM ROBÔ\" NA JANELA DO CHROME <<<");
        chrome.trazerParaFrente();
        long fim = System.currentTimeMillis() + minutos * 60000L;
        while (true) {
            dormir(1000);
            Object ok = null;
            try { ok = js("H.captchaMarcado()"); } catch (Exception e) {
                if (!chrome.aberto()) throw new IllegalStateException("a janela do navegador foi fechada");
            }
            if (Boolean.TRUE.equals(ok)) break;
            if (System.currentTimeMillis() > fim) throw new IllegalStateException("ninguém marcou o captcha em " + minutos + " minutos");
        }
        log(v, "captcha marcado, enviando");
        String marca = marcar();
        js("H.enviar()");
        esperarNovaPagina(marca, 90000);
    }

    private boolean clicarAvancar() throws Exception {
        String marca = marcar();
        if (!Boolean.TRUE.equals(js("H.clicarAvancar()"))) return false;
        esperarNovaPagina(marca, 60000);
        return true;
    }

    private void esperarPassoManual(Map<String, Object> v, String motivo) throws Exception {
        log(v, motivo + " — faça este passo no Chrome; o programa continua quando a página mudar.");
        String antes = String.valueOf(js("H.assinatura()"));
        while (true) {
            dormir(1500);
            try { if (!antes.equals(String.valueOf(js("H.assinatura()")))) break; } catch (Exception e) {
                if (!chrome.aberto()) throw new IllegalStateException("a janela do navegador foi fechada");
            }
        }
        dormir(1500);
    }

    /** Telas depois do captcha: "ok", "sem_vaga" ou "erro". */
    private String etapasDoAgendamento(Map<String, Object> v) throws Exception {
        String cidadeV = str(v, "cidade"), postoV = str(v, "posto");
        boolean localEscolhido = false;
        for (int passo = 1; passo <= 12; passo++) {
            dormir(1500);
            String txt = textoPagina();
            String reg = registrar(v, "passo" + passo);
            if (CONCLUIDO.matcher(txt).find()) {
                log(v, "AGENDADO! Comprovante (imagem e página) salvo em registros como " + reg + ".");
                return "ok";
            }
            if (SEM_VAGA.matcher(txt).find()) {
                log(v, "sem vaga nesta tentativa.");
                return "sem_vaga";
            }
            Matcher erro = ERRO.matcher(txt);
            boolean temErro = erro.find();

            if (!localEscolhido && !(cidadeV.isEmpty() && postoV.isEmpty())) {
                String marca = marcar();
                Object cidade = cidadeV.isEmpty() ? null : js("H.escolherPorTexto(" + Json.stringify(List.of(cidadeV)) + ")");
                if (cidade != null) { log(v, "cidade: " + cidade); dormir(1500); }
                // A cidade pode ser um link: a página troca sozinha e o posto vem na próxima.
                boolean mudou;
                try { mudou = Boolean.TRUE.equals(js("H.pronta(" + Json.stringify(marca) + ")")); } catch (Exception e) { mudou = true; }
                Object posto = !postoV.isEmpty() && !mudou ? js("H.escolherPorTexto(" + Json.stringify(List.of(postoV)) + ")") : null;
                if (posto != null) log(v, "posto: " + posto);
                if (posto != null || (cidade != null && postoV.isEmpty())) localEscolhido = true;
                if (cidade != null || posto != null) {
                    dormir(1500);
                    boolean trocou = false;
                    try { trocou = Boolean.TRUE.equals(js("H.pronta(" + Json.stringify(marca) + ")")); } catch (Exception e) { trocou = true; }
                    if (!trocou) clicarAvancar(); else esperarNovaPagina(marca, 30000);
                    continue;
                }
            }
            if (localEscolhido) {
                Object item = js("H.escolherPrimeiro()");
                if (item != null) {
                    String t = String.valueOf(item).replaceAll("\\s+", " ");
                    log(v, "escolhido: " + (t.length() > 80 ? t.substring(0, 80) : t));
                    dormir(800);
                }
                if (clicarAvancar()) continue;
            }
            if (temErro && passo == 1) {
                log(v, "o Detran recusou os dados: " + erro.group());
                return "erro";
            }
            esperarPassoManual(v, "não reconheci esta tela (registrada como " + reg + ")");
        }
        log(v, "muitas telas sem chegar ao fim; parando este veículo.");
        return "erro";
    }

    /** Devolve true se agendou (ou, no teste, se preencheu). */
    boolean agendarVeiculo(Map<String, Object> v, Map<String, Object> opcoes, boolean teste) throws Exception {
        Servico s = SERVICOS.get(str(v, "servico"));
        int intervalo = Math.max(1, numero(opcoes.get("intervaloMinutos"), 15));
        int maxTent = Math.max(0, numero(opcoes.get("maxTentativas"), 0));
        int esperaCaptcha = Math.max(1, numero(opcoes.get("esperaCaptchaMinutos"), 30));
        log(v, s.nome + ", documento " + mascarar(str(v, "cpfCnpj")) + ", local: " + String.join(" / ", naoVazios(str(v, "cidade"), str(v, "posto"))));
        for (int tentativa = 1; maxTent == 0 || tentativa <= maxTent; tentativa++) {
            try {
                chrome.garantir();
                log(v, "tentativa " + tentativa);
                abrirIdentificacao(v);
                preencher(v);
                if (teste) {
                    log(v, "TESTE, nada enviado. Campos preenchidos:\n    " + js("H.campos()"));
                    registrar(v, "teste");
                    return true;
                }
                esperarCaptchaEEnviar(v, esperaCaptcha);
                String r = etapasDoAgendamento(v);
                if (r.equals("ok")) return true;
                if (r.equals("erro")) return false; // dado recusado não melhora tentando de novo
            } catch (InterruptedException e) {
                throw e;
            } catch (Exception e) {
                if (parar) throw new InterruptedException("parado");
                log(v, "falhou: " + e.getMessage());
            }
            if (maxTent != 0 && tentativa >= maxTent) break;
            log(v, "nova tentativa em " + intervalo + " min.");
            dormir(intervalo * 60000L);
        }
        return false;
    }

    private static int numero(Object o, int padrao) {
        if (o instanceof Number) return ((Number) o).intValue();
        try { return Integer.parseInt(String.valueOf(o).trim()); } catch (Exception e) { return padrao; }
    }

    private static List<String> naoVazios(String... ss) {
        List<String> l = new ArrayList<>();
        for (String s : ss) if (!s.isEmpty()) l.add(s);
        return l;
    }
}
