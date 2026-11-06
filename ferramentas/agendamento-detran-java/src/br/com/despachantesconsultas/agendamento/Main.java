package br.com.despachantesconsultas.agendamento;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Agendamento Detran RJ — versão Java (sem Node, sem instalador .exe).
 *
 * Igual ao servidor.js da versão Node: serve o MESMO painel.html (copiado
 * para dentro do .jar pelo build, sem segunda cópia para manter) em
 * http://localhost:3940 e responde as mesmas /api. A porta é outra para as
 * duas versões poderem estar instaladas ao mesmo tempo. Só escuta em
 * 127.0.0.1: o veiculos.json tem CPF e renavam de clientes.
 *
 * Os dados ficam em %LOCALAPPDATA%\Agendamento Detran RJ (Java), fora da
 * pasta do programa: baixar uma versão nova e descompactar por cima não
 * apaga os veículos.
 */
public final class Main {
    static final int PORTA = 3940;
    static final String URL = "http://localhost:" + PORTA + "/";

    private final Path pasta;
    private final Path arqDados;
    private final Chrome chrome;
    private final String paginaJs;
    private final List<String> linhas = new ArrayList<>();
    private int inicioLog = 0;
    private volatile Thread trabalho;
    private volatile Robo robo;

    private Main(Path pasta) throws IOException {
        this.pasta = pasta;
        Files.createDirectories(pasta);
        this.arqDados = pasta.resolve("veiculos.json");
        this.chrome = new Chrome(pasta.resolve("perfil-chrome"), this::addLinha);
        this.paginaJs = recurso("/pagina.js");
    }

    static String recurso(String nome) throws IOException {
        try (InputStream in = Main.class.getResourceAsStream(nome)) {
            if (in == null) throw new IOException("recurso " + nome + " não está no .jar");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    static Path pastaDados() {
        String base = System.getenv("LOCALAPPDATA");
        if (base == null) base = System.getProperty("user.home");
        return Paths.get(base, "Agendamento Detran RJ (Java)");
    }

    public static void main(String[] args) throws Exception {
        Main m = new Main(pastaDados());
        // Modo de linha de comando, para conferir sem a tela:
        //   java -jar agendamento.jar --teste [PLACA]   (só preenche, não envia)
        if (args.length > 0 && args[0].equals("--teste")) {
            m.rodar(args.length > 1 ? args[1] : null, true, System.out::println);
            m.chrome.encerrar();
            return;
        }
        HttpServer s;
        try {
            s = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), PORTA), 0);
        } catch (BindException e) {
            abrirNavegador(); // já aberto por um clique anterior: só mostra a tela
            return;
        }
        s.createContext("/", m::atender);
        s.setExecutor(Executors.newCachedThreadPool());
        s.start();
        if (!List.of(args).contains("--sem-navegador")) abrirNavegador();
    }

    static void abrirNavegador() {
        try { new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", URL).start(); } catch (IOException e) { /* a pessoa abre à mão */ }
    }

    // ---------- andamento ----------

    synchronized void addLinha(String texto) {
        for (String l : texto.split("\\r?\\n")) if (!l.isBlank()) linhas.add(l);
        if (linhas.size() > 2000) {
            int sobra = linhas.size() - 2000;
            linhas.subList(0, sobra).clear();
            inicioLog += sobra;
        }
    }

    private synchronized Map<String, Object> lerDados() throws IOException {
        if (!Files.exists(arqDados)) {
            Map<String, Object> d = new LinkedHashMap<>();
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("intervaloMinutos", 15L);
            o.put("maxTentativas", 0L);
            o.put("esperaCaptchaMinutos", 30L);
            d.put("opcoes", o);
            d.put("veiculos", new ArrayList<>());
            return d;
        }
        return Json.objeto(Files.readString(arqDados, StandardCharsets.UTF_8));
    }

    private synchronized void gravarDados(Map<String, Object> d) throws IOException {
        Path tmp = arqDados.resolveSibling("veiculos.json.tmp");
        Files.writeString(tmp, Json.stringify(d), StandardCharsets.UTF_8);
        Files.move(tmp, arqDados, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }

    // ---------- fila ----------

    @SuppressWarnings("unchecked")
    void rodar(String filtro, boolean teste, java.util.function.Consumer<String> saida) throws Exception {
        Map<String, Object> d = lerDados();
        Map<String, Object> opcoes = d.get("opcoes") instanceof Map ? (Map<String, Object>) d.get("opcoes") : new LinkedHashMap<>();
        List<Map<String, Object>> lista = new ArrayList<>();
        for (Object o : (List<Object>) d.get("veiculos")) {
            Map<String, Object> v = (Map<String, Object>) o;
            if (v.get("feito") != null) continue;
            if (filtro != null && !Robo.ident(v).equals(filtro.toUpperCase())) continue;
            lista.add(v);
        }
        if (lista.isEmpty()) { saida.accept("Nenhum veículo pendente para agendar."); return; }
        boolean invalido = false;
        for (Map<String, Object> v : lista) {
            List<String> erros = Robo.validar(v);
            if (!erros.isEmpty()) { invalido = true; saida.accept((Robo.ident(v).isEmpty() ? "(sem placa)" : Robo.ident(v)) + ": " + String.join("; ", erros)); }
        }
        if (invalido) return;
        Robo r = new Robo(chrome, pasta.resolve("registros"), saida, paginaJs);
        robo = r;
        List<String> resumo = new ArrayList<>();
        for (Map<String, Object> v : lista) {
            boolean ok = r.agendarVeiculo(v, opcoes, teste);
            resumo.add(Robo.ident(v) + ": " + (teste ? "teste" : ok ? "AGENDADO" : "não agendado"));
            if (ok && !teste) {
                // Relê antes de gravar: só marca este veículo, sem desfazer nada.
                Map<String, Object> atual = lerDados();
                for (Object o : (List<Object>) atual.get("veiculos")) {
                    Map<String, Object> x = (Map<String, Object>) o;
                    if (Robo.ident(x).equals(Robo.ident(v)) && x.get("feito") == null) {
                        x.put("feito", LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME));
                        break;
                    }
                }
                gravarDados(atual);
            }
        }
        saida.accept("Resumo:\n  " + String.join("\n  ", resumo));
    }

    private synchronized boolean iniciar(String filtro, boolean teste) {
        if (trabalho != null) return false;
        linhas.clear();
        inicioLog = 0;
        addLinha("=== " + (teste ? "TESTE" : "AGENDAMENTO") + " " + (filtro != null ? "de " + filtro : "de todos os veículos") + " — "
            + LocalDateTime.now().format(DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm:ss")) + " ===");
        Thread t = new Thread(() -> {
            String fim = "ok";
            try { rodar(filtro, teste, this::addLinha); }
            catch (InterruptedException e) { fim = null; }
            catch (Exception e) { addLinha("erro: " + e.getMessage()); fim = "erro"; }
            finally {
                addLinha(fim == null ? "=== parado ===" : "=== fim (" + fim + ") ===");
                synchronized (Main.this) { trabalho = null; robo = null; }
            }
        }, "agendamento");
        t.setDaemon(true);
        trabalho = t;
        t.start();
        return true;
    }

    private void parar() {
        Robo r = robo;
        if (r != null) r.parar();
        Thread t = trabalho;
        if (t != null) t.interrupt();
    }

    // ---------- HTTP ----------

    private void atender(HttpExchange x) throws IOException {
        try {
            // Só a própria tela: um site aberto em outra aba não pode mandar
            // pedidos para cá (o navegador manda Origin nos POST/PUT dele).
            String origem = x.getRequestHeaders().getFirst("Origin");
            if (origem != null && !origem.equals("http://localhost:" + PORTA) && !origem.equals("http://127.0.0.1:" + PORTA)) {
                responder(x, 403, Map.of("erro", "origem recusada"));
                return;
            }
            String metodo = x.getRequestMethod();
            URI u = x.getRequestURI();
            String rota = metodo + " " + u.getPath();
            switch (rota) {
                case "GET /":
                    enviar(x, 200, "text/html; charset=utf-8", painel().getBytes(StandardCharsets.UTF_8));
                    return;
                case "GET /api/dados":
                    responder(x, 200, lerDados());
                    return;
                case "GET /api/ambiente":
                    responder(x, 200, Map.of("whatsapp", false, "java", true));
                    return;
                case "PUT /api/dados": {
                    if (trabalho != null) { responder(x, 409, Map.of("erro", "Espere o agendamento em andamento terminar (ou pare) antes de salvar.")); return; }
                    Object d = Json.parse(corpo(x));
                    if (!(d instanceof Map) || !(((Map<?, ?>) d).get("veiculos") instanceof List) || !(((Map<?, ?>) d).get("opcoes") instanceof Map)) {
                        responder(x, 400, Map.of("erro", "dados inválidos"));
                        return;
                    }
                    @SuppressWarnings("unchecked") Map<String, Object> dm = (Map<String, Object>) d;
                    gravarDados(dm);
                    responder(x, 200, Map.of("ok", true));
                    return;
                }
                case "POST /api/agendar": {
                    String c = corpo(x);
                    Map<String, Object> pedido = c.isBlank() ? Map.of() : Json.objeto(c);
                    Object placa = pedido.get("placa");
                    if (!iniciar(placa == null ? null : String.valueOf(placa), Boolean.TRUE.equals(pedido.get("teste")))) {
                        responder(x, 409, Map.of("erro", "Já tem um agendamento rodando."));
                        return;
                    }
                    responder(x, 200, Map.of("ok", true));
                    return;
                }
                case "POST /api/parar":
                    parar();
                    responder(x, 200, Map.of("ok", true));
                    return;
                case "POST /api/sair":
                    responder(x, 200, Map.of("ok", true));
                    parar();
                    new Thread(() -> { chrome.encerrar(); System.exit(0); }).start();
                    return;
                case "GET /api/andamento": {
                    int desde = 0;
                    String q = u.getQuery();
                    if (q != null) for (String p : q.split("&")) if (p.startsWith("desde=")) try { desde = Integer.parseInt(p.substring(6)); } catch (NumberFormatException e) { /* 0 */ }
                    Map<String, Object> r = new LinkedHashMap<>();
                    synchronized (this) {
                        desde = Math.max(desde, inicioLog);
                        r.put("rodando", trabalho != null);
                        r.put("inicio", inicioLog);
                        r.put("proximo", inicioLog + linhas.size());
                        r.put("linhas", new ArrayList<>(linhas.subList(Math.min(desde - inicioLog, linhas.size()), linhas.size())));
                    }
                    responder(x, 200, r);
                    return;
                }
                default:
                    responder(x, 404, Map.of("erro", "não encontrado"));
            }
        } catch (Exception e) {
            responder(x, 500, Map.of("erro", String.valueOf(e.getMessage())));
        }
    }

    /**
     * O painel.html é o mesmo da versão Node e da página do site. Aqui ele
     * ganha só o botão "Fechar programa": esta versão não tem janela nem ícone
     * perto do relógio, então é o jeito de encerrá-la.
     */
    private String painel() throws IOException {
        String extra = "<script>document.addEventListener('DOMContentLoaded',function(){var h=document.querySelector('header');if(!h)return;"
            + "var b=document.createElement('button');b.textContent='Fechar programa';b.style.cssText='background:#fff;color:#0b4f9c';"
            + "b.onclick=function(){if(!confirm('Fechar o programa? Um agendamento em andamento para.'))return;"
            + "fetch('/api/sair',{method:'POST'}).finally(function(){document.body.innerHTML='<p style=\"padding:30px;font:16px system-ui\">Programa fechado. Para abrir de novo, use o atalho \"Abrir Agendamento Detran\".</p>';});};"
            + "h.appendChild(b);var e=document.getElementById('estado');if(e)e.title='Versão Java';});</script>\n</head>";
        return recurso("/painel.html").replace("</head>", extra);
    }

    private static String corpo(HttpExchange x) throws IOException {
        byte[] b = x.getRequestBody().readNBytes(2_000_001);
        if (b.length > 2_000_000) throw new IOException("corpo grande demais");
        return new String(b, StandardCharsets.UTF_8);
    }

    private static void responder(HttpExchange x, int status, Object corpo) throws IOException {
        enviar(x, status, "application/json; charset=utf-8", Json.stringify(corpo).getBytes(StandardCharsets.UTF_8));
    }

    private static void enviar(HttpExchange x, int status, String tipo, byte[] b) throws IOException {
        x.getResponseHeaders().set("Content-Type", tipo);
        x.getResponseHeaders().set("Cache-Control", "no-store");
        x.sendResponseHeaders(status, b.length);
        try (OutputStream o = x.getResponseBody()) { o.write(b); }
    }
}
