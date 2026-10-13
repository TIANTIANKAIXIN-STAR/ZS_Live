# StreamForge UE 插件（接口层）

`StreamForge` 是 ZS_Live 的 Unreal Engine 端推流与控制插件，提供：

- UE 画面 **NVENC 硬编码**低延迟 RTMP 推流（4K@30/60）
- 浏览器 ↔ UE 的**双向控制通道**（命令透传，如按需关键帧 `sf_request_keyframe`）
- 待命降载（空闲实例低帧率/低码率省 GPU，会话接入瞬时恢复满配）

## 本目录为接口层（公开）

本公开仓库仅提供 **接口声明**，便于集成评估与技术沟通：

| 文件 | 内容 |
|---|---|
| `Source/StreamForge/Public/StreamForgeSubsystem.h` | 游戏线程入口（蓝图/原生调用）接口 |
| `Source/StreamForge/Public/StreamForgeModule.h` | 模块生命周期接口 |
| `Source/StreamForge/Public/StreamForgeTypes.h` | 公共类型 / 枚举 / 结构体 |
| `Source/StreamForge/StreamForge.Build.cs` | 模块构建依赖声明 |

## 实现为闭源授权组件

NVENC 编码管线、RTMP 推流、关键帧控制、控制通道等**实现代码（`Private/`）不在本仓库提供**，
需获取 License Key 后由作者提供完整插件。

## 集成方式

详见 [../docs/UE插件集成指南.md](../docs/UE插件集成指南.md)。
