# Layout DnD example

The app has **Mixed**, **FlatList**, **Lists**, and **Grid** tabs. Lists demonstrates measured variable-height
vertical cards, variable-width horizontal cards, edge auto-scroll, cross-list
transfers, and a rejection toggle. Hold a card's handle for 250ms to start.
Grid retains the original spatial grid example. All use the package's public imports.

Mixed shares one `DndProvider` between a 120-item variable-height FlatList and a
grid with mixed spans. Drag in either direction, toggle drop rejection, and
switch between `useDndState` and `createDndStateStore` with `useSyncExternalStore`.
Switching state mode resets this demo. The caller explicitly chooses each item's
grid span; the library preserves its data during transfers.

FlatList uses the same list API with `virtualization`, 500 vertical cards and 80
horizontal cards. Its size-change button updates data and invalidates measured
sizes. To verify source-cell unmount behavior, start a drag after scrolling beyond
the initial batch: React Native retains its initial cells as an optimization.

Use the workspace commands in the [repository README](../README.md) to start
Metro and run iOS or Android. This example resolves local package source; it is
separate from the packed-consumer release check.

Native verification is still pending. Check scrolling with a stationary pointer,
both list orientations, cross-list acceptance/rejection, outside release, gesture
interruption, rotation, and reduced motion on both platforms. FlatList also needs
long-distance scrolling, source-cell unmount/remount and size-change checks.
Mixed also needs grid/list transfers, different destination spans, full-grid
rejection, and preview handoff checks on both platforms.

The native projects were bootstrapped with the React Native Community CLI.
The generated setup instructions follow.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
