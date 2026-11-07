# WorldCard

A world you can play or remix: key art on top, a metadata line, the world's name. Selecting one frames it with viewfinder brackets and throws the others slightly out of focus.

- `title` (required): the world's name, "Meadow Village".
- `art`: an image URL (a render of the world, 16:10, subject in the middle third) or a node.
- `meta`: the Meta line — genre, biome, length.
- `status`: a node over the art, usually a `Tally`.
- `selected`, `onSelect`: the card is a toggle button (`aria-pressed`).
- `children`: one line of description, optional.

Put cards in a container with class `vg-grid`: when one is selected the rest blur by `depth-near`. Key art is always a real render from the engine or Blender, never an illustration or stock image; the art corner stays square to the card (`radius-md` top only).
