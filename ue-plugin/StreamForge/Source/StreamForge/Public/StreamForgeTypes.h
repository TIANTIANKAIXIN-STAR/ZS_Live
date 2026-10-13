// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include <atomic>

/** StreamForge runtime settings, normally supplied by the scheduler via command line. */
struct STREAMFORGE_API FSFSettings
{
	FString InstanceId;      // -SFInstanceId=
	FString RtmpUrl;         // -SFRtmpUrl=rtmp://host:1935/zslive/<instanceId>
	FString AgentUrl;        // -SFAgentUrl=ws://host:3000/agent
	FString AgentToken;      // -SFAgentToken=

	uint32 Width = 1280;     // -SFWidth=
	uint32 Height = 720;     // -SFHeight=
	uint32 Fps = 30;         // -SFFps=
	int32  BitrateKbps = 8000;   // -SFBitrate= (kbps)
	int32  MaxBitrateKbps = 12000; // -SFMaxBitrate=

	// UE's HW encoders (legacy AVEncoder NVENC/AMF) default to ultra-low-latency
	// tuning with an INFINITE GOP: they emit zero IDR frames (only P + recovery
	// point SEI), which starves every mid-stream joiner (WebRTC, fMP4 recorder,
	// RTMP readers) waiting for a keyframe. We therefore force IDR frames
	// ourselves: on the very first frame and every KeyframeIntervalSec seconds.
	int32  KeyframeIntervalSec = 2; // -SFKeyframeInterval= (seconds, <=0 = first frame only)

	// auto | aac | pcma | none
	FString AudioCodec = TEXT("auto");
	int32  AudioBitrateKbps = 128;

	bool   bEnableInput = true; // -SFInput=0/1
	bool   bEnableVideo = true;
	bool   bEnableAudio = true;

	// 视频管线重试耗尽后直接退出进程（fail-fast）：
	// 让调度服务立即回收实例并重试，而不是留一个永远不推流的僵尸进程
	// 等 120s spawn 超时。设为 0 可关闭（调试用）。
	bool   bExitOnFailure = true; // -SFExitOnFailure=0/1

	// 编码后端（-SFEncoder=）：
	//   auto   = 引擎硬件编码（NVENC/AMF）优先，失败自动降级外部 FFmpeg（默认，推荐）
	//   ave    = 仅用引擎硬件编码（旧行为，严格模式）
	//   ffmpeg = 仅用外部 FFmpeg（软编码 libx264 兜底 / 国产卡 VAAPI/DXVA）
	// 旧版打包程序不认识此参数会忽略 → 行为等价 ave，向后兼容。
	FString EncoderBackend = TEXT("auto");

	// auto 模式下本轮是否允许降级 FFmpeg。由模块外层重试控制：
	// 打包实例里 EncoderNVENC 要等游戏主循环启动后才注册（PostEngineInit 时
	// StreamForge 若阻塞等待编码器是鸡生蛋死锁——主循环不跑，编码器永不注册）。
	// 前几轮重试禁用降级、快速失败让出主循环；Ticker 重试时 NVENC 已就绪。
	bool   bAllowFfmpegFallback = true;

	// FFmpeg 可执行文件路径（-SFFFmpegPath=，默认 "ffmpeg" 走 PATH）。
	// 接入砺算/摩尔线程硬编码时换成厂商定制版 ffmpeg 的绝对路径。
	FString FFmpegPath = TEXT("ffmpeg");

	// FFmpeg 编码段参数全覆盖（-SFFFmpegArgs=，高级选项，一般留空）。
	// 默认编码段为 libx264 软编码；接入国产卡时由管理员配置，例如：
	//   -SFFFmpegArgs="-c:v h264_vaapi -qp 24"
	// 注意：输出侧 "-bsf:v h264_metadata=aud=insert -f h264 pipe:1" 始终由插件追加，不要重复写。
	FString FFmpegArgs;

	bool   bValid = false;

	/** Parses "-SFKey=Value" command line arguments. */
	static FSFSettings FromCommandLine();

	FString ToString() const;
};

/** Live stats reported through the control channel heartbeat. */
struct STREAMFORGE_API FSFStats
{
	std::atomic<int32> EncodedFps{ 0 };
	std::atomic<int32> EncodeMs{ 0 };
	std::atomic<int32> VideoQueueDepth{ 0 };
	std::atomic<int32> AudioQueueDepth{ 0 };
	std::atomic<int64> SentBytes{ 0 };
	std::atomic<int32> SendQueueMs{ 0 };
	std::atomic<int32> ReconnectCount{ 0 };
	std::atomic<int32> DroppedFrames{ 0 };
	std::atomic<bool>  bRtmpPublishing{ false };
	std::atomic<bool>  bAgentConnected{ false };
};
