// Instalar-Agendamento-Detran.exe — o que o site oferece para baixar.
// Leva dentro (recurso "app.zip") os arquivos da ferramenta, o node_modules
// (só o Playwright, que usa o Chrome instalado) e o AgendamentoDetran.exe.
// NÃO leva o .env do site: as chaves são da MC, e sem elas a ferramenta só
// perde o aviso no WhatsApp (o painel esconde o campo).
//
// O Node.js não vai dentro (são ~30 MB e o download do site para em 4,5 MB):
// quando falta, o instalador baixa o LTS mais novo de nodejs.org e roda o MSI
// oficial — que pede permissão de administrador, como qualquer instalação dele.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class Instalador : Form
{
    readonly string pasta = Comum.PastaInstalacao();
    readonly string nodeAtual = Comum.AcharNode();
    CheckBox chkNode, chkIniciar, chkAtalho, chkAbrir;
    ProgressBar barra;
    Label status;
    Button btnInstalar, btnCancelar;

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        // nodejs.org só aceita TLS 1.2+, que o .NET 4 não liga sozinho.
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
        Application.Run(new Instalador());
    }

    Instalador()
    {
        Text = "Instalar " + Comum.NOME;
        Font = new Font("Segoe UI", 9.5f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 430);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var y = 16;
        var titulo = new Label { Text = Comum.NOME, Font = new Font("Segoe UI", 15f, FontStyle.Bold), ForeColor = Color.FromArgb(30, 58, 138), AutoSize = true, Location = new Point(20, y) };
        Controls.Add(titulo);
        y += 40;
        Controls.Add(new Label
        {
            Text = "Agenda Transferência de Propriedade, Transferência de Jurisdição e Troca de Município no site do Detran RJ. "
                 + "Você só marca o \"Não sou um robô\"; o resto o programa faz e tenta de novo até achar vaga.",
            Location = new Point(20, y), Size = new Size(520, 42),
        });
        y += 48;
        Controls.Add(new Label { Text = "Será instalado em: " + pasta, ForeColor = Color.DimGray, Location = new Point(20, y), Size = new Size(520, 34) });
        y += 40;

        var versao = nodeAtual == null ? null : Comum.VersaoNode(nodeAtual);
        chkNode = new CheckBox { Location = new Point(20, y), Size = new Size(520, 40) };
        if (nodeAtual == null)
        {
            chkNode.Text = "Instalar o Node.js (necessário para o agendamento rodar) — baixa a versão LTS do site oficial nodejs.org";
            chkNode.Checked = true;
        }
        else
        {
            chkNode.Text = "Node.js " + (versao ?? "") + " já instalado neste computador";
            chkNode.Checked = false;
            chkNode.Enabled = false;
        }
        Controls.Add(chkNode);
        y += 44;

        if (Comum.TemChrome())
        {
            Controls.Add(new Label { Text = "✓ Google Chrome encontrado", ForeColor = Color.FromArgb(21, 128, 61), Location = new Point(20, y), AutoSize = true });
        }
        else
        {
            var link = new LinkLabel { Text = "⚠ Google Chrome não encontrado: o agendamento abre o site do Detran no Chrome. Clique aqui para baixar.", Location = new Point(20, y), Size = new Size(520, 36), LinkColor = Color.FromArgb(185, 28, 28) };
            link.LinkClicked += (s, e) => Process.Start("https://www.google.com/chrome/");
            Controls.Add(link);
        }
        y += 40;

        chkIniciar = new CheckBox { Text = "Iniciar automaticamente com o Windows (o servidor fica rodando em segundo plano, com um ícone perto do relógio)", Checked = true, Location = new Point(20, y), Size = new Size(520, 40) };
        Controls.Add(chkIniciar);
        y += 42;
        chkAtalho = new CheckBox { Text = "Criar atalho na Área de Trabalho", Checked = true, Location = new Point(20, y), AutoSize = true };
        Controls.Add(chkAtalho);
        y += 28;
        chkAbrir = new CheckBox { Text = "Abrir o agendamento ao terminar", Checked = true, Location = new Point(20, y), AutoSize = true };
        Controls.Add(chkAbrir);
        y += 34;

        barra = new ProgressBar { Location = new Point(20, y), Size = new Size(520, 18), Visible = false };
        Controls.Add(barra);
        status = new Label { Location = new Point(20, y + 22), Size = new Size(520, 20), ForeColor = Color.DimGray };
        Controls.Add(status);

        btnCancelar = new Button { Text = "Cancelar", Location = new Point(440, 385), Size = new Size(100, 32) };
        btnCancelar.Click += (s, e) => Close();
        btnInstalar = new Button { Text = "Instalar", Location = new Point(330, 385), Size = new Size(100, 32), BackColor = Color.FromArgb(234, 88, 12), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        btnInstalar.Click += (s, e) => Instalar();
        Controls.Add(btnCancelar);
        Controls.Add(btnInstalar);
        AcceptButton = btnInstalar;
    }

    void Status(string texto, int porcento)
    {
        BeginInvoke((Action)(() =>
        {
            status.Text = texto;
            if (porcento < 0) barra.Style = ProgressBarStyle.Marquee;
            else { barra.Style = ProgressBarStyle.Continuous; barra.Value = Math.Max(0, Math.Min(100, porcento)); }
        }));
    }

    void Instalar()
    {
        foreach (Control c in Controls) if (c is CheckBox) c.Enabled = false;
        btnInstalar.Enabled = false;
        btnCancelar.Enabled = false;
        barra.Visible = true;
        bool instalarNode = chkNode.Checked && chkNode.Enabled, iniciar = chkIniciar.Checked, atalho = chkAtalho.Checked, abrir = chkAbrir.Checked;

        new Thread(() =>
        {
            string erro = null;
            string avisoNode = null;
            try
            {
                Status("Encerrando a versão anterior, se estiver aberta…", -1);
                Comum.EncerrarTudo(pasta);
                CopiarArquivos();

                if (instalarNode)
                {
                    try { InstalarNode(); }
                    catch (Exception ex) { avisoNode = ex.Message; }
                }

                Status("Criando atalhos…", 95);
                var exe = Path.Combine(pasta, Comum.EXE);
                Comum.CriarAtalho(Comum.AtalhoMenuIniciar(), exe, pasta, "Agendamento assistido no Detran RJ");
                if (atalho) Comum.CriarAtalho(Comum.AtalhoAreaDeTrabalho(), exe, pasta, "Agendamento assistido no Detran RJ");
                Comum.DefinirIniciaComWindows(iniciar, exe);
                RegistrarDesinstalacao(exe);
                Status("Pronto.", 100);

                if (abrir || iniciar)
                    Process.Start(new ProcessStartInfo(exe, abrir ? "" : "--autostart") { WorkingDirectory = pasta });
            }
            catch (Exception ex) { erro = ex.Message; }

            BeginInvoke((Action)(() =>
            {
                if (erro != null)
                {
                    MessageBox.Show(this, "A instalação não terminou:\n\n" + erro, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    btnCancelar.Enabled = true;
                    return;
                }
                var msg = Comum.NOME + " instalado.\n\nPara abrir: atalho \"" + Comum.NOME + "\" no Menu Iniciar"
                    + (atalho ? " ou na Área de Trabalho" : "") + ". A tela abre no navegador em " + Comum.URL;
                if (avisoNode != null)
                    msg += "\n\n⚠ O Node.js não foi instalado (" + avisoNode + "). Baixe em nodejs.org e instale antes de usar.";
                MessageBox.Show(this, msg, Text, MessageBoxButtons.OK, avisoNode == null ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                Close();
            }));
        }) { IsBackground = true }.Start();
    }

    // Atualizar por cima não pode perder os veículos cadastrados nem o perfil do
    // Chrome (o reCAPTCHA confia mais em perfil com histórico).
    void CopiarArquivos()
    {
        Status("Copiando arquivos…", 5);
        Directory.CreateDirectory(pasta);
        var nm = Path.Combine(pasta, "node_modules");
        if (Directory.Exists(nm)) Directory.Delete(nm, true);

        using (var recurso = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip"))
        using (var zip = new ZipArchive(recurso, ZipArchiveMode.Read))
        {
            int i = 0, total = zip.Entries.Count;
            foreach (var entrada in zip.Entries)
            {
                i++;
                var destino = Path.GetFullPath(Path.Combine(pasta, entrada.FullName));
                if (!destino.StartsWith(pasta + "\\", StringComparison.OrdinalIgnoreCase)) continue;
                if (entrada.FullName.EndsWith("/")) { Directory.CreateDirectory(destino); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(destino));
                using (var origem = entrada.Open())
                using (var arq = File.Create(destino)) origem.CopyTo(arq);
                if (i % 40 == 0) Status("Copiando arquivos… " + i + " de " + total, 5 + 40 * i / total);
            }
        }
    }

    void InstalarNode()
    {
        Status("Procurando a versão LTS do Node.js…", 45);
        string indice;
        using (var web = new WebClient()) indice = web.DownloadString("https://nodejs.org/dist/index.json");
        // A lista vem da mais nova para a mais antiga; LTS tem "lts":"<nome>".
        var m = Regex.Match(indice, "\\{\"version\":\"(v[0-9.]+)\"[^{}]*?\"lts\":\"[^\"]+\"");
        if (!m.Success) throw new Exception("não achei a versão LTS em nodejs.org");
        var versao = m.Groups[1].Value;
        var arq = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").ToUpperInvariant() == "ARM64" ? "arm64" : "x64";
        var url = "https://nodejs.org/dist/" + versao + "/node-" + versao + "-" + arq + ".msi";
        var msi = Path.Combine(Path.GetTempPath(), "node-" + versao + "-" + arq + ".msi");

        var pedido = (HttpWebRequest)WebRequest.Create(url);
        using (var resp = pedido.GetResponse())
        using (var origem = resp.GetResponseStream())
        using (var destino = File.Create(msi))
        {
            long total = resp.ContentLength, lido = 0;
            var buf = new byte[81920];
            int n, ultimo = -1;
            while ((n = origem.Read(buf, 0, buf.Length)) > 0)
            {
                destino.Write(buf, 0, n);
                lido += n;
                var p = total > 0 ? (int)(lido * 100 / total) : 0;
                if (p != ultimo) { ultimo = p; Status("Baixando Node.js " + versao + "… " + (lido / 1048576) + " de " + (total / 1048576) + " MB", 45 + p * 35 / 100); }
            }
        }

        Status("Instalando o Node.js " + versao + " (confirme a permissão do Windows)…", -1);
        Process p2;
        try
        {
            p2 = Process.Start(new ProcessStartInfo("msiexec.exe", "/i \"" + msi + "\" /passive /norestart") { UseShellExecute = true, Verb = "runas" });
        }
        catch (System.ComponentModel.Win32Exception) { throw new Exception("a permissão de administrador foi recusada"); }
        p2.WaitForExit();
        try { File.Delete(msi); } catch { }
        if (p2.ExitCode != 0 && p2.ExitCode != 3010) throw new Exception("o instalador do Node.js terminou com o código " + p2.ExitCode);
        if (Comum.AcharNode() == null) throw new Exception("o Node.js não apareceu depois da instalação");
    }

    // Aparece em Configurações > Aplicativos, com "Desinstalar".
    void RegistrarDesinstalacao(string exe)
    {
        using (var k = Registry.CurrentUser.CreateSubKey(Comum.CHAVE_DESINSTALAR))
        {
            k.SetValue("DisplayName", Comum.NOME);
            k.SetValue("DisplayVersion", Comum.VERSAO);
            k.SetValue("Publisher", "Despachantes Consultas");
            k.SetValue("DisplayIcon", exe + ",0");
            k.SetValue("InstallLocation", pasta);
            k.SetValue("UninstallString", "\"" + exe + "\" --desinstalar");
            k.SetValue("URLInfoAbout", "https://despachantesconsultas.com.br/baixar-app");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", 12000, RegistryValueKind.DWord);
        }
    }
}
