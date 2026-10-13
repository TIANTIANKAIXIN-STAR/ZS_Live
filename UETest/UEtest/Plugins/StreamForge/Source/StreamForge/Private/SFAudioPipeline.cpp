// Copyright ZS Live Platform. All Rights Reserved.

#include "SFAudioPipeline.h"
#include "SFRtmpPusher.h"
#include "SFLog.h"

#include "Engine/GameEngine.h"
#include "AudioDevice.h"
#include "AudioEncoderFactory.h"
#include "AudioEncoder.h"
#include "MediaPacket.h"

FSFAudioPipeline::FSFAudioPipeline() = default;

FSFAudioPipeline::~FSFAudioPipeline()
{
	Stop();
}

bool FSFAudioPipeline::Initialize(const FSFSettings& InSettings, FSFStats* InStats, FSFRtmpPusher* InPusher)
{
	Settings = InSettings;
	Stats = InStats;
	Pusher = InPusher;

	FString Codec = Settings.AudioCodec.ToLower();
	if (Codec == TEXT("auto"))
	{
#if PLATFORM_WINDOWS
		Codec = TEXT("aac");
#else
		Codec = TEXT("pcma");
#endif
	}

	if (Codec == TEXT("none") || !Settings.bEnableAudio)
	{
		UE_LOG(LogStreamForge, Log, TEXT("[Audio] Disabled"));
		return true;
	}

	if (Codec == TEXT("aac"))
	{
#if PLATFORM_WINDOWS
		PRAGMA_DISABLE_DEPRECATION_WARNINGS
		AVEncoder::FAudioEncoderFactory* Factory = AVEncoder::FAudioEncoderFactory::FindFactory("aac");
		if (!Factory)
		{
			UE_LOG(LogStreamForge, Warning, TEXT("[Audio] AAC encoder unavailable, falling back to PCMA"));
			Codec = TEXT("pcma");
		}
		else
		{
			AacEncoder = Factory->CreateEncoder("aac");
			AVEncoder::FAudioConfig Config;
			Config.Samplerate = 48000;
			Config.NumChannels = 2;
			Config.Bitrate = Settings.AudioBitrateKbps * 1000;
			if (!AacEncoder.IsValid() || !AacEncoder->Initialize(Config))
			{
				UE_LOG(LogStreamForge, Warning, TEXT("[Audio] AAC init failed, falling back to PCMA"));
				AacEncoder.Reset();
				Codec = TEXT("pcma");
			}
			else
			{
				AacEncoder->RegisterListener(*this);
			}
		}
		PRAGMA_ENABLE_DEPRECATION_WARNINGS
#else
		UE_LOG(LogStreamForge, Warning, TEXT("[Audio] AAC not supported on this platform, using PCMA"));
		Codec = TEXT("pcma");
#endif
	}

	bUseAac = (Codec == TEXT("aac"));
	AudioTagBuilder.Init(bUseAac ? SFMediaFormat::FAudioTagBuilder::ECodec::AAC : SFMediaFormat::FAudioTagBuilder::ECodec::PCMA,
	                     48000, 2);
	PcmaSamplesWritten = 0;

	UE_LOG(LogStreamForge, Log, TEXT("[Audio] Codec=%s"), bUseAac ? TEXT("AAC 48k stereo") : TEXT("G.711 PCMA 8k mono"));
	return true;
}

void FSFAudioPipeline::Start()
{
	if (bRunning)
	{
		return;
	}
	bRunning = true;

	FAudioDeviceHandle AudioDevice = GEngine ? GEngine->GetMainAudioDevice() : FAudioDeviceHandle();
	if (AudioDevice.IsValid())
	{
		AudioDevice->RegisterSubmixBufferListener(AsShared(), AudioDevice->GetMainSubmixObject());
		UE_LOG(LogStreamForge, Log, TEXT("[Audio] Submix listener registered"));
	}
	else
	{
		UE_LOG(LogStreamForge, Warning, TEXT("[Audio] No audio device, streaming without sound"));
	}
}

void FSFAudioPipeline::Stop()
{
	if (!bRunning)
	{
		return;
	}
	bRunning = false;

	UGameEngine* GameEngine = Cast<UGameEngine>(GEngine);
	if (GameEngine)
	{
		if (FAudioDevice* AudioDevice = GameEngine->GetMainAudioDeviceRaw())
		{
			AudioDevice->UnregisterSubmixBufferListener(AsShared(), AudioDevice->GetMainSubmixObject());
		}
	}

	FScopeLock Lock(&AudioCS);
	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	if (AacEncoder)
	{
		AacEncoder->Shutdown();
		AacEncoder.Reset();
	}
	PRAGMA_ENABLE_DEPRECATION_WARNINGS
}

void FSFAudioPipeline::OnNewSubmixBuffer(const USoundSubmix* OwningSubmix, float* AudioData, int32 NumSamples, int32 NumChannels, const int32 SampleRate, double AudioClock)
{
	if (!bRunning)
	{
		return;
	}

	FScopeLock Lock(&AudioCS);
	if (bUseAac)
	{
		ProcessAac(AudioData, NumSamples, NumChannels, SampleRate, AudioClock);
	}
	else
	{
		ProcessPcma(AudioData, NumSamples, NumChannels, SampleRate);
	}
}

void FSFAudioPipeline::ProcessAac(float* AudioData, int32 NumSamples, int32 NumChannels, int32 SampleRate, double AudioClock)
{
	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	if (!AacEncoder.IsValid())
	{
		return;
	}

	// mix to stereo
	Audio::FAlignedFloatBuffer InData;
	InData.Append(AudioData, NumSamples);
	Audio::TSampleBuffer<float> Buffer(InData, NumChannels, SampleRate);
	if (Buffer.GetNumChannels() != 2)
	{
		Buffer.MixBufferToChannels(2);
	}
	Buffer.Clamp();

	AVEncoder::FAudioFrame Frame;
	Frame.Timestamp = FTimespan::FromSeconds(AudioClock);
	Frame.Duration = FTimespan::FromSeconds(Buffer.GetSampleDuration());
	Frame.Data = MoveTemp(Buffer);
	AacEncoder->Encode(Frame);
	PRAGMA_ENABLE_DEPRECATION_WARNINGS
}

void FSFAudioPipeline::ProcessPcma(float* AudioData, int32 NumSamples, int32 NumChannels, int32 SampleRate)
{
	// 1. mix down to mono
	TArray<float> Mono;
	const int32 Frames = NumSamples / NumChannels;
	Mono.SetNumUninitialized(Frames);
	for (int32 I = 0; I < Frames; ++I)
	{
		float S = 0.f;
		for (int32 C = 0; C < NumChannels; ++C)
		{
			S += AudioData[I * NumChannels + C];
		}
		Mono[I] = S / NumChannels;
	}

	// 2. linear resample to 8 kHz, keeping phase + last sample across callbacks
	const double SrcToDst = 8000.0 / SampleRate;
	static thread_local bool bHasPrev = false;
	static thread_local float PrevSample = 0.f;
	static thread_local double Frac = 0.0; // fractional src position carried over

	TArray<uint8> Alaw;
	Alaw.Reserve((int32)(Frames * SrcToDst) + 8);

	const float* Src = Mono.GetData();
	double P = Frac;
	float Last = bHasPrev ? PrevSample : (Frames > 0 ? Src[0] : 0.f);
	while (P < (double)Frames)
	{
		const int32 I = (int32)P;
		const double T = P - I;
		const float S0 = (I == 0) ? Last : Src[I - 1];
		const float S1 = Src[I];
		const float S = S0 + (S1 - S0) * (float)T;
		Alaw.Add(SFMediaFormat::LinearToAlaw((int16)(S * 32767.f)));
		P += SrcToDst;
	}
	Frac = P - Frames;
	if (Frames > 0)
	{
		PrevSample = Src[Frames - 1];
		bHasPrev = true;
	}

	if (Alaw.Num() > 0)
	{
		TArray<uint8> Tag;
		AudioTagBuilder.BuildPcma(Alaw.GetData(), Alaw.Num(), Tag);
		const uint32 TsMs = (uint32)(PcmaSamplesWritten / 8.0);
		Pusher->EnqueueAudio(MoveTemp(Tag), TsMs);
		PcmaSamplesWritten += Alaw.Num();
	}
}

#if PLATFORM_WINDOWS
void FSFAudioPipeline::OnEncodedAudioFrame(const AVEncoder::FMediaPacket& Packet)
{
	if (!Pusher || Packet.Data.Num() == 0)
	{
		return;
	}
	TArray<uint8> SeqTag;
	TArray<uint8> FrameTag;
	AudioTagBuilder.BuildAac(Packet.Data.GetData(), Packet.Data.Num(), SeqTag, FrameTag);
	const uint32 TsMs = (uint32)(Packet.Timestamp.GetTicks() / 10000); // ticks are 100ns
	if (SeqTag.Num() > 0)
	{
		Pusher->EnqueueAudio(MoveTemp(SeqTag), TsMs);
	}
	if (FrameTag.Num() > 0)
	{
		Pusher->EnqueueAudio(MoveTemp(FrameTag), TsMs);
	}
}
#endif
