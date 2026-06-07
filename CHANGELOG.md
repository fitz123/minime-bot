# Changelog

## Unreleased

- Imported the bot package into the public `minime-bot` repository.
- Documented the package-root architecture: runtime code and Pi extensions live
  in this package, while production config and agent workspace state live in an
  external control workspace.
- Documented the package CLI, workspace selection through `--workspace` or
  `MINIME_WORKSPACE_ROOT`, and the validation commands for pull requests.
- Clarified that the current runtime path is Pi/Codex based.
