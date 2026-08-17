import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import type Prescription from "@/models/prescription";
import type { Pagination } from "@/lib/server-functions/builders";
import { PaginationControls } from "./PaginationControls";

type Props = {
  prescriptions: Prescription.EncodedT[];
  pagination: Pagination;
  onPageChange: (offset: number) => void;
  loading?: boolean;
  /**
   * Counts across every one of the patient's prescriptions, not just the page
   * on screen. Omit to hide the summary line.
   */
  statusCounts?: readonly Prescription.StatusCount[];
};

/**
 * Display order for the summary line. Mirrors `Prescription.statusValues`, which
 * lives behind a server-only module the browser bundle can't import.
 */
const STATUS_DISPLAY_ORDER = [
  "pending",
  "prepared",
  "picked-up",
  "not-picked-up",
  "partially-picked-up",
  "cancelled",
  "other",
] as const;

export type PrescriptionsSummary = {
  total: number;
  /** Statuses with at least one prescription, in `STATUS_DISPLAY_ORDER`. */
  byStatus: { status: string; count: number }[];
};

/**
 * Tally raw per-status counts into the summary the list renders.
 *
 * Every count reaches a bucket, so `total` always equals the sum of `byStatus`:
 * unknown statuses sort after the known ones rather than being dropped, and a
 * null or blank status folds into `other`.
 */
export const summarizePrescriptionStatuses = (
  counts: readonly Prescription.StatusCount[],
): PrescriptionsSummary => {
  const totals = new Map<string, number>();

  for (const { status, count } of counts) {
    if (!Number.isFinite(count) || count <= 0) continue;
    const key = status?.trim() ? status.trim() : "other";
    totals.set(key, (totals.get(key) ?? 0) + count);
  }

  const rank = (status: string) => {
    const index = STATUS_DISPLAY_ORDER.indexOf(
      status as (typeof STATUS_DISPLAY_ORDER)[number],
    );
    return index === -1 ? STATUS_DISPLAY_ORDER.length : index;
  };

  const byStatus = [...totals.entries()]
    .map(([status, count]) => ({ status, count }))
    // Unknown statuses all share the fallback rank, so break the tie by name to
    // keep the order stable across renders.
    .sort(
      (a, b) =>
        rank(a.status) - rank(b.status) || a.status.localeCompare(b.status),
    );

  return {
    total: byStatus.reduce((sum, entry) => sum + entry.count, 0),
    byStatus,
  };
};

const statusVariant = (status: string) => {
  switch (status) {
    case "picked-up":
      return "default" as const;
    case "pending":
    case "prepared":
      return "secondary" as const;
    case "cancelled":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
};

const priorityVariant = (priority: string | null) => {
  switch (priority) {
    case "emergency":
      return "destructive" as const;
    case "high":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
};

/** Format a prescription date for display. Returns "—" for null/missing/invalid. */
export const formatPrescriptionDate = (
  date: Date | string | null | undefined,
): string => {
  if (!date) return "—";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "—";
    return format(d, "MMM dd, yyyy");
  } catch {
    return "—";
  }
};

/** Derive a human-readable status label from a prescription status string. */
export const statusLabel = (status: string): string =>
  status
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** Single prescription row. */
export function PrescriptionRow({
  prescription,
}: {
  prescription: Prescription.EncodedT;
}) {
  return (
    <div className="border rounded-lg p-4">
      <div className="flex justify-between items-start mb-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            Prescribed: {formatPrescriptionDate(prescription.prescribed_at)}
          </p>
          {prescription.expiration_date && (
            <p className="text-xs text-muted-foreground">
              Expires: {formatPrescriptionDate(prescription.expiration_date)}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Badge variant={statusVariant(prescription.status)}>
            {statusLabel(prescription.status)}
          </Badge>
          {prescription.priority && prescription.priority !== "normal" && (
            <Badge variant={priorityVariant(prescription.priority)}>
              {prescription.priority}
            </Badge>
          )}
        </div>
      </div>
      {prescription.notes && (
        <p className="text-sm text-muted-foreground mt-1">
          {prescription.notes}
        </p>
      )}
    </div>
  );
}

/** One-line tally of the patient's prescriptions by status. */
export function PrescriptionsSummaryLine({
  summary,
}: {
  summary: PrescriptionsSummary;
}) {
  return (
    <p className="text-xs text-muted-foreground mb-3">
      {[
        `${summary.total} total`,
        ...summary.byStatus.map(
          ({ status, count }) =>
            `${count} ${statusLabel(status).toLowerCase()}`,
        ),
      ].join(" · ")}
    </p>
  );
}

export function PrescriptionsList({
  prescriptions,
  pagination,
  onPageChange,
  loading,
  statusCounts,
}: Props) {
  const summary = statusCounts
    ? summarizePrescriptionStatuses(statusCounts)
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prescriptions</CardTitle>
        <CardDescription>Active and past medications</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Keyed off the summary, not the page: `hasMore` can land the user on an
            empty last page while the patient still has prescriptions. */}
        {summary && summary.total > 0 && (
          <PrescriptionsSummaryLine summary={summary} />
        )}
        {prescriptions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No prescriptions recorded
          </div>
        ) : (
          <div className="space-y-3">
            {prescriptions.map((rx) => (
              <PrescriptionRow key={rx.id} prescription={rx} />
            ))}
            {pagination.total > 0 && (
              <PaginationControls
                pagination={pagination}
                onPageChange={onPageChange}
                loading={loading}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
