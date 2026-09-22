import type { GestureRelations } from '../components/gridTypes';
import type { ValidationIssue } from '../types';

type GestureRelationResult =
  | { valid: true; relations: GestureRelations | undefined }
  | { valid: false; issues: ValidationIssue[] };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tags(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(tag => Number.isSafeInteger(tag) && tag > 0)
  );
}

/** Published RNGH v3 gesture surface, without probing detector internals. */
function gestureTags(gesture: unknown): number[] | null {
  if (
    !record(gesture) ||
    typeof gesture.type !== 'string' ||
    !gesture.type ||
    !record(gesture.config) ||
    !record(gesture.detectorCallbacks)
  )
    return null;
  if ('handlerTags' in gesture) {
    return tags(gesture.handlerTags) &&
      tags(gesture.externalSimultaneousHandlers) &&
      Array.isArray(gesture.gestures)
      ? gesture.handlerTags
      : null;
  }
  const relations = gesture.gestureRelations;
  if (
    !Number.isSafeInteger(gesture.handlerTag) ||
    (gesture.handlerTag as number) <= 0 ||
    !record(relations) ||
    !tags(relations.simultaneousHandlers) ||
    !tags(relations.waitFor) ||
    !tags(relations.blocksHandlers)
  )
    return null;
  return [gesture.handlerTag as number];
}

/** Element-wise equality of the three relation lists; a single gesture equals a one-element list. */
export function sameGestureRelations(
  first: GestureRelations | undefined,
  second: GestureRelations | undefined,
): boolean {
  return (['block', 'requireToFail', 'simultaneousWith'] as const).every(
    key => {
      const a = first?.[key];
      const b = second?.[key];
      const aa = a === undefined ? [] : Array.isArray(a) ? a : [a];
      const bb = b === undefined ? [] : Array.isArray(b) ? b : [b];
      return (
        aa.length === bb.length &&
        aa.every((gesture, index) => gesture === bb[index])
      );
    },
  );
}

/** Attachment to an actual detector still requires device validation by the caller. */
export function validateGestureRelations(
  value: unknown,
): GestureRelationResult {
  if (value === undefined) return { valid: true, relations: undefined };
  const fail = (message: string): GestureRelationResult => ({
    valid: false,
    issues: [{ code: 'invalid-configuration', message }],
  });
  const keys = ['block', 'requireToFail', 'simultaneousWith'] as const;
  if (
    !record(value) ||
    Object.keys(value).some(key => !keys.some(known => known === key))
  ) {
    return fail(
      'gestureRelations must contain only block, requireToFail and simultaneousWith.',
    );
  }
  const normalized: GestureRelations = {};
  const objectOwners = new Map<object, string>();
  const tagOwners = new Map<number, string>();
  for (const key of keys) {
    const relation = value[key];
    if (relation === undefined) continue;
    const gestures: unknown[] = Array.isArray(relation) ? relation : [relation];
    const unique = new Set<object>();
    for (const gesture of gestures) {
      const handlerTags = gestureTags(gesture);
      if (!handlerTags || !record(gesture)) {
        return fail(
          `${key} requires v3 gesture objects, not refs or incomplete objects.`,
        );
      }
      const prior = objectOwners.get(gesture);
      if (prior && prior !== key)
        return fail(`The same gesture cannot be in both ${prior} and ${key}.`);
      objectOwners.set(gesture, key);
      for (const tag of handlerTags) {
        const owner = tagOwners.get(tag);
        if (owner && owner !== key)
          return fail(
            `The same native handler cannot be in both ${owner} and ${key}.`,
          );
        tagOwners.set(tag, key);
      }
      unique.add(gesture);
    }
    // Preserve actual gesture object identities; v3 connects relations through
    // these objects and mutates their symmetric relation lists itself.
    normalized[key] = [...unique] as Exclude<
      GestureRelations[typeof key],
      undefined
    >;
  }
  return { valid: true, relations: normalized };
}
