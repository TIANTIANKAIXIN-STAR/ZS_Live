// Copyright ZS Live Platform. All Rights Reserved.

#include "SFMediaFormat.h"
#include "SFLog.h"


namespace SFMediaFormat
{
	namespace
	{
		/** Returns length of the AnnexB start code at offset, or 0. */
		FORCEINLINE uint32 StartCodeLen(const uint8* P, uint32 Size)
		{
			if (Size >= 4 && P[0] == 0 && P[1] == 0 && P[2] == 0 && P[3] == 1)
			{
				return 4;
			}
			if (Size >= 3 && P[0] == 0 && P[1] == 0 && P[2] == 1)
			{
				return 3;
			}
			return 0;
		}
	}

	bool ForEachAnnexBNal(const uint8* Data, uint32 Size, FOnNal OnNal)
	{
		uint32 I = 0;
		// find first start code
		while (I < Size)
		{
			uint32 L = StartCodeLen(Data + I, Size - I);
			if (L > 0)
			{
				break;
			}
			++I;
		}
		if (I >= Size)
		{
			return false;
		}

		while (I < Size)
		{
			uint32 Sc = StartCodeLen(Data + I, Size - I);
			check(Sc > 0);
			uint32 NalStart = I + Sc;
			uint32 J = NalStart;
			while (J < Size && StartCodeLen(Data + J, Size - J) == 0)
			{
				++J;
			}
			if (J > NalStart)
			{
				OnNal(Data[NalStart] & 0x1F, Data + NalStart, J - NalStart);
			}
			I = J;
		}
		return true;
	}

	bool AnnexBToAvcc(const uint8* Data, uint32 Size, TArray<uint8>& OutAvcc)
	{
		OutAvcc.Reset(Size + 16);
		bool bAny = false;
		ForEachAnnexBNal(Data, Size, [&OutAvcc, &bAny](uint8 Type, const uint8* Nal, uint32 Len)
		{
			const uint8 LenBe[4] = {
				(uint8)((Len >> 24) & 0xFF),
				(uint8)((Len >> 16) & 0xFF),
				(uint8)((Len >> 8) & 0xFF),
				(uint8)(Len & 0xFF)
			};
			OutAvcc.Append(LenBe, 4);
			OutAvcc.Append(Nal, Len);
			bAny = true;
		});
		return bAny;
	}

	uint8 LinearToAlaw(int16 Pcm)
	{
		// Standard ITU G.711 A-law companding (16-bit -> 8-bit).
		const int32 Sign = (Pcm >> 8) & 0x80;
		int32 Aval = Pcm >= 0 ? Pcm : -Pcm; // abs

		if (Aval > 32635) Aval = 32635;

		if (Aval < 256)
		{
			Aval = Aval >> 4; // 0..15
		}
		else
		{
			// segment the magnitude into 8 segments
			int32 Exponent = 7;
			int32 Mask = 0x4000;
			while ((Aval & Mask) == 0 && Exponent > 0)
			{
				Exponent--;
				Mask >>= 1;
			}
			// mantissa 4 bits
			int32 Mantissa = (Aval >> (Exponent + 3)) & 0x0F;
			Aval = (Exponent << 4) | Mantissa; // 0x7F max
		}

		uint8 Alaw = (uint8)(Sign | Aval);
		// XOR pattern: even bits inverted
		return (uint8)(Alaw ^ 0xD5);
	}

	int32 SampleRateToAacIndex(int32 SampleRate)
	{
		static const int32 Table[] = { 96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350 };
		for (int32 I = 0; I < 13; ++I)
		{
			if (SampleRate == Table[I])
			{
				return I;
			}
		}
		return -1;
	}

	void BuildAudioSpecificConfig(int32 SampleRate, int32 Channels, TArray<uint8>& Out)
	{
		int32 FreqIdx = SampleRateToAacIndex(SampleRate);
		if (FreqIdx < 0)
		{
			FreqIdx = 3; // default 48000
			SampleRate = 48000;
		}
		// AAC-LC profile = 2
		uint8 B0 = (uint8)((2 << 3) | ((FreqIdx >> 1) & 0x07));
		uint8 B1 = (uint8)(((FreqIdx & 0x01) << 7) | ((Channels & 0x0F) << 3));
		Out.Reset(2);
		Out.Add(B0);
		Out.Add(B1);
	}

	//////////////////////////////////////////////////////////////////
	// FVideoTagBuilder
	//////////////////////////////////////////////////////////////////

	void FVideoTagBuilder::Build(const uint8* AnnexBData, uint32 Size, bool bKeyFrame, TArray<uint8>& OutSeqTag, TArray<uint8>& OutFrameTag)
	{
		OutSeqTag.Reset();
		OutFrameTag.Reset();

		// scan for SPS/PPS to update cache
		ForEachAnnexBNal(AnnexBData, Size, [this](uint8 Type, const uint8* Nal, uint32 Len)
		{
			if (Type == 7 && Len >= 4) // SPS (need at least profile/level bytes)
			{
				Sps.SetNum(0, EAllowShrinking::No);
				Sps.Append(Nal, Len);
			}
			else if (Type == 8) // PPS
			{
				Pps.SetNum(0, EAllowShrinking::No);
				Pps.Append(Nal, Len);
			}
		});

		// sequence header: sent on first frame with config, refreshed before every keyframe
		// (refreshing is required by servers like MediaMTX after an RTMP reconnect,
		//  since each new connection must be told the AVC configuration again)
		const bool bNeedSeq = (bKeyFrame || !bSeqSent) && HasConfig();
		if (bNeedSeq)
		{
			// FLV video tag: frametype(1)|codec(7=AVC)
			OutSeqTag.Add(bKeyFrame ? 0x17 : 0x27);
			OutSeqTag.Add(0x00); // AVC packet type: sequence header
			OutSeqTag.Add(0); OutSeqTag.Add(0); OutSeqTag.Add(0); // composition time

			// AVCDecoderConfigurationRecord
			OutSeqTag.Add(1); // configuration version
			OutSeqTag.Add(Sps.Num() >= 3 ? Sps[1] : 0x42); // profile
			OutSeqTag.Add(Sps.Num() >= 3 ? Sps[2] : 0x00); // constraint
			OutSeqTag.Add(Sps.Num() >= 3 ? Sps[3] : 0x1F); // level
			OutSeqTag.Add(0xFF); // 4-2-0 + lengthSizeMinusOne = 3
			OutSeqTag.Add(0xE1); // num SPS = 1
			OutSeqTag.Add((uint8)(Sps.Num() >> 8));
			OutSeqTag.Add((uint8)(Sps.Num() & 0xFF));
			OutSeqTag.Append(Sps);
			OutSeqTag.Add(0x01); // num PPS = 1
			OutSeqTag.Add((uint8)(Pps.Num() >> 8));
			OutSeqTag.Add((uint8)(Pps.Num() & 0xFF));
			OutSeqTag.Append(Pps);

			bSeqSent = true;
		}

		// coded frames tag
		TArray<uint8> Avcc;
		if (AnnexBToAvcc(AnnexBData, Size, Avcc))
		{
			OutFrameTag.Add(bKeyFrame ? 0x17 : 0x27);
			OutFrameTag.Add(0x01); // AVC NALU
			OutFrameTag.Add(0); OutFrameTag.Add(0); OutFrameTag.Add(0); // composition time offset (no B frames)
			OutFrameTag.Append(Avcc);
		}
	}

	//////////////////////////////////////////////////////////////////
	// FAudioTagBuilder
	//////////////////////////////////////////////////////////////////

	void FAudioTagBuilder::Init(ECodec InCodec, int32 InSampleRate, int32 InChannels)
	{
		Codec = InCodec;
		SampleRate = InSampleRate;
		Channels = InChannels;
		bSeqSent = false;
	}

	void FAudioTagBuilder::BuildAac(const uint8* Frame, uint32 Size, TArray<uint8>& OutSeqTag, TArray<uint8>& OutFrameTag)
	{
		OutSeqTag.Reset();
		OutFrameTag.Reset();
		if (!bSeqSent)
		{
			// SoundFormat 10 = AAC, rate 3 = 44kHz (AAC always overrides with real config),
			// 16-bit, channels per config
			OutSeqTag.Add(0xAF); // 1010 1111
			OutSeqTag.Add(0x00); // AAC sequence header
			TArray<uint8> Asc;
			BuildAudioSpecificConfig(SampleRate, Channels, Asc);
			OutSeqTag.Append(Asc);
			bSeqSent = true;
		}

		OutFrameTag.Add(0xAF);
		OutFrameTag.Add(0x01); // raw AAC frame
		OutFrameTag.Append(Frame, Size);
	}

	void FAudioTagBuilder::BuildPcma(const uint8* AlawData, uint32 Size, TArray<uint8>& OutTag)
	{
		// SoundFormat 7 = PCMA (G.711 A-law), rate bits are ignored (always 8kHz),
		// 16-bit samples, mono
		OutTag.Add(0x72); // 0111 0010
		OutTag.Append(AlawData, Size);
	}
}
