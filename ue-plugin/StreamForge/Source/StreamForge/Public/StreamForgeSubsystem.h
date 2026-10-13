// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "StreamForgeSubsystem.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FSFCommandDelegate, const FString&, Name, const FString&, Payload);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FSFControlEventDelegate, const FString&, EventName, const FString&, Data);

/**
 * StreamForge runtime bridge for Blueprints.
 * Streaming itself starts automatically from command line arguments
 * (-SFInstanceId, -SFRtmpUrl, ...). This subsystem exposes events and status.
 */
UCLASS(BlueprintType)
class STREAMFORGE_API UStreamForgeSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/** Custom command sent from a browser page to this instance. */
	UPROPERTY(BlueprintAssignable, Category = "StreamForge")
	FSFCommandDelegate OnCommand;

	/** Raw control event (keydown / mousemove / ...) when -SFInputRawDelegate=1. */
	UPROPERTY(BlueprintAssignable, Category = "StreamForge")
	FSFControlEventDelegate OnControlEvent;

	/** True when the whole pipeline (capture + encoder + RTMP publish) is running. */
	UFUNCTION(BlueprintPure, Category = "StreamForge")
	bool IsStreaming() const;

	/** Send a custom event to the currently attached browser session. */
	UFUNCTION(BlueprintCallable, Category = "StreamForge")
	bool SendEventToBrowser(const FString& Name, const FString& Data);

	/** Request an immediate key frame (e.g. after a scene cut). */
	UFUNCTION(BlueprintCallable, Category = "StreamForge")
	void RequestKeyFrame();

	/** Change target bitrate (kbps) at runtime. */
	UFUNCTION(BlueprintCallable, Category = "StreamForge")
	void SetBitrate(int32 Kbps);

	/** Snapshot of runtime stats as a JSON string. */
	UFUNCTION(BlueprintPure, Category = "StreamForge")
	FString GetStatsJson() const;

	//~ Begin USubsystem
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;
	//~ End USubsystem

	void BroadcastCommand(const FString& Name, const FString& Payload);
	void BroadcastControlEvent(const FString& EventName, const FString& Data);
};
