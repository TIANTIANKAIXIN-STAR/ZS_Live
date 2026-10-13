// Copyright ZS Live Platform. All Rights Reserved.

#include "SFRtmpPusher.h"
#include "SFAmf0.h"
#include "SFLog.h"
#include "Sockets.h"
#include "SocketSubsystem.h"

PRAGMA_DISABLE_DEPRECATION_WARNINGS

namespace
{
	constexpr uint8 RTMP_MSG_SET_CHUNK_SIZE = 0x01;
	constexpr uint8 RTMP_MSG_ABORT = 0x02;
	constexpr uint8 RTMP_MSG_ACK = 0x03;
	constexpr uint8 RTMP_MSG_USER_CONTROL = 0x04;
	constexpr uint8 RTMP_MSG_WINDOW_ACK_SIZE = 0x05;
	constexpr uint8 RTMP_MSG_SET_PEER_BW = 0x06;
	constexpr uint8 RTMP_MSG_AUDIO = 0x08;
	constexpr uint8 RTMP_MSG_VIDEO = 0x09;
	constexpr uint8 RTMP_MSG_AMF0_COMMAND = 0x14;
	constexpr uint8 RTMP_MSG_AMF0_DATA = 0x12;

	constexpr uint8 CS_PROTOCOL = 2;
	constexpr uint8 CS_COMMAND = 3;
	constexpr uint8 CS_AUDIO = 4;
	constexpr uint8 CS_VIDEO = 6;

	FORCEINLINE void AppendU8(TArray<uint8>& A, uint8 V) { A.Add(V); }
	FORCEINLINE void AppendU16BE(TArray<uint8>& A, uint16 V) { A.Add((uint8)(V >> 8)); A.Add((uint8)(V & 0xFF)); }
	FORCEINLINE void AppendU24BE(TArray<uint8>& A, uint32 V)
	{
		A.Add((uint8)((V >> 16) & 0xFF)); A.Add((uint8)((V >> 8) & 0xFF)); A.Add((uint8)(V & 0xFF));
	}
	FORCEINLINE void AppendU32BE(TArray<uint8>& A, uint32 V)
	{
		A.Add((uint8)((V >> 24) & 0xFF)); A.Add((uint8)((V >> 16) & 0xFF)); A.Add((uint8)((V >> 8) & 0xFF)); A.Add((uint8)(V & 0xFF));
	}
	FORCEINLINE void AppendU32LE(TArray<uint8>& A, uint32 V)
	{
		A.Add((uint8)(V & 0xFF)); A.Add((uint8)((V >> 8) & 0xFF)); A.Add((uint8)((V >> 16) & 0xFF)); A.Add((uint8)((V >> 24) & 0xFF));
	}
	FORCEINLINE uint32 ReadU24(const uint8* P) { return ((uint32)P[0] << 16) | ((uint32)P[1] << 8) | P[2]; }
	FORCEINLINE uint32 ReadU32LE(const uint8* P)
	{
		return (uint32)P[0] | ((uint32)P[1] << 8) | ((uint32)P[2] << 16) | ((uint32)P[3] << 24);
	}
}

FSFRtmpPusher::FSFRtmpPusher() = default;

FSFRtmpPusher::~FSFRtmpPusher()
{
	Stop();
}

bool FSFRtmpPusher::Start(const FString& InUrl, FSFStats* InStats)
{
	if (bStarted.exchange(true))
	{
		return false; // already running
	}
	Url = InUrl;
	Stats = InStats;

	// parse rtmp://host:port/app/streamKey
	FString SchemeRest;
	if (!Url.Split(TEXT("://"), nullptr, &SchemeRest, ESearchCase::IgnoreCase, ESearchDir::FromStart))
	{
		UE_LOG(LogStreamForge, Error, TEXT("[RTMP] Invalid url: %s"), *Url);
		return false;
	}
	FString HostPort, Path;
	SchemeRest.Split(TEXT("/"), &HostPort, &Path);
	if (HostPort.Contains(TEXT(":")))
	{
		FString PortStr;
		HostPort.Split(TEXT(":"), &HostPort, &PortStr);
		Port = FCString::Atoi(*PortStr);
	}
	else
	{
		Port = 1935;
	}
	if (Path.IsEmpty())
	{
		UE_LOG(LogStreamForge, Error, TEXT("[RTMP] Url has no publish path: %s"), *Url);
		return false;
	}
	Host = HostPort;
	// app = first path segment, streamKey = remainder
	if (!Path.Split(TEXT("/"), &App, &StreamKey) || App.IsEmpty() || StreamKey.IsEmpty())
	{
		App = TEXT("live");
		StreamKey = Path;
	}
	TcUrl = FString::Printf(TEXT("rtmp://%s:%d/%s"), *HostPort, Port, *App);

	Thread = FRunnableThread::Create(this, TEXT("SF-RtmpPush"), 0, TPri_BelowNormal);
	return Thread != nullptr;
}

void FSFRtmpPusher::Stop()
{
	if (!bStarted.exchange(false))
	{
		return;
	}
	bStopRequested = true;
	if (Thread)
	{
		Thread->WaitForCompletion();
		delete Thread;
		Thread = nullptr;
	}
	if (Socket)
	{
		ISocketSubsystem::Get()->DestroySocket(Socket);
		Socket = nullptr;
	}
}

void FSFRtmpPusher::EnqueueVideo(TArray<uint8>&& Tag, uint32 TsMs, bool bKey)
{
	if (!bStarted || PendingCount > MaxPending)
	{
		if (Stats) Stats->DroppedFrames++;
		return;
	}
	FPendingMsg M;
	M.Type = 0;
	M.TsMs = TsMs;
	M.bKey = bKey;
	M.Data = MoveTemp(Tag);
	Pending.Enqueue(MoveTemp(M));
	PendingCount++;
}

void FSFRtmpPusher::EnqueueAudio(TArray<uint8>&& Tag, uint32 TsMs)
{
	if (!bStarted || PendingCount > MaxPending)
	{
		return;
	}
	FPendingMsg M;
	M.Type = 1;
	M.TsMs = TsMs;
	M.Data = MoveTemp(Tag);
	Pending.Enqueue(MoveTemp(M));
	PendingCount++;
}

uint32 FSFRtmpPusher::Run()
{
	int32 BackoffMs = 1000;
	while (!bStopRequested)
	{
		ResetConnection();
		State = EState::Connecting;

		if (!TcpConnect())
		{
			UE_LOG(LogStreamForge, Warning, TEXT("[RTMP] TCP connect failed, retry in %d ms"), BackoffMs);
			FPlatformProcess::Sleep(BackoffMs / 1000.f);
			BackoffMs = FMath::Min(BackoffMs * 2, 10000);
			continue;
		}
		BackoffMs = 1000;

		if (!Handshake())
		{
			UE_LOG(LogStreamForge, Warning, TEXT("[RTMP] Handshake failed"));
			FPlatformProcess::Sleep(BackoffMs / 1000.f);
			continue;
		}

		// 4K 关键帧可达数 MB；默认 4KB chunk 会拆成上千片，推高发送尖峰与卡顿
		SendSetChunkSize(65536);

		if (!SendConnect())
		{
			FPlatformProcess::Sleep(BackoffMs / 1000.f);
			continue;
		}
		State = EState::WaitConnectResult;

		// main loop: pump inbound, and drain outbound once published
		while (!bStopRequested)
		{
			if (!RecvBytes(50))
			{
				break; // socket failure -> reconnect
			}
			HandleIncoming();

			if (State == EState::Publishing)
			{
				// On every (re)connect, drop the entire pending backlog before
				// draining: queued tags were built against the PREVIOUS connection
				// (no AVC sequence header after InvalidateTags, stale A/V sync).
				// Sending them makes MediaMTX kill the connection with
				// "video track is not set up" and puts us into a reconnect loop.
				// Fresh frames resume within one keyframe interval (<=2s) and the
				// first one carries a re-sent sequence header.
				if (!bBacklogPurged)
				{
					bBacklogPurged = true;
					FPendingMsg Purge;
					int32 Purged = 0;
					while (Pending.Dequeue(Purge))
					{
						PendingCount--;
						Purged++;
					}
					if (Purged > 0)
					{
						if (Stats) Stats->DroppedFrames += Purged;
						UE_LOG(LogStreamForge, Log, TEXT("[RTMP] Purged %d stale queued frames on (re)connect"), Purged);
					}
				}
				FPendingMsg M;
				while (Pending.Dequeue(M))
				{
					PendingCount--;
					if (State != EState::Publishing || bStopRequested)
					{
						break;
					}
				const uint8 TypeId = M.Type == 0 ? RTMP_MSG_VIDEO : RTMP_MSG_AUDIO;
				const uint8 CsId = M.Type == 0 ? CS_VIDEO : CS_AUDIO;
				// media payloads MUST be wrapped in an RTMP chunk header (fmt=0 full
				// header + fmt=3 continuations) - sending the raw FLV tag makes the
				// server interpret tag bytes as chunk headers and drop the connection.
				if (!WriteMessage(CsId, TypeId, StreamId, M.TsMs, M.Data.GetData(), M.Data.Num()))
				{
					goto ConnectionFailed;
				}
					if (Stats)
					{
						Stats->SentBytes += M.Data.Num();
					}
				}
				if (Stats) Stats->VideoQueueDepth = PendingCount.load();
			}
		}

	ConnectionFailed:
		UE_LOG(LogStreamForge, Warning, TEXT("[RTMP] Connection lost, reconnecting..."));
		FPlatformProcess::Sleep(BackoffMs / 1000.f);
	}
	return 0;
}

void FSFRtmpPusher::Exit()
{
	bPublishing = false;
	if (Socket)
	{
		ISocketSubsystem::Get()->DestroySocket(Socket);
		Socket = nullptr;
	}
}

void FSFRtmpPusher::ResetConnection()
{
	if (bPublishing.exchange(false) && Stats)
	{
		Stats->bRtmpPublishing = false;
	}
	if (Socket)
	{
		ISocketSubsystem::Get()->DestroySocket(Socket);
		Socket = nullptr;
	}
	RecvBuf.Reset();
	InChunks.Reset();
	State = EState::Idle;
	InChunkSize = 128;
	OutChunkSize = 128;   // per-spec default until our SetChunkSize is sent
	StreamId = 1;
	RecvBytesTotal = 0;
	RecvBytesSinceAck = 0;
	bBacklogPurged = false;
}

bool FSFRtmpPusher::TcpConnect()
{
	ISocketSubsystem* SSS = ISocketSubsystem::Get();
	if (!SSS)
	{
		return false;
	}

	TSharedRef<FInternetAddr> Addr = SSS->CreateInternetAddr();
	bool bIsIp = false;
	Addr->SetIp(*Host, bIsIp);
	if (!bIsIp)
	{
		UE_LOG(LogStreamForge, Error, TEXT("[RTMP] Cannot resolve host: %s"), *Host);
		return false;
	}
	Addr->SetPort(Port);

	Socket = SSS->CreateSocket(NAME_Stream, TEXT("SFRtmpPusher"));
	if (!Socket)
	{
		return false;
	}
	Socket->SetNoDelay(true);
	Socket->SetNonBlocking(false);

	const bool bConnected = Socket->Connect(*Addr);
	if (!bConnected)
	{
		UE_LOG(LogStreamForge, Verbose, TEXT("[RTMP] Connect(%s:%d) error=%d"), *Host, Port,
		       (int32)SSS->GetLastErrorCode());
		ISocketSubsystem::Get()->DestroySocket(Socket);
		Socket = nullptr;
		return false;
	}
	UE_LOG(LogStreamForge, Log, TEXT("[RTMP] Connected to %s:%d (app=%s key=%s)"), *Host, Port, *App, *StreamKey);
	return true;
}

bool FSFRtmpPusher::Handshake()
{
	// C0 + C1
	TArray<uint8> C01;
	C01.Add(0x03);
	TArray<uint8> Random;
	Random.SetNum(1528);
	FMath::RandInit(FPlatformTime::Cycles());
	for (auto& B : Random) B = (uint8)FMath::Rand();
	const uint32 TimeZero = 0;
	C01.Append((const uint8*)&TimeZero, 4);
	C01.AddZeroed(4);
	C01.Append(Random);

	if (!SendBytes(C01.GetData(), C01.Num()))
	{
		return false;
	}

	// S0 + S1 + S2
	TArray<uint8> S;
	S.SetNum(1 + 1536 + 1536);
	int32 Got = 0;
	while (Got < S.Num() && !bStopRequested)
	{
		// poll with a timeout so we stay responsive to shutdown requests
		if (!Socket->Wait(ESocketWaitConditions::WaitForRead, FTimespan::FromMilliseconds(200)))
		{
			continue;
		}
		int32 Read = 0;
		if (Socket->Recv(S.GetData() + Got, S.Num() - Got, Read))
		{
			if (Read <= 0)
			{
				return false;
			}
			Got += Read;
		}
		else
		{
			const ESocketErrors Err = ISocketSubsystem::Get()->GetLastErrorCode();
			if (Err == SE_ETIMEDOUT || Err == SE_EWOULDBLOCK)
			{
				continue;
			}
			return false;
		}
	}
	if (bStopRequested)
	{
		return false;
	}
	if (S[0] != 0x03)
	{
		UE_LOG(LogStreamForge, Error, TEXT("[RTMP] Unsupported RTMP version %d"), S[0]);
		return false;
	}

	// C2 = echo of S1
	if (!SendBytes(S.GetData() + 1, 1536))
	{
		return false;
	}
	UE_LOG(LogStreamForge, Verbose, TEXT("[RTMP] Handshake complete"));
	return true;
}

void FSFRtmpPusher::SendSetChunkSize(uint32 Size)
{
	TArray<uint8> Payload;
	AppendU32BE(Payload, Size);
	WriteMessage(CS_PROTOCOL, RTMP_MSG_SET_CHUNK_SIZE, 0, 0, Payload.GetData(), Payload.Num());
	OutChunkSize = Size;
}

bool FSFRtmpPusher::SendConnect()
{
	SFAmf0::FWriter W;
	W.WriteString(TEXT("connect")); // command name: AMF0 string (marker 0x02 + length)
	W.WriteNumber(1);               // transaction id
	W.WriteObjectBegin();
	W.WriteProp(TEXT("app"), App);
	W.WriteProp(TEXT("type"), TEXT("nonprivate"));
	W.WriteProp(TEXT("flashVer"), TEXT("FMLE/3.0 (ZS Live)"));
	W.WriteProp(TEXT("tcUrl"), TcUrl);
	W.WriteObjectEnd();

	TArray<uint8> Payload;
	Payload.Append(W.GetData());

	WriteMessage(CS_COMMAND, RTMP_MSG_AMF0_COMMAND, 0, 0, Payload.GetData(), Payload.Num());
	UE_LOG(LogStreamForge, Log, TEXT("[RTMP] Sent 'connect' (app=%s)"), *App);
	return true;
}

bool FSFRtmpPusher::SendCreateStream()
{
	SFAmf0::FWriter W;
	TArray<uint8> Payload;
	W.WriteString(TEXT("createStream"));
	W.WriteNumber(2); // transaction id
	W.WriteNull();
	Payload.Append(W.GetData());
	WriteMessage(CS_COMMAND, RTMP_MSG_AMF0_COMMAND, 0, 0, Payload.GetData(), Payload.Num());
	return true;
}

bool FSFRtmpPusher::SendPublish()
{
	SFAmf0::FWriter W;
	TArray<uint8> Payload;
	W.WriteString(TEXT("publish"));
	W.WriteNumber(3);
	W.WriteNull();
	W.WriteString(StreamKey);
	W.WriteString(TEXT("live"));
	Payload.Append(W.GetData());
	WriteMessage(CS_COMMAND, RTMP_MSG_AMF0_COMMAND, StreamId, 0, Payload.GetData(), Payload.Num());
	UE_LOG(LogStreamForge, Log, TEXT("[RTMP] Sent 'publish' %s"), *StreamKey);
	return true;
}

bool FSFRtmpPusher::SendBytes(const uint8* Data, int32 Len)
{
	if (!Socket)
	{
		return false;
	}
	int32 Sent = 0;
	while (Sent < Len)
	{
		int32 N = 0;
		if (!Socket->Send(Data + Sent, Len - Sent, N) || N < 0)
		{
			const ESocketErrors Err = ISocketSubsystem::Get()->GetLastErrorCode();
			if (Err == SE_EWOULDBLOCK || Err == SE_TRY_AGAIN)
			{
				FPlatformProcess::Sleep(0.001f);
				continue;
			}
			UE_LOG(LogStreamForge, Warning, TEXT("[RTMP] Send failed (err=%d, sent=%d/%d)"), (int32)Err, Sent, Len);
			return false;
		}
		if (N == 0)
		{
			FPlatformProcess::Sleep(0.001f);
			continue;
		}
		Sent += N;
	}
	return true;
}

bool FSFRtmpPusher::RecvBytes(int32 WaitMs)
{
	if (!Socket)
	{
		return false;
	}
	uint8 Tmp[4096];
	// poll with a timeout instead of a blocking recv so the thread stays responsive
	if (!Socket->Wait(ESocketWaitConditions::WaitForRead, FTimespan::FromMilliseconds(FMath::Max(WaitMs, 1))))
	{
		return true; // no data right now; not an error
	}
	int32 Read = 0;
	if (Socket->Recv(Tmp, sizeof(Tmp), Read))
	{
		if (Read > 0)
		{
			RecvBuf.Append(Tmp, Read);
			RecvBytesTotal += Read;
			RecvBytesSinceAck += Read;
			if (RecvBytesSinceAck > 2 * 1024 * 1024)
			{
				TArray<uint8> Ack;
				AppendU32BE(Ack, (uint32)RecvBytesTotal);
				WriteMessage(CS_PROTOCOL, RTMP_MSG_ACK, 0, 0, Ack.GetData(), Ack.Num());
				RecvBytesSinceAck = 0;
			}
		}
		return true;
	}
	const ESocketErrors Err = ISocketSubsystem::Get()->GetLastErrorCode();
	return Err == SE_ETIMEDOUT || Err == SE_EWOULDBLOCK || Err == SE_TRY_AGAIN;
}

bool FSFRtmpPusher::WriteMessage(uint8 CsId, uint8 TypeId, uint32 MsgStreamId, uint32 TsMs, const uint8* Payload, uint32 Len)
{
	TArray<uint8> Out;
	const bool bExtTs = TsMs >= 0xFFFFFF;

	// chunk stream id (support 2..63 inline; we only use small ids)
	AppendU8(Out, CsId);

	// fmt=0 full header
	AppendU24BE(Out, bExtTs ? 0xFFFFFF : TsMs);
	AppendU24BE(Out, Len);
	AppendU8(Out, TypeId);
	AppendU32LE(Out, MsgStreamId);
	if (bExtTs)
	{
		AppendU32BE(Out, TsMs);
	}

	uint32 Offset = 0;
	while (Offset < Len)
	{
		if (Offset > 0)
		{
			AppendU8(Out, CsId | 0xC0); // fmt=3 continuation
			if (bExtTs)
			{
				AppendU32BE(Out, TsMs);
			}
		}
		const uint32 N = FMath::Min(OutChunkSize, Len - Offset);
		Out.Append(Payload + Offset, N);
		Offset += N;
	}

	if (!SendBytes(Out.GetData(), Out.Num()))
	{
		UE_LOG(LogStreamForge, Verbose, TEXT("[RTMP] WriteMessage send failed"));
		return false;
	}
	return true;
}

void FSFRtmpPusher::HandleIncoming()
{
	while (true)
	{
		if (RecvBuf.Num() < 1)
		{
			return;
		}

		const uint8 B0 = RecvBuf[0];
		const uint8 Fmt = (B0 >> 6) & 0x03;
		uint32 CsId = B0 & 0x3F;
		uint32 HeaderLen = 1;

		if (CsId == 0)
		{
			if (RecvBuf.Num() < 2) return;
			CsId = 64 + RecvBuf[1];
			HeaderLen = 2;
		}
		else if (CsId == 1)
		{
			if (RecvBuf.Num() < 3) return;
			CsId = 64 + RecvBuf[1] + 256 * RecvBuf[2];
			HeaderLen = 3;
		}

		static const uint32 FmtLen[4] = { 11, 7, 3, 0 };
		const uint32 MsgHeaderLen = FmtLen[Fmt];

		uint32 Peek = HeaderLen;
		if (RecvBuf.Num() < (int32)(HeaderLen + MsgHeaderLen))
		{
			return;
		}

		FChunkState& St = InChunks.FindOrAdd(CsId);

		uint32 TsField = 0;
		bool bExtTs = false;
		if (Fmt == 0)
		{
			TsField = ReadU24(RecvBuf.GetData() + Peek); Peek += 3;
			St.MsgLen = ReadU24(RecvBuf.GetData() + Peek); Peek += 3;
			St.TypeId = RecvBuf[Peek]; Peek += 1;
			St.MsgStreamId = ReadU32LE(RecvBuf.GetData() + Peek); Peek += 4;
			if (TsField == 0xFFFFFF) bExtTs = true;
			St.Ts = TsField == 0xFFFFFF ? 0 : TsField;
			St.bValid = true;
		}
		else if (Fmt == 1)
		{
			TsField = ReadU24(RecvBuf.GetData() + Peek); Peek += 3;
			St.MsgLen = ReadU24(RecvBuf.GetData() + Peek); Peek += 3;
			St.TypeId = RecvBuf[Peek]; Peek += 1;
			if (TsField == 0xFFFFFF) bExtTs = true;
			St.Ts += TsField == 0xFFFFFF ? 0 : TsField;
		}
		else if (Fmt == 2)
		{
			TsField = ReadU24(RecvBuf.GetData() + Peek); Peek += 3;
			if (TsField == 0xFFFFFF) bExtTs = true;
			St.Ts += TsField == 0xFFFFFF ? 0 : TsField;
		}
		// fmt == 3: nothing

		if (bExtTs)
		{
			if (RecvBuf.Num() < (int32)(Peek + 4)) return;
			uint32 Ext = ((uint32)RecvBuf[Peek] << 24) | ((uint32)RecvBuf[Peek + 1] << 16) | ((uint32)RecvBuf[Peek + 2] << 8) | RecvBuf[Peek + 3];
			Peek += 4;
			// fmt0: absolute, fmt1/2/3: delta was signalled via ext field
			if (Fmt == 0)
			{
				St.Ts = Ext;
			}
			else
			{
				// delta unknown here (already added 0) - add now
				St.Ts += Ext;
			}
		}

		// chunk payload
		const uint32 ChunkLen = FMath::Min(InChunkSize, St.MsgLen - St.Payload.Num());
		if (RecvBuf.Num() < (int32)(Peek + ChunkLen))
		{
			return; // wait for more data
		}

		St.Payload.Append(RecvBuf.GetData() + Peek, ChunkLen);
		RecvBuf.RemoveAt(0, Peek + ChunkLen, EAllowShrinking::No);

		if ((uint32)St.Payload.Num() >= St.MsgLen && St.bValid)
		{
			// complete message
			if (St.TypeId == RTMP_MSG_SET_CHUNK_SIZE && St.MsgLen >= 4)
			{
				const uint32 NewSize = ((uint32)St.Payload[0] << 24) | ((uint32)St.Payload[1] << 16) | ((uint32)St.Payload[2] << 8) | St.Payload[3];
				InChunkSize = FMath::Clamp(NewSize, 128u, 16777215u);
			}
			else if (St.TypeId == RTMP_MSG_WINDOW_ACK_SIZE || St.TypeId == RTMP_MSG_SET_PEER_BW || St.TypeId == RTMP_MSG_ACK || St.TypeId == RTMP_MSG_ABORT)
			{
				// ignore
			}
			else if (St.TypeId == RTMP_MSG_USER_CONTROL)
			{
				OnUserControl(St.Payload.GetData(), St.Payload.Num());
			}
			else if (St.TypeId == RTMP_MSG_AMF0_COMMAND)
			{
				OnCommand(St.Payload);
			}
			else if (St.TypeId == RTMP_MSG_AMF0_DATA)
			{
				// @setDataFrame etc - ignore
			}
			St.Payload.Reset();
		}
	}
}

void FSFRtmpPusher::OnUserControl(const uint8* Data, uint32 Len)
{
	// ping / pong. A polite client answers PingRequest(6).
	if (Len >= 6)
	{
		const uint16 EvType = ((uint16)Data[0] << 8) | Data[1];
		if (EvType == 6)
		{
			TArray<uint8> Pong;
			Pong.Add(0); Pong.Add(7); // PongResponse
			Pong.Append(Data + 2, 4);
			WriteMessage(CS_PROTOCOL, RTMP_MSG_USER_CONTROL, 0, 0, Pong.GetData(), Pong.Num());
		}
	}
}

void FSFRtmpPusher::OnCommand(const TArray<uint8>& Payload)
{
	uint32 Cursor = 0;
	SFAmf0::FValue Name;
	if (!SFAmf0::ReadValue(Payload, Cursor, Name) || !Name.IsString())
	{
		return;
	}
	SFAmf0::FValue Tx;
	if (!SFAmf0::ReadValue(Payload, Cursor, Tx))
	{
		return;
	}
	SFAmf0::FValue Dummy;
	SFAmf0::ReadValue(Payload, Cursor, Dummy); // command object / null

	if (Name.Str == TEXT("_result"))
	{
		if (State == EState::WaitConnectResult)
		{
			UE_LOG(LogStreamForge, Log, TEXT("[RTMP] Connect accepted"));
			SendCreateStream();
			State = EState::WaitCreateStreamResult;
		}
		else if (State == EState::WaitCreateStreamResult)
		{
			SFAmf0::FValue StreamIdVal;
			if (SFAmf0::ReadValue(Payload, Cursor, StreamIdVal) && StreamIdVal.IsNumber())
			{
				StreamId = (uint32)StreamIdVal.Number;
				if (StreamId == 0) StreamId = 1;
			}
			UE_LOG(LogStreamForge, Log, TEXT("[RTMP] Stream created (msid=%u)"), StreamId);
			SendPublish();
			State = EState::WaitPublishStatus;
		}
	}
	else if (Name.Str == TEXT("onStatus"))
	{
		SFAmf0::FValue Info;
		if (!SFAmf0::ReadValue(Payload, Cursor, Info) || !Info.IsObject())
		{
			return;
		}
		const SFAmf0::FValue* Code = Info.Find(TEXT("code"));
		const SFAmf0::FValue* Level = Info.Find(TEXT("level"));
		const FString CodeStr = Code && Code->IsString() ? Code->Str : TEXT("");
		const FString LevelStr = Level && Level->IsString() ? Level->Str : TEXT("");

		if (CodeStr == TEXT("NetStream.Publish.Start"))
		{
			UE_LOG(LogStreamForge, Log, TEXT("[RTMP] Publishing! path=%s/%s"), *App, *StreamKey);
			bPublishing = true;
			if (Stats) Stats->bRtmpPublishing = true;
			if (Stats) Stats->ReconnectCount++;
			if (OnReconnected)
			{
				OnReconnected();
			}
			State = EState::Publishing;
		}
		else if (LevelStr == TEXT("error") || CodeStr.Contains(TEXT("Failed")) || CodeStr.Contains(TEXT("Rejected")))
		{
			UE_LOG(LogStreamForge, Error, TEXT("[RTMP] Publish rejected: %s"), *CodeStr);
			// stay non-publishing; server will likely drop us
		}
	}
	else if (Name.Str == TEXT("close"))
	{
		UE_LOG(LogStreamForge, Warning, TEXT("[RTMP] Server sent close"));
	}
}

PRAGMA_ENABLE_DEPRECATION_WARNINGS
