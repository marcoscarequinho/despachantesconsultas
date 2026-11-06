package br.com.despachantesconsultas.agendamento;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON mínimo, sem biblioteca: o pacote leva só o Java reduzido (jlink), então
 * nada de Jackson/Gson. Objeto vira LinkedHashMap (mantém a ordem dos campos
 * do veiculos.json), lista vira ArrayList, número vira Double ou Long.
 */
final class Json {
    private final String s;
    private int i;

    private Json(String s) { this.s = s; }

    static Object parse(String texto) {
        Json j = new Json(texto);
        j.espacos();
        Object v = j.valor();
        j.espacos();
        if (j.i != j.s.length()) throw new IllegalArgumentException("JSON com sobra na posição " + j.i);
        return v;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> objeto(String texto) { return (Map<String, Object>) parse(texto); }

    private void espacos() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

    private Object valor() {
        if (i >= s.length()) throw new IllegalArgumentException("JSON terminou antes da hora");
        char c = s.charAt(i);
        if (c == '{') return obj();
        if (c == '[') return lista();
        if (c == '"') return texto();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return null; }
        return numero();
    }

    private Map<String, Object> obj() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++; espacos();
        if (s.charAt(i) == '}') { i++; return m; }
        while (true) {
            espacos();
            String k = texto();
            espacos();
            if (s.charAt(i++) != ':') throw new IllegalArgumentException("esperava ':' na posição " + (i - 1));
            espacos();
            m.put(k, valor());
            espacos();
            char c = s.charAt(i++);
            if (c == '}') return m;
            if (c != ',') throw new IllegalArgumentException("esperava ',' na posição " + (i - 1));
        }
    }

    private List<Object> lista() {
        List<Object> l = new ArrayList<>();
        i++; espacos();
        if (s.charAt(i) == ']') { i++; return l; }
        while (true) {
            espacos();
            l.add(valor());
            espacos();
            char c = s.charAt(i++);
            if (c == ']') return l;
            if (c != ',') throw new IllegalArgumentException("esperava ',' na posição " + (i - 1));
        }
    }

    private String texto() {
        if (s.charAt(i) != '"') throw new IllegalArgumentException("esperava texto na posição " + i);
        i++;
        StringBuilder b = new StringBuilder();
        while (true) {
            char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            char e = s.charAt(i++);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 'r': b.append('\r'); break;
                case 't': b.append('\t'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                default: b.append(e);
            }
        }
    }

    private Object numero() {
        int ini = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        String n = s.substring(ini, i);
        if (n.isEmpty()) throw new IllegalArgumentException("valor inválido na posição " + ini);
        if (n.matches("-?\\d+") && n.length() < 18) return Long.parseLong(n);
        return Double.parseDouble(n);
    }

    static String stringify(Object v) {
        StringBuilder b = new StringBuilder();
        escrever(b, v);
        return b.toString();
    }

    private static void escrever(StringBuilder b, Object v) {
        if (v == null) { b.append("null"); return; }
        if (v instanceof String) { aspas(b, (String) v); return; }
        if (v instanceof Boolean) { b.append(v); return; }
        if (v instanceof Double) {
            double d = (Double) v;
            if (d == Math.rint(d) && Math.abs(d) < 1e15) b.append((long) d); else b.append(d);
            return;
        }
        if (v instanceof Number) { b.append(v); return; }
        if (v instanceof Map) {
            b.append('{');
            boolean primeiro = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!primeiro) b.append(',');
                primeiro = false;
                aspas(b, String.valueOf(e.getKey()));
                b.append(':');
                escrever(b, e.getValue());
            }
            b.append('}');
            return;
        }
        if (v instanceof List) {
            b.append('[');
            boolean primeiro = true;
            for (Object o : (List<?>) v) {
                if (!primeiro) b.append(',');
                primeiro = false;
                escrever(b, o);
            }
            b.append(']');
            return;
        }
        aspas(b, v.toString());
    }

    private static void aspas(StringBuilder b, String s) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    //  /  também: o texto vai parar dentro de um script.
                    if (c < 0x20 || c == ' ' || c == ' ') b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        b.append('"');
    }
}
