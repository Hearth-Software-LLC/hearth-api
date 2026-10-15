import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest, buildAuthHeader } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

const profilesMaybeSingleMock = vi.fn();
const profilesEqMock = vi.fn();
const profilesSelectMock = vi.fn();
const profilesUpsertMock = vi.fn();

const recipesCountEq1Mock = vi.fn();
const recipesCountEq2Mock = vi.fn();
const recipesCountEq3Mock = vi.fn();
const recipesCountSelectMock = vi.fn();

const recipesUpdateEq1Mock = vi.fn();
const recipesUpdateEq2Mock = vi.fn();
const recipesUpdateEq3Mock = vi.fn();
const recipesUpdateMock = vi.fn();

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin: {
    from: fromMock,
  },
}));

describe("/api/me/social-visibility route", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    getUserIdFromAuthHeader.mockResolvedValue("user-1");

    profilesMaybeSingleMock.mockResolvedValue({
      data: { social_profile_visible: true },
      error: null,
    });
    profilesEqMock.mockReturnValue({ maybeSingle: profilesMaybeSingleMock });
    profilesSelectMock.mockReturnValue({ eq: profilesEqMock });
    profilesUpsertMock.mockResolvedValue({ error: null });

    recipesCountEq3Mock.mockResolvedValue({ count: 0, error: null });
    recipesCountEq2Mock.mockReturnValue({ eq: recipesCountEq3Mock });
    recipesCountEq1Mock.mockReturnValue({ eq: recipesCountEq2Mock });
    recipesCountSelectMock.mockReturnValue({ eq: recipesCountEq1Mock });

    recipesUpdateEq3Mock.mockResolvedValue({ error: null });
    recipesUpdateEq2Mock.mockReturnValue({ eq: recipesUpdateEq3Mock });
    recipesUpdateEq1Mock.mockReturnValue({ eq: recipesUpdateEq2Mock });
    recipesUpdateMock.mockReturnValue({ eq: recipesUpdateEq1Mock });

    fromMock.mockImplementation((table: string) => {
      if (table === "profiles") {
        return {
          select: profilesSelectMock,
          upsert: profilesUpsertMock,
        };
      }

      if (table === "recipes") {
        return {
          select: recipesCountSelectMock,
          update: recipesUpdateMock,
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("GET returns social visibility and published recipe count", async () => {
    recipesCountEq3Mock.mockResolvedValueOnce({ count: 2, error: null });

    const { GET } = await import("../../src/bigtable/routes/me.social-visibility.js");
    const response = await GET(
      new Request("http://localhost/api/me/social-visibility", {
        headers: { authorization: buildAuthHeader() },
      }) as never
    );

    const payload = (await response.json()) as {
      socialProfileVisible: boolean;
      publishedRecipeCount: number;
    };

    expect(response.status).toBe(200);
    expect(payload.socialProfileVisible).toBe(true);
    expect(payload.publishedRecipeCount).toBe(2);
  });

  it("PUT false bulk-unpublishes all published user recipes", async () => {
    recipesCountEq3Mock.mockResolvedValueOnce({ count: 3, error: null });

    const { PUT } = await import("../../src/bigtable/routes/me.social-visibility.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/me/social-visibility",
        { socialProfileVisible: false },
        "token",
        { method: "PUT" }
      ) as never
    );

    const payload = (await response.json()) as {
      ok: boolean;
      socialProfileVisible: boolean;
      unpublishedRecipeCount: number;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.socialProfileVisible).toBe(false);
    expect(payload.unpublishedRecipeCount).toBe(3);
    expect(recipesUpdateMock).toHaveBeenCalledWith({ status: "unpublished" });
  });

  it("PUT true updates visibility without unpublishing recipes", async () => {
    const { PUT } = await import("../../src/bigtable/routes/me.social-visibility.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/me/social-visibility",
        { socialProfileVisible: true },
        "token",
        { method: "PUT" }
      ) as never
    );

    const payload = (await response.json()) as {
      ok: boolean;
      socialProfileVisible: boolean;
      unpublishedRecipeCount?: number;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.socialProfileVisible).toBe(true);
    expect(payload.unpublishedRecipeCount).toBe(0);
    expect(recipesCountSelectMock).not.toHaveBeenCalled();
    expect(recipesUpdateMock).not.toHaveBeenCalled();
  });
});
