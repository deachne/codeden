import {
  FactoryAdmitRequest,
  FactoryDismissRequest,
  FactoryFileFollowUpRequest,
  type FactoryItemResponse,
  type FactoryLessonResponse,
  type FactoryReleaseSnapshot,
  FactoryRetryOptions,
  type FactoryScorecard,
  FactoryScorecardQuery,
  FactorySetTypeRequest,
  FactorySpecDecisionRequest,
  FactorySpotCheckRequest,
  type FactorySpotCheckResponse,
  KillSwitchRequest,
  type OwnerCheckResponse,
  OwnerCheckRunRequest,
  type OwnerCheckRunResponse,
  type OwnerChecksResponse,
  OwnerCheckWriteRequest,
  type ParkedIdeaResponse,
  type ParkedIdeasResponse,
  PutVisionRequest,
  SetAutonomyModeRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/projects/:id/...`: autonomy mode, vision, the factory panel and its controls (§10.1).
 * Mounted under `/projects`. `factory/scout` is "Run scout now": 409 `scout_unavailable` with
 * the reason when no round can start. `kill-switch` takes `mode` (`now`, the default, or
 * `drain`: finish the work in flight, then stop); `factory/resume` also cancels a drain.
 * `DELETE factory/lessons/:lessonId` forgets a lesson (404 `lesson_not_found`).
 * `factory/parked-ideas` lists the scout's parked ideas still shown; `.../:ideaId/build` files one as
 * a factory issue (status `building`) and `.../:ideaId/not-now` hides it (404 `parked_idea_not_found`,
 * 409 `parked_idea_building`).
 * `owner-checks` lists the owner's checks and their latest runs; `POST owner-checks` writes one
 * (409 `owner_checks_full`), `PUT`/`DELETE owner-checks/:checkId` edit or remove one (404
 * `owner_check_not_found`), and `POST owner-checks/run` runs them on a session's branch or a work
 * item's PR (409 `no_owner_checks`, `no_dev_server`, `no_provider`, `no_pull_request`).
 * `follow-ups/file` is "File issue" for one review follow-up of a merged item (and "File now" on
 * the scout's held list); `follow-ups/dismiss` drops a held one (409 `follow_up_filed` once filed).
 * `items/:itemId/spec` approves a feature's spec or asks for changes (409 `spec_not_pending`
 * unless it waits for approval).
 * `factory/scorecard?days=7|30|90` (30 by default) is the scorecard by builder and reviewer.
 * `items/:itemId/spot-check` records a person's spot-check of a merge (409
 * `spot_check_not_pending` unless one waits); `spot-check/file-issue` files the follow-up issue of
 * a problem recorded without one (409 `spot_check_not_problem` or `spot_check_issue_filed`).
 * `factory/release/approve` releases the release branch's batch into the default branch (release
 * mode, #4; 409 `release_mode_off`, `release_not_ready` or `release_conflict`).
 */
export function projectFactoryRoutes(s: AppServices) {
  const f = s.factory;
  return new Hono()
    .get("/:id/factory", async (c) => c.json(await f.status(c.req.param("id"))))
    .put("/:id/autonomy", jsonBody(SetAutonomyModeRequest), async (c) =>
      c.json(await f.setMode(c.req.param("id"), c.req.valid("json"))),
    )
    .get("/:id/vision", (c) => c.json(f.vision(c.req.param("id"))))
    .put("/:id/vision", jsonBody(PutVisionRequest), async (c) =>
      c.json(await f.putVision(c.req.param("id"), c.req.valid("json").contents)),
    )
    .post("/:id/kill-switch", jsonBody(KillSwitchRequest), async (c) => {
      const { on, mode, drainLimitMin } = c.req.valid("json");
      return c.json(await f.setKillSwitch(c.req.param("id"), on, { mode, drainLimitMin }));
    })
    .post("/:id/factory/resume", async (c) => c.json(await f.resume(c.req.param("id"))))
    .post("/:id/factory/tick", async (c) => {
      await f.checkNow(c.req.param("id"));
      return c.json(await f.status(c.req.param("id")));
    })
    .post("/:id/factory/scout", async (c) => {
      await f.runScout(c.req.param("id"));
      return c.json(await f.status(c.req.param("id")));
    })
    .post("/:id/factory/digest", async (c) => c.json(await f.digestNow(c.req.param("id"))))
    .post("/:id/factory/release/approve", async (c) =>
      c.json<FactoryReleaseSnapshot>(await f.approveRelease(c.req.param("id"))),
    )
    .get("/:id/factory/scorecard", queryOf(FactoryScorecardQuery), async (c) =>
      c.json<FactoryScorecard>(await f.scorecard(c.req.param("id"), c.req.valid("query").days)),
    )
    .get("/:id/factory/items/:itemId", async (c) => {
      const id = c.req.param("id");
      return c.json<FactoryItemResponse>(
        await f.itemResponse(id, f.item(id, c.req.param("itemId"))),
      );
    })
    .post("/:id/factory/admit", jsonBody(FactoryAdmitRequest), async (c) => {
      const id = c.req.param("id");
      const item = await f.admit(id, c.req.valid("json"), "user");
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/set-type", jsonBody(FactorySetTypeRequest), async (c) => {
      const id = c.req.param("id");
      const item = await f.setType(id, c.req.valid("json"), "user");
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/retry", jsonBody(FactoryRetryOptions), async (c) => {
      const id = c.req.param("id");
      const item = f.retry(id, c.req.param("itemId"), c.req.valid("json").mode);
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/dismiss", jsonBody(FactoryDismissRequest), async (c) => {
      const id = c.req.param("id");
      const item = f.dismiss(id, c.req.param("itemId"), c.req.valid("json"), "user");
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/spec", jsonBody(FactorySpecDecisionRequest), async (c) => {
      const id = c.req.param("id");
      const item = await f.decideSpec(id, c.req.param("itemId"), c.req.valid("json"));
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/spot-check", jsonBody(FactorySpotCheckRequest), async (c) =>
      c.json<FactorySpotCheckResponse>(
        await f.decideSpotCheck(c.req.param("id"), c.req.param("itemId"), c.req.valid("json")),
      ),
    )
    .post("/:id/factory/items/:itemId/spot-check/file-issue", async (c) =>
      c.json<FactorySpotCheckResponse>(
        await f.fileSpotCheckIssue(c.req.param("id"), c.req.param("itemId")),
      ),
    )
    .get("/:id/owner-checks", (c) => c.json<OwnerChecksResponse>(f.ownerChecks(c.req.param("id"))))
    .post("/:id/owner-checks", jsonBody(OwnerCheckWriteRequest), (c) =>
      c.json<OwnerCheckResponse>({
        check: f.addOwnerCheck(c.req.param("id"), c.req.valid("json").text),
      }),
    )
    .post("/:id/owner-checks/run", jsonBody(OwnerCheckRunRequest), async (c) =>
      c.json<OwnerCheckRunResponse>({
        run: await f.runOwnerChecks(c.req.param("id"), c.req.valid("json")),
      }),
    )
    .put("/:id/owner-checks/:checkId", jsonBody(OwnerCheckWriteRequest), (c) =>
      c.json<OwnerCheckResponse>({
        check: f.editOwnerCheck(
          c.req.param("id"),
          c.req.param("checkId"),
          c.req.valid("json").text,
        ),
      }),
    )
    .delete("/:id/owner-checks/:checkId", (c) =>
      c.json<OwnerCheckResponse>({
        check: f.removeOwnerCheck(c.req.param("id"), c.req.param("checkId")),
      }),
    )
    .get("/:id/factory/parked-ideas", (c) =>
      c.json<ParkedIdeasResponse>({ ideas: f.parkedIdeas(c.req.param("id")) }),
    )
    .post("/:id/factory/parked-ideas/:ideaId/build", async (c) =>
      c.json<ParkedIdeaResponse>({
        idea: await f.buildParkedIdea(c.req.param("id"), c.req.param("ideaId")),
      }),
    )
    .post("/:id/factory/parked-ideas/:ideaId/not-now", (c) =>
      c.json<ParkedIdeaResponse>({
        idea: f.setParkedIdeaAside(c.req.param("id"), c.req.param("ideaId")),
      }),
    )
    .delete("/:id/factory/lessons/:lessonId", (c) =>
      c.json<FactoryLessonResponse>({
        lesson: f.forgetLesson(c.req.param("id"), c.req.param("lessonId")),
      }),
    )
    .post(
      "/:id/factory/items/:itemId/follow-ups/file",
      jsonBody(FactoryFileFollowUpRequest),
      async (c) => {
        const id = c.req.param("id");
        const item = await f.fileFollowUp(id, c.req.param("itemId"), c.req.valid("json").index);
        return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
      },
    )
    .post(
      "/:id/factory/items/:itemId/follow-ups/dismiss",
      jsonBody(FactoryFileFollowUpRequest),
      async (c) => {
        const id = c.req.param("id");
        const itemId = c.req.param("itemId");
        const item = await f.dismissFollowUp(id, itemId, c.req.valid("json").index);
        return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
      },
    );
}

/** `/api/factory`: the global kill switch (Stop now only: 400 `drain_per_project` for a drain). */
export function factoryRoutes(s: AppServices) {
  return new Hono().post("/kill-switch", jsonBody(KillSwitchRequest), async (c) => {
    const { on, mode } = c.req.valid("json");
    return c.json(await s.factory.setGlobalKillSwitch(on, mode));
  });
}
