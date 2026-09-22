import { useState, useSyncExternalStore } from 'react';

type StateStore<Value, OnChange, SetValue, Respond> = {
  getSnapshot(): Value;
  subscribe(listener: () => void): () => void;
  onChange: OnChange;
  setValue: SetValue;
  respond: Respond;
};

/** Own one approval store for the component's lifetime and subscribe to it. */
export function useStoreState<Value, OnChange, SetValue, Respond>(
  create: () => StateStore<Value, OnChange, SetValue, Respond>,
): { value: Value; onChange: OnChange; setValue: SetValue; respond: Respond } {
  const [store] = useState(create);
  const value = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return {
    value,
    onChange: store.onChange,
    setValue: store.setValue,
    respond: store.respond,
  };
}
