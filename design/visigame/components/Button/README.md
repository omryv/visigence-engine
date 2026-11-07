# Button

Buttons start things; the one **primary** button per view is the tungsten practical light that says "this is what the screen is for".

- `variant`: `primary` (tungsten fill, `on-tungsten` label; hover lights `shadow-practical`), `secondary` (default: `surface-200`, `line-strong` edge), `ghost` (toolbars, dense rows), `danger` (tally outline; fills on hover).
- `size`: `sm` 32px (toolbars, node headers), `md` 40px, `lg` 52px (launcher, play overlay, landing hero).
- `icon` / `iconEnd`: an icon name from the studio set (`bolt`, `play`, `arrow`…) or a node. An `icon` with no children makes a square icon button — give it an `aria-label`.
- `shortcut`: a key hint shown in a mono `kbd` (`⏎`, `Space`).

Label in sentence case, verb first: "Generate & play", "Start mission", "Choose a world", "Beat this". Never two primaries side by side; the second action is `secondary` or `ghost`.
