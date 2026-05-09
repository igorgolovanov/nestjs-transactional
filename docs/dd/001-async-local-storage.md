# DD-001: AsyncLocalStorage as the foundation

**Alternatives**:
- continuation-local-storage (cls-hooked) — legacy, deprecated
- Passing context explicitly through parameters — breaks the API surface

**Choice**: AsyncLocalStorage from Node.js core. Stable since Node 14,
performant, correct across async boundaries.

**Trade-off**: there is a small performance overhead (<5% on typical
operations), but it is real. For critical hot paths, the programmatic API
`manager.run()` can be used in place of the decorator.

> See also: [ADR-001](../adr/001-async-local-storage.md) for the
> ADR-form record of this decision.
