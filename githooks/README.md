# githooks

`prepare-commit-msg` keeps every commit authored by the human only:

- strips assistant/bot authorship lines from commit messages — `Generated with
  Codebuff/Freebuff/Claude…` and `Co-Authored-By:` lines naming Claude, Codebuff,
  Freebuff or Buffy (any casing, any noreply domain) — whatever the assistant
  calls itself after an update;
- refuses any commit whose **author identity** is a bot identity, so the bot
  always commits "from my place".

It runs even under `git commit --no-verify`, and it lives in the repo (not in the
assistant app), so app updates cannot remove it.

Already active in this checkout (`core.hooksPath=githooks`). In a fresh clone,
re-enable with:

```bash
git config core.hooksPath githooks
```

A fallback copy sits in `.git/hooks/prepare-commit-msg` in case the config is
ever reset.
