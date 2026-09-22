# Contributing

This repository is preparing its first public release. Start with [status and limitations](README.md#status-and-limitations) in the README. Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Workspace setup

The root package contains the library and `example/` contains a React Native Community CLI consumer. Use the Node version in [`.nvmrc`](.nvmrc) and the bundled Yarn 4.11.0:

```sh
node .yarn/releases/yarn-4.11.0.cjs install
```

If Yarn 4 is already configured, `yarn install` is equivalent. Keep dependency changes and the workspace lockfile together; do not add an npm or Yarn 1 lockfile.

## Checks

Run relevant tests while working, then run the complete package checks before submitting a change:

```sh
node .yarn/releases/yarn-4.11.0.cjs typecheck
node .yarn/releases/yarn-4.11.0.cjs test
node .yarn/releases/yarn-4.11.0.cjs lint
node .yarn/releases/yarn-4.11.0.cjs build
node .yarn/releases/yarn-4.11.0.cjs check:package
```

| Script          | Purpose                                                |
| --------------- | ------------------------------------------------------ |
| `typecheck`     | Check TypeScript without generating a release          |
| `test`          | Run the extracted test suite                           |
| `lint`          | Check JavaScript and TypeScript style and lint rules   |
| `build`         | Generate ESM and TypeScript declarations with Bob      |
| `check:package` | Check configured package entry points and build output |
| `test:perf-tools` | Run the performance tooling's own checks with `node --test` |

Current verification counts are in the [README project status](README.md#project-status). Record new results separately, including any tests that could not run.

## Run the native example

Install Xcode and CocoaPods for iOS, or the Android SDK and the required JDK for Android. Install the example's iOS pods with the project's Ruby dependencies before the first iOS build:

```sh
cd example
bundle install
cd ios
bundle exec pod install
```

From the repository root, start Metro:

```sh
node .yarn/releases/yarn-4.11.0.cjs example start
```

In another terminal, also from the repository root:

```sh
node .yarn/releases/yarn-4.11.0.cjs example ios
# Or:
node .yarn/releases/yarn-4.11.0.cjs example android
```

The example uses local library source. Rebuild the native app after native dependency changes. Keep `react-native-worklets/plugin` in the consuming app's Babel configuration; the package's test configuration also uses it. Do not precompile the library's worklets with the release machine's plugin version.

For behavior changes, check the affected scenarios on iOS and Android: drag activation, preview handoff, movement, cancellation, rejection, and competing gestures. New scrolling and virtualization features must also survive source-cell unmounting and offset changes. Describe actual checks and any unavailable platform in the change description.

## Verify the distribution

After building and checking the package, create the actual distribution artifact:

```sh
npm pack
```

Inspect the tarball contents and install that file in a separate React Native app. Ensure the consumer uses the built root and `/engine` exports, resolves the declaration files, and builds without the original application's aliases, Re.Pack setup, or React Compiler configuration. Check worklet execution on a device or simulator.

The workspace example tests source integration. A successful source import does not prove that the tarball includes all required files.

## Implementation boundaries

- Keep the engine independent of React Native and preserve caller-owned data.
- Keep home sizing, app/widget classification, storage, haptics, and WebView capture in the application adapter.
- When changing movement policy, check pointer thresholds, candidate layout, preview, and committed layout together.
- Track measured and estimated item bounds separately. Scrolling updates coordinates while the drag remains active.
- Apply transfers across containers atomically and reject stale responses without overwriting newer external state.
- Preserve the original app during extraction; replace its imports after package validation, then remove the duplicate implementation.
- Document planned features as planned until their acceptance checks pass.

## Changes and release readiness

Keep each change focused. Explain the previous behavior, the resulting behavior, and the tests or native checks performed. Update examples and public types when an API changes.

The intended repository owner is `baesumin`, and the license is MIT. The bootstrap does not create a remote GitHub repository or publish to npm. Keep `private: true` while release requirements remain open. Release work includes the tested support matrix, complete first-release scope, package installation checks, documentation, CI, and npm publishing configuration described in the implementation plan.
