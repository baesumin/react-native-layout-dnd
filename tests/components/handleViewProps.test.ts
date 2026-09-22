import { pickHandleViewProps } from '../../src/components/handleViewProps';

it('forwards only defined accessibility and test attributes', () => {
  const onAccessibilityAction = jest.fn();
  const forwarded = pickHandleViewProps({
    accessible: true,
    accessibilityLabel: 'Move task',
    accessibilityRole: 'button',
    accessibilityActions: [{ name: 'activate' }],
    onAccessibilityAction,
    testID: 'handle',
    accessibilityHint: undefined,
    ...({ itemId: 'a', disabled: true, children: null } as object),
  });

  expect(forwarded).toEqual({
    accessible: true,
    accessibilityLabel: 'Move task',
    accessibilityRole: 'button',
    accessibilityActions: [{ name: 'activate' }],
    onAccessibilityAction,
    testID: 'handle',
  });
  expect(Object.keys(forwarded)).not.toContain('accessibilityHint');
  expect(pickHandleViewProps({})).toEqual({});
});
