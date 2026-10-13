// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "StreamForgeTypes.h"
#include <atomic>

/**
 * FSFFmpegEncoder — 外部 FFmpeg 进程编码后端（软编码兜底 / 国产显卡 VAAPI·DXVA 通道）
 *
 * 工作方式：
 *   - 拉起一个 ffmpeg 子进程：stdin 喂 BGRA 裸帧，stdout 收 H264 Annex-B 码流
 *   - 默认编码参数是 libx264 软编码（任何机器可用，作为 NVENC/AMF 失效时的兜底）
 *   - 通过 -SFFFmpegArgs= 可整体替换编码段（例如国产卡的 -c:v h264_vaapi），
 *     输出侧 "-bsf:v h264_metadata=aud=insert -f h264 pipe:1" 始终由本类追加
 *   - 读流线程按 AUD（Access Unit Delimiter）把码流切成完整 AU 后回调上层
 *
 * 线程模型：
 *   - WriteFrame() 在游戏线程调用（帧来自 GPU readback）
 *   - 包回调在内部读流线程触发（与 AVEncoder 的编码回调线程模型一致）
 */
class FSFFmpegEncoder
{
public:
	/** 包回调：(AnnexB AU 数据, 长度, 是否关键帧)；在读流线程触发 */
	typedef TFunction<void(const uint8*, uint32, bool)> FOnPacket;

	FSFFmpegEncoder() = default;
	~FSFFmpegEncoder();

	FSFFmpegEncoder(const FSFFmpegEncoder&) = delete;
	FSFFmpegEncoder& operator=(const FSFFmpegEncoder&) = delete;

	/** 拉起 ffmpeg 子进程并开始读流。失败返回 false（ffmpeg 不存在/参数错误等）。 */
	bool Start(const FSFSettings& Settings, FOnPacket InOnPacket);

	/** 写入一帧 BGRA（Width*Height*4 字节）。游戏线程调用；子进程异常时静默丢弃。 */
	void WriteFrame(const uint8* BgraData, int32 NumBytes);

	/** 关闭 stdin → 等子进程退出（超时强杀）→ 停读流线程 → 关管道。幂等。 */
	void Stop();

	bool IsRunning() const { return bProcAlive.load(); }
	uint64 GetPacketsOut() const { return PacketsOut.load(); }

private:
	void ReaderLoop();
	/** 增量解析缓冲里的 Annex-B，按 AUD 切 AU 并回调；bFlush 时把残余 AU 也吐出来 */
	void DrainBuffer(bool bFlush);
	void EmitAu(TArray<uint8>& Au, bool bKeyFrame);

	FProcHandle Proc;
	uint32 ProcId = 0;
	void* StdInRead = nullptr;   // 子进程 stdin 读端（传给 CreateProc）
	void* StdInWrite = nullptr;  // 本进程写入端
	void* StdOutRead = nullptr;  // 本进程读取端
	void* StdOutWrite = nullptr; // 子进程 stdout 写端（传给 CreateProc）

	class FSFFmpegReaderRunnable;
	TUniquePtr<FRunnableThread> ReaderThread;

	FCriticalSection WriteCS;    // WriteFrame 与 Stop 互斥
	std::atomic<bool> bStopping{ false };
	std::atomic<bool> bProcAlive{ false };
	std::atomic<uint64> PacketsOut{ 0 };

	FOnPacket OnPacket;
	TArray<uint8> Buf;           // 读流线程私有：未消费的码流缓冲
	uint64 AuCount = 0;
};
