import type { NativeToolModule } from "./types.ts";
import {
  REQUEST_CREDENTIAL_NAME,
  requestCredentialToolDef,
  handleRequestCredential,
} from "./credential/request.ts";
import {
  REQUEST_OAUTH_SETUP_NAME,
  requestOAuthSetupToolDef,
  handleRequestOAuthSetup,
} from "./credential/oauth-setup.ts";
import {
  UPDATE_CREDENTIAL_NAME,
  updateCredentialToolDef,
  handleUpdateCredential,
  LIST_CREDENTIALS_NAME,
  listCredentialsToolDef,
  handleListCredentials,
  USE_CREDENTIAL_NAME,
  useCredentialToolDef,
  handleUseCredential,
  DELETE_CREDENTIAL_NAME,
  deleteCredentialToolDef,
  handleDeleteCredential,
  TEST_CREDENTIAL_NAME,
  testCredentialToolDef,
  handleTestCredential,
} from "./credential/crud.ts";

export { resolveCredentialRequest } from "./credential/request.ts";
export { resolveOAuthWizard } from "./credential/oauth-setup.ts";

export const credentialModule: NativeToolModule = {
  defs: {
    [REQUEST_CREDENTIAL_NAME]: requestCredentialToolDef,
    [REQUEST_OAUTH_SETUP_NAME]: requestOAuthSetupToolDef,
    [UPDATE_CREDENTIAL_NAME]: updateCredentialToolDef,
    [LIST_CREDENTIALS_NAME]: listCredentialsToolDef,
    [USE_CREDENTIAL_NAME]: useCredentialToolDef,
    [DELETE_CREDENTIAL_NAME]: deleteCredentialToolDef,
    [TEST_CREDENTIAL_NAME]: testCredentialToolDef,
  },
  handlers: {
    [REQUEST_CREDENTIAL_NAME]: handleRequestCredential,
    [REQUEST_OAUTH_SETUP_NAME]: handleRequestOAuthSetup,
    [UPDATE_CREDENTIAL_NAME]: handleUpdateCredential,
    [LIST_CREDENTIALS_NAME]: handleListCredentials,
    [USE_CREDENTIAL_NAME]: handleUseCredential,
    [DELETE_CREDENTIAL_NAME]: handleDeleteCredential,
    [TEST_CREDENTIAL_NAME]: handleTestCredential,
  },
  mappings: {
    [REQUEST_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [REQUEST_OAUTH_SETUP_NAME]: { kind: "tool", id: "credentials" },
    [UPDATE_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [LIST_CREDENTIALS_NAME]: { kind: "tool", id: "credentials" },
    [USE_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [DELETE_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [TEST_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
  },
};
