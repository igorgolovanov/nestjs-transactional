import { type InjectionToken } from '@nestjs/common';

/**
 * Configuration accepted by
 * {@link OutboxMicroservicesModule.forRoot} (and the resolved factory
 * result of `forRootAsync`). Per DD-017 the package does NOT register
 * `ClientProxy` instances itself — register them via the standard
 * `ClientsModule.register()` / `ClientsModule.registerAsync()` from
 * `@nestjs/microservices` and pass the token here.
 */
export interface OutboxMicroservicesOptions {
  /**
   * DI token of the default `ClientProxy` used when an `@Externalized`
   * mapping does not specify its own `client` override. Resolved via
   * `ModuleRef.get(token, { strict: false })` so the proxy can live in
   * any module (including a globally-imported `ClientsModule`).
   *
   * If omitted, every `@Externalized` event must carry a `client` of
   * its own — otherwise the externalizer rejects the publication and
   * the row is recorded as `FAILED` (DD-019).
   */
  readonly defaultClient?: InjectionToken;

  /**
   * When `true` (default), the externalizer's `OnApplicationBootstrap`
   * hook resolves `defaultClient` immediately and fails the bootstrap
   * if the binding is missing — surfacing a misconfiguration before
   * the first event is processed. Set `false` to defer resolution
   * until the first call to `externalize()` (useful when the
   * `ClientProxy` registration is itself wired by an asynchronous
   * factory that has not finished by the time bootstrap runs).
   */
  readonly validateOnBootstrap?: boolean;
}

/**
 * DI token for the resolved {@link OutboxMicroservicesOptions} object.
 * Internal — consumers configure the module via
 * `OutboxMicroservicesModule.forRoot()` rather than injecting the
 * token directly.
 */
export const OUTBOX_MICROSERVICES_OPTIONS = Symbol('OUTBOX_MICROSERVICES_OPTIONS');
