// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/RunnableThread.h"
#include "StreamForgeTypes.h"

/**
 * Self-contained RTMP push client.
 * Connects to a MediaMTX (or any RTMP server) and publishes H264 video +
 * AAC/PCMA audio as FLV-formatted RTMP messages.
 *
 * Usage:
 *   FSFRtmpPusher Pusher;
 *   Pusher.Start(TEXT("rtmp://127.0.0.1:1935/zslive/inst_1"), &Stats);
 *   Pusher.EnqueueVideo(Tag, TsMs, bKey);
 *   Pusher.Stop();
 */
class FSFRtmpPusher : public FRunnable
{
public:
	FSFRtmpPusher();
	virtual ~FSFRtmpPusher();

	bool Start(const FString& InUrl, FSFStats* InStats);
	void Stop();

	/** FLV video tag (already packaged by SFMediaFormat). Thread-safe. */
	void EnqueueVideo(TArray<uint8>&& Tag, uint32 TsMs, bool bKey);
	/** FLV audio tag (already packaged by SFMediaFormat). Thread-safe. */
	void EnqueueAudio(TArray<uint8>&& Tag, uint32 TsMs);

	bool IsPublishing() const { return bPublishing; }

	/** Invoked (from the socket thread) whenever the stream reconnects, so media packagers can resend headers. */
	TFunction<void()> OnReconnected;

private:
	//~ FRunnable
	virtual uint32 Run() override;
	virtual void Exit() override;

	// protocol steps
	bool TcpConnect();
	bool Handshake();
	bool SendConnect();
	bool SendCreateStream();
	bool SendPublish();
	void SendSetChunkSize(uint32 Size);

	// socket I/O
	bool SendBytes(const uint8* Data, int32 Len);
	bool RecvBytes(int32 WaitMs);
	void HandleIncoming();

	// RTMP framing
	bool WriteMessage(uint8 CsId, uint8 TypeId, uint32 StreamId, uint32 TsMs, const uint8* Payload, uint32 Len);

	// state
	enum class EState
	{
		Idle,
		Connecting,           // TCP + handshake
		WaitConnectResult,
		WaitCreateStreamResult,
		WaitPublishStatus,
		Publishing,
	};

	FString Host;
	int32 Port = 1935;
	FString App;          // e.g. "zslive"
	FString StreamKey;    // e.g. "inst_1"
	FString TcUrl;
	FString Url;

	FSFStats* Stats = nullptr;
	FRunnableThread* Thread = nullptr;
	std::atomic<bool> bStopRequested{ false };
	std::atomic<bool> bPublishing{ false };
	std::atomic<bool> bStarted{ false };

	class FSocket* Socket = nullptr;

	EState State = EState::Idle;
	uint32 InChunkSize = 128;
	uint32 OutChunkSize = 4096;
	uint32 StreamId = 1;

	TArray<uint8> RecvBuf;
	int32 NextTxId = 2;

	// inbound chunk reassembly
	struct FChunkState
	{
		bool bValid = false;
		uint32 Ts = 0;
		uint32 MsgLen = 0;
		uint8 TypeId = 0;
		uint32 MsgStreamId = 0;
		TArray<uint8> Payload;
	};
	TMap<uint32, FChunkState> InChunks;

	// outbound backlog
	struct FPendingMsg
	{
		uint8 Type = 0; // 0 = video, 1 = audio
		uint32 TsMs = 0;
		bool bKey = false;
		TArray<uint8> Data;
	};
	TQueue<FPendingMsg, EQueueMode::Mpsc> Pending;
	std::atomic<int32> PendingCount{ 0 };
	int32 MaxPending = 240;
	// true until the pending backlog has been purged once after (re)entering
	// Publishing state; reset by ResetConnection()
	bool bBacklogPurged = false;

	std::atomic<int64> RecvBytesSinceAck{ 0 };
	int64 RecvBytesTotal = 0;

	// message dispatch
	void OnProtocolControl(uint8 TypeId, const uint8* Data, uint32 Len);
	void OnCommand(const TArray<uint8>& Payload);
	void OnUserControl(const uint8* Data, uint32 Len);

	void Fail(const TCHAR* Reason);
	void ResetConnection();
};
