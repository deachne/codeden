import { OWNER_CHECKS_WORK_KEY_PREFIX, OwnerChecksSubmission } from "@codeden/contracts";
import { defineTool } from "../../define";
import { asTool, forSession } from "./shared";

/**
 * `factory_submit_owner_checks`: the tryout agent's results (§10.1, Owner checks), one per
 * scenario of its brief. Only tryout sessions see it.
 */
export const factorySubmitOwnerChecks = defineTool({
  name: "factory_submit_owner_checks",
  description:
    "Submit your owner checks results: one per scenario number of your brief, each `pass` or `fail`, the screenshot you took of it (the File path or artifact id browser_screenshot printed) and one sentence of what you saw the app do, in your own words (never the scenario's wording). Submit once, after trying every scenario.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession(
    (services, id) =>
      services.sessionRepo.find(id)?.session.workKey.startsWith(OWNER_CHECKS_WORK_KEY_PREFIX) ??
      false,
  ),
  input: OwnerChecksSubmission,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.submitOwnerChecks(services.sessionRepo.get(sessionId), input)),
});
