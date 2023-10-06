export class InvalidEvmSnapshotResult extends Error {
  constructor() {
    super("`evm_snapshot` must return a string.");
  }
}

export class EvmRevertFailed extends Error {
  constructor() {
    super("`evm_revert` must return `true`.");
  }
}
