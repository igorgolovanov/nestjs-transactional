# DD-004: Adapter as interface, not base class

**Alternatives**:
- An abstract `TransactionAdapter` base class with shared logic
- An interface with implementation rules documented

**Choice**: pure interface. All shared logic lives in TransactionManager;
adapters are minimal ORM-specific implementations.

**Trade-off**: adapters must implement two methods (`runInTransaction`,
`runInSavepoint`). That's the minimum, and it's easy to add new adapters.
