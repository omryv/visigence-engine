# Viewfinder

Four corner brackets, just outside a box, that mark what the camera is framing: the selected card, the node being edited, the element with keyboard focus.

- `active`: shows the brackets (they close in from 4px out over the rack-focus curve).
- `tone`: `peaking` (default — selection and focus) or `tungsten` (the featured item on a landing or launcher).
- `as`: the element; anything else is passed through.

The brackets replace a glow, a thick border or a filled background as the sign of "selected". Leave `space-2` or more around a Viewfinder so the brackets never touch a neighbour. WorldCard and Node already use it.
