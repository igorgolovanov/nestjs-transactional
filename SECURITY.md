# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not through a public
issue. Use GitHub's private vulnerability reporting on this
repository: **Security → Advisories → Report a vulnerability**. That
opens a channel visible only to the maintainers.

Please do not open a public issue, a pull request, or a discussion for
a suspected vulnerability before it has been addressed.

What helps most in a report:

- the affected package and version (all six packages ship as one
  version cohort, so naming one is usually enough);
- what an attacker gains — the data they can read, write, or bypass;
- a minimal reproduction, ideally a failing test rather than prose;
- whether it reproduces on the default single-dataSource setup or only
  in a specific configuration (multi-dataSource, a particular
  propagation mode, the outbox worker, an externalizer).

Expect an acknowledgement within a few days. This is a
volunteer-maintained project, not a vendor with an on-call rota — the
honest expectation is best effort, and you will be told if a report
needs longer than that.

## Supported versions

| Version                   | Supported            |
| ------------------------- | -------------------- |
| `1.0.0-alpha.x`           | ✅ latest alpha only |
| earlier `0.x` prereleases | ❌                   |

While the packages are pre-`1.0.0`, fixes land on the newest alpha and
there are no backports — upgrading to the latest alpha is the
supported path. Once `1.0.0` ships, security fixes will go to the
latest minor of the current major.

## Scope

In scope: anything in the six published packages under
`@nestjs-transactional/*`.

Out of scope, though still worth telling us about as ordinary issues:

- vulnerabilities in TypeORM, NestJS, or a database driver — report
  those to the project that owns the code;
- the documented limitations in
  [`docs/known-limitations.md`](docs/known-limitations.md) and the
  reliability gap recorded in
  [ADR-016](docs/adr/016-externalization-reliability-semantics.md).
  These are known and deliberate, with rationale; a report that they
  exist will be closed with a pointer. A report that one of them is
  _worse than documented_ is very much in scope;
- anything requiring the attacker to already control your application
  code or your database.

## What this library does with your data

Two behaviours are worth knowing about when you assess risk:

- **The outbox persists serialized event payloads** in
  `event_publication.serialized_event` (and in
  `event_publication_archive` under `ARCHIVE` completion mode) until
  the row is purged. Anything you put in an event lands in your own
  database, in plain text, for as long as you retain it. Retention is
  yours to configure.
- **Failure reasons are stored** in `event_publication.failure_reason`,
  which means an exception message from a listener is persisted. Avoid
  putting secrets in exception messages you expect to cross that
  boundary.

Neither is a vulnerability in itself. They are stated here so the
data-at-rest footprint is not a surprise.

There is no telemetry: nothing is reported to us or to any third party.
The only outbound traffic the packages generate is to endpoints you
configure yourself — your database through TypeORM, and, if you use
`outbox-microservices`, your own broker through the `ClientProxy` you
provide.
