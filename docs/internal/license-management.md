# ZS Live 授权与交付管理（私有 · 内部文档）

> 本文件**仅存在于私有仓库**（`ZS_Live-Private`），用于你自己给客户签发 License、生成交付包。
> 切勿将其复制/推送到公开仓库 `ZS_Live`。

---

## 0. 三种客户形态

| 客户类型 | 你交付什么 | 授权方式 | 密钥核对 |
|---|---|---|---|
| **① 应用购买**（部署包） | 编译好的部署包（含授权模块） | 后台「授权管理」开关 + 你签发的 token | ✅ 内置，必须验 token |
| **② 源码购买**（源代码） | 仅含推流 + UE 插件的源码（见 §6） | 无密钥核对（源码版删除了 license.js） | ❌ 不限制 |
| **③ 试用**（Trial） | 部署包，但不发 token | 部署包默认即评估模式 | 未授权 → 仅 1 实例 |

要点：
- **类型①**是主营收模型：部署包内置 RSA 授权模块，**后台「授权管理」页**里你能让客户粘贴 token；token 的**有效期 / 实例上限 / 档位**全由你签发时决定。
- **类型②**只卖源码（推流 + UE 插件），不卖授权体系——交付前用 `scripts/build_source_edition.js` 生成一份**不含 `license.js` 的源码包**，运行时自动降级为不限实例。
- **类型③**就是类型①不发 token 的状态：客户装好即是评估模式（最多 1 实例），购买后你补发 token 即可解除，无需换包。

---

## 1. 授权原理（一句话）

- 你（作者）持有**私钥** `server/license.priv.pem`，只有它能**签发** License。
- 部署包只含**公钥** `server/license.pub.pem`，只能**验签**、**无法伪造**。
- 因此：客户即便拆解整个部署包，也造不出合法的 License Token。

---

## 2. 用 EXE 工具签发（最方便，推荐）

项目里提供了图形化签发工具 `tools/LicenseTool/`（已编译好的 exe 在 `tools/LicenseTool/dist/`）：

1. 把 `server/license.priv.pem`（私钥）放到 `LicenseTool.exe` **同目录**（或点「浏览」指定）。
2. 双击 `LicenseTool.exe`：填「有效期(天, 0=永久) / 最大并发实例数 / 档位 / 客户名」，**生成并复制**（自动进剪贴板，也可「生成并存文件」）。
3. 把生成的 **Token 字符串**发给客户，客户在后台「授权管理」粘贴保存即可。

> 该工具的验签逻辑与 Node 端 `server/src/license.js` 已做**双向兼容性验证**（C# 签发的 token 能被 Node 验过、Node 签发的也能被 C# 验过），格式完全一致。

如需重新编译（或打自包含便携版）：
```bash
cd tools/LicenseTool
dotnet publish -c Release -r win-x64 --self-contained -o dist-portable   # 自带运行时，可拷到无 .NET 的机器
# 或默认（依赖本机 .NET 9 运行时，体积小）：
dotnet publish -c Release -r win-x64 -o dist
```

---

## 3. 用命令行签发（备选）

```bash
node scripts/gen_license.js <天数> <实例数> <档位> <客户名> server/keys/<客户名>.key
```

| 参数 | 含义 | 示例 |
|---|---|---|
| 天数 | 有效期天数；**`0` = 永久** | `365` / `0` |
| 实例数 | 最大并发推流实例数 | `6` |
| 档位 | `eval` / `standard` / `enterprise` | `standard` |
| 客户名 | 授权对象，用于泄露溯源 | `"客户A-专业版"` |

三档速查：
```bash
node scripts/gen_license.js 30 1 eval        "客户A-POC"     server/keys/customerA-eval.key      # 🆓 评估
node scripts/gen_license.js 365 6 standard    "客户A-专业版"  server/keys/customerA-pro.key       # 🏅 专业
node scripts/gen_license.js 0 50 enterprise   "客户B-企业版"  server/keys/customerB-ent.key       # 💎 企业(永久)
```
运行后打印的 `TOKEN    : xxxx.yyyy` 就是授权串，发给客户。签发前建议校验：
```bash
node scripts/verify_license.js server/keys/customerA-pro.key   # 看到 valid:true 再发
```

---

## 4. 客户侧安装 token（把这段连同 token 一起发客户）

客户拿到 token 后，在后台「授权管理」页：勾选「启用授权验证」→ 把 token 整行粘贴进文本框 →「保存并验证」。
保存后服务实时生效（无需重启），状态区会显示档位 / 实例上限 / 到期时间。

也可走环境变量/文件（部署自动化场景）：
```bash
ZSLIVE_LICENSE="<token>" node server/src/index.js
# 或把 token 单行写入 server/license.key 后重启
```

> 客户**无需私钥**，部署包已自带公钥 `server/license.pub.pem`。

---

## 5. 后台「授权管理」开关说明

部署包的后台「授权管理」页由 `server/src/license.js` 是否存在决定：
- **存在（部署包）**：显示该页。开关「启用授权验证」默认 **开**；关掉则不限制实例数（仅供你自用 / 交付前测试，正式交付应保持开启）。
- **不存在（源码版，§6）**：该页自动隐藏，运行时不限制实例数。

---

## 6. 源码购买客户的交付包（类型②）

运行生成器，产出一份**删除授权模块、仅含推流 + UE 插件**的源码包：

```bash
node scripts/build_source_edition.js
```

产物在 `dist/source-edition/`（可整体打包发给源码客户）。它会：
- 复制整个工程源码；
- **删除** `server/src/license.js`（密钥核对模块）、`server/license.*.pem`、`server/keys/`；
- **删除** 作者内部工具：`scripts/gen_license.js`、`scripts/verify_license.js`、`tools/LicenseTool/`、`docs/internal/`；
- 保留：推流调度 `server/`（不含授权）、`web/`、`ue-plugin/`、`launcher/`、`mediamtx/`、`installer/`、`docs/`(公开部分)。

因为 `license.js` 被删除，运行时自动降级为「不限制实例」——源码客户拿到的是纯净的推流+插件代码，没有授权体系。

---

## 7. 常见问题

- **客户没 token / token 错 / 已过期**：服务自动进入「评估模式」——仅 1 实例、全功能可用、不崩溃。预期防白嫖行为。
- **token 被泄露倒卖**：`to` 字段记录客户名可溯源；如需强控可结合机器指纹（超出本脚本范围）。
- **实例上限 `max`**：同时运行的推流实例数上限；超量时新实例被拒绝启动。

---

## 8. 安全红线

1. **`server/license.priv.pem`（私钥）永远不进公开仓库、不发任何人、不进部署包。** 仅本机 + 私有库备份 + 离线 U 盘多处备份。
2. 换电脑/重装前先备份私钥；一旦怀疑泄露，立即重新生成 RSA 密钥对并给所有客户重签（旧 token 全部失效）。
3. 公开仓库只有前端壳 + 插件接口 + 文档；核心 `server/` 与签发工具只在私有仓库。
