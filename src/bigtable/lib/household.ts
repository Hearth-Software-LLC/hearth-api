import { supabaseAdmin } from "../../services/supabase.js";

export type MembershipRole = "organizer" | "member";

export type MembershipContext = {
  role: MembershipRole;
  organizerProfileId: string;
};

export async function getMembershipContext(userId: string): Promise<MembershipContext> {
  const { data, error } = await supabaseAdmin
    .from("household_memberships")
    .select("organizer_id")
    .eq("member_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data?.organizer_id && typeof data.organizer_id === "string") {
    return {
      role: "member",
      organizerProfileId: data.organizer_id,
    };
  }

  return {
    role: "organizer",
    organizerProfileId: userId,
  };
}

export async function resolveEffectiveProfileId(userId: string): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("effective_profile_id", { uid: userId });

  if (error) {
    const normalizedMessage = error.message.toLowerCase();
    const missingFunction =
      normalizedMessage.includes("effective_profile_id")
      && normalizedMessage.includes("does not exist");

    // Older environments may not have the household-sharing RPC yet.
    // Fall back to the caller's own profile ID so core planner routes still work.
    if (missingFunction) {
      console.warn("effective_profile_id RPC missing; falling back to userId", {
        userId,
        message: error.message,
      });
      return userId;
    }

    throw new Error(error.message);
  }

  if (typeof data === "string" && data.trim()) {
    return data;
  }

  return userId;
}
