// Copyright ZS Live Platform. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

/**
 * Minimal AMF0 codec used by the RTMP client (commands only).
 */
namespace SFAmf0
{
	enum class EAmfType : uint8
	{
		Number = 0x00,
		Boolean = 0x01,
		String = 0x02,
		Object = 0x03,
		Null = 0x05,
		Undefined = 0x06,
		EcmaArray = 0x08,
		ObjectEnd = 0x09,
	};

	/** A parsed AMF0 value. */
	struct FValue
	{
		EAmfType Type = EAmfType::Undefined;
		double Number = 0;
		bool Boolean = false;
		FString Str;
		TArray<TPair<FString, FValue>> Props; // object / ecma array

		bool IsNumber() const { return Type == EAmfType::Number; }
		bool IsString() const { return Type == EAmfType::String; }
		bool IsObject() const { return Type == EAmfType::Object || Type == EAmfType::EcmaArray; }

		const FValue* Find(const TCHAR* Key) const
		{
			for (const auto& P : Props)
			{
				if (P.Key == Key)
				{
					return &P.Value;
				}
			}
			return nullptr;
		}
	};

	//////////////////////////////////////////////////////////////////
	// Encoder
	//////////////////////////////////////////////////////////////////

	class FWriter
	{
	public:
		void WriteNumber(double V);
		void WriteBoolean(bool V);
		void WriteString(const FString& V);
		void WriteNull();
		void WriteObjectBegin();
		void WriteProp(const FString& Key, const FString& V);
		void WritePropNumber(const FString& Key, double V);
		void WritePropBool(const FString& Key, bool V);
		void WriteObjectEnd();

		const TArray<uint8>& GetData() const { return Buf; }

	private:
		void WriteU8(uint8 V);
		void WriteU16BE(uint16 V);
		void WriteU32BE(uint32 V);

		TArray<uint8> Buf;
	};

	//////////////////////////////////////////////////////////////////
	// Decoder
	//////////////////////////////////////////////////////////////////

	/** Reads one AMF0 value at Cursor (byte offset). Returns false on malformed data. */
	bool ReadValue(const TArray<uint8>& Buf, uint32& Cursor, FValue& OutValue);
}
