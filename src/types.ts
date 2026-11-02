export type EscalationStatus = "open" | "answered" | "claimed" | "resolved" | "dismissed" | "snoozed";
export type OnAnswer = "next-run" | "immediate";
export type ReopenReason = "snooze-ended" | "failed" | "interrupted" | "job-deleted";
export interface EscalationOption { id: string; label: string; detail?: string }
export interface EscalationAnswer { option?: string; instruction?: string; by?: string; at: string }
export interface HistoryEntry { at: string; event: "raised" | "answered" | "withdrawn" | "claimed" | "resolved" | "failed" | "interrupted" | "dismissed" | "restored" | "snoozed" | "snooze-ended" | "job-deleted"; note?: string; answer?: EscalationAnswer }
export interface Escalation {
  id: string;                 // crypto.randomUUID()
  owner?: string;             // undefined → shared bucket (empty directory only)
  namespace: string;          // "job:<jobId>" | "user"
  key: string;
  title: string; body: string;
  options: EscalationOption[]; allowInstruction: boolean;
  onAnswer: OnAnswer;
  source: { jobId?: string; conversationId?: number };
  status: EscalationStatus;
  answer?: EscalationAnswer;
  claim?: { conversationId: number; at: string };
  snoozedUntil?: string;
  reopenReason?: ReopenReason;
  orphaned?: boolean;         // job deleted: only Dismiss is offered
  createdAt: string; updatedAt: string; resolvedAt?: string;
  history: HistoryEntry[];
}
export type Bucket = { kind: "user"; user: string } | { kind: "shared" };
export const SKIP_STATUSES: readonly EscalationStatus[] = ["open", "answered", "claimed", "dismissed", "snoozed"];

export interface RaiseInput {
  owner?: string;
  namespace: string;
  key: string;
  title: string;
  body: string;
  options: EscalationOption[];
  allowInstruction: boolean;
  onAnswer: OnAnswer;
  source: Escalation["source"];
}
