# Contributing

This repository is preparing its first public release. Start with [status and limitations](README.md#status-and-limitations) in the README. Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Workspace setup

The root package contains the library and `example/` contains a React Native Community CLI consumer. Use the Node version in [`.nvmrc`](.nvmrc). The repository pins Yarn 4.11.0 through `packageManager` and `yarnPath`, so a plain `yarn` runs that version; if Yarn is missing or is Yarn 1, run `node .yarn/releases/yarn-4.11.0.cjs` in its place, as the workflows do.

```sh
yarn install
```

Keep dependency changes and the workspace lockfile together; do not add an npm or Yarn 1 lockfile.

## Checks

Run relevant tests while working, then run the complete package checks before submitting a change:

```sh
yarn typecheck
yarn test
yarn lint
yarn build
yarn check:package
```

| Script            | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `typecheck`       | Check TypeScript without generating a release               |
| `test`            | Run the extracted test suite                                |
| `lint`            | Check JavaScript and TypeScript style and lint rules        |
| `build`           | Generate ESM and TypeScript declarations with Bob           |
| `check:package`   | Check configured package entry points and build output      |
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
yarn example start
```

In another terminal, also from the repository root:

```sh
yarn example ios
# Or:
yarn example android
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

The repository owner is `baesumin`, and the license is MIT. Remaining release work is listed under [status and limitations](README.md#status-and-limitations): a tested support matrix, the open device checks, and screen-reader announcements.

## Publishing a release

Prereleases go out under the `next` dist-tag, so `npm install react-native-layout-dnd` keeps resolving to the last stable release. A version without a hyphen publishes as `latest`.

[`release.yml`](.github/workflows/release.yml) publishes with npm trusted publishing (OIDC), so no npm token is stored in this repository. It repeats the full verification before publishing and refuses a tag that disagrees with `package.json`.

npm can only attach a trusted publisher to a package that already exists, so the first release is published by hand:

```sh
yarn install
npm whoami                 # log in with `npm login` first
npm publish --tag next     # prepack runs the Bob build
```

Then, on npmjs.com, open the package settings and add a GitHub Actions trusted publisher with organization `baesumin`, repository `react-native-layout-dnd` and workflow filename `release.yml`. Every later release is a tag push:

```sh
npm version 0.1.0-alpha.1  # or edit package.json and commit
git push --follow-tags
```

The same workflow creates the GitHub release for the tag, marked as a prerelease when the version has a hyphen, with notes generated from the commits since the previous tag. A version that is already on npm is not published again, so a tag pushed after a manual publish only creates the release.
