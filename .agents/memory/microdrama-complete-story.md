---
name: Microdrama complete-story planning
description: Product requirements and sequencing for long-form stories in the Telegram microdrama bot.
---

Each requested duration is one complete story, not an automatic cliffhanger or a multi-episode outline. Establish the prologue, central conflict, chronological acts, climax, and epilogue before writing scenes. Endings are closed by default; use an open ending only when the user explicitly asks for one.

Plan two 30-second beats per minute, with three ten-second shots per beat. Long outlines should be generated and persisted in small batches (up to ten beats) before storyboard generation; each new batch needs the saved story arc, its relevant act plan, and recent completed beats so it can continue causally and resume without regenerating completed batches. Media generation remains behind its existing quote and approval step.

**Why:** a single large beat-list response becomes unreliable at long durations, while scene-by-scene improvisation can lose the ending and causal continuity. Planning the ending first and persisting batches preserves the complete arc and resumability.

**How to apply:** keep the story outline separate from scene/shot generation, carry arc and neighboring-beat context into scene prompts, and test the maximum duration without submitting paid media jobs.

## One-minute dracin pacing

For a one-minute standalone dracin, use original high-retention vertical Chinese short-drama pacing: a visual/emotional hook within the first three seconds, one clear central conflict, escalating reversals, a decisive choice, and a satisfying closed payoff by 60 seconds. The minute is six ten-second shots. Keep dialogue in the configured language and do not copy a specific Melolo title, characters, or plot.

**Why:** The user asked for a dracin that feels like a real Melolo short drama and specified a one-minute duration.

**How to apply:** Preserve this pacing in the story bible, two 30-second beats, and six 10-second shot prompts. Keep the ending closed unless the user explicitly requests a cliffhanger.
