---
name: Picsart AI Clipper response contract
description: Analysis-only clip results versus finished video export in the captured Picsart workflow
---

The captured Picsart video-clipping workflow returns clip recommendations, not finished video files.

**Why:** A completed browser HAR response contained clip start/end seconds, word timing, descriptive metadata and thumbnail URLs, with the original source video URL separate. It contained no per-clip video/export URL and captured no export request.

**How to apply:** Before promising Telegram MP4 delivery, either obtain a verified export contract or plan separate source-video trimming/rendering. Word timing can support subtitles, but subtitle rendering is separate. Thumbnail canvas dimensions must not be presented as final video resolution or evidence of automatic portrait reframing.

## Captured upstream contract

- Upload: `POST https://upload.picsart.com/files`, returning `result.url`.
- Submit: `POST https://api.picsart.com/gw-v2/workflows/video-clipping/v1/clips/submit`.
- Request nests settings under `params`: `sources:[{videoUrl}]`, `numClips`, `model`, `mediaProcessing`, `mode`, `visualAnalysis`, `refineBoundaries`, `openingHoldSeconds` and `thumbnails`.
- Observed settings: `model:"gemini-3.7-flash"`, `mediaProcessing:"AGENTIC"`, `mode:"discover"`, `numClips:12`, `visualAnalysis:true`, `refineBoundaries:true`, `openingHoldSeconds:1`, `thumbnails:{mode:"plate",canvasWidth:1080,canvasHeight:1920}`. These are captured values, not a verified supported-options catalog.
- Submit returns `response.id`; poll `GET .../clips/{id}/result`.
- Completion is `response.status:"COMPLETED"` with `response.result.clips`, `response.result.sources` and `response.usage.credits`.

**Rule:** Do not infer a universal credits-per-minute formula from one job, or promise fixed short-clip durations from `numClips`.

**Why:** The captured job charged 73 credits for about 72 minutes of source video, and its twelve recommendations varied from about 40 to 173 seconds.

**How to apply:** Treat these as observed examples only; verify duration controls, pricing and actual delivered output before adding a paid bot menu.
