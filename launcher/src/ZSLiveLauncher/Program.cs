using System.ComponentModel;
using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace ZSLiveLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

// =====================================================================
//  自定义控件：圆角面板 / 渐变标题栏 / 圆角按钮 / 状态圆点
// =====================================================================

internal static class UiKit
{
    public static GraphicsPath RoundedRect(Rectangle r, int rad)
    {
        var path = new GraphicsPath();
        int d = rad * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static Color Blend(Color a, Color b, float t) => Color.FromArgb(
        (int)(a.R + (b.R - a.R) * t),
        (int)(a.G + (b.G - a.G) * t),
        (int)(a.B + (b.B - a.B) * t));
}

/// <summary>圆角白卡片</summary>
public sealed class RoundedPanel : Panel
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public int Radius { get; set; } = 12;
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Color BorderColor { get; set; } = Color.FromArgb(228, 231, 238);

    public RoundedPanel()
    {
        DoubleBuffered = true;
        BackColor = Color.White;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using var path = UiKit.RoundedRect(rect, Radius);
        using var br = new SolidBrush(BackColor);
        g.FillPath(br, path);
        using var pen = new Pen(BorderColor);
        g.DrawPath(pen, path);
    }
}

/// <summary>顶部渐变标题栏（文本在 Paint 里绘制，避免 Label 透明底问题）</summary>
public sealed class GradientHeader : Panel
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public string Title { get; set; } = "";
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public string Subtitle { get; set; } = "";
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public string RightText { get; set; } = "";

    public GradientHeader() { DoubleBuffered = true; }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        using var br = new LinearGradientBrush(ClientRectangle,
            Color.FromArgb(37, 99, 235), Color.FromArgb(88, 80, 236), LinearGradientMode.Horizontal);
        e.Graphics.FillRectangle(br, ClientRectangle);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var fTitle = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold);
        using var fSub = new Font("Microsoft YaHei UI", 8.5F);
        TextRenderer.DrawText(g, Title, fTitle, new Point(24, 10), Color.White,
            TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        TextRenderer.DrawText(g, Subtitle, fSub, new Point(26, 40), Color.FromArgb(199, 216, 255),
            TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        if (RightText.Length > 0)
        {
            TextRenderer.DrawText(g, RightText, fSub, new Rectangle(0, 0, Width - 24, Height), Color.FromArgb(199, 216, 255),
                TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }
}

/// <summary>圆角按钮（支持实色 / 幽灵边框两种风格，含悬停与按压态）</summary>
public sealed class RoundButton : Button
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public int Radius { get; set; } = 9;
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public bool Ghost { get; set; }
    private bool _hover;
    private bool _down;

    public RoundButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Cursor = Cursors.Hand;
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnBackColorChanged(EventArgs e) { Invalidate(); base.OnBackColorChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);

        Color fill;
        if (!Enabled) fill = Color.FromArgb(209, 213, 219);
        else if (Ghost) fill = _hover ? Color.FromArgb(239, 246, 255) : Color.White;
        else
        {
            fill = BackColor;
            if (_hover) fill = UiKit.Blend(fill, Color.White, .16f);
            if (_down) fill = UiKit.Blend(fill, Color.Black, .10f);
        }

        using var path = UiKit.RoundedRect(rect, Radius);
        using (var br = new SolidBrush(fill)) g.FillPath(br, path);

        Color borderCol = Ghost
            ? (_hover ? Color.FromArgb(147, 197, 253) : Color.FromArgb(203, 213, 225))
            : UiKit.Blend(fill, Color.Black, Enabled ? .12f : .0f);
        using (var pen = new Pen(borderCol)) g.DrawPath(pen, path);

        var fg = !Enabled ? Color.FromArgb(120, 128, 140)
            : Ghost ? Color.FromArgb(37, 99, 235)
            : ForeColor;
        TextRenderer.DrawText(g, Text, Font, rect, fg,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
            TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }
}

/// <summary>服务状态圆点</summary>
public sealed class StatusDot : Control
{
    private Color _dot = Color.FromArgb(156, 163, 175);
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Color DotColor { get => _dot; set { if (_dot != value) { _dot = value; Invalidate(); } } }

    public StatusDot()
    {
        Size = new Size(10, 10);
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint |
                 ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
        TabStop = false;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var halo = new SolidBrush(Color.FromArgb(45, _dot));
        e.Graphics.FillEllipse(halo, 0, 0, Width - 1, Height - 1);
        using var br = new SolidBrush(_dot);
        e.Graphics.FillEllipse(br, 2, 2, Width - 5, Height - 5);
    }
}

/// <summary>
/// ZS Live 启动器（LarkXR 风格单页面板）：
/// - 服务状态区：MediaMTX / 调度服务 / UE 实例池，独立电源按钮启停
/// - 环境检查区：Node / MediaMTX / 项目文件 / 端口 / GPU / 防火墙 / VC++ 运行库
/// - 实例监控区：实时显示实例就绪 / 推流 / 浏览器连接数
/// - 底部日志 + 操作栏（一键启停 / 管理后台 / 首页 / 防火墙 / 开机自启）
/// 所有子进程全部无窗口后台运行，不污染桌面。
/// </summary>
public class MainForm : Form
{
    // ---------- 路径与配置 ----------
    private readonly string _root;
    private readonly string _serverDir;
    private readonly string _mediamtxDir;
    private int _port = 3100;
    private int _mtxApiPort = 9997;
    private string _adminUser = "admin";
    private string _adminPass = "admin123";
    private string _nodePath = "node";
    private string _mtxPath;

    // ---------- 进程 ----------
    private Process _nodeProc;
    private Process _mtxProc;

    // ---------- HTTP ----------
    private readonly HttpClient _http;
    private string _adminToken;
    private DateTime _tokenTime = DateTime.MinValue;
    private Dictionary<int, string> _templateNames = new();

    // ---------- 配色（浅色主题） ----------
    private static readonly Color CBg = Color.FromArgb(242, 244, 248);
    private static readonly Color CPanel = Color.White;
    private static readonly Color CText = Color.FromArgb(31, 41, 55);
    private static readonly Color CGray = Color.FromArgb(107, 114, 128);
    private static readonly Color CGreen = Color.FromArgb(34, 197, 94);
    private static readonly Color CRed = Color.FromArgb(239, 68, 68);
    private static readonly Color CBlue = Color.FromArgb(59, 130, 246);
    private static readonly Color COrange = Color.FromArgb(245, 158, 11);
    private static readonly Color CPurple = Color.FromArgb(139, 92, 246);
    private static readonly Color CBorder = Color.FromArgb(228, 231, 238);
    private static readonly Color CIdle = Color.FromArgb(156, 163, 175);

    // ---------- UI ----------
    private ServiceRow _rowMtx;
    private ServiceRow _rowNode;
    private ServiceRow _rowInst;
    private readonly List<(Label icon, Label text, Func<Task<(bool? ok, string text)>> check)> _envItems = new();
    private ListView _lvInstances;
    private TextBox _txtLog;
    private RoundButton _btnStartAll;
    private RoundButton _btnStopAll;
    private CheckBox _chkAutoStart;
    private System.Windows.Forms.Timer _timer;
    private bool _shuttingDown;
    private bool _busy;

    private const int POLL_MS = 2000;
    private const string RUN_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RUN_NAME = "ZSLiveLauncher";

    public MainForm()
    {
        _root = FindRoot();
        _serverDir = Path.Combine(_root, "server");
        _mediamtxDir = Path.Combine(_root, "mediamtx");
        _mtxPath = Path.Combine(_mediamtxDir, "mediamtx.exe");

        LoadConfig();

        _http = new HttpClient(new HttpClientHandler { Proxy = null, UseProxy = false })
        { Timeout = TimeSpan.FromSeconds(4) };

        Text = "ZS Live 启动器";
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = CBg;
        ForeColor = CText;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        ClientSize = new Size(984, 766);
        DoubleBuffered = true;

        BuildUi();

        _timer = new System.Windows.Forms.Timer { Interval = POLL_MS };
        _timer.Tick += async (_, _) => await PollAsync();
        _timer.Start();

        Log($"项目根目录: {_root}");
        _ = RunEnvChecksAsync();
        _ = StartAllAsync(); // 启动器打开即自动拉起服务
    }

    // =====================================================================
    //  配置
    // =====================================================================

    private static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "server", "src", "index.js")))
                return dir.FullName;
        }
        return AppContext.BaseDirectory;
    }

    private void LoadConfig()
    {
        try
        {
            var envFile = Path.Combine(_serverDir, ".env");
            if (File.Exists(envFile))
            {
                foreach (var raw in File.ReadAllLines(envFile))
                {
                    var line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line[..eq].Trim();
                    string v = line[(eq + 1)..].Trim();
                    switch (k)
                    {
                        case "PORT": _port = ParseInt(v, _port); break;
                        case "MEDIAMTX_API_PORT": _mtxApiPort = ParseInt(v, _mtxApiPort); break;
                        case "ADMIN_USER": _adminUser = DefaultStr(v, _adminUser); break;
                        case "ADMIN_PASS": _adminPass = DefaultStr(v, _adminPass); break;
                    }
                }
            }
        }
        catch { /* 用默认值 */ }

        try
        {
            var cfgFile = Path.Combine(AppContext.BaseDirectory, "launcher.config.json");
            if (File.Exists(cfgFile))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(cfgFile));
                var cfg = doc.RootElement;
                if (cfg.TryGetProperty("port", out var p) && p.ValueKind == JsonValueKind.Number) _port = p.GetInt32();
                if (cfg.TryGetProperty("mtxApiPort", out var mp) && mp.ValueKind == JsonValueKind.Number) _mtxApiPort = mp.GetInt32();
                if (cfg.TryGetProperty("nodePath", out var np) && np.ValueKind == JsonValueKind.String && np.GetString().Length > 0) _nodePath = np.GetString();
                if (cfg.TryGetProperty("mediamtxPath", out var mtp) && mtp.ValueKind == JsonValueKind.String && mtp.GetString().Length > 0) _mtxPath = mtp.GetString();
            }
        }
        catch { /* 配置坏文件不阻塞启动 */ }
    }

    private static int ParseInt(string s, int fallback) => int.TryParse(s, out var v) ? v : fallback;
    private static string DefaultStr(string s, string fallback) => string.IsNullOrWhiteSpace(s) ? fallback : s;

    // =====================================================================
    //  UI 构建
    // =====================================================================

    private sealed class ServiceRow
    {
        public Panel Panel;
        public Label Name;
        public Label Info;
        public Label Status;
        public StatusDot Dot;
        public RoundButton Power;
    }

    private void BuildUi()
    {
        // ---------- 顶部渐变标题栏 ----------
        var header = new GradientHeader
        {
            Location = new Point(0, 0),
            Size = new Size(984, 62),
            Title = "ZS Live",
            Subtitle = "云渲染推流平台 · 启动器",
            RightText = $"管理端口 :{_port} · RTMP 1935 · WHEP 8890",
        };

        // ---------- 服务状态 ----------
        var svcPanel = MakePanel(16, 76, 952, 184, "服务状态", "可单独启停，或使用底部一键启动");
        _rowMtx = MakeServiceRow(svcPanel, 40, "MediaMTX", "流媒体服务（RTMP 1935 / WHEP 8890）",
            async () => await ToggleMediaMtxAsync());
        _rowNode = MakeServiceRow(svcPanel, 84, "调度服务", $"实例调度 / 会话 / 控制通道（:{_port}）",
            async () => await ToggleNodeAsync());
        _rowInst = MakeServiceRow(svcPanel, 128, "UE 实例池", "由调度服务自动预热与分配",
            async () => await StopInstancesAsync());

        // ---------- 环境检查 ----------
        var envPanel = MakePanel(16, 272, 464, 208, "环境检查", null);
        var btnRecheck = new RoundButton
        {
            Text = "重新检查", Size = new Size(88, 24), Radius = 7,
            Ghost = true, Font = new Font("Microsoft YaHei UI", 8F),
            Location = new Point(362, 5),
        };
        btnRecheck.Click += async (_, _) => await RunEnvChecksAsync();
        envPanel.Controls.Add(btnRecheck);
        BuildEnvItems(envPanel);

        // ---------- 实例监控 ----------
        var instPanel = MakePanel(496, 272, 472, 208, "实例监控", "2 秒自动刷新");
        _lvInstances = new ListView
        {
            Location = new Point(12, 32),
            Size = new Size(448, 164),
            View = View.Details,
            FullRowSelect = true,
            HideSelection = true,
            BorderStyle = BorderStyle.None,
            BackColor = CPanel,
            Font = new Font("Microsoft YaHei UI", 8.5F),
        };
        foreach (var (n, w) in new[] { ("实例", 126), ("模板", 92), ("状态", 60), ("FPS", 42), ("推流", 60), ("浏览器", 52) })
            _lvInstances.Columns.Add(n, w);
        instPanel.Controls.Add(_lvInstances);

        // ---------- 日志 ----------
        _txtLog = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            Location = new Point(16, 492),
            Size = new Size(952, 210),
            BackColor = Color.FromArgb(23, 27, 36),
            ForeColor = Color.FromArgb(201, 212, 227),
            Font = new Font("Consolas", 8.5F),
            BorderStyle = BorderStyle.FixedSingle,
            WordWrap = false,
        };

        // ---------- 底部操作栏 ----------
        int by = 716;
        _btnStartAll = new RoundButton { Text = "▶ 一键启动", BackColor = CGreen, Size = new Size(112, 36) };
        _btnStartAll.Location = new Point(16, by);
        _btnStartAll.Click += async (_, _) => await StartAllAsync();

        _btnStopAll = new RoundButton { Text = "■ 一键停止", BackColor = CRed, Size = new Size(112, 36) };
        _btnStopAll.Location = new Point(136, by);
        _btnStopAll.Click += async (_, _) => await StopAllAsync();

        var btnAdmin = new RoundButton { Text = "管理后台", BackColor = CBlue, Size = new Size(96, 36) };
        btnAdmin.Location = new Point(262, by);
        btnAdmin.Click += (_, _) => OpenUrl($"http://127.0.0.1:{_port}/admin");

        var btnHome = new RoundButton { Text = "打开首页", Ghost = true, Size = new Size(96, 36) };
        btnHome.Location = new Point(366, by);
        btnHome.Click += (_, _) => OpenUrl($"http://127.0.0.1:{_port}/");

        var btnFw = new RoundButton { Text = "添加防火墙规则", BackColor = CPurple, Size = new Size(132, 36) };
        btnFw.Location = new Point(470, by);
        btnFw.Click += (_, _) => AddFirewallRules();

        _chkAutoStart = new CheckBox
        {
            Text = "开机自启",
            AutoSize = true,
            Location = new Point(622, by + 9),
            ForeColor = CText,
            Checked = IsAutoStartEnabled(),
        };
        _chkAutoStart.CheckedChanged += (_, _) => SetAutoStart(_chkAutoStart.Checked);

        var hint = new Label
        {
            Text = "服务以无窗口后台方式运行，关闭本窗口时可选择保留服务",
            ForeColor = CGray,
            AutoSize = true,
            Font = new Font("Microsoft YaHei UI", 8F),
            Location = new Point(718, by + 11),
        };

        Controls.AddRange(new Control[]
        {
            header, svcPanel, envPanel, instPanel, _txtLog,
            _btnStartAll, _btnStopAll, btnAdmin, btnHome, btnFw, _chkAutoStart, hint,
        });
    }

    private Panel MakePanel(int x, int y, int w, int h, string title, string subtitle)
    {
        var p = new RoundedPanel
        {
            Location = new Point(x, y),
            Size = new Size(w, h),
            BackColor = CPanel,
        };
        var accent = new Panel { Location = new Point(14, 12), Size = new Size(4, 14), BackColor = CBlue };
        p.Controls.Add(accent);
        var lbl = new Label
        {
            Text = title,
            Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
            ForeColor = CText,
            AutoSize = true,
            Location = new Point(26, 9),
        };
        p.Controls.Add(lbl);
        if (subtitle != null)
        {
            var sub = new Label
            {
                Text = subtitle,
                Font = new Font("Microsoft YaHei UI", 7.5F),
                ForeColor = CGray,
                AutoSize = true,
                Location = new Point(26 + lbl.PreferredWidth + 8, 12),
            };
            p.Controls.Add(sub);
        }
        return p;
    }

    private ServiceRow MakeServiceRow(Panel parent, int y, string name, string info, Func<Task> onPower)
    {
        var row = new ServiceRow();
        row.Panel = new Panel { Location = new Point(12, y), Size = new Size(parent.Width - 24, 40), BackColor = CPanel };
        row.Dot = new StatusDot { Location = new Point(8, 15) };
        row.Name = new Label
        {
            Text = name,
            Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
            ForeColor = CText,
            AutoSize = true,
            Location = new Point(26, 10),
        };
        row.Info = new Label
        {
            Text = info,
            Font = new Font("Microsoft YaHei UI", 8F),
            ForeColor = CGray,
            AutoSize = true,
            Location = new Point(160, 13),
        };
        row.Status = new Label
        {
            Text = "检测中…",
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
            ForeColor = CGray,
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleRight,
            Location = new Point(row.Panel.Width - 216, 5),
            Size = new Size(140, 30),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
        };
        row.Power = new RoundButton
        {
            Text = "⏻",
            Font = new Font("Segoe UI Symbol", 11F, FontStyle.Bold),
            Size = new Size(30, 30),
            Radius = 9,
            Location = new Point(row.Panel.Width - 62, 5),
            BackColor = CGreen,
            ForeColor = Color.White,
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
        };
        row.Power.Click += async (_, _) => await onPower();
        row.Panel.Controls.AddRange(new Control[] { row.Dot, row.Name, row.Info, row.Status, row.Power });
        row.Panel.Paint += (_, e) =>
        {
            using var pen = new Pen(Color.FromArgb(240, 242, 246));
            e.Graphics.DrawLine(pen, 26, row.Panel.Height - 1, row.Panel.Width - 8, row.Panel.Height - 1);
        };
        parent.Controls.Add(row.Panel);
        return row;
    }

    // =====================================================================
    //  环境检查
    // =====================================================================

    private void BuildEnvItems(Panel parent)
    {
        (string label, Func<Task<(bool?, string)>> check)[] defs =
        {
            ("Node.js 运行时",      CheckNodeAsync),
            ("MediaMTX 程序",       CheckMtxAsync),
            ("调度服务文件",        CheckServerFilesAsync),
            ($"端口 {_port}（调度）",  CheckPortDispatchAsync),
            ("端口 8890（WHEP）",    CheckPortWhepAsync),
            ("NVIDIA GPU",          CheckGpuAsync),
            ("防火墙规则",          CheckFirewallAsync),
            ("VC++ 运行库",         CheckVcRuntimeAsync),
        };
        for (int i = 0; i < defs.Length; i++)
        {
            int col = i % 2, rowi = i / 2;
            var icon = new Label
            {
                Text = "…",
                Font = new Font("Segoe UI Symbol", 10F, FontStyle.Bold),
                ForeColor = CGray,
                AutoSize = true,
                Location = new Point(16 + col * 224, 40 + rowi * 42),
            };
            var text = new Label
            {
                Text = defs[i].label,
                ForeColor = CText,
                AutoSize = true,
                Location = new Point(40 + col * 224, 42 + rowi * 42),
            };
            parent.Controls.Add(icon);
            parent.Controls.Add(text);
            _envItems.Add((icon, text, defs[i].check));
        }
    }

    private async Task RunEnvChecksAsync()
    {
        foreach (var (icon, text, check) in _envItems)
        {
            SetEnv(icon, text, null, text.Text.Split('（')[0].Split('：')[0]);
        }
        foreach (var (icon, text, check) in _envItems)
        {
            if (_shuttingDown) return;
            try
            {
                var (ok, msg) = await check();
                SetEnv(icon, text, ok, msg);
            }
            catch (Exception ex)
            {
                SetEnv(icon, text, false, $"{text.Text.Split('（')[0]}：检查异常 {ex.Message}");
            }
        }
    }

    private void SetEnv(Label icon, Label text, bool? ok, string msg)
    {
        void DoIt()
        {
            icon.Text = ok == null ? "…" : ok.Value ? "✓" : "✗";
            icon.ForeColor = ok == null ? CGray : ok.Value ? CGreen : CRed;
            text.Text = msg;
            text.ForeColor = ok == false ? CRed : CText;
        }
        if (InvokeRequired) BeginInvoke(DoIt); else DoIt();
    }

    private async Task<(bool?, string)> CheckNodeAsync()
    {
        var best = ResolveNodeCandidates()
            .Select(p => (path: p, ver: GetNodeVersion(p)))
            .Where(x => x.ver != null)
            .OrderByDescending(x => x.ver)
            .FirstOrDefault();
        if (best.path == null) return (false, "Node.js：未安装（需 18+）");
        return best.ver.Major >= 18
            ? (true, $"Node.js：v{best.ver} ✓")
            : (false, $"Node.js：v{best.ver} 版本过低（需 18+）");
    }

    private static Version GetNodeVersion(string nodeExe)
    {
        try
        {
            var psi = new ProcessStartInfo(nodeExe, "--version")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            using var p = Process.Start(psi);
            if (p == null || !p.WaitForExit(3000)) return null;
            var s = p.StandardOutput.ReadToEnd().Trim().TrimStart('v');
            return Version.TryParse(s, out var v) ? v : null;
        }
        catch { return null; }
    }

    private Task<(bool?, string)> CheckMtxAsync()
        => Task.FromResult(File.Exists(_mtxPath)
            ? ((bool?)true, "MediaMTX：已就绪")
            : ((bool?)false, $"MediaMTX：缺失 {_mtxPath}"));

    private Task<(bool?, string)> CheckServerFilesAsync()
    {
        bool ok = File.Exists(Path.Combine(_serverDir, "src", "index.js"))
               && File.Exists(Path.Combine(_serverDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
        return Task.FromResult(ok
            ? ((bool?)true, "调度服务文件：完整")
            : ((bool?)false, "调度服务文件：缺失（需在 server 目录执行 npm install）"));
    }

    private Task<(bool?, string)> CheckPortDispatchAsync()
    {
        // 已被占用不一定是坏事——可能就是本服务在跑
        bool busy = IsPortOpen(_port);
        return Task.FromResult(busy
            ? ((bool?)true, $"端口 {_port}：服务运行中")
            : ((bool?)true, $"端口 {_port}：空闲可用"));
    }

    private Task<(bool?, string)> CheckPortWhepAsync()
    {
        bool busy = IsPortOpen(8890);
        return Task.FromResult(busy
            ? ((bool?)true, "端口 8890：服务运行中")
            : ((bool?)true, "端口 8890：空闲可用"));
    }

    private Task<(bool?, string)> CheckGpuAsync()
    {
        try
        {
            var psi = new ProcessStartInfo("nvidia-smi", "--query-gpu=name --format=csv,noheader")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            using var p = Process.Start(psi);
            if (p != null && p.WaitForExit(4000) && p.ExitCode == 0)
            {
                var name = p.StandardOutput.ReadLine()?.Trim();
                if (!string.IsNullOrEmpty(name))
                    return Task.FromResult(((bool?)true, $"GPU：{name}"));
            }
        }
        catch { }
        return Task.FromResult(((bool?)false, "GPU：未检测到 NVIDIA 显卡（软编可用但性能差）"));
    }

    private Task<(bool?, string)> CheckFirewallAsync()
    {
        try
        {
            var psi = new ProcessStartInfo("netsh", "advfirewall firewall show rule name=\"ZS Live\"")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            using var p = Process.Start(psi);
            var outp = p?.StandardOutput.ReadToEnd() ?? "";
            p?.WaitForExit(4000);
            if (outp.Contains("ZS Live") && !outp.Contains("No rules match") && !outp.Contains("没有与指定标准相匹配"))
                return Task.FromResult(((bool?)true, "防火墙规则：已放行"));
        }
        catch { }
        return Task.FromResult(((bool?)false, "防火墙规则：未配置（仅本机访问可忽略）"));
    }

    private Task<(bool?, string)> CheckVcRuntimeAsync()
    {
        string sys = Environment.GetFolderPath(Environment.SpecialFolder.System);
        bool ok = File.Exists(Path.Combine(sys, "vcruntime140.dll"));
        return Task.FromResult(ok
            ? ((bool?)true, "VC++ 运行库：已安装")
            : ((bool?)false, "VC++ 运行库：缺失（UE 程序需要）"));
    }

    // =====================================================================
    //  防火墙 / 开机自启
    // =====================================================================

    private void AddFirewallRules()
    {
        Log("---- 添加防火墙规则（需要管理员权限）----");
        var rules = new[]
        {
            ("ZS Live 调度服务", "TCP", _port),
            ("ZS Live RTMP", "TCP", 1935),
            ("ZS Live WHEP", "TCP", 8890),
            ("ZS Live WebRTC", "UDP", 8189),
        };
        foreach (var (name, proto, port) in rules)
        {
            try
            {
                var psi = new ProcessStartInfo("netsh",
                    $"advfirewall firewall add rule name=\"{name}\" dir=in action=allow protocol={proto} localport={port}")
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                using var p = Process.Start(psi);
                string outp = (p?.StandardOutput.ReadToEnd() ?? "") + (p?.StandardError.ReadToEnd() ?? "");
                p?.WaitForExit(5000);
                bool ok = p != null && p.ExitCode == 0;
                Log($"  {(ok ? "[OK]" : "[失败]")} {name} {proto}/{port}：{outp.Trim()}");
                if (!ok && (outp.Contains("权限") || outp.Contains("privilege") || outp.Contains("admin")))
                    Log("  请以管理员身份运行启动器后重试");
            }
            catch (Exception ex)
            {
                Log($"  [失败] {name}：{ex.Message}");
            }
        }
        Log("---- 防火墙规则处理完成，外部机器即可访问 ----");
        _ = RunEnvChecksAsync();
    }

    private static bool IsAutoStartEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RUN_KEY, false);
            return key?.GetValue(RUN_NAME) != null;
        }
        catch { return false; }
    }

    private void SetAutoStart(bool enable)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RUN_KEY, true);
            if (key == null) return;
            if (enable)
            {
                key.SetValue(RUN_NAME, $"\"{Application.ExecutablePath}\"");
                Log("[OK] 已加入开机自启（当前用户）");
            }
            else
            {
                key.DeleteValue(RUN_NAME, false);
                Log("[OK] 已取消开机自启");
            }
        }
        catch (Exception ex)
        {
            Log($"[错误] 设置开机自启失败: {ex.Message}");
        }
    }

    // =====================================================================
    //  日志
    // =====================================================================

    private void Log(string msg)
    {
        if (_shuttingDown || IsDisposed) return;
        string line = $"[{DateTime.Now:HH:mm:ss}] {msg}\r\n";
        try
        {
            if (InvokeRequired) BeginInvoke(() => AppendLogCore(line));
            else AppendLogCore(line);
        }
        catch { /* 窗体已关 */ }
    }

    private void AppendLogCore(string line)
    {
        if (_txtLog == null) return;
        _txtLog.AppendText(line);
        if (_txtLog.TextLength > 400_000)
            _txtLog.Text = _txtLog.Text[^200_000..];
    }

    // =====================================================================
    //  服务启停
    // =====================================================================

    private static bool IsPortOpen(int port)
    {
        try
        {
            using var tcp = new TcpClient();
            var ar = tcp.BeginConnect("127.0.0.1", port, null, null);
            if (ar.AsyncWaitHandle.WaitOne(400))
            {
                tcp.EndConnect(ar);
                return true;
            }
            return false;
        }
        catch { return false; }
    }

    private async Task ToggleMediaMtxAsync()
    {
        if (IsPortOpen(_mtxApiPort)) KillByPort(_mtxApiPort, "MediaMTX");
        else await StartMediaMtxAsync();
    }

    private async Task ToggleNodeAsync()
    {
        if (IsPortOpen(_port)) { await StopInstancesAsync(); KillByPort(_port, "调度服务"); _adminToken = null; }
        else await StartNodeAsync();
    }

    private async Task StartAllAsync()
    {
        if (_busy) return;
        _busy = true;
        SetButtonsEnabled(false);
        try
        {
            Log("========== 开始启动全部服务 ==========");
            await StartMediaMtxAsync();
            await StartNodeAsync();
            for (int i = 0; i < 20; i++)
            {
                if (_shuttingDown) return;
                if (await HealthOkAsync()) { Log("[OK] 调度服务就绪"); break; }
                await Task.Delay(1000);
            }
            if (!await HealthOkAsync()) Log("[WARN] 调度服务 20 秒内未就绪，请查看日志排查");
            Log("========== 启动流程结束 ==========");
        }
        finally
        {
            _busy = false;
            SetButtonsEnabled(true);
        }
    }

    private async Task StartMediaMtxAsync()
    {
        if (IsPortOpen(_mtxApiPort)) { Log($"[跳过] MediaMTX 已在运行（端口 {_mtxApiPort}）"); return; }
        if (!File.Exists(_mtxPath)) { Log($"[错误] 未找到 {_mtxPath}，无法启动 MediaMTX"); return; }
        string yml = Path.Combine(_mediamtxDir, "mediamtx.yml");
        if (!File.Exists(yml)) { Log($"[错误] 未找到 {yml} 配置文件"); return; }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = _mtxPath,
                Arguments = "mediamtx.yml",
                WorkingDirectory = _mediamtxDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            _mtxProc = Process.Start(psi);
            if (_mtxProc == null) { Log("[错误] MediaMTX 进程启动失败"); return; }
            _mtxProc.OutputDataReceived += (_, e) => { if (e.Data != null) Log("[MediaMTX] " + e.Data); };
            _mtxProc.ErrorDataReceived += (_, e) => { if (e.Data != null) Log("[MediaMTX][err] " + e.Data); };
            _mtxProc.BeginOutputReadLine();
            _mtxProc.BeginErrorReadLine();
            _mtxProc.EnableRaisingEvents = true;
            _mtxProc.Exited += (_, _) =>
            {
                try { Log($"[MediaMTX] 进程已退出，退出码 {_mtxProc.ExitCode}"); }
                catch { Log("[MediaMTX] 进程已退出"); }
            };
            Log($"[启动] MediaMTX pid={_mtxProc.Id}（RTMP 1935 / WHEP 8890 / API {_mtxApiPort}）");
        }
        catch (Exception ex)
        {
            Log($"[错误] MediaMTX 启动异常: {ex.Message}");
        }
        await Task.Delay(300);
    }

    private async Task StartNodeAsync()
    {
        if (IsPortOpen(_port)) { Log($"[跳过] 调度服务已在运行（端口 {_port}）"); return; }
        if (!File.Exists(Path.Combine(_serverDir, "src", "index.js")))
        {
            Log($"[错误] 未找到 {_serverDir}\\src\\index.js");
            return;
        }

        var candidates = ResolveNodeCandidates();
        if (candidates.Count == 0)
        {
            Log("[错误] 未找到 Node.js。请安装 Node 18+，或在 launcher.config.json 里配置 nodePath");
            return;
        }

        foreach (var nodeExe in candidates)
        {
            var proc = TryStartNode(nodeExe);
            if (proc == null) continue;
            for (int i = 0; i < 10 && !proc.HasExited; i++)
            {
                await Task.Delay(1000);
                if (IsPortOpen(_port)) { AdoptNode(proc, nodeExe); return; }
            }
            if (IsPortOpen(_port)) { AdoptNode(proc, nodeExe); return; }

            if (proc.HasExited)
            {
                int code = -1;
                try { code = proc.ExitCode; } catch { }
                Log($"[警告] {nodeExe} 启动后即退出（退出码 {code}，常见原因: better-sqlite3 原生模块与该 Node 版本不匹配），尝试下一个 Node…");
            }
            else
            {
                AdoptNode(proc, nodeExe);
                return;
            }
        }
        Log("[错误] 所有候选 Node 均无法启动调度服务，请查看上方日志定位原因");
    }

    private void AdoptNode(Process proc, string nodeExe)
    {
        _nodeProc = proc;
        Log($"[OK] 调度服务已由 {nodeExe} 启动 (pid={proc.Id}，端口 {_port})");
    }

    private Process TryStartNode(string nodeExe)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "src\\index.js",
                WorkingDirectory = _serverDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            var proc = Process.Start(psi);
            if (proc == null) { Log($"[警告] 无法用 {nodeExe} 创建进程"); return null; }
            proc.OutputDataReceived += (_, e) => { if (e.Data != null) Log("[Server] " + e.Data); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data != null) Log("[Server][err] " + e.Data); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            proc.EnableRaisingEvents = true;
            proc.Exited += (_, _) =>
            {
                try { Log($"[Server] 进程已退出，退出码 {proc.ExitCode}"); }
                catch { Log("[Server] 进程已退出"); }
            };
            Log($"[启动] 尝试使用 Node: {nodeExe}");
            return proc;
        }
        catch (Exception ex)
        {
            Log($"[警告] 启动 {nodeExe} 异常: {ex.Message}");
            return null;
        }
    }

    private List<string> ResolveNodeCandidates()
    {
        var list = new List<string>();
        void Add(string p)
        {
            if (!string.IsNullOrWhiteSpace(p) && File.Exists(p) && !list.Contains(p, StringComparer.OrdinalIgnoreCase))
                list.Add(p);
        }
        if (_nodePath != "node") Add(_nodePath);
        try
        {
            var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in pathVar.Split(';', StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    var p = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(p)) Add(p);
                }
                catch { }
            }
        }
        catch { }
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"));
        return list;
    }

    private async Task StopInstancesAsync()
    {
        Log("---- 通过管理 API 优雅停止全部实例 ----");
        var instances = await GetJsonAsync($"{ApiBase}/api/admin/instances", auth: true);
        if (instances == null) { Log("[提示] 调度服务未运行，无需停止实例"); return; }
        JsonElement arr = instances.Value.ValueKind == JsonValueKind.Array
            ? instances.Value
            : (instances.Value.TryGetProperty("instances", out var l) ? l : default);
        if (arr.ValueKind != JsonValueKind.Array) return;
        int n = 0;
        foreach (var it in arr.EnumerateArray())
        {
            string id = it.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
            if (string.IsNullOrEmpty(id)) continue;
            var resp = await PostAsync($"{ApiBase}/api/admin/instances/{id}/stop", null, auth: true);
            Log($"  停止 {id}: {(resp ? "已下发" : "失败")}");
            n++;
        }
        if (n == 0) Log("  （当前没有实例在运行）");
        Log("---- 实例停止指令完成 ----");
    }

    private async Task StopAllAsync()
    {
        if (_busy) return;
        _busy = true;
        SetButtonsEnabled(false);
        try
        {
            Log("========== 开始停止全部服务 ==========");
            if (IsPortOpen(_port)) await StopInstancesAsync();
            KillByPort(_port, "调度服务");
            KillByPort(_mtxApiPort, "MediaMTX");
            _nodeProc = null;
            _mtxProc = null;
            _adminToken = null;
            Log("========== 全部服务已停止 ==========");
        }
        finally
        {
            _busy = false;
            SetButtonsEnabled(true);
        }
    }

    private void KillByPort(int port, string name)
    {
        try
        {
            var pids = GetPidsListeningOn(port);
            if (pids.Count == 0) { Log($"[跳过] {name} 未在运行"); return; }
            foreach (var pid in pids)
            {
                var psi = new ProcessStartInfo("taskkill", $"/F /T /PID {pid}")
                { UseShellExecute = false, CreateNoWindow = true };
                using var p = Process.Start(psi);
                p?.WaitForExit(5000);
                Log($"[停止] 已结束 {name} 进程 pid={pid}");
            }
        }
        catch (Exception ex)
        {
            Log($"[错误] 停止 {name} 失败: {ex.Message}");
        }
    }

    private static HashSet<int> GetPidsListeningOn(int port)
    {
        var pids = new HashSet<int>();
        try
        {
            var psi = new ProcessStartInfo("netstat", "-ano -p tcp")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            using var p = Process.Start(psi);
            string output = p?.StandardOutput.ReadToEnd() ?? "";
            foreach (var raw in output.Split('\n'))
            {
                var line = raw.Trim();
                if (!line.StartsWith("TCP")) continue;
                var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                var local = parts[1];
                if (local.EndsWith($":{port}") && line.Contains("LISTENING") && int.TryParse(parts[^1], out int pid))
                    pids.Add(pid);
            }
        }
        catch { }
        return pids;
    }

    // =====================================================================
    //  HTTP / API
    // =====================================================================

    private string ApiBase => $"http://127.0.0.1:{_port}";
    private string MtxBase => $"http://127.0.0.1:{_mtxApiPort}";

    private async Task<bool> HealthOkAsync()
    {
        try
        {
            using var resp = await _http.GetAsync($"{ApiBase}/health");
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private async Task<JsonElement?> GetJsonAsync(string url, bool auth = false)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                if (auth && !string.IsNullOrEmpty(_adminToken))
                    req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _adminToken);
                using var resp = await _http.SendAsync(req);
                if (resp.StatusCode == HttpStatusCode.Unauthorized && auth)
                {
                    _adminToken = null;
                    if (await LoginAsync()) continue;
                }
                if (!resp.IsSuccessStatusCode) return null;
                using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
                return doc.RootElement.Clone();
            }
            catch { return null; }
        }
        return null;
    }

    private async Task<bool> PostAsync(string url, string jsonBody, bool auth = false)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            if (auth && !string.IsNullOrEmpty(_adminToken))
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _adminToken);
            if (jsonBody != null)
                req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
            using var resp = await _http.SendAsync(req);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private async Task<bool> LoginAsync()
    {
        try
        {
            var body = JsonSerializer.Serialize(new { username = _adminUser, password = _adminPass });
            using var resp = await _http.PostAsync($"{ApiBase}/api/admin/login",
                new StringContent(body, Encoding.UTF8, "application/json"));
            if (!resp.IsSuccessStatusCode) return false;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            if (doc.RootElement.TryGetProperty("token", out var t))
            {
                _adminToken = t.GetString();
                _tokenTime = DateTime.Now;
                return true;
            }
            return false;
        }
        catch { return false; }
    }

    private async Task LoadTemplateNamesAsync()
    {
        var tpl = await GetJsonAsync($"{ApiBase}/api/admin/templates", auth: true);
        if (tpl == null) return;
        JsonElement arr = tpl.Value.ValueKind == JsonValueKind.Array
            ? tpl.Value
            : (tpl.Value.TryGetProperty("templates", out var l) ? l : default);
        if (arr.ValueKind != JsonValueKind.Array) return;
        var names = new Dictionary<int, string>();
        foreach (var t in arr.EnumerateArray())
        {
            if (t.TryGetProperty("id", out var idEl) && t.TryGetProperty("name", out var nameEl))
                names[idEl.GetInt32()] = nameEl.GetString();
        }
        if (names.Count > 0) _templateNames = names;
    }

    // =====================================================================
    //  轮询
    // =====================================================================

    private async Task PollAsync()
    {
        if (_shuttingDown || _busy) return;
        try
        {
            bool nodeUp = IsPortOpen(_port);
            bool mtxUp = IsPortOpen(_mtxApiPort);
            UpdateServiceRow(_rowMtx, mtxUp, mtxUp ? "运行中" : "已停止");
            UpdateServiceRow(_rowNode, nodeUp, nodeUp ? "运行中" : "已停止");

            if (nodeUp)
            {
                if (_adminToken == null || DateTime.Now - _tokenTime > TimeSpan.FromMinutes(30))
                {
                    if (!await LoginAsync()) _adminToken = null;
                }
                if (_templateNames.Count == 0) await LoadTemplateNamesAsync();
                await UpdateInstancesAsync();
            }
            else
            {
                UpdateServiceRow(_rowInst, false, "已停止");
                ClearListIfNotEmpty(_lvInstances);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(ex.Message);
        }
    }

    private void UpdateServiceRow(ServiceRow row, bool running, string text)
    {
        if (InvokeRequired) { BeginInvoke(() => DoUpdate()); } else DoUpdate();
        return;
        void DoUpdate()
        {
            row.Status.Text = text;
            row.Status.ForeColor = running ? Color.FromArgb(21, 128, 61) : CRed;
            row.Dot.DotColor = running ? CGreen : CRed;
            row.Power.BackColor = running ? CRed : CGreen;
        }
    }

    private async Task UpdateInstancesAsync()
    {
        var data = await GetJsonAsync($"{ApiBase}/api/admin/instances", auth: true);
        if (data == null) return;
        JsonElement arr = data.Value.ValueKind == JsonValueKind.Array
            ? data.Value
            : (data.Value.TryGetProperty("instances", out var listEl) ? listEl : default);
        if (arr.ValueKind != JsonValueKind.Array) return;

        // MediaMTX readers：zslive/<instanceId> 的 webRTC 读者数 = 浏览器连接数
        var readersByInst = new Dictionary<string, int>();
        var pathsJson = await GetJsonAsync($"{MtxBase}/v3/paths/list");
        if (pathsJson != null && pathsJson.Value.TryGetProperty("items", out var items))
        {
            foreach (var p in items.EnumerateArray())
            {
                if (!p.TryGetProperty("name", out var n)) continue;
                string name = n.GetString() ?? "";
                if (!name.StartsWith("zslive/")) continue;
                int cnt = p.TryGetProperty("readers", out var r) && r.ValueKind == JsonValueKind.Array ? r.GetArrayLength() : 0;
                readersByInst[name["zslive/".Length..]] = cnt;
            }
        }

        int ready = 0, total = 0;
        void DoUpdate()
        {
            _lvInstances.BeginUpdate();
            _lvInstances.Items.Clear();
            foreach (var it in arr.EnumerateArray())
            {
                string id = GetStr(it, "id") ?? "-";
                int tplId = GetInt(it, "templateId");
                string state = GetStr(it, "state") ?? "-";
                string sess = GetStr(it, "sessionId");

                double fps = 0; bool rtmpOk = false;
                if (it.TryGetProperty("stats", out var st) && st.ValueKind == JsonValueKind.Object)
                {
                    fps = GetDbl(st, "fps");
                    rtmpOk = st.TryGetProperty("rtmpOk", out var ro) && ro.ValueKind == JsonValueKind.True;
                }
                readersByInst.TryGetValue(id, out int readers);

                total++;
                if (state == "ready" || state == "assigned") ready++;

                string shortId = id.Length > 14 ? id[..14] + "…" : id;
                var item = new ListViewItem(shortId);
                item.SubItems.Add(_templateNames.TryGetValue(tplId, out var tplName) ? tplName : $"模板{tplId}");
                item.SubItems.Add(sess != null ? "使用中" : state);
                item.SubItems.Add(fps > 0 ? fps.ToString("0") : "-");
                item.SubItems.Add(rtmpOk ? "✔ 推流" : "—");
                item.SubItems.Add(readers.ToString());

                item.ForeColor = (sess != null) ? CBlue
                    : state == "ready" ? Color.FromArgb(21, 128, 61)
                    : state is "spawning" or "starting" ? COrange
                    : state == "dead" ? CRed
                    : CText;
                _lvInstances.Items.Add(item);
            }
            _lvInstances.EndUpdate();

            _rowInst.Status.Text = total == 0 ? "无实例" : $"{ready}/{total} 就绪";
            _rowInst.Status.ForeColor = ready > 0 ? Color.FromArgb(21, 128, 61) : COrange;
            _rowInst.Dot.DotColor = total == 0 ? CIdle : ready > 0 ? CGreen : COrange;
            _rowInst.Power.BackColor = total > 0 ? CRed : CGreen;
            _rowInst.Power.Enabled = total > 0;
        }

        if (InvokeRequired) BeginInvoke(DoUpdate); else DoUpdate();
    }

    private void ClearListIfNotEmpty(ListView lv)
    {
        if (lv.Items.Count == 0) return;
        if (InvokeRequired) BeginInvoke(() => { lv.Items.Clear(); });
        else lv.Items.Clear();
    }

    // =====================================================================
    //  辅助
    // =====================================================================

    private void SetButtonsEnabled(bool enabled)
    {
        void DoIt()
        {
            _btnStartAll.Enabled = enabled;
            _btnStopAll.Enabled = enabled;
        }
        if (InvokeRequired) BeginInvoke(DoIt); else DoIt();
    }

    private void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception ex) { Log($"[错误] 打开浏览器失败: {ex.Message}"); }
    }

    private static string GetStr(JsonElement e, string prop)
        => e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int GetInt(JsonElement e, string prop)
        => e.TryGetProperty(prop, out var v) && v.TryGetInt32(out int i) ? i : 0;

    private static double GetDbl(JsonElement e, string prop)
        => e.TryGetProperty(prop, out var v) && v.TryGetDouble(out double d) ? d : 0;

    // =====================================================================
    //  退出
    // =====================================================================

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _shuttingDown = true;
        _timer?.Stop();

        bool nodeUp = IsPortOpen(_port);
        bool mtxUp = IsPortOpen(_mtxApiPort);

        if ((nodeUp || mtxUp) && e.CloseReason == CloseReason.UserClosing)
        {
            var result = MessageBox.Show(
                "服务正在运行。要在退出启动器的同时停止全部服务吗？\n\n" +
                "「是」= 停止全部服务并退出\n「否」= 保持服务后台运行，仅退出启动器",
                "ZS Live 启动器",
                MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);

            if (result == DialogResult.Cancel) { e.Cancel = true; _shuttingDown = false; _timer?.Start(); return; }
            if (result == DialogResult.Yes)
            {
                if (nodeUp) StopInstancesBlocking();
                KillByPort(_port, "调度服务");
                KillByPort(_mtxApiPort, "MediaMTX");
            }
        }
        base.OnFormClosing(e);
    }

    private void StopInstancesBlocking()
    {
        try
        {
            var data = GetJsonAsync($"{ApiBase}/api/admin/instances", auth: true).GetAwaiter().GetResult();
            if (data == null) return;
            JsonElement arr = data.Value.ValueKind == JsonValueKind.Array
                ? data.Value
                : (data.Value.TryGetProperty("instances", out var l) ? l : default);
            if (arr.ValueKind != JsonValueKind.Array) return;
            foreach (var it in arr.EnumerateArray())
            {
                string id = GetStr(it, "id");
                if (!string.IsNullOrEmpty(id))
                    PostAsync($"{ApiBase}/api/admin/instances/{id}/stop", null, auth: true).GetAwaiter().GetResult();
            }
            System.Threading.Thread.Sleep(4000);
        }
        catch { }
    }
}
