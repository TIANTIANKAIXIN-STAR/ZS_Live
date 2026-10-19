// Copyright ZS Live Platform. All Rights Reserved.

#include "SFControlChannel.h"
#include "SFLog.h"

#include "Framework/Application/SlateApplication.h"
#include "Engine/GameEngine.h"
#include "Engine/GameViewportClient.h"
#include "UnrealClient.h"
#include "InputKeyEventArgs.h"
#include "GameFramework/PlayerController.h"
#include "Input/Events.h"
#include "InputCoreTypes.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WebSocketsModule.h"
#include "IWebSocket.h"
#include "Async/Async.h"
#include "Misc/App.h"

namespace
{
	/** Maps JS KeyboardEvent.code strings to UE FKey. */
	const TMap<FString, FKey>& GetKeyMap()
	{
		static TMap<FString, FKey> Map;
		if (Map.Num() == 0)
		{
			for (char C = 'A'; C <= 'Z'; ++C)
			{
				Map.Add(FString::Printf(TEXT("Key%c"), C), FKey(FName(*FString::Printf(TEXT("%c"), C))));
			}
			for (char C = '0'; C <= '9'; ++C)
			{
				Map.Add(FString::Printf(TEXT("Digit%d"), C - '0'), FKey(FName(*FString::Printf(TEXT("%c"), C))));
			}
			Map.Add(TEXT("Space"), EKeys::SpaceBar);
			Map.Add(TEXT("Enter"), EKeys::Enter);
			Map.Add(TEXT("Backspace"), EKeys::BackSpace);
			Map.Add(TEXT("Tab"), EKeys::Tab);
			Map.Add(TEXT("Escape"), EKeys::Escape);
			Map.Add(TEXT("ArrowLeft"), EKeys::Left);
			Map.Add(TEXT("ArrowRight"), EKeys::Right);
			Map.Add(TEXT("ArrowUp"), EKeys::Up);
			Map.Add(TEXT("ArrowDown"), EKeys::Down);
			Map.Add(TEXT("PageUp"), EKeys::PageUp);
			Map.Add(TEXT("PageDown"), EKeys::PageDown);
			Map.Add(TEXT("Home"), EKeys::Home);
			Map.Add(TEXT("End"), EKeys::End);
			Map.Add(TEXT("Insert"), EKeys::Insert);
			Map.Add(TEXT("Delete"), EKeys::Delete);
			Map.Add(TEXT("ShiftLeft"), EKeys::LeftShift);
			Map.Add(TEXT("ShiftRight"), EKeys::RightShift);
			Map.Add(TEXT("ControlLeft"), EKeys::LeftControl);
			Map.Add(TEXT("ControlRight"), EKeys::RightControl);
			Map.Add(TEXT("AltLeft"), EKeys::LeftAlt);
			Map.Add(TEXT("AltRight"), EKeys::RightAlt);
			Map.Add(TEXT("F1"), EKeys::F1);   Map.Add(TEXT("F2"), EKeys::F2);
			Map.Add(TEXT("F3"), EKeys::F3);   Map.Add(TEXT("F4"), EKeys::F4);
			Map.Add(TEXT("F5"), EKeys::F5);   Map.Add(TEXT("F6"), EKeys::F6);
			Map.Add(TEXT("F7"), EKeys::F7);   Map.Add(TEXT("F8"), EKeys::F8);
			Map.Add(TEXT("F9"), EKeys::F9);   Map.Add(TEXT("F10"), EKeys::F10);
			Map.Add(TEXT("F11"), EKeys::F11); Map.Add(TEXT("F12"), EKeys::F12);
			Map.Add(TEXT("Minus"), EKeys::Hyphen);
			Map.Add(TEXT("Equal"), EKeys::Equals);
			Map.Add(TEXT("BracketLeft"), EKeys::LeftBracket);
			Map.Add(TEXT("BracketRight"), EKeys::RightBracket);
			Map.Add(TEXT("Semicolon"), EKeys::Semicolon);
			Map.Add(TEXT("Quote"), EKeys::Quote);
			Map.Add(TEXT("Backquote"), EKeys::Tilde);
			Map.Add(TEXT("Comma"), EKeys::Comma);
			Map.Add(TEXT("Period"), EKeys::Period);
			Map.Add(TEXT("Slash"), EKeys::Slash);
			Map.Add(TEXT("Backslash"), EKeys::Backslash);
			Map.Add(TEXT("Numpad0"), EKeys::NumPadZero);
			Map.Add(TEXT("Numpad1"), EKeys::NumPadOne);
			Map.Add(TEXT("Numpad2"), EKeys::NumPadTwo);
			Map.Add(TEXT("Numpad3"), EKeys::NumPadThree);
			Map.Add(TEXT("Numpad4"), EKeys::NumPadFour);
			Map.Add(TEXT("Numpad5"), EKeys::NumPadFive);
			Map.Add(TEXT("Numpad6"), EKeys::NumPadSix);
			Map.Add(TEXT("Numpad7"), EKeys::NumPadSeven);
			Map.Add(TEXT("Numpad8"), EKeys::NumPadEight);
			Map.Add(TEXT("Numpad9"), EKeys::NumPadNine);
			Map.Add(TEXT("NumpadEnter"), EKeys::Enter);
			Map.Add(TEXT("NumpadAdd"), EKeys::Add);
			Map.Add(TEXT("NumpadSubtract"), EKeys::Subtract);
			Map.Add(TEXT("NumpadMultiply"), EKeys::Multiply);
			Map.Add(TEXT("NumpadDivide"), EKeys::Divide);
			Map.Add(TEXT("NumpadDecimal"), EKeys::Decimal);
		}
		return Map;
	}

	FKey ButtonNameToKey(const FString& Button)
	{
		if (Button == TEXT("0") || Button == TEXT("left"))  return EKeys::LeftMouseButton;
		if (Button == TEXT("1") || Button == TEXT("middle")) return EKeys::MiddleMouseButton;
		if (Button == TEXT("2") || Button == TEXT("right")) return EKeys::RightMouseButton;
		if (Button == TEXT("3") || Button == TEXT("back"))  return EKeys::ThumbMouseButton;
		if (Button == TEXT("4") || Button == TEXT("forward")) return EKeys::ThumbMouseButton2;
		return EKeys::LeftMouseButton;
	}

	FString GetJsonString(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key)
	{
		FString V;
		return Obj->TryGetStringField(Key, V) ? V : FString();
	}

	double GetJsonDouble(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, double Default = 0)
	{
		double V;
		return Obj->TryGetNumberField(Key, V) ? V : Default;
	}

	bool GetJsonBool(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, bool Default = false)
	{
		bool V;
		return Obj->TryGetBoolField(Key, V) ? V : Default;
	}

	FModifierKeysState MakeMods(bool bCtrl, bool bShift, bool bAlt)
	{
		return FModifierKeysState(bShift, bShift, bCtrl, bCtrl, bAlt, bAlt, false, false, false);
	}

	/**
	 * 云渲染实例的窗口通常没有操作系统焦点（服务进程拉起 / 离屏渲染），
	 * Slate 会把键盘事件路由给"当前聚焦的 Slate 控件"——没有聚焦控件时事件直接丢弃，
	 * 游戏永远收不到输入。
	 *
	 * 但**每次**注入前都强制抢回 GameViewport 焦点会把已经聚焦的 UMG 文本框/控制台输入框
	 * 的焦点抢走，造成三个连锁问题：
	 *   1) FCharacterEvent 路由到视口而非文本框 → 控制台/UMG 文字打不进去
	 *   2) Slate 焦点链被反复重置，UMG 按钮的命中测试拿不到一致焦点 → 点击无响应
	 *   3) 滚轮事件链同样因焦点抖动而断裂 → 场景滚轮无效果
	 * 走 FKeyEvent 触发的非文本动作（3xL 弹窗、`~` 开控制台）不受影响，因为它们依赖
	 * 视口级监听而非文本框焦点。
	 *
	 * 修正：仅在**首次**输入时设一次焦点（lazy init），之后让 Slate 走自然焦点链。
	 * 控件打开/被点击时焦点会自然转移；不再人为抢回。
	 */
	std::atomic<bool> bFocusEnsured{false};
	void EnsureGameViewportFocus()
	{
		if (bFocusEnsured.load(std::memory_order_acquire))
		{
			return;
		}
		if (FSlateApplication::IsInitialized())
		{
			FSlateApplication::Get().SetAllUserFocusToGameViewport();
			bFocusEnsured.store(true, std::memory_order_release);
		}
	}
}

FSFControlChannel::FSFControlChannel() = default;
FSFControlChannel::~FSFControlChannel()
{
	Stop();
}

bool FSFControlChannel::Initialize(const FSFSettings& InSettings, FSFStats* InStats)
{
	Settings = InSettings;
	Stats = InStats;
	return true;
}

void FSFControlChannel::Start()
{
	if (bWantConnected.exchange(true))
	{
		return;
	}
	NextReconnectAt = 0;
	Connect();

	TickerHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateRaw(this, &FSFControlChannel::TickStats), 1.0f);
}

void FSFControlChannel::Stop()
{
	if (!bWantConnected.exchange(false))
	{
		return;
	}
	if (TickerHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(TickerHandle);
		TickerHandle.Reset();
	}
	// 关键：先解绑全部委托再 Close/Reset。Close() 是异步的——close/connected/error
	// 事件由 WS 模块在之后的游戏线程泵里晚到，若委托还挂着（且对象随后被 delete），
	// 晚到事件会打进已释放内存（2026-10-12 UAF 事故：Ticker 表损坏 + 60s 后随机崩溃）。
	if (Socket.IsValid())
	{
		Socket->OnConnected().RemoveAll(this);
		Socket->OnMessage().RemoveAll(this);
		Socket->OnClosed().RemoveAll(this);
		Socket->OnConnectionError().RemoveAll(this);
		Socket->Close();
		Socket.Reset();
	}
}

void FSFControlChannel::Connect()
{
	if (!bWantConnected || Socket.IsValid())
	{
		return;
	}

	TMap<FString, FString> Headers;
	Headers.Add(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *Settings.AgentToken));
	Headers.Add(TEXT("X-SF-InstanceId"), Settings.InstanceId);

	FString Url = Settings.AgentUrl;
	if (!Url.Contains(TEXT("?")))
	{
		Url += FString::Printf(TEXT("?instanceId=%s"), *Settings.InstanceId);
	}

	Socket = FWebSocketsModule::Get().CreateWebSocket(Url, FString(), Headers);

	Socket->OnConnected().AddRaw(this, &FSFControlChannel::SendHello);
	Socket->OnMessage().AddRaw(this, &FSFControlChannel::HandleMessage);
	Socket->OnConnectionError().AddRaw(this, &FSFControlChannel::HandleConnectError);
	Socket->OnClosed().AddRaw(this, &FSFControlChannel::HandleClosed);

	Socket->Connect();
	UE_LOG(LogStreamForge, Log, TEXT("[Agent] Connecting to %s"), *Url);
}

void FSFControlChannel::HandleConnectError(const FString& Err)
{
	UE_LOG(LogStreamForge, Warning, TEXT("[Agent] Connect error: %s"), *Err);
}

void FSFControlChannel::HandleClosed(int32 Code, const FString& Reason, bool bClean)
{
	UE_LOG(LogStreamForge, Log, TEXT("[Agent] Closed (code=%d clean=%d): %s"), Code, bClean, *Reason);
	if (Socket.IsValid())
	{
		Socket.Reset();
	}
	if (Stats) Stats->bAgentConnected = false;
	NextReconnectAt = FPlatformTime::Seconds() + 3.0;
}

void FSFControlChannel::SendHello()
{
	if (Stats) Stats->bAgentConnected = true;
	UE_LOG(LogStreamForge, Log, TEXT("[Agent] Connected"));

	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("t"), TEXT("hello"));
	Obj->SetStringField(TEXT("instanceId"), Settings.InstanceId);
	Obj->SetNumberField(TEXT("pid"), FPlatformProcess::GetCurrentProcessId());
	Obj->SetStringField(TEXT("platform"), FPlatformProperties::IniPlatformName());
	Obj->SetNumberField(TEXT("width"), Settings.Width);
	Obj->SetNumberField(TEXT("height"), Settings.Height);
	Obj->SetNumberField(TEXT("fps"), Settings.Fps);
	Obj->SetNumberField(TEXT("bitrateKbps"), Settings.BitrateKbps);
	Obj->SetStringField(TEXT("audioCodec"), Settings.AudioCodec);
	// 视频管线状态：false = agent 已连但推流未建立（服务端不应视作 ready）
	Obj->SetBoolField(TEXT("videoReady"), bVideoReady);
	if (!StartupErrorCode.IsEmpty())
	{
		TSharedPtr<FJsonObject> Err = MakeShared<FJsonObject>();
		Err->SetStringField(TEXT("code"), StartupErrorCode);
		Err->SetStringField(TEXT("detail"), StartupErrorDetail);
		Obj->SetObjectField(TEXT("error"), Err);
	}

	FString Out;
	auto Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	SendJson(Out);
}

bool FSFControlChannel::SendJson(const FString& Json)
{
	if (!Socket.IsValid() || !Socket->IsConnected())
	{
		return false;
	}
	Socket->Send(Json);
	return true;
}

bool FSFControlChannel::SendEvent(const FString& Name, const FString& Data)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("t"), TEXT("event"));
	Obj->SetStringField(TEXT("name"), Name);
	Obj->SetStringField(TEXT("data"), Data);
	FString Out;
	auto Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return SendJson(Out);
}

bool FSFControlChannel::IsConnected() const
{
	return Socket.IsValid() && Socket->IsConnected();
}

bool FSFControlChannel::TickStats(float Dt)
{
	const double Now = FPlatformTime::Seconds();

	// reconnect logic
	if (bWantConnected && !Socket.IsValid() && NextReconnectAt > 0 && Now >= NextReconnectAt)
	{
		Connect();
	}

	// heartbeat
	if (Socket.IsValid() && Socket->IsConnected() && Now >= NextHeartbeatAt)
	{
		NextHeartbeatAt = Now + 2.0;
		TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
		Obj->SetStringField(TEXT("t"), TEXT("heartbeat"));
		TSharedPtr<FJsonObject> S = MakeShared<FJsonObject>();
		if (Stats)
		{
			S->SetNumberField(TEXT("fps"), Stats->EncodedFps.load());
			S->SetNumberField(TEXT("encodeMs"), Stats->EncodeMs.load());
			S->SetNumberField(TEXT("sentMB"), (double)Stats->SentBytes.load() / 1048576.0);
			S->SetNumberField(TEXT("reconnects"), Stats->ReconnectCount.load());
			S->SetNumberField(TEXT("dropped"), Stats->DroppedFrames.load());
			S->SetBoolField(TEXT("rtmpOk"), Stats->bRtmpPublishing.load());
		}
		Obj->SetObjectField(TEXT("stats"), S);
		FString Out;
		auto Writer = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
		SendJson(Out);
	}
	return true;
}

void FSFControlChannel::HandleMessage(const FString& Message)
{
	TSharedPtr<FJsonObject> Obj;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
	if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
	{
		return;
	}

	const FString Type = GetJsonString(Obj, TEXT("t"));

	if (Type == TEXT("ping"))
	{
		TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
		P->SetStringField(TEXT("t"), TEXT("pong"));
		FString Out;
		auto Writer = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(P.ToSharedRef(), Writer);
		SendJson(Out);
		return;
	}

	if (Type == TEXT("command"))
	{
		const FString Name = GetJsonString(Obj, TEXT("name"));
		const FString Payload = GetJsonString(Obj, TEXT("payload"));
		AsyncTask(ENamedThreads::GameThread, [this, Name, Payload]()
		{
			if (OnCommand)
			{
				OnCommand(Name, Payload);
			}
		});
		return;
	}

	if (Type == TEXT("stop"))
	{
		UE_LOG(LogStreamForge, Warning, TEXT("[Agent] Server requested stop"));
		if (OnStopRequest)
		{
			OnStopRequest();
		}
		return;
	}

	if (Type == TEXT("control"))
	{
		if (!Settings.bEnableInput)
		{
			return;
		}
		const TSharedPtr<FJsonObject>* EvtObj = nullptr;
		if (!Obj->TryGetObjectField(TEXT("e"), EvtObj) || !EvtObj->IsValid())
		{
			return;
		}
		const TSharedPtr<FJsonObject> Evt = *EvtObj;
		const FString EventName = GetJsonString(Evt, TEXT("type"));

		// raw event passthrough
		if (OnControlEvent)
		{
			FString Raw;
			auto Writer = TJsonWriterFactory<>::Create(&Raw);
			FJsonSerializer::Serialize(Evt.ToSharedRef(), Writer);
			AsyncTask(ENamedThreads::GameThread, [this, Raw]()
			{
				if (OnControlEvent)
				{
					OnControlEvent(TEXT(""), Raw);
				}
			});
		}

		const TSharedPtr<FJsonObject>* ModsObj = nullptr;
		Obj->TryGetObjectField(TEXT("mods"), ModsObj);
		const bool bCtrl = ModsObj && (*ModsObj)->HasField(TEXT("ctrl")) ? GetJsonBool(*ModsObj, TEXT("ctrl")) : false;
		const bool bShift = ModsObj && (*ModsObj)->HasField(TEXT("shift")) ? GetJsonBool(*ModsObj, TEXT("shift")) : false;
		const bool bAlt = ModsObj && (*ModsObj)->HasField(TEXT("alt")) ? GetJsonBool(*ModsObj, TEXT("alt")) : false;

		if (EventName == TEXT("keydown"))
		{
			const FString Key = GetJsonString(Evt, TEXT("key"));
			UE_LOG(LogStreamForge, Log, TEXT("[Agent] Input keydown: %s"), *Key);
			InjectKeyDown(Key, bCtrl, bShift, bAlt,
				(uint32)GetJsonDouble(Evt, TEXT("charCode"), 0));
		}
		else if (EventName == TEXT("keyup"))
		{
			const FString Key = GetJsonString(Evt, TEXT("key"));
			UE_LOG(LogStreamForge, Log, TEXT("[Agent] Input keyup: %s"), *Key);
			InjectKeyUp(Key, bCtrl, bShift, bAlt);
		}
		else if (EventName == TEXT("mousemove"))
		{
			InjectMouseMove(GetJsonDouble(Evt, TEXT("x"), 0.5), GetJsonDouble(Evt, TEXT("y"), 0.5));
		}
		else if (EventName == TEXT("mousedown"))
		{
			const FString Btn = GetJsonString(Evt, TEXT("button"));
			UE_LOG(LogStreamForge, Log, TEXT("[Agent] Input mousedown: %s"), *Btn);
			InjectMouseButton(Btn, true);
		}
		else if (EventName == TEXT("mouseup"))
		{
			InjectMouseButton(GetJsonString(Evt, TEXT("button")), false);
		}
		else if (EventName == TEXT("wheel"))
		{
			UE_LOG(LogStreamForge, Log, TEXT("[Agent] Input wheel deltaY=%.0f"), GetJsonDouble(Evt, TEXT("delta"), 0));
			InjectWheel(GetJsonDouble(Evt, TEXT("delta"), 0));
		}
	}
}

void FSFControlChannel::InjectKeyDown(const FString& KeyName, bool bCtrl, bool bShift, bool bAlt, uint32 CharCode)
{
	AsyncTask(ENamedThreads::GameThread, [this, KeyName, bCtrl, bShift, bAlt, CharCode]()
	{
		const FKey* Key = GetKeyMap().Find(KeyName);
		if (!Key)
		{
			return;
		}
		EnsureGameViewportFocus();
		PressedButtons.Add(*Key);
		FKeyEvent Ev(*Key, MakeMods(bCtrl, bShift, bAlt), 0, false, CharCode, CharCode);
		FSlateApplication::Get().ProcessKeyDownEvent(Ev);
		// 可打印字符必须补发字符事件：Slate 文本框（控制台/登录框/聊天栏等）
		// 走 OnKeyChar 收字符，只发按键事件会导致"字母打不进任何文本输入框"。
		if (CharCode >= 32)
		{
			FCharacterEvent CharEv((TCHAR)CharCode, MakeMods(bCtrl, bShift, bAlt), 0, false);
			FSlateApplication::Get().ProcessKeyCharEvent(CharEv);
		}
	});
}

void FSFControlChannel::InjectKeyUp(const FString& KeyName, bool bCtrl, bool bShift, bool bAlt)
{
	AsyncTask(ENamedThreads::GameThread, [this, KeyName, bCtrl, bShift, bAlt]()
	{
		const FKey* Key = GetKeyMap().Find(KeyName);
		if (!Key)
		{
			return;
		}
		EnsureGameViewportFocus();
		PressedButtons.Remove(*Key);
		FKeyEvent Ev(*Key, MakeMods(bCtrl, bShift, bAlt), 0, false, 0, 0);
		FSlateApplication::Get().ProcessKeyUpEvent(Ev);
	});
}

void FSFControlChannel::InjectMouseMove(double Nx, double Ny)
{
	AsyncTask(ENamedThreads::GameThread, [this, Nx, Ny]()
	{
		EnsureGameViewportFocus();
		FVector2D Size(1280, 720);
		if (GEngine && GEngine->GameViewport && GEngine->GameViewport->Viewport)
		{
			Size = FVector2D(GEngine->GameViewport->Viewport->GetSizeXY());
		}
		const FVector2D NewPos(Nx * Size.X, Ny * Size.Y);
		const FVector2D OldPos = bHasMousePos ? LastMousePos : NewPos;
		LastMousePos = NewPos;
		bHasMousePos = true;

		FPointerEvent Ev(0, NewPos, OldPos, PressedButtons, EKeys::Invalid, 0.f, FModifierKeysState());
		FSlateApplication::Get().ProcessMouseMoveEvent(Ev);
	});
}

void FSFControlChannel::InjectMouseButton(const FString& Button, bool bDown)
{
	AsyncTask(ENamedThreads::GameThread, [this, Button, bDown]()
	{
		EnsureGameViewportFocus();
		const FKey Btn = ButtonNameToKey(Button);
		if (bDown)
		{
			PressedButtons.Add(Btn);
		}
		else
		{
			PressedButtons.Remove(Btn);
		}
		const FVector2D Pos = bHasMousePos ? LastMousePos : FVector2D::ZeroVector;
		FPointerEvent Ev(0, 0, Pos, Pos, PressedButtons, Btn, 0.f, FModifierKeysState());
		if (bDown)
		{
			TSharedPtr<FGenericWindow> NativeWindow;
			if (GEngine && GEngine->GameViewport && GEngine->GameViewport->GetWindow().IsValid())
			{
				NativeWindow = GEngine->GameViewport->GetWindow()->GetNativeWindow();
			}
			FSlateApplication::Get().ProcessMouseButtonDownEvent(NativeWindow, Ev);
		}
		else
		{
			FSlateApplication::Get().ProcessMouseButtonUpEvent(Ev);
		}
	});
}

void FSFControlChannel::InjectWheel(double Delta)
{
	AsyncTask(ENamedThreads::GameThread, [this, Delta]()
	{
		// 前端传浏览器 wheel.deltaY（正=向下）。UE/Windows WheelDelta：正=向上。
		if (!FMath::IsFinite(Delta) || FMath::IsNearlyZero(Delta))
		{
			return;
		}
		EnsureGameViewportFocus();

		// 归一化为 ±1 刻度（等同 WM_MOUSEWHEEL ÷ WHEEL_DELTA）。
		// 旧逻辑把 ±100 像素增量直接当轴值，且符号与 UE 相反，表现为「滚轮没连上」。
		const float WheelDelta = (Delta > 0.0) ? -1.f : 1.f;

		if (!(GEngine && GEngine->GameViewport && GEngine->GameViewport->Viewport))
		{
			return;
		}

		FViewport* VP = GEngine->GameViewport->Viewport;
		const FInputDeviceId DeviceId = FInputDeviceId::CreateFromInternalId(0);
		const FKey Key = WheelDelta > 0.f ? EKeys::MouseScrollUp : EKeys::MouseScrollDown;

		// 离屏下不走 ProcessMouseWheelOrGestureEvent：无真实光标时命中常失败或假 handled，
		// 且与下方直连叠加会滚轮加倍。与 FSceneViewport::OnMouseWheel 对齐，直连 ViewportClient。
		GEngine->GameViewport->InputKey(FInputKeyEventArgs(VP, DeviceId, Key, EInputEvent::IE_Pressed, 1.0f, false, 0u));
		GEngine->GameViewport->InputKey(FInputKeyEventArgs(VP, DeviceId, Key, EInputEvent::IE_Released, 1.0f, false, 0u));
		GEngine->GameViewport->InputAxis(FInputKeyEventArgs(VP, DeviceId, EKeys::MouseWheelAxis, WheelDelta, FApp::GetDeltaTime(), 1, 0u));

		UE_LOG(LogStreamForge, Log, TEXT("[Agent] wheel browserDelta=%.0f -> ue=%.1f (%s)"),
			Delta, WheelDelta, WheelDelta > 0.f ? TEXT("ScrollUp") : TEXT("ScrollDown"));
	});
}
