# DD-030: Public names lead with `Transactional`

**Context**: the packages named their modules after the library they
integrate first and the feature second: `TypeOrmTransactionalModule`,
`CqrsTransactionalModule`, `CQRS_TRANSACTIONAL_OPTIONS`. The outbox
bridge, added at 3.0.0, is already `TransactionalOutboxModule`. And
NestJS's own reliability modules name an integration after the package
that provides it: `@nestjs/workflows` ships `WorkflowsCqrsModule`, the
workflows module for cqrs. Next to it, `CqrsTransactionalModule` reads
as the cqrs module of some transactional package.

**Decision**: every public name leads with `Transactional`, the package
family, and follows with the library it integrates:

| 2.x | 3.0 |
| --- | --- |
| `TypeOrmTransactionalModule` | `TransactionalTypeOrmModule` |
| `TypeOrmTransactionalOptions` | `TransactionalTypeOrmOptions` |
| `TypeOrmTransactionalAsyncOptions` | `TransactionalTypeOrmAsyncOptions` |
| `CqrsTransactionalModule` | `TransactionalCqrsModule` |
| `CqrsTransactionalOptions` | `TransactionalCqrsOptions` |
| `CqrsTransactionalAsyncOptions` | `TransactionalCqrsAsyncOptions` |
| `CqrsTransactionalAsyncFactoryResult` | `TransactionalCqrsAsyncFactoryResult` |
| `CqrsTransactionalBootstrap` | `TransactionalCqrsBootstrap` |
| `CQRS_TRANSACTIONAL_OPTIONS` | `TRANSACTIONAL_CQRS_OPTIONS` |

The 2.x names stay as aliases marked `@deprecated`, from each package's
`src/deprecated.ts`: the same class or value, and a type alias, so
`TypeOrmTransactionalModule.forRoot()` and an `instanceof` check keep
working. They go in the next major. The source files follow the names:
`transactional-typeorm.module.ts`, `transactional-cqrs.module.ts`.

`CQRS_TRANSACTIONAL_OPTIONS`'s string value changes with its name. Code
that injects the options through either constant is unaffected; code
that injected the string literal `'CQRS_TRANSACTIONAL_OPTIONS'` is not.

**Rationale**: one family prefix makes the packages' modules sort and
autocomplete together, matches `TransactionalModule` and
`TransactionalOutboxModule`, and reads the way NestJS names its own
integrations. The aliases make the rename free for an upgrading
application, so it costs nothing to do it now, in the major that
already moves the API.

**Verified by** `packages/cqrs/src/deprecated.spec.ts` and
`packages/typeorm/test/unit/deprecated.spec.ts`, and by the committed
api-extractor reports, which list every alias as `@deprecated`.
