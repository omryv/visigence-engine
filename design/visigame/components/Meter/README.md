# Meter

A labelled bar with a mono value: health, ammo, stamina in the HUD; build and download progress in the studio.

- `label` (required), `value`, `max` (default 100), `display` (what the number says, e.g. "30 / 120").
- `tone`: `ink` (default), `tungsten` (progress of the primary action), `peaking`, `zebra` (warning, striped), `tally`.
- `low`: a threshold; at or under it the meter turns tally and adds the word `flag` (default "Low").

Never let colour alone say "low": the flag word appears with the red. In the HUD, meters sit on `scrim` with a `depth-mid` backdrop blur.
