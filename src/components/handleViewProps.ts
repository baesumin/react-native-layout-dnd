import type { ViewProps } from 'react-native';

/** Accessibility and test attributes forwarded to a handle's native view. */
export type HandleViewProps = Pick<
  ViewProps,
  | 'accessible'
  | 'accessibilityLabel'
  | 'accessibilityHint'
  | 'accessibilityRole'
  | 'accessibilityState'
  | 'accessibilityActions'
  | 'onAccessibilityAction'
  | 'importantForAccessibility'
  | 'testID'
>;

const HANDLE_VIEW_PROP_KEYS = [
  'accessible',
  'accessibilityLabel',
  'accessibilityHint',
  'accessibilityRole',
  'accessibilityState',
  'accessibilityActions',
  'onAccessibilityAction',
  'importantForAccessibility',
  'testID',
] as const satisfies ReadonlyArray<keyof HandleViewProps>;

/** Copies only the defined view attributes so handle-specific props never reach the native view. */
export function pickHandleViewProps(props: HandleViewProps): HandleViewProps {
  const forwarded: Record<string, unknown> = {};
  for (const key of HANDLE_VIEW_PROP_KEYS)
    if (props[key] !== undefined) forwarded[key] = props[key];
  return forwarded as HandleViewProps;
}
