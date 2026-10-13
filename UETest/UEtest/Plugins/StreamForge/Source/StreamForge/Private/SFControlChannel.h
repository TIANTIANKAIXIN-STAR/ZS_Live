// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "StreamForgeTypes.h"
#include "Containers/Ticker.h"

class IWebSocket;

/**
 * Control channel: a WebSocket client that connects to the ZS Live scheduler.
 * Receives remote input events (keyboard/mouse) and custom commands,
 * reports heartbeats with live stats, and forwards game events to the browser.
 */
class FSFControlChannel
{
public:
	FSFControlChannel();
	~FSFControlChannel();

	bool Initialize(const FSFSettings& InSettings, FSFStats* InStats);
	void Start();
	void Stop();

	bool SendJson(const FString& Json);
	bool SendEvent(const FString& Name, const FString& Data);
	bool IsConnected() const;

	/**
	 * 视频管线是否就绪（随 hello 上报）。
	 * 控制通道先于视频管线启动时，服务端据此区分「agent 已连但没推流」
	 * 与「实例真正就绪」，避免过早通知浏览器拉流。
	 */
	void SetVideoReady(bool bInReady) { bVideoReady = bInReady; }
	/** 视频管线初始化失败原因，随 hello 上报给调度服务（快速失败/回收） */
	void SetStartupError(const FString& InCode, const FString& InDetail)
	{
		StartupErrorCode = InCode;
		StartupErrorDetail = InDetail;
	}

	/** Called for custom commands (game thread safe). */
	TFunction<void(const FString& Name, const FString& Payload)> OnCommand;
	/** Called for raw control events (game thread). */
	TFunction<void(const FString& EventName, const FString& Data)> OnControlEvent;
	/** Called when the server requests shutdown. */
	TFunction<void()> OnStopRequest;

private:
	void Connect();
	void HandleMessage(const FString& Message);

	// input injection (game thread)
	void InjectKeyDown(const FString& KeyName, bool bCtrl, bool bShift, bool bAlt, uint32 CharCode);
	void InjectKeyUp(const FString& KeyName, bool bCtrl, bool bShift, bool bAlt);
	void InjectMouseMove(double Nx, double Ny);
	void InjectMouseButton(const FString& Button, bool bDown);
	void InjectWheel(double Delta);

	void SendHello();
	bool TickStats(float Dt);

	// Socket 事件必须绑成成员函数（AddRaw），Stop() 里才能 RemoveAll(this) 解绑——
	// 2026-10-12 现场：OnClosed 绑 Lambda 捕获 this，Close() 异步完成后事件晚到，
	// 此时对象已被 delete，回调打进已释放内存（UAF → Ticker 表损坏、随机崩溃）。
	void HandleClosed(int32 Code, const FString& Reason, bool bClean);
	void HandleConnectError(const FString& Err);

	FSFSettings Settings;
	FSFStats* Stats = nullptr;

	bool bVideoReady = false;   // 视频/音频管线是否已就绪（hello 上报）
	FString StartupErrorCode;   // 非空 = 启动期视频管线失败原因
	FString StartupErrorDetail;

	TSharedPtr<IWebSocket> Socket;
	FTSTicker::FDelegateHandle TickerHandle;

	std::atomic<bool> bWantConnected{ false };
	std::atomic<bool> bReady{ false };
	double NextReconnectAt = 0.0;
	double NextHeartbeatAt = 0.0;

	// input state
	FVector2D LastMousePos = FVector2D::ZeroVector;
	bool bHasMousePos = false;
	TSet<FKey> PressedButtons;
};
