// Copyright ZS Live Platform. All Rights Reserved.

#include "SFFmpegEncoder.h"
#include "SFLog.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"       // FPlatformTime::Seconds
#include "HAL/RunnableThread.h"
#include "HAL/Runnable.h"

namespace
{
	/** Annex-B start code 长度（00 00 01 = 3，00 00 00 01 = 4），没有则 0 */
	FORCEINLINE int32 SfStartCodeLen(const uint8* P, int32 Size)
	{
		if (Size >= 4 && P[0] == 0 && P[1] == 0 && P[2] == 0 && P[3] == 1) return 4;
		if (Size >= 3 && P[0] == 0 && P[1] == 0 && P[2] == 1) return 3;
		return 0;
	}
}

class FSFFmpegEncoder::FSFFmpegReaderRunnable : public FRunnable
{
public:
	explicit FSFFmpegReaderRunnable(FSFFmpegEncoder* InOwner) : Owner(InOwner) {}
	virtual uint32 Run() override
	{
		Owner->ReaderLoop();
		return 0;
	}
private:
	FSFFmpegEncoder* Owner;
};

FSFFmpegEncoder::~FSFFmpegEncoder()
{
	Stop();
}

bool FSFFmpegEncoder::Start(const FSFSettings& Settings, FOnPacket InOnPacket)
{
	if (bProcAlive.load())
	{
		return true;
	}
	OnPacket = MoveTemp(InOnPacket);

	// ---- 参数组装 ----
	// 输入：BGRA 裸帧走 stdin；输出：H264 Annex-B 走 stdout。
	// aud=insert 保证每个 AU 以 AUD 开头（切包依据）；重复 AUD 无害（切包器会丢弃空 AU）。
	const int32 Kbps = FMath::Max(500, Settings.BitrateKbps);
	const int32 GopFrames = FMath::Max(1, (int32)Settings.Fps * FMath::Max(1, Settings.KeyframeIntervalSec));

	FString EncoderSeg;
	if (!Settings.FFmpegArgs.IsEmpty())
	{
		// 管理员覆盖：国产卡 VAAPI/DXVA 等场景
		EncoderSeg = Settings.FFmpegArgs;
		UE_LOG(LogStreamForge, Log, TEXT("[FFmpeg] 使用自定义编码段: %s"), *EncoderSeg);
	}
	else
	{
		// 默认：libx264 软编码兜底（低延迟、无 B 帧、CBR、带内重复 SPS/PPS）
		// threads=8：zerolatency 会启用 sliced-threads 并按逻辑核数切 slice
		// （28 核机器 = 28 slice/帧），MediaMTX 单帧 NALU 上限 25 会踢断连接；
		// 固定 8 线程后每帧 8 slice + SPS/PPS/SEI ≈ 11 NALU，安全余量充足。
		EncoderSeg = FString::Printf(
			TEXT("-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p ")
			TEXT("-profile:v baseline -b:v %dk -maxrate %dk -bufsize %dk ")
			TEXT("-g %d -bf 0 -sc_threshold 0 -x264-params repeat-headers=1:threads=8"),
			Kbps, Kbps, Kbps * 2, GopFrames);
	}

	const FString Params = FString::Printf(
		TEXT("-hide_banner -loglevel error ")
		TEXT("-f rawvideo -pix_fmt bgra -s %ux%u -r %u -i pipe:0 ")
		TEXT("-an -sn -dn %s ")
		TEXT("-bsf:v h264_metadata=aud=insert -f h264 pipe:1"),
		Settings.Width, Settings.Height, Settings.Fps, *EncoderSeg);

	// ---- 管道与进程 ----
	// CreateProc 参数语义（以引擎头文件注释为准）：
	//   PipeWriteChild = 子进程 stdout 的写端（我们在另一端读）
	//   PipeReadChild  = 子进程 stdin 的读端（我们在另一端写）
	if (!FPlatformProcess::CreatePipe(StdOutRead, StdOutWrite, false))
	{
		UE_LOG(LogStreamForge, Error, TEXT("[FFmpeg] 创建 stdout 管道失败"));
		return false;
	}
	if (!FPlatformProcess::CreatePipe(StdInRead, StdInWrite, true))
	{
		UE_LOG(LogStreamForge, Error, TEXT("[FFmpeg] 创建 stdin 管道失败"));
		FPlatformProcess::ClosePipe(StdOutRead, StdOutWrite);
		StdOutRead = StdOutWrite = nullptr;
		return false;
	}

	Proc = FPlatformProcess::CreateProc(
		*Settings.FFmpegPath, *Params,
		false /*bLaunchDetached*/, true /*bLaunchHidden*/, true /*bLaunchReallyHidden*/,
		&ProcId, 0 /*PriorityModifier*/, nullptr /*WorkDir*/,
		StdOutWrite /*child stdout*/, StdInRead /*child stdin*/);

	if (!Proc.IsValid())
	{
		UE_LOG(LogStreamForge, Error,
			TEXT("[FFmpeg] 启动失败: %s（找不到可执行文件？可在系统设置里配置 ffmpegPath 绝对路径）"),
			*Settings.FFmpegPath);
		FPlatformProcess::ClosePipe(StdOutRead, StdOutWrite);
		FPlatformProcess::ClosePipe(StdInRead, StdInWrite);
		StdOutRead = StdOutWrite = StdInRead = StdInWrite = nullptr;
		return false;
	}

	// 子进程已复制了它那一端：父进程关掉自己持有的「子端」句柄，
	// 保证 EOF 语义干净（stdin 全关→ffmpeg 收 EOF 退出；ffmpeg 退出→stdout 读到 EOF）
	FPlatformProcess::ClosePipe(nullptr, StdOutWrite);
	StdOutWrite = nullptr;
	FPlatformProcess::ClosePipe(StdInRead, nullptr);
	StdInRead = nullptr;

	bStopping = false;
	bProcAlive = true;
	PacketsOut = 0;
	AuCount = 0;
	Buf.Reset(1 << 20);

	ReaderThread.Reset(FRunnableThread::Create(new FSFFmpegReaderRunnable(this), TEXT("SFFmpegReader"), 0, TPri_Normal));

	UE_LOG(LogStreamForge, Log, TEXT("[FFmpeg] 编码进程已启动 (pid=%u): %s %s"), ProcId, *Settings.FFmpegPath, *Params);
	return true;
}

void FSFFmpegEncoder::WriteFrame(const uint8* BgraData, int32 NumBytes)
{
	if (!bProcAlive.load() || bStopping.load() || !BgraData || NumBytes <= 0)
	{
		return;
	}
	FScopeLock Lock(&WriteCS);
	if (!StdInWrite)
	{
		return;
	}
	int32 Written = 0;
	if (!FPlatformProcess::WritePipe(StdInWrite, BgraData, NumBytes, &Written) || Written != NumBytes)
	{
		// 子进程死了（崩溃/参数错误退出）：标记不可用，让上层日志可见
		bProcAlive = false;
		UE_LOG(LogStreamForge, Error, TEXT("[FFmpeg] 写入帧失败，子进程可能已退出（已写入 %d/%d 字节）"), Written, NumBytes);
	}
}

void FSFFmpegEncoder::Stop()
{
	const bool bWasRunning = bProcAlive.exchange(false);
	bStopping = true;

	{
		FScopeLock Lock(&WriteCS);
		if (StdInWrite || StdInRead)
		{
			// 关 stdin：ffmpeg 读到 EOF 后冲刷残留帧并自行退出
			FPlatformProcess::ClosePipe(StdInRead, StdInWrite);
			StdInRead = StdInWrite = nullptr;
		}
	}

	if (Proc.IsValid())
	{
		// 等子进程自行退出（stdin 已关，正常秒退），最多 3s；轮询写法兼容全部引擎版本
		const double Deadline = FPlatformTime::Seconds() + 3.0;
		while (FPlatformProcess::IsProcRunning(Proc) && FPlatformTime::Seconds() < Deadline)
		{
			FPlatformProcess::Sleep(0.05f);
		}
		if (FPlatformProcess::IsProcRunning(Proc))
		{
			UE_LOG(LogStreamForge, Warning, TEXT("[FFmpeg] 子进程 3s 内未退出，强制终止"));
			FPlatformProcess::TerminateProc(Proc, true);
		}
		FPlatformProcess::CloseProc(Proc);
		Proc.Reset();
	}

	if (ReaderThread.IsValid())
	{
		ReaderThread->Kill(true);
		ReaderThread.Reset();
	}

	if (StdOutRead || StdOutWrite)
	{
		FPlatformProcess::ClosePipe(StdOutRead, StdOutWrite);
		StdOutRead = StdOutWrite = nullptr;
	}
}

void FSFFmpegEncoder::ReaderLoop()
{
	TArray<uint8> Chunk;
	while (!bStopping.load())
	{
		Chunk.Reset();
		if (StdOutRead && FPlatformProcess::ReadPipeToArray(StdOutRead, Chunk) && Chunk.Num() > 0)
		{
			Buf.Append(Chunk);
			DrainBuffer(false);
		}
		else
		{
			// 子进程已退出且管道无数据 → 退出线程
			if (!FPlatformProcess::IsProcRunning(Proc))
			{
				break;
			}
			FPlatformProcess::Sleep(0.002f);
		}
	}
	// 收尾：把缓冲里残留的完整 AU 吐掉
	DrainBuffer(true);
	bProcAlive = false;
}

void FSFFmpegEncoder::EmitAu(TArray<uint8>& Au, bool bKeyFrame)
{
	if (OnPacket && Au.Num() > 0)
	{
		OnPacket(Au.GetData(), (uint32)Au.Num(), bKeyFrame);
		PacketsOut++;
		AuCount++;
	}
	Au.Reset();
}

void FSFFmpegEncoder::DrainBuffer(bool bFlush)
{
	// 增量解析：只对「完整 NAL」（后面跟着下一个 start code 或缓冲结束且 flush）做处理；
	// AUD（type 9）是 AU 边界：遇到 AUD 就把之前攒的 AU 发射出去。AUD 本身不进载荷。
	static TArray<uint8> CurrentAu;   // 读流线程独占，static 省一次成员（单实例语义由 pipeline 保证）
	static bool bAuHasVcl = false;
	static bool bAuKey = false;

	int32 Pos = 0;
	const int32 Size = Buf.Num();
	const uint8* Data = Buf.GetData();

	// 找第一个 start code
	while (Pos < Size && SfStartCodeLen(Data + Pos, Size - Pos) == 0)
	{
		++Pos;
	}

	while (Pos < Size)
	{
		const int32 ScLen = SfStartCodeLen(Data + Pos, Size - Pos);
		if (ScLen == 0) break;
		const int32 NalStart = Pos + ScLen;
		// 找下一个 start code 确定本 NAL 长度
		int32 Next = NalStart;
		while (Next < Size && SfStartCodeLen(Data + Next, Size - Next) == 0)
		{
			++Next;
		}
		if (Next >= Size && !bFlush)
		{
			break; // 本 NAL 不完整，等更多数据
		}
		const int32 NalLen = Next - NalStart;
		if (NalLen > 0)
		{
			const uint8 NalType = Data[NalStart] & 0x1F;
			if (NalType == 9)
			{
				// AU 边界
				if (bAuHasVcl)
				{
					EmitAu(CurrentAu, bAuKey);
				}
				else
				{
					CurrentAu.Reset();
				}
				bAuHasVcl = false;
				bAuKey = false;
			}
			else
			{
				CurrentAu.Append(Data + Pos, ScLen + NalLen);
				if (NalType == 5)
				{
					bAuKey = true;
					bAuHasVcl = true;
				}
				else if (NalType == 1)
				{
					bAuHasVcl = true;
				}
			}
		}
		Pos = Next;
	}

	// 丢弃已消费字节
	if (Pos > 0)
	{
		Buf.RemoveAt(0, Pos, EAllowShrinking::No);
	}
	// 缓冲防爆（正常远达不到）：丢到下一个 start code
	if (Buf.Num() > 32 * 1024 * 1024)
	{
		UE_LOG(LogStreamForge, Warning, TEXT("[FFmpeg] 码流缓冲异常膨胀（%d MB），重置"), Buf.Num() / 1024 / 1024);
		Buf.Reset();
		CurrentAu.Reset();
		bAuHasVcl = false;
		bAuKey = false;
	}
}
