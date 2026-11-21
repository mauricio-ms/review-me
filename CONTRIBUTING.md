# Contributing to review-me

Thanks for your interest in review-me. Bug reports, ideas and pull requests are all
welcome.

## Reporting bugs and suggesting features

Open an [issue](https://github.com/mauricio-ms/review-me/issues/new/choose). For a bug,
include the version (`M-x version` in the app), your distribution and desktop, how you
installed review-me, and the steps that lead to the problem. If it depends on the
repository you were reviewing, say what kind it is (size, languages, a branch or commit
comparison) rather than sharing private code.

For anything bigger than a small fix, please open an issue to discuss it before you
start, so that your work fits where the project is going.

## Setting up

[Developing review-me](docs/development.md) covers the prerequisites, running from
source and the test suites. [`CLAUDE.md`](CLAUDE.md) describes the architecture and the
conventions the code relies on. It is written for AI coding agents and human
contributors alike, and it is worth reading before you change anything non-trivial.

## Pull requests

- **Keep each pull request focused** on one change, and describe what it changes and why.
- **Add tests.** Behaviour changes need automated tests in the layer they touch:
  browser tests under `tests/` for the frontend, Rust unit tests for the backend, and
  both when a change crosses Tauri IPC. A bug fix needs a test that fails without the
  fix.
- **Run the checks** before you push. CI runs the same ones:

  ```bash
  npm run build
  npm run test:frontend
  (cd src-tauri && cargo test --locked)
  ```

- **Follow the existing conventions.** TypeScript runs in strict mode with unused
  locals and parameters as errors; there is no separate formatter, so match the style
  around your change. Key bindings follow Emacs conventions: every command gets an `M-x`
  name, and only frequently used ones get a key.
- **Update the docs** ([user guide](docs/guide.md), README, `CLAUDE.md`) when you change
  what a user or contributor needs to know.
- **Write commit messages** with a short imperative subject, such as
  `Add Vim-style clipboard yanking`.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
