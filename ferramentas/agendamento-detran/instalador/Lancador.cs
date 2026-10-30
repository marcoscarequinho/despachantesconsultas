// AgendamentoDetran.exe — fica na pasta instalada, no lugar do
// "Agendamento Detran.bat": sobe o servidor.js escondido (sem a janela preta
// que não podia ser fechada) e põe um ícone perto do relógio para abrir a tela,
// ligar/desligar o início com o Windows e encerrar.
//
//   AgendamentoDetran.exe              abre a tela (sobe o servidor se preciso)
//   AgendamentoDetran.exe --autostart  só sobe o servidor (início do Windows)
//   AgendamentoDetran.exe --desinstalar

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Lancador
{
    static readonly string pasta = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    static Process servidor;
    static NotifyIcon icone;
    static bool saindo;
    static StreamWriter log;

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        if (Array.IndexOf(args, "--desinstalar") >= 0) { Desinstalar(); return; }
        bool auto = Array.IndexOf(args, "--autostart") >= 0;

        bool primeiro;
        var trava = new Mutex(true, @"Local\AgendamentoDetranRJ", out primeiro);
        if (!primeiro)
        {
            // Já está rodando (ícone perto do relógio): só mostra a tela.
            if (!auto) AbrirTela();
            return;
        }

        var node = Comum.AcharNode();
        if (node == null)
        {
            if (!auto && MessageBox.Show("O Node.js não está instalado, e o agendamento precisa dele para rodar.\n\nAbrir o site oficial do Node.js para baixar? Depois de instalar, abra o Agendamento Detran de novo.",
                Comum.NOME, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                Process.Start("https://nodejs.org/pt-br/download");
            return;
        }

        try { log = new StreamWriter(Path.Combine(pasta, "servidor.log"), false) { AutoFlush = true }; } catch { }
        if (!PortaAberta()) IniciarServidor(node);
        MontarIcone(auto);
        if (!auto) new Thread(() => { EsperarPorta(20000); AbrirTela(); }) { IsBackground = true }.Start();

        Application.Run();
        GC.KeepAlive(trava);
    }

    static void IniciarServidor(string node)
    {
        var info = new ProcessStartInfo(node, "\"" + Path.Combine(pasta, "servidor.js") + "\" --sem-navegador")
        {
            WorkingDirectory = pasta,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        servidor = new Process { StartInfo = info, EnableRaisingEvents = true };
        servidor.OutputDataReceived += (s, e) => Registrar(e.Data);
        servidor.ErrorDataReceived += (s, e) => Registrar(e.Data);
        servidor.Exited += (s, e) =>
        {
            Registrar("=== servidor encerrado (código " + servidor.ExitCode + ") ===");
            if (!saindo && icone != null)
                icone.ShowBalloonTip(5000, Comum.NOME, "O agendamento parou. Clique no ícone e em \"Abrir agendamento\" para iniciar de novo.", ToolTipIcon.Warning);
            servidor = null;
        };
        servidor.Start();
        servidor.BeginOutputReadLine();
        servidor.BeginErrorReadLine();
    }

    static void Registrar(string linha)
    {
        if (linha == null || log == null) return;
        lock (log) { try { log.WriteLine(linha); } catch { } }
    }

    static bool PortaAberta()
    {
        try
        {
            using (var c = new TcpClient())
            {
                var r = c.BeginConnect("127.0.0.1", Comum.PORTA, null, null);
                return r.AsyncWaitHandle.WaitOne(500) && c.Connected;
            }
        }
        catch { return false; }
    }

    static void EsperarPorta(int ms)
    {
        var fim = DateTime.Now.AddMilliseconds(ms);
        while (DateTime.Now < fim && !PortaAberta()) Thread.Sleep(300);
    }

    static void AbrirTela()
    {
        if (!PortaAberta())
        {
            // Servidor caiu: sobe de novo antes de abrir.
            var node = Comum.AcharNode();
            if (node != null && servidor == null) { IniciarServidor(node); EsperarPorta(20000); }
        }
        try { Process.Start(Comum.URL); } catch { }
    }

    static void MontarIcone(bool auto)
    {
        var menu = new ContextMenuStrip();
        var abrir = menu.Items.Add("Abrir agendamento", null, (s, e) => AbrirTela());
        abrir.Font = new Font(abrir.Font, FontStyle.Bold);
        var iniciar = new ToolStripMenuItem("Iniciar com o Windows") { Checked = Comum.IniciaComWindows() };
        iniciar.Click += (s, e) =>
        {
            Comum.DefinirIniciaComWindows(!iniciar.Checked, Application.ExecutablePath);
            iniciar.Checked = Comum.IniciaComWindows();
        };
        menu.Items.Add(iniciar);
        menu.Items.Add("Abrir pasta dos registros", null, (s, e) =>
        {
            var reg = Path.Combine(pasta, "registros");
            Directory.CreateDirectory(reg);
            Process.Start("explorer.exe", "\"" + reg + "\"");
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Sair (encerra o agendamento)", null, (s, e) => Sair());

        icone = new NotifyIcon
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
            Text = Comum.NOME + " — localhost:" + Comum.PORTA,
            ContextMenuStrip = menu,
            Visible = true,
        };
        icone.DoubleClick += (s, e) => AbrirTela();
        if (auto) icone.ShowBalloonTip(4000, Comum.NOME, "Rodando em segundo plano. Clique no ícone para abrir.", ToolTipIcon.Info);
    }

    static void Sair()
    {
        saindo = true;
        if (servidor != null) Comum.MatarArvore(servidor.Id);
        icone.Visible = false;
        Application.Exit();
    }

    static void Desinstalar()
    {
        if (MessageBox.Show("Desinstalar o " + Comum.NOME + "?", Comum.NOME, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        var apagarDados = MessageBox.Show("Apagar também os veículos cadastrados (CPF e renavam dos clientes) e os registros das telas?\n\nSe escolher \"Não\", eles ficam em:\n" + pasta,
            Comum.NOME, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;

        Comum.EncerrarTudo(pasta);
        Comum.DefinirIniciaComWindows(false, Application.ExecutablePath);
        foreach (var lnk in new[] { Comum.AtalhoMenuIniciar(), Comum.AtalhoAreaDeTrabalho() })
            try { if (File.Exists(lnk)) File.Delete(lnk); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(Comum.CHAVE_DESINSTALAR, false); } catch { }

        var dados = new[] { "veiculos.json", "registros", "perfil-chrome" };
        foreach (var item in Directory.GetFileSystemEntries(pasta))
        {
            var nome = Path.GetFileName(item);
            if (nome.Equals(Comum.EXE, StringComparison.OrdinalIgnoreCase)) continue;
            if (!apagarDados && Array.IndexOf(dados, nome) >= 0) continue;
            try { if (Directory.Exists(item)) Directory.Delete(item, true); else File.Delete(item); } catch { }
        }
        MessageBox.Show(Comum.NOME + " desinstalado.", Comum.NOME, MessageBoxButtons.OK, MessageBoxIcon.Information);
        // O próprio .exe só sai depois que este processo terminar.
        var cmd = "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + Path.Combine(pasta, Comum.EXE) + "\" & rmdir \"" + pasta + "\"";
        Process.Start(new ProcessStartInfo("cmd.exe", cmd) { UseShellExecute = false, CreateNoWindow = true });
    }
}
