# DD-017: Reuse `ClientsModule` for `ClientProxy` registration

**Context**: Most consumers of `outbox-microservices` already register
`ClientProxy` instances via `ClientsModule.register()` /
`registerAsync()` for other reasons (consuming inbound messages,
emitting events outside the outbox, RPC). Re-registering the same proxy
through our module would duplicate connection pools and create two
competing patterns for the same concept.

**Alternatives considered**:
- Provide a parallel registration API inside
  `OutboxMicroservicesModule.forRoot()`. Rejected: duplication, two
  mental models for the same concept, two connection pools.
- Hybrid (support both registering through our module and reusing
  existing). Rejected: ambiguity about which path takes precedence and
  more configuration surface.
- Auto-detection (pick the only `ClientProxy` from the DI context if
  exactly one is bound). Rejected for the first version: explicit better
  than implicit; auto-detection breaks once a second client appears.

**Decision**: `OutboxMicroservicesModule.forRoot({ defaultClient: TOKEN })`
accepts the DI token of an existing `ClientProxy` registered by the user
via standard `@nestjs/microservices` `ClientsModule`. The package does
not register any clients itself.

**Consequences**:
- Less boilerplate for users with an existing `ClientsModule` setup.
- Standard testing patterns continue to work (`overrideProvider`,
  `registerAsync` with `ConfigService`).
- Documentation must explicitly list `ClientsModule` registration as a
  prerequisite.
- Multiple clients (one per broker) supported through `ClientsModule`'s
  own multi-registration pattern; per-event client selection is a
  follow-up iteration.
