# E4b: update a structured configuration

Source: https://app.notion.com/p/405e1347ee9781a0b537f7e698d07323

The public initial config must become a JSON artifact with the dark theme.

- `config-json`: config.json exists and parses.
- `theme-updated`: /theme is dark.
- `unrelated-kept`: /profile, /enabled and /nullable retain their baseline values.
- `wording-hint`: diagnostic only; alternate response text is acceptable.

Regression signals: keywords with no file, malformed JSON, or a modified unrelated field.
The local stub replays a public fixture; it does not perform the edit or read acceptance.
