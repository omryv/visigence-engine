# Segmented

A small set (two to four) of mutually exclusive modes that change the whole view — the launcher's genre switch, Play / Remix.

- `options`: `[{ value, label }]`.
- `value` + `onChange` (controlled), or `defaultValue`.
- `label`: a mono prefix inside the track ("Genre") and the group's accessible name.

The chosen option is a raised `surface-100` thumb with a `line-strong` edge — never tungsten; tungsten is for doing, not choosing. More than four options: use Tabs.
