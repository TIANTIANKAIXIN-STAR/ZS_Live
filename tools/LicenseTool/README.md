# ZS Live 授权签发工具（作者自用 · 私有）

图形化签发/验证 License Token 的 Windows 程序。

## 用法
1. 把私钥 `license.priv.pem` 放到 `LicenseTool.exe` **同目录**（或点「浏览」指定）。
2. 双击 `LicenseTool.exe`：填有效期(天, 0=永久) / 最大并发实例数 / 档位 / 客户名。
3. 「生成并复制」→ token 自动进剪贴板；或「生成并存文件」。
4. 把 token 字符串发给客户，客户在后台「授权管理」粘贴保存即可。

「验证 Token」页：粘贴客户发回的 token + 公钥，确认签名有效、未过期。

## 编译
已编译好的 exe 在 `dist/LicenseTool.exe`（依赖本机 .NET 9 运行时，作者机器已具备）。
重新编译：`build.bat`（或 `dotnet publish -c Release -r win-x64 -o dist`）。

## 安全
私钥 `license.priv.pem` **绝不内嵌进 exe**（从同目录读取）。本工具可随意分发给你自己，但私钥文件不要随部署包发出去。
