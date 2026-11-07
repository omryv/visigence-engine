# Field

A labelled single-line input: project names, seeds, world titles, share links.

- `label` (required): mono caps above the box.
- `hint`: one line under it; `error` replaces the hint, turns the edge tally, and is announced ("Error — …").
- `suffix`: a mono unit or tag inside the box (`px`, `.json`, `/ 64`).
- Everything else goes to the `<input>` (`value`, `onChange`, `placeholder`, `maxLength`…).

The box is a `surface-300` well with a `line-strong` edge; focus draws a peaking edge. Placeholder text is an example value, never an instruction.
