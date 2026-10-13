@echo off
rem 编译 ZS Live 授权签发工具（作者自用）
rem 默认：依赖本机 .NET 9 运行时（体积小）；如需无运行时便携版，去掉下方注释改用自包含。
cd /d %~dp0
dotnet publish -c Release -r win-x64 -o dist
rem dotnet publish -c Release -r win-x64 --self-contained -o dist-portable
echo.
echo 编译完成：dist\LicenseTool.exe ^(双击运行^)
pause
