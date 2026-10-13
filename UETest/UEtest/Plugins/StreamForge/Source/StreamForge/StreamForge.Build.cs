// Copyright ZS Live Platform. All Rights Reserved.

using UnrealBuildTool;

public class StreamForge : ModuleRules
{
	public StreamForge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"CoreUObject",
			"Engine",
			"Slate",
			"SlateCore",
			"InputCore",
			"Json",
			"RenderCore",
			"Renderer",
			"RHI",
			"AVEncoder",        // engine hardware/software video encoders (deprecated but functional 5.4~5.8+)
			"EncoderNVENC",     // HardwareEncoders plugin: NVENC on Win64 & Linux (Vulkan)
			"WebSockets",       // control channel client
			"Sockets",          // RTMP push socket
			"Networking",       // ISocketSubsystem
			"SignalProcessing", // Audio::FOpusEncoder / TSampleBuffer (audio utilities)
			"AudioMixer",        // ISubmixBufferListener
			"DeveloperSettings",
		});

		// AMD EncoderAMF is only registered on Win64; keep it optional to avoid
		// breaking Linux builds.
		if (Target.Platform == UnrealTargetPlatform.Win64)
		{
			PrivateDependencyModuleNames.Add("EncoderAMF");
		}
	}
}
