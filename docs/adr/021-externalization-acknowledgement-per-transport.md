# ADR-021: What `ClientProxy.emit()` actually acknowledges, per transport

- **Status**: Accepted
- **Date**: 2026-09-01
- **Supersedes**: [ADR-016](016-externalization-reliability-semantics.md)
  (externalization reliability semantics with `@nestjs/microservices`)
- **Related**:
  - ADR-015 (event externalization architecture)
  - DD-016 (event externalization scope and design)
  - DD-017 (reuse of `ClientsModule` for `ClientProxy` registration)
  - DD-018 (`EventExternalizer` SPI as a structural port)

## Context

ADR-016 recorded, as the contract of record, that
`ClientProxy.emit()` cannot report broker-side failures on any
transport: an unreachable broker still yields a completed Observable,
`MicroservicesEventExternalizer` therefore returns without throwing,
and the processor finalises the publication as `COMPLETED` with
nothing delivered. On that basis it deleted the real-broker
integration suite, dropped the `testcontainers` / `kafkajs` /
`amqplib` dev-dependencies, added a mock test pinning the
silent-success behaviour, and put a "read this before production"
warning at the top of the package README. A future phase of native
broker adapters was scheduled to close the gap.

The premise was never re-checked after that experiment. It has now
been re-measured against live brokers, and read out of the installed
`@nestjs/microservices` source rather than inferred from the
abstraction. Neither exercise reproduces ADR-016's conclusion.

Measured, `@nestjs/microservices` 11.2.3 with `testcontainers`
`rabbitmq:3.13-alpine` and `confluentinc/cp-kafka:7.6.0`:

- RabbitMQ, broker up: `externalize()` resolves, and a second
  connection reads the message off the queue. Delivery is real, not
  assumed.
- RabbitMQ, broker stopped: `externalize()` **rejects** with
  `ExternalizationError`, which is exactly the signal the processor
  needs to mark the publication `FAILED`.
- Kafka, broker up: a `kafkajs` consumer that subscribed before the
  publish receives the message. ADR-016 recorded that it did not.
- Kafka, broker stopped: `externalize()` **rejects**.

Reading `dispatchEvent` in each client explains why, and shows that
the answer was never uniform across transports the way ADR-016
assumed:

| Transport | `dispatchEvent` resolves when | Acknowledged by the broker? |
| --- | --- | --- |
| Kafka | `producer.send()` settles; `kafkajs` defaults to `acks = -1`, every in-sync replica | Yes |
| RabbitMQ | the publish callback fires; `amqp-connection-manager` defaults `confirm` to `true`, so this is a publisher confirm | Yes, but see `persistent` below |
| MQTT | the publish callback fires: PUBACK at QoS 1 and above, immediately at QoS 0 | Depends on QoS |
| Redis | the `PUBLISH` command replies | Server received it; Redis pub/sub does not persist, so only live subscribers get it |
| TCP | the message is written to the socket | No |
| NATS | never: `publish()` returns `void` and the client calls `resolve()` unconditionally on the next line | No |
| gRPC | never: `dispatchEvent` throws `Method is not supported in gRPC mode` | Externalization over gRPC has never worked |

Two of these rows contradict our own user-facing documentation:

- The package README and the root README list gRPC among the
  transports this externalizer covers. `ClientGrpcProxy.dispatchEvent`
  throws unconditionally, so an `@Externalized` event routed to a gRPC
  client has never been publishable.
- ADR-016's first mitigation strategy told RabbitMQ users to add a
  confirm channel via `amqp-connection-manager`. NestJS builds its
  channel through `amqp-connection-manager` already, and confirms are
  on by default. The advice that was actually needed is different and
  was never given: `RQM_DEFAULT_PERSISTENT` is `false`, so messages
  are published non-persistent unless the user sets
  `persistent: true`. RabbitMQ confirms a non-persistent message
  without writing it to disk, and a broker restart loses it.

Separately, the failure reason recorded on a `FAILED` publication was
useless for RabbitMQ: the client rejects with values that are not
`Error` instances, and `String(err)` rendered them as
`[object Object]`. That is our defect, not the transport's, and it is
the field an operator reads when deciding whether to resubmit.

## Decision

1. **ADR-016 is superseded.** Its conclusion does not hold for Kafka
   or RabbitMQ, and it was never true as a statement about "every
   transport". Its status is changed to Superseded with a pointer
   here. The document is kept, not deleted: the reasoning that led to
   a wrong general claim from one failing experiment is worth being
   able to read.

2. **The real-broker suite comes back**, as
   `packages/outbox-microservices/test/integration/reliability.integration.spec.ts`,
   pinning both halves: a reachable broker delivers and resolves, an
   unreachable one rejects. The `testcontainers` / `kafkajs` /
   `amqplib` dev-dependencies and the `test:integration` script that
   ADR-016 removed are restored. If a future version regresses to
   silent success, this fails in CI rather than being discovered by a
   user whose publication was marked `COMPLETED` with nothing sent.

3. **It runs in its own CI job**, `broker-integration`, single-cell,
   and `outbox-microservices` is excluded from the TypeORM-matrixed
   integration job. Both brokers together take about 40 seconds; the
   TypeORM version is irrelevant to what the job measures.

4. **`describeThrown` is added to `@nestjs-transactional/outbox` and
   exported.** It renders an unknown thrown value as something an
   operator can read, and the externalizer uses it at all three sites
   that previously fell back to `String(err)`. It is exported rather
   than kept internal because the `EVENT_EXTERNALIZER` SPI is public
   (DD-018) and every implementation of it meets the same problem.

5. **The documentation states the per-transport table** instead of a
   single blanket warning, and says plainly which transports do not
   acknowledge. The blanket warning was worse than no warning: it was
   wrong in the direction that makes a correct system look broken, and
   it pointed users at a mitigation they already had.

## What is still not guaranteed

Stated explicitly so the correction does not overshoot:

- **NATS core and TCP do not acknowledge.** For NATS this is the
  protocol, not a library gap: core `publish()` is fire-and-forget and
  returns `void`. JetStream's `publish()` returns a `PubAck`, but
  `@nestjs/microservices` does not use it. A NATS user who needs
  delivery guarantees needs an externalizer that is not this one.
- **Configuration can give away what the default provides.** Kafka
  `acks: 0`, MQTT QoS 0, or RabbitMQ without `persistent: true` each
  weaken the guarantee, and the user chooses those on their own
  `ClientsModule.register()`, which DD-017 deliberately leaves alone.
- **A broker can accept a message and lose it before durable
  storage.** `acks: -1` plus replication is the answer to that, it
  cannot be reproduced deterministically from a client, and no client
  library closes it. It is not asserted in the suite, and the suite
  says so.

The residual gap is therefore real but much narrower than ADR-016
described, and it is concentrated in specific transports and specific
configurations rather than being a property of `emit()`.

## Alternatives considered

- **Amend ADR-016 in place.** Rejected: the change is to the
  conclusion, not to a detail. An ADR whose Decision section is
  rewritten to say the opposite is no longer a record of a decision.

- **Delete ADR-016.** Rejected: the failure mode it illustrates,
  generalising from one experiment to every transport and then
  building documentation and roadmap on top of the generalisation,
  is the more useful thing to keep than the conclusion was.

- **Ship the native broker adapters anyway** (`kafkajs`, `amqplib`,
  `nats` externalizers under the DD-018 SPI), as ADR-016 and
  improvement-plan item C5 scheduled. Rejected for Kafka and
  RabbitMQ: the gap those packages were meant to close does not exist
  on those transports, so they would be three new published packages
  buying nothing. A NATS externalizer that uses JetStream is the one
  piece of that plan the evidence still supports, and it is left
  unscheduled rather than assumed.

- **Keep the suite out of CI and run it locally.** Rejected: that is
  how the wrong claim survived. A measurement nobody re-runs decays
  into an assumption.

## Consequences

### Positive

- The published READMEs stop telling users that their messages may be
  silently dropped on transports where they are not.
- An executable test now owns the claim. Any future regression in
  `@nestjs/microservices`, `kafkajs` or `amqplib` surfaces as a CI
  failure with a name that says what broke.
- Two concrete defects surfaced that the blanket warning had hidden:
  gRPC is documented as supported and is not, and RabbitMQ users were
  given the wrong durability advice.
- A `FAILED` publication's `failureReason` is now readable for
  RabbitMQ instead of `[object Object]`.
- A planned phase of three broker-adapter packages is retired on
  evidence rather than shipped on a premise.

### Negative

- CI gains a job that starts two containers. About 40 seconds, and it
  can fail for reasons that are not ours: an image pull, a slow
  controller election. That cost is the price of the claim staying
  true, and the alternative was measured and found worse.
- `describeThrown` is a permanent addition to a public API governed by
  ADR-004. It is a pure function with no dependencies, which is about
  as cheap as a permanent commitment gets, but it is one.
- Documentation across the repository, the examples, and the roadmap
  still refers to the ADR-016 limitation and is corrected in a
  follow-up rather than here, so the two land separately.

## References

- `packages/outbox-microservices/test/integration/reliability.integration.spec.ts`
  — the measurement, executable.
- `packages/outbox/src/externalization/describe-thrown.ts` — the
  diagnostics fix and the reasoning behind its ordering.
- [ADR-016](016-externalization-reliability-semantics.md) — superseded
  by this document.
- [ADR-015](015-event-externalization-architecture.md) — externalization
  architecture; its reliability caveat section derives from ADR-016.
