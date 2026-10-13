; ============================================================
;  ZS Live 云渲染推流平台 - 一键安装包脚本
;  构建: ISCC ZSLive.iss（在 installer/ 目录下执行）
;  产物: ../dist/ZSLive-Setup-1.0.0.exe
;
;  组件:
;    core     - 调度服务 + Web 前端 + MediaMTX + 启动器 + Node 运行时（必装）
;    winpkg   - UE 演示程序 Windows 版（约 1 GB）
;    linuxpkg - UE 演示程序 Linux 版（约 1.2 GB，供部署到 Linux 渲染节点）
;
;  安装完成后自动执行:
;    1. 授予 Users 组目录写权限（服务子进程需要写 DB/日志）
;    2. 生成 launcher.config.json（指向随包 Node 运行时）
;    3. 添加防火墙规则（TCP 3100/1935/8890 + UDP 8189，自动去重）
;    4. 运行 install-init.js：生成 mediamtx.yml + 播种演示模板
; ============================================================

#define MyAppName "ZS Live 云渲染推流平台"
#define MyAppVersion "1.0.1"
#define MyAppPublisher "ZS Live"

[Setup]
AppId={{7F3A9C21-5E84-4B2D-A6C8-3D9E1F5A7B42}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
UninstallDisplayName={#MyAppName}
DefaultDirName=C:\ZS_Live
DefaultGroupName=ZS Live
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=ZSLive-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
DiskSliceSize=max
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
SetupLogging=yes
VersionInfoVersion={#MyAppVersion}

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Types]
Name: "full"; Description: "完整安装（含双平台 UE 演示程序）"
Name: "compact"; Description: "精简安装（仅平台服务，不含 UE 演示程序）"
Name: "custom"; Description: "自定义安装"; Flags: iscustom

[Components]
Name: "core"; Description: "调度服务 + Web 前端 + MediaMTX + 启动器 + Node 运行时（必装）"; Types: full compact custom; Flags: fixed
Name: "winpkg"; Description: "UE 演示程序 Windows 版（约 1 GB）"; Types: full
Name: "linuxpkg"; Description: "UE 演示程序 Linux 版（约 1.2 GB，供部署到 Linux 渲染节点）"; Types: full

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Files]
; .env 首次安装时从示例生成（升级安装不覆盖用户已改配置）
Source: "..\dist\stage\core\server\.env.example"; DestDir: "{app}\server"; DestName: ".env"; Flags: onlyifdoesntexist
Source: "..\dist\stage\core\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: core
Source: "..\dist\stage\winpkg\*"; DestDir: "{app}\UETest\Package\Windows"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: winpkg
Source: "..\dist\stage\linuxpkg\*"; DestDir: "{app}\UETest\Package\Linux"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: linuxpkg

[Icons]
Name: "{group}\ZS Live 启动器"; Filename: "{app}\launcher\ZSLiveLauncher.exe"; WorkingDir: "{app}\launcher"
Name: "{group}\部署与使用手册"; Filename: "{app}\docs\部署与使用手册.md"; WorkingDir: "{app}\docs"
Name: "{group}\卸载 ZS Live"; Filename: "{uninstallexe}"
Name: "{autodesktop}\ZS Live 启动器"; Filename: "{app}\launcher\ZSLiveLauncher.exe"; WorkingDir: "{app}\launcher"; Tasks: desktopicon

[Run]
Filename: "{app}\launcher\ZSLiveLauncher.exe"; Description: "启动 ZS Live 启动器"; WorkingDir: "{app}\launcher"; Flags: nowait postinstall skipifsilent

[Code]
const
  FW_RULE_SERVER = 'ZS Live Server (TCP 3100)';
  FW_RULE_MTX = 'ZS Live MediaMTX (TCP 1935 8890)';
  FW_RULE_RTC = 'ZS Live WebRTC (UDP 8189)';

function RunHidden(Exe, Params, WorkingDir: string; var ExitCode: Integer): Boolean;
begin
  Result := Exec(Exe, Params, WorkingDir, SW_HIDE, ewWaitUntilTerminated, ExitCode);
end;

// 防火墙规则：已存在则跳过（支持重装/升级不重复添加）
procedure AddFirewallRule(RuleName, Protocol, Ports: string);
var
  rc: Integer;
begin
  if RunHidden(ExpandConstant('{sys}\netsh.exe'),
      Format('advfirewall firewall show rule name="%s"', [RuleName]), '', rc) and (rc = 0) then
    exit;
  RunHidden(ExpandConstant('{sys}\netsh.exe'),
    Format('advfirewall firewall add rule name="%s" dir=in action=allow protocol=%s localport=%s', [RuleName, Protocol, Ports]), '', rc);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  appDir, nodeExe, serverDir, winExe, logPath, cfgPath, params, cmdLine, jNode, jMtx: string;
  rc: Integer;
begin
  if CurStep <> ssPostInstall then exit;
  appDir := ExpandConstant('{app}');

  // 1. Users 组写权限（非管理员运行启动器时服务子进程仍可写 DB/日志）
  RunHidden(ExpandConstant('{sys}\icacls.exe'),
    '"' + appDir + '" /grant *S-1-5-32-545:(OI)(CI)M', '', rc);
  RunHidden(ExpandConstant('{sys}\icacls.exe'),
    '"' + appDir + '\server" /grant *S-1-5-32-545:(OI)(CI)M /T', '', rc);

  // 2. launcher.config.json（首次安装生成，指向随包 Node；已存在不覆盖）
  cfgPath := appDir + '\launcher\launcher.config.json';
  if not FileExists(cfgPath) then
  begin
    jNode := appDir + '\runtime\node.exe';
    StringChangeEx(jNode, '\', '\\', True);
    jMtx := appDir + '\mediamtx\mediamtx.exe';
    StringChangeEx(jMtx, '\', '\\', True);
    SaveStringToFile(cfgPath,
      '{"nodePath": "' + jNode + '", "mediamtxPath": "' + jMtx + '"}' + #13#10, False);
  end;

  // 3. 防火墙规则（入站：调度服务 / MediaMTX RTMP+WHEP / WebRTC UDP）
  AddFirewallRule(FW_RULE_SERVER, 'TCP', '3100');
  AddFirewallRule(FW_RULE_MTX, 'TCP', '1935,8890');
  AddFirewallRule(FW_RULE_RTC, 'UDP', '8189');

  // 4. 初始化：生成 mediamtx.yml（含本机局域网 IP）+ 播种演示模板
  nodeExe := appDir + '\runtime\node.exe';
  serverDir := appDir + '\server';
  ForceDirectories(appDir + '\logs');
  logPath := appDir + '\logs\install-init.log';
  winExe := appDir + '\UETest\Package\Windows\UEtest.exe';
  params := 'install-init.js';
  if FileExists(winExe) then
    params := params + ' "' + winExe + '"';
  cmdLine := '/C ""' + nodeExe + '" ' + params + ' > "' + logPath + '" 2>&1"';
  RunHidden(ExpandConstant('{cmd}'), cmdLine, serverDir, rc);
end;

// 卸载前停掉本平台拉起的进程（避免文件被锁导致卸载残留）
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  rc: Integer;
begin
  if CurUninstallStep <> usUninstall then exit;
  RunHidden(ExpandConstant('{sys}\taskkill.exe'), '/F /IM UEtest.exe', '', rc);
  RunHidden(ExpandConstant('{sys}\taskkill.exe'), '/F /IM mediamtx.exe', '', rc);
  // 只杀工作目录在安装目录下的 node（不影响用户其他 Node 进程）
  RunHidden(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | ' +
    'Where-Object { $_.CommandLine -like ''' + ExpandConstant('{app}') + '\server*'' } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', '', rc);
end;

