/**
 * Derives the onboarding / pending-task checklist from REAL workspace state.
 * Pure function so it can be unit tested.
 */
export interface TaskInput {
  canManage: boolean;
  socialStatus: string | null;
  hasNiche: boolean;
  hasBrandVoice: boolean;
  memberCount: number;
  seatLimit: number;
  pendingInvitations: number;
  creditBalance: number;
  profileHasName: boolean;
}

export interface PendingTask {
  id: string;
  title: string;
  description: string;
  href: string;
  done: boolean;
}

export function derivePendingTasks(i: TaskInput): PendingTask[] {
  const tasks: PendingTask[] = [
    {
      id: "profile",
      title: "Complete your profile",
      description: "Add your name so teammates recognise you.",
      href: "/settings/profile",
      done: i.profileHasName,
    },
    {
      id: "instagram",
      title: i.socialStatus && i.socialStatus !== "connected" ? "Reconnect Instagram" : "Connect Instagram",
      description:
        i.socialStatus && i.socialStatus !== "connected"
          ? "Your Instagram connection needs attention."
          : "Link the Instagram account this workspace produces content for.",
      href: "/settings/connections",
      done: i.socialStatus === "connected",
    },
    {
      id: "niche",
      title: "Define your content niche",
      description: "Future modules use it to tailor research and scripts.",
      href: "/settings/workspace",
      done: i.hasNiche,
    },
    {
      id: "voice",
      title: "Describe your brand voice",
      description: "Tone, vocabulary and things to avoid.",
      href: "/settings/workspace",
      done: i.hasBrandVoice,
    },
  ];

  if (i.canManage && i.seatLimit > 1) {
    tasks.push({
      id: "team",
      title: "Invite a teammate",
      description: i.pendingInvitations > 0 ? `${i.pendingInvitations} invitation(s) pending.` : "Collaborate on production.",
      href: "/settings/members",
      done: i.memberCount > 1,
    });
  }

  // Members cannot act on manager-only tasks; hide those they cannot complete.
  return tasks.filter((t) => i.canManage || !["instagram", "niche", "voice"].includes(t.id) || t.done);
}
