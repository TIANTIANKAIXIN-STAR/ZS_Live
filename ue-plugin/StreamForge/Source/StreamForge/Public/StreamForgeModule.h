// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "StreamForgeTypes.h"

class UStreamForgeSubsystem;

/**
 * Public module interface for StreamForge.
 */
class IStreamForgeModule : public IModuleInterface
{
public:
	static inline IStreamForgeModule& Get()
	{
		return FModuleManager::LoadModuleChecked<IStreamForgeModule>(TEXT("StreamForge"));
	}

	virtual bool IsStreaming() const = 0;
	virtual bool SendEventToBrowser(const FString& Name, const FString& Data) = 0;
	virtual void RequestKeyFrame() = 0;
	virtual void SetBitrate(int32 Kbps) = 0;
	virtual FString GetStatsJson() const = 0;
};

/** Small indirection so the subsystem can be reached from the module (non-UObject code). */
namespace ModuleManagerHack
{
	extern STREAMFORGE_API UStreamForgeSubsystem* GSubsystem;
	STREAMFORGE_API void SetSubsystem(UStreamForgeSubsystem* InSubsystem);
}
