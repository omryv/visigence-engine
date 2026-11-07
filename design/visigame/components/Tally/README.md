# Tally

A tally light and one word: the state of a build, a play session or a publish.

- `state`: `live` (tally red, pulsing ring — the game is running or a world is being recorded/published), `ready` (success teal — compiled, playable), `warn` (zebra — needs attention), `idle` (grey).
- `children`: overrides the word (`Playing`, `Compiled`, `Unsaved`). Keep it one or two words.

Only one `live` tally per screen. It carries its own word, so it never relies on colour. The pulse stops under reduced motion.
