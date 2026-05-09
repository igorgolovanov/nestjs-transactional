# ADR-008: Event serialization strategy

## Status

Accepted — 2026-04-24.

## Context

The outbox ([ADR-006](006-outbox-pattern.md)) writes a row to
`event_publication` for every event published inside a transaction.
The row carries the event payload as a string and the event type
name; a worker reads the row back, deserializes the payload, and
invokes the matching handler. Serialization must:

1. **Survive a round-trip across processes.** The publishing
   process and the worker process can be different JVMs of the
   library — say, an HTTP server and a dedicated worker pod —
   reading from the same `event_publication` table.
2. **Restore enough type information** that handlers see the
   event as the original class. Listeners use TypeScript
   `instanceof` checks indirectly (the
   `OutboxListenerRegistry` matches by class name + event type
   name); the deserialized object must work with the application's
   typed code path.
3. **Support arbitrary user-defined event classes** without
   forcing each event to derive from a framework base class or
   implement a marker interface.
4. **Survive small schema drift** (an old worker reading a new
   payload, or vice versa) without producing silent corruption.
5. **Be replaceable** for users with stricter requirements —
   binary payloads (msgpack, protobuf), encryption, schema
   evolution, classless events, etc.

The space of possible designs ranges from "JSON.stringify + class
re-hydration" to "pluggable codec SPI with msgpack as default" to
"protobuf with code generation."

## Decision

Ship JSON serialization as the default, exposed through a
**pluggable `EventSerializer` SPI** so users can replace it.

### The SPI

```typescript
export interface EventSerializer {
  serialize(event: unknown): string;
  deserialize(serialized: string, eventType: string): unknown;
}

export const EVENT_SERIALIZER = Symbol('EVENT_SERIALIZER');
```

Two methods, both string-typed (the publication row stores a
`text` column). `eventType` is the class name registered via
`OutboxModule.forFeature([...])` so the deserializer can look up
the class prototype.

Implementations promise:
- `serialize` throws `SerializationError` on encoding failure
  (circular refs, unsupported values).
- `deserialize` throws `DeserializationError` on decoding failure
  (malformed payload, schema drift, missing type).
- Both are deterministic — same input yields same output.

### The default implementation: `JsonEventSerializer`

`@Injectable()` class registered under `EVENT_SERIALIZER` by
`OutboxModule.forRoot()` unless the user provides an override.

- **Serialize**: `JSON.stringify(event)`. Refuses non-object
  inputs.
- **Deserialize**: `JSON.parse(serialized)` plus a prototype
  swap — `Object.assign(Object.create(EventClass.prototype),
  data)` — so the deserialized object has the same prototype as
  the original class. Methods on the prototype work; `instanceof
  EventClass` returns `true`.

The prototype-swap trick deliberately does NOT call the event
class constructor. Constructors with side effects (validation,
logging, time-stamping) would fire on every replay and produce
incorrect behaviour. Users with constructor invariants must
either supply a custom `EventSerializer` or move the invariants
to a factory function called only at original publication time.

### Class name as the event type

The class name (`event.constructor.name`) is the canonical event
type identifier. `OutboxModule.forFeature([OrderPlacedEvent])`
registers `'OrderPlacedEvent'` in `EventTypeRegistry`, which
acts as the lookup key for deserialization. Renaming an event
class invalidates pending publication rows — see
[ADR-009](009-listener-id-stability.md) for the related listener
id stability story.

### Replacement path

Users with stricter requirements override the SPI binding:

```ts
OutboxModule.forRoot({
  // ...
  serializer: { useClass: ProtobufEventSerializer },
});
```

The framework imposes no further structure on alternative
implementations.

## Alternatives Considered

### msgpack as default

Binary, more compact than JSON, faster to encode/decode for large
payloads.

Rejected as default because:
- Adds a runtime dependency on the framework.
- Postgres `text` columns are easy to inspect (`SELECT * FROM
  event_publication`); binary blobs require tooling to read and
  obscure operator debugging.
- Most events are small (KB range) — JSON's size penalty doesn't
  matter at the scale events are produced.
- Users who do need msgpack can plug it in via the SPI.

### protobuf with code generation

Strict schema, forward/backward compatibility built in.

Rejected as default because:
- Requires a build pipeline (`.proto` files, code generation).
  Friction high enough to lose the "drop in and use" property.
- Most NestJS apps don't already have a protobuf workflow.
- The framework would have to ship tooling or document users'
  own setup; both are scope expansion.
- Users who want protobuf provide their own
  `EventSerializer` implementation.

### Embed the event class in the payload

Serialize the constructor's source or a fully-qualified type
name plus enough metadata to reconstruct the class at deserialize
time.

Rejected because:
- Couples the publication-row schema to the source code's class
  layout. A class rename invalidates rows.
- Worker-side reconstruction of a class from source is brittle
  (require paths, esbuild bundles, etc.).
- The `EventTypeRegistry` + class-name approach achieves the same
  intent with less coupling.

### Force events to extend a base class with `toJSON()` /
`fromJSON()`

Make the framework dictate event shape. Users would extend
`abstract class BaseEvent { abstract toJSON(): unknown; static
fromJSON(json: unknown): BaseEvent; }`.

Rejected because:
- Hostile to plain DTO-style event classes — most NestJS event
  classes today are `class FooEvent { constructor(public readonly
  field: string) {} }` and don't carry serialization logic.
- Adds inheritance constraints we don't want to enforce.
- The opt-in path (override the SPI) is strictly better than
  the opt-out path (extend a base class).

### No serialization layer at all (rely on `JSON.stringify`
inline)

Just call `JSON.stringify` directly inside
`EventPublicationRegistry.publish` and `JSON.parse` in the
worker.

Rejected because:
- Hard-codes JSON semantics with no replacement path. Users with
  encryption requirements, schema evolution, or non-JSON payload
  needs are stuck.
- Mixes concerns: the registry should track lifecycle states,
  not encode payloads.
- Errors lose context (no `SerializationError` wrapping; raw
  `SyntaxError` from `JSON.parse` is hard to trace).

## Consequences

### Positive

- **Drop-in for the common case.** Most apps' events are plain
  data classes; `JsonEventSerializer` works without
  configuration.
- **Replaceable for the uncommon case.** Users with binary
  payload, encryption, or strict schema evolution requirements
  swap the SPI binding. No fork, no patch.
- **Postgres-friendly.** `text` columns are inspectable from
  `psql`; operators can read recent publications without tooling.
- **Errors are typed.** `SerializationError` and
  `DeserializationError` extend `OutboxError`; logging and
  recovery code matches the framework's error conventions.

### Negative

- **No schema evolution out of the box.** Adding a field to an
  event class works (deserialized objects just have the new
  field undefined for old rows); removing a field breaks
  consumers that read it. JSON gives no schema enforcement.
  Users with strict evolution needs roll their own.
- **The prototype-swap trick is non-obvious.**
  `Object.assign(Object.create(EventClass.prototype), data)`
  reads as a hack to anyone who hasn't seen it before. We
  document it in JSDoc and in the package README, but the
  surprise factor remains.
- **Constructor side effects don't run on deserialize.** Events
  with `constructor` validation logic that mutates internal
  state lose that on replay. Documented as a known constraint.
- **Class renames break stored rows.** Renaming
  `OrderPlacedEvent` to `OrderCreatedEvent` makes existing
  `event_publication` rows for the old name unresolvable. Users
  must migrate the stored rows or accept the loss. Same family
  of constraint as listener id stability —
  [ADR-009](009-listener-id-stability.md).

### Mitigations

- The replacement SPI is the documented escape hatch for every
  negative above. Encrypted payloads, msgpack, protobuf, schema
  registry integration — all are user-side concerns the SPI
  composes with.
- The README of `@nestjs-transactional/outbox` lists the
  prototype-swap caveat in a "Known Limitations" section.
- The `EventTypeRegistry` is per-DataSource (DD-018 / ADR-018):
  duplicate class names across DataSources don't conflict, but
  a single class registered under two DataSources is a
  bootstrap-time error.

## Notes

- `JsonEventSerializer` lives at
  `packages/outbox/src/serialization/json-event-serializer.ts`;
  the SPI is at
  `packages/outbox/src/serialization/event-serializer.ts`.
- The Spring Modulith equivalent is also called
  `EventSerializer` and uses the same SPI shape (with Jackson as
  the default, not JSON.stringify). The cross-ecosystem mapping
  is intentional.
- A future iteration may ship a typed-key `EventSerializer<T>`
  generic that lets users plug per-event-class encoders without
  losing the SPI's uniformity. Not scheduled.
