# ADR-005: Method Wrapping Strategy for @Transactional

## Status
Accepted — 2026-04-23

## Context

`@Transactional()` декоратор должен оборачивать методы в transaction context.
В NestJS есть несколько возможных механизмов перехвата вызовов:

1. **NestJS Interceptors** (через APP_INTERCEPTOR) — работают только на request
   boundary: controllers, resolvers, gateways, message patterns.

2. **Prototype method wrapping в декораторе** — декоратор напрямую заменяет
   `descriptor.value` на обёртку. Проблема: нет доступа к DI-контейнеру для
   получения TransactionManager.

3. **Runtime wrapping через DiscoveryService** — сервис сканирует провайдеры
   при `OnApplicationBootstrap` и оборачивает методы на уровне instance.

Ни один механизм не покрывает все cases сам по себе. Сервисы `@Injectable`
не ловятся interceptor'ами. Декораторы не могут resolve'ить DI. Runtime
wrapping не работает для controllers (у них уже есть NestJS pipeline).

## Decision

Декоратор `@Transactional` — **metadata only**. Он не модифицирует метод,
только пишет metadata через `Reflect.defineMetadata(TRANSACTIONAL_METADATA, ...)`.

Реальное обёртывание выполняют **три координированных механизма**, каждый
для своего контекста:

### 1. TransactionalInterceptor (via APP_INTERCEPTOR)
Для **request boundary**: controllers, resolvers, gateways, message
patterns. Читает metadata с handler через Reflector и оборачивает вызов в
`manager.run()`. Регистрируется автоматически в `TransactionalModule.forRoot()`
(opt-out через `registerInterceptor: false`).

### 2. TransactionalMethodsBootstrap (via OnApplicationBootstrap)
Для **обычных `@Injectable` сервисов**. На `OnApplicationBootstrap`:
- Сканирует все провайдеры через `DiscoveryService` + `MetadataScanner`
- Для каждого метода с `@Transactional` metadata — оборачивает
  `instance[methodName]` через замыкание, вызывающее `manager.run()`
- Skip'ает classes с NestJS controller/resolver/gateway metadata (их
  обрабатывает Interceptor)
- Skip'ает CQRS handler classes (их обрабатывает CqrsHandlerWrapper)
- Opt-out через `useMethodBootstrap: false` в module options

### 3. CqrsHandlerWrapper (via OnApplicationBootstrap, в @nestjs-transactional/cqrs)
Специализация для `@CommandHandler`, `@QueryHandler`, `@EventsHandler`.
Логически аналогичен `TransactionalMethodsBootstrap`, но работает
специфично с `execute()` методом handler'ов и интегрируется с
`TransactionalEventPublisher` для AggregateRoot events.

## Coordination between mechanisms

Двойное обёртывание предотвращается через **wrapping marker**:

```typescript
const WRAPPED_MARKER = Symbol.for('@nestjs-transactional/wrapped');

// Перед wrapping
if (Reflect.getMetadata(WRAPPED_MARKER, instance[methodName]) === true) {
  return;  // уже обёрнут
}

// После wrapping
Reflect.defineMetadata(WRAPPED_MARKER, true, wrapped);
instance[methodName] = wrapped;
```

Причины выбора `Reflect.defineMetadata` вместо instance-level `WeakSet`:

- **Stateless**: marker живёт на самом методе, не на внешнем трекере
- **Test-safe**: при пересоздании TestingModule метадата перезаписывается
  свежими методами
- **No cross-instance leakage**: каждый созданный класс/метод получает
  свой marker независимо от истории других инстансов
- **`Symbol.for`** даёт shared symbol на случай edge case с двумя
  версиями пакета в одном дереве зависимостей

Fallback: если по каким-то причинам метод всё же обёрнут дважды
(в обход маркера), propagation mode REQUIRED гарантирует корректное
поведение — существующая транзакция переиспользуется, новая не создаётся.

## Alternatives Considered

### Только Interceptor
Не покрывает service-to-service calls. Отвергнуто.

### Prototype wrapping в декораторе
Требует либо глобальный singleton TransactionManager (анти-паттерн, ломает
DI), либо lazy resolution через `Inject.get()` (сложность, race conditions
при concurrent initialization). Отвергнуто.

### Один универсальный bootstrap без interceptor
Не работает для controllers — NestJS создаёт ExecutionContext для
request pipeline, и interceptor-based подход более natural для request
handling (лучше интегрируется с exception filters, guards, pipes).
Отвергнуто в пользу комбинированного подхода.

### WeakSet-based wrapping tracking
Хранение обёрнутых методов в `WeakSet<Function>` внутри
`TransactionalMethodsBootstrap`. Проблемы: state живёт на инстансе
сервиса, которого при частых `Test.createTestingModule()` может
создаваться много; логика проверки "wrapped?" усложняется необходимостью
трекать и original, и wrapper. Отвергнуто в пользу Reflect metadata marker.

## Consequences

### Positive
- Unified API для пользователя: `@Transactional()` "просто работает" везде
- Clean separation of concerns: каждый механизм делает одну вещь
- Testability: каждый wrapper можно отключить через module options для
  unit-testing в изоляции
- Test-safe: marker-based tracking stateless

### Negative
- Больше infrastructure кода (3 компонента вместо 1)
- Отладка "почему не обёрнуто?" требует знания всех трёх механизмов
- Runtime wrapping через DiscoveryService делает debugging чуть менее
  straightforward (методы на instance отличаются от prototype)

### Mitigations
- Каждый механизм — в отдельном файле с понятным именем
- Logging на debug level при wrapping: "Wrapped method X.Y with
  metadata {propagation: 'REQUIRED'}"
- ADR документирует решение, будущие вопросы разрулить отсылкой сюда
