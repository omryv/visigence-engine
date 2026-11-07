# Node

A node in the game blueprint graph: a pool, an objective, the world generator or the playable output, with typed ports on its edges.

- `title` (required), `kind` (mono caps: "World pool", "Objective"), `icon`, `status` (usually a `Tally`), `children` (one line of summary).
- `inputs` / `outputs`: `[{ id, label, type, connected }]`. `type` is `asset` (grey — assets flow in), `flow` (peaking — mission steps chain), `output` (tungsten — the playable game).
- `selected`: viewfinder brackets and a peaking edge.

Wires take the colour of the port they leave, at `stroke-focus`. An unconnected pool is shown as is, not dimmed — the graph status line says what is missing.
