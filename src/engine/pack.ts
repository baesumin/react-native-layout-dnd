import type { PackInput, PackResult } from '../types';

import { createPlacementSearch } from './search';
import { validatePackInput } from './validation';

export function packItems<T>(input: PackInput<T>): PackResult<T> {
  const validation = validatePackInput(input);
  if (!validation.valid) {
    return { status: 'invalid', issues: validation.issues };
  }
  const result = createPlacementSearch({
    items: input.items,
    rows: input.rows,
    columns: input.columns,
    searchBudget: input.searchBudget,
  }).advance(input.searchBudget);
  if (result.status === 'ok') {
    return { status: 'ok', placements: result.placements };
  }
  // A chunk containing the entire global budget always resolves its status.
  return {
    status: result.status === 'impossible' ? 'impossible' : 'unresolved',
  };
}
