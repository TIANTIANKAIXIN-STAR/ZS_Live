// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "StreamForgeTypes.h"
#include "SFMediaFormat.h"
#include "ISubmixBufferListener.h"
#include "AudioEncoder.h"

class FSFRtmpPusher;

/**
 * Captures the master submix, encodes to AAC (Windows WMF) or G.711 PCMA
 * (cross-platform fallback) and pushes FLV audio tags into the RTMP pusher.
 */
class FSFAudioPipeline : public ISubmixBufferListener
#if PLATFORM_WINDOWS
	, public AVEncoder::IAudioEncoderListener
#endif
{
public:
	FSFAudioPipeline();
	~FSFAudioPipeline();

	bool Initialize(const FSFSettings& InSettings, FSFStats* InStats, FSFRtmpPusher* InPusher);
	void Start();
	void Stop();

	//~ ISubmixBufferListener
	virtual void OnNewSubmixBuffer(const USoundSubmix* OwningSubmix, float* AudioData, int32 NumSamples, int32 NumChannels, const int32 SampleRate, double AudioClock) override;

#if PLATFORM_WINDOWS
	//~ AVEncoder::IAudioEncoderListener
	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	virtual void OnEncodedAudioFrame(const AVEncoder::FMediaPacket& Packet) override;
	PRAGMA_ENABLE_DEPRECATION_WARNINGS
#endif

	void InvalidateTags() { AudioTagBuilder.Invalidate(); }

private:
	void ProcessAac(float* AudioData, int32 NumSamples, int32 NumChannels, int32 SampleRate, double AudioClock);
	void ProcessPcma(float* AudioData, int32 NumSamples, int32 NumChannels, int32 SampleRate);

	FSFSettings Settings;
	FSFStats* Stats = nullptr;
	FSFRtmpPusher* Pusher = nullptr;

	bool bUseAac = false;

	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	TUniquePtr<AVEncoder::FAudioEncoder> AacEncoder;
	PRAGMA_ENABLE_DEPRECATION_WARNINGS

	SFMediaFormat::FAudioTagBuilder AudioTagBuilder;

	// PCMA accumulation state (audio thread only)
	TArray<float> PcmaPending;      // interleaved stereo float samples
	int64 PcmaSamplesWritten = 0;  // mono 8kHz samples pushed so far

	// mixing scratch
	Audio::FAlignedFloatBuffer MixScratch;

	FCriticalSection AudioCS;
	bool bRunning = false;
};
