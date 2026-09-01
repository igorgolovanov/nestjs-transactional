---
'@nestjs-transactional/outbox': minor
'@nestjs-transactional/outbox-microservices': patch
---

Correct what externalization actually guarantees, per transport

ADR-016 recorded that `ClientProxy.emit()` cannot report broker
failures on any transport, and on that basis the real-broker test
suite was deleted and a "your messages may be silently dropped"
warning was placed at the top of the `outbox-microservices` README.
Re-measured against live Kafka and RabbitMQ, and read out of the
`@nestjs/microservices` source, that claim does not hold: an
unreachable broker rejects and marks the publication `FAILED`, a
reachable one delivers, and `emit()` resolves on a real
acknowledgement. Kafka settles `producer.send()` with `kafkajs`'
default `acks: -1`; RabbitMQ waits for a publisher confirm, which
`amqp-connection-manager` enables by default.

The guarantee is transport-specific rather than absent, so the
documentation now carries a per-transport table instead of a blanket
warning. Two things that table surfaced, both worth acting on:

- gRPC was listed as a supported externalization transport and has
  never worked: `ClientGrpcProxy.dispatchEvent` throws
  unconditionally.
- RabbitMQ publishes non-persistent by default, so a confirmed
  message is still lost across a broker restart. Set
  `persistent: true` in your `ClientsModule.register()` options. The
  advice that was there before, to add a confirm channel, described
  something that was already on.

NATS core and TCP genuinely do not acknowledge, and that is now
stated plainly rather than being folded into a claim about every
transport.

`@nestjs-transactional/outbox` gains one public export,
`describeThrown`, which renders an unknown thrown value as something
an operator can read. Broker clients reject with values that are not
`Error` instances, and the previous `String(err)` fallback rendered
RabbitMQ's rejections as `[object Object]` in the `failureReason`
field of a `FAILED` publication, which is exactly the field read when
deciding whether to resubmit. The externalizer now uses it at all
three sites. Third-party implementations of the public
`EVENT_EXTERNALIZER` SPI hit the same problem, which is why it is
exported rather than kept internal.

The suite ADR-016 removed is restored as
`reliability.integration.spec.ts` and runs in CI against
testcontainers Kafka and RabbitMQ, so a future regression to silent
success fails a build instead of reaching a user.

Full measurements and reasoning: ADR-021, superseding ADR-016.
