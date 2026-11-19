import type { JsonObject } from "@earendil-works/pi-durable";
export type EscalationStatus = "open" | "answered" | "claimed" | "resolved" | "dismissed" | "snoozed";
export type OnAnswer = "next-run" | "immediate";
export type ReopenReason = "snooze-ended" | "failed" | "interrupted" | "job-deleted";
/** A tool call an option authorizes when chosen (shown in the inbox; matched by the warden). */
export type EscalationCall = {
    tool: string;
    arguments: JsonObject;
};
export type EscalationOption = {
    id: string;
    label: string;
    detail?: string;
    calls?: EscalationCall[];
};
export interface EscalationAnswer {
    option?: string;
    instruction?: string;
    by?: string;
    at: string;
}
export interface HistoryEntry {
    at: string;
    event: "raised" | "answered" | "withdrawn" | "claimed" | "resolved" | "failed" | "interrupted" | "dismissed" | "restored" | "snoozed" | "snooze-ended" | "job-deleted" | "transferred";
    note?: string;
    answer?: EscalationAnswer;
}
export interface Escalation {
    id: string;
    owner?: string;
    namespace: string;
    key: string;
    title: string;
    body: string;
    options: EscalationOption[];
    allowInstruction: boolean;
    onAnswer: OnAnswer;
    source: {
        jobId?: string;
        conversationId?: number;
    };
    status: EscalationStatus;
    answer?: EscalationAnswer;
    claim?: {
        conversationId: number;
        at: string;
    };
    snoozedUntil?: string;
    reopenReason?: ReopenReason;
    orphaned?: boolean;
    createdAt: string;
    updatedAt: string;
    resolvedAt?: string;
    history: HistoryEntry[];
}
export type Bucket = {
    kind: "user";
    user: string;
} | {
    kind: "shared";
};
export declare const SKIP_STATUSES: readonly EscalationStatus[];
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
