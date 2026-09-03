import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  getPrescriptionsPage,
  togglePrescriptionStatus,
  type PrescriptionsPage,
} from "@/lib/server-functions/prescriptions";
import { pageCount, pageWindow } from "@/lib/server-functions/builders";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Fragment } from "react";
import { format } from "date-fns";
import { SelectInput } from "@/components/select-input";
import Prescription from "@/models/prescription";
import upperFirst from "lodash/upperFirst";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/app/prescriptions/")({
  component: RouteComponent,
  // Anything that is not a whole page number falls back to the first page.
  validateSearch: (search: Record<string, unknown>) => ({
    page: Math.max(1, Math.floor(Number(search.page)) || 1),
  }),
  loaderDeps: ({ search: { page } }) => ({ page }),
  // TanStack's serializable-return check degrades this to `unknown`; the
  // handler's own annotation is the real shape.
  loader: async ({ deps }): Promise<PrescriptionsPage> =>
    (await getPrescriptionsPage({
      data: { page: deps.page },
    })) as PrescriptionsPage,
});

function RouteComponent() {
  const router = useRouter();
  const { items: prescriptions, pagination } = Route.useLoaderData();
  const { page } = Route.useSearch();
  const navigate = Route.useNavigate();

  const totalPages = pageCount(pagination.total, pagination.limit);

  // A `?page=` past the end has rows behind it but none on it.
  const rangeCaption =
    pagination.total === 0
      ? "No prescriptions yet"
      : prescriptions.length === 0
        ? `${pagination.total} prescriptions in total`
        : `Showing ${pagination.offset + 1}–${pagination.offset + prescriptions.length} of ${pagination.total}`;

  // Clamped, so a `?page=` past the end still has a way back.
  const goToPage = (target: number) => {
    const nextPage = Math.min(Math.max(1, target), totalPages);
    if (nextPage === page) return;
    navigate({ search: { page: nextPage } });
  };

  const handleStatusChange = async (id: string, status: string) => {
    togglePrescriptionStatus({ data: { id, status } })
      .then((res) => {
        toast.success("Status updated successfully");
        router.invalidate({ sync: true });
      })
      .catch((err) => {
        toast.error("Failed to update status");
      });
  };

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Prescriptions</h1>
        <Button asChild>
          <Link to="/app/prescriptions/edit/$" params={{ _splat: "new" }}>
            Add New Prescription
          </Link>
        </Button>
      </div>

      <div className="rounded-md border overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableCaption>{rangeCaption}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Patient ID</TableHead>
                <TableHead>Provider ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Prescribed At</TableHead>
                <TableHead>Expiration Date</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prescriptions.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground py-8"
                  >
                    {pagination.total === 0
                      ? "No prescriptions have been recorded."
                      : "No prescriptions on this page."}
                  </TableCell>
                </TableRow>
              )}
              {prescriptions.map((prescription) => (
                <TableRow key={prescription.id}>
                  <TableCell>{prescription.patient_id}</TableCell>
                  <TableCell>{prescription.provider_id}</TableCell>
                  <TableCell>
                    <SelectInput
                      data={Prescription.statusValues.map((status) => ({
                        value: status,
                        label: upperFirst(status),
                      }))}
                      value={prescription.status}
                      onChange={(value) =>
                        handleStatusChange(prescription.id, value || "")
                      }
                      size="sm"
                      clearable={false}
                    />
                  </TableCell>
                  <TableCell>
                    {prescription.prescribed_at
                      ? format(new Date(prescription.prescribed_at), "PPP")
                      : "N/A"}
                  </TableCell>
                  <TableCell>
                    {prescription.expiration_date
                      ? format(new Date(prescription.expiration_date), "PPP")
                      : "N/A"}
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {prescription.notes}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="py-8">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => goToPage(page - 1)}
                  className={
                    page <= 1
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>

              {pageWindow(page, totalPages).map((pageNumber, index, shown) => (
                <Fragment key={pageNumber}>
                  {index > 0 && pageNumber > shown[index - 1] + 1 && (
                    <PaginationItem>
                      <PaginationEllipsis />
                    </PaginationItem>
                  )}
                  <PaginationItem>
                    <PaginationLink
                      onClick={() => goToPage(pageNumber)}
                      isActive={pageNumber === page}
                      className="cursor-pointer"
                    >
                      {pageNumber}
                    </PaginationLink>
                  </PaginationItem>
                </Fragment>
              ))}

              <PaginationItem>
                <PaginationNext
                  onClick={() => goToPage(page + 1)}
                  className={
                    page >= totalPages
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}
