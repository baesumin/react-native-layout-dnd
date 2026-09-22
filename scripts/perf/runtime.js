/* global __r, globalThis, performance, requestAnimationFrame, cancelAnimationFrame */
// This file is compiled with the installed Worklets Babel plugin and evaluated
// through CDP. It never replaces coordinator methods or application prototypes.
(() => {
  globalThis.__layoutDndPerf?.dispose();
  const devtools = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!devtools?.getFiberRoots)
    throw new Error('React DevTools fiber access is unavailable');
  const find = predicate => {
    const found = [];
    const visit = fiber => {
      if (!fiber) return;
      if (predicate(fiber)) found.push(fiber);
      visit(fiber.child);
      visit(fiber.sibling);
    };
    for (const id of devtools.renderers.keys())
      for (const root of devtools.getFiberRoots(id)) visit(root.current);
    return found;
  };
  const modules = Array.from(__r.getModules()).map(
    ([, module]) => module.publicModule?.exports,
  );
  const worklets = modules.find(
    exports => exports?.scheduleOnUI && exports?.scheduleOnRN,
  );
  const animated = modules.find(
    exports => exports?.measure && exports?.scrollTo,
  );
  if (!worklets || !animated)
    throw new Error('Reanimated/Worklets modules are unavailable');
  const scheduleOnRN = worklets.scheduleOnRN;
  const measure = animated.measure;
  const scrollTo = animated.scrollTo;
  const delay = ms => new Promise(accept => setTimeout(accept, ms));
  const context = () => {
    const values = new Set(
      find(fiber => fiber.memoizedProps?.value?.registerZone).map(
        fiber => fiber.memoizedProps.value,
      ),
    );
    if (values.size !== 1)
      throw new Error(`Expected one mounted DndRuntime; found ${values.size}`);
    return [...values][0];
  };
  const hooksOf = fiber => {
    const hooks = [];
    for (let hook = fiber?.memoizedState; hook; hook = hook.next)
      hooks.push(hook.memoizedState);
    return hooks;
  };
  const internals = runtime => {
    let coordinator;
    let settlement;
    let progress;
    // Provider still owns the session and frame worklet. Handle/gesture state
    // now belongs to GestureHostImpl and must not be inferred by hook index.
    const providers = find(candidate =>
      hooksOf(candidate).some(state => state === runtime.motion),
    );
    for (const fiber of providers) {
      for (const state of hooksOf(fiber)) {
        if (
          state?.getSnapshot &&
          state?.start &&
          state?.commit &&
          state?.release
        )
          coordinator = state;
        for (const candidate of [
          ...(state?.deps || []),
          ...(Array.isArray(state) ? state.slice(0, 1) : []),
        ]) {
          const closure = candidate?.__closure;
          if (closure?.settlement?.get && closure?.settleProgress?.get) {
            settlement = closure.settlement;
            progress = closure.settleProgress;
          }
        }
      }
    }
    if (!coordinator || !settlement || !progress)
      throw new Error(
        'Original coordinator or settlement worklet references are unavailable; update the diagnostic adapter',
      );
    return { coordinator, settlement, progress };
  };
  const gestureOwners = runtime => {
    const hosts = find(fiber => {
      const props = fiber.memoizedProps;
      return (
        props?.registry?.getSnapshot &&
        props.registry.setOwners &&
        props.runtime?.motion === runtime.motion
      );
    });
    const registries = new Set(hosts.map(host => host.memoizedProps.registry));
    if (registries.size > 1)
      throw new Error('Multiple gesture registries matched this DndRuntime');
    if (registries.size === 1) {
      const registry = [...registries][0];
      const host =
        hosts.find(
          candidate =>
            candidate.type?.name === 'GestureHostImpl' ||
            candidate.type?.type?.name === 'GestureHostImpl',
        ) ?? hosts[0];
      const gestureRuntime = host.memoizedProps.runtime;
      let shared = false;
      const owners = registry.getSnapshot().map(owner => {
        // One native recognizer per handle (older hosts) or one per gesture
        // relation signature whose hit targets include this handle.
        const fiber = find(candidate => {
          const props = candidate.memoizedProps;
          if (
            props?.runtime !== gestureRuntime ||
            typeof props.publish !== 'function' ||
            !candidate.memoizedState
          )
            return false;
          if (
            props.id === owner.id &&
            props.registration === owner.registration
          )
            return true;
          const targets = props.channel?.targets ?? props.targets;
          return (
            Array.isArray(targets) &&
            targets.some(
              target =>
                target.id === owner.id && target.ref === owner.registration.ref,
            )
          );
        })[0];
        if (!fiber)
          throw new Error(
            `Registered gesture owner ${owner.id} has not mounted`,
          );
        if (
          fiber.memoizedProps.channel ||
          Array.isArray(fiber.memoizedProps.targets)
        )
          shared = true;
        return { fiber, registration: owner.registration };
      });
      return {
        owners,
        method: shared
          ? 'GestureHostImpl registry snapshot (relation-group recognizers)'
          : 'GestureHostImpl registry snapshot',
      };
    }
    // The same driver can measure the earlier Provider-owned implementation.
    return {
      method: 'legacy Provider gesture owner fibers',
      owners: find(
        fiber =>
          fiber.memoizedProps?.registration?.itemId !== undefined &&
          fiber.memoizedProps.runtime?.motion === runtime.motion &&
          typeof fiber.memoizedProps.publish === 'function' &&
          fiber.memoizedState,
      ).map(fiber => ({
        fiber,
        registration: fiber.memoizedProps.registration,
      })),
    };
  };
  const measureOnRN = ref =>
    new Promise((accept, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Native measurement timed out')),
        1500,
      );
      if (!ref?.current?.measure) {
        clearTimeout(timeout);
        reject(new Error('Native ref is unmounted'));
        return;
      }
      ref.current.measure((_x, _y, width, height, x, y) => {
        clearTimeout(timeout);
        accept({ x, y, width, height });
      });
    });
  let prepared;
  let running = false;
  let statsGeneration = 0;
  let raf;
  let originalCommit;
  let wrappedCommit;
  let unsubscribe;
  const activity = { frames: [], commits: [], publications: [], monitor: null };
  const mark = name => globalThis.performance?.mark?.(`layout-dnd:${name}`);
  const startStats = () => {
    if (running) throw new Error('A diagnostic capture is already running');
    running = true;
    const generation = ++statsGeneration;
    const requestFrame = globalThis.requestAnimationFrame;
    let consecutiveFast = 0;
    activity.monitor = {
      bridgeless: globalThis.RN$Bridgeless ?? null,
      worklet: globalThis._WORKLET === true,
      requestFunction: {
        name: requestFrame.name,
        source: String(requestFrame).slice(0, 1000),
      },
      requestFunctionChanged: false,
      stoppedReason: null,
    };
    originalCommit = devtools.onCommitFiberRoot;
    wrappedCommit = function (...args) {
      activity.commits.push(Date.now());
      return originalCommit?.apply(this, args);
    };
    devtools.onCommitFiberRoot = wrappedCommit;
    unsubscribe = prepared.coordinator.subscribe(() => {
      const snapshot = prepared.coordinator.getSnapshot();
      activity.publications.push({
        wall: Date.now(),
        phase: snapshot.phase,
        seq: snapshot.seq,
        validity: snapshot.validity,
        target: snapshot.target,
      });
    });
    let previousWall = Date.now();
    let previous = performance.now();
    const frame = timestamp => {
      if (!running || generation !== statsGeneration) return;
      const current = performance.now();
      const wall = Date.now();
      const gapMs = current - previous;
      activity.frames.push({
        fromWall: previousWall,
        wall,
        gapMs,
        frameTimestamp: Number.isFinite(timestamp) ? timestamp : null,
      });
      previous = current;
      previousWall = wall;
      activity.monitor.requestFunctionChanged ||=
        globalThis.requestAnimationFrame !== requestFrame;
      consecutiveFast = gapMs >= 0 && gapMs < 1 ? consecutiveFast + 1 : 0;
      if (consecutiveFast >= 32) {
        activity.monitor.stoppedReason =
          'JS rAF monitor stopped after 32 consecutive intervals below 1 ms';
        // Preserve the scenario and cleanup evidence without making a runaway
        // timer chain add tens of thousands of diagnostic callbacks.
        raf = undefined;
        return;
      }
      raf = requestFrame(frame);
    };
    raf = requestFrame(frame);
    return previousWall;
  };
  const stopStats = () => {
    running = false;
    statsGeneration++;
    if (raf !== undefined) cancelAnimationFrame(raf);
    if (devtools.onCommitFiberRoot === wrappedCommit)
      devtools.onCommitFiberRoot = originalCommit;
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const uiScroll = (zones, zoneId, offset, completed) => {
    'worklet';
    const zone = zones.get().find(candidate => candidate.zoneId === zoneId);
    if (!zone || zone.kind !== 'list') {
      scheduleOnRN(completed, false);
      return;
    }
    scrollTo(
      zone.ref,
      zone.orientation === 'horizontal' ? offset : 0,
      zone.orientation === 'vertical' ? offset : 0,
      false,
    );
    scheduleOnRN(completed, true);
  };
  const uiViewport = (zones, zoneId, completed) => {
    'worklet';
    const zone = zones.get().find(candidate => candidate.zoneId === zoneId);
    const rect = zone ? measure(zone.ref) : null;
    scheduleOnRN(
      completed,
      rect
        ? {
            x: rect.pageX,
            y: rect.pageY,
            width: rect.width,
            height: rect.height,
          }
        : null,
    );
  };
  const drive = (input, completed) => {
    'worklet';
    const {
      options,
      motion,
      zones,
      settlement,
      progress,
      config,
      event,
      viewport,
      zoneId,
      sourceRef,
    } = input;
    const begun = performance.now();
    const firstWall = Date.now();
    const initial = motion.get();
    const token = initial.token;
    const stages = [];
    const timeline = [];
    const validationTimeline = [];
    let stage =
      options.scenario === 'idle'
        ? 'idle'
        : options.scenario === 'scroll'
          ? 'scroll'
          : 'drag';
    let stageStart = firstWall;
    let index = 0;
    let holdAt = null;
    let releasedAt = null;
    let releaseFrom;
    let lastEvent = event;
    let releasePointer = null;
    let scrollOffsetsAtRelease = null;
    let sourceUnmounted = false;
    let sourceUnmountedBeforeRelease = false;
    let centeredAt = null;
    let scrollChanged = false;
    let previousOffset =
      zones
        .get()
        .find(zone => zone.zoneId === zoneId)
        ?.offset.get() ?? 0;
    const startOffset = previousOffset;
    let lastScrollStep = -1;
    let stopped = false;
    const scrollOffsets = () =>
      zones
        .get()
        .filter(zone => zone.kind === 'list')
        .map(zone => ({ zoneId: zone.zoneId, offset: zone.offset.get() }));
    const checkpoint = name => {
      const state = motion.get();
      validationTimeline.push({
        name,
        wall: Date.now(),
        elapsedMs: performance.now() - begun,
        token: state.token,
        phase: state.phase,
        pointer: { x: state.pointer.x, y: state.pointer.y },
        sourceUnmounted,
        scrollOffsets: scrollOffsets(),
      });
    };
    const changeStage = name => {
      stages.push({ name: stage, startWall: stageStart, endWall: Date.now() });
      stage = name;
      stageStart = Date.now();
    };
    const finish = error => {
      if (stopped) return;
      stopped = true;
      stages.push({ name: stage, startWall: stageStart, endWall: Date.now() });
      scheduleOnRN(completed, {
        error: error ?? null,
        stages,
        timeline,
        validationTimeline,
        updatesSent: index,
        sourceUnmounted,
        sourceUnmountedBeforeRelease,
        releasePointer,
        scrollOffsetsAtRelease,
        sourceSettleMs:
          releasedAt !== null && centeredAt !== null
            ? releasedAt - centeredAt
            : null,
        scrollChanged,
        token,
        elapsedMs: performance.now() - begun,
      });
    };
    const next = () => {
      if (stopped) return;
      try {
        const now = performance.now();
        const state = motion.get();
        const zone = zones.get().find(candidate => candidate.zoneId === zoneId);
        if (!zone) {
          finish('Source zone disappeared');
          return;
        }
        const offset = zone.offset.get();
        scrollChanged ||= Math.abs(offset - previousOffset) > 1;
        previousOffset = offset;
        if (options.scenario === 'idle' || options.scenario === 'scroll') {
          if (options.scenario === 'scroll') {
            const offsets = [600, 1200, 300, 0, 900, 0];
            const step = Math.min(
              offsets.length - 1,
              Math.floor((now - begun) / (options.durationMs / offsets.length)),
            );
            if (step !== lastScrollStep) {
              lastScrollStep = step;
              scrollTo(
                zone.ref,
                zone.orientation === 'horizontal' ? offsets[step] : 0,
                zone.orientation === 'vertical' ? offsets[step] : 0,
                true,
              );
            }
          }
          if (now - begun >= options.durationMs) {
            finish();
            return;
          }
        } else if (releasedAt === null) {
          if (state.token !== token || state.phase !== 'dragging') {
            finish('Gesture lost activation before release');
            return;
          }
          const edge =
            options.scenario === 'edge-drop' ||
            options.scenario === 'source-unmount';
          const finalY = edge
            ? viewport.y + viewport.height - 12
            : viewport.y + Math.min(viewport.height - 50, 350);
          if (index < options.updates) {
            const fraction = index / Math.max(1, options.updates - 1);
            lastEvent = {
              ...event,
              absoluteY:
                event.absoluteY + (finalY - event.absoluteY) * fraction,
            };
            config.onUpdate(lastEvent);
            index++;
          } else {
            if (holdAt === null) {
              holdAt = now;
              if (options.scenario === 'source-unmount') {
                changeStage('source-unmount');
                scrollTo(zone.ref, 0, startOffset + viewport.height * 8, false);
                checkpoint('source-scroll-jump');
                // The dragged item's cell keeps its committed slot during a
                // same-list preview, so the jump alone can carry it out of the
                // window. Leaving the list also reverts a candidate-order
                // display (the fallback for an uncovered displacement), so the
                // far-away source cell unmounts in either mode.
                lastEvent = {
                  ...event,
                  absoluteX: viewport.x + viewport.width / 2,
                  absoluteY: viewport.y - 24,
                };
                config.onUpdate(lastEvent);
                checkpoint('pointer-outside');
              }
            }
            let readyToRelease;
            if (options.scenario === 'source-unmount') {
              if (!sourceUnmounted && measure(sourceRef) === null) {
                sourceUnmounted = true;
                checkpoint('source-unmounted');
                // Isolate owner loss from the continuous edge-scroll stress
                // scenario: stop auto-scroll, then let geometry settle.
                lastEvent = {
                  ...event,
                  absoluteX: viewport.x + viewport.width / 2,
                  absoluteY: viewport.y + viewport.height / 2,
                };
                config.onUpdate(lastEvent);
                centeredAt = now;
                changeStage('settle');
                checkpoint('pointer-centered');
              }
              if (!sourceUnmounted && now - holdAt >= 5000) {
                checkpoint('source-unmount-timeout');
                finish(
                  'Original native source cell remained mounted for 5000 ms',
                );
                return;
              }
              readyToRelease = centeredAt !== null && now - centeredAt >= 1800;
            } else {
              sourceUnmounted ||= measure(sourceRef) === null;
              readyToRelease = now - holdAt >= (edge ? 1800 : 100);
            }
            if (readyToRelease) {
              changeStage('drop');
              releasedAt = now;
              const current = motion.get();
              releaseFrom = {
                x: current.pointer.x - current.grip.x - current.root.x,
                y: current.pointer.y - current.grip.y - current.root.y,
              };
              const releaseEvent =
                options.scenario === 'source-unmount'
                  ? lastEvent
                  : { ...event, absoluteY: finalY };
              releasePointer = {
                x: releaseEvent.absoluteX,
                y: releaseEvent.absoluteY,
              };
              sourceUnmountedBeforeRelease = sourceUnmounted;
              scrollOffsetsAtRelease = scrollOffsets();
              checkpoint('before-release');
              config.onDeactivate(releaseEvent);
              checkpoint('after-release');
            }
          }
        } else {
          const work = settlement.get();
          const amount = progress.get();
          const x = work?.destination
            ? work.from.x + (work.destination.x - work.from.x) * amount
            : state.pointer.x - state.grip.x - state.root.x;
          const y = work?.destination
            ? work.from.y + (work.destination.y - work.from.y) * amount
            : state.pointer.y - state.grip.y - state.root.y;
          timeline.push({
            t: now - releasedAt,
            wall: Date.now(),
            phase: state.phase,
            visible: state.visible,
            progress: amount,
            moved:
              state.visible &&
              (Math.abs(x - releaseFrom.x) > 0.01 ||
                Math.abs(y - releaseFrom.y) > 0.01),
          });
          if (state.phase === 'idle') {
            finish();
            return;
          }
          if (now - releasedAt >= options.dropTimeoutMs) {
            finish('Native cleanup timed out');
            return;
          }
        }
        if (now - begun > 30000) {
          finish('UI driver timed out');
          return;
        }
        requestAnimationFrame(next);
      } catch (error) {
        finish(String(error));
      }
    };
    requestAnimationFrame(next);
  };
  globalThis.__layoutDndPerf = {
    async prepare(options) {
      const tab = find(
        fiber =>
          fiber.memoizedProps?.children === options.screen &&
          (fiber.type?.name === 'Text' || fiber.type?.displayName === 'Text'),
      )[0];
      let pressed = false;
      for (let fiber = tab; fiber; fiber = fiber.return)
        if (typeof fiber.memoizedProps?.onPress === 'function') {
          fiber.memoizedProps.onPress();
          pressed = true;
          break;
        }
      if (!pressed)
        throw new Error(`Example tab unavailable: ${options.screen}`);
      await delay(options.warmupMs);
      const runtime = context();
      const original = internals(runtime);
      const baseline = original.coordinator.getSnapshot().value;
      const zone = baseline.zones.find(
        candidate =>
          candidate.kind === 'list' && candidate.orientation === 'vertical',
      );
      if (!runtime || !zone || runtime.motion.get().phase !== 'idle')
        throw new Error('Example is not ready and idle');
      if (options.scenario === 'source-unmount') {
        await new Promise(accept =>
          worklets.scheduleOnUI(uiScroll, runtime.zones, zone.id, 2000, accept),
        );
        await delay(1200);
      }
      const viewport = await new Promise(accept =>
        worklets.scheduleOnUI(uiViewport, runtime.zones, zone.id, accept),
      );
      if (!viewport || viewport.width <= 0 || viewport.height <= 0)
        throw new Error('The source viewport has no usable native measurement');
      const ownerSnapshot = gestureOwners(runtime);
      const refs = ownerSnapshot.owners.filter(
        owner => owner.registration.zoneId === zone.id,
      );
      let selected;
      for (const { fiber, registration } of refs) {
        if (
          options.scenario === 'source-unmount' &&
          zone.itemIds.indexOf(registration.itemId) < 12
        )
          continue;
        const rect = await measureOnRN(registration.ref);
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (
          rect.x + rect.width / 2 < viewport.x ||
          rect.x + rect.width / 2 > viewport.x + viewport.width ||
          rect.y + rect.height / 2 < viewport.y ||
          rect.y + rect.height / 2 > viewport.y + viewport.height
        )
          continue;
        // Prefer the top of the visible viewport; the activation callback rejects
        // pinned FlatList refs outside their clipped viewport.
        const config = hooksOf(fiber).find(
          state => state?.[0]?.onActivate,
        )?.[0];
        if (!config?.onDeactivate?.__workletHash) continue;
        const event = {
          absoluteX: rect.x + rect.width / 2,
          absoluteY: rect.y + rect.height / 2,
          numberOfPointers: 1,
          canceled: false,
        };
        selected = {
          config,
          event,
          sourceRef: registration.sourceRef,
          itemId: registration.itemId,
        };
        break;
      }
      if (!selected) throw new Error('No eligible mounted source handle');
      const requiresActivation = !['idle', 'scroll'].includes(options.scenario);
      prepared = {
        ...original,
        options,
        motion: runtime.motion,
        zones: runtime.zones,
        viewport,
        zoneId: zone.id,
        ...selected,
        baselineRevision: baseline.revision,
        itemCount: baseline.items.length,
        requiresActivation,
        activated: !requiresActivation,
        adapter: {
          gestureOwners: ownerSnapshot.method,
          settlement: 'original Provider frame worklet closure',
          renderStore: !!runtime.renderStore,
        },
      };
      return {
        ready: true,
        itemCount: baseline.items.length,
        sourceItemId: selected.itemId,
      };
    },
    async run() {
      if (!prepared) throw new Error('prepare() must complete first');
      if (running) throw new Error('A diagnostic capture is already running');
      activity.frames.length = 0;
      activity.commits.length = 0;
      activity.publications.length = 0;
      const monitorStartedWall = startStats();
      mark('measure:start');
      const activationStages = [];
      let result;
      try {
        // Send original refs and callbacks, never values round-tripped from UI.
        const {
          options,
          motion,
          zones,
          settlement,
          progress,
          config,
          event,
          viewport,
          zoneId,
          sourceRef,
        } = prepared;
        if (prepared.requiresActivation) {
          const activation = {
            name: 'activation',
            startWall: monitorStartedWall,
          };
          mark('activation:start');
          try {
            worklets.scheduleOnUI(config.onBegin);
            worklets.scheduleOnUI(config.onActivate, event);
            const deadline = performance.now() + 2500;
            while (performance.now() < deadline) {
              const native = motion.get();
              const snapshot = prepared.coordinator.getSnapshot();
              if (
                native.phase === 'dragging' &&
                snapshot.phase === 'dragging' &&
                native.itemId === prepared.itemId &&
                snapshot.itemId === prepared.itemId
              ) {
                prepared.activated = true;
                break;
              }
              await delay(20);
            }
            if (!prepared.activated)
              throw new Error(
                'Native and coordinator activation did not agree within 2500 ms',
              );
            // Include the first JS frame after activation so its initial long
            // gap is not discarded at the activation/drag stage boundary.
            await new Promise(accept => requestAnimationFrame(accept));
          } finally {
            activation.endWall = Date.now();
            activation.verified = prepared.activated;
            activationStages.push(activation);
            mark('activation:end');
          }
        }
        result = await new Promise(accept =>
          worklets.scheduleOnUI(
            drive,
            {
              options,
              motion,
              zones,
              settlement,
              progress,
              config,
              event,
              viewport,
              zoneId,
              sourceRef,
            },
            accept,
          ),
        );
        // UI cleanup can finish while JS is blocked. Keep observing until its
        // next frame so the gap crossing the end of drop is still recorded.
        await new Promise(accept => requestAnimationFrame(accept));
      } catch (error) {
        result = {
          error: String(error),
          stack: error?.stack,
          stages: [],
          timeline: [],
          updatesSent: 0,
          sourceUnmounted: false,
          scrollChanged: false,
        };
      } finally {
        mark('measure:end');
        stopStats();
      }
      const snapshot = prepared.coordinator.getSnapshot();
      const dragging = !['idle', 'scroll'].includes(prepared.options.scenario);
      const assertions = {
        activationVerified: prepared.activated,
        driverCompleted: !result.error,
        nativeIdle: prepared.motion.get().phase === 'idle',
        coordinatorIdle: snapshot.phase === 'idle',
        scrollMoved:
          prepared.options.scenario !== 'scroll' || result.scrollChanged,
        sourceUnmounted:
          prepared.options.scenario !== 'source-unmount' ||
          result.sourceUnmountedBeforeRelease,
        sourceSettled:
          prepared.options.scenario !== 'source-unmount' ||
          result.sourceSettleMs >= 1800,
        accepted:
          !dragging ||
          snapshot.value.revision === prepared.baselineRevision + 1,
        updatesComplete:
          !dragging || result.updatesSent === prepared.options.updates,
      };
      const stages = [...activationStages, ...result.stages].map(stage => {
        const inside = wall => wall >= stage.startWall && wall <= stage.endWall;
        const gaps = activity.frames
          .filter(frame => inside(frame.fromWall) && inside(frame.wall))
          .map(frame => frame.gapMs)
          .sort((a, b) => a - b);
        const overlapping = activity.frames
          .filter(
            frame =>
              frame.fromWall < stage.endWall && frame.wall > stage.startWall,
          )
          .map(frame => frame.gapMs);
        return {
          ...stage,
          durationMs: stage.endWall - stage.startWall,
          reactCommits: activity.commits.filter(inside).length,
          jsRafSamples: gaps.length,
          jsRafP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? null,
          jsRafMaxMs: gaps.at(-1) ?? null,
          jsRafOver33: gaps.filter(gap => gap > 33).length,
          jsRafOverlappingSamples: overlapping.length,
          jsRafOverlappingMaxMs: overlapping.length
            ? Math.max(...overlapping)
            : null,
          jsRafOverlappingOver33: overlapping.filter(gap => gap > 33).length,
        };
      });
      return {
        ...result,
        stages,
        assertions,
        valid: Object.values(assertions).every(Boolean),
        itemCount: prepared.itemCount,
        sourceItemId: prepared.itemId,
        adapter: prepared.adapter,
        baselineRevision: prepared.baselineRevision,
        finalRevision: snapshot.value.revision,
        firstVisualMovementMs:
          result.timeline.find(sample => sample.moved)?.t ?? null,
        firstNativeIdleMs:
          result.timeline.find(sample => sample.phase === 'idle')?.t ?? null,
        activity,
      };
    },
    dispose() {
      stopStats();
      if (prepared && prepared.coordinator.getSnapshot().phase !== 'idle')
        prepared.coordinator.cancel('gesture-interrupted');
      prepared = undefined;
    },
  };
})();
