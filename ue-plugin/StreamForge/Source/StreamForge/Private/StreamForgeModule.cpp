// Copyright ZS Live Platform. All Rights Reserved.

#include "StreamForgeModule.h"
#include "StreamForgeTypes.h"
#include "StreamForgeSubsystem.h"
#include "SFLog.h"
#include "SFVideoPipeline.h"
#include "SFAudioPipeline.h"
#include "SFControlChannel.h"
#include "SFRtmpPusher.h"

#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "HAL/PlatformProcess.h"
#include "Engine/Engine.h"
#include "Framework/Application/SlateApplication.h"
#include "Misc/CoreDelegates.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"

DEFINE_LOG_CATEGORY(LogStreamForge);

namespace ModuleManagerHack
{
	UStreamForgeSubsystem* GSubsystem = nullptr;

	void SetSubsystem(UStreamForgeSubsystem* InSubsystem)
	{
		GSubsystem = InSubsystem;
	}
}

//////////////////////////////////////////////////////////////////
// FSFSettings
//////////////////////////////////////////////////////////////////

FSFSettings FSFSettings::FromCommandLine()
{
	FSFSettings S;
	FParse::Value(FCommandLine::Get(), TEXT("SFInstanceId="), S.InstanceId);
	FParse::Value(FCommandLine::Get(), TEXT("SFRtmpUrl="), S.RtmpUrl);
	FParse::Value(FCommandLine::Get(), TEXT("SFAgentUrl="), S.AgentUrl);
	FParse::Value(FCommandLine::Get(), TEXT("SFAgentToken="), S.AgentToken);
	FParse::Value(FCommandLine::Get(), TEXT("SFAudio="), S.AudioCodec);

	FParse::Value(FCommandLine::Get(), TEXT("SFWidth="), S.Width);
	FParse::Value(FCommandLine::Get(), TEXT("SFHeight="), S.Height);
	FParse::Value(FCommandLine::Get(), TEXT("SFFps="), S.Fps);
	FParse::Value(FCommandLine::Get(), TEXT("SFBitrate="), S.BitrateKbps);
	FParse::Value(FCommandLine::Get(), TEXT("SFMaxBitrate="), S.MaxBitrateKbps);
	FParse::Value(FCommandLine::Get(), TEXT("SFAudioBitrate="), S.AudioBitrateKbps);
	FParse::Value(FCommandLine::Get(), TEXT("SFKeyframeInterval="), S.KeyframeIntervalSec);
	S.KeyframeIntervalSec = FMath::Clamp(S.KeyframeIntervalSec < 0 ? 0 : S.KeyframeIntervalSec, 0, 30);

	bool bInput = true;
	if (FParse::Bool(FCommandLine::Get(), TEXT("SFInput="), bInput))
	{
		S.bEnableInput = bInput;
	}
	bool bExitOnFailure = true;
	if (FParse::Bool(FCommandLine::Get(), TEXT("SFExitOnFailure="), bExitOnFailure))
	{
		S.bExitOnFailure = bExitOnFailure;
	}

	// 编码后端与 FFmpeg 路径（缺省 auto + PATH 里的 ffmpeg）
	FParse::Value(FCommandLine::Get(), TEXT("SFEncoder="), S.EncoderBackend);
	S.EncoderBackend.ToLowerInline();
	if (S.EncoderBackend != TEXT("ave") && S.EncoderBackend != TEXT("ffmpeg"))
	{
		S.EncoderBackend = TEXT("auto");
	}
	FParse::Value(FCommandLine::Get(), TEXT("SFFFmpegPath="), S.FFmpegPath);
	if (S.FFmpegPath.IsEmpty())
	{
		S.FFmpegPath = TEXT("ffmpeg");
	}
	FParse::Value(FCommandLine::Get(), TEXT("SFFFmpegArgs="), S.FFmpegArgs);

	// defaults sanity
	S.Width = FMath::Clamp(S.Width == 0 ? 1280 : S.Width, 320u, 3840u);
	S.Height = FMath::Clamp(S.Height == 0 ? 720 : S.Height, 240u, 2160u);
	S.Fps = FMath::Clamp(S.Fps == 0 ? 30 : S.Fps, 5u, 120u);
	S.BitrateKbps = S.BitrateKbps <= 0 ? 8000 : S.BitrateKbps;
	S.MaxBitrateKbps = S.MaxBitrateKbps <= S.BitrateKbps ? S.BitrateKbps * 3 / 2 : S.MaxBitrateKbps;

	S.bValid = !S.RtmpUrl.IsEmpty();
	return S;
}

FString FSFSettings::ToString() const
{
	return FString::Printf(TEXT("instance=%s rtmp=%s agent=%s %ux%u@%u %dkbps audio=%s input=%d encoder=%s"),
		*InstanceId, *RtmpUrl, *AgentUrl, Width, Height, Fps, BitrateKbps, *AudioCodec, bEnableInput ? 1 : 0, *EncoderBackend);
}

//////////////////////////////////////////////////////////////////
// Module runtime
//////////////////////////////////////////////////////////////////

namespace
{
	class FStreamForgeRuntime
	{
	public:
		bool Start()
		{
			if (bStarted)
			{
				return true;
			}

			UE_LOG(LogStreamForge, Log, TEXT("=== StreamForge starting: %s ==="), *Settings.ToString());

			Pusher = MakeUnique<FSFRtmpPusher>();

			// 控制通道先建好并接好回调：即便视频管线初始化失败，
			// 也要把失败原因通过 agent hello 上报给调度服务——
			// 否则服务端只能干等 120s spawn 超时，用户侧表现为"推流一直连不上"。
			Control = MakeUnique<FSFControlChannel>();
			Control->Initialize(Settings, &Stats);
			Control->SetVideoReady(!Settings.bEnableVideo); // 纯音频模式视为就绪
		Control->OnCommand = [this](const FString& Name, const FString& Payload)
		{
			// 平台内置指令（sf_ 前缀）由插件直接处理，不转发给蓝图
			if (HandlePlatformCommand(Name, Payload))
			{
				return;
			}
			if (UStreamForgeSubsystem* Sub = ModuleManagerHack::GSubsystem)
			{
				Sub->BroadcastCommand(Name, Payload);
			}
		};
			Control->OnControlEvent = [](const FString& EventName, const FString& Data)
			{
				if (UStreamForgeSubsystem* Sub = ModuleManagerHack::GSubsystem)
				{
					Sub->BroadcastControlEvent(EventName, Data);
				}
			};
			Control->OnStopRequest = [this]()
			{
				UE_LOG(LogStreamForge, Warning, TEXT("Server stop request -> exiting process"));
				Stop();
				FPlatformMisc::RequestExit(false);
			};

			if (Settings.bEnableVideo)
			{
				Video = MakeUnique<FSFVideoPipeline>();
				if (!Video->Initialize(Settings, &Stats, Pusher.Get()))
				{
					UE_LOG(LogStreamForge, Error, TEXT("Video pipeline failed to initialize"));
					// 拉起控制通道上报错误（hello 携带 videoReady=false + error），
					// 服务端据此快速回收本实例，而不是等 120s 超时
					Control->SetStartupError(TEXT("video_init_failed"),
						TEXT("encoder init failed (NVENC/AMF not registered?). Check HardwareEncoders plugin, GPU driver, VRAM."));
					if (!Settings.AgentUrl.IsEmpty())
					{
						Control->Start();
					}
					return false;
				}
				Control->SetVideoReady(true);
			}

			Audio = MakeShared<FSFAudioPipeline>();
			if (!Audio->Initialize(Settings, &Stats, Pusher.Get()))
			{
				UE_LOG(LogStreamForge, Warning, TEXT("Audio pipeline failed to initialize, continuing without audio"));
			}

			// resend sequence headers after every RTMP reconnect
			Pusher->OnReconnected = [this]()
			{
				if (Video.IsValid())
				{
					Video->InvalidateTags(); // re-send AVC sequence header with the next frame
					Video->RequestKeyFrame();
				}
				if (Audio.IsValid())
				{
					Audio->InvalidateTags(); // re-send AAC AudioSpecificConfig with the next frame
				}
			};

		if (!Settings.AgentUrl.IsEmpty())
		{
			Control->Start();
		}

		// 顺序要点（MediaMTX track 锁定机制）：
		// publish 后 MediaMTX 按「先到的媒体包」锁定 path 轨道。音频 20ms 一包，
		// 若抢在视频 AVC sequence header 前到达，path 被锁成纯音频轨，后续视频包
		// 会被 "video track is not set up" 踢断 → 重连死循环（2026-10-12 现场）。
		// FFmpeg 后端首帧慢（readback + 外部编码启动 1~3s），因此先开采集，
		// 用游戏线程 Ticker 等首个 AU 入队后再启动 RTMP/音频（5s 兜底强制启动）。
		// 不能在游戏线程阻塞等——Slate present 由游戏线程驱动，阻塞则回调停摆必超时。
		if (Video.IsValid())
		{
			Video->Start();
		}

		if (Video.IsValid() && Video->IsFFmpegBackend())
		{
			DeferredPusherElapsed = 0.0f;
			DeferredPusherHandle = FTSTicker::GetCoreTicker().AddTicker(
				FTickerDelegate::CreateLambda([this](float Dt)
				{
					DeferredPusherElapsed += Dt;
					const bool bReady = Video.IsValid() && Video->HasFirstPacket();
					if (!bReady && DeferredPusherElapsed < 5.0f)
					{
						return true; // 继续等
					}
					if (bReady)
					{
						UE_LOG(LogStreamForge, Log, TEXT("[RTMP] FFmpeg 首帧已就绪，启动推流与音频"));
					}
					else
					{
						UE_LOG(LogStreamForge, Warning, TEXT("[RTMP] 等待首帧超时（5s），强制启动推流与音频"));
					}
					if (Pusher.IsValid())
					{
						Pusher->Start(Settings.RtmpUrl, &Stats);
					}
					if (Audio.IsValid())
					{
						Audio->Start();
					}
					return false; // 一次性
				}), 0.1f);
		}
		else
		{
			Pusher->Start(Settings.RtmpUrl, &Stats);
			Audio->Start();
		}

		// 引擎级限帧：云端推流无需高于推流帧率渲染（-fps 命令行在打包版不可靠，这里显式设置）。
		// 待命(sf_standby)会临时调低，恢复时回到 Settings.Fps。
		if (GEngine && Settings.Fps > 0)
		{
			GEngine->SetMaxFPS(Settings.Fps);
			UE_LOG(LogStreamForge, Log, TEXT("[Agent] engine max fps set to %d"), Settings.Fps);
		}

		bStarted = true;
			UE_LOG(LogStreamForge, Log, TEXT("=== StreamForge started ==="));
			return true;
		}

	void Stop()
	{
		if (!bStarted)
		{
			return;
		}
		bStarted = false;
		UE_LOG(LogStreamForge, Log, TEXT("=== StreamForge stopping ==="));
		// 首包延迟启动的 Ticker 可能还在等：先摘掉，避免 Stop 后触发访问半成品
		if (DeferredPusherHandle.IsValid())
		{
			FTSTicker::GetCoreTicker().RemoveTicker(DeferredPusherHandle);
			DeferredPusherHandle.Reset();
		}
		if (Video.IsValid()) Video->Stop();
			if (Audio.IsValid()) Audio->Stop();
			if (Pusher.IsValid()) Pusher->Stop();
			if (Control.IsValid()) Control->Stop();
			UE_LOG(LogStreamForge, Log, TEXT("=== StreamForge stopped ==="));
		}

		/**
	 * 平台内置指令：
	 * - sf_standby      payload JSON {"fps":5,"bitrateKbps":500}；字段为 0 = 恢复模板满配
	 * - sf_set_bitrate  payload 为纯数字 kbps（自适应降档用）
	 * 返回 true 表示已消费，不再转发给蓝图 OnCommand。
	 */
	bool HandlePlatformCommand(const FString& Name, const FString& Payload)
	{
		if (!Video.IsValid())
		{
			return false;
		}

		if (Name == TEXT("sf_set_bitrate"))
		{
			const int32 Kbps = FCString::Atoi(*Payload);
			if (Kbps > 0)
			{
				Video->SetBitrate(Kbps);
				UE_LOG(LogStreamForge, Log, TEXT("[Agent] sf_set_bitrate: %d kbps"), Kbps);
			}
			return true;
		}

		// 浏览器标签页切回前台时，播放端解码管线需一个 IDR 才能重建（RTMP 入流
		// 单向，RTCP PLI 到不了 UE 编码器）。主动请求 UE 立即插入一个关键帧，
		// 把"切回前台 4~5 秒卡顿"降到 <300ms。RequestKeyFrame 置 bForceKeyFrame，
		// 下一帧编码强制 IDR（见 SFVideoPipeline::OnBackBufferReady）。
		if (Name == TEXT("sf_request_keyframe"))
		{
			Video->RequestKeyFrame();
			UE_LOG(LogStreamForge, Log, TEXT("[Agent] sf_request_keyframe: 已请求 UE 立即插入 IDR（缓解切前台解码重建卡顿）"));
			return true;
		}

		if (Name == TEXT("sf_standby"))
		{
			int32 Fps = -1, Kbps = -1;
			TSharedPtr<FJsonObject> Obj;
			TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Payload);
			if (FJsonSerializer::Deserialize(Reader, Obj) && Obj.IsValid())
			{
				double V;
				if (Obj->TryGetNumberField(TEXT("fps"), V)) Fps = (int32)V;
				if (Obj->TryGetNumberField(TEXT("bitrateKbps"), V)) Kbps = (int32)V;
			}
			if (Fps >= 0)
			{
				Video->SetMaxFps((uint32)Fps); // 0 = 恢复 Settings.Fps（采集节流）
				// 引擎级限帧：待命时渲染循环也降到低帧率，否则引擎仍全速渲染白白吃满 GPU
				if (GEngine)
				{
					GEngine->SetMaxFPS(Fps > 0 ? Fps : Settings.Fps);
				}
			}
			Video->SetBitrate(Kbps > 0 ? Kbps : Settings.BitrateKbps);
			UE_LOG(LogStreamForge, Log, TEXT("[Agent] sf_standby: fps=%d bitrate=%d kbps (engine fps=%d)"),
				Fps >= 0 ? Fps : -1, Kbps > 0 ? Kbps : Settings.BitrateKbps,
				(Fps > 0 ? Fps : Settings.Fps));
			return true;
		}

		return false;
	}

	FSFSettings Settings;
	FSFStats Stats;
	TUniquePtr<FSFVideoPipeline> Video;
	TSharedPtr<FSFAudioPipeline> Audio; // shared: ISubmixBufferListener::AsShared() needs shared ownership
	TUniquePtr<FSFControlChannel> Control;
	TUniquePtr<FSFRtmpPusher> Pusher;
	bool bStarted = false;

	/** FFmpeg 后端首包延迟启动状态（见 Start() 顺序要点注释） */
	float DeferredPusherElapsed = 0.0f;
	FTSTicker::FDelegateHandle DeferredPusherHandle;
};

	FStreamForgeRuntime* GRuntime = nullptr;
}

//////////////////////////////////////////////////////////////////
// Module interface
//////////////////////////////////////////////////////////////////

class FStreamForgeModuleImpl : public IStreamForgeModule
{
public:
	virtual void StartupModule() override
	{
		const FSFSettings Settings = FSFSettings::FromCommandLine();
		if (!Settings.bValid)
		{
			UE_LOG(LogStreamForge, Log, TEXT("StreamForge disabled (no -SFRtmpUrl on command line)"));
			return;
		}

		CachedSettings = Settings;

		// start after the engine (RHI + Slate) is fully up
		if (GEngine && GEngine->IsInitialized() && FSlateApplication::IsInitialized())
		{
			BeginRuntime();
		}
		else
		{
			OnPostEngineInitHandle = FCoreDelegates::OnPostEngineInit.AddRaw(this, &FStreamForgeModuleImpl::BeginRuntime);
		}
	}

	virtual void ShutdownModule() override
	{
		if (OnPostEngineInitHandle.IsValid())
		{
			FCoreDelegates::OnPostEngineInit.Remove(OnPostEngineInitHandle);
		}
		if (RetryTickerHandle.IsValid())
		{
			FTSTicker::GetCoreTicker().RemoveTicker(RetryTickerHandle);
		}
		if (GRuntime)
		{
			GRuntime->Stop();
			delete GRuntime;
			GRuntime = nullptr;
		}
		if (RetiredRuntime)
		{
			RetiredRuntime.Reset();
		}
	}

	virtual bool IsStreaming() const override
	{
		return GRuntime && GRuntime->bStarted;
	}

	virtual bool SendEventToBrowser(const FString& Name, const FString& Data) override
	{
		return GRuntime && GRuntime->Control.IsValid() ? GRuntime->Control->SendEvent(Name, Data) : false;
	}

	virtual void RequestKeyFrame() override
	{
		if (GRuntime && GRuntime->Video.IsValid())
		{
			GRuntime->Video->RequestKeyFrame();
		}
	}

	virtual void SetBitrate(int32 Kbps) override
	{
		if (GRuntime && GRuntime->Video.IsValid())
		{
			GRuntime->Video->SetBitrate(Kbps);
		}
	}

	virtual FString GetStatsJson() const override
	{
		if (!GRuntime)
		{
			return TEXT("{}");
		}
		const FSFStats& S = GRuntime->Stats;
		return FString::Printf(TEXT(
			"{\"fps\":%d,\"encodeMs\":%d,\"videoQueue\":%d,\"audioQueue\":%d,"
			"\"sentBytes\":%lld,\"reconnects\":%d,\"dropped\":%d,"
			"\"rtmpOk\":%s,\"agentOk\":%s}"),
			S.EncodedFps.load(), S.EncodeMs.load(), S.VideoQueueDepth.load(), S.AudioQueueDepth.load(),
			S.SentBytes.load(), S.ReconnectCount.load(), S.DroppedFrames.load(),
			S.bRtmpPublishing.load() ? TEXT("true") : TEXT("false"),
			S.bAgentConnected.load() ? TEXT("true") : TEXT("false"));
	}

private:
	void BeginRuntime()
	{
		if (GRuntime || !CachedSettings.bValid)
		{
			return;
		}
		// 首启也走延迟：打包实例里 EncoderNVENC 要等游戏主循环跑起来才注册，
		// 而 PostEngineInit 时主循环尚未开始——同步 Start 必然失败，然后
		// 走失败路径（历史 bug 高发区：UAF / 重试 Ticker 失效 / 60s 冻结后崩溃）。
		// 交给 Ticker（主循环开始 ~1s 后触发），AVE 首次尝试即成功，绕开整个失败路径。
		ScheduleStartRetry();
	}

	/** 统一的延迟启动调度：Ticker 1s 后触发 TryStartRuntime（主循环驱动，重入安全） */
	void ScheduleStartRetry()
	{
		if (RetryTickerHandle.IsValid())
		{
			return; // 已有未触发的调度
		}
		RetryTickerHandle = FTSTicker::GetCoreTicker().AddTicker(
			FTickerDelegate::CreateLambda([this](float)
			{
				RetryTickerHandle.Reset();
				TryStartRuntime();
				return false; // one-shot
			}), 1.0f);
	}

	void TryStartRuntime()
	{
		// 先销毁上一轮退役的失败 Runtime：它 Stop() 至今已隔 ≥1 个 tick，
		// WS 关闭等晚到回调早已排空，此时 delete 才安全。
		// （失败现场立即 delete = 回调打进已释放内存 → UAF → Ticker 表损坏，
		//  2026-10-12 现场实锤：重试永远不触发 + 60s 冻结后随机崩溃）
		RetiredRuntime.Reset();

		GRuntime = new FStreamForgeRuntime();
		GRuntime->Settings = CachedSettings;
		// 打包实例里 EncoderNVENC 要等游戏主循环启动后才注册（PostEngineInit 时
		// 阻塞等待是鸡生蛋死锁——主循环不跑 → 编码器永不注册）。所以前 3 轮
		// 外层重试禁用 FFmpeg 降级——本轮 AVE 失败就快速返回让出主循环，
		// Ticker 1s 后重试时 NVENC 已就绪一次即成；第 4 轮起（真无硬编码，
		// 如无 AMF 的国产卡）才允许降级软编码。显式 -SFEncoder=ffmpeg 不受影响。
		GRuntime->Settings.bAllowFfmpegFallback =
			(CachedSettings.EncoderBackend == TEXT("ffmpeg")) || (RetryCount >= 3);
		if (GRuntime->Start())
		{
			RetryCount = 0;
			return;
		}

		// 失败：退役而非立即销毁（WS 晚到回调排空前不能 delete），下一轮再清。
		GRuntime->Stop();
		RetiredRuntime.Reset(GRuntime);
		GRuntime = nullptr;

		if (RetryCount < 15)
		{
			RetryCount++;
			UE_LOG(LogStreamForge, Log, TEXT("StreamForge start failed, retry %d/15 in 1s..."), RetryCount);
			ScheduleStartRetry();
		}
		else
		{
			UE_LOG(LogStreamForge, Error, TEXT("StreamForge failed to start after %d retries, giving up"), RetryCount);
			// fail-fast：直接退出进程，调度服务会立即收到 exit 事件并回收/重试，
			// 避免留下一个永远不推流的僵尸 UE 进程白占 GPU 与 NVENC 会话。
			// 需要在失败现场调试时可加 -SFExitOnFailure=0 关闭。
			if (CachedSettings.bExitOnFailure)
			{
				UE_LOG(LogStreamForge, Warning, TEXT("SFExitOnFailure enabled -> exiting for fast recycle"));
				FPlatformMisc::RequestExit(false);
			}
		}
	}

	FSFSettings CachedSettings;
	FDelegateHandle OnPostEngineInitHandle;
	FTSTicker::FDelegateHandle RetryTickerHandle;
	/** 上一轮启动失败的 Runtime（退役中，等 WS 晚到回调排空后于下轮销毁） */
	TUniquePtr<FStreamForgeRuntime> RetiredRuntime;
	int32 RetryCount = 0;
};

IMPLEMENT_MODULE(FStreamForgeModuleImpl, StreamForge)
