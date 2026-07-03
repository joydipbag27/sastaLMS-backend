export const jobTemplate = {
  Queue: "",
  Role: "",
  UserMetadata: {
    mediaId: "",
  },

  Settings: {
    OutputGroups: [
      {
        Name: "Apple HLS",
        Outputs: [
          // 360p @ 1.2 Mbps — low tier (mobile / slow connections)
          // Preferred over 600 Kbps: better text/slide legibility for LMS content
          {
            Preset: "System-Ott_Hls_Ts_Avc_Aac_16x9_640x360p_30Hz_1.2Mbps",
            NameModifier: "_360p",
          },
          // 720p @ 3.5 Mbps — mid tier (standard desktop / tablet)
          // 5.0 and 6.5 Mbps variants are for fast-motion sports; not needed for lectures
          {
            Preset: "System-Ott_Hls_Ts_Avc_Aac_16x9_1280x720p_30Hz_3.5Mbps",
            NameModifier: "_720p",
          },
          // 1080p @ 8.5 Mbps — high tier (high-quality desktop playback)
          // {
          //   Preset: "System-Ott_Hls_Ts_Avc_Aac_16x9_1920x1080p_30Hz_8.5Mbps",
          //   NameModifier: "_1080p",
          // },
        ],
        OutputGroupSettings: {
          Type: "HLS_GROUP_SETTINGS",
          HlsGroupSettings: {
            ManifestDurationFormat: "INTEGER",
            SegmentLength: 6,
            TimedMetadataId3Period: 10,
            CaptionLanguageSetting: "OMIT",
            Destination: "",
            TimedMetadataId3Frame: "PRIV",
            CodecSpecification: "RFC_4281",
            OutputSelection: "MANIFESTS_AND_SEGMENTS",
            ProgramDateTimePeriod: 600,
            MinSegmentLength: 0,
            DirectoryStructure: "SINGLE_DIRECTORY",
            ProgramDateTime: "EXCLUDE",
            SegmentControl: "SEGMENTED_FILES",
            ManifestCompression: "NONE",
            ClientCache: "ENABLED",
            StreamInfResolution: "INCLUDE",
          },
        },
      },
    ],
    AdAvailOffset: 0,
    FollowSource: 1,
    Inputs: [
      {
        AudioSelectors: {
          "Audio Selector 1": {
            DefaultSelection: "DEFAULT",
          },
        },
        VideoSelector: {},
        TimecodeSource: "ZEROBASED",
        FileInput: "",
      },
    ],
  },
  StatusUpdateInterval: "SECONDS_60",
  Priority: 0,
};
