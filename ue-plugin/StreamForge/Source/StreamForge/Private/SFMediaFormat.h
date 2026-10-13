// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

/**
 * Media format helpers: H264 AnnexB <-> AVCC, AVCDecoderConfigurationRecord
 * (FLV sequence header) construction, AAC AudioSpecificConfig, G.711 A-law.
 */
namespace SFMediaFormat
{
	/** Iterates NAL units of an AnnexB byte stream. Returns false when no start code found. */
	typedef TFunctionRef<void(uint8 NalType, const uint8* Data, uint32 Len)> FOnNal;
	bool ForEachAnnexBNal(const uint8* Data, uint32 Size, FOnNal OnNal);

	/** Converts an AnnexB H264 access unit into AVCC (4 byte length prefixed). */
	bool AnnexBToAvcc(const uint8* Data, uint32 Size, TArray<uint8>& OutAvcc);

	/** A-law encode a 16-bit PCM sample. */
	uint8 LinearToAlaw(int16 Pcm);

	/** AAC sample rate table index (returns -1 when unsupported). */
	int32 SampleRateToAacIndex(int32 SampleRate);

	/** Builds the 2 byte AudioSpecificConfig for AAC-LC. */
	void BuildAudioSpecificConfig(int32 SampleRate, int32 Channels, TArray<uint8>& Out);

	/**
	 * Tracks SPS/PPS seen in the encoded stream and builds FLV video tags.
	 * Thread-safe enough for single producer (the encoder callback thread).
	 */
	class FVideoTagBuilder
	{
	public:
		/**
		 * Builds FLV video tags. Sequence header and coded frame are emitted as SEPARATE
		 * tags (OutSeqTag may be empty): one RTMP message must carry exactly one FLV tag,
		 * concatenating both into a single message corrupts the AVC config and drops the
		 * keyframe payload on the server.
		 */
		void Build(const uint8* AnnexBData, uint32 Size, bool bKeyFrame, TArray<uint8>& OutSeqTag, TArray<uint8>& OutFrameTag);

		/** Force re-sending of the sequence header with the next keyframe (e.g. after reconnect). */
		void Invalidate() { bSeqSent = false; }

		bool HasConfig() const { return Sps.Num() > 0 && Pps.Num() > 0; }

	private:
		TArray<uint8> Sps;
		TArray<uint8> Pps;
		bool bSeqSent = false;
	};

	/** Builds FLV audio tags. */
	class FAudioTagBuilder
	{
	public:
		enum class ECodec : uint8 { AAC, PCMA, None };

		void Init(ECodec InCodec, int32 SampleRate, int32 Channels);

		/** AAC: expects a raw AAC frame (ADTS stripped already). Sequence header and frame are emitted as separate tags (OutSeqTag may be empty). */
		void BuildAac(const uint8* Frame, uint32 Size, TArray<uint8>& OutSeqTag, TArray<uint8>& OutFrameTag);

		/** PCMA: expects raw G.711 A-law bytes. */
		void BuildPcma(const uint8* AlawData, uint32 Size, TArray<uint8>& OutTag);

		void Invalidate() { bSeqSent = false; }

	private:
		ECodec Codec = ECodec::None;
		int32 SampleRate = 48000;
		int32 Channels = 2;
		bool bSeqSent = false;
	};
};
