package br.com.despachantesconsultas.agendamento;

import java.io.File;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * O Chrome instalado no computador, comandado pelo protocolo DevTools (o mesmo
 * que o Playwright usa por baixo), por WebSocket do próprio Java. Assim o
 * pacote não precisa de Node nem de Playwright: só do Java reduzido.
 *
 * Perfil próprio e persistente (perfil-chrome na pasta de dados): o reCAPTCHA
 * desconfia menos de um navegador já usado, e o Chrome 136+ recusa a porta de
 * depuração no perfil padrão da pessoa.
 */
final class Chrome {
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final Path perfil;
    private final Consumer<String> log;
    private Process processo;
    private int porta;
    private WebSocket ws;
    private final AtomicInteger seq = new AtomicInteger();
    private final Map<Integer, CompletableFuture<Map<String, Object>>> pendentes = new ConcurrentHashMap<>();
    private volatile boolean fechado = true;

    Chrome(Path perfil, Consumer<String> log) {
        this.perfil = perfil;
        this.log = log;
    }

    static String acharExecutavel() {
        String[] bases = { System.getenv("ProgramFiles"), System.getenv("ProgramFiles(x86)"), System.getenv("LOCALAPPDATA") };
        for (String base : bases) {
            if (base == null) continue;
            File f = new File(base, "Google\\Chrome\\Application\\chrome.exe");
            if (f.isFile()) return f.getPath();
        }
        // Sem Chrome, o Edge (também Chromium, já vem no Windows) serve.
        for (String base : bases) {
            if (base == null) continue;
            File f = new File(base, "Microsoft\\Edge\\Application\\msedge.exe");
            if (f.isFile()) return f.getPath();
        }
        return null;
    }

    boolean aberto() { return !fechado && processo != null && processo.isAlive(); }

    /** Abre o navegador (se ainda não estiver aberto) e se conecta à aba. */
    synchronized void garantir() throws Exception {
        if (aberto()) return;
        fechar();
        String exe = acharExecutavel();
        if (exe == null) throw new IllegalStateException("não achei o Google Chrome nem o Microsoft Edge neste computador. Instale o Chrome em google.com/chrome.");
        try (ServerSocket s = new ServerSocket(0)) { porta = s.getLocalPort(); }
        List<String> cmd = new ArrayList<>(List.of(exe, "--remote-debugging-port=" + porta, "--user-data-dir=" + perfil,
            "--no-first-run", "--no-default-browser-check", "--start-maximized", "about:blank"));
        // Só para conferir o preenchimento sem abrir janela (--teste no build).
        if ("1".equals(System.getenv("AGENDAMENTO_SEM_JANELA"))) cmd.add(1, "--headless=new");
        processo = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        String wsUrl = null;
        long fim = System.currentTimeMillis() + 30000;
        while (wsUrl == null && System.currentTimeMillis() < fim) {
            Thread.sleep(500);
            try {
                String corpo = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + porta + "/json/list")).build(),
                    HttpResponse.BodyHandlers.ofString()).body();
                for (Object o : (List<?>) Json.parse(corpo)) {
                    Map<?, ?> t = (Map<?, ?>) o;
                    if ("page".equals(t.get("type"))) { wsUrl = (String) t.get("webSocketDebuggerUrl"); break; }
                }
            } catch (Exception e) { /* ainda subindo */ }
        }
        if (wsUrl == null) throw new IllegalStateException("o navegador abriu mas não respondeu (feche as janelas dele e tente de novo).");
        ws = http.newWebSocketBuilder().buildAsync(URI.create(wsUrl), new Ouvinte()).get(15, TimeUnit.SECONDS);
        fechado = false;
        enviar("Page.enable", Map.of());
        enviar("Runtime.enable", Map.of());
    }

    synchronized void fechar() {
        fechado = true;
        if (ws != null) { try { ws.abort(); } catch (Exception e) { /* já caiu */ } ws = null; }
        for (CompletableFuture<Map<String, Object>> f : pendentes.values()) f.completeExceptionally(new IllegalStateException("navegador fechado"));
        pendentes.clear();
    }

    /** Fecha a janela do navegador também (botão "Parar" / sair do programa). */
    synchronized void encerrar() {
        fechar();
        if (processo != null && processo.isAlive()) processo.descendants().forEach(ProcessHandle::destroy);
        if (processo != null) processo.destroy();
        processo = null;
    }

    Map<String, Object> enviar(String metodo, Map<String, Object> params) throws Exception {
        return enviar(metodo, params, 60);
    }

    Map<String, Object> enviar(String metodo, Map<String, Object> params, int segundos) throws Exception {
        if (ws == null || fechado) throw new IllegalStateException("navegador fechado");
        int id = seq.incrementAndGet();
        CompletableFuture<Map<String, Object>> f = new CompletableFuture<>();
        pendentes.put(id, f);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("method", metodo);
        m.put("params", params);
        synchronized (this) { ws.sendText(Json.stringify(m), true).get(10, TimeUnit.SECONDS); }
        try {
            return f.get(segundos, TimeUnit.SECONDS);
        } finally {
            pendentes.remove(id);
        }
    }

    void navegar(String url) throws Exception { enviar("Page.navigate", Map.of("url", url)); }

    /** Roda a expressão na página e devolve o valor (já convertido do JSON). */
    Object avaliar(String expressao) throws Exception {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("expression", expressao);
        p.put("returnByValue", true);
        p.put("awaitPromise", true);
        Map<String, Object> r = enviar("Runtime.evaluate", p);
        Object exc = r.get("exceptionDetails");
        if (exc != null) {
            Object ex = ((Map<?, ?>) exc).get("exception");
            Object desc = ex instanceof Map ? ((Map<?, ?>) ex).get("description") : null;
            throw new IllegalStateException("erro na página: " + (desc != null ? desc : ((Map<?, ?>) exc).get("text")));
        }
        Map<?, ?> res = (Map<?, ?>) r.get("result");
        return res == null ? null : res.get("value");
    }

    String capturaPng() throws Exception {
        Map<String, Object> r = enviar("Page.captureScreenshot", Map.of("format", "png"), 30);
        return (String) r.get("data");
    }

    void trazerParaFrente() {
        try { enviar("Page.bringToFront", Map.of(), 5); } catch (Exception e) { /* sem importância */ }
    }

    private final class Ouvinte implements WebSocket.Listener {
        private final StringBuilder parte = new StringBuilder();

        @Override
        public CompletionStage<?> onText(WebSocket w, CharSequence dados, boolean ultimo) {
            parte.append(dados);
            if (ultimo) {
                String msg = parte.toString();
                parte.setLength(0);
                try { tratar(Json.objeto(msg)); } catch (Exception e) { /* mensagem que não interessa */ }
            }
            w.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket w, int codigo, String motivo) {
            fechar();
            return null;
        }

        @Override
        public void onError(WebSocket w, Throwable erro) { fechar(); }
    }

    @SuppressWarnings("unchecked")
    private void tratar(Map<String, Object> m) {
        Object id = m.get("id");
        if (id != null) {
            CompletableFuture<Map<String, Object>> f = pendentes.get(((Number) id).intValue());
            if (f == null) return;
            if (m.get("error") != null) f.completeExceptionally(new IllegalStateException(String.valueOf(((Map<?, ?>) m.get("error")).get("message"))));
            else f.complete(m.get("result") == null ? Map.of() : (Map<String, Object>) m.get("result"));
            return;
        }
        // O Detran avisa recusa (placa, DUDA, captcha…) por alert(). Com o
        // alerta aberto a página para, então ele é aceito e o texto vai pro log.
        if ("Page.javascriptDialogOpening".equals(m.get("method"))) {
            Map<?, ?> p = (Map<?, ?>) m.get("params");
            log.accept("aviso do site: " + p.get("message"));
            CompletableFuture.runAsync(() -> {
                try { enviar("Page.handleJavaScriptDialog", Map.of("accept", true), 10); } catch (Exception e) { /* já fechado */ }
            });
        }
    }
}
