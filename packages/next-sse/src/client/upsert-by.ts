"use client";

/**
 * The keyed-merge reducer: replace the item that has the same key, or append it.
 *
 * One reducer covers every duplicate the library can hand a page (ADR-0007), which is why the
 * hooks have no dedup option of their own. The Snapshot and the replay overlap; a Kick replays
 * what a client already had; a server action's result arrives once through `apply` and again as
 * the Message it published. All three are the same item twice, and this makes them one.
 *
 * The key is a property name — `upsertBy('id')` — or a function, for an item keyed by something
 * that is not one property.
 */
export function upsertBy<Key extends PropertyKey>(
  key: Key,
): <Item extends Record<Key, unknown>>(state: Item[], item: Item) => Item[];
export function upsertBy<Item>(key: (item: Item) => unknown): (state: Item[], item: Item) => Item[];
export function upsertBy<Item>(
  key: PropertyKey | ((item: Item) => unknown),
): (state: Item[], item: Item) => Item[] {
  const keyOf = (item: Item): unknown =>
    typeof key === "function" ? key(item) : (item as Record<PropertyKey, unknown>)[key];

  return (state, item) => {
    const at = state.findIndex((existing) => keyOf(existing) === keyOf(item));

    return at === -1
      ? [...state, item]
      : state.map((existing, index) => (index === at ? item : existing));
  };
}
