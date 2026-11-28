/** Steps reported by the Video Studio worker for each job kind (shown in the UI). */
export const VIDEO_JOB_STEPS = {
  asset: [
    { id: "validate", label: "Validate file" },
    { id: "probe", label: "Read media details" },
    { id: "derivatives", label: "Create preview and thumbnail" },
  ],
  voiceover: [
    { id: "prepare", label: "Prepare recording" },
    { id: "transcribe", label: "Transcribe voiceover" },
    { id: "compare", label: "Compare with script" },
  ],
  render: [
    { id: "prepare", label: "Prepare media" },
    { id: "compose", label: "Build timeline" },
    { id: "encode", label: "Encode video" },
    { id: "verify", label: "Measure and check output" },
    { id: "upload", label: "Save render" },
  ],
} as const;
