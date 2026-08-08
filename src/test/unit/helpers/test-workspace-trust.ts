import { WorkspaceTrust } from "../../../core/workspace-trust";

export function trustedWorkspace(): WorkspaceTrust {
  return new WorkspaceTrust(() => true);
}
