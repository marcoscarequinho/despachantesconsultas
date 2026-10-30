// Partes usadas pelo lançador (AgendamentoDetran.exe) e pelo instalador.
// C# 5: é o compilador que vem no próprio Windows (.NET Framework 4), para o
// build não depender de nada instalado à parte.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Reflection;
using Microsoft.Win32;

static class Comum
{
    public const string NOME = "Agendamento Detran RJ";
    public const string VERSAO = "1.0.0";
    public const string EXE = "AgendamentoDetran.exe";
    public const string CHAVE_RUN = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string VALOR_RUN = "AgendamentoDetranRJ";
    public const string CHAVE_DESINSTALAR = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AgendamentoDetranRJ";
    public const int PORTA = 3939;
    public const string URL = "http://localhost:3939/";

    // Por usuário, sem pedir administrador: é onde o Windows põe app de usuário
    // (o mesmo lugar do VS Code "User Installer"). O veiculos.json fica aqui.
    public static string PastaInstalacao()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", NOME);
    }

    public static string AtalhoMenuIniciar()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), NOME + ".lnk");
    }

    public static string AtalhoAreaDeTrabalho()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), NOME + ".lnk");
    }

    // Depois de instalar o Node.js o PATH deste processo ainda é o antigo, por
    // isso o PATH é relido do registro, além das pastas de sempre.
    public static string AcharNode()
    {
        var pastas = new List<string>();
        pastas.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        pastas.Add(Path.Combine(Environment.GetEnvironmentVariable("ProgramW6432") ?? "", "nodejs"));
        pastas.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs"));
        foreach (var alvo in new[] { EnvironmentVariableTarget.Process, EnvironmentVariableTarget.User, EnvironmentVariableTarget.Machine })
        {
            var path = Environment.GetEnvironmentVariable("PATH", alvo);
            if (path != null) pastas.AddRange(path.Split(';'));
        }
        foreach (var p in pastas)
        {
            if (string.IsNullOrWhiteSpace(p)) continue;
            try
            {
                var node = Path.Combine(Environment.ExpandEnvironmentVariables(p.Trim().Trim('"')), "node.exe");
                if (File.Exists(node)) return node;
            }
            catch { }
        }
        return null;
    }

    public static string VersaoNode(string node)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo(node, "--version") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true });
            var v = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit(5000);
            return v;
        }
        catch { return null; }
    }

    // O agendar.js abre o Chrome instalado (channel 'chrome' do Playwright).
    public static bool TemChrome()
    {
        foreach (var raiz in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using (var k = raiz.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"))
            {
                var v = k == null ? null : k.GetValue("") as string;
                if (v != null && File.Exists(v.Trim('"'))) return true;
            }
        }
        foreach (var raiz in new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("LOCALAPPDATA") })
        {
            if (raiz != null && File.Exists(Path.Combine(raiz, @"Google\Chrome\Application\chrome.exe"))) return true;
        }
        return false;
    }

    public static bool IniciaComWindows()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(CHAVE_RUN))
            return k != null && k.GetValue(VALOR_RUN) != null;
    }

    public static void DefinirIniciaComWindows(bool ligar, string exe)
    {
        using (var k = Registry.CurrentUser.CreateSubKey(CHAVE_RUN))
        {
            if (ligar) k.SetValue(VALOR_RUN, "\"" + exe + "\" --autostart");
            else if (k.GetValue(VALOR_RUN) != null) k.DeleteValue(VALOR_RUN);
        }
    }

    // Encerra o lançador e o servidor Node desta pasta (e o agendar.js/Chrome
    // que ele abriu): antes de atualizar os arquivos e na desinstalação.
    public static void EncerrarTudo(string pasta)
    {
        var eu = Process.GetCurrentProcess().Id;
        foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(EXE)))
        {
            if (p.Id == eu) continue;
            try { p.Kill(); p.WaitForExit(3000); } catch { }
        }
        try
        {
            var busca = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'");
            foreach (ManagementObject o in busca.Get())
            {
                var cmd = o["CommandLine"] as string;
                if (cmd != null && cmd.IndexOf(pasta, StringComparison.OrdinalIgnoreCase) >= 0)
                    MatarArvore(Convert.ToInt32(o["ProcessId"]));
            }
        }
        catch { }
    }

    public static void MatarArvore(int pid)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F") { UseShellExecute = false, CreateNoWindow = true });
            p.WaitForExit(5000);
        }
        catch { }
    }

    // Atalho .lnk pelo WScript.Shell (COM), sem referência a interop.
    public static void CriarAtalho(string lnk, string alvo, string pastaTrabalho, string descricao)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(lnk));
        var tipo = Type.GetTypeFromProgID("WScript.Shell");
        var shell = Activator.CreateInstance(tipo);
        var atalho = tipo.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
        var t = atalho.GetType();
        t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, atalho, new object[] { alvo });
        t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, atalho, new object[] { pastaTrabalho });
        t.InvokeMember("Description", BindingFlags.SetProperty, null, atalho, new object[] { descricao });
        t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, atalho, new object[] { alvo + ",0" });
        t.InvokeMember("Save", BindingFlags.InvokeMethod, null, atalho, null);
    }
}
