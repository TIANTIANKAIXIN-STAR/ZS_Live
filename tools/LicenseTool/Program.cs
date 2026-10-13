using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using System.Security.Cryptography;

namespace LicenseTool;

public class LicenseForm : Form
{
    private TextBox _days, _max, _to, _privPath, _genResult;
    private ComboBox _edition;
    private TextBox _pubPath, _verifyToken, _verifyResult;

    public LicenseForm()
    {
        Text = "ZS Live 授权签发工具";
        Width = 720; Height = 560;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new System.Drawing.Font("Microsoft YaHei", 10);
        var tabs = new TabControl { Dock = DockStyle.Fill };
        tabs.TabPages.Add(BuildGenerateTab());
        tabs.TabPages.Add(BuildVerifyTab());
        Controls.Add(tabs);
    }

    private TabPage BuildGenerateTab()
    {
        var page = new TabPage("签发 Token");
        var y = 16; int labelW = 130, inputW = 300;
        void AddLabel(string text, int top) => page.Controls.Add(new Label { Text = text, Left = 16, Top = top + 3, Width = labelW });
        TextBox AddInput(ref int top, string def = "")
        {
            var t = new TextBox { Left = 16 + labelW, Top = top, Width = inputW, Text = def };
            page.Controls.Add(t); top += 30; return t;
        }
        AddLabel("有效期(天, 0=永久)", y); _days = AddInput(ref y, "365");
        AddLabel("最大并发实例数", y); _max = AddInput(ref y, "6");
        AddLabel("版本档位", y);
        _edition = new ComboBox { Left = 16 + labelW, Top = y, Width = inputW, DropDownStyle = ComboBoxStyle.DropDownList };
        _edition.Items.AddRange(new[] { "eval", "standard", "enterprise" });
        _edition.SelectedIndex = 1; page.Controls.Add(_edition); y += 30;
        AddLabel("授权对象(客户名)", y); _to = AddInput(ref y, "");
        AddLabel("私钥文件(.pem)", y);
        _privPath = new TextBox { Left = 16 + labelW, Top = y, Width = inputW - 80, Text = DefaultKey("license.priv.pem") };
        page.Controls.Add(_privPath);
        var btnPriv = new Button { Left = 16 + labelW + inputW - 70, Top = y, Width = 70, Text = "浏览" };
        btnPriv.Click += (s, e) => PickFile(_privPath); page.Controls.Add(btnPriv); y += 30;
        var genBtn = new Button { Left = 16, Top = y, Width = 140, Text = "生成并复制", Height = 30 };
        genBtn.Click += OnGenerate; page.Controls.Add(genBtn);
        var saveBtn = new Button { Left = 170, Top = y, Width = 140, Text = "生成并存文件", Height = 30 };
        saveBtn.Click += OnGenerateSave; page.Controls.Add(saveBtn); y += 40;
        _genResult = new TextBox { Left = 16, Top = y, Width = 660, Height = 120, Multiline = true, ScrollBars = ScrollBars.Vertical, ReadOnly = true };
        page.Controls.Add(_genResult);
        return page;
    }

    private TabPage BuildVerifyTab()
    {
        var page = new TabPage("验证 Token");
        var y = 16; int labelW = 130, inputW = 400;
        page.Controls.Add(new Label { Text = "公钥文件(.pem)", Left = 16, Top = y + 3, Width = labelW });
        _pubPath = new TextBox { Left = 16 + labelW, Top = y, Width = inputW - 80, Text = DefaultKey("license.pub.pem") };
        page.Controls.Add(_pubPath);
        var btnPub = new Button { Left = 16 + labelW + inputW - 70, Top = y, Width = 70, Text = "浏览" };
        btnPub.Click += (s, e) => PickFile(_pubPath); page.Controls.Add(btnPub); y += 34;
        page.Controls.Add(new Label { Text = "待验证 Token", Left = 16, Top = y + 3, Width = labelW }); y += 24;
        _verifyToken = new TextBox { Left = 16, Top = y, Width = inputW + labelW - 16, Height = 70, Multiline = true, ScrollBars = ScrollBars.Vertical };
        page.Controls.Add(_verifyToken); y += 80;
        var vBtn = new Button { Left = 16, Top = y, Width = 160, Text = "验证", Height = 30 };
        vBtn.Click += OnVerify; page.Controls.Add(vBtn); y += 40;
        _verifyResult = new TextBox { Left = 16, Top = y, Width = 660, Height = 150, Multiline = true, ScrollBars = ScrollBars.Vertical, ReadOnly = true };
        page.Controls.Add(_verifyResult);
        return page;
    }

    private static string DefaultKey(string name)
    {
        var p = Path.Combine(AppContext.BaseDirectory, name);
        return File.Exists(p) ? p : name;
    }

    private void PickFile(TextBox target)
    {
        using var d = new OpenFileDialog { Filter = "PEM 文件|*.pem|所有文件|*.*", InitialDirectory = AppContext.BaseDirectory };
        if (d.ShowDialog() == DialogResult.OK) target.Text = d.FileName;
    }

    private void OnGenerate(object? s, EventArgs e)
    {
        var (ok, token, err) = Generate();
        if (!ok) { _genResult.Text = "生成失败: " + err; return; }
        _genResult.Text = token;
        Clipboard.SetText(token);
        MessageBox.Show("Token 已生成并复制到剪贴板。\n把它发给客户，客户在后台「授权管理」粘贴保存即可。", "成功", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void OnGenerateSave(object? s, EventArgs e)
    {
        var (ok, token, err) = Generate();
        if (!ok) { _genResult.Text = "生成失败: " + err; return; }
        using var d = new SaveFileDialog { Filter = "Key 文件|*.key|所有文件|*.*", FileName = "customer.key" };
        if (d.ShowDialog() == DialogResult.OK)
        {
            File.WriteAllText(d.FileName, token);
            _genResult.Text = token + "\n\n已保存: " + d.FileName;
        }
    }

    private (bool ok, string token, string err) Generate()
    {
        try
        {
            var days = long.Parse(_days.Text.Trim());
            var max = long.Parse(_max.Text.Trim());
            var privPem = File.ReadAllText(_privPath.Text.Trim());
            return LicenseCore.Sign(privPem, days, max, _edition.Text.Trim(), _to.Text.Trim());
        }
        catch (Exception ex) { return (false, "", ex.Message); }
    }

    private void OnVerify(object? s, EventArgs e)
    {
        try
        {
            var pubPem = File.ReadAllText(_pubPath.Text.Trim());
            var (ok, info, err) = LicenseCore.Verify(pubPem, _verifyToken.Text.Trim());
            _verifyResult.Text = ok ? info : ("❌ " + err);
        }
        catch (Exception ex) { _verifyResult.Text = "验证失败: " + ex.Message; }
    }

    [STAThread]
    public static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new LicenseForm());
    }
}
