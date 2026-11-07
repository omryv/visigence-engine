# Tabs

Switches between views of the same thing — Preview / Performance / Logs under the game viewport, sections of the inspector.

- `items`: `[{ id, label, count? }]`; `count` shows a small mono number.
- `value` + `onChange`, or `defaultValue`.
- `label`: the tablist's accessible name.

The active tab is `ink` with a `stroke-focus` tungsten underline; the rest are `ink-muted`. Labels are one word, sentence case.
