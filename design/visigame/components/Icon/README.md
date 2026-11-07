# Icon

The studio's own line icons, drawn on a 24px grid with a 1.5 stroke (`stroke-icon`), round caps and joins, in `currentColor`.

- `name`: one of `theme`, `mountain`, `enemy`, `target`, `cube`, `crosshair`, `settings`, `folder`, `download`, `undo`, `redo`, `bolt`, `arrow`, `expand`, `play`, `pause`, `close` (`Visigame.icons` lists them).
- `size`: px, default 20 (18 inside buttons, 16 in node headers).
- `title`: set it only when the icon stands alone and means something; otherwise it is hidden from assistive tech.

Draw new icons the same way: outline only, no fills, no second colour. Colour comes from the text around it — `ink`, `ink-muted`, or a signal token when the icon *is* the signal.
