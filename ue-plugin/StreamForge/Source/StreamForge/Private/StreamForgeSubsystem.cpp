// Copyright ZS Live Platform. All Rights Reserved.

#include "StreamForgeSubsystem.h"
#include "StreamForgeModule.h"
#include "StreamForgeTypes.h"

void UStreamForgeSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	ModuleManagerHack::SetSubsystem(this);
}

void UStreamForgeSubsystem::Deinitialize()
{
	ModuleManagerHack::SetSubsystem(nullptr);
	Super::Deinitialize();
}

bool UStreamForgeSubsystem::IsStreaming() const
{
	IStreamForgeModule* Module = FModuleManager::GetModulePtr<IStreamForgeModule>(TEXT("StreamForge"));
	return Module && Module->IsStreaming();
}

bool UStreamForgeSubsystem::SendEventToBrowser(const FString& Name, const FString& Data)
{
	IStreamForgeModule* Module = FModuleManager::GetModulePtr<IStreamForgeModule>(TEXT("StreamForge"));
	return Module ? Module->SendEventToBrowser(Name, Data) : false;
}

void UStreamForgeSubsystem::RequestKeyFrame()
{
	if (IStreamForgeModule* Module = FModuleManager::GetModulePtr<IStreamForgeModule>(TEXT("StreamForge")))
	{
		Module->RequestKeyFrame();
	}
}

void UStreamForgeSubsystem::SetBitrate(int32 Kbps)
{
	if (IStreamForgeModule* Module = FModuleManager::GetModulePtr<IStreamForgeModule>(TEXT("StreamForge")))
	{
		Module->SetBitrate(Kbps);
	}
}

FString UStreamForgeSubsystem::GetStatsJson() const
{
	IStreamForgeModule* Module = FModuleManager::GetModulePtr<IStreamForgeModule>(TEXT("StreamForge"));
	return Module ? Module->GetStatsJson() : TEXT("{}");
}

void UStreamForgeSubsystem::BroadcastCommand(const FString& Name, const FString& Payload)
{
	OnCommand.Broadcast(Name, Payload);
}

void UStreamForgeSubsystem::BroadcastControlEvent(const FString& EventName, const FString& Data)
{
	OnControlEvent.Broadcast(EventName, Data);
}
