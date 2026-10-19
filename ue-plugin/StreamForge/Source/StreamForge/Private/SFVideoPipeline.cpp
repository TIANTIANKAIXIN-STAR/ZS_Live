// Copyright ZS Live Platform. All Rights Reserved.

#include "SFVideoPipeline.h"
#include "SFRtmpPusher.h"
#include "SFLog.h"

#include "Engine/GameEngine.h"
#include "Framework/Application/SlateApplication.h"
#include "Modules/ModuleManager.h"
#include "RendererInterface.h"
#include "RHI.h"
#include "RHIStaticStates.h"
#include "ScreenRendering.h"
#include "ShaderCore.h"
#include "PipelineStateCache.h"
#include "ClearQuad.h"
#include "CommonRenderResources.h"
#include "RenderingThread.h"
#include "Runtime/Launch/Resources/Version.h"   // ENGINE_MAJOR_VERSION / ENGINE_MINOR_VERSION

#include "VideoEncoderFactory.h"
#include "VideoEncoderInput.h"

#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 4)
	#define SF_AVENCODER_DEPRECATED 1
#else
	#define SF_AVENCODER_DEPRECATED 0
#endif

#if SF_AVENCODER_DEPRECATED
	#define SF_AV_ENC(x) PRAGMA_DISABLE_DEPRECATION_WARNINGS x PRAGMA_ENABLE_DEPRECATION_WARNINGS
#else
	#define SF_AV_ENC(x) x
#endif

// includes for engine version differences
#include "Runtime/Launch/Resources/Version.h"

PRAGMA_DISABLE_DEPRECATION_WARNINGS
/**
 * Create the AVEncoder input for the current RHI.
 * D3D11/D3D12 branches are Windows-only; Linux uses Vulkan exclusively.
 */
static TSharedPtr<AVEncoder::FVideoEncoderInput> CreateEncoderInputForRHI()
{
	const ERHIInterfaceType RHIType = RHIGetInterfaceType();
#if PLATFORM_WINDOWS
	if (RHIType == ERHIInterfaceType::D3D11)
	{
		return AVEncoder::FVideoEncoderInput::CreateForD3D11(GDynamicRHI->RHIGetNativeDevice(), true, IsRHIDeviceAMD());
	}
	if (RHIType == ERHIInterfaceType::D3D12)
	{
		return AVEncoder::FVideoEncoderInput::CreateForD3D12(GDynamicRHI->RHIGetNativeDevice(), true, IsRHIDeviceNVIDIA());
	}
#endif
	if (RHIType == ERHIInterfaceType::Vulkan)
	{
		return AVEncoder::FVideoEncoderInput::CreateForVulkan(GDynamicRHI->RHIGetNativeDevice(), true);
	}
	return nullptr;
}
PRAGMA_ENABLE_DEPRECATION_WARNINGS

FSFVideoPipeline::FSFVideoPipeline() = default;
FSFVideoPipeline::~FSFVideoPipeline()
{
	Stop();
}

bool FSFVideoPipeline::Initialize(const FSFSettings& InSettings, FSFStats* InStats, FSFRtmpPusher* InPusher)
{
	Settings = InSettings;
	Stats = InStats;
	Pusher = InPusher;

	if (!GDynamicRHI)
	{
		UE_LOG(LogStreamForge, Error, TEXT("[Video] No dynamic RHI available"));
		return false;
	}

	// 后端选择：auto = AVE 优先失败降级 FFmpeg；ave = 仅 AVE；ffmpeg = 仅 FFmpeg
	// bAllowFfmpegFallback 由模块外层重试控制（见 StreamForgeTypes.h 注释）：
	// 前几轮禁用降级 → 本函数失败快速返回 → 游戏主循环启动 → EncoderNVENC
	// 注册（实测 2026-10-12 J002：主循环启动后 ~100ms 就绪）→ Ticker 重试即成。
	const bool bWantAve = Settings.EncoderBackend != TEXT("ffmpeg");
	const bool bWantFfmpeg = Settings.EncoderBackend != TEXT("ave") && Settings.bAllowFfmpegFallback;

	bool bAveOk = false;
	if (bWantAve)
	{
		// 注意：这里不能长时间阻塞等待——PostEngineInit 时游戏主循环还没跑，
		// 编码器注册靠主循环驱动，Sleep 等待 = 鸡生蛋死锁（旧版就是这么把
		// 健康的 4090 误判成 NVENC 不可用、全量拖去 x264 的）。短重试 3 次
		// 只为吸收已运行期的偶发空枚举（09-29 现场连续 15 次后恢复）。
		const int32 MaxAveAttempts = bWantFfmpeg ? 3 : 1; // ave 严格模式由外层 Module 重试
		for (int32 Attempt = 1; Attempt <= MaxAveAttempts && !bAveOk; ++Attempt)
		{
			if (Attempt > 1)
			{
				UE_LOG(LogStreamForge, Warning, TEXT("[Video] AVE 编码器重试 %d/%d..."), Attempt, MaxAveAttempts);
				FPlatformProcess::Sleep(1.0f);
				VideoEncoder.Reset();
				VideoEncoderInput.Reset();
			}
			bAveOk = InitAveEncoder();
		}
		if (!bAveOk)
		{
			UE_LOG(LogStreamForge, Warning, TEXT("[Video] 引擎硬件编码（NVENC/AMF）不可用%s"),
				bWantFfmpeg ? TEXT("，自动降级 FFmpeg 后端") : TEXT("（-SFEncoder=ave 严格模式，不降级）"));
		}
	}
	if (bAveOk)
	{
		ActiveBackend = EBackend::AVE;
	}
	else if (bWantFfmpeg && InitFfmpegEncoder())
	{
		ActiveBackend = EBackend::FFmpeg;
	}

	if (ActiveBackend == EBackend::None)
	{
		UE_LOG(LogStreamForge, Error, TEXT("[Video] 所有编码后端均不可用（AVE=%d, FFmpeg=%d）"),
			bAveOk ? 1 : 0, ActiveBackend == EBackend::FFmpeg ? 1 : 0);
		return false;
	}

	UE_LOG(LogStreamForge, Log, TEXT("[Video] 编码后端: %s"), *ActiveBackendName());
	return true;
}

bool FSFVideoPipeline::InitAveEncoder()
{
	const ERHIInterfaceType RHIType = RHIGetInterfaceType();

	VideoEncoderInput = CreateEncoderInputForRHI();
	if (!VideoEncoderInput.IsValid() && RHIType != ERHIInterfaceType::Vulkan && RHIType != ERHIInterfaceType::D3D11 && RHIType != ERHIInterfaceType::D3D12)
	{
		UE_LOG(LogStreamForge, Error, TEXT("[Video] Unsupported RHI for hardware encoding"));
		return false;
	}

	if (!VideoEncoderInput.IsValid())
	{
		UE_LOG(LogStreamForge, Error, TEXT("[Video] Failed to create encoder input"));
		return false;
	}

	SF_AV_ENC(
		const TArray<AVEncoder::FVideoEncoderInfo>& Encoders = AVEncoder::FVideoEncoderFactory::Get().GetAvailable();
		if (Encoders.Num() == 0)
		{
			UE_LOG(LogStreamForge, Error, TEXT("[Video] No encoders registered. Enable the 'HardwareEncoders' plugin (EncoderNVENC/EncoderAMF)."));
			return false;
		}

		AVEncoder::FVideoEncoder::FLayerConfig LayerConfig;
		LayerConfig.Width = Settings.Width;
		LayerConfig.Height = Settings.Height;
		LayerConfig.MaxFramerate = Settings.Fps;
		LayerConfig.TargetBitrate = Settings.BitrateKbps * 1000;
		LayerConfig.MaxBitrate = Settings.MaxBitrateKbps * 1000;
		LayerConfig.RateControlMode = AVEncoder::FVideoEncoder::RateControlMode::CBR;
		LayerConfig.MultipassMode = AVEncoder::FVideoEncoder::MultipassMode::DISABLED;
		LayerConfig.FillData = true;
		LayerConfig.H264Profile = AVEncoder::FVideoEncoder::H264Profile::CONSTRAINED_BASELINE;
		LayerConfig.QPMin = 10;
		LayerConfig.QPMax = 51;

		bool bPicked = false;
		for (const AVEncoder::FVideoEncoderInfo& Info : Encoders)
		{
			if (Info.CodecType == AVEncoder::ECodecType::H264)
			{
				UE_LOG(LogStreamForge, Log, TEXT("[Video] Using H264 encoder id=%u"), Info.ID);
				VideoEncoder = AVEncoder::FVideoEncoderFactory::Get().Create(Info.ID, VideoEncoderInput, LayerConfig);
				bPicked = true;
				break;
			}
		}
		if (!bPicked)
		{
			UE_LOG(LogStreamForge, Error, TEXT("[Video] No H264 encoder found"));
			return false;
		}
	);

	if (!VideoEncoder.IsValid())
	{
		UE_LOG(LogStreamForge, Error, TEXT("[Video] Encoder creation failed"));
		return false;
	}

	VideoEncoder->SetOnEncodedPacket([this](uint32 LayerIndex, const TSharedPtr<AVEncoder::FVideoEncoderInputFrame> Frame, const AVEncoder::FCodecPacket& Packet)
	{
		OnEncodedPacket(LayerIndex, Frame, Packet);
	});

	UE_LOG(LogStreamForge, Log, TEXT("[Video] Encoder ready: %ux%u@%u, %d kbps"), Settings.Width, Settings.Height, Settings.Fps, Settings.BitrateKbps);
	return true;
}

bool FSFVideoPipeline::InitFfmpegEncoder()
{
	FFmpegEnc = MakeUnique<FSFFmpegEncoder>();
	if (!FFmpegEnc->Start(Settings, [this](const uint8* Data, uint32 Size, bool bKeyFrame)
	{
		OnFfmpegPacket(Data, Size, bKeyFrame);
	}))
	{
		FFmpegEnc.Reset();
		return false;
	}
	UE_LOG(LogStreamForge, Log, TEXT("[Video] FFmpeg encoder ready: %ux%u@%u, %d kbps（GPU readback → 外部编码）"),
		Settings.Width, Settings.Height, Settings.Fps, Settings.BitrateKbps);
	return true;
}

void FSFVideoPipeline::Start()
{
	if (bRunning)
	{
		return;
	}
	bRunning = true;
	StartTime = FPlatformTime::Seconds();
	NumCapturedFrames = 0;
	bFirstPacketSignaled = false;

	FSlateApplication::Get().GetRenderer()->OnBackBufferReadyToPresent().AddRaw(this, &FSFVideoPipeline::OnBackBufferReady);
	UE_LOG(LogStreamForge, Log, TEXT("[Video] Backbuffer capture started"));
}

void FSFVideoPipeline::Stop()
{
	if (!bRunning)
	{
		return;
	}
	bRunning = false;

	if (FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().GetRenderer()->OnBackBufferReadyToPresent().RemoveAll(this);
	}

	FScopeLock Lock(&EncodeCS);
	BackBuffers.Empty();
	SF_AV_ENC(
		if (VideoEncoder)
		{
			VideoEncoder->Shutdown();
			VideoEncoder.Reset();
		}
	);

	// FFmpeg 后端：先停编码进程（读流线程随之 join），再释放 readback 资源
	if (FFmpegEnc.IsValid())
	{
		FFmpegEnc->Stop();
		FFmpegEnc.Reset();
	}
	Readbacks[0].Reset();
	Readbacks[1].Reset();
	ReadbackStaging.SafeRelease();
	FfCpuBuf.Reset();
	FfTsQueue.Empty();
	FfFramesEnqueued = 0;
	ReadbackSlot = 0;
	ActiveBackend = EBackend::None;
	bFirstPacketSignaled = false;
}

void FSFVideoPipeline::OnBackBufferReady(SWindow& SlateWindow, const FTextureRHIRef& FrameBuffer)
{
	if (!bRunning || ActiveBackend == EBackend::None)
	{
		return;
	}

	FScopeLock Lock(&EncodeCS);

	const double Now = FPlatformTime::Seconds() - StartTime;

	// 有效帧率：待命降载时用运行期上限，否则用模板满配
	const uint32 EffectiveFps = OverrideFps > 0 ? OverrideFps.load() : Settings.Fps;

	// fps cap：按距上一帧的间隔节流（而非累计帧数——帧率运行期切换时累计值会卡死）
	const double MinInterval = 1.0 / (double)EffectiveFps;
	if (Now - LastCaptureTime < MinInterval * 0.95)
	{
		return;
	}
	LastCaptureTime = Now;

	// runtime bitrate update
	if (PendingBitrateKbps > 0)
	{
		if (ActiveBackend == EBackend::AVE)
		{
			SF_AV_ENC(
				auto Config = VideoEncoder->GetLayerConfig(0);
				Config.TargetBitrate = PendingBitrateKbps * 1000;
				Config.MaxBitrate = FMath::Max<int32>(PendingBitrateKbps * 120 / 100, Config.TargetBitrate);
				VideoEncoder->UpdateLayerConfig(0, Config);
			);
		}
		else
		{
			// FFmpeg 管道无法运行期改码率（重启编码进程代价太大），仅记录一次日志
			static bool bLoggedFfBitrate = false;
			if (!bLoggedFfBitrate)
			{
				bLoggedFfBitrate = true;
				UE_LOG(LogStreamForge, Warning, TEXT("[Video] FFmpeg 后端不支持运行期码率调整，已忽略（%d kbps）"), PendingBitrateKbps.load());
			}
		}
		PendingBitrateKbps = 0;
	}

	if (ActiveBackend == EBackend::FFmpeg)
	{
		CaptureFrameForFfmpeg(FrameBuffer, Now);
		NumCapturedFrames++;
		return;
	}

	SF_AV_ENC(
		TSharedPtr<AVEncoder::FVideoEncoderInputFrame> InputFrame = ObtainInputFrame();
		// 时间戳用墙钟而非帧序号：待命降载/恢复切换帧率时仍单调且速率正确
		InputFrame->SetTimestampUs((int64)(Now * 1000000.0));

		CopyTexture(FrameBuffer, BackBuffers[InputFrame]);

		AVEncoder::FVideoEncoder::FEncodeOptions Options;
		// Force periodic IDR: legacy HW encoder tuning (NVENC P4+ULTRA_LOW_LATENCY,
		// AMF equivalent) runs an INFINITE GOP and never emits IDR frames on its
		// own - mid-stream joiners (WebRTC / fMP4 recorder / RTMP readers) would
		// wait forever for a keyframe. Forced-IDR is also reliable across
		// engine versions, unlike gopLength/idrPeriod config knobs.
		Options.bForceKeyFrame = bForceKeyFrame.exchange(false);
		const uint64 KeyframeIntervalFrames = (uint64)FMath::Max<int64>(
			(int64)Settings.KeyframeIntervalSec * (int64)EffectiveFps, 1);
		if (NumCapturedFrames % KeyframeIntervalFrames == 0)
		{
			Options.bForceKeyFrame = true; // frame 0 included: stream always starts with IDR
		}
		VideoEncoder->Encode(InputFrame, Options);
	);

	NumCapturedFrames++;
}

// ---------------- FFmpeg 后端：GPU readback 采集 ----------------

void FSFVideoPipeline::CaptureFrameForFfmpeg(const FTextureRHIRef& FrameBuffer, double Now)
{
	// 懒建 staging 纹理与 readback 双槽
	if (!ReadbackStaging.IsValid())
	{
		const FRHITextureCreateDesc Desc =
			FRHITextureCreateDesc::Create2D(TEXT("SFReadbackStaging"), Settings.Width, Settings.Height, PF_B8G8R8A8)
			.SetFlags(ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::ShaderResource)
			.SetInitialState(ERHIAccess::CopyDest);
		ReadbackStaging = RHICreateTexture(Desc);
		Readbacks[0] = MakeUnique<FRHIGPUTextureReadback>(TEXT("SFReadback0"));
		Readbacks[1] = MakeUnique<FRHIGPUTextureReadback>(TEXT("SFReadback1"));
	}

	CopyTexture(FrameBuffer, ReadbackStaging);

	const int32 Slot = ReadbackSlot;

	// 先回收上一帧（另一个槽）。正常情况 GPU 已拷完，Lock 立即返回；
	// GPU 滞后一整帧时才会短暂阻塞（兜底路径可接受）。
	if (FfFramesEnqueued > 0)
	{
		ResolveReadbackSlot(1 - Slot);
	}

	// 本帧时间戳入 FIFO（与输出 AU 一一对应：zerolatency 无重排）
	FfTsQueue.Enqueue((int64)(Now * 1000000.0));

	FTextureRHIRef Staging = ReadbackStaging;
	FRHIGPUTextureReadback* Rb = Readbacks[Slot].Get();
	ENQUEUE_RENDER_COMMAND(SFEnqueueReadback)(
		[Staging, Rb](FRHICommandListImmediate& RHICmdList)
		{
			Rb->EnqueueCopy(RHICmdList, Staging);
		});

	ReadbackSlot = 1 - Slot;
	FfFramesEnqueued++;
}

void FSFVideoPipeline::ResolveReadbackSlot(int32 Slot)
{
	FRHIGPUTextureReadback* Rb = Readbacks[Slot].Get();
	if (!Rb || !FFmpegEnc.IsValid())
	{
		return;
	}
	if (!Rb->IsReady())
	{
		static uint32 StallLogCount = 0;
		if (StallLogCount++ < 5)
		{
			UE_LOG(LogStreamForge, Warning, TEXT("[Video] GPU readback 滞后，Lock 将短暂阻塞游戏线程（slot=%d）"), Slot);
		}
	}

	int32 RowPitchPx = 0;
	int32 BufH = 0;
	void* Data = Rb->Lock(RowPitchPx, &BufH);
	if (!Data)
	{
		return;
	}

	const int32 W = (int32)Settings.Width;
	const int32 H = (int32)Settings.Height;
	const int32 RowBytes = W * 4; // BGRA
	const int32 CopyH = BufH > 0 ? FMath::Min(H, BufH) : H;
	const int32 SrcPitchBytes = RowPitchPx > 0 ? RowPitchPx * 4 : RowBytes;

	FfCpuBuf.SetNumUninitialized(RowBytes * CopyH);
	const uint8* Src = (const uint8*)Data;
	for (int32 Y = 0; Y < CopyH; ++Y)
	{
		FMemory::Memcpy(FfCpuBuf.GetData() + Y * RowBytes, Src + Y * SrcPitchBytes, RowBytes);
	}
	Rb->Unlock();

	FFmpegEnc->WriteFrame(FfCpuBuf.GetData(), FfCpuBuf.Num());
}

void FSFVideoPipeline::OnFfmpegPacket(const uint8* Data, uint32 Size, bool bKeyFrame)
{
	if (!Data || Size == 0 || !Pusher)
	{
		return;
	}

	int64 TsUs = -1;
	FfTsQueue.Dequeue(TsUs); // 与采集帧一一对应；空队列时用帧序号兜底
	const uint32 TsMs = TsUs >= 0
		? (uint32)(TsUs / 1000)
		: (uint32)(NumEncodedFrames * 1000 / Settings.Fps);

	TArray<uint8> SeqTag;
	TArray<uint8> FrameTag;
	TagBuilder.Build(Data, Size, bKeyFrame, SeqTag, FrameTag);

	if (SeqTag.Num() > 0)
	{
		Pusher->EnqueueVideo(MoveTemp(SeqTag), TsMs, true);
	}
	if (FrameTag.Num() > 0)
	{
		Pusher->EnqueueVideo(MoveTemp(FrameTag), TsMs, bKeyFrame);
	}

	// 首包标志：Module 的游戏线程 Ticker 轮询此标志，就绪后才启动 RTMP/音频
	//（tag 已入队，保证 publish 后视频 seq header 先于音频包到达 MediaMTX）
	if (!bFirstPacketSignaled.exchange(true))
	{
		UE_LOG(LogStreamForge, Log, TEXT("[Video] FFmpeg 首个 AU 已产出并入队"));
	}

	NumEncodedFrames++;

	const double NowSec = FPlatformTime::Seconds();
	if (NowSec - LastStatsTime >= 1.0 && Stats)
	{
		Stats->EncodedFps = (int32)(NumEncodedFrames - LastStatsFrameCount);
		Stats->EncodeMs = 0; // 外部进程编码，单帧耗时不可测
		LastStatsFrameCount = NumEncodedFrames;
		LastStatsTime = NowSec;
	}
}

// ---------------- AVEncoder 后端（原逻辑，未改动） ----------------

PRAGMA_DISABLE_DEPRECATION_WARNINGS
TSharedPtr<AVEncoder::FVideoEncoderInputFrame> FSFVideoPipeline::ObtainInputFrame()
{
	TSharedPtr<AVEncoder::FVideoEncoderInputFrame> InputFrame = VideoEncoderInput->ObtainInputFrame();
	InputFrame->SetWidth(Settings.Width);
	InputFrame->SetHeight(Settings.Height);

	if (!BackBuffers.Contains(InputFrame))
	{
		const ERHIInterfaceType RHIType = RHIGetInterfaceType();

		const FRHITextureCreateDesc Desc =
			FRHITextureCreateDesc::Create2D(TEXT("SFVideoBackBuffer"), Settings.Width, Settings.Height, PF_B8G8R8A8)
			.SetFlags(ETextureCreateFlags::Shared | ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::UAV)
			.SetInitialState(ERHIAccess::CopyDest);

		FTextureRHIRef Texture = RHICreateTexture(Desc);

#if PLATFORM_WINDOWS
		if (RHIType == ERHIInterfaceType::D3D11)
		{
			InputFrame->SetTexture((ID3D11Texture2D*)Texture->GetNativeResource(),
				[this, InputFrame](ID3D11Texture2D*)
				{
					BackBuffers.Remove(InputFrame);
				});
			BackBuffers.Add(InputFrame, Texture);
		}
		else if (RHIType == ERHIInterfaceType::D3D12)
		{
			InputFrame->SetTexture((ID3D12Resource*)Texture->GetNativeResource(),
				[this, InputFrame](ID3D12Resource*)
				{
					BackBuffers.Remove(InputFrame);
				});
			BackBuffers.Add(InputFrame, Texture);
		}
		else if (RHIType == ERHIInterfaceType::Vulkan)
#else
		if (RHIType == ERHIInterfaceType::Vulkan)
#endif
		{
			InputFrame->SetTexture((VkImage)Texture->GetNativeResource(),
				[this, InputFrame](VkImage)
				{
					BackBuffers.Remove(InputFrame);
				});
			BackBuffers.Add(InputFrame, Texture);
		}
		else
		{
			// Unsupported: no back buffer possible
		}
	}

	return InputFrame;
}
PRAGMA_ENABLE_DEPRECATION_WARNINGS

void FSFVideoPipeline::OnEncodedPacket(uint32 LayerIndex, const TSharedPtr<AVEncoder::FVideoEncoderInputFrame> Frame, const AVEncoder::FCodecPacket& Packet)
{
	if (!Packet.Data || Packet.DataSize == 0 || !Pusher)
	{
		PRAGMA_DISABLE_DEPRECATION_WARNINGS
		if (Frame) Frame->Release();
		PRAGMA_ENABLE_DEPRECATION_WARNINGS
		return;
	}

	TArray<uint8> SeqTag;
	TArray<uint8> FrameTag;
	TagBuilder.Build(Packet.Data.Get(), Packet.DataSize, Packet.IsKeyFrame, SeqTag, FrameTag);

	const uint32 TsMs = (uint32)(Frame ? Frame->GetTimestampUs() / 1000 : NumEncodedFrames * 1000 / Settings.Fps);

	// sequence header & frames share the same timestamp clock; sent as separate RTMP messages
	if (SeqTag.Num() > 0)
	{
		Pusher->EnqueueVideo(MoveTemp(SeqTag), TsMs, true);
	}
	if (FrameTag.Num() > 0)
	{
		Pusher->EnqueueVideo(MoveTemp(FrameTag), TsMs, Packet.IsKeyFrame);
	}

	NumEncodedFrames++;

	// fps / latency stats
	const double Now = FPlatformTime::Seconds();
	if (Now - LastStatsTime >= 1.0 && Stats)
	{
		Stats->EncodedFps = (int32)(NumEncodedFrames - LastStatsFrameCount);
		Stats->EncodeMs = (int32)((Packet.Timings.FinishTs - Packet.Timings.StartTs).GetTotalMilliseconds());
		LastStatsFrameCount = NumEncodedFrames;
		LastStatsTime = Now;
	}

	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	if (Frame) Frame->Release();
	PRAGMA_ENABLE_DEPRECATION_WARNINGS
}

void FSFVideoPipeline::CopyTexture(const FTextureRHIRef& SourceTexture, FTextureRHIRef& DestinationTexture) const
{
	FRHICommandListImmediate& RHICmdList = FRHICommandListImmediate::Get();

	if (SourceTexture->GetFormat() == DestinationTexture->GetFormat() && SourceTexture->GetSizeXY() == DestinationTexture->GetSizeXY())
	{
		TransitionAndCopyTexture(RHICmdList, SourceTexture, DestinationTexture, {});
	}
	else
	{
		// stretch copy (window size differs from stream size) — upscaling looks soft
		// 注意：仅像素格式不同（尺寸相同）也会进此分支，属正常转换，不要误报警告
		static bool bLoggedMismatch = false;
		if (!bLoggedMismatch && SourceTexture->GetSizeXY() != DestinationTexture->GetSizeXY())
		{
			bLoggedMismatch = true;
			UE_LOG(LogStreamForge, Warning,
				TEXT("[Video] Backbuffer %dx%d != encode %dx%d — image will look soft. "
				     "Ensure -ForceRes -ResX/-ResY match SFWidth/SFHeight, and GameUserSettings "
				     "is not locking a lower resolution (sg.ResolutionQuality should be 100)."),
				SourceTexture->GetSizeX(), SourceTexture->GetSizeY(),
				DestinationTexture->GetSizeX(), DestinationTexture->GetSizeY());
		}
		IRendererModule* RendererModule = &FModuleManager::GetModuleChecked<IRendererModule>("Renderer");

		FRHIRenderPassInfo RPInfo(DestinationTexture, ERenderTargetActions::Load_Store);
		RHICmdList.Transition(FRHITransitionInfo(DestinationTexture, ERHIAccess::Unknown, ERHIAccess::RTV));
		RHICmdList.BeginRenderPass(RPInfo, TEXT("SFStretchCopy"));

		RHICmdList.SetViewport(0, 0, 0.0f, (float)DestinationTexture->GetSizeX(), (float)DestinationTexture->GetSizeY(), 1.0f);

		FGraphicsPipelineStateInitializer GraphicsPSOInit;
		RHICmdList.ApplyCachedRenderTargets(GraphicsPSOInit);
		GraphicsPSOInit.BlendState = TStaticBlendState<>::GetRHI();
		GraphicsPSOInit.RasterizerState = TStaticRasterizerState<>::GetRHI();
		GraphicsPSOInit.DepthStencilState = TStaticDepthStencilState<false, CF_Always>::GetRHI();

		FGlobalShaderMap* ShaderMap = GetGlobalShaderMap(GMaxRHIFeatureLevel);
		TShaderMapRef<FScreenVS> VertexShader(ShaderMap);
		TShaderMapRef<FScreenPS> PixelShader(ShaderMap);

		GraphicsPSOInit.BoundShaderState.VertexDeclarationRHI = GFilterVertexDeclaration.VertexDeclarationRHI;
		GraphicsPSOInit.BoundShaderState.VertexShaderRHI = VertexShader.GetVertexShader();
		GraphicsPSOInit.BoundShaderState.PixelShaderRHI = PixelShader.GetPixelShader();
		GraphicsPSOInit.PrimitiveType = PT_TriangleList;

		SetGraphicsPipelineState(RHICmdList, GraphicsPSOInit, 0);

		const bool bSameSize = (DestinationTexture->GetDesc().Extent == SourceTexture->GetDesc().Extent);
		FRHISamplerState* PixelSampler = bSameSize ? TStaticSamplerState<SF_Point>::GetRHI() : TStaticSamplerState<SF_Bilinear>::GetRHI();
		SetShaderParametersLegacyPS(RHICmdList, PixelShader, PixelSampler, SourceTexture);

		RendererModule->DrawRectangle(
			RHICmdList,
			0, 0,
			(float)DestinationTexture->GetSizeX(), (float)DestinationTexture->GetSizeY(),
			0, 0,
			1, 1,
			DestinationTexture->GetSizeXY(),
			FIntPoint(1, 1),
			VertexShader, EDRF_Default);

		RHICmdList.EndRenderPass();
		RHICmdList.Transition(FRHITransitionInfo(DestinationTexture, ERHIAccess::RTV, ERHIAccess::SRVMask));
	}
}
