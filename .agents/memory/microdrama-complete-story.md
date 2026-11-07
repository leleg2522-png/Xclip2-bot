---
name: Microdrama complete-story planning
description: Product requirements and sequencing for long-form stories in the Telegram microdrama bot.
---

Each requested duration is one complete story, not an automatic cliffhanger or a multi-episode outline. Establish the prologue, central conflict, chronological acts, climax, and epilogue before writing scenes. Endings are closed by default; use an open ending only when the user explicitly asks for one.

Plan two 30-second beats per minute, with three ten-second shots per beat. Long outlines should be generated and persisted in small batches (up to ten beats) before storyboard generation; each new batch needs the saved story arc, its relevant act plan, and recent completed beats so it can continue causally and resume without regenerating completed batches. Media generation remains behind its existing quote and approval step.

**Why:** a single large beat-list response becomes unreliable at long durations, while scene-by-scene improvisation can lose the ending and causal continuity. Planning the ending first and persisting batches preserves the complete arc and resumability.

**How to apply:** keep the story outline separate from scene/shot generation, carry arc and neighboring-beat context into scene prompts, and test the maximum duration without submitting paid media jobs.
