// 对比新构建产物 vs 包目录的模块文件结构
const fs = require('fs');
const path = require('path');

function listWithMtime(dir, filter) {
  if (!fs.existsSync(dir)) return ['(dir missing: ' + dir + ')'];
  return fs.readdirSync(dir)
    .filter((f) => !filter || filter(f))
    .map((f) => {
      const s = fs.statSync(path.join(dir, f));
      return `${f}  ${s.size}B  ${s.mtime.toISOString().slice(0, 16)}`;
    });
}

console.log('=== 新构建 UEtest\\Binaries\\Win64 ===');
listWithMtime('F:/streamming/ZS_Live/UETest/UEtest/Binaries/Win64').forEach((x) => console.log(' ', x));

console.log('=== 新构建 插件 StreamForge Binaries\\Win64 ===');
listWithMtime('F:/streamming/ZS_Live/UETest/UEtest/Plugins/StreamForge/Binaries/Win64').forEach((x) => console.log(' ', x));

console.log('=== 包目录 Package\\Windows (根) ===');
listWithMtime('F:/streamming/ZS_Live/UETest/Package/Windows', (f) => f.endsWith('.exe') || f.endsWith('.dll') || f.endsWith('.bak-20261012')).forEach((x) => console.log(' ', x));

console.log('=== 包目录 Package\\Windows\\UEtest\\Binaries\\Win64 ===');
listWithMtime('F:/streamming/ZS_Live/UETest/Package/Windows/UEtest/Binaries/Win64').forEach((x) => console.log(' ', x));

console.log('=== 包目录 插件 DLL ===');
const pkgPlugin = 'F:/streamming/ZS_Live/UETest/Package/Windows/UEtest/Plugins/StreamForge/Binaries/Win64';
listWithMtime(pkgPlugin).forEach((x) => console.log(' ', x));
const pkgPlugin2 = 'F:/streamming/ZS_Live/UETest/Package/Windows/Engine/Plugins/StreamForge/Binaries/Win64';
listWithMtime(pkgPlugin2).forEach((x) => console.log(' (engine侧)', x));
