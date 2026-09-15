import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { currentUserHasRole } from "@/lib/server-functions/users";
import {
  getSyncAuditAccounts,
  getSyncEvents,
} from "@/lib/server-functions/sync-audit";

const ALL_ACCOUNTS = "all";

type Search = { page: number; userId?: string };

export const Route = createFileRoute("/app/audit/sync-attempts")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): Search => {
    const page = Number(search.page);
    return {
      page: Number.isInteger(page) && page >= 1 ? page : 1,
      userId:
        typeof search.userId === "string" && search.userId.length > 0
          ? search.userId
          : undefined,
    };
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const isSuperAdmin = await currentUserHasRole({
      data: { role: "super_admin" },
    });
    if (!isSuperAdmin) {
      return { isSuperAdmin, accounts: [], events: [], hasNextPage: false };
    }

    const [accounts, page] = await Promise.all([
      getSyncAuditAccounts(),
      getSyncEvents({ data: deps }),
    ]);
    return { isSuperAdmin, accounts, ...page };
  },
});

const formatDuration = (startedAt: number, finishedAt: number | null) =>
  finishedAt === null ? "—" : `${((finishedAt - startedAt) / 1000).toFixed(1)}s`;

const OUTCOME_LABEL: Record<string, string> = {
  completed: "Completed",
  failed: "Failed",
  started: "In progress",
};

const OUTCOME_VARIANT: Record<string, "default" | "secondary" | "destructive"> =
  { completed: "default", started: "secondary", failed: "destructive" };

function RouteComponent() {
  const { isSuperAdmin, accounts, events, hasNextPage } =
    Route.useLoaderData();
  const { page, userId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  if (!isSuperAdmin) {
    return (
      <div className="container py-6">
        <h1 className="text-2xl font-bold mb-6">Sync Attempts</h1>
        <p className="text-muted-foreground">
          Only Super Admins can view the sync audit log.
        </p>
      </div>
    );
  }

  return (
    <div className="container py-6 space-y-4">
      <h1 className="text-2xl font-bold">Sync Attempts</h1>

      <div className="max-w-md">
        <Select
          value={userId ?? ALL_ACCOUNTS}
          onValueChange={(value) =>
            navigate({
              search: {
                page: 1,
                userId: value === ALL_ACCOUNTS ? undefined : value,
              },
            })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="All accounts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ACCOUNTS}>All accounts</SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Sent</TableHead>
            <TableHead>Device</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="text-center py-6">
                No syncs recorded.
              </TableCell>
            </TableRow>
          ) : (
            events.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="whitespace-nowrap">
                  {new Date(event.startedAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  {event.userName ?? "Unknown user"}
                  {event.userEmail && (
                    <div className="text-xs text-muted-foreground">
                      {event.userEmail}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {event.kind === "manual_sync" ? "Manual sync" : "Sync"}
                </TableCell>
                <TableCell>
                  <Badge variant={OUTCOME_VARIANT[event.outcome]}>
                    {OUTCOME_LABEL[event.outcome]}
                  </Badge>
                </TableCell>
                <TableCell>
                  {formatDuration(event.startedAt, event.finishedAt)}
                </TableCell>
                <TableCell className="text-right">
                  {event.recordsReceived}
                </TableCell>
                <TableCell className="text-right">
                  {event.recordsSent}
                  {event.recordsRejected > 0 && (
                    <div className="text-xs text-destructive">
                      {event.recordsRejected} rejected
                    </div>
                  )}
                </TableCell>
                <TableCell>{event.peerType}</TableCell>
                <TableCell>{event.ipAddress ?? "—"}</TableCell>
                <TableCell
                  className="max-w-xs truncate"
                  title={event.error ?? ""}
                >
                  {event.error ?? "—"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-end gap-2">
        <span className="text-sm text-muted-foreground">Page {page}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => navigate({ search: { page: page - 1, userId } })}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNextPage}
          onClick={() => navigate({ search: { page: page + 1, userId } })}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
