export class IntegrationSetupFlowNotFoundError extends Error {}

export class IntegrationSetupRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `integration setup revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`
    );
  }
}

export class IntegrationSetupIllegalTransitionError extends Error {}
export class IntegrationSetupFlowExpiredError extends Error {}
