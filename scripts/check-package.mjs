import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'layout-dnd-package-'));

try {
  assert.ok(
    existsSync(path.join(root, 'lib/module/index.js')),
    'Run yarn build before checking the package.',
  );
  const [packed] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--offline',
        '--cache',
        path.join(scratch, 'npm-cache'),
        '--pack-destination',
        scratch,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  for (const { path: file } of packed.files) {
    assert.match(file, /^(src\/|lib\/|package\.json$|README\.md$|LICENSE$)/);
    assert.doesNotMatch(file, /(^|\/)(node_modules|tests|\.npmrc|\.env)(\/|$)/);
  }

  execFileSync('tar', [
    '-xzf',
    path.join(scratch, packed.filename),
    '-C',
    scratch,
  ]);
  const modules = path.join(scratch, 'node_modules');
  mkdirSync(modules);
  const packageRoot = path.join(modules, 'react-native-layout-dnd');
  renameSync(path.join(scratch, 'package'), packageRoot);
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json')));
  for (const entry of ['.', './engine']) {
    for (const target of Object.values(pkg.exports[entry])) {
      assert.ok(
        existsSync(path.join(packageRoot, target)),
        `Missing ${target}`,
      );
    }
  }

  for (const file of readdirSync(path.join(packageRoot, 'lib'), {
    recursive: true,
  })) {
    if (!/\.(js|ts)$/.test(file)) continue;
    const code = readFileSync(path.join(packageRoot, 'lib', file), 'utf8');
    assert.doesNotMatch(code, /@\/libs\/|ttm_superapp|__workletHash/);
  }

  // The actual packed engine must load without installing any native peers.
  writeFileSync(
    path.join(scratch, 'consumer.mjs'),
    `import assert from 'node:assert/strict';
       import {
         packItems, validateValue, validateLayoutState, fromGridValue, toGridValue,
         DEFAULT_SEARCH_BUDGET, DEFAULT_GRID_MOVEMENT_POLICY, HOME_GRID_MOVEMENT_POLICY,
         resolveGridMovementPolicy, validateGridMovementPolicy, computeMove,
         createGridStateStore, respondToGridProposal, screenToContent,
         computeListLayout, computeListIndex, ListSizeCache, computeLayoutMove,
         createDndStateStore, computeAutoScroll, constrainDragPoint,
         resolveListVirtualization
       } from 'react-native-layout-dnd/engine';
       const result = packItems({
         items: [{ id: 'a', span: { rows: 1, cols: 1 }, data: { label: 'A' } }],
         rows: 2, columns: 2, searchBudget: 100
       });
       assert.equal(result.status, 'ok');
       const original = { revision: 4, zones: [
         { id: 'board', strategy: 'spatial', rows: 2, columns: 2, items: result.placements },
         { id: 'tray', strategy: 'spatial', rows: 1, columns: 2, items: [] }
       ] };
       assert.equal(validateValue(original).valid, true);

       const layout = fromGridValue(original);
       assert.equal(layout.valid, true);
       assert.equal(validateLayoutState(layout.value).valid, true);
       assert.equal(layout.value.revision, 4);
       assert.equal(layout.value.items[0].data, result.placements[0].data);
       assert.deepEqual(toGridValue(layout.value), { valid: true, value: original });
       const list = { revision: 0, items: [{ id: 'a', data: null }], zones: [
         { id: 'list', kind: 'list', orientation: 'vertical', itemIds: ['a'] }
       ] };
       assert.equal(validateLayoutState(list).valid, true);
       assert.equal(toGridValue(list).issues[0].code, 'unsupported-zone');
       assert.equal(validateLayoutState({ ...list, items: [] }).valid, false);

       assert.equal(Number.isSafeInteger(DEFAULT_SEARCH_BUDGET), true);
       assert.ok(DEFAULT_SEARCH_BUDGET > 0);
       assert.equal(DEFAULT_GRID_MOVEMENT_POLICY.adjacentInsertExchange, 'disabled');
       assert.equal(HOME_GRID_MOVEMENT_POLICY.adjacentInsertExchange, 'single-cell');
       assert.equal(HOME_GRID_MOVEMENT_POLICY.rowRotation, 'full-width');
       assert.equal(validateGridMovementPolicy(HOME_GRID_MOVEMENT_POLICY).valid, true);
       assert.deepEqual(resolveGridMovementPolicy(), DEFAULT_GRID_MOVEMENT_POLICY);
       assert.deepEqual(screenToContent({ x: 30, y: 90 }, {
         viewport: { source: 'measured', space: 'screen', revision: 4, timestampMs: 100,
           rect: { x: 20, y: 80, width: 200, height: 300 } },
         scrollOffset: { x: 0, y: 150 }
       }, { revision: 4 }), { valid: true, value: { x: 10, y: 160 } });

       const store = createGridStateStore(original);
       const before = store.getSnapshot();
       const moved = computeMove({ value: before, itemId: 'a',
         to: { zoneId: 'tray', strategy: 'spatial', position: { row: 0, col: 1 } } });
       assert.equal(moved.status, 'ok');
       assert.equal(moved.value.revision, 5);
       assert.equal(before.zones[0].items.length, 1);
       assert.equal(before.zones[1].items.length, 0);
       const proposal = { sessionId: 'packed-transfer', itemId: 'a', baseRevision: 4,
         from: moved.from, to: moved.to, value: moved.value };
       const rejected = respondToGridProposal(before, proposal, false);
       assert.equal(rejected.status, 'rejected');
       assert.equal(rejected.value.zones, before.zones);
       assert.equal(rejected.value.revision, 4);
       assert.equal(store.getSnapshot(), before);
       const notifications = [];
       const unsubscribe = store.subscribe(() => notifications.push(store.getSnapshot()));
       assert.equal(store.respond(proposal, true).status, 'accepted');
       assert.equal(notifications.length, 1);
       const committed = notifications[0];
       assert.equal(committed.revision, 5);
       assert.equal(committed.zones[0].items.length, 0);
       assert.equal(committed.zones[1].items[0].data, result.placements[0].data);
       assert.deepEqual(committed.proposalResponse,
         { sessionId: 'packed-transfer', baseRevision: 4, accepted: true });
       assert.equal(store.respond(proposal, true).status, 'stale');
       assert.equal(notifications.length, 1);
       assert.equal(store.getSnapshot(), committed);
       unsubscribe();

       const cache = new ListSizeCache();
       const context = { orientation: 'vertical', crossSize: 200 };
       assert.equal(cache.set('a', 30, context, 7), true);
       assert.equal(cache.set('b', 90, context, 7), true);
       assert.equal(cache.set('b', 10, context, 6), false);
       const listInput = { itemIds: ['a', 'b', 'c'], ...context, cache,
         estimatedItemSize: 50, gap: 8, paddingStart: 12, paddingEnd: 18, revision: 7 };
       const measuredList = computeListLayout(listInput);
       assert.equal(measuredList.valid, true);
       assert.equal(measuredList.totalSize, 216);
       assert.deepEqual(measuredList.entries.map(entry => [entry.itemId, entry.start, entry.size, entry.source]),
         [['a', 12, 30, 'measured'], ['b', 50, 90, 'measured'], ['c', 148, 50, 'estimated']]);
       assert.equal(computeListIndex(measuredList, 'a', 100), 1);
       assert.equal(computeListIndex(measuredList, 'a', 95), 0);
       const reorderedList = computeListLayout({ ...listInput, itemIds: ['b', 'a', 'c'], revision: 8 });
       assert.equal(reorderedList.valid, true);
       assert.deepEqual(reorderedList.entries.map(entry => [entry.itemId, entry.start, entry.size]),
         [['b', 12, 90], ['a', 110, 30], ['c', 148, 50]]);
       assert.ok(reorderedList.entries.every(entry => entry.revision === 8));
       assert.equal(cache.get('a', context), 30);
       assert.equal(cache.get('a', { ...context, crossSize: 300 }), undefined);

       const normalized = { revision: 7,
         items: ['a', 'b', 'c', 'd'].map(id => ({ id, data: { label: id.toUpperCase() } })),
         zones: [
           { id: 'source', kind: 'list', orientation: 'vertical', itemIds: ['a', 'b', 'c'] },
           { id: 'destination', kind: 'list', orientation: 'horizontal', itemIds: ['d'] },
           { id: 'unrelated', kind: 'grid', rows: 2, columns: 3, placements: [] }
         ] };
       const reordered = computeLayoutMove({ value: normalized, itemId: 'a',
         to: { kind: 'list', zoneId: 'source', index: 2 } });
       assert.equal(reordered.status, 'ok');
       assert.equal(reordered.value.revision, 8);
       assert.deepEqual(reordered.value.zones[0].itemIds, ['b', 'c', 'a']);
       assert.equal(reordered.value.items, normalized.items);
       assert.equal(reordered.value.zones[1], normalized.zones[1]);
       assert.deepEqual(normalized.zones[0].itemIds, ['a', 'b', 'c']);

       const listStore = createDndStateStore(normalized);
       const baseline = listStore.getSnapshot();
       const transfer = computeLayoutMove({ value: baseline, itemId: 'b',
         to: { kind: 'list', zoneId: 'destination', index: 1 } });
       assert.equal(transfer.status, 'ok');
       assert.deepEqual(transfer.value.zones[0].itemIds, ['a', 'c']);
       assert.deepEqual(transfer.value.zones[1].itemIds, ['d', 'b']);
       assert.equal(transfer.value.zones[2], baseline.zones[2]);
       assert.equal(transfer.value.items, baseline.items);
       assert.equal(transfer.value.items[1].data, baseline.items[1].data);
       assert.equal(transfer.value.revision, 8);
       const listProposal = { sessionId: 'packed-list-rejected', itemId: 'b', baseRevision: 7,
         from: transfer.from, to: transfer.to, value: transfer.value };
       const listNotifications = [];
       const stopList = listStore.subscribe(() => listNotifications.push(listStore.getSnapshot()));
       assert.equal(listStore.respond(listProposal, false).status, 'rejected');
       assert.equal(listNotifications.length, 1);
       assert.equal(listStore.getSnapshot().zones, baseline.zones);
       assert.equal(listStore.getSnapshot().revision, 7);
       assert.equal(listStore.respond(listProposal, true).status, 'stale');
       const acceptedProposal = { ...listProposal, sessionId: 'packed-list-accepted' };
       assert.equal(listStore.respond(acceptedProposal, true).status, 'accepted');
       assert.equal(listNotifications.length, 2);
       const acceptedList = listNotifications[1];
       assert.equal(acceptedList.revision, 8);
       assert.deepEqual(acceptedList.zones[0].itemIds, ['a', 'c']);
       assert.deepEqual(acceptedList.zones[1].itemIds, ['d', 'b']);
       assert.equal(acceptedList.items, normalized.items);
       assert.equal(validateLayoutState(acceptedList).valid, true);
       assert.deepEqual(acceptedList.proposalResponse,
         { sessionId: 'packed-list-accepted', baseRevision: 7, accepted: true });
       assert.deepEqual(baseline.zones[0].itemIds, ['a', 'b', 'c']);
       assert.deepEqual(baseline.zones[1].itemIds, ['d']);
       assert.equal(listStore.respond(acceptedProposal, true).status, 'stale');
       assert.equal(listNotifications.length, 2);
       stopList();

       const mixedStore = createDndStateStore(normalized);
       const mixedBaseline = mixedStore.getSnapshot();
       const intoGridInput = { value: mixedBaseline, itemId: 'b',
         to: { kind: 'grid', zoneId: 'unrelated', position: { row: 0, col: 0 } } };
       const missingSpan = computeLayoutMove(intoGridInput);
       assert.equal(missingSpan.status, 'invalid');
       assert.equal(missingSpan.issues[0].code, 'missing-item-span');
       const intoGrid = computeLayoutMove({ ...intoGridInput,
         gridItem: { span: { rows: 2, cols: 2 }, placement: 'exchange' } });
       assert.equal(intoGrid.status, 'ok');
       assert.equal(intoGrid.value.revision, 8);
       assert.deepEqual(intoGrid.value.zones[0].itemIds, ['a', 'c']);
       assert.deepEqual(intoGrid.value.zones[2].placements,
         [{ itemId: 'b', position: { row: 0, col: 0 }, span: { rows: 2, cols: 2 }, placement: 'exchange' }]);
       assert.equal(intoGrid.value.items, normalized.items);
       assert.equal(intoGrid.value.zones[1], normalized.zones[1]);
       const mixedProposal = { sessionId: 'packed-mixed-rejected', itemId: 'b', baseRevision: 7,
         from: intoGrid.from, to: intoGrid.to, value: intoGrid.value };
       const mixedNotifications = [];
       const stopMixed = mixedStore.subscribe(() => mixedNotifications.push(mixedStore.getSnapshot()));
       assert.equal(mixedStore.respond(mixedProposal, false).status, 'rejected');
       assert.equal(mixedNotifications.length, 1);
       assert.equal(mixedNotifications[0].zones, normalized.zones);
       assert.equal(mixedNotifications[0].revision, 7);
       assert.equal(mixedStore.respond({ ...mixedProposal, sessionId: 'packed-mixed-accepted' }, true).status, 'accepted');
       assert.equal(mixedNotifications.length, 2);
       assert.equal(mixedNotifications[1].revision, 8);
       assert.equal(validateLayoutState(mixedNotifications[1]).valid, true);
       assert.deepEqual(mixedNotifications[1].zones[0].itemIds, ['a', 'c']);
       assert.equal(mixedNotifications[1].zones[2].placements[0].itemId, 'b');
       const backToList = computeLayoutMove({ value: mixedStore.getSnapshot(), itemId: 'b',
         to: { kind: 'list', zoneId: 'destination', index: 1 } });
       assert.equal(backToList.status, 'ok');
       const backProposal = { sessionId: 'packed-grid-to-list', itemId: 'b', baseRevision: 8,
         from: backToList.from, to: backToList.to, value: backToList.value };
       mixedStore.onChange(backToList.value, backProposal);
       assert.equal(mixedNotifications.length, 3);
       assert.equal(mixedStore.getSnapshot().revision, 9);
       assert.deepEqual(mixedStore.getSnapshot().zones[2].placements, []);
       assert.deepEqual(mixedStore.getSnapshot().zones[1].itemIds, ['d', 'b']);
       assert.equal(mixedStore.getSnapshot().items, normalized.items);
       assert.deepEqual(normalized.zones[0].itemIds, ['a', 'b', 'c']);
       assert.deepEqual(normalized.zones[2].placements, []);
       stopMixed();

       const crossGridBaseline = { ...intoGrid.value, zones: [...intoGrid.value.zones,
         { id: 'other-grid', kind: 'grid', rows: 3, columns: 4, placements: [] }] };
       const crossGrid = computeLayoutMove({ value: crossGridBaseline, itemId: 'b',
         to: { kind: 'grid', zoneId: 'other-grid', position: { row: 1, col: 0 } },
         gridItem: { span: { rows: 1, cols: 3 }, placement: 'insert' } });
       assert.equal(crossGrid.status, 'ok');
       assert.deepEqual(crossGrid.value.zones[2].placements, []);
       assert.deepEqual(crossGrid.value.zones[3].placements,
         [{ itemId: 'b', position: { row: 1, col: 0 }, span: { rows: 1, cols: 3 }, placement: 'insert' }]);
       assert.equal(crossGrid.value.items, normalized.items);

       const cell = (itemId, row, col, rows = 1, cols = 1, placement = 'insert') =>
         ({ itemId, position: { row, col }, span: { rows, cols }, placement });
       const homeValue = { revision: 0,
         items: ['active', 'neighbor', 'panel'].map(id => ({ id, data: { label: id } })),
         zones: [{ id: 'home', kind: 'grid', rows: 5, columns: 4, placements: [
           cell('active', 0, 1), cell('neighbor', 0, 3), cell('panel', 1, 0, 4, 4, 'exchange')
         ] }] };
       const homeInput = { value: homeValue, itemId: 'active',
         to: { kind: 'grid', zoneId: 'home', position: { row: 1, col: 1 } } };
       assert.equal(computeLayoutMove(homeInput).status, 'impossible');
       const homeMove = computeLayoutMove({ ...homeInput, movementPolicy: HOME_GRID_MOVEMENT_POLICY });
       assert.equal(homeMove.status, 'ok');
       assert.deepEqual(homeMove.to, { kind: 'grid', zoneId: 'home', position: { row: 4, col: 1 } });
       const legacyHomeValue = toGridValue(homeValue);
       assert.equal(legacyHomeValue.valid, true);
       const legacyHomeMove = computeMove({ value: legacyHomeValue.value, itemId: 'active',
         to: { strategy: 'spatial', zoneId: 'home', position: { row: 1, col: 1 } },
         movementPolicy: HOME_GRID_MOVEMENT_POLICY });
       assert.equal(legacyHomeMove.status, 'ok');
       assert.deepEqual(homeMove.value.zones[0].placements.map(item => [item.itemId, item.position]),
         legacyHomeMove.value.zones[0].items.map(item => [item.id, item.position]));

       const constrained = { revision: 0,
         items: ['A', 'panel', 'X'].map(id => ({ id, data: null })),
         zones: [
           { id: 'small-grid', kind: 'grid', rows: 1, columns: 3,
             placements: [cell('A', 0, 0), cell('panel', 0, 1, 1, 1, 'exchange')] },
           { id: 'queue', kind: 'list', orientation: 'vertical', itemIds: ['X'] }
         ] };
       const constrainedBefore = JSON.stringify(constrained);
       const constrainedInput = { value: constrained, itemId: 'X',
         to: { kind: 'grid', zoneId: 'small-grid', position: { row: 0, col: 0 } },
         gridItem: { span: { rows: 1, cols: 1 }, placement: 'insert' } };
       assert.deepEqual(computeLayoutMove({ ...constrainedInput, searchBudget: 2 }),
         { status: 'unresolved', attempts: 2 });
       assert.equal(computeLayoutMove({ ...constrainedInput, searchBudget: 3 }).status, 'ok');
       const fullGrid = { ...constrained, zones: constrained.zones.map(zone =>
         zone.kind === 'grid' ? { ...zone, columns: 2 } : zone) };
       assert.deepEqual(computeLayoutMove({ ...constrainedInput, value: fullGrid, searchBudget: 100 }),
         { status: 'impossible', attempts: 2 });
       assert.equal(JSON.stringify(constrained), constrainedBefore);
       assert.deepEqual(fullGrid.zones[1].itemIds, ['X']);

       const scrollFrame = { pointer: 220, viewportStart: 20, viewportSize: 200,
         contentSize: 1000, offset: 100, deltaTimeMs: 10000 };
       const auto = computeAutoScroll(scrollFrame);
       assert.equal(auto.valid, true);
       assert.ok(Math.abs(auto.offset - 138.4) < 1e-9);
       const end = computeAutoScroll({ ...scrollFrame, offset: 799 });
       assert.equal(end.valid, true);
       assert.equal(end.offset, 800);
       assert.ok(end.velocity > 0 && end.velocity <= 600);
       assert.deepEqual(computeAutoScroll({ ...scrollFrame, options: { enabled: false } }),
         { valid: true, offset: 100, velocity: 0 });
       assert.deepEqual(computeAutoScroll({ ...scrollFrame, options: { edgeThreshold: 0 } }),
         { valid: false, reason: 'invalid-options' });
       const slow = computeAutoScroll({ ...scrollFrame, pointer: 215, deltaTimeMs: 32,
         options: { edgeThreshold: 10, maxSpeed: 100 } });
       assert.equal(slow.valid, true);
       assert.ok(Math.abs(slow.offset - 101.6) < 1e-9);
       assert.deepEqual(constrainDragPoint({ x: 10, y: 20 }, { x: 1, y: 2 }, 'x'),
         { x: 10, y: 2 });

       assert.deepEqual(resolveListVirtualization(undefined), { valid: true, options: null });
       assert.deepEqual(resolveListVirtualization(false), { valid: true, options: null });
       assert.deepEqual(resolveListVirtualization(true), { valid: true, options: {
         initialNumToRender: 12, maxToRenderPerBatch: 12, windowSize: 7, updateCellsBatchingPeriod: 50
       } });
       assert.deepEqual(resolveListVirtualization({ windowSize: 3, updateCellsBatchingPeriod: 0 }),
         { valid: true, options: {
           initialNumToRender: 12, maxToRenderPerBatch: 12, windowSize: 3, updateCellsBatchingPeriod: 0
         } });
       for (const invalidWindow of [null, { windowSize: 1 }, { initialNumToRender: 1.5 },
           { maxToRenderPerBatch: 0 }, { updateCellsBatchingPeriod: NaN }, { unknown: 1 }]) {
         const invalid = resolveListVirtualization(invalidWindow);
         assert.equal(invalid.valid, false);
         assert.equal(invalid.issues[0].code, 'invalid-configuration');
       }`,
  );
  execFileSync(process.execPath, [path.join(scratch, 'consumer.mjs')], {
    cwd: scratch,
    stdio: 'pipe',
  });

  writeFileSync(
    path.join(scratch, 'consumer.ts'),
    `import {
       packItems, validateLayoutState, fromGridValue, toGridValue, computeMove,
       createGridStateStore, respondToGridProposal, screenToContent,
       DEFAULT_SEARCH_BUDGET, DEFAULT_GRID_MOVEMENT_POLICY, HOME_GRID_MOVEMENT_POLICY,
       type CellSpan, type DndItem, type LayoutState, type MoveProposal,
       type ProposalResponse, type GridValue, type GridProposal, type GridMovementPolicy,
       type RectMeasurement, type ZoneCoordinateContext,
       computeListLayout, computeListIndex, ListSizeCache, computeLayoutMove,
       createDndStateStore, computeAutoScroll, constrainDragPoint,
       type ListLayout, type ListLayoutInput, type ListMeasurementContext,
       type GridItemLayout, type LayoutMoveInput, type LayoutMoveResult, type DndProposal,
       type DndValue, type DndStateStore, type AutoScrollOptions,
       type AutoScrollInput, type AutoScrollResult, type DragAxis,
       resolveListVirtualization, type ListVirtualizationOptions, type ListVirtualizationResult
     } from 'react-native-layout-dnd/engine';
     const result = packItems({
       items: [{ id: 'a', span: { rows: 1, cols: 1 }, data: { label: 'A' } }],
       rows: 2, columns: 2, searchBudget: 100
     });
     if (result.status === 'ok') {
       const label: string = result.placements[0]!.data.label;
       void label;
     }
     // @ts-expect-error A span cannot contain a string dimension.
     const invalid: CellSpan = { rows: 'two', cols: 1 };
     void invalid;

     const item: DndItem<{ label: string }> = { id: 'a', data: { label: 'A' } };
     const layout: LayoutState<typeof item.data> = { revision: 0, items: [item], zones: [
       { id: 'list', kind: 'list', orientation: 'horizontal', itemIds: ['a'] }
     ] };
     validateLayoutState(layout);
     const sharedProposal: MoveProposal<typeof layout> = {
       sessionId: 'shared', itemId: 'a', baseRevision: layout.revision,
       from: { kind: 'list', zoneId: 'list', index: 0 },
       to: { kind: 'list', zoneId: 'list', index: 0 }, value: layout
     };
     const response: ProposalResponse = { sessionId: sharedProposal.sessionId,
       baseRevision: sharedProposal.baseRevision, accepted: true };
     void response;
     // @ts-expect-error Revision is mandatory for a shared proposal response.
     const missingRevision: ProposalResponse = { sessionId: 'shared', accepted: true };
     void missingRevision;
     // @ts-expect-error List order has an orientation, not a grid strategy.
     const invalidList: LayoutState<null> = { revision: 0, items: [], zones: [{ id: 'l', kind: 'list', orientation: 'spatial', itemIds: [] }] };
     void invalidList;

     const grid: GridValue<typeof item.data> = { revision: 0, zones: [{
       id: 'board', strategy: 'spatial', rows: 2, columns: 2,
       items: [{ ...item, span: { rows: 1, cols: 1 }, position: { row: 0, col: 0 } }]
     }] };
     const converted = fromGridValue(grid);
     if (converted.valid) {
       const label: string = converted.value.items[0]!.data.label;
       const restored = toGridValue(converted.value);
       if (restored.valid) {
         const restoredLabel: string = restored.value.zones[0]!.items[0]!.data.label;
         void restoredLabel;
       }
       void label;
     }
     const budget: number = DEFAULT_SEARCH_BUDGET;
     const policies: GridMovementPolicy[] = [DEFAULT_GRID_MOVEMENT_POLICY, HOME_GRID_MOVEMENT_POLICY];
     void budget;
     void policies;
     const store = createGridStateStore(grid);
     const moved = computeMove({ value: store.getSnapshot(), itemId: 'a',
       movementPolicy: HOME_GRID_MOVEMENT_POLICY,
       to: { zoneId: 'board', strategy: 'spatial', position: { row: 1, col: 1 } } });
     if (moved.status === 'ok' && moved.value.revision !== undefined) {
       const proposal: GridProposal<typeof item.data> = { sessionId: 'grid', itemId: 'a',
         baseRevision: store.getSnapshot().revision, from: moved.from, to: moved.to,
         value: { ...moved.value, revision: moved.value.revision } };
       const applied = respondToGridProposal(store.getSnapshot(), proposal, true);
       const label: string = applied.value.zones[0]!.items[0]!.data.label;
       store.respond(proposal, true);
       void label;
     }
     const measurement: RectMeasurement<'screen'> = { source: 'measured', space: 'screen',
       revision: 0, timestampMs: 0, rect: { x: 0, y: 0, width: 100, height: 100 } };
     const frame: ZoneCoordinateContext = { viewport: measurement, scrollOffset: { x: 0, y: 10 } };
     const point = screenToContent({ x: 10, y: 20 }, frame, { revision: 0 });
     if (point.valid) { const y: number = point.value.y; void y; }

     const cache = new ListSizeCache();
     const context: ListMeasurementContext = { orientation: 'horizontal', crossSize: 100, epoch: 1 };
     const measured: boolean = cache.set('a', 45, context, 0);
     const cached: number | undefined = cache.get('a', context);
     void measured; void cached;
     const listInput: ListLayoutInput = { itemIds: ['a'], ...context, revision: 0, measurementEpoch: context.epoch,
       cache, estimatedItemSize: 40, itemSize: (itemId, index) => itemId.length + index + 30 };
     const listResult = computeListLayout(listInput);
     if (listResult.valid) {
       const geometry: ListLayout = listResult;
       const index: number | null = computeListIndex(geometry, 'a', 40);
       const source: 'measured' | 'estimated' = geometry.entries[0]!.source;
       void index; void source;
     }
     // @ts-expect-error The size resolver must return a number.
     const wrongItemSize: ListLayoutInput = { ...listInput, itemSize: () => 'large' };
     void wrongItemSize;

     const dndStore: DndStateStore<typeof item.data> = createDndStateStore(layout);
     const dndValue: DndValue<typeof item.data> = dndStore.getSnapshot();
     const moveInput: LayoutMoveInput<typeof item.data> = { value: dndValue, itemId: 'a',
       to: { kind: 'list', zoneId: 'list', index: 0 } };
     const layoutMove: LayoutMoveResult<typeof item.data> = computeLayoutMove(moveInput);
     if (layoutMove.status === 'ok') {
       const label: string = layoutMove.value.items[0]!.data.label;
       const proposal: DndProposal<typeof item.data> = { sessionId: 'normalized', itemId: 'a',
         baseRevision: dndValue.revision, from: layoutMove.from, to: layoutMove.to, value: layoutMove.value };
       const response = dndStore.respond(proposal, false);
       const responseLabel: string = response.value.items[0]!.data.label;
       void label; void responseLabel;
     }
     // @ts-expect-error Store item data retains its inferred label type.
     const wrongData: DndStateStore<{ label: number }> = createDndStateStore(layout);
     void wrongData;
     // @ts-expect-error A normalized list target requires an insertion index.
     computeLayoutMove({ value: layout, itemId: 'a', to: { kind: 'list', zoneId: 'list' } });

     const descriptor: GridItemLayout = { span: { rows: 2, cols: 1 }, placement: 'exchange' };
     const gridMove = computeLayoutMove({ value: layout, itemId: 'a',
       to: { kind: 'grid', zoneId: 'board', position: { row: 0, col: 0 } },
       gridItem: descriptor, movementPolicy: HOME_GRID_MOVEMENT_POLICY, searchBudget: 100 });
     if (gridMove.status === 'ok') {
       const movedLabel: string = gridMove.value.items[0]!.data.label;
       void movedLabel;
     } else if (gridMove.status === 'impossible' || gridMove.status === 'unresolved') {
       const attempts: number = gridMove.attempts;
       void attempts;
       // @ts-expect-error Failed searches do not expose a partially modified value.
       void gridMove.value;
     }
     // @ts-expect-error Grid descriptors keep the existing placement policy vocabulary.
     const wrongDescriptor: GridItemLayout = { span: { rows: 1, cols: 1 }, placement: 'resize' };
     void wrongDescriptor;

     const scrollOptions: AutoScrollOptions = { enabled: true, edgeThreshold: 30, maxSpeed: 400 };
     const scrollInput: AutoScrollInput = { pointer: 180, viewportStart: 20, viewportSize: 160,
       offset: 0, contentSize: 900, deltaTimeMs: 16, options: scrollOptions };
     const scrollResult: AutoScrollResult = computeAutoScroll(scrollInput);
     if (scrollResult.valid) {
       const nextOffset: number = scrollResult.offset;
       const speed: number = scrollResult.velocity;
       void nextOffset; void speed;
     } else {
       const reason: 'invalid-input' | 'invalid-options' = scrollResult.reason;
       void reason;
     }
     const axis: DragAxis = 'y';
     const constrainedY: number = constrainDragPoint({ x: 20, y: 30 }, { x: 0, y: 0 }, axis).y;
     void constrainedY;
     // @ts-expect-error Drag axis describes screen coordinates, not list orientation.
     const invalidAxis: DragAxis = 'vertical';
     void invalidAxis;

     const virtualizationOptions: ListVirtualizationOptions = { initialNumToRender: 8,
       maxToRenderPerBatch: 10, windowSize: 5, updateCellsBatchingPeriod: 25 };
     const virtualizationResult: ListVirtualizationResult = resolveListVirtualization(virtualizationOptions);
     if (virtualizationResult.valid && virtualizationResult.options) {
       const windowSize: number = virtualizationResult.options.windowSize;
       const initialCount: number = virtualizationResult.options.initialNumToRender;
       void windowSize; void initialCount;
     }
     // @ts-expect-error Rendering limits are numbers, not string labels.
     const wrongWindow: ListVirtualizationOptions = { windowSize: 'small' };
     void wrongWindow;`,
  );
  writeFileSync(
    path.join(scratch, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: [],
      },
      files: ['consumer.ts'],
    }),
  );
  execFileSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '--project', scratch],
    { cwd: scratch, stdio: 'pipe' },
  );

  // Root component declarations need native peer types. Link the pinned local
  // dependencies only after the isolated, peer-free engine checks above pass.
  for (const dependency of [
    ...Object.keys(pkg.peerDependencies),
    '@types/react',
  ]) {
    const source = path.join(root, 'node_modules', dependency);
    const target = path.join(modules, dependency);
    assert.ok(existsSync(source), `Install the declared peer ${dependency}.`);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(source, target, 'dir');
  }
  writeFileSync(
    path.join(scratch, 'component-consumer.tsx'),
    `import { DndProvider, SortableList, SortableGrid,
       type SortableListProps, type ListItemRenderArgs, type ListVirtualizationOptions,
       type SortableGridProps, type GridItemRenderArgs, type DndProviderProps,
       type GridItemLayout, type GridItemLayoutResolverArgs,
       type DndDropFailureReason } from 'react-native-layout-dnd';
     type Task = { title: string; priority: number };
     const options: ListVirtualizationOptions = { initialNumToRender: 6,
       maxToRenderPerBatch: 8, windowSize: 5, updateCellsBatchingPeriod: 0 };
     const props: SortableListProps<Task> = {
       zoneId: 'tasks', virtualization: options, estimatedItemSize: 72,
       renderItem: ({ item, index, zoneId, isDragging }) => {
         const title: string = item.data.title;
         const priority: number = item.data.priority;
         const position: number = index;
         const zone: string = zoneId;
         const dragging: boolean = isDragging;
         void title; void priority; void position; void zone; void dragging;
         // @ts-expect-error Public renderItem data keeps its generic field types.
         const wrongPriority: string = item.data.priority;
         void wrongPriority;
         return null;
       }
     };
     const automatic: SortableListProps<Task> = { ...props, virtualization: true };
     const scrollView: SortableListProps<Task> = { ...props, virtualization: false };
     const omitted: SortableListProps<Task> = { zoneId: 'tasks', renderItem: props.renderItem };
     const partial: SortableListProps<Task> = { ...props, virtualization: { windowSize: 3 } };
     const renderer: (args: ListItemRenderArgs<Task>) => unknown = props.renderItem;
     void automatic; void scrollView; void omitted; void partial; void renderer;
     // @ts-expect-error virtualization accepts a boolean or an options object.
     const wrongMode: SortableListProps<Task> = { ...props, virtualization: 'flatlist' };
     void wrongMode;
     // @ts-expect-error Individual render limits must retain numeric types.
     const wrongLimit: SortableListProps<Task> = { ...props, virtualization: { maxToRenderPerBatch: '8' } };
     void wrongLimit;
     // @ts-expect-error Unknown render options are not public FlatList passthrough props.
     const unknownLimit: SortableListProps<Task> = { ...props, virtualization: { removeClippedSubviews: true } };
     void unknownLimit;

     const gridProps: SortableGridProps<Task> = {
       zoneId: 'board',
       geometry: { mode: 'fixed', cellWidth: 80, cellHeight: 60, rowGap: 4, columnGap: 4,
         padding: { top: 0, right: 0, bottom: 0, left: 0 } },
       dropIndicatorStyle: { borderWidth: 1 },
       renderItem: ({ item, index, zoneId, isDragging, position, span, placement, width, height }) => {
         const title: string = item.data.title;
         const priority: number = item.data.priority;
         const row: number = position.row;
         const columns: number = span.cols;
         const behavior: 'insert' | 'exchange' | undefined = placement;
         const size: number = width * height;
         void title; void priority; void row; void columns; void behavior; void size;
         void index; void zoneId; void isDragging;
         // @ts-expect-error The grid renderer preserves the same Task data shape.
         const wrongTitle: number = item.data.title;
         void wrongTitle;
         return null;
       }
     };
     const gridRenderer: (args: GridItemRenderArgs<Task>) => unknown = gridProps.renderItem;
     const providerProps: DndProviderProps<Task> = {
       children: null,
       value: { revision: 0, items: [{ id: 'task', data: { title: 'Task', priority: 1 } }], zones: [
         { id: 'tasks', kind: 'list', orientation: 'vertical', itemIds: ['task'] },
         { id: 'board', kind: 'grid', rows: 2, columns: 2, placements: [] }
       ] },
       onChange: (next, proposal) => {
         const title: string = next.items[0]!.data.title;
         const proposedTitle: string = proposal.value.items[0]!.data.title;
         void title; void proposedTitle;
       },
       getGridItemLayout: ({ item, from, target, value }) => {
         const title: string = item.data.title;
         const targetRows: number = target.rows;
         const revision: number = value.revision;
         void title; void targetRows; void revision; void from;
         return { span: { rows: 1, cols: item.data.priority }, placement: 'insert' };
       },
       searchBudget: 500
     };
     const resolver: (args: GridItemLayoutResolverArgs<Task>) => GridItemLayout | null =
       providerProps.getGridItemLayout!;
     const failure: DndDropFailureReason = 'missing-grid-item-layout';
     const tree = <DndProvider {...providerProps}>
       <SortableList {...props} />
       <SortableGrid {...gridProps} />
     </DndProvider>;
     void gridRenderer; void resolver; void failure; void tree;
     // @ts-expect-error Unknown drop failures are not part of the public union.
     const unknownFailure: DndDropFailureReason = 'unknown-grid-error';
     void unknownFailure;
     // @ts-expect-error Grid geometry requires numeric fixed cell dimensions.
     const wrongGeometry: SortableGridProps<Task> = { ...gridProps, geometry: { ...gridProps.geometry, mode: 'fixed', cellWidth: '80', cellHeight: 60 } };
     void wrongGeometry;`,
  );
  writeFileSync(
    path.join(scratch, 'tsconfig.components.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ESNext',
        lib: ['ESNext'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        jsx: 'react-jsx',
        types: [],
        // Peer packages have their own declaration checks; verify the packed
        // consumer surface here without rechecking all third-party declarations.
        skipLibCheck: true,
      },
      files: ['component-consumer.tsx'],
    }),
  );
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--project',
      path.join(scratch, 'tsconfig.components.json'),
    ],
    { cwd: scratch, stdio: 'pipe' },
  );
  console.log(
    `Package verified: ${packed.files.length} files; isolated mixed grid/list/scroll/state APIs, virtualization options and packed provider/list/grid consumer types passed.`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
