import { describeThrown } from './describe-thrown';

describe('describeThrown', () => {
  it('uses an Error message', () => {
    expect(describeThrown(new Error('connection refused'))).toBe('connection refused');
  });

  it('returns a thrown string as itself', () => {
    // `@nestjs/microservices` rejects a publish to a stopped RabbitMQ
    // broker with a bare string.
    expect(describeThrown('Unexpected close')).toBe('Unexpected close');
  });

  it('reads a message property off a non-Error object', () => {
    expect(describeThrown({ message: 'channel closed' })).toBe('channel closed');
  });

  it('renders a plain object rather than losing it to [object Object]', () => {
    // The measured RabbitMQ case: a plain object with no `message`.
    // `String()` would give `[object Object]`, which is what made a
    // FAILED publication's reason useless.
    expect(describeThrown({ code: 320, classId: 10 })).toBe('{"code":320,"classId":10}');
  });

  it('survives a circular object', () => {
    const circular: Record<string, unknown> = { code: 320 };
    circular.self = circular;

    expect(() => describeThrown(circular)).not.toThrow();
    expect(describeThrown(circular)).toBe('[object Object]');
  });

  it('survives a throwing toJSON', () => {
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };

    expect(describeThrown(hostile)).toBe('[object Object]');
  });

  it('handles the empty cases without pretending they say something', () => {
    expect(describeThrown(undefined)).toBe('undefined');
    expect(describeThrown(null)).toBe('null');
  });
});
