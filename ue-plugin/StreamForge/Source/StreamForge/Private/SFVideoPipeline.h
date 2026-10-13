// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "StreamForgeTypes.h"
#include "SFMediaFormat.h"
#include "SFFmpegEncoder.h"
#include "RHIGPUReadback.h"
#include "Containers/Queue.h"

PRAGMA_DISABLE_DEPRECATION_WARNINGS
#include "VideoEncoder.h"
#include "VideoEncoderInput.h"
PRAGMA_ENABLE_DEPRECATION_WARNINGS

class FSFRtmpPusher;

/**
 * Captures the final backbuffer each frame, encodes it to H264 and pushes
 * FLV video tags into the RTMP pusher.
 *
 * 编码后端（Settings.EncoderBackend，-SFEncoder=）：
 *   - EBackend::AVE    引擎硬件编码（NVENC/AMF via AVEncoder）——NVIDIA/AMD 主路径，行为与旧版完全一致
 *   - EBackend::FFmpeg 外部 ffmpeg 进程（GPU readback → BGRA 裸帧 → H264 Annex-B）：
 *                      默认 libx264 软编码兜底；-SFFFmpegArgs= 可换国产卡 VAAPI/DXVA 硬编码
 *   auto 模式先 AVE 后 FFmpeg；ave 严格只 AVE；ffmpeg 严格只 FFmpeg。
 */
class FSFVideoPipeline : public TSharedFromThis<FSFVideoPipeline>
{
public:
	FSFVideoPipeline();
	~FSFVideoPipeline();

	bool Initialize(const FSFSettings& InSettings, FSFStats* InStats, FSFRtmpPusher* InPusher);
	void Start();
	void Stop();

	void RequestKeyFrame() { bForceKeyFrame = true; }
	/** Drop sequence-header state; the next frame re-sends the AVC config (after RTMP reconnect). */
	void InvalidateTags() { TagBuilder.Invalidate(); }
	void SetBitrate(int32 Kbps) { PendingBitrateKbps = Kbps; }
	/** 运行期帧率上限（待命降载用）；0 = 恢复 Settings.Fps 满配 */
	void SetMaxFps(uint32 Fps) { OverrideFps = Fps; }

	bool IsEncoderReady() const
	{
		return VideoEncoder.IsValid() || (FFmpegEnc.IsValid() && FFmpegEnc->IsRunning());
	}

	/**
	 * FFmpeg 后端专用：首个编码 AU 是否已产出（tag 已入 RTMP 队列）。
	 * 背景：MediaMTX 在 publish 后按先到的媒体包锁定 path 轨道；音频包（20ms 一包）
	 * 若抢在视频 AVC sequence header 之前到达，path 被锁成纯音频轨，后续视频包
	 * 会被以 "video track is not set up" 踢断，陷入重连死循环。
	 * Module 在游戏线程轮询此标志，首包就绪后再启动 RTMP 与音频。
	 */
	bool HasFirstPacket() const { return bFirstPacketSignaled.load(); }

	/** 当前是否为 FFmpeg 外部编码后端（决定是否启用首包延迟启动） */
	bool IsFFmpegBackend() const { return ActiveBackend == EBackend::FFmpeg; }

	/** 当前生效的编码后端名（日志/诊断用） */
	FString ActiveBackendName() const
	{
		return ActiveBackend == EBackend::AVE ? TEXT("ave")
			: ActiveBackend == EBackend::FFmpeg ? TEXT("ffmpeg") : TEXT("none");
	}

private:
	enum class EBackend { None, AVE, FFmpeg };

	void OnBackBufferReady(SWindow& SlateWindow, const FTextureRHIRef& FrameBuffer);

	/** AVEncoder（引擎硬件编码 NVENC/AMF）初始化——旧 Initialize 主体，行为不变 */
	bool InitAveEncoder();
	/** 外部 FFmpeg 编码进程初始化 */
	bool InitFfmpegEncoder();

	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	TSharedPtr<AVEncoder::FVideoEncoderInputFrame> ObtainInputFrame();
	PRAGMA_ENABLE_DEPRECATION_WARNINGS

	void CopyTexture(const FTextureRHIRef& SourceTexture, FTextureRHIRef& DestinationTexture) const;
	void OnEncodedPacket(uint32 LayerIndex, const TSharedPtr<AVEncoder::FVideoEncoderInputFrame> Frame, const AVEncoder::FCodecPacket& Packet);

	/** FFmpeg 后端：把背缓冲经 staging 纹理 + GPU readback 双槽送回 CPU 喂给 ffmpeg */
	void CaptureFrameForFfmpeg(const FTextureRHIRef& FrameBuffer, double Now);
	void ResolveReadbackSlot(int32 Slot);
	/** FFmpeg 读流线程回调：一个完整 AU（Annex-B，不含 AUD） */
	void OnFfmpegPacket(const uint8* Data, uint32 Size, bool bKeyFrame);

	FSFSettings Settings;
	FSFStats* Stats = nullptr;
	FSFRtmpPusher* Pusher = nullptr;
	EBackend ActiveBackend = EBackend::None;

	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	TSharedPtr<AVEncoder::FVideoEncoderInput> VideoEncoderInput;
	TUniquePtr<AVEncoder::FVideoEncoder> VideoEncoder;
	TMap<TSharedPtr<AVEncoder::FVideoEncoderInputFrame>, FTextureRHIRef> BackBuffers;
	PRAGMA_ENABLE_DEPRECATION_WARNINGS

	// ---- FFmpeg 后端状态 ----
	TUniquePtr<FSFFmpegEncoder> FFmpegEnc;
	FTextureRHIRef ReadbackStaging;                    // 流尺寸 BGRA staging 纹理
	TUniquePtr<FRHIGPUTextureReadback> Readbacks[2];   // 双槽 readback（N 帧入队，N-1 帧回收）
	int32 ReadbackSlot = 0;
	uint64 FfFramesEnqueued = 0;
	TArray<uint8> FfCpuBuf;                            // 去行距后的连续 BGRA 帧
	TQueue<int64, EQueueMode::Spsc> FfTsQueue;         // 采集时间戳 FIFO（游戏线程→读流线程）

	SFMediaFormat::FVideoTagBuilder TagBuilder;

	FCriticalSection EncodeCS;
	double StartTime = 0.0;
	double LastCaptureTime = -1.0;
	uint64 NumCapturedFrames = 0;
	uint64 NumEncodedFrames = 0;
	uint64 LastStatsFrameCount = 0;
	double LastStatsTime = 0.0;

	std::atomic<bool> bForceKeyFrame{ false };
	std::atomic<int32> PendingBitrateKbps{ 0 };
	std::atomic<uint32> OverrideFps{ 0 };
	bool bRunning = false;
	bool bEncodeInFlight = false;

	/** 首个视频 AU 已产出标志（FFmpeg 后端首包延迟启动用，读流线程置位） */
	std::atomic<bool> bFirstPacketSignaled{ false };
};
