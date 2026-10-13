// Copyright ZS Live Platform. All Rights Reserved.

#include "SFAmf0.h"
#include "SFLog.h"

namespace SFAmf0
{
	void FWriter::WriteU8(uint8 V) { Buf.Add(V); }

	void FWriter::WriteU16BE(uint16 V)
	{
		Buf.Add((uint8)((V >> 8) & 0xFF));
		Buf.Add((uint8)(V & 0xFF));
	}

	void FWriter::WriteU32BE(uint32 V)
	{
		Buf.Add((uint8)((V >> 24) & 0xFF));
		Buf.Add((uint8)((V >> 16) & 0xFF));
		Buf.Add((uint8)((V >> 8) & 0xFF));
		Buf.Add((uint8)(V & 0xFF));
	}

	void FWriter::WriteNumber(double V)
	{
		WriteU8((uint8)EAmfType::Number);
		uint64 Bits;
		FMemory::Memcpy(&Bits, &V, sizeof(double));
		for (int32 I = 7; I >= 0; --I)
		{
			Buf.Add((uint8)((Bits >> (I * 8)) & 0xFF));
		}
	}

	void FWriter::WriteBoolean(bool V)
	{
		WriteU8((uint8)EAmfType::Boolean);
		WriteU8(V ? 1 : 0);
	}

	void FWriter::WriteString(const FString& V)
	{
		WriteU8((uint8)EAmfType::String);
		FTCHARToUTF8 Utf8(*V);
		WriteU16BE((uint16)Utf8.Length());
		Buf.Append((const uint8*)Utf8.Get(), Utf8.Length());
	}

	void FWriter::WriteNull()
	{
		WriteU8((uint8)EAmfType::Null);
	}

	void FWriter::WriteObjectBegin()
	{
		WriteU8((uint8)EAmfType::Object);
	}

	void FWriter::WriteProp(const FString& Key, const FString& V)
	{
		FTCHARToUTF8 Utf8Key(*Key);
		WriteU16BE((uint16)Utf8Key.Length());
		Buf.Append((const uint8*)Utf8Key.Get(), Utf8Key.Length());
		WriteString(V);
	}

	void FWriter::WritePropNumber(const FString& Key, double V)
	{
		FTCHARToUTF8 Utf8Key(*Key);
		WriteU16BE((uint16)Utf8Key.Length());
		Buf.Append((const uint8*)Utf8Key.Get(), Utf8Key.Length());
		WriteNumber(V);
	}

	void FWriter::WritePropBool(const FString& Key, bool V)
	{
		FTCHARToUTF8 Utf8Key(*Key);
		WriteU16BE((uint16)Utf8Key.Length());
		Buf.Append((const uint8*)Utf8Key.Get(), Utf8Key.Length());
		WriteBoolean(V);
	}

	void FWriter::WriteObjectEnd()
	{
		WriteU16BE(0);
		WriteU8((uint8)EAmfType::ObjectEnd);
	}

	//////////////////////////////////////////////////////////////////

	namespace
	{
		FORCEINLINE uint32 ReadU8(const TArray<uint8>& B, uint32& C)
		{
			if (C >= (uint32)B.Num()) return 0;
			return B[C++];
		}

		FORCEINLINE uint32 ReadU16(const TArray<uint8>& B, uint32& C)
		{
			uint32 A = ReadU8(B, C), D = ReadU8(B, C);
			return (A << 8) | D;
		}

		FORCEINLINE uint32 ReadU24(const TArray<uint8>& B, uint32& C)
		{
			uint32 A = ReadU8(B, C), D = ReadU8(B, C), E = ReadU8(B, C);
			return (A << 16) | (D << 8) | E;
		}

		FORCEINLINE uint32 ReadU32(const TArray<uint8>& B, uint32& C)
		{
			return (ReadU24(B, C) << 8) | ReadU8(B, C);
		}

		FORCEINLINE bool ReadDouble(const TArray<uint8>& B, uint32& C, double& Out)
		{
			if (C + 8 > (uint32)B.Num()) return false;
			uint64 Bits = 0;
			for (int32 I = 0; I < 8; ++I)
			{
				Bits = (Bits << 8) | B[C + I];
			}
			C += 8;
			FMemory::Memcpy(&Out, &Bits, sizeof(double));
			return true;
		}

		FORCEINLINE bool ReadUtf8String(const TArray<uint8>& B, uint32& C, uint32 Len, FString& Out)
		{
			if (C + Len > (uint32)B.Num()) return false;
			FUTF8ToTCHAR Conv((const ANSICHAR*)(B.GetData() + C), Len);
			Out = FString(Conv.Length(), Conv.Get());
			C += Len;
			return true;
		}

		FORCEINLINE bool ReadLengthPrefixedString(const TArray<uint8>& B, uint32& C, FString& Out)
		{
			uint32 Len = ReadU16(B, C);
			return ReadUtf8String(B, C, Len, Out);
		}
	}

	bool ReadValue(const TArray<uint8>& Buf, uint32& Cursor, FValue& OutValue)
	{
		uint8 Type = ReadU8(Buf, Cursor);
		OutValue = FValue();
		OutValue.Type = (EAmfType)Type;

		switch (Type)
		{
		case (uint8)EAmfType::Number:
			return ReadDouble(Buf, Cursor, OutValue.Number);
		case (uint8)EAmfType::Boolean:
			OutValue.Boolean = ReadU8(Buf, Cursor) != 0;
			return true;
		case (uint8)EAmfType::String:
			return ReadLengthPrefixedString(Buf, Cursor, OutValue.Str);
		case (uint8)EAmfType::Null:
		case (uint8)EAmfType::Undefined:
			return true;
		case (uint8)EAmfType::Object:
		case (uint8)EAmfType::EcmaArray:
		{
			if (Type == (uint8)EAmfType::EcmaArray)
			{
				ReadU32(Buf, Cursor); // associative-count (advisory)
			}
			while (true)
			{
				uint32 KeyLen = ReadU16(Buf, Cursor);
				if (KeyLen == 0)
				{
					uint8 EndMarker = ReadU8(Buf, Cursor);
					if (EndMarker == (uint8)EAmfType::ObjectEnd)
					{
						return true;
					}
					return false; // malformed
				}
				FString Key;
				if (!ReadUtf8String(Buf, Cursor, KeyLen, Key))
				{
					return false;
				}
				FValue Sub;
				if (!ReadValue(Buf, Cursor, Sub))
				{
					return false;
				}
				OutValue.Props.Add(TPair<FString, FValue>(MoveTemp(Key), MoveTemp(Sub)));
			}
		}
		default:
			return false;
		}
	}
}
