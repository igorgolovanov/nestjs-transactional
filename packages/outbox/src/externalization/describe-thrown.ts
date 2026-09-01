/**
 * Render an unknown thrown value as something an operator can read.
 *
 * `String(err)` is the obvious thing to reach for and it is wrong here.
 * Broker clients reject with values that are not `Error` instances, and
 * `String()` turns those into `[object Object]`. Measured against the
 * current libraries: `@nestjs/microservices` rejects a RabbitMQ publish
 * with a plain object carrying no `message`, and rejects a publish to a
 * stopped broker with a bare string. Both end up as the failure reason
 * recorded on a `FAILED` publication, which is precisely the field an
 * operator reads when deciding whether to resubmit.
 *
 * The order below is "most specific thing that carries meaning first":
 * an `Error`'s message, a string as itself, any object exposing a
 * string `message`, then a JSON rendering, and only then the
 * `[object Object]` of last resort for something with a throwing or
 * circular shape.
 */
export function describeThrown(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
    try {
      const json = JSON.stringify(err);
      // `JSON.stringify` returns `undefined` for a value it cannot
      // represent, and `{}` for an object whose own properties are all
      // non-enumerable, neither of which tells anyone anything.
      if (json !== undefined && json !== '{}') {
        return json;
      }
    } catch {
      // Circular, or a throwing `toJSON`. Fall through.
    }
  }
  return String(err);
}
