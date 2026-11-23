export type Conversation = {
  night: number; // this venue's nights so far with the host
  phase: "closed" | "open" | "last-round-in" | "ended";
  roundsTonight: number;
};
export type SubjectState = {
  seed: number;
  venue: string | null; // the profile id (world/profiles.ts)
  conversation: Conversation;
};
